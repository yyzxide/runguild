import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// The web project intentionally emits no Node build. Transpile this standalone
// coordinator; inject worker control so tests cannot launch real processes.
const source = await readFile(new URL('../src/goal-execution.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
})
const { ensureGoalExecution, planGoalExecution, GoalExecutionError } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64')
)

function fixture() {
  const project = { id: 'project', workspaceId: 'workspace' }
  const agents = ['planner', 'builder', 'reviewer', 'researcher'].map((role) => ({
    id: role, name: role, role, status: 'active', worker: null,
  }))
  return {
    identity: { projectId: project.id, workspaceId: project.workspaceId, userId: 'user' },
    mission: {
      id: 'mission', projectId: project.id, workspaceId: project.workspaceId, status: 'running',
      tasks: [{ id: 'task', role: 'builder', status: 'ready', reviewRequired: true, dependsOn: [] }],
    },
    runtime: {
      configuration: { project, agents },
      control: {
        enabled: true,
        workers: [
          ...agents.map((agent) => ({ kind: 'agent', agentId: agent.id })),
          { kind: 'scheduler' }, { kind: 'integration' }, { kind: 'evaluation' },
        ].map((worker) => ({ ...worker, ready: true, managedByThisApi: false, missing: [] })),
      },
    },
    overview: { project, agents, systemWorkers: [] },
  }
}

test('starts only needed roles, independent review and delivery services, scheduler last', async () => {
  const input = fixture()
  input.runtime.configuration.agents.push({ id: 'builder-2', name: 'Builder 2', role: 'builder', status: 'active' })
  input.runtime.control.workers.push({ kind: 'agent', agentId: 'builder-2', ready: true, managedByThisApi: false })
  const calls = []
  const result = await ensureGoalExecution(input, async (identity, action, command) => {
    assert.deepEqual(identity, input.identity)
    assert.equal(action, 'start')
    calls.push(command)
    return { state: 'starting', message: 'started' }
  })
  assert.deepEqual(calls, [
    { kind: 'agent', agentId: 'builder' }, { kind: 'agent', agentId: 'reviewer' },
    { kind: 'agent', agentId: 'builder-2' }, { kind: 'integration' }, { kind: 'scheduler' },
  ])
  assert.deepEqual(result.started, calls)
})

test('preflight rejects all missing configuration before making any start call', async () => {
  const input = fixture()
  input.runtime.control.workers.find((worker) => worker.kind === 'integration').ready = false
  input.runtime.control.workers.find((worker) => worker.kind === 'integration').missing = ['仓库路径']
  let calls = 0
  await assert.rejects(ensureGoalExecution(input, async () => { calls++; return { state: 'starting' } }), /仓库路径/)
  assert.equal(calls, 0)
})

test('does not take over online external workers or restart a child awaiting heartbeat', () => {
  const input = fixture()
  input.overview.agents.find((agent) => agent.id === 'builder').worker = { state: 'online' }
  input.runtime.control.workers.find((worker) => worker.agentId === 'builder').ready = false
  input.runtime.control.workers.find((worker) => worker.agentId === 'reviewer').managedByThisApi = true
  assert.deepEqual(planGoalExecution(input).start, [{ kind: 'integration' }, { kind: 'scheduler' }])
})

test('disabled local control succeeds only when all required deployed workers are online', async () => {
  const input = fixture()
  input.runtime.control = { enabled: false, workers: [] }
  assert.throws(() => planGoalExecution(input), /部署环境/)
  for (const agent of input.overview.agents) agent.worker = { state: 'online' }
  input.overview.systemWorkers = [{ kind: 'integration', state: 'online' }, { kind: 'scheduler', state: 'online' }]
  assert.deepEqual((await ensureGoalExecution(input)).started, [])
})

test('partial failure keeps successful starts and a fresh retry starts only the missing process', async () => {
  const input = fixture()
  await assert.rejects(ensureGoalExecution(input, async (_identity, _action, command) => {
    if (command.kind === 'integration') throw new Error('path unavailable')
    input.runtime.control.workers.find((worker) => worker.kind === command.kind && worker.agentId === command.agentId).managedByThisApi = true
    return { state: 'starting', message: 'started' }
  }), (error) => error instanceof GoalExecutionError && error.started.length === 3 && /path unavailable/.test(error.message))
  const calls = []
  await ensureGoalExecution(input, async (_identity, _action, command) => {
    calls.push(command)
    return { state: 'starting', message: 'started' }
  })
  assert.deepEqual(calls, [{ kind: 'integration' }])
})

test('rejects unapproved or different-project missions, missing roles and self-review', () => {
  const input = fixture()
  input.mission.status = 'awaiting_approval'
  assert.throws(() => planGoalExecution(input), /已批准/)
  input.mission.status = 'running'
  input.mission.projectId = 'other'
  assert.throws(() => planGoalExecution(input), /当前项目/)
  input.mission.projectId = 'project'
  input.mission.tasks[0].role = 'custom'
  assert.throws(() => planGoalExecution(input), /custom Agent/)
  input.mission.tasks[0].role = 'reviewer'
  assert.throws(() => planGoalExecution(input), /独立审查/)
})

test('completed tasks do not require workers and failed tasks are not silently retried', () => {
  const input = fixture()
  input.mission.tasks[0].status = 'completed'
  assert.deepEqual(planGoalExecution(input), { start: [], alreadyRunning: [] })
  input.mission.tasks[0].status = 'failed'
  assert.throws(() => planGoalExecution(input), /先检查原因并重试任务/)
})

test('failed branches do not prevent independent work and blocked descendants stay stopped', () => {
  const input = fixture()
  input.mission.tasks.push(
    { id: 'failed', role: 'researcher', status: 'failed', reviewRequired: false, dependsOn: [] },
    { id: 'grandchild', role: 'custom', status: 'blocked', reviewRequired: false, dependsOn: ['child'] },
    { id: 'child', role: 'planner', status: 'blocked', reviewRequired: false, dependsOn: ['failed'] },
  )
  assert.deepEqual(planGoalExecution(input).start, [
    { kind: 'agent', agentId: 'builder' }, { kind: 'agent', agentId: 'reviewer' },
    { kind: 'integration' }, { kind: 'scheduler' },
  ])
  input.mission.tasks[0].status = 'completed'
  assert.throws(() => planGoalExecution(input), /失败依赖阻塞/)
})

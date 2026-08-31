import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentInboxProcessor, executionMessages } from '../dist/agent-loop.js'

const context = {
  workspaceId: 'ws_agent',
  projectId: 'project_agent',
  missionId: 'mission_agent',
  taskId: 'task_agent',
  runId: 'run_agent',
  agentId: 'agent_builder',
  agentRole: 'builder',
  modelProvider: 'openai',
  modelName: 'test-model',
  missionTitle: 'Build the feature',
  missionGoal: 'Ship a verified implementation.',
  missionConstraints: ['stay inside workspace'],
  taskTitle: 'Implement',
  taskDescription: 'Change the code and prove it works.',
  reviewRequired: true,
  missionArtifacts: [{
    id: 'artifact_mission',
    title: 'Mission deliverable',
    kind: 'mission_deliverable',
  }],
  acceptanceCriteria: [{
    key: 'tests',
    description: 'Tests pass.',
    required: true,
    evidenceKinds: ['test_run', 'file_diff'],
  }],
}

test('Agent inbox claims a dispatch, executes its durable Run, and releases the lease', async () => {
  const claims = []
  const acknowledgements = []
  const executions = []
  const releases = []
  const processor = new AgentInboxProcessor({
    agentId: 'agent_builder',
    workspaceId: 'ws_agent',
    projectId: 'project_agent',
    inbox: {
      async read() {
        return {
          cursor: 0n,
          messages: [{
            seq: 1n,
            id: 'inbox_dispatch',
            workspaceId: 'ws_agent',
            agentId: 'agent_builder',
            missionId: 'mission_agent',
            runId: null,
            kind: 'task.dispatch',
            payload: {
              schemaVersion: 1,
              type: 'task.dispatch',
              dispatchToken: 'dispatch-token',
              taskId: 'task_agent',
              missionId: 'mission_agent',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
          }],
        }
      },
      async acknowledge(input) {
        acknowledgements.push(input)
        return true
      },
    },
    tasks: {
      async claimTask(input) {
        claims.push(input)
        return { claimed: true }
      },
      async resumeWaitingRun() {
        throw new Error('not expected')
      },
      async listRunnableAgentRuns() {
        return [{
          workspaceId: 'ws_agent',
          missionId: 'mission_agent',
          taskId: 'task_agent',
          runId: 'run_agent',
          agentId: 'agent_builder',
          leaseToken: 'lease_agent',
        }]
      },
      async renewLease() {
        return '2026-08-19T00:01:00.000Z'
      },
      async releaseLease(input) {
        releases.push(input)
        return true
      },
      async resolveTerminalRunLease() { throw new Error('not expected') },
    },
    contexts: {
      async load() {
        return context
      },
    },
    async createRuntime(loaded) {
      assert.equal(loaded, context)
      return {
        async run(input) {
          executions.push(input)
          return { status: 'succeeded', summary: 'Done.', hops: 1 }
        },
      }
    },
  }, {
    inboxLimit: 10,
    runLimit: 5,
    leaseSeconds: 60,
  })

  const result = await processor.tick()

  assert.deepEqual(result, { inboxProcessed: 1, runsExecuted: 1 })
  assert.equal(claims.length, 1)
  assert.equal(claims[0].dispatchToken, 'dispatch-token')
  assert.equal(claims[0].projectId, 'project_agent')
  assert.match(claims[0].runId, /^run_/)
  assert.deepEqual(acknowledgements, [{
    agentId: 'agent_builder',
    expectedCursor: 0n,
    throughSeq: 1n,
  }])
  assert.equal(executions.length, 1)
  assert.equal(executions[0].runId, 'run_agent')
  assert.equal(executions[0].resumeWaiting, true)
  assert.match(executions[0].initialMessages[1].content, /test_run/)
  assert.match(executions[0].initialMessages[1].content, /artifact_mission/)
  assert.match(executions[0].initialMessages[1].content, /submit that exact Version for review/)
  assert.deepEqual(releases, [{
    taskId: 'task_agent',
    runId: 'run_agent',
    agentId: 'agent_builder',
    leaseToken: 'lease_agent',
  }])
})

test('terminal failed Run immediately returns its Task to durable scheduling', async () => {
  const resolutions = []
  const processor = new AgentInboxProcessor({
    agentId: 'agent_builder',
    workspaceId: 'ws_agent',
    projectId: 'project_agent',
    inbox: {
      async read() { return { cursor: 0n, messages: [] } },
      async acknowledge() { return true },
    },
    tasks: {
      async claimTask() { throw new Error('not expected') },
      async resumeWaitingRun() { throw new Error('not expected') },
      async listRunnableAgentRuns() {
        return [{
          workspaceId: 'ws_agent', missionId: 'mission_agent', taskId: 'task_agent',
          runId: 'run_agent', agentId: 'agent_builder', leaseToken: 'lease_agent',
        }]
      },
      async renewLease() { return '2026-08-19T00:01:00.000Z' },
      async releaseLease() { throw new Error('not expected') },
      async resolveTerminalRunLease(input) { resolutions.push(input); return true },
    },
    contexts: { async load() { return context } },
    async createRuntime() {
      return { async run() { return { status: 'failed', summary: 'Bad tool arguments.', hops: 2 } } }
    },
  }, {
    inboxLimit: 10,
    runLimit: 5,
    leaseSeconds: 60,
  })

  assert.deepEqual(await processor.tick(), { inboxProcessed: 0, runsExecuted: 1 })
  assert.equal(resolutions.length, 1)
  assert.deepEqual({ ...resolutions[0], correlationId: 'normalized' }, {
    taskId: 'task_agent',
    runId: 'run_agent',
    agentId: 'agent_builder',
    leaseToken: 'lease_agent',
    correlationId: 'normalized',
  })
  assert.match(resolutions[0].correlationId, /^agent_terminal_/)
})

test('control inbox messages reacquire a lease for a waiting Run before polling', async () => {
  const resumed = []
  const processor = new AgentInboxProcessor({
    agentId: 'agent_builder',
    workspaceId: 'ws_agent',
    projectId: 'project_agent',
    inbox: {
      async read() {
        return {
          cursor: 4n,
          messages: [{
            seq: 5n,
            id: 'inbox_control',
            workspaceId: 'ws_agent',
            agentId: 'agent_builder',
            missionId: 'mission_agent',
            runId: 'run_agent',
            kind: 'run.control',
            payload: {},
            createdAt: '2026-08-19T00:00:00.000Z',
          }],
        }
      },
      async acknowledge() { return true },
    },
    tasks: {
      async claimTask() { throw new Error('not expected') },
      async resumeWaitingRun(input) {
        resumed.push(input)
        return { resumed: true }
      },
      async listRunnableAgentRuns() { return [] },
      async renewLease() { throw new Error('not expected') },
      async releaseLease() { throw new Error('not expected') },
    },
    contexts: {
      async load() { throw new Error('not expected') },
    },
    async createRuntime() { throw new Error('not expected') },
  }, {
    inboxLimit: 10,
    runLimit: 5,
    leaseSeconds: 90,
  })

  assert.deepEqual(await processor.tick(), { inboxProcessed: 1, runsExecuted: 0 })
  assert.deepEqual(resumed, [{
    runId: 'run_agent',
    agentId: 'agent_builder',
    workspaceId: 'ws_agent',
    projectId: 'project_agent',
    leaseSeconds: 90,
  }])
})

test('Worker ownership loss aborts the active Agent Runtime', async () => {
  let runtimeStarted
  const started = new Promise((resolve) => { runtimeStarted = resolve })
  const processor = new AgentInboxProcessor({
    agentId: 'agent_builder',
    workspaceId: 'ws_agent',
    projectId: 'project_agent',
    inbox: {
      async read() { return { cursor: 0n, messages: [] } },
      async acknowledge() { return true },
    },
    tasks: {
      async claimTask() { throw new Error('not expected') },
      async resumeWaitingRun() { throw new Error('not expected') },
      async listRunnableAgentRuns() {
        return [{
          workspaceId: 'ws_agent', missionId: 'mission_agent', taskId: 'task_agent',
          runId: 'run_agent', agentId: 'agent_builder', leaseToken: 'lease_agent',
        }]
      },
      async renewLease() { return '2026-08-19T00:01:00.000Z' },
      async releaseLease() { throw new Error('not expected') },
    },
    contexts: { async load() { return context } },
    async createRuntime(_context, abortSignal) {
      return {
        async run() {
          runtimeStarted()
          return new Promise((_resolve, reject) => {
            abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
          })
        },
      }
    },
  }, {
    inboxLimit: 10,
    runLimit: 5,
    leaseSeconds: 60,
  })
  const controller = new AbortController()
  const ticking = processor.tick(controller.signal)
  await started
  controller.abort(new Error('Worker heartbeat ownership lost'))
  await assert.rejects(ticking, /Worker heartbeat ownership lost/)
})

test('execution prompt includes mission scope and evidence requirements', () => {
  const messages = executionMessages(context, [['npm', 'test'], ['npm', 'run', 'build']])
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /Never invent command results/)
  assert.match(messages[0].content, /repo\.commit even when no code changed/)
  assert.match(messages[0].content, /\[\["npm","test"\],\["npm","run","build"\]\]/)
  assert.match(messages[0].content, /globs are unsupported/)
  assert.match(messages[0].content, /at most 4 discovery hops/)
  assert.match(messages[0].content, /after each later successful file\.patch/)
  assert.match(messages[0].content, /repo\.status, repo\.search, repo\.diff, and file\.read stay hidden/)
  assert.match(messages[1].content, /Build the feature/)
  assert.match(messages[1].content, /tests: Tests pass\. \(evidence: test_run, file_diff\)/)
})

test('execution prompt does not require file.patch without required file_diff evidence', () => {
  const messages = executionMessages({
    ...context,
    acceptanceCriteria: [{
      key: 'tests',
      description: 'Tests pass.',
      required: true,
      evidenceKinds: ['test_run'],
    }],
  })
  assert.doesNotMatch(messages[0].content, /Runtime hides repo\.status/)
})

test('execution prompt explains durable Integration conflict recovery and fresh Review', () => {
  const messages = executionMessages({
    ...context,
    integrationRecovery: {
      baseCommit: 'b'.repeat(40),
      error: { code: 'worktree_integration_conflict', message: 'README conflicts' },
    },
  })

  const taskPrompt = messages.at(-1).content
  assert.match(taskPrompt, /Integration recovery is active/)
  assert.match(taskPrompt, new RegExp('b{40}'))
  assert.match(taskPrompt, /pending Git merge/)
  assert.match(taskPrompt, /old Submission was superseded/)
  assert.match(taskPrompt, /independent Review/)
})

test('execution prompt injects the exact frozen Skill Version below the runtime contract', () => {
  const messages = executionMessages({
    ...context,
    skills: [{
      skillId: 'skill_worker',
      versionId: 'skill_worker_v3',
      name: 'Repository procedure',
      description: 'Checks for this repository.',
      instructions: 'Run tests and typecheck before requesting completion.',
      contentHash: 'b'.repeat(64),
      estimatedTokens: 20,
      priority: 10,
    }],
  })

  assert.equal(messages.length, 3)
  assert.match(messages[1].content, /Assigned Skill: Repository procedure/)
  assert.match(messages[1].content, /Skill Version: skill_worker_v3/)
  assert.match(messages[1].content, new RegExp('b{64}'))
  assert.match(messages[1].content, /Run tests and typecheck/)
  assert.match(messages[2].content, /Assigned task: Implement/)
})

test('Reviewer inbox stays unacknowledged while the producing Task has not entered reviewing', async () => {
  let acknowledgements = 0
  let reviewCalls = 0
  const processor = new AgentInboxProcessor({
    agentId: 'agent_reviewer',
    workspaceId: 'ws_agent',
    projectId: 'project_agent',
    inbox: {
      async read() {
        return {
          cursor: 0n,
          messages: [{
            seq: 1n,
            id: 'inbox_review',
            workspaceId: 'ws_agent',
            agentId: 'agent_reviewer',
            missionId: 'mission_agent',
            runId: null,
            kind: 'artifact.review_requested',
            payload: {
              schemaVersion: 1,
              type: 'artifact.review_requested',
              reviewId: 'review_agent',
              submissionId: 'submission_agent',
              missionId: 'mission_agent',
              taskId: 'task_agent',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
          }],
        }
      },
      async acknowledge() { acknowledgements += 1; return true },
    },
    tasks: {
      async claimTask() { throw new Error('not expected') },
      async resumeWaitingRun() { throw new Error('not expected') },
      async listRunnableAgentRuns() { return [] },
      async renewLease() { throw new Error('not expected') },
      async releaseLease() { throw new Error('not expected') },
    },
    contexts: { async load() { throw new Error('not expected') } },
    async createRuntime() { throw new Error('not expected') },
    reviewer: {
      async process() { reviewCalls += 1; return 'deferred' },
    },
  }, {
    inboxLimit: 10,
    runLimit: 5,
    leaseSeconds: 60,
  })

  assert.deepEqual(await processor.tick(), { inboxProcessed: 0, runsExecuted: 0 })
  assert.equal(reviewCalls, 1)
  assert.equal(acknowledgements, 0)
})

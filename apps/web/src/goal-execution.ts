import type {
  MissionSnapshot,
  ProjectOperatorOverview,
  ProjectRuntimeConfigurationResponse,
  TestIdentity,
  WorkerKind,
  missionApi,
} from './api'

export interface GoalWorkerCommand {
  readonly kind: WorkerKind
  readonly agentId?: string
}

export interface GoalExecutionInput {
  readonly identity: TestIdentity
  readonly mission: MissionSnapshot
  readonly runtime: ProjectRuntimeConfigurationResponse
  readonly overview: ProjectOperatorOverview
}

export interface GoalExecutionResult {
  readonly started: readonly GoalWorkerCommand[]
  readonly alreadyRunning: readonly GoalWorkerCommand[]
}

export class GoalExecutionError extends Error {
  readonly started: readonly GoalWorkerCommand[]
  readonly failures: readonly string[]

  constructor(failures: readonly string[], started: readonly GoalWorkerCommand[] = []) {
    super((started.length ? `已启动 ${started.length} 个进程；` : '') + failures.join('；'))
    this.name = 'GoalExecutionError'
    this.started = started
    this.failures = failures
  }
}

function commandLabel(command: GoalWorkerCommand, input: GoalExecutionInput): string {
  if (command.kind === 'scheduler') return '任务调度服务'
  if (command.kind === 'integration') return '项目集成服务'
  return input.runtime.configuration.agents.find((agent) => agent.id === command.agentId)?.name ?? 'Agent'
}

/** Preflight uses fresh snapshots; it never starts or changes a process. */
export function planGoalExecution(input: GoalExecutionInput): {
  readonly start: readonly GoalWorkerCommand[]
  readonly alreadyRunning: readonly GoalWorkerCommand[]
} {
  const { identity, mission, runtime, overview } = input
  if (mission.workspaceId !== identity.workspaceId || mission.projectId !== identity.projectId
    || runtime.configuration.project.workspaceId !== identity.workspaceId
    || runtime.configuration.project.id !== identity.projectId
    || overview.project.workspaceId !== identity.workspaceId || overview.project.id !== identity.projectId) {
    throw new GoalExecutionError(['目标与运行配置不属于当前项目，请刷新后重试'])
  }
  if (mission.status !== 'running') {
    throw new GoalExecutionError(['只有已批准且正在执行的目标可以启动执行进程'])
  }
  const unfinished = mission.tasks.filter((task) => !['completed', 'cancelled'].includes(task.status))
  if (unfinished.length === 0) return { start: [], alreadyRunning: [] }
  const unavailable = new Set(mission.tasks
    .filter((task) => ['failed', 'cancelled'].includes(task.status)).map((task) => task.id))
  let changed = true
  while (changed) {
    changed = false
    for (const task of unfinished) {
      if (task.status === 'blocked' && !unavailable.has(task.id)
        && task.dependsOn.some((id) => unavailable.has(id))) {
        unavailable.add(task.id)
        changed = true
      }
    }
  }
  // Preserve failed branches until the user explicitly grants a retry, while
  // allowing independent ready/running/reviewing branches to keep progressing.
  const tasks = unfinished.filter((task) => !unavailable.has(task.id))
  if (!tasks.length) throw new GoalExecutionError(['剩余任务已失败或被失败依赖阻塞，请先检查原因并重试任务'])
  const roles = new Set(tasks.map((task) => task.role))
  if (roles.has(null)) throw new GoalExecutionError(['计划中存在未分配执行角色的任务，请先修正计划'])
  if (tasks.some((task) => task.reviewRequired)) roles.add('reviewer')
  const agents = runtime.configuration.agents.filter((agent) => agent.status === 'active' && roles.has(agent.role))
  const failures: string[] = []
  for (const role of roles) {
    if (!agents.some((agent) => agent.role === role)) failures.push(`缺少可用的 ${role} Agent，请检查团队配置`)
  }
  if (tasks.some((task) => task.role === 'reviewer' && task.reviewRequired)
    && agents.filter((agent) => agent.role === 'reviewer').length < 2) {
    failures.push('审查 Agent 的任务需要另一名独立审查 Agent，请检查团队配置')
  }

  // The scheduler can dispatch to any active Agent of a required role. Start all
  // candidates so a dispatch cannot be assigned to a matching but sleeping Agent.
  const commands: GoalWorkerCommand[] = [
    ...agents.map((agent): GoalWorkerCommand => ({ kind: 'agent', agentId: agent.id })),
    // createRuntime currently provisions a worktree for every role, including
    // research. Task completion requires that worktree to be integrated.
    { kind: 'integration' },
    { kind: 'scheduler' },
  ]
  const start: GoalWorkerCommand[] = []
  const alreadyRunning: GoalWorkerCommand[] = []
  for (const command of commands) {
    const capability = runtime.control.workers.find((worker) =>
      worker.kind === command.kind && worker.agentId === command.agentId)
    const online = command.kind === 'agent'
      ? overview.agents.some((agent) => agent.id === command.agentId && agent.worker?.state === 'online')
      : overview.systemWorkers.some((worker) => worker.kind === command.kind && worker.state === 'online')
    if (online || capability?.managedByThisApi) {
      alreadyRunning.push(command)
      continue
    }
    const label = commandLabel(command, input)
    if (!runtime.control.enabled) failures.push(`${label}未在线，请由部署环境启动该进程`)
    else if (!capability) failures.push(`${label}没有可用的启动配置`)
    else if (!capability.ready) failures.push(`${label}缺少运行条件：${capability.missing.join('、')}`)
    else start.push(command)
  }
  if (failures.length) throw new GoalExecutionError(failures)
  return { start, alreadyRunning }
}

/** Called only by an explicit approval/continue action, never by polling effects. */
export async function ensureGoalExecution(
  input: GoalExecutionInput,
  controlWorker?: typeof missionApi.controlLocalWorker,
): Promise<GoalExecutionResult> {
  const plan = planGoalExecution(input)
  if (!plan.start.length) return { started: [], alreadyRunning: plan.alreadyRunning }
  const control = controlWorker ?? (await import('./api')).missionApi.controlLocalWorker
  const started: GoalWorkerCommand[] = []
  const alreadyRunning = [...plan.alreadyRunning]
  const failures: string[] = []
  // Keep successful starts if another process fails. A retry uses fresh
  // capabilities and heartbeats; the API also checks for an existing process.
  for (const command of plan.start) {
    try {
      const result = await control(input.identity, 'start', command)
      if (result.state === 'already_running') alreadyRunning.push(command)
      else if (result.state === 'starting') started.push(command)
      else failures.push(`${commandLabel(command, input)}未启动：${result.message}`)
    } catch (error) {
      failures.push(`${commandLabel(command, input)}启动失败：${error instanceof Error ? error.message : '请检查运行配置'}`)
    }
  }
  if (failures.length) throw new GoalExecutionError(failures, started)
  return { started, alreadyRunning }
}

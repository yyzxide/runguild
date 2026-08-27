import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  WORKER_KINDS,
  type ProjectRuntimeConfiguration,
  type WorkerInstanceRepository,
  type WorkerKind,
} from '@runguild/database'
import type { AgentId } from '@runguild/protocol'

type WorkerActivityStore = Pick<WorkerInstanceRepository, 'hasActive'>

export interface LocalWorkerCommand {
  readonly kind: WorkerKind
  readonly agentId?: AgentId
}

export interface LocalWorkerCapability {
  readonly kind: WorkerKind
  readonly agentId?: AgentId
  readonly label: string
  readonly ready: boolean
  readonly missing: readonly string[]
  readonly managedByThisApi: boolean
}

export interface LocalRuntimeCapabilities {
  readonly enabled: true
  readonly secretSource: 'api_environment'
  readonly workers: readonly LocalWorkerCapability[]
}

export interface LocalWorkerControlResult {
  readonly kind: WorkerKind
  readonly agentId?: AgentId
  readonly state: 'starting' | 'stopping' | 'already_running' | 'not_owned'
  readonly message: string
}

export interface LocalRuntimeControl {
  capabilities(configuration: ProjectRuntimeConfiguration): LocalRuntimeCapabilities
  start(
    command: LocalWorkerCommand,
    configuration: ProjectRuntimeConfiguration,
  ): Promise<LocalWorkerControlResult>
  stop(command: LocalWorkerCommand): Promise<LocalWorkerControlResult>
}

interface LocalWorkerSupervisorOptions {
  readonly databaseUrl: string
  readonly redisUrl?: string
  readonly openaiApiKey?: string
  readonly openaiBaseUrl?: string
  readonly openaiReasoningEffort?: string
  readonly openaiMaxOutputTokens?: string
  readonly workerHeartbeatMs?: string
  readonly activity: WorkerActivityStore
}

const ENTRY_POINTS: Readonly<Record<WorkerKind, string>> = {
  scheduler: fileURLToPath(new URL('../../worker/dist/main.js', import.meta.url)),
  agent: fileURLToPath(new URL('../../worker/dist/agent-main.js', import.meta.url)),
  integration: fileURLToPath(new URL('../../worker/dist/integration-main.js', import.meta.url)),
  evaluation: fileURLToPath(new URL('../../worker/dist/evaluation-main.js', import.meta.url)),
}

function workerKey(command: LocalWorkerCommand): string {
  if ((command.kind === 'agent') !== Boolean(command.agentId)) {
    throw new Error('Agent Worker commands must include exactly one agentId')
  }
  if (!WORKER_KINDS.includes(command.kind)) throw new Error('Unsupported Worker kind')
  return command.kind === 'agent' ? 'agent:' + command.agentId : command.kind
}

function safeProcessEnvironment(values: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
  }
  for (const [key, value] of Object.entries(values)) {
    if (value?.trim()) environment[key] = value
  }
  return environment
}

function commandLabel(command: LocalWorkerCommand, configuration: ProjectRuntimeConfiguration): string {
  if (command.kind !== 'agent') return command.kind
  const agent = configuration.agents.find((candidate) => candidate.id === command.agentId)
  return agent ? 'Agent · ' + agent.name : 'Agent · ' + command.agentId
}

export async function ensureWorkspaceRoots(repositoryPath: string, worktreeRoot: string): Promise<void> {
  const repository = await stat(repositoryPath)
  if (!repository.isDirectory()) throw new Error('仓库路径必须是已存在的目录')
  try {
    const worktrees = await stat(worktreeRoot)
    if (!worktrees.isDirectory()) throw new Error('Worktree 根目录已存在但不是目录')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 })
  }
}

export class LocalWorkerSupervisor implements LocalRuntimeControl {
  private readonly children = new Map<string, ChildProcess>()

  constructor(private readonly options: LocalWorkerSupervisorOptions) {}

  capabilities(configuration: ProjectRuntimeConfiguration): LocalRuntimeCapabilities {
    const commands: LocalWorkerCommand[] = [
      { kind: 'scheduler' },
      { kind: 'integration' },
      { kind: 'evaluation' },
      ...configuration.agents
        .filter((agent) => agent.status === 'active')
        .map((agent): LocalWorkerCommand => ({ kind: 'agent', agentId: agent.id })),
    ]
    return {
      enabled: true,
      secretSource: 'api_environment',
      workers: commands.map((command) => {
        const missing: string[] = []
        if (command.kind === 'scheduler' && !this.options.redisUrl?.trim()) missing.push('REDIS_URL')
        if (command.kind === 'agent' || command.kind === 'integration') {
          if (!configuration.project.repositoryPath) missing.push('仓库路径')
          if (!configuration.runtime.worktreeRoot) missing.push('Worktree 根目录')
        }
        if (command.kind === 'agent') {
          if (!this.options.openaiApiKey?.trim()) missing.push('OPENAI_API_KEY')
          const agent = configuration.agents.find((candidate) => candidate.id === command.agentId)
          if (!agent) missing.push('项目 Agent')
          else if (agent.modelProvider !== 'openai') missing.push('当前仅支持 openai 模型提供商')
        }
        const key = workerKey(command)
        return {
          ...command,
          label: commandLabel(command, configuration),
          ready: missing.length === 0,
          missing,
          managedByThisApi: this.children.get(key)?.exitCode === null,
        }
      }),
    }
  }

  async start(
    command: LocalWorkerCommand,
    configuration: ProjectRuntimeConfiguration,
  ): Promise<LocalWorkerControlResult> {
    const key = workerKey(command)
    const existing = this.children.get(key)
    if (existing?.exitCode === null) {
      return { ...command, state: 'already_running', message: '该 Worker 已由当前 API 进程启动' }
    }
    const capability = this.capabilities(configuration).workers.find((worker) => workerKey(worker) === key)
    if (!capability) throw new Error('Worker is not part of this Project runtime configuration')
    if (!capability.ready) throw new Error('Worker 缺少运行条件：' + capability.missing.join('、'))
    if (await this.options.activity.hasActive(command.kind, command.agentId)) {
      return { ...command, state: 'already_running', message: '数据库中已有该 Worker 的有效心跳' }
    }

    const repositoryPath = configuration.project.repositoryPath
    const worktreeRoot = configuration.runtime.worktreeRoot
    if (command.kind === 'agent' || command.kind === 'integration') {
      if (!repositoryPath || !worktreeRoot) throw new Error('仓库路径和 Worktree 根目录尚未配置')
      await ensureWorkspaceRoots(repositoryPath, worktreeRoot)
    }
    const entryPoint = ENTRY_POINTS[command.kind]
    await access(entryPoint)
    const child = spawn(process.execPath, [entryPoint], {
      cwd: repositoryPath ?? process.cwd(),
      env: this.environmentFor(command, configuration),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    this.children.set(key, child)
    const prefix = '[local-worker ' + key + '] '
    child.stdout?.on('data', (chunk: Buffer | string) => process.stdout.write(prefix + chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(prefix + chunk.toString()))
    child.once('error', (error) => {
      process.stderr.write(prefix + 'spawn error: ' + error.message + '\n')
      if (this.children.get(key) === child) this.children.delete(key)
    })
    child.once('exit', (code, signal) => {
      process.stdout.write(prefix + 'exited code=' + String(code) + ' signal=' + String(signal) + '\n')
      if (this.children.get(key) === child) this.children.delete(key)
    })
    return { ...command, state: 'starting', message: 'Worker 进程已启动，等待心跳上线' }
  }

  async stop(command: LocalWorkerCommand): Promise<LocalWorkerControlResult> {
    const key = workerKey(command)
    const child = this.children.get(key)
    if (!child || child.exitCode !== null) {
      return { ...command, state: 'not_owned', message: '该 Worker 不是由当前 API 进程启动，未执行停止' }
    }
    child.kill('SIGTERM')
    return { ...command, state: 'stopping', message: '已发送安全停止信号，等待 Worker 退出' }
  }

  async shutdown(): Promise<void> {
    for (const child of this.children.values()) {
      if (child.exitCode === null) child.kill('SIGTERM')
    }
  }

  private environmentFor(
    command: LocalWorkerCommand,
    configuration: ProjectRuntimeConfiguration,
  ): NodeJS.ProcessEnv {
    const common: Record<string, string | undefined> = {
      DATABASE_URL: this.options.databaseUrl,
      WORKER_HEARTBEAT_MS: this.options.workerHeartbeatMs,
    }
    if (command.kind === 'scheduler') return safeProcessEnvironment({ ...common, REDIS_URL: this.options.redisUrl })
    if (command.kind === 'evaluation') return safeProcessEnvironment(common)
    const workspace: Record<string, string | undefined> = {
      ...common,
      REPOSITORY_ROOT: configuration.project.repositoryPath ?? undefined,
      WORKTREE_ROOT: configuration.runtime.worktreeRoot ?? undefined,
    }
    if (command.kind === 'integration') return safeProcessEnvironment(workspace)
    return safeProcessEnvironment({
      ...workspace,
      AGENT_ID: command.agentId,
      OPENAI_API_KEY: this.options.openaiApiKey,
      OPENAI_BASE_URL: this.options.openaiBaseUrl,
      OPENAI_REASONING_EFFORT: this.options.openaiReasoningEffort,
      OPENAI_MAX_OUTPUT_TOKENS: this.options.openaiMaxOutputTokens,
      AGENT_CONTEXT_INPUT_TOKENS: String(configuration.runtime.agentContextInputTokens),
      AGENT_MAX_TEST_TIMEOUT_MS: String(configuration.runtime.agentMaxTestTimeoutMs),
      AGENT_TEST_COMMANDS_JSON: JSON.stringify(configuration.runtime.testCommands),
      AGENT_WORKTREE_SETUP_COMMANDS_JSON: JSON.stringify(configuration.runtime.worktreeSetupCommands),
      AGENT_WORKTREE_SETUP_TIMEOUT_MS: String(configuration.runtime.worktreeSetupTimeoutMs),
    })
  }
}

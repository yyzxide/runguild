import { setTimeout as delay } from 'node:timers/promises'

import {
  AgentRuntime,
  DeterministicContextBuilder,
  OpenAIResponsesAdapter,
} from '@runguild/agent-runtime'
import {
  ARTIFACT_TOOL_DEFINITIONS,
  CONVERSATION_TOOL_DEFINITIONS,
  ArtifactRepository,
  createArtifactToolHandlers,
  createConversationToolHandlers,
} from '@runguild/collaboration'
import {
  DatabaseCompletionVerifier,
  ConversationPlanningRepository,
  ConversationRepository,
  EvidenceRepository,
  ExecutionContextRepository,
  InboxRepository,
  MissionRepository,
  RuntimeRepository,
  ReviewRepository,
  ReviewerExecutionRepository,
  TaskRepository,
  TaskWorktreeRepository,
  ToolExecutionRepository,
  WorktreeSetupRepository,
  WorkerInstanceRepository,
  createDatabasePool,
  runMigrations,
  type AgentExecutionContext,
} from '@runguild/database'
import type { AgentId, EvidenceKind } from '@runguild/protocol'
import { ToolGateway, type ToolHandlerContext } from '@runguild/tool-gateway'
import {
  WORKSPACE_TOOL_DEFINITIONS,
  GitWorktreeManager,
  createWorkspaceToolHandlers,
} from '@runguild/workspace-tools'

import {
  AgentInboxProcessor,
  IMPLEMENTATION_DISCOVERY_HOP_LIMIT,
  requiresFilePatch,
} from './agent-loop.js'
import { ArtifactReviewer } from './artifact-reviewer.js'
import { ConversationPlanner } from './conversation-planner.js'
import { startWorkerHeartbeat } from './worker-heartbeat.js'
import { prepareWorktree } from './worktree-preparation.js'

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(name + ' is required')
  return value
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum)
  }
  return value
}

function testCommandsSetting(): readonly (readonly string[])[] {
  const raw = process.env.AGENT_TEST_COMMANDS_JSON ?? '[["npm","test"],["npm","run","typecheck"]]'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('AGENT_TEST_COMMANDS_JSON must be valid JSON', { cause: error })
  }
  if (!Array.isArray(parsed)
      || parsed.length === 0
      || parsed.length > 50
      || parsed.some((command) => !Array.isArray(command)
        || command.length === 0
        || command.length > 30
        || command.some((part) => typeof part !== 'string' || !part.trim()))) {
    throw new Error('AGENT_TEST_COMMANDS_JSON must be a non-empty array of non-empty string arrays')
  }
  return parsed as readonly (readonly string[])[]
}

function worktreeSetupCommandsSetting(): readonly (readonly string[])[] {
  const raw = process.env.AGENT_WORKTREE_SETUP_COMMANDS_JSON ?? '[]'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('AGENT_WORKTREE_SETUP_COMMANDS_JSON must be valid JSON', { cause: error })
  }
  if (!Array.isArray(parsed)
      || parsed.length > 20
      || parsed.some((command) => !Array.isArray(command)
        || command.length === 0
        || command.length > 30
        || command.some((part) => typeof part !== 'string' || !part.trim() || part.length > 1_000))) {
    throw new Error('AGENT_WORKTREE_SETUP_COMMANDS_JSON must be an array of non-empty string arrays')
  }
  return parsed as readonly (readonly string[])[]
}

function reasoningEffortSetting(): 'none' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  const value = process.env.OPENAI_REASONING_EFFORT?.trim()
  if (!value) return undefined
  if (!['none', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
    throw new Error('OPENAI_REASONING_EFFORT must be none, low, medium, high, or xhigh')
  }
  return value as 'none' | 'low' | 'medium' | 'high' | 'xhigh'
}

const databaseUrl = requiredSetting('DATABASE_URL')
const agentId = requiredSetting('AGENT_ID') as AgentId
const repositoryRoot = requiredSetting('REPOSITORY_ROOT')
const worktreeRoot = requiredSetting('WORKTREE_ROOT')
const openaiApiKey = requiredSetting('OPENAI_API_KEY')
const modelOverride = process.env.MODEL_NAME?.trim()
const modelProviderOverride = process.env.MODEL_PROVIDER?.trim()
const openaiBaseUrl = process.env.OPENAI_BASE_URL?.trim()
const reasoningEffort = reasoningEffortSetting()
const maxOutputTokens = integerSetting('OPENAI_MAX_OUTPUT_TOKENS', 16_384, 1, 128_000)
const contextInputTokens = integerSetting('AGENT_CONTEXT_INPUT_TOKENS', 65_536, 256, 2_000_000)
const pollMs = integerSetting('AGENT_POLL_MS', 1_000, 100, 60_000)
const leaseSeconds = integerSetting('AGENT_LEASE_SECONDS', 60, 5, 3_600)
const maxTestTimeoutMs = integerSetting('AGENT_MAX_TEST_TIMEOUT_MS', 120_000, 1_000, 900_000)
const worktreeSetupTimeoutMs = integerSetting('AGENT_WORKTREE_SETUP_TIMEOUT_MS', 300_000, 1_000, 900_000)
const allowedTestCommands = testCommandsSetting()
const worktreeSetupCommands = worktreeSetupCommandsSetting()
const contextBuilder = new DeterministicContextBuilder({ tokenBudget: contextInputTokens })

const pool = createDatabasePool(databaseUrl)
if (process.env.AUTO_MIGRATE === 'true') await runMigrations(pool)

const inbox = new InboxRepository(pool)
const tasks = new TaskRepository(pool)
const contexts = new ExecutionContextRepository(pool)
const persistence = new RuntimeRepository(pool)
const completionVerifier = new DatabaseCompletionVerifier(pool)
const evidence = new EvidenceRepository(pool)
const toolStore = new ToolExecutionRepository(pool)
const artifactRepository = new ArtifactRepository(pool)
const conversationRepository = new ConversationRepository(pool)
const conversationPlanning = new ConversationPlanningRepository(pool)
const missions = new MissionRepository(pool)
const reviews = new ReviewRepository(pool)
const reviewExecutions = new ReviewerExecutionRepository(pool)
const worktrees = new TaskWorktreeRepository(pool)
const worktreeSetups = new WorktreeSetupRepository(pool)
const worktreeManager = await GitWorktreeManager.create({
  repositoryPath: repositoryRoot,
  worktreeRoot,
  store: worktrees,
})
const evidenceRecorder = {
  async record(
    context: ToolHandlerContext,
    draft: {
      readonly kind: EvidenceKind
      readonly uri: string
      readonly contentHash: string
      readonly metadata: Readonly<Record<string, unknown>>
    },
  ) {
    const request = context.request
    return evidence.recordToolEvidence({
      workspaceId: request.workspaceId,
      missionId: request.missionId,
      taskId: request.taskId,
      runId: request.runId,
      agentId: request.agentId,
      toolCallId: request.id,
      ...draft,
    })
  },
}
const artifactHandlers = createArtifactToolHandlers({
  repository: artifactRepository,
  reviews,
  evidence: evidenceRecorder,
})
const conversationHandlers = createConversationToolHandlers({ repository: conversationRepository })
const models = new Map<string, OpenAIResponsesAdapter>()
const gateways = new Map<string, ToolGateway>()

function modelFor(contextProvider: string, contextModel: string): OpenAIResponsesAdapter {
  const provider = modelProviderOverride || contextProvider
  if (provider !== 'openai') {
    throw new Error('Unsupported model provider for Agent worker: ' + provider)
  }
  const modelName = modelOverride || contextModel
  if (!modelName) throw new Error('Agent has no model name and MODEL_NAME is empty')
  const cacheKey = provider + ':' + modelName
  let model = models.get(cacheKey)
  if (!model) {
    model = new OpenAIResponsesAdapter({
      apiKey: openaiApiKey,
      model: modelName,
      maxOutputTokens,
      ...(openaiBaseUrl ? { baseURL: openaiBaseUrl } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })
    models.set(cacheKey, model)
  }
  return model
}

async function createRuntime(
  context: AgentExecutionContext,
  abortSignal?: AbortSignal,
): Promise<AgentRuntime> {
  let assigned = await worktreeManager.ensure({
    workspaceId: context.workspaceId,
    missionId: context.missionId,
    projectId: context.projectId,
    taskId: context.taskId,
    baseRef: context.defaultBranch,
    ...(context.expectedBaseCommit === undefined ? {} : { expectedBaseCommit: context.expectedBaseCommit }),
    ...(context.allowBaseRefAdvance === undefined ? {} : { allowBaseRefAdvance: context.allowBaseRefAdvance }),
    leaseSeconds,
  })
  while (assigned.kind === 'busy') {
    await delay(Math.min(assigned.retryAfterMs, 5_000), undefined, {
      ...(abortSignal === undefined ? {} : { signal: abortSignal }),
    })
    assigned = await worktreeManager.ensure({
      workspaceId: context.workspaceId,
      missionId: context.missionId,
      projectId: context.projectId,
      taskId: context.taskId,
      baseRef: context.defaultBranch,
      ...(context.expectedBaseCommit === undefined ? {} : { expectedBaseCommit: context.expectedBaseCommit }),
      ...(context.allowBaseRefAdvance === undefined ? {} : { allowBaseRefAdvance: context.allowBaseRefAdvance }),
      leaseSeconds,
    })
  }
  await prepareWorktree({ setups: worktreeSetups }, {
    workspaceId: context.workspaceId,
    missionId: context.missionId,
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    worktreeGeneration: assigned.worktree.generation,
    worktreePath: assigned.worktree.worktreePath,
    commands: worktreeSetupCommands,
    timeoutMs: worktreeSetupTimeoutMs,
    leaseSeconds,
    ...(abortSignal === undefined ? {} : { abortSignal }),
  })
  let tools = gateways.get(context.taskId)
  if (!tools) {
    const workspaceHandlers = await createWorkspaceToolHandlers({
      root: assigned.worktree.worktreePath,
      allowedTestCommands,
      maxTestTimeoutMs,
      evidence: evidenceRecorder,
      worktrees,
    })
    tools = new ToolGateway(toolStore, [...workspaceHandlers, ...artifactHandlers, ...conversationHandlers])
    gateways.set(context.taskId, tools)
  }
  const model = modelFor(context.modelProvider, context.modelName)
  return new AgentRuntime({
    persistence,
    model,
    tools,
    completionVerifier,
    contextBuilder,
    toolDefinitions: [
      ...WORKSPACE_TOOL_DEFINITIONS,
      ...ARTIFACT_TOOL_DEFINITIONS,
      ...CONVERSATION_TOOL_DEFINITIONS,
    ],
    ...(requiresFilePatch(context)
      ? {
          implementationGate: {
            maxDiscoveryHops: IMPLEMENTATION_DISCOVERY_HOP_LIMIT,
            discoveryActions: ['repo.status', 'repo.search', 'repo.diff', 'file.read'],
            implementationActions: ['file.patch'],
          },
        }
      : {}),
  })
}

const planner = new ConversationPlanner({
  planning: conversationPlanning,
  missions,
  conversations: conversationRepository,
  modelFor,
  leaseSeconds: Math.max(30, Math.min(1_800, leaseSeconds * 5)),
})

const reviewer = new ArtifactReviewer({
  executions: reviewExecutions,
  reviews,
  modelFor,
  leaseSeconds: Math.max(30, Math.min(1_800, leaseSeconds * 5)),
})

const processor = new AgentInboxProcessor({
  agentId,
  inbox,
  tasks,
  contexts,
  createRuntime,
  allowedTestCommands,
  planner,
  reviewer,
}, {
  inboxLimit: 100,
  runLimit: 10,
  leaseSeconds,
  waitingToolRetryMs: 1_000,
  waitingToolRetries: 30,
})

let stopping = false
const workerAbortController = new AbortController()
const heartbeat = await startWorkerHeartbeat({
  repository: new WorkerInstanceRepository(pool),
  kind: 'agent',
  agentId,
  onFailure(error) {
    stopping = true
    workerAbortController.abort(error)
    process.stderr.write(JSON.stringify({
      type: 'agent.heartbeat_failed', agentId, message: error.message,
    }) + '\n')
  },
})
const stop = () => {
  stopping = true
  workerAbortController.abort(new Error('Agent Worker received a shutdown signal'))
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  while (!stopping && heartbeat.isAlive()) {
    const startedAt = Date.now()
    try {
      const result = await processor.tick(workerAbortController.signal)
      if (result.inboxProcessed > 0 || result.runsExecuted > 0) {
        process.stdout.write(JSON.stringify({
          type: 'agent.tick',
          agentId,
          ...result,
          durationMs: Date.now() - startedAt,
        }) + '\n')
      }
    } catch (error) {
      process.stderr.write(JSON.stringify({
        type: 'agent.error',
        agentId,
        message: error instanceof Error ? error.message : String(error),
      }) + '\n')
    }
    if (!stopping) await delay(pollMs)
  }
} finally {
  try {
    await heartbeat.stop()
  } finally {
    await pool.end()
  }
}

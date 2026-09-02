import {
  AuthenticationRepository,
  MissionRepository,
  ProjectOperatorRepository,
  ProjectRuntimeConfigRepository,
  ConversationRepository,
  ConversationPlanningRepository,
  DevelopmentSetupRepository,
  EvaluationRepository,
  ReviewRepository,
  ReviewerExecutionRepository,
  RuntimeRepository,
  RunTraceRepository,
  SkillRepository,
  TaskRepository,
  ToolExecutionRepository,
  WorkerInstanceRepository,
  WorktreeSetupRepository,
  createDatabasePool,
  runMigrations,
} from '@runguild/database'
import { ArtifactRepository } from '@runguild/collaboration'

import { createApiApp } from './app.js'
import { attachArtifactRealtimeServer } from './artifact-realtime.js'
import { SessionAuthentication } from './authentication.js'
import { LocalWorkerSupervisor } from './local-worker-supervisor.js'
import { RedisArtifactFanout } from './redis-artifact-fanout.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const redisUrl = process.env.REDIS_URL?.trim()
const production = process.env.NODE_ENV === 'production'
const authenticationMode = process.env.AUTH_MODE?.trim() || (production ? 'team' : 'local')
if (authenticationMode !== 'local' && authenticationMode !== 'team') {
  throw new Error('AUTH_MODE must be local or team')
}
if (production && authenticationMode === 'local') {
  throw new Error('AUTH_MODE=local cannot be used in production')
}
const defaultWorkspaceId = process.env.AUTH_DEFAULT_WORKSPACE_ID?.trim()
  || (production ? '' : 'demo_workspace')
const localUserId = process.env.LOCAL_AUTH_USER_ID?.trim() || (production ? '' : 'demo_user')
const configuredOrigins = process.env.AUTH_ALLOWED_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const allowedOrigins = configuredOrigins?.length
  ? configuredOrigins
  : production ? [] : ['http://127.0.0.1:4173', 'http://localhost:4173']
if (production && allowedOrigins.length === 0) {
  throw new Error('AUTH_ALLOWED_ORIGINS is required in production')
}
if (production && process.env.AUTH_COOKIE_SECURE === 'false') {
  throw new Error('AUTH_COOKIE_SECURE cannot be false in production')
}
if (production && process.env.ENABLE_DEV_BOOTSTRAP === 'true') {
  throw new Error('ENABLE_DEV_BOOTSTRAP cannot be enabled in production')
}

const port = Number(process.env.PORT ?? 4000)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be a valid TCP port')
}
const host = process.env.HOST?.trim() || (production ? '0.0.0.0' : '127.0.0.1')
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost'])
if (authenticationMode === 'local' && !loopbackHosts.has(host)) {
  throw new Error('AUTH_MODE=local requires HOST to be a loopback address')
}
if (!defaultWorkspaceId) throw new Error('AUTH_DEFAULT_WORKSPACE_ID is required')
if (authenticationMode === 'local' && !localUserId) throw new Error('LOCAL_AUTH_USER_ID is required in local mode')

const pool = createDatabasePool(databaseUrl)
if (process.env.AUTO_MIGRATE === 'true') {
  await runMigrations(pool)
}

const artifacts = new ArtifactRepository(pool)
const authentication = new SessionAuthentication(new AuthenticationRepository(pool), {
  secureCookies: production || process.env.AUTH_COOKIE_SECURE === 'true',
  allowedOrigins,
  ...(process.env.AUTH_SESSION_LIFETIME_SECONDS?.trim()
    ? { sessionLifetimeSeconds: Number(process.env.AUTH_SESSION_LIFETIME_SECONDS) }
    : {}),
  ...(process.env.AUTH_SESSION_IDLE_SECONDS?.trim()
    ? { sessionIdleSeconds: Number(process.env.AUTH_SESSION_IDLE_SECONDS) }
    : {}),
  ...(process.env.INTERNAL_AGENT_TOKEN?.trim()
    ? { internalAgentToken: process.env.INTERNAL_AGENT_TOKEN.trim() }
    : {}),
})
const reportArtifactFanoutError = (error: Error) => {
  process.stderr.write(JSON.stringify({ type: 'artifact.fanout_error', message: error.message }) + '\n')
}
const artifactFanout = redisUrl
  ? new RedisArtifactFanout(redisUrl, { onError: reportArtifactFanoutError })
  : undefined
const developmentSetup = process.env.ENABLE_DEV_BOOTSTRAP === 'true'
  ? new DevelopmentSetupRepository(pool)
  : undefined
const localRuntimeControl = process.env.ENABLE_LOCAL_RUNTIME_CONTROL === 'true'
  ? new LocalWorkerSupervisor({
      databaseUrl,
      activity: new WorkerInstanceRepository(pool),
      ...(redisUrl ? { redisUrl } : {}),
      ...(process.env.OPENAI_API_KEY?.trim() ? { openaiApiKey: process.env.OPENAI_API_KEY.trim() } : {}),
      ...(process.env.OPENAI_BASE_URL?.trim() ? { openaiBaseUrl: process.env.OPENAI_BASE_URL.trim() } : {}),
      ...(process.env.OPENAI_REASONING_EFFORT?.trim()
        ? { openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT.trim() }
        : {}),
      ...(process.env.OPENAI_MAX_OUTPUT_TOKENS?.trim()
        ? { openaiMaxOutputTokens: process.env.OPENAI_MAX_OUTPUT_TOKENS.trim() }
        : {}),
      ...(process.env.WORKER_HEARTBEAT_MS?.trim()
        ? { workerHeartbeatMs: process.env.WORKER_HEARTBEAT_MS.trim() }
        : {}),
    })
  : undefined
const app = createApiApp({
  missions: new MissionRepository(pool),
  projectOperator: new ProjectOperatorRepository(pool),
  projectRuntimeConfigs: new ProjectRuntimeConfigRepository(pool),
  worktreeSetups: new WorktreeSetupRepository(pool),
  conversations: new ConversationRepository(pool),
  conversationPlanning: new ConversationPlanningRepository(pool),
  runControls: new RuntimeRepository(pool),
  taskControls: new TaskRepository(pool),
  toolApprovals: new ToolExecutionRepository(pool),
  artifacts,
  reviews: new ReviewRepository(pool),
  reviewerExecutions: new ReviewerExecutionRepository(pool),
  skills: new SkillRepository(pool),
  evaluations: new EvaluationRepository(pool),
  runTraces: new RunTraceRepository(pool),
  ...(developmentSetup ? { developmentSetup } : {}),
  ...(localRuntimeControl ? { localRuntimeControl } : {}),
  authentication,
  healthcheck: async () => {
    await pool.query('SELECT 1')
  },
}, {
  authenticationMode,
  defaultWorkspaceId,
  ...(authenticationMode === 'local' ? { localUserId } : {}),
})
const server = app.listen(port, host, () => {
  process.stdout.write(`API listening on http://${host}:${port} (${authenticationMode} authentication)\n`)
})
const artifactRealtime = attachArtifactRealtimeServer(server, {
  repository: artifacts,
  authenticate: (input) => authentication.authenticateRealtime(input),
  ...(artifactFanout ? { fanout: artifactFanout, onFanoutError: reportArtifactFanoutError } : {}),
})

async function shutdown(): Promise<void> {
  await localRuntimeControl?.shutdown()
  await artifactRealtime.close()
  artifactFanout?.close()
  server.close()
  await pool.end()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

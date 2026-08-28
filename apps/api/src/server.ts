import {
  MissionRepository,
  ProjectOperatorRepository,
  ProjectRuntimeConfigRepository,
  ConversationRepository,
  ConversationPlanningRepository,
  DevelopmentSetupRepository,
  EvaluationRepository,
  ReviewRepository,
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
import { LocalWorkerSupervisor } from './local-worker-supervisor.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const port = Number(process.env.PORT ?? 4000)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be a valid TCP port')
}

const pool = createDatabasePool(databaseUrl)
if (process.env.AUTO_MIGRATE === 'true') {
  await runMigrations(pool)
}

const artifacts = new ArtifactRepository(pool)
const developmentSetup = process.env.ENABLE_DEV_BOOTSTRAP === 'true'
  ? new DevelopmentSetupRepository(pool)
  : undefined
const localRuntimeControl = process.env.ENABLE_LOCAL_RUNTIME_CONTROL === 'true'
  ? new LocalWorkerSupervisor({
      databaseUrl,
      activity: new WorkerInstanceRepository(pool),
      ...(process.env.REDIS_URL?.trim() ? { redisUrl: process.env.REDIS_URL.trim() } : {}),
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
  skills: new SkillRepository(pool),
  evaluations: new EvaluationRepository(pool),
  runTraces: new RunTraceRepository(pool),
  ...(developmentSetup ? { developmentSetup } : {}),
  ...(localRuntimeControl ? { localRuntimeControl } : {}),
  healthcheck: async () => {
    await pool.query('SELECT 1')
  },
})
const server = app.listen(port, () => {
  process.stdout.write('API listening on port ' + port + '\n')
})
const artifactRealtime = attachArtifactRealtimeServer(server, { repository: artifacts })

async function shutdown(): Promise<void> {
  await localRuntimeControl?.shutdown()
  await artifactRealtime.close()
  server.close()
  await pool.end()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

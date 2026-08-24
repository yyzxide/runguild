import { setTimeout as delay } from 'node:timers/promises'

import {
  EvaluationRepository,
  MissionRepository,
  WorkerInstanceRepository,
  createDatabasePool,
  runMigrations,
} from '@runguild/database'
import {
  EvaluationCoordinator,
  EvaluationMissionDriver,
} from '@runguild/evaluation'

import { startWorkerHeartbeat } from './worker-heartbeat.js'

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

const pool = createDatabasePool(requiredSetting('DATABASE_URL'))
if (process.env.AUTO_MIGRATE === 'true') await runMigrations(pool)

const pollMs = integerSetting('EVALUATION_POLL_MS', 2_000, 100, 60_000)
const materializationLimit = integerSetting('EVALUATION_MATERIALIZATION_BATCH_SIZE', 10, 1, 100)
const collectionLimit = integerSetting('EVALUATION_COLLECTION_BATCH_SIZE', 100, 1, 1_000)
const leaseSeconds = integerSetting('EVALUATION_LEASE_SECONDS', 120, 5, 3_600)
const evaluations = new EvaluationRepository(pool)
const coordinator = new EvaluationCoordinator(
  evaluations,
  new EvaluationMissionDriver(new MissionRepository(pool)),
)

let stopping = false
const heartbeat = await startWorkerHeartbeat({
  repository: new WorkerInstanceRepository(pool),
  kind: 'evaluation',
  onFailure(error) {
    stopping = true
    process.stderr.write(JSON.stringify({ type: 'evaluation.heartbeat_failed', message: error.message }) + '\n')
  },
})
const stop = () => { stopping = true }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  while (!stopping && heartbeat.isAlive()) {
    const result = await coordinator.tick({
      materializationLimit,
      collectionLimit,
      leaseSeconds,
    })
    if (result.discovered > 0 || result.collected > 0 || result.materializationFailed > 0) {
      process.stdout.write(JSON.stringify({ type: 'evaluation.tick', ...result }) + '\n')
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

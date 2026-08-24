import { setTimeout as delay } from 'node:timers/promises'

import {
  TaskRepository,
  TaskWorktreeRepository,
  WorkerInstanceRepository,
  createDatabasePool,
  runMigrations,
} from '@runguild/database'
import {
  GitWorktreeManager,
  IntegrationCoordinator,
} from '@runguild/workspace-tools'

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

const databaseUrl = requiredSetting('DATABASE_URL')
const repositoryPath = requiredSetting('REPOSITORY_ROOT')
const worktreeRoot = requiredSetting('WORKTREE_ROOT')
const pollMs = integerSetting('INTEGRATION_POLL_MS', 2_000, 100, 60_000)
const leaseSeconds = integerSetting('INTEGRATION_LEASE_SECONDS', 120, 5, 3_600)
const limit = integerSetting('INTEGRATION_BATCH_SIZE', 10, 1, 1_000)

const pool = createDatabasePool(databaseUrl)
if (process.env.AUTO_MIGRATE === 'true') await runMigrations(pool)
const worktrees = new TaskWorktreeRepository(pool)
const manager = await GitWorktreeManager.create({ repositoryPath, worktreeRoot, store: worktrees })
const coordinator = new IntegrationCoordinator({
  worktrees,
  tasks: new TaskRepository(pool),
  manager,
})

let stopping = false
const heartbeat = await startWorkerHeartbeat({
  repository: new WorkerInstanceRepository(pool),
  kind: 'integration',
  onFailure(error) {
    stopping = true
    process.stderr.write(JSON.stringify({ type: 'integration.heartbeat_failed', message: error.message }) + '\n')
  },
})
const stop = () => { stopping = true }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  while (!stopping && heartbeat.isAlive()) {
    const result = await coordinator.tick({ limit, leaseSeconds })
    if (result.discovered > 0) {
      process.stdout.write(JSON.stringify({ type: 'integration.tick', ...result }) + '\n')
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

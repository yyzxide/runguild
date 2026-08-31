import { setTimeout as delay } from 'node:timers/promises'

import {
  OutboxRepository,
  ReviewRepository,
  SchedulerRepository,
  TaskRepository,
  WorkerInstanceRepository,
  createDatabasePool,
  runMigrations,
} from '@runguild/database'
import { Redis } from 'ioredis'

import { runWorkerTick } from './tick.js'
import { startWorkerHeartbeat } from './worker-heartbeat.js'

const databaseUrl = process.env.DATABASE_URL
const redisUrl = process.env.REDIS_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
if (!redisUrl) throw new Error('REDIS_URL is required')

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum)
  }
  return value
}

const intervalMs = integerSetting('SCHEDULER_INTERVAL_MS', 1_000, 100, 60_000)
const pool = createDatabasePool(databaseUrl)
if (process.env.AUTO_MIGRATE === 'true') {
  await runMigrations(pool)
}
const redis = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
})
await redis.connect()

const scheduler = new SchedulerRepository(pool)
const tasks = new TaskRepository(pool)
const reviews = new ReviewRepository(pool)
const outbox = new OutboxRepository(pool)
let stopping = false
const heartbeat = await startWorkerHeartbeat({
  repository: new WorkerInstanceRepository(pool),
  kind: 'scheduler',
  onFailure(error) {
    stopping = true
    process.stderr.write(JSON.stringify({ type: 'worker.heartbeat_failed', message: error.message }) + '\n')
  },
})

const stop = () => {
  stopping = true
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  while (!stopping && heartbeat.isAlive()) {
    const startedAt = Date.now()
    try {
      const result = await runWorkerTick({
        scheduler,
        tasks,
        reviews,
        outbox,
        publisher: {
          async publish(topic, payload) {
            await redis.publish(topic, JSON.stringify(payload))
          },
        },
      }, {
        recoveryLimit: 50,
        reviewRecoveryLimit: 50,
        dispatchLimit: 50,
        dispatchSeconds: 60,
        outboxLimit: 100,
        outboxClaimSeconds: 30,
      })
      if (result.recovered > 0 || result.reviewsRecovered > 0 || result.dispatched > 0
          || result.published > 0 || result.publishFailed > 0) {
        process.stdout.write(JSON.stringify({
          type: 'worker.tick',
          ...result,
          durationMs: Date.now() - startedAt,
        }) + '\n')
      }
    } catch (error) {
      process.stderr.write(JSON.stringify({
        type: 'worker.error',
        message: error instanceof Error ? error.message : String(error),
      }) + '\n')
    }
    await delay(intervalMs)
  }
} finally {
  try {
    await heartbeat.stop()
  } finally {
    redis.disconnect()
    await pool.end()
  }
}

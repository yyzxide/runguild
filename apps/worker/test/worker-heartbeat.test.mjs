import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { startWorkerHeartbeat } from '../dist/worker-heartbeat.js'

test('Worker heartbeat registers identity and marks a graceful stop', async () => {
  const calls = []
  const repository = {
    async register(input) {
      calls.push(['register', input])
      return {
        id: input.id, kind: input.kind, workspaceId: null, agentId: null,
        startedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:15.000Z',
      }
    },
    async heartbeat(id) { calls.push(['heartbeat', id]); return true },
    async markStopped(id) { calls.push(['stop', id]); return true },
  }
  const heartbeat = await startWorkerHeartbeat({
    repository,
    kind: 'scheduler',
    instanceId: 'worker_test',
    hostname: 'test-host',
    processId: 101,
    heartbeatIntervalMs: 1_000,
  })
  assert.equal(heartbeat.isAlive(), true)
  assert.equal(calls[0][1].heartbeatTimeoutSeconds, 3)
  await heartbeat.stop()
  assert.equal(heartbeat.isAlive(), false)
  assert.deepEqual(calls.at(-1), ['stop', 'worker_test'])
})

test('Worker heartbeat becomes unhealthy when database ownership is lost', async () => {
  let failure
  const repository = {
    async register(input) {
      return {
        id: input.id, kind: input.kind, workspaceId: null, agentId: null,
        startedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:03.000Z',
      }
    },
    async heartbeat() { return false },
    async markStopped() { return false },
  }
  const heartbeat = await startWorkerHeartbeat({
    repository,
    kind: 'integration',
    instanceId: 'worker_lost',
    hostname: 'test-host',
    processId: 102,
    heartbeatIntervalMs: 1_000,
    onFailure(error) { failure = error },
  })
  await delay(1_100)
  assert.equal(heartbeat.isAlive(), false)
  assert.match(failure.message, /ownership was lost/)
  await heartbeat.stop()
})

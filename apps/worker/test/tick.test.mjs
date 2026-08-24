import assert from 'node:assert/strict'
import test from 'node:test'

import { runWorkerTick } from '../dist/tick.js'

test('worker dispatches tasks and acknowledges published outbox rows', async () => {
  const published = []
  const marked = []
  const result = await runWorkerTick({
    scheduler: {
      async dispatchReadyTasks() {
        return [{ id: 'dispatch_1' }]
      },
    },
    outbox: {
      async claimBatch() {
        return [
          {
            id: 'out_1',
            topic: 'topic.one',
            payload: { value: 1 },
            attempts: 0,
            claimToken: 'claim_1',
          },
        ]
      },
      async markPublished(id, token) {
        marked.push([id, token])
        return true
      },
      async markFailed() {
        throw new Error('not expected')
      },
    },
    publisher: {
      async publish(topic, payload) {
        published.push([topic, payload])
      },
    },
  }, {
    dispatchLimit: 10,
    dispatchSeconds: 60,
    outboxLimit: 10,
    outboxClaimSeconds: 30,
  })

  assert.deepEqual(result, { dispatched: 1, published: 1, publishFailed: 0 })
  assert.deepEqual(published, [['topic.one', { value: 1 }]])
  assert.deepEqual(marked, [['out_1', 'claim_1']])
})

test('worker retries a failed publication without acknowledging it', async () => {
  const failures = []
  const result = await runWorkerTick({
    scheduler: {
      async dispatchReadyTasks() {
        return []
      },
    },
    outbox: {
      async claimBatch() {
        return [
          {
            id: 'out_failed',
            topic: 'topic.failed',
            payload: {},
            attempts: 2,
            claimToken: 'claim_failed',
          },
        ]
      },
      async markPublished() {
        throw new Error('not expected')
      },
      async markFailed(input) {
        failures.push(input)
        return true
      },
    },
    publisher: {
      async publish() {
        throw new Error('redis unavailable')
      },
    },
  }, {
    dispatchLimit: 10,
    dispatchSeconds: 60,
    outboxLimit: 10,
    outboxClaimSeconds: 30,
  })

  assert.deepEqual(result, { dispatched: 0, published: 0, publishFailed: 1 })
  assert.deepEqual(failures, [{
    id: 'out_failed',
    claimToken: 'claim_failed',
    error: 'redis unavailable',
    retryDelaySeconds: 4,
  }])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { routeRequest } from '../src/router.mjs'

test('creates one normalized task with a deterministic id', () => {
  assert.deepEqual(
    routeRequest({
      method: 'POST',
      path: '/tasks',
      body: { title: '  Ship API Docs!  ', priority: 'high' },
    }),
    {
      status: 201,
      body: {
        task: {
          id: 'task_ship-api-docs',
          title: 'Ship API Docs!',
          priority: 'high',
        },
      },
    },
  )
  assert.equal(
    routeRequest({ method: 'POST', path: '/tasks', body: { title: 'Triage' } }).body.task.priority,
    'normal',
  )
})

test('returns stable validation errors', () => {
  assert.deepEqual(
    routeRequest({ method: 'POST', path: '/tasks', body: { title: '   ' } }),
    { status: 400, body: { error: { code: 'invalid_title' } } },
  )
  assert.deepEqual(
    routeRequest({ method: 'POST', path: '/tasks', body: { title: 'Ship', priority: 'urgent' } }),
    { status: 400, body: { error: { code: 'invalid_priority' } } },
  )
})

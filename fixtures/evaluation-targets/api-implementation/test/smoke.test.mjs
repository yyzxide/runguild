import assert from 'node:assert/strict'
import test from 'node:test'
import { routeRequest } from '../src/router.mjs'

test('keeps the health route stable', () => {
  assert.deepEqual(routeRequest({ method: 'GET', path: '/health' }), {
    status: 200,
    body: { status: 'ok' },
  })
})

test('keeps unknown routes explicit', () => {
  assert.equal(routeRequest({ method: 'DELETE', path: '/unknown' }).status, 404)
})

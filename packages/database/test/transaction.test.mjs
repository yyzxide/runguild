import assert from 'node:assert/strict'
import test from 'node:test'

import { withTransaction } from '../dist/index.js'

function fakePool() {
  const statements = []
  let released = false
  const client = {
    async query(statement) {
      statements.push(statement)
      return { rows: [], rowCount: 0 }
    },
    release() {
      released = true
    },
  }
  return {
    pool: {
      async connect() {
        return client
      },
    },
    statements,
    wasReleased: () => released,
  }
}

test('transaction commits and releases the client', async () => {
  const fake = fakePool()
  const value = await withTransaction(fake.pool, async (client) => {
    await client.query('SELECT work')
    return 42
  })

  assert.equal(value, 42)
  assert.deepEqual(fake.statements, ['BEGIN', 'SELECT work', 'COMMIT'])
  assert.equal(fake.wasReleased(), true)
})

test('transaction rolls back and releases after failure', async () => {
  const fake = fakePool()
  await assert.rejects(
    withTransaction(fake.pool, async () => {
      throw new Error('boom')
    }),
    /boom/,
  )

  assert.deepEqual(fake.statements, ['BEGIN', 'ROLLBACK'])
  assert.equal(fake.wasReleased(), true)
})

test('serializable transaction sets isolation before work', async () => {
  const fake = fakePool()
  await withTransaction(fake.pool, async () => undefined, 'serializable')
  assert.deepEqual(fake.statements, [
    'BEGIN',
    'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'COMMIT',
  ])
})

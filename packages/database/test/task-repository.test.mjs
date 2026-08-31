import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskRepository } from '../dist/index.js'

function scriptedPool(claimable) {
  const statements = []
  const client = {
    async query(statement) {
      statements.push(statement)
      if (statement.startsWith('SELECT m.project_id, t.attempt_count')) {
        return {
          rows: claimable ? [{ project_id: 'project_test', attempt_count: 0, dispatch_id: 'dispatch_test' }] : [],
          rowCount: claimable ? 1 : 0,
        }
      }
      if (statement.startsWith('INSERT INTO task_leases')) {
        return { rows: [{ expires_at: new Date('2030-01-01T00:00:00.000Z') }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return {
    pool: {
      async connect() {
        return client
      },
    },
    statements,
  }
}

function claimInput() {
  return {
    workspaceId: 'ws_test',
    projectId: 'project_test',
    missionId: 'mission_test',
    taskId: 'task_test',
    agentId: 'agent_test',
    runId: 'run_test',
    correlationId: 'correlation_test',
    dispatchToken: 'dispatch_token_test',
    leaseSeconds: 60,
  }
}

test('claim creates run, lease, three events, and commits atomically', async () => {
  const scripted = scriptedPool(true)
  const repository = new TaskRepository(scripted.pool)
  const result = await repository.claimTask(claimInput())

  assert.equal(result.claimed, true)
  assert.equal(result.attempt, 1)
  assert.equal(result.leaseExpiresAt, '2030-01-01T00:00:00.000Z')
  assert.equal(scripted.statements[0], 'BEGIN')
  assert.equal(scripted.statements.at(-1), 'COMMIT')
  assert.equal(scripted.statements.filter((sql) => sql.startsWith('INSERT INTO agent_runs')).length, 1)
  assert.equal(scripted.statements.filter((sql) => sql.startsWith('INSERT INTO task_leases')).length, 1)
  assert.equal(scripted.statements.filter((sql) => sql.startsWith('INSERT INTO domain_events')).length, 3)
  assert.equal(scripted.statements.filter((sql) => sql.startsWith('INSERT INTO outbox_events')).length, 3)
})

test('runnable Run lookup carries the exact Agent Project scope into SQL', async () => {
  let observed
  const repository = new TaskRepository({
    async query(statement, params) {
      observed = { statement, params }
      return { rows: [] }
    },
  })
  assert.deepEqual(await repository.listRunnableAgentRuns({
    agentId: 'agent_test',
    workspaceId: 'ws_test',
    projectId: 'project_test',
    limit: 7,
  }), [])
  assert.match(observed.statement, /m\.project_id = \$3/)
  assert.deepEqual(observed.params, ['agent_test', 'ws_test', 'project_test', 7])
})

test('non-claimable task creates no run, lease, event, or outbox row', async () => {
  const scripted = scriptedPool(false)
  const repository = new TaskRepository(scripted.pool)
  const result = await repository.claimTask(claimInput())

  assert.deepEqual(result, { claimed: false, reason: 'not_claimable' })
  assert.equal(scripted.statements.length, 3)
  assert.equal(scripted.statements[0], 'BEGIN')
  assert.match(scripted.statements[1], /^SELECT m\.project_id, t\.attempt_count/)
  assert.equal(scripted.statements.at(-1), 'COMMIT')
  assert.equal(scripted.statements.some((sql) => sql.startsWith('INSERT INTO agent_runs')), false)
  assert.equal(scripted.statements.some((sql) => sql.startsWith('INSERT INTO task_leases')), false)
  assert.equal(scripted.statements.some((sql) => sql.startsWith('INSERT INTO domain_events')), false)
})

test('invalid lease duration fails before opening a transaction', async () => {
  const scripted = scriptedPool(true)
  const repository = new TaskRepository(scripted.pool)
  await assert.rejects(
    repository.claimTask({ ...claimInput(), leaseSeconds: 1 }),
    /leaseSeconds/,
  )
  assert.equal(scripted.statements.length, 0)
})

test('human retry preserves attempts, adds one bounded attempt, and records an event', async () => {
  const statements = []
  const client = {
    async query(statement) {
      statements.push(statement)
      if (statement.startsWith('SELECT m.project_id, m.status AS mission_status')) {
        return {
          rows: [{
            project_id: 'project_test',
            mission_status: 'running',
            task_status: 'failed',
            max_attempts: 3,
            dependencies_complete: true,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const repository = new TaskRepository({ async connect() { return client } })
  const result = await repository.retryFailedTask({
    workspaceId: 'ws_test',
    missionId: 'mission_test',
    taskId: 'task_test',
    requestedBy: 'user_test',
    reason: 'Runtime repair was deployed.',
    correlationId: 'correlation_retry',
  })

  assert.deepEqual(result, { retried: true, maxAttempts: 4 })
  assert.equal(statements.some((sql) =>
    sql.startsWith("UPDATE tasks SET status = 'ready', max_attempts = $2")), true)
  assert.equal(statements.filter((sql) => sql.startsWith('INSERT INTO domain_events')).length, 1)
  assert.equal(statements.filter((sql) => sql.startsWith('INSERT INTO outbox_events')).length, 1)
})

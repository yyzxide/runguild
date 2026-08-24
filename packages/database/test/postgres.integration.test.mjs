import assert from 'node:assert/strict'
import test from 'node:test'

import { Pool } from 'pg'

import {
  InboxDedupeConflictError,
  InboxRepository,
  OutboxRepository,
  TaskRepository,
  runMigrations,
} from '../dist/index.js'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl && process.env.REQUIRE_POSTGRES === '1') {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
}

async function resetDatabase(pool) {
  await pool.query('TRUNCATE outbox_events, domain_events, workspaces CASCADE')
}

async function seedMission(pool) {
  await pool.query("INSERT INTO workspaces (id, name) VALUES ('ws_test', 'Test')")
  await pool.query(
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project_test', 'ws_test', 'Test Project')",
  )
  await pool.query(
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) " +
    "VALUES ('mission_test', 'ws_test', 'project_test', 'Mission', 'Test mission', 'running', 'user_test')",
  )
  await pool.query(
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('agent_a', 'ws_test', 'Builder A', 'builder', 'test', 'test'), " +
    "('agent_b', 'ws_test', 'Builder B', 'builder', 'test', 'test')",
  )
}

test('PostgreSQL coordination integration', { skip: !databaseUrl }, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  try {
    await runMigrations(pool)

    await t.test('only one competing agent claims a ready task', async () => {
      await resetDatabase(pool)
      await seedMission(pool)
      await pool.query(
        "INSERT INTO tasks (id, mission_id, title, status, required_role) " +
        "VALUES ('task_claim', 'mission_test', 'Claim me', 'ready', 'builder')",
      )
      await pool.query(
        "INSERT INTO task_dispatches " +
        "(id, workspace_id, mission_id, task_id, agent_id, attempt, dispatch_token, expires_at) " +
        "VALUES ('dispatch_claim', 'ws_test', 'mission_test', 'task_claim', 'agent_a', 1, " +
        "'dispatch_token_claim', NOW() + INTERVAL '60 seconds')",
      )

      const repository = new TaskRepository(pool)
      const [first, second] = await Promise.all([
        repository.claimTask({
          workspaceId: 'ws_test',
          missionId: 'mission_test',
          taskId: 'task_claim',
          agentId: 'agent_a',
          runId: 'run_a',
          correlationId: 'correlation_claim',
          dispatchToken: 'dispatch_token_claim',
          leaseSeconds: 60,
        }),
        repository.claimTask({
          workspaceId: 'ws_test',
          missionId: 'mission_test',
          taskId: 'task_claim',
          agentId: 'agent_b',
          runId: 'run_b',
          correlationId: 'correlation_claim',
          dispatchToken: 'dispatch_token_claim',
          leaseSeconds: 60,
        }),
      ])

      assert.equal([first, second].filter((result) => result.claimed).length, 1)
      assert.equal([first, second].filter((result) => !result.claimed).length, 1)
      const counts = await pool.query(
        "SELECT " +
        "(SELECT COUNT(*)::int FROM task_leases WHERE task_id = 'task_claim') AS leases, " +
        "(SELECT COUNT(*)::int FROM agent_runs WHERE task_id = 'task_claim') AS runs",
      )
      assert.deepEqual(counts.rows[0], { leases: 1, runs: 1 })
    })

    await t.test('expired lease times out the run and makes work ready again', async () => {
      await pool.query(
        "UPDATE task_leases SET heartbeat_at = NOW() - INTERVAL '10 seconds', " +
        "expires_at = NOW() - INTERVAL '1 second' WHERE task_id = 'task_claim'",
      )
      const repository = new TaskRepository(pool)
      const recovered = await repository.recoverExpiredLeases(10, 'correlation_recovery')
      assert.deepEqual(recovered, ['task_claim'])

      const state = await pool.query(
        "SELECT t.status AS task_status, r.status AS run_status, " +
        "EXISTS (SELECT 1 FROM task_leases l WHERE l.task_id = t.id) AS has_lease " +
        "FROM tasks t JOIN agent_runs r ON r.task_id = t.id WHERE t.id = 'task_claim'",
      )
      assert.deepEqual(state.rows[0], {
        task_status: 'ready',
        run_status: 'timed_out',
        has_lease: false,
      })
    })

    await t.test('durable inbox deduplicates payload and advances by cursor', async () => {
      await resetDatabase(pool)
      await seedMission(pool)
      const inbox = new InboxRepository(pool)
      const input = {
        id: 'inbox_1',
        workspaceId: 'ws_test',
        agentId: 'agent_a',
        missionId: 'mission_test',
        kind: 'task.ready',
        payload: { taskId: 'task_1' },
        dedupeKey: 'task.ready:task_1',
      }

      const first = await inbox.enqueue(input)
      const duplicate = await inbox.enqueue(input)
      assert.equal(first.inserted, true)
      assert.deepEqual(duplicate, { seq: first.seq, inserted: false })

      await assert.rejects(
        inbox.enqueue({
          ...input,
          id: 'inbox_2',
          payload: { taskId: 'different' },
        }),
        InboxDedupeConflictError,
      )

      const batch = await inbox.read({ agentId: 'agent_a', limit: 10 })
      assert.equal(batch.cursor, 0n)
      assert.equal(batch.messages.length, 1)
      assert.equal(await inbox.acknowledge({
        agentId: 'agent_a',
        expectedCursor: batch.cursor,
        throughSeq: batch.messages[0].seq,
      }), true)
      assert.equal((await inbox.read({ agentId: 'agent_a', limit: 10 })).messages.length, 0)
    })

    await t.test('outbox rows are exclusively claimed and explicitly published', async () => {
      const outbox = new OutboxRepository(pool)
      const [left, right] = await Promise.all([
        outbox.claimBatch({ limit: 10, claimSeconds: 30 }),
        outbox.claimBatch({ limit: 10, claimSeconds: 30 }),
      ])
      assert.equal(left.length + right.length, 1)
      const event = left[0] ?? right[0]
      assert.ok(event)
      assert.equal(await outbox.markPublished(event.id, event.claimToken), true)
      assert.equal(await outbox.markPublished(event.id, event.claimToken), false)
    })

    await t.test('completing a reviewed task unlocks its dependent', async () => {
      await resetDatabase(pool)
      await seedMission(pool)
      await pool.query(
        "INSERT INTO tasks (id, mission_id, title, status, review_required, position) VALUES " +
        "('task_parent', 'mission_test', 'Parent', 'reviewing', FALSE, 1), " +
        "('task_child', 'mission_test', 'Child', 'blocked', FALSE, 2)",
      )
      await pool.query(
        "INSERT INTO task_dependencies (mission_id, task_id, depends_on_task_id) " +
        "VALUES ('mission_test', 'task_child', 'task_parent')",
      )

      const repository = new TaskRepository(pool)
      const result = await repository.completeTaskAndUnlockDependents({
        workspaceId: 'ws_test',
        missionId: 'mission_test',
        taskId: 'task_parent',
        actor: { kind: 'system', id: 'integration-test' },
        correlationId: 'correlation_complete',
      })
      assert.deepEqual(result, {
        completed: true,
        unlockedTaskIds: ['task_child'],
        missionReadyForReview: false,
      })
      const child = await pool.query("SELECT status FROM tasks WHERE id = 'task_child'")
      assert.equal(child.rows[0].status, 'ready')
    })
  } finally {
    await pool.end()
  }
})

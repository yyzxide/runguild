import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { Pool } from 'pg'

import {
  InboxDedupeConflictError,
  InboxRepository,
  OutboxRepository,
  ProjectLifecycleRepository,
  ProjectProvisioningRepository,
  TaskRepository,
  runMigrations,
} from '../dist/index.js'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    'PostgreSQL integration tests require TEST_DATABASE_URL. Run npm test or npm run test:integration ' +
    'to start an isolated test database, or provide a dedicated PostgreSQL URL whose database name ends in _test.',
  )
}

function isDedicatedTestDatabaseName(name) {
  return typeof name === 'string' && name.endsWith('_test')
}

function assertDedicatedTestDatabaseUrl(value) {
  let url
  let name
  try {
    url = new URL(value)
    name = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL for a dedicated _test database')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !isDedicatedTestDatabaseName(name)) {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL whose database name ends in _test')
  }
}

assertDedicatedTestDatabaseUrl(databaseUrl)

async function assertDedicatedTestDatabase(pool) {
  const result = await pool.query('SELECT current_database() AS name')
  const name = result.rows[0]?.name
  if (!isDedicatedTestDatabaseName(name)) {
    throw new Error(
      'Refusing destructive PostgreSQL integration tests outside a database whose name ends in _test',
    )
  }
}

test('PostgreSQL integration suite requires a dedicated _test database name', () => {
  assert.equal(isDedicatedTestDatabaseName('mission_control_test'), true)
  assert.equal(isDedicatedTestDatabaseName('mission_control'), false)
  assert.equal(isDedicatedTestDatabaseName('production'), false)
  assert.equal(isDedicatedTestDatabaseName(undefined), false)
  assert.doesNotThrow(() => assertDedicatedTestDatabaseUrl('postgresql://localhost/mission_control_test'))
  assert.throws(() => assertDedicatedTestDatabaseUrl('postgresql://localhost/mission_control'))
  assert.throws(() => assertDedicatedTestDatabaseUrl('http://localhost/mission_control_test'))
  assert.throws(() => assertDedicatedTestDatabaseUrl('not a connection URL'))
})

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

async function seedClaimableTask(pool) {
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
}

function claimInput(runId, agentId = 'agent_a') {
  return {
    workspaceId: 'ws_test',
    projectId: 'project_test',
    missionId: 'mission_test',
    taskId: 'task_claim',
    agentId,
    runId,
    correlationId: 'correlation_claim',
    dispatchToken: 'dispatch_token_claim',
    leaseSeconds: 60,
  }
}

const goalHistory = ['0027_mission_budget.sql', '0028_goal_verification.sql']
const mainHistory = [
  '0027_protected_test_paths.sql', '0028_test_sandbox_config.sql',
  '0029_evaluation_unknown_pricing.sql', '0030_model_provider_provenance.sql',
]

async function verifyHistoricalUpgrade(admin, history) {
  const schema = 'migration_upgrade_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE SCHEMA "' + schema + '"')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, options: '-c search_path=' + schema })
  try {
    await pool.query('CREATE TABLE schema_migrations (' +
      'name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())')
    const folder = new URL('../migrations/', import.meta.url)
    const common = (await readdir(folder)).filter((name) => /^00\d\d_.*\.sql$/.test(name)
      && Number(name.slice(0, 4)) <= 26).sort()
    assert.equal(common.length, 26)
    const applyHistorical = async (names) => {
      for (const name of names) {
        const sql = await readFile(new URL(name, folder), 'utf8')
        await pool.query(sql)
        await pool.query(
          "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ($1, $2, '2026-09-26T00:00:00Z')",
          [name, createHash('sha256').update(sql).digest('hex')],
        )
      }
    }
    await applyHistorical(common)
    await seedMission(pool)
    await pool.query("INSERT INTO tasks (id, mission_id, title, status, attempt_count) " +
      "VALUES ('task_upgrade', 'mission_test', 'Keep existing work', 'running', 1)")
    await pool.query("INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status) " +
      "VALUES ('run_upgrade', 'ws_test', 'mission_test', 'task_upgrade', 'agent_a', 1, 'running')")
    await pool.query("INSERT INTO llm_calls " +
      '(id, workspace_id, mission_id, task_id, run_id, hop, provider, model, status, request_hash, ' +
      'request_redacted, input_tokens, output_tokens) VALUES ' +
      "('call_upgrade', 'ws_test', 'mission_test', 'task_upgrade', 'run_upgrade', 1, 'test', 'test', " +
      "'succeeded', 'request-hash', '{}', 7, 5)")
    await applyHistorical(history === 'goal' ? goalHistory : mainHistory)
    if (history === 'goal') {
      await pool.query("UPDATE missions SET budget_tokens = 0, goal_verification = TRUE, " +
        "verification_task_id = 'task_upgrade' WHERE id = 'mission_test'")
    }
    await pool.query("INSERT INTO project_runtime_configs (project_id, workspace_id) VALUES ('project_test', 'ws_test')")
    if (history === 'main') {
      await pool.query("UPDATE project_runtime_configs SET protected_test_paths = '[\"tests/acceptance.mjs\"]', " +
        "test_sandbox_mode = 'bubblewrap', test_network_mode = 'none', test_max_processes = 256 " +
        "WHERE project_id = 'project_test'")
      await pool.query("UPDATE llm_calls SET endpoint = 'https://provider.example/v1', " +
        "returned_model = 'observed-model' WHERE id = 'call_upgrade'")
    }
    const original = (await pool.query('SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name')).rows

    assert.deepEqual(await runMigrations(pool), history === 'goal' ? mainHistory : goalHistory)
    assert.deepEqual(await runMigrations(pool), [], 'repeat startup must not replay either historical branch')
    const retained = (await pool.query(
      'SELECT name, checksum, applied_at FROM schema_migrations WHERE name = ANY($1::text[]) ORDER BY name',
      [original.map((row) => row.name)],
    )).rows
    assert.deepEqual(retained, original, 'historical identities, checksums and timestamps must survive')
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations')).rows[0].count, 32)
    const mission = (await pool.query(
      'SELECT title, budget_tokens, goal_verification, verification_task_id FROM missions WHERE id = $1',
      ['mission_test'],
    )).rows[0]
    assert.equal(mission.title, 'Mission')
    assert.equal(mission.goal_verification, history === 'goal')
    assert.equal(mission.budget_tokens, history === 'goal' ? '0' : null)
    assert.equal(mission.verification_task_id, history === 'goal' ? 'task_upgrade' : null)
    assert.deepEqual((await pool.query(
      "SELECT id, input_tokens, output_tokens, status FROM mission_model_calls WHERE mission_id = 'mission_test'",
    )).rows, [{ id: 'legacy:execution:call_upgrade', input_tokens: '7', output_tokens: '5', status: 'completed' }])
    const runtime = (await pool.query('SELECT protected_test_paths, test_sandbox_mode, test_network_mode, ' +
      "test_max_processes FROM project_runtime_configs WHERE project_id = 'project_test'")).rows[0]
    assert.deepEqual(runtime, history === 'main'
      ? { protected_test_paths: ['tests/acceptance.mjs'], test_sandbox_mode: 'bubblewrap', test_network_mode: 'none', test_max_processes: 256 }
      : { protected_test_paths: [], test_sandbox_mode: 'trusted_process', test_network_mode: 'host', test_max_processes: 128 })
    assert.deepEqual((await pool.query(
      "SELECT endpoint, returned_model FROM llm_calls WHERE id = 'call_upgrade'",
    )).rows[0], history === 'main'
      ? { endpoint: 'https://provider.example/v1', returned_model: 'observed-model' }
      : { endpoint: null, returned_model: null })
  } finally {
    await pool.end()
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE')
  }
}

test('PostgreSQL coordination integration', async (t) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  try {
    await assertDedicatedTestDatabase(pool)
    await runMigrations(pool)

    for (const history of ['goal', 'main']) {
      await t.test('upgrades the existing ' + history + ' migration history without replay or data loss', async () => {
        await verifyHistoricalUpgrade(pool, history)
      })
    }

    await t.test('a different agent cannot consume another agent\'s dispatch', async () => {
      await seedClaimableTask(pool)
      assert.deepEqual(await new TaskRepository(pool).claimTask(claimInput('run_foreign', 'agent_b')), {
        claimed: false, reason: 'not_claimable',
      })
      const state = await pool.query(
        "SELECT t.status AS task_status, t.attempt_count, d.status AS dispatch_status, " +
        "(SELECT COUNT(*)::int FROM agent_runs WHERE task_id = t.id) AS runs " +
        "FROM tasks t JOIN task_dispatches d ON d.task_id = t.id WHERE t.id = 'task_claim'",
      )
      assert.deepEqual(state.rows[0], {
        task_status: 'ready', attempt_count: 0, dispatch_status: 'pending', runs: 0,
      })
    })

    await t.test('competing connections consume the same authorized dispatch only once', async () => {
      await seedClaimableTask(pool)
      const left = new Pool({ connectionString: databaseUrl, max: 1 })
      const right = new Pool({ connectionString: databaseUrl, max: 1 })
      try {
        const [leftBackend, rightBackend] = await Promise.all([
          left.query('SELECT pg_backend_pid() AS pid'),
          right.query('SELECT pg_backend_pid() AS pid'),
        ])
        assert.notEqual(leftBackend.rows[0].pid, rightBackend.rows[0].pid)
        const results = await Promise.all([
          new TaskRepository(left).claimTask(claimInput('run_a')),
          new TaskRepository(right).claimTask(claimInput('run_b')),
        ])
        assert.equal(results.filter((result) => result.claimed).length, 1)
        assert.deepEqual(results.find((result) => !result.claimed), {
          claimed: false, reason: 'not_claimable',
        })
        const counts = await pool.query(
          "SELECT " +
          "(SELECT COUNT(*)::int FROM task_leases WHERE task_id = 'task_claim') AS leases, " +
          "(SELECT COUNT(*)::int FROM agent_runs WHERE task_id = 'task_claim') AS runs, " +
          "(SELECT attempt_count FROM tasks WHERE id = 'task_claim') AS attempts, " +
          "(SELECT status FROM task_dispatches WHERE id = 'dispatch_claim') AS dispatch_status",
        )
        assert.deepEqual(counts.rows[0], { leases: 1, runs: 1, attempts: 1, dispatch_status: 'consumed' })
      } finally {
        await Promise.all([left.end(), right.end()])
      }
    })

    await t.test('expired lease times out the run and makes work ready again', async () => {
      await seedClaimableTask(pool)
      const repository = new TaskRepository(pool)
      assert.equal((await repository.claimTask(claimInput('run_expired'))).claimed, true)
      await pool.query(
        "UPDATE task_leases SET heartbeat_at = NOW() - INTERVAL '10 seconds', " +
        "expires_at = NOW() - INTERVAL '1 second' WHERE task_id = 'task_claim'",
      )
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
      await resetDatabase(pool)
      await seedMission(pool)
      await new InboxRepository(pool).enqueue({
        id: 'inbox_outbox', workspaceId: 'ws_test', agentId: 'agent_a', missionId: 'mission_test',
        kind: 'task.ready', payload: { taskId: 'task_outbox' }, dedupeKey: 'task.ready:task_outbox',
      })
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

    await t.test('workspace provisioning commits one complete Project and Agent team', async () => {
      await resetDatabase(pool)
      await pool.query("INSERT INTO workspaces (id, name) VALUES ('ws_test', 'Test')")
      await pool.query(
        "INSERT INTO users (id, workspace_id, display_name, role) " +
        "VALUES ('creator_test', 'ws_test', 'Creator', 'operator')",
      )
      const project = await new ProjectProvisioningRepository(pool).create({
        workspaceId: 'ws_test', actorId: 'creator_test', projectId: 'project_provision_test',
        name: 'Provisioned', repositoryPath: '/workspace/provisioned', defaultBranch: 'main',
        modelProvider: 'test', modelName: 'test-model',
      })
      assert.equal(project.role, 'owner')
      const counts = await pool.query(
        "SELECT " +
        "(SELECT COUNT(*)::int FROM project_memberships WHERE project_id = 'project_provision_test') AS memberships, " +
        "(SELECT COUNT(*)::int FROM agents WHERE id LIKE 'project_provision_test:agent:%') AS agents, " +
        "(SELECT COUNT(*)::int FROM conversation_members WHERE conversation_id = 'project_provision_test:conversation:team') AS room_members, " +
        "(SELECT COUNT(*)::int FROM project_runtime_configs WHERE project_id = 'project_provision_test') AS runtime_configs",
      )
      assert.deepEqual(counts.rows[0], {
        memberships: 1, agents: 4, room_members: 5, runtime_configs: 1,
      })
      const lifecycle = new ProjectLifecycleRepository(pool)
      const renamed = await lifecycle.update({
        workspaceId: 'ws_test', projectId: project.id, actorId: 'creator_test',
        change: { action: 'rename', name: 'Renamed Provisioned' },
      })
      assert.equal(renamed.name, 'Renamed Provisioned')
      assert.ok((await lifecycle.update({
        workspaceId: 'ws_test', projectId: project.id, actorId: 'creator_test',
        change: { action: 'archive' },
      })).archivedAt)
      assert.equal((await lifecycle.update({
        workspaceId: 'ws_test', projectId: project.id, actorId: 'creator_test',
        change: { action: 'restore' },
      })).archivedAt, null)
    })

    await t.test('completing a task unlocks its dependent', async () => {
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

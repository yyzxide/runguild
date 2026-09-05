import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { ProjectLifecycleRepository, ProjectMembershipRepository } from '../dist/index.js'

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return { async connect() { return client }, query: client.query }
}

async function setup(database) {
  for (const migration of [
    '0001_core.sql',
    '0009_evaluation.sql',
    '0010_conversations.sql',
    '0012_worker_instances.sql',
    '0019_project_scoped_integration_workers.sql',
    '0020_project_scoped_agent_workers.sql',
    '0021_authentication.sql',
  ]) {
    await database.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'))
  }
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
    "INSERT INTO users (id, workspace_id, display_name, role) VALUES " +
    "('owner', 'ws', 'Owner', 'owner'), ('operator', 'ws', 'Operator', 'operator');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project', 'ws', 'Project');",
  )
  await database.exec(await readFile(new URL('../migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0023_project_lifecycle.sql', import.meta.url), 'utf8'))
}

test('Project Lifecycle renames, archives, restores, and exposes archive state through access', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const lifecycle = new ProjectLifecycleRepository(pool)
    const memberships = new ProjectMembershipRepository(pool)

    await assert.rejects(
      lifecycle.update({
        workspaceId: 'ws', projectId: 'project', actorId: 'operator',
        change: { action: 'rename', name: 'Forbidden' },
      }),
      (error) => error.code === 'project_owner_required',
    )
    const renamed = await lifecycle.update({
      workspaceId: 'ws', projectId: 'project', actorId: 'owner',
      change: { action: 'rename', name: '  Renamed Project  ' },
    })
    assert.deepEqual(renamed, {
      id: 'project', name: 'Renamed Project', role: 'owner', archivedAt: null,
    })

    const archived = await lifecycle.update({
      workspaceId: 'ws', projectId: 'project', actorId: 'owner',
      change: { action: 'archive' },
    })
    assert.ok(archived.archivedAt)
    assert.deepEqual(await memberships.getAccess('ws', 'project', 'owner'), {
      role: 'owner', archivedAt: archived.archivedAt,
    })
    await assert.rejects(
      lifecycle.update({
        workspaceId: 'ws', projectId: 'project', actorId: 'owner',
        change: { action: 'rename', name: 'Archived Rename' },
      }),
      (error) => error.code === 'project_archived',
    )

    const restored = await lifecycle.update({
      workspaceId: 'ws', projectId: 'project', actorId: 'owner',
      change: { action: 'restore' },
    })
    assert.equal(restored.archivedAt, null)
    assert.deepEqual(
      (await database.query('SELECT kind FROM project_lifecycle_events ORDER BY id')).rows.map(({ kind }) => kind),
      ['renamed', 'archived', 'restored'],
    )
  } finally {
    await database.close()
  }
})

test('Project Lifecycle refuses archive while project execution is not quiescent', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const lifecycle = new ProjectLifecycleRepository(poolAdapter(database))
    const archive = () => lifecycle.update({
      workspaceId: 'ws', projectId: 'project', actorId: 'owner', change: { action: 'archive' },
    })

    await database.exec(
      "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) " +
      "VALUES ('mission', 'ws', 'project', 'Mission', 'Goal', 'running', 'owner')",
    )
    await assert.rejects(archive(), (error) => error.code === 'project_has_active_missions')
    await database.exec("UPDATE missions SET status = 'completed' WHERE id = 'mission'")

    await database.exec(
      "INSERT INTO worker_instances " +
      "(id, kind, workspace_id, project_id, hostname, process_id, heartbeat_interval_seconds, heartbeat_timeout_seconds, expires_at) " +
      "VALUES ('integration_worker', 'integration', 'ws', 'project', 'local', 1, 5, 15, NOW() + INTERVAL '1 hour')",
    )
    await assert.rejects(archive(), (error) => error.code === 'project_has_active_workers')
    await database.exec(
      "UPDATE worker_instances SET status = 'stopped', stopped_at = NOW(), expires_at = NOW() " +
      "WHERE id = 'integration_worker'",
    )

    await database.exec(
      "INSERT INTO evaluation_scenarios (id, workspace_id, project_id, slug, name) " +
      "VALUES ('scenario', 'ws', 'project', 'scenario', 'Scenario');" +
      "INSERT INTO evaluation_scenario_versions " +
      "(id, scenario_id, workspace_id, project_id, version, definition, definition_hash, created_by) " +
      "VALUES ('scenario_v1', 'scenario', 'ws', 'project', 1, '{}'::jsonb, repeat('a', 64), 'owner');" +
      "INSERT INTO evaluation_experiments " +
      "(id, workspace_id, project_id, scenario_version_id, name, repetitions, variants, created_by) " +
      "VALUES ('experiment', 'ws', 'project', 'scenario_v1', 'Experiment', 1, ARRAY['single_agent'], 'owner')",
    )
    await assert.rejects(archive(), (error) => error.code === 'project_has_active_evaluations')
    await database.exec("UPDATE evaluation_experiments SET status = 'cancelled' WHERE id = 'experiment'")
    assert.ok((await archive()).archivedAt)
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { AuthenticationRepository, ProjectProvisioningRepository } from '../dist/index.js'

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
  await database.exec(await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'))
  await database.exec('ALTER TABLE projects ADD COLUMN repository_path TEXT;')
  for (const migration of [
    '0010_conversations.sql',
    '0013_project_runtime_config.sql',
    '0021_authentication.sql',
  ]) {
    await database.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'))
  }
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
    "INSERT INTO users (id, workspace_id, display_name, role) VALUES " +
    "('creator', 'ws', 'Creator', 'operator'), ('viewer', 'ws', 'Viewer', 'viewer');",
  )
  await database.exec(await readFile(new URL('../migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0023_project_lifecycle.sql', import.meta.url), 'utf8'))
}

test('Project Provisioning creates one complete user-facing workspace atomically', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const provisioning = new ProjectProvisioningRepository(pool)
    const project = await provisioning.create({
      workspaceId: 'ws', actorId: 'creator', projectId: 'project_created',
      name: '  新工作区  ', repositoryPath: '/workspace/repository/../repository',
      defaultBranch: 'develop', modelProvider: 'openai', modelName: 'gpt-test',
    })

    assert.equal(project.id, 'project_created')
    assert.equal(project.name, '新工作区')
    assert.equal(project.role, 'owner')
    assert.equal(project.conversationId, 'project_created:conversation:team')
    assert.deepEqual(project.agents.map(({ role }) => role), ['planner', 'researcher', 'builder', 'reviewer'])

    const storedProject = await database.query(
      "SELECT name, repository_path, default_branch FROM projects WHERE id = 'project_created'",
    )
    assert.deepEqual(storedProject.rows[0], {
      name: '新工作区', repository_path: '/workspace/repository', default_branch: 'develop',
    })
    assert.deepEqual((await database.query(
      "SELECT user_id, role FROM project_memberships WHERE project_id = 'project_created'",
    )).rows[0], { user_id: 'creator', role: 'owner' })
    assert.equal((await database.query("SELECT role FROM users WHERE id = 'creator'")).rows[0].role, 'owner')
    assert.deepEqual((await database.query(
      "SELECT kind, next_role FROM project_membership_events WHERE project_id = 'project_created'",
    )).rows[0], { kind: 'member_added', next_role: 'owner' })

    const runtime = await database.query(
      "SELECT worktree_root, test_commands FROM project_runtime_configs " +
      "WHERE project_id = 'project_created'",
    )
    assert.deepEqual(runtime.rows[0], {
      worktree_root: '/workspace/.runguild-worktrees/project_created',
      test_commands: [['npm', 'test'], ['npm', 'run', 'typecheck']],
    })
    assert.equal((await database.query(
      "SELECT COUNT(*)::int AS count FROM agents WHERE id LIKE 'project_created:agent:%'",
    )).rows[0].count, 4)
    assert.equal((await database.query(
      "SELECT COUNT(*)::int AS count FROM conversation_members WHERE conversation_id = 'project_created:conversation:team'",
    )).rows[0].count, 5)

    const authentication = new AuthenticationRepository(pool)
    assert.deepEqual(await authentication.listProjects('ws', 'viewer'), [])
    assert.deepEqual((await authentication.listProjects('ws', 'creator')).map(({ id, role }) => [id, role]), [
      ['project_created', 'owner'],
    ])
  } finally {
    await database.close()
  }
})

test('Project Provisioning rejects Viewer creation and rolls back generated-id conflicts', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const provisioning = new ProjectProvisioningRepository(poolAdapter(database))
    const base = {
      workspaceId: 'ws', projectId: 'project_forbidden', name: 'Forbidden',
      defaultBranch: 'main', modelProvider: 'openai', modelName: 'gpt-test',
    }
    await assert.rejects(
      provisioning.create({ ...base, actorId: 'viewer' }),
      (error) => error.code === 'project_creation_forbidden',
    )
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM projects WHERE id = 'project_forbidden'")).rows[0].count, 0)

    await database.exec(
      "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) " +
      "VALUES ('project_collision:agent:builder', 'ws', 'Existing', 'builder', 'test', 'test')",
    )
    await assert.rejects(
      provisioning.create({ ...base, actorId: 'creator', projectId: 'project_collision' }),
      (error) => error.code === 'generated_agent_id_conflict',
    )
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM projects WHERE id = 'project_collision'")).rows[0].count, 0)
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM agents WHERE id = 'project_collision:agent:planner'")).rows[0].count, 0)
  } finally {
    await database.close()
  }
})

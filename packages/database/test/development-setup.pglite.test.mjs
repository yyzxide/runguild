import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { DevelopmentSetupRepository } from '../dist/index.js'

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

test('development bootstrap is idempotent and creates a complete local Agent team', async () => {
  const database = new PGlite()
  try {
    await database.exec(await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0010_conversations.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0021_authentication.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
    const repository = new DevelopmentSetupRepository(poolAdapter(database))
    const input = {
      workspaceId: 'demo_workspace', workspaceName: 'Agent Lab',
      projectId: 'demo_project', projectName: 'Demo',
      userId: 'demo_user', displayName: 'Developer',
      modelProvider: 'test', modelName: 'test-model',
    }
    const first = await repository.bootstrap(input)
    const second = await repository.bootstrap({ ...input, projectName: 'Renamed Demo' })

    assert.equal(first.agents.length, 4)
    assert.equal(first.conversationId, 'demo_project:conversation:team')
    assert.deepEqual(second.agents.map((agent) => agent.role), ['planner', 'researcher', 'builder', 'reviewer'])
    const counts = await database.query(
      "SELECT (SELECT COUNT(*)::int FROM workspaces) AS workspaces, " +
      "(SELECT COUNT(*)::int FROM projects) AS projects, " +
      "(SELECT COUNT(*)::int FROM users) AS users, " +
      "(SELECT COUNT(*)::int FROM agents) AS agents, " +
      "(SELECT COUNT(*)::int FROM conversations) AS conversations, " +
      "(SELECT COUNT(*)::int FROM conversation_members) AS members, " +
      "(SELECT name FROM projects WHERE id = 'demo_project') AS project_name",
    )
    assert.deepEqual(counts.rows[0], {
      workspaces: 1, projects: 1, users: 1, agents: 4,
      conversations: 1, members: 5, project_name: 'Renamed Demo',
    })
  } finally {
    await database.close()
  }
})

test('development bootstrap refuses to move an existing id across workspaces', async () => {
  const database = new PGlite()
  try {
    await database.exec(await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0010_conversations.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0021_authentication.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
    await database.exec("INSERT INTO workspaces (id, name) VALUES ('other', 'Other'); INSERT INTO users (id, workspace_id, display_name) VALUES ('shared_user', 'other', 'User');")
    const repository = new DevelopmentSetupRepository(poolAdapter(database))
    await assert.rejects(repository.bootstrap({
      workspaceId: 'demo_workspace', workspaceName: 'Agent Lab',
      projectId: 'demo_project', projectName: 'Demo',
      userId: 'shared_user', displayName: 'Developer',
      modelProvider: 'test', modelName: 'test-model',
    }), /another workspace/)
  } finally {
    await database.close()
  }
})

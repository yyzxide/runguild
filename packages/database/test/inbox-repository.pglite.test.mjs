import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { InboxProjectScopeError, InboxRepository } from '../dist/index.js'

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
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES " +
    "('project', 'ws', 'Project'), ('sibling', 'ws', 'Sibling');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('agent', 'ws', 'Builder', 'builder', 'openai', 'gpt-test');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, created_by) VALUES " +
    "('mission_project', 'ws', 'project', 'Project', 'Goal', 'user'), " +
    "('mission_sibling', 'ws', 'sibling', 'Sibling', 'Goal', 'user');",
  )
}

test('Inbox read returns only the safe prefix and never advances across a foreign Project message', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new InboxRepository(poolAdapter(database))
    const first = await repository.enqueue({
      id: 'inbox_project',
      workspaceId: 'ws',
      agentId: 'agent',
      missionId: 'mission_project',
      kind: 'task.dispatch',
      payload: { project: true },
      dedupeKey: 'project',
    })
    await repository.enqueue({
      id: 'inbox_sibling',
      workspaceId: 'ws',
      agentId: 'agent',
      missionId: 'mission_sibling',
      kind: 'task.dispatch',
      payload: { sibling: true },
      dedupeKey: 'sibling',
    })

    const safe = await repository.read({
      agentId: 'agent', workspaceId: 'ws', projectId: 'project', limit: 10,
    })
    assert.deepEqual(safe.messages.map((message) => message.id), ['inbox_project'])
    assert.equal(await repository.acknowledge({
      agentId: 'agent', expectedCursor: safe.cursor, throughSeq: first.seq,
    }), true)
    await assert.rejects(
      repository.read({ agentId: 'agent', workspaceId: 'ws', projectId: 'project', limit: 10 }),
      InboxProjectScopeError,
    )
    const cursor = await database.query(
      "SELECT last_seq::text FROM inbox_cursors WHERE agent_id = 'agent'",
    )
    assert.equal(cursor.rows[0].last_seq, first.seq.toString())
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import {
  ConversationAccessError,
  ConversationRepository,
  ConversationScopeError,
} from '../dist/index.js'

const migrations = ['0001_core.sql', '0002_orchestration.sql', '0003_runtime.sql', '0010_conversations.sql']

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
  for (const name of migrations) {
    await database.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'))
  }
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project', 'ws', 'Project');" +
    "INSERT INTO users (id, workspace_id, display_name) VALUES " +
    "('user', 'ws', 'Developer'), ('outsider', 'ws', 'Outsider');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('planner', 'ws', 'Planner', 'planner', 'test', 'test'), " +
    "('builder', 'ws', 'Builder', 'builder', 'test', 'test'), " +
    "('reviewer', 'ws', 'Reviewer', 'reviewer', 'test', 'test');",
  )
}

test('Conversation Repository persists messages and routes mentions into active Runs', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ConversationRepository(poolAdapter(database))
    const conversation = await repository.create({
      id: 'conversation',
      workspaceId: 'ws',
      projectId: 'project',
      kind: 'project_room',
      title: 'Team room',
      members: [
        { kind: 'agent', id: 'planner' },
        { kind: 'agent', id: 'builder' },
        { kind: 'agent', id: 'reviewer' },
      ],
      actor: { kind: 'user', id: 'user' },
      correlationId: 'correlation-create',
    })
    assert.equal(conversation.members.length, 4)

    await database.exec(
      "INSERT INTO missions (id, workspace_id, project_id, conversation_id, title, goal, created_by) " +
      "VALUES ('mission', 'ws', 'project', 'conversation', 'Mission', 'Goal', 'user');" +
      "INSERT INTO tasks (id, mission_id, title, status, attempt_count) VALUES " +
      "('task_planner', 'mission', 'Plan', 'running', 1), " +
      "('task_builder', 'mission', 'Build', 'running', 1);" +
      "INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status) VALUES " +
      "('run_planner', 'ws', 'mission', 'task_planner', 'planner', 1, 'running'), " +
      "('run_builder', 'ws', 'mission', 'task_builder', 'builder', 1, 'waiting_human');",
    )

    const posted = await repository.postMessage({
      workspaceId: 'ws',
      conversationId: 'conversation',
      author: { kind: 'user', id: 'user' },
      body: '请 Planner 和 Builder 对齐接口。',
      mentions: ['planner', 'builder', 'reviewer'],
      entityRefs: { missionId: 'mission' },
      idempotencyKey: 'message-1',
      correlationId: 'correlation-message',
    })
    assert.equal(posted.reused, false)
    assert.deepEqual(posted.message.deliveries.map((delivery) => [delivery.agentId, delivery.status]), [
      ['builder', 'steered'],
      ['planner', 'steered'],
      ['reviewer', 'context_pending'],
    ])

    const controls = await database.query(
      'SELECT run_id, kind FROM run_control_requests ORDER BY run_id',
    )
    assert.deepEqual(controls.rows, [
      { run_id: 'run_builder', kind: 'steer' },
      { run_id: 'run_planner', kind: 'steer' },
    ])
    const wakes = await database.query("SELECT COUNT(*)::int AS count FROM inbox_messages WHERE kind = 'run.control'")
    assert.equal(wakes.rows[0].count, 2)

    const reused = await repository.postMessage({
      workspaceId: 'ws',
      conversationId: 'conversation',
      author: { kind: 'user', id: 'user' },
      body: '请 Planner 和 Builder 对齐接口。',
      mentions: ['planner', 'builder', 'reviewer'],
      entityRefs: { missionId: 'mission' },
      idempotencyKey: 'message-1',
      correlationId: 'correlation-retry',
    })
    assert.equal(reused.reused, true)
    assert.equal(reused.message.id, posted.message.id)

    const messages = await repository.listMessages({
      workspaceId: 'ws', conversationId: 'conversation', actor: { kind: 'user', id: 'user' },
    })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].authorName, 'Developer')
    assert.equal(messages[0].entityRefs.missionId, 'mission')
  } finally {
    await database.close()
  }
})

test('Conversation Repository enforces membership, idempotency, and entity scope', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ConversationRepository(poolAdapter(database))
    await repository.create({
      id: 'conversation', workspaceId: 'ws', projectId: 'project', kind: 'group', title: 'Scoped',
      members: [{ kind: 'agent', id: 'planner' }],
      actor: { kind: 'user', id: 'user' }, correlationId: 'create',
    })
    await assert.rejects(
      repository.listMessages({
        workspaceId: 'ws', conversationId: 'conversation', actor: { kind: 'user', id: 'outsider' },
      }),
      ConversationAccessError,
    )
    await assert.rejects(
      repository.postMessage({
        workspaceId: 'ws', conversationId: 'conversation', author: { kind: 'user', id: 'user' },
        body: 'Invalid mention', mentions: ['builder'], correlationId: 'invalid-mention',
      }),
    )
    await assert.rejects(
      repository.postMessage({
        workspaceId: 'ws', conversationId: 'conversation', author: { kind: 'user', id: 'user' },
        body: 'Task without Mission', entityRefs: { taskId: 'task' }, correlationId: 'invalid-scope',
      }),
      ConversationScopeError,
    )
  } finally {
    await database.close()
  }
})

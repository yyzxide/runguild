import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { createConversationToolHandlers } from '../../collaboration/dist/index.js'

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

async function setupAgentCoordination(database) {
  await setup(database)
  const repository = new ConversationRepository(poolAdapter(database))
  await repository.create({
    id: 'conversation', workspaceId: 'ws', projectId: 'project', kind: 'project_room', title: 'Team room',
    members: ['planner', 'builder', 'reviewer'].map((id) => ({ kind: 'agent', id })),
    actor: { kind: 'user', id: 'user' }, correlationId: 'coordination-create',
  })
  await database.exec(
    "INSERT INTO missions (id, workspace_id, project_id, conversation_id, title, goal, created_by) VALUES " +
    "('mission', 'ws', 'project', 'conversation', 'Mission', 'Goal', 'user'), " +
    "('other_mission', 'ws', 'project', 'conversation', 'Other Mission', 'Other Goal', 'user');" +
    "INSERT INTO tasks (id, mission_id, title, status, attempt_count) VALUES " +
    "('task_planner', 'mission', 'Plan', 'running', 1), " +
    "('task_builder', 'mission', 'Build', 'running', 1), " +
    "('other_task_builder', 'other_mission', 'Other Build', 'running', 1), " +
    "('other_task_reviewer', 'other_mission', 'Other Review', 'running', 1);" +
    "INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status, updated_at) VALUES " +
    "('run_planner', 'ws', 'mission', 'task_planner', 'planner', 1, 'running', '2030-01-01'), " +
    "('run_builder', 'ws', 'mission', 'task_builder', 'builder', 1, 'running', '2030-01-01'), " +
    "('other_run_builder', 'ws', 'other_mission', 'other_task_builder', 'builder', 1, 'running', '2030-01-02'), " +
    "('other_run_reviewer', 'ws', 'other_mission', 'other_task_reviewer', 'reviewer', 1, 'running', '2030-01-02');",
  )
  return repository
}

function coordinationRequest(id, mentions) {
  return {
    schemaVersion: 1,
    id,
    action: 'conversation.reply',
    workspaceId: 'ws',
    missionId: 'mission',
    taskId: 'task_planner',
    runId: 'run_planner',
    agentId: 'planner',
    idempotencyKey: id,
    risk: 'workspace_write',
    input: { conversationId: 'conversation', body: 'Please confirm the interface contract.', mentions },
    createdAt: '2030-01-01T00:00:00.000Z',
  }
}

async function coordinationEffects(database) {
  return {
    controls: (await database.query('SELECT * FROM run_control_requests ORDER BY id')).rows,
    inbox: (await database.query("SELECT * FROM inbox_messages WHERE kind = 'run.control' ORDER BY id")).rows,
    outbox: (await database.query("SELECT * FROM outbox_events WHERE payload->>'reason' = 'run.control' ORDER BY id")).rows,
  }
}

test('conversation.reply steers an Agent in another Task and preserves sender provenance on retry', async () => {
  const database = new PGlite()
  try {
    const repository = await setupAgentCoordination(database)
    const [handler] = createConversationToolHandlers({ repository })
    const request = coordinationRequest('cross-task-reply', ['builder'])
    const posted = await handler.execute(request.input, { request })
    assert.deepEqual(posted.output.deliveredAgentIds, ['builder'])
    assert.deepEqual(posted.output.pendingAgentIds, [])
    assert.deepEqual(posted.sideEffects, [{
      type: 'message.posted', conversationId: 'conversation', messageId: posted.output.messageId,
    }])

    const messages = await repository.listMessages({
      workspaceId: 'ws', conversationId: 'conversation', actor: { kind: 'user', id: 'user' },
    })
    assert.equal(messages.length, 1)
    assert.deepEqual(messages[0].entityRefs, {
      missionId: 'mission', taskId: 'task_planner', runId: 'run_planner',
    })
    assert.deepEqual(messages[0].deliveries.map(({ agentId, runId, status }) => ({ agentId, runId, status })), [
      { agentId: 'builder', runId: 'run_builder', status: 'steered' },
    ])

    const effects = await coordinationEffects(database)
    assert.equal(effects.controls.length, 1)
    assert.equal(effects.controls[0].run_id, 'run_builder')
    assert.equal(effects.controls[0].kind, 'steer')
    assert.equal(effects.controls[0].payload.messageId, posted.output.messageId)
    assert.deepEqual(effects.controls[0].payload.author, { kind: 'agent', id: 'planner', runId: 'run_planner' })
    assert.equal(effects.inbox.length, 1)
    assert.equal(effects.inbox[0].agent_id, 'builder')
    assert.equal(effects.inbox[0].run_id, 'run_builder')
    assert.equal(effects.inbox[0].mission_id, 'mission')
    assert.equal(effects.inbox[0].payload.controlId, effects.controls[0].id)
    assert.equal(effects.outbox.length, 1)
    assert.equal(effects.outbox[0].partition_key, 'builder')
    assert.deepEqual(effects.outbox[0].payload, effects.inbox[0].payload)

    const retried = await handler.execute(request.input, { request: { ...request, id: 'retry-cross-task-reply' } })
    assert.deepEqual(retried.output, posted.output)
    assert.deepEqual(retried.sideEffects, [])
    assert.deepEqual(await coordinationEffects(database), effects)
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM messages')).rows[0].count, 1)
  } finally {
    await database.close()
  }
})

test('conversation.reply leaves unavailable recipients pending, stays in its Mission, and never wakes its sender', async () => {
  const database = new PGlite()
  try {
    const repository = await setupAgentCoordination(database)
    await database.exec("UPDATE agent_runs SET status = 'succeeded' WHERE id = 'run_builder'")
    const [handler] = createConversationToolHandlers({ repository })
    const request = coordinationRequest('no-active-recipient', ['builder', 'reviewer', 'planner'])
    const posted = await handler.execute(request.input, { request })
    assert.deepEqual(posted.output.deliveredAgentIds, ['planner'])
    assert.deepEqual(posted.output.pendingAgentIds, ['builder', 'reviewer'])
    assert.deepEqual(await coordinationEffects(database), { controls: [], inbox: [], outbox: [] })
    const deliveries = (await database.query(
      'SELECT agent_id, run_id, status FROM conversation_message_deliveries ORDER BY agent_id',
    )).rows
    assert.deepEqual(deliveries, [
      { agent_id: 'builder', run_id: null, status: 'context_pending' },
      { agent_id: 'planner', run_id: 'run_planner', status: 'context_loaded' },
      { agent_id: 'reviewer', run_id: null, status: 'context_pending' },
    ])
  } finally {
    await database.close()
  }
})

test('a user message with an explicit Task reference only steers Runs in that Task', async () => {
  const database = new PGlite()
  try {
    const repository = await setupAgentCoordination(database)
    const posted = await repository.postMessage({
      workspaceId: 'ws', conversationId: 'conversation', author: { kind: 'user', id: 'user' },
      body: 'Please focus on this Task.', mentions: ['planner', 'builder'],
      entityRefs: { missionId: 'mission', taskId: 'task_planner' }, correlationId: 'task-scoped-user-message',
    })
    assert.deepEqual(posted.message.deliveries.map(({ agentId, runId, status }) => ({ agentId, runId, status })), [
      { agentId: 'builder', runId: undefined, status: 'context_pending' },
      { agentId: 'planner', runId: 'run_planner', status: 'steered' },
    ])
    const effects = await coordinationEffects(database)
    assert.deepEqual(effects.controls.map(({ run_id }) => run_id), ['run_planner'])
    assert.deepEqual(effects.inbox.map(({ run_id }) => run_id), ['run_planner'])
    assert.deepEqual(effects.outbox.map(({ payload }) => payload.runId), ['run_planner'])
  } finally {
    await database.close()
  }
})

test('Agent messages reject forged Run provenance before persisting messages or wakeups', async () => {
  const database = new PGlite()
  try {
    const repository = await setupAgentCoordination(database)
    const invalidSources = [
      {
        description: 'the author claims another Agent Run',
        author: { kind: 'agent', id: 'planner', runId: 'run_builder' },
        entityRefs: { missionId: 'mission', taskId: 'task_builder', runId: 'run_builder' },
      },
      {
        description: 'author Run and referenced Run disagree',
        author: { kind: 'agent', id: 'planner', runId: 'run_planner' },
        entityRefs: { missionId: 'mission', taskId: 'task_builder', runId: 'run_builder' },
      },
      {
        description: 'the author Run is omitted from entity references',
        author: { kind: 'agent', id: 'planner', runId: 'run_planner' },
        entityRefs: { missionId: 'mission', taskId: 'task_planner' },
      },
      {
        description: 'a message without an author Run references another Agent Run',
        author: { kind: 'agent', id: 'planner' },
        entityRefs: { missionId: 'mission', taskId: 'task_builder', runId: 'run_builder' },
      },
    ]
    for (const { description, author, entityRefs } of invalidSources) {
      await assert.rejects(
        repository.postMessage({
          workspaceId: 'ws', conversationId: 'conversation', author, entityRefs,
          body: description, mentions: ['builder'], correlationId: 'invalid-source',
        }),
        ConversationScopeError,
        description,
      )
      assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM messages')).rows[0].count, 0)
      assert.deepEqual(await coordinationEffects(database), { controls: [], inbox: [], outbox: [] })
    }

    const plannerUpdate = await repository.postMessage({
      workspaceId: 'ws', conversationId: 'conversation', author: { kind: 'agent', id: 'planner' },
      entityRefs: { missionId: 'mission' }, body: 'The Mission plan is ready.',
      mentions: ['builder'], correlationId: 'planner-without-run',
    })
    assert.equal(plannerUpdate.message.deliveries[0].status, 'steered')
    assert.equal(plannerUpdate.message.deliveries[0].runId, 'run_builder')
  } finally {
    await database.close()
  }
})

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

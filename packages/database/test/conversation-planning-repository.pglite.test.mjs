import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { ConversationPlanningRepository, MissionBudgetRepository } from '../dist/index.js'

const migrations = [
  '0001_core.sql',
  '0002_orchestration.sql',
  '0003_runtime.sql',
  '0010_conversations.sql',
  '0011_conversation_planning.sql',
  '0014_reviewer_execution.sql',
  '0018_reviewer_model_calls.sql',
  '0021_authentication.sql',
  '0023_project_lifecycle.sql',
  '0027_mission_budget.sql',
  '0028_goal_verification.sql',
]

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
    "('planner', 'ws', 'Planner', 'planner', 'test', 'planner-model'), " +
    "('builder', 'ws', 'Builder', 'builder', 'test', 'builder-model');" +
    "INSERT INTO conversations (id, workspace_id, project_id, kind, title) " +
    "VALUES ('conversation', 'ws', 'project', 'project_room', 'Team room');" +
    "INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) VALUES " +
    "('conversation', 'ws', 'user', 'user'), " +
    "('conversation', 'ws', 'agent', 'planner'), " +
    "('conversation', 'ws', 'agent', 'builder');" +
    "INSERT INTO messages " +
    "(id, workspace_id, conversation_id, author_kind, author_id, body, mentioned_agent_ids) VALUES " +
    "('message_1', 'ws', 'conversation', 'user', 'user', '增加项目级权限，并证明隔离。', ARRAY['planner']), " +
    "('message_2', 'ws', 'conversation', 'user', 'user', '实现必须经过独立审查。', ARRAY[]::TEXT[]);" +
    "INSERT INTO conversation_message_deliveries " +
    "(message_id, conversation_id, agent_id, status) " +
    "VALUES ('message_1', 'conversation', 'planner', 'context_pending');",
  )
}

const plan = {
  summary: '先研究权限边界，再实现并独立审查。',
  tasks: [
    {
      key: 'research', title: '确认权限边界', description: '检查现有鉴权路径。',
      role: 'researcher', priority: 10, dependsOn: [], reviewRequired: false,
      acceptanceCriteria: [{
        key: 'scope', description: '作用域边界明确', required: true,
        evidenceKinds: ['artifact_version'],
      }],
    },
    {
      key: 'build', title: '实现项目权限', description: '完成实现和测试。',
      role: 'builder', priority: 20, dependsOn: ['research'], reviewRequired: true,
      acceptanceCriteria: [{
        key: 'tests', description: '隔离测试通过', required: true,
        evidenceKinds: ['test_run'],
      }],
    },
  ],
}

test('selected Conversation messages atomically create a leased Planner request and Mission', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ConversationPlanningRepository(poolAdapter(database))
    const input = {
      id: 'planning_request', missionId: 'mission_planning', workspaceId: 'ws',
      conversationId: 'conversation', sourceMessageIds: ['message_1', 'message_2'],
      title: '项目级权限交付', createdBy: 'user', correlationId: 'correlation',
      goal: '交付项目权限', constraints: ['保持接口兼容'], acceptanceCriteria: ['跨项目访问被拒绝'],
      goalVerification: true, budgetTokens: 10000,
      idempotencyKey: 'planning-once',
    }
    const created = await repository.create(input)
    assert.equal(created.reused, false)
    assert.equal(created.request.status, 'queued')
    assert.equal(created.request.plannerAgentId, 'planner')
    const replay = await repository.create(input)
    assert.equal(replay.reused, true)
    assert.equal(replay.request.missionId, 'mission_planning')
    await assert.rejects(repository.create({ ...input, constraints: ['允许接口变更'] }), /different input/)
    await assert.rejects(repository.create({ ...input, acceptanceCriteria: ['仅需登录'] }), /different input/)
    await assert.rejects(repository.create({ ...input, budgetTokens: 20000 }), /different input/)
    await assert.rejects(repository.create({ ...input, goalVerification: false }), /different input/)
    await assert.rejects(repository.create({ ...input, budgetTokens: -1 }), /nonnegative safe integer/)
    const contract = (await database.query('SELECT goal, constraints, acceptance_criteria, goal_verification, budget_tokens FROM missions WHERE id = $1', ['mission_planning'])).rows[0]
    assert.deepEqual(contract, { goal: '交付项目权限', constraints: ['保持接口兼容'], acceptance_criteria: ['跨项目访问被拒绝'], goal_verification: true, budget_tokens: 10000 })

    const durable = await database.query(
      "SELECT m.status AS mission_status, m.source_message_ids, r.status AS request_status, " +
      "(SELECT COUNT(*)::int FROM inbox_messages WHERE kind = 'conversation.plan_requested') AS inbox_count, " +
      "(SELECT kind FROM artifacts WHERE mission_id = m.id) AS artifact_kind, " +
      "(SELECT status FROM conversation_message_deliveries WHERE message_id = 'message_1') AS delivery_status " +
      "FROM missions m JOIN conversation_planning_requests r ON r.mission_id = m.id " +
      "WHERE m.id = 'mission_planning'",
    )
    assert.deepEqual(durable.rows[0], {
      mission_status: 'planning', source_message_ids: ['message_1', 'message_2'],
      request_status: 'queued', inbox_count: 1, artifact_kind: 'mission_deliverable',
      delivery_status: 'context_loaded',
    })

    const claimed = await repository.claim({
      requestId: 'planning_request', plannerAgentId: 'planner', leaseSeconds: 60,
    })
    assert.equal(claimed.kind, 'work')
    assert.equal(claimed.work.request.attempt, 1)
    assert.deepEqual(claimed.work.missionAcceptanceCriteria, ['跨项目访问被拒绝'])
    assert.deepEqual(claimed.work.missionConstraints, ['保持接口兼容'])
    assert.deepEqual(claimed.work.sourceMessages.map((message) => message.id), ['message_1', 'message_2'])
    assert.deepEqual(claimed.work.availableRoles, ['builder', 'planner'])
    const busy = await repository.claim({
      requestId: 'planning_request', plannerAgentId: 'planner', leaseSeconds: 60,
    })
    assert.equal(busy.kind, 'busy')

    // This fixture fails before sending a model request, so its reservation has no spend.
    await new MissionBudgetRepository(poolAdapter(database)).cancelModelCall(claimed.work.budgetCallId)
    const transient = await repository.fail({
      requestId: 'planning_request', plannerAgentId: 'planner',
      leaseToken: claimed.work.leaseToken, message: 'temporary provider failure',
    })
    assert.equal(transient.retryable, true)
    assert.equal(transient.request.error, 'temporary provider failure')
    const retried = await repository.claim({
      requestId: 'planning_request', plannerAgentId: 'planner', leaseSeconds: 60,
    })
    assert.equal(retried.kind, 'work')
    assert.equal(retried.work.request.attempt, 2)
    assert.equal('error' in retried.work.request, false)

    await repository.completeModel({
      requestId: 'planning_request', plannerAgentId: 'planner',
      leaseToken: retried.work.leaseToken, plan,
      promptSnapshot: { messages: 2 }, responseSnapshot: { toolCalls: 1 },
      modelProvider: 'test', modelName: 'planner-model', providerRequestId: 'response_1',
      inputTokens: 120, outputTokens: 80, estimatedCostUsd: 0.01, latencyMs: 25,
    })
    const awaiting = await repository.markAwaitingApproval({
      requestId: 'planning_request', plannerAgentId: 'planner',
      leaseToken: retried.work.leaseToken, planVersion: 1,
    })
    assert.equal(awaiting.status, 'awaiting_approval')
    assert.equal(awaiting.planVersion, 1)
    assert.equal('error' in awaiting, false)
    assert.equal(await repository.get('ws', 'planning_request', { kind: 'user', id: 'outsider' }), null)
    await database.query(
      "UPDATE missions SET status = 'running', approved_by = 'user', approved_at = NOW() " +
      "WHERE id = 'mission_planning'",
    )
    const approved = await repository.get('ws', 'planning_request', { kind: 'user', id: 'user' })
    assert.equal(approved.status, 'approved')
  } finally {
    await database.close()
  }
})

test('planning promotion rejects foreign messages, non-members, and non-Planner Agents', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ConversationPlanningRepository(poolAdapter(database))
    await assert.rejects(repository.create({
      workspaceId: 'ws', conversationId: 'conversation', sourceMessageIds: ['missing'],
      title: 'Invalid', createdBy: 'user', correlationId: 'invalid-message',
    }), /source message/)
    await assert.rejects(repository.create({
      workspaceId: 'ws', conversationId: 'conversation', sourceMessageIds: ['message_1'],
      title: 'Invalid', createdBy: 'outsider', correlationId: 'invalid-user',
    }), /not a member/)
    await assert.rejects(repository.create({
      workspaceId: 'ws', conversationId: 'conversation', sourceMessageIds: ['message_1'],
      title: 'Invalid', plannerAgentId: 'builder', createdBy: 'user', correlationId: 'invalid-agent',
    }), /no active Planner/)
  } finally {
    await database.close()
  }
})

test('a terminal frozen-plan failure preserves its audit material and cannot be reclaimed', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const repository = new ConversationPlanningRepository(pool)
    await repository.create({ id: 'invalid_goal_plan', workspaceId: 'ws', conversationId: 'conversation',
      sourceMessageIds: ['message_1'], title: 'Goal', createdBy: 'user', correlationId: 'invalid-plan', goalVerification: true })
    const claimed = await repository.claim({ requestId: 'invalid_goal_plan', plannerAgentId: 'planner', leaseSeconds: 60 })
    const oversized = { ...plan, tasks: Array.from({ length: 100 }, (_, index) => ({
      ...plan.tasks[1], key: 'task-' + index, dependsOn: [],
    })) }
    await new MissionBudgetRepository(pool).settleModelCall(claimed.work.budgetCallId, { inputTokens: 50, outputTokens: 50 })
    await repository.completeModel({ requestId: 'invalid_goal_plan', plannerAgentId: 'planner',
      leaseToken: claimed.work.leaseToken, plan: oversized,
      promptSnapshot: { test: 'original prompt' }, responseSnapshot: { test: 'original response' },
      modelProvider: 'test', modelName: 'planner-model', inputTokens: 50, outputTokens: 50, latencyMs: 10 })
    const failed = await repository.fail({ requestId: 'invalid_goal_plan', plannerAgentId: 'planner',
      leaseToken: claimed.work.leaseToken, terminal: true, message: 'Stored Goal plan requires 1–99 original tasks.' })
    assert.equal(failed.retryable, false)
    assert.equal(failed.request.status, 'failed')
    assert.equal(failed.request.attempt, 1)
    const stored = (await database.query('SELECT plan, response_snapshot FROM conversation_planning_requests WHERE id = $1', ['invalid_goal_plan'])).rows[0]
    assert.deepEqual(stored.plan, oversized)
    assert.deepEqual(stored.response_snapshot, { test: 'original response' })
    const restarted = new ConversationPlanningRepository(pool)
    assert.equal((await restarted.claim({ requestId: 'invalid_goal_plan', plannerAgentId: 'planner', leaseSeconds: 60 })).kind, 'terminal')
    const visible = await restarted.get('ws', 'invalid_goal_plan', { kind: 'user', id: 'user' })
    assert.match(visible.error, /1–99/)
  } finally { await database.close() }
})

test('planning replay retains the pre-contract hash when new fields are omitted', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ConversationPlanningRepository(poolAdapter(database))
    const input = {
      workspaceId: 'ws', conversationId: 'conversation', sourceMessageIds: ['message_1'],
      title: 'Legacy goal', createdBy: 'user', correlationId: 'legacy', idempotencyKey: 'legacy-request',
    }
    const created = await repository.create(input)
    const legacyHash = createHash('sha256').update(JSON.stringify({
      conversationId: 'conversation', sourceMessageIds: ['message_1'], title: 'Legacy goal',
    })).digest('hex')
    const stored = (await database.query('SELECT request_hash FROM conversation_planning_requests WHERE id = $1', [created.request.id])).rows[0]
    assert.equal(stored.request_hash, legacyHash)
    const replay = await repository.create(input)
    assert.equal(replay.reused, true)
    assert.equal(replay.request.missionId, created.request.missionId)
  } finally {
    await database.close()
  }
})

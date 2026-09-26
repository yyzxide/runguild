import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { MissionBudgetRepository, ConversationPlanningRepository, ReviewerExecutionRepository, TaskRepository, SchedulerRepository } from '../dist/index.js'

const scope = { workspaceId: 'ws', missionId: 'mission' }
const run = (id = 'run') => ({ ...scope, taskId: id === 'run' ? 'task' : 'task2', runId: id, agentId: 'builder',
  status: 'running', currentHop: 2, maxHops: 60, contextSnapshot: {} })

async function fixture(database) {
  const folder = new URL('../migrations/', import.meta.url)
  for (const name of (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort()) {
    await database.exec(await readFile(new URL(name, folder), 'utf8'))
  }
  await database.exec(`
    INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');
    INSERT INTO projects (id, workspace_id, name) VALUES ('project', 'ws', 'Project');
    INSERT INTO users (id, workspace_id, display_name) VALUES ('user', 'ws', 'User');
    INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES
      ('builder', 'ws', 'Builder', 'builder', 'test', 'test'),
      ('planner', 'ws', 'Planner', 'planner', 'test', 'test'),
      ('reviewer', 'ws', 'Reviewer', 'reviewer', 'test', 'test');
    INSERT INTO conversations (id, workspace_id, project_id, kind, title)
      VALUES ('conversation', 'ws', 'project', 'project_room', 'Room');
    INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) VALUES
      ('conversation', 'ws', 'user', 'user'), ('conversation', 'ws', 'agent', 'planner'),
      ('conversation', 'ws', 'agent', 'builder'), ('conversation', 'ws', 'agent', 'reviewer');
    INSERT INTO messages (id, workspace_id, conversation_id, author_kind, author_id, body)
      VALUES ('message', 'ws', 'conversation', 'user', 'user', 'Deliver a feature');
    INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by, budget_tokens)
      VALUES ('mission', 'ws', 'project', 'Goal', 'Deliver', 'running', 'user', 100);
    INSERT INTO tasks (id, mission_id, title, status, attempt_count, required_role) VALUES
      ('task', 'mission', 'Build', 'running', 1, 'builder'),
      ('task2', 'mission', 'Build other', 'running', 1, 'builder'),
      ('human_task', 'mission', 'Human approval', 'waiting_human', 1, 'builder'),
      ('ready_task', 'mission', 'Next', 'ready', 0, 'builder');
    INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status, current_hop) VALUES
      ('run', 'ws', 'mission', 'task', 'builder', 1, 'running', 2),
      ('run2', 'ws', 'mission', 'task2', 'builder', 1, 'running', 2),
      ('human_run', 'ws', 'mission', 'human_task', 'builder', 1, 'waiting_human', 2);
    INSERT INTO task_leases (task_id, run_id, agent_id, lease_token, expires_at) VALUES
      ('task', 'run', 'builder', 'lease', NOW() + INTERVAL '1 hour'),
      ('task2', 'run2', 'builder', 'lease2', NOW() + INTERVAL '1 hour');
  `)
  const client = { async query(sql, params = []) {
    const result = await database.query(sql, params)
    return { ...result, rowCount: result.affectedRows ?? result.rows.length }
  }, release() {} }
  const pool = { connect: async () => client, query: client.query }
  return { pool, budget: new MissionBudgetRepository(pool) }
}

test('Mission soft cap persists shared spend, permits admitted calls, and resumes only budget waiters', async () => {
  const database = new PGlite()
  try {
    const { pool, budget } = await fixture(database)
    assert.equal(await budget.reserveRunCall(run(), 'call1'), true)
    assert.equal(await budget.reserveRunCall(run('run2'), 'call2'), true)
    await budget.settleModelCall('call1', { inputTokens: 80, outputTokens: 30, cachedInputTokens: 50 })
    assert.equal(await budget.reserveRunCall(run(), 'blocked'), false)
    await budget.settleModelCall('call2', { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 })
    // Duplicate settlement cannot charge twice or overwrite the original usage.
    await budget.settleModelCall('call2', { inputTokens: 999, outputTokens: 999 })
    const fresh = new MissionBudgetRepository(pool)
    const snapshot = await fresh.getSnapshot(scope)
    assert.equal(snapshot.totalTokens, 125)
    assert.equal(snapshot.status, 'exhausted')
    assert.equal(snapshot.estimatedCostUsd, null)
    assert.equal(snapshot.unpricedCalls, 1)
    assert.equal(snapshot.inFlightCalls, 0)
    const states = await database.query("SELECT status, current_hop, attempt FROM agent_runs WHERE id = 'run'")
    assert.deepEqual(states.rows[0], { status: 'waiting_human', current_hop: 2, attempt: 1 })
    assert.equal((await database.query("SELECT COUNT(*)::int AS n FROM task_leases WHERE run_id = 'run'")).rows[0].n, 0)
    const tasks = new TaskRepository(pool)
    assert.equal((await tasks.resumeWaitingRun({ ...scope, projectId: 'project', runId: 'run', agentId: 'builder', leaseSeconds: 60 })).resumed, false)
    assert.deepEqual(await new SchedulerRepository(pool).dispatchReadyTasks({ limit: 10, dispatchSeconds: 60, correlationId: 'blocked' }), [])
    assert.equal((await fresh.setTokenLimit({ ...scope, tokenLimit: 300, actorId: 'user' })).status, 'available')
    const resumes = await database.query("SELECT run_id FROM inbox_messages WHERE kind = 'run.control'")
    assert.deepEqual(resumes.rows, [{ run_id: 'run' }])
    assert.equal((await tasks.resumeWaitingRun({ ...scope, projectId: 'project', runId: 'run', agentId: 'builder', leaseSeconds: 60 })).resumed, true)
    const runnable = await tasks.listRunnableAgentRuns({ workspaceId: 'ws', projectId: 'project', agentId: 'builder', limit: 10 })
    assert.ok(runnable.some((entry) => entry.runId === 'run'))
    assert.equal((await database.query("SELECT COUNT(*)::int AS n FROM domain_events WHERE event_type = 'mission.budget_changed' AND actor->>'id' = 'user'")).rows[0].n, 1)
    const unchanged = await database.query("SELECT status FROM agent_runs WHERE id = 'human_run'")
    assert.equal(unchanged.rows[0].status, 'waiting_human')
    await fresh.setTokenLimit({ ...scope, tokenLimit: 300, actorId: 'user' })
    assert.equal((await database.query("SELECT COUNT(*)::int AS n FROM inbox_messages WHERE kind = 'run.control'")).rows[0].n, 1)
  } finally { await database.close() }
})

test('Unknown provider usage stops finite budgets and is never reported as measured zero spend', async () => {
  const database = new PGlite()
  try {
    const { budget } = await fixture(database)
    assert.equal(await budget.reserveRunCall(run(), 'unknown'), true)
    await budget.settleModelCall('unknown', { inputTokens: 0, outputTokens: 0, usageReported: false })
    const snapshot = await budget.getSnapshot(scope)
    assert.equal(snapshot.unknownUsageCalls, 1)
    assert.equal(snapshot.status, 'usage_unknown')
    assert.equal(snapshot.estimatedCostUsd, null)
    assert.equal(await budget.reserveRunCall(run(), 'denied'), false)
    assert.equal((await budget.setTokenLimit({ ...scope, tokenLimit: 500, actorId: 'user' })).status, 'usage_unknown')
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM mission_budget_waits')).rows[0].n, 1)
    assert.equal((await budget.setTokenLimit({ ...scope, tokenLimit: null, actorId: 'user' })).status, 'unlimited')
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM mission_budget_waits')).rows[0].n, 0)
  } finally { await database.close() }
})

test('Interrupted same-lease calls become unknown and late usage durably wakes only the paused run', async () => {
  const database = new PGlite()
  try {
    const { pool, budget } = await fixture(database)
    assert.equal(await budget.reserveRunCall(run(), 'interrupted', 'lease'), true)
    // A restarted Worker tries a new call before the old call was settled.
    assert.equal(await budget.reserveRunCall(run(), 'restart', 'lease'), false)
    assert.equal((await budget.getSnapshot(scope)).status, 'usage_unknown')
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM mission_budget_waits')).rows[0].n, 1)
    await budget.settleModelCall('interrupted', { inputTokens: 10, outputTokens: 5 })
    assert.equal((await budget.getSnapshot(scope)).status, 'available')
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM mission_budget_waits')).rows[0].n, 0)
    assert.deepEqual((await database.query("SELECT run_id FROM inbox_messages WHERE kind = 'run.control'")).rows, [{ run_id: 'run' }])
    const resumed = await new TaskRepository(pool).resumeWaitingRun({ ...scope, projectId: 'project', runId: 'run', agentId: 'builder', leaseSeconds: 60 })
    assert.equal(resumed.resumed, true)
    await assert.rejects(budget.reserveRunCall(run(), 'stale-worker', 'lease'), /lease was lost/)
    assert.equal(await budget.reserveRunCall(run(), 'new-worker', resumed.leaseToken), true)
    assert.equal((await database.query("SELECT lease_token FROM task_leases WHERE run_id = 'run'")).rows[0].lease_token, resumed.leaseToken)
  } finally { await database.close() }
})

test('Planner budget refusal consumes no attempt and raising the budget durably redelivers work', async () => {
  const database = new PGlite()
  try {
    const { pool, budget } = await fixture(database)
    const planning = new ConversationPlanningRepository(pool)
    const created = await planning.create({ id: 'planning', workspaceId: 'ws', conversationId: 'conversation',
      sourceMessageIds: ['message'], title: 'Goal', createdBy: 'user', correlationId: 'planning', budgetTokens: 0 })
    const planningScope = { workspaceId: 'ws', missionId: created.request.missionId }
    assert.equal((await planning.claim({ requestId: 'planning', plannerAgentId: 'planner', leaseSeconds: 300 })).kind, 'budget_blocked')
    assert.equal((await database.query("SELECT attempt FROM conversation_planning_requests WHERE id = 'planning'")).rows[0].attempt, 0)
    await budget.setTokenLimit({ ...planningScope, tokenLimit: 1000, actorId: 'user' })
    const claimed = await planning.claim({ requestId: 'planning', plannerAgentId: 'planner', leaseSeconds: 300 })
    assert.equal(claimed.kind, 'work')
    assert.equal(claimed.work.request.attempt, 1)
    await budget.settleModelCall(claimed.work.budgetCallId, { inputTokens: 90, outputTokens: 10 })
    assert.equal((await budget.getSnapshot(planningScope)).totalTokens, 100)
    assert.equal((await database.query("SELECT COUNT(*)::int AS n FROM inbox_messages WHERE kind = 'conversation.plan_requested'")).rows[0].n, 2)
  } finally { await database.close() }
})

test('Reviewer budget refusal consumes no attempt and its returned usage joins Mission spend', async () => {
  const database = new PGlite()
  try {
    const { pool, budget } = await fixture(database)
    await database.exec(`
      UPDATE tasks SET status = 'reviewing' WHERE id = 'task';
      INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, created_by)
        VALUES ('artifact', 'ws', 'project', 'mission', 'Delivery', 'builder');
      INSERT INTO artifact_versions (id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash,
        created_by_run_id, created_by_kind, created_by_id)
        VALUES ('version', 'artifact', 1, '{}', decode('', 'hex'), 'hash', 'state', 'run', 'agent', 'builder');
      INSERT INTO task_submissions (id, workspace_id, mission_id, task_id, run_id, artifact_version_id,
        submitted_by_agent_id, evidence_bundle_hash, status)
        VALUES ('submission', 'ws', 'mission', 'task', 'run', 'version', 'builder', 'bundle', 'in_review');
      INSERT INTO reviews (id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id, reviewer_kind, reviewer_id, status)
        VALUES ('review', 'ws', 'mission', 'task', 'submission', 'reviewer', 'agent', 'reviewer', 'requested');
      INSERT INTO review_executions (review_id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id,
        model_provider, model_name, materials_snapshot)
        VALUES ('review', 'ws', 'mission', 'task', 'submission', 'reviewer', 'test', 'test', '{}');
    `)
    await budget.setTokenLimit({ ...scope, tokenLimit: 0, actorId: 'user' })
    const executions = new ReviewerExecutionRepository(pool)
    assert.equal((await executions.claim({ reviewId: 'review', reviewerAgentId: 'reviewer', leaseSeconds: 300 })).kind, 'budget_blocked')
    assert.equal((await database.query("SELECT attempt FROM review_executions WHERE review_id = 'review'")).rows[0].attempt, 0)
    await budget.setTokenLimit({ ...scope, tokenLimit: 200, actorId: 'user' })
    const claimed = await executions.claim({ reviewId: 'review', reviewerAgentId: 'reviewer', leaseSeconds: 300 })
    assert.equal(claimed.kind, 'work')
    await budget.settleModelCall(claimed.work.budgetCallId, { inputTokens: 170, outputTokens: 30 })
    assert.equal((await budget.getSnapshot(scope)).status, 'exhausted')
  } finally { await database.close() }
})

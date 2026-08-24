import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import {
  DatabaseCompletionVerifier,
  EvidenceRepository,
  RuntimeRepository,
} from '../dist/index.js'

const migrationUrls = [
  new URL('../migrations/0001_core.sql', import.meta.url),
  new URL('../migrations/0002_orchestration.sql', import.meta.url),
  new URL('../migrations/0003_runtime.sql', import.meta.url),
  new URL('../migrations/0004_execution.sql', import.meta.url),
  new URL('../migrations/0005_artifacts.sql', import.meta.url),
  new URL('../migrations/0006_reviews.sql', import.meta.url),
  new URL('../migrations/0007_worktrees.sql', import.meta.url),
  new URL('../migrations/0008_context.sql', import.meta.url),
  new URL('../migrations/0009_evaluation.sql', import.meta.url),
]

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return {
    async connect() { return client },
    query: client.query,
  }
}

async function setup(database) {
  for (const url of migrationUrls) await database.exec(await readFile(url, 'utf8'))
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws_gate', 'Gate');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project_gate', 'ws_gate', 'Project');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) " +
    "VALUES ('agent_gate', 'ws_gate', 'Builder', 'builder', 'openai', 'test-model');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) " +
    "VALUES ('mission_gate', 'ws_gate', 'project_gate', 'Mission', 'Goal', 'running', 'user');" +
    "INSERT INTO tasks (id, mission_id, title, status, attempt_count, review_required) VALUES " +
    "('task_gate', 'mission_gate', 'Build', 'running', 1, false), " +
    "('task_child', 'mission_gate', 'Follow-up', 'blocked', 0, false), " +
    "('task_review', 'mission_gate', 'Reviewable', 'running', 1, true);" +
    "INSERT INTO task_dependencies (mission_id, task_id, depends_on_task_id) " +
    "VALUES ('mission_gate', 'task_child', 'task_gate');" +
    "INSERT INTO task_acceptance_criteria " +
    "(id, task_id, criterion_key, description, required, required_evidence_kinds) " +
    "VALUES ('criterion_tests', 'task_gate', 'tests', 'Tests pass', true, ARRAY['test_run']);" +
    "INSERT INTO agent_runs " +
    "(id, workspace_id, mission_id, task_id, agent_id, attempt, status, current_hop) VALUES " +
    "('run_gate', 'ws_gate', 'mission_gate', 'task_gate', 'agent_gate', 1, 'running', 2), " +
    "('run_review', 'ws_gate', 'mission_gate', 'task_review', 'agent_gate', 1, 'running', 1);",
  )
}

function runContext(taskId, runId, currentHop) {
  return {
    workspaceId: 'ws_gate',
    missionId: 'mission_gate',
    taskId,
    runId,
    agentId: 'agent_gate',
    status: 'running',
    currentHop,
    maxHops: 30,
    contextSnapshot: {},
  }
}

test('durable evidence is deduplicated and gates Task completion and dependency unlock', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const verifier = new DatabaseCompletionVerifier(pool)
    const evidence = new EvidenceRepository(pool)
    const run = runContext('task_gate', 'run_gate', 2)

    assert.deepEqual(await verifier.verify({ run, summary: 'Done.', evidence: [] }), {
      accepted: false,
      reason: 'Required durable evidence is missing.',
    })

    const input = {
      workspaceId: 'ws_gate',
      missionId: 'mission_gate',
      taskId: 'task_gate',
      runId: 'run_gate',
      agentId: 'agent_gate',
      toolCallId: 'call_tests',
      kind: 'test_run',
      uri: 'test-run://call_tests#sha256',
      contentHash: 'sha256',
      metadata: { command: ['npm', 'test'], passed: true },
    }
    const first = await evidence.recordToolEvidence(input)
    const replay = await evidence.recordToolEvidence(input)
    assert.equal(first.length, 1)
    assert.equal(replay[0].id, first[0].id)

    assert.deepEqual(await verifier.verify({ run, summary: 'Verified.', evidence: first }), {
      accepted: true,
    })
    const states = await database.query(
      "SELECT id, status FROM tasks WHERE id IN ('task_gate', 'task_child') ORDER BY id",
    )
    assert.deepEqual(states.rows, [
      { id: 'task_child', status: 'ready' },
      { id: 'task_gate', status: 'completed' },
    ])
    const durable = await database.query(
      "SELECT COUNT(*)::int AS evidence_count FROM evidence WHERE run_id = 'run_gate'",
    )
    assert.equal(durable.rows[0].evidence_count, 1)
  } finally {
    await database.close()
  }
})

test('review-required Task enters reviewing while its producing Run may finish', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const verifier = new DatabaseCompletionVerifier(poolAdapter(database))
    const decision = await verifier.verify({
      run: runContext('task_review', 'run_review', 1),
      summary: 'Ready for independent review.',
      evidence: [],
    })
    assert.deepEqual(decision, {
      accepted: true,
      reason: 'Run finished; Task is awaiting independent review.',
    })
    const task = await database.query("SELECT status FROM tasks WHERE id = 'task_review'")
    assert.equal(task.rows[0].status, 'reviewing')
  } finally {
    await database.close()
  }
})

test('a durable Run control request also creates exactly one Agent wake', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const runtime = new RuntimeRepository(poolAdapter(database))
    const input = {
      id: 'control_gate',
      workspaceId: 'ws_gate',
      runId: 'run_gate',
      kind: 'steer',
      payload: { message: 'Check the edge case.' },
      createdBy: 'user_gate',
      dedupeKey: 'steer-edge',
    }
    assert.equal(await runtime.createControl(input), 'control_gate')
    assert.equal(await runtime.createControl({ ...input, id: 'control_duplicate' }), 'control_gate')
    const counts = await database.query(
      "SELECT " +
      "(SELECT COUNT(*)::int FROM run_control_requests WHERE run_id = 'run_gate') AS controls, " +
      "(SELECT COUNT(*)::int FROM inbox_messages WHERE run_id = 'run_gate' AND kind = 'run.control') AS inbox, " +
      "(SELECT COUNT(*)::int FROM outbox_events WHERE partition_key = 'agent_gate') AS wakes",
    )
    assert.deepEqual(counts.rows[0], { controls: 1, inbox: 1, wakes: 1 })
  } finally {
    await database.close()
  }
})

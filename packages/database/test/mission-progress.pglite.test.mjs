import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { MissionRepository } from '../dist/index.js'
import { hasMissingTaskEvidence } from '../dist/evidence-gate.js'

const migrations = [
  '0001_core', '0002_orchestration', '0003_runtime', '0004_execution', '0005_artifacts',
  '0006_reviews', '0007_worktrees', '0008_context', '0009_evaluation',
  '0016_submission_evidence', '0017_integration_conflict_recovery',
  '0028_goal_verification',
]

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return { connect: async () => client, query: client.query }
}

async function fixture(database) {
  for (const name of migrations) {
    await database.exec(await readFile(new URL('../migrations/' + name + '.sql', import.meta.url), 'utf8'))
  }
  await database.exec(`
    INSERT INTO workspaces (id, name) VALUES ('ws_goal', 'Goal');
    INSERT INTO projects (id, workspace_id, name) VALUES ('project_goal', 'ws_goal', 'Project');
    INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES
      ('builder_goal', 'ws_goal', 'Actual Builder', 'builder', 'configured-provider', 'configured-model'),
      ('reviewer_goal', 'ws_goal', 'Independent Reviewer', 'reviewer', 'test', 'review-model');
    INSERT INTO missions (id, workspace_id, project_id, title, goal, constraints, acceptance_criteria, status, created_by)
      VALUES ('mission_goal', 'ws_goal', 'project_goal', 'Deliver feature', 'Meet the original goal',
        '["Keep the public API stable"]', '["End-to-end behavior works"]', 'running', 'operator');
    INSERT INTO tasks (id, mission_id, title, description, status, required_role, attempt_count, max_attempts, review_required, position)
      VALUES ('task_goal', 'mission_goal', 'Implement', 'Implement and verify the feature', 'running', 'builder', 2, 3, false, 0),
        ('task_child', 'mission_goal', 'Follow-up', '', 'blocked', 'builder', 0, 3, false, 1);
    INSERT INTO task_dependencies (mission_id, task_id, depends_on_task_id) VALUES ('mission_goal', 'task_child', 'task_goal');
    INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status, current_hop,
      started_at, finished_at, completion_summary, context_snapshot) VALUES
      ('run_old', 'ws_goal', 'mission_goal', 'task_goal', 'builder_goal', 1, 'failed', 30,
        NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 'Old failure', '{"private":"RAW_CONTEXT_MARKER"}'),
      ('run_current', 'ws_goal', 'mission_goal', 'task_goal', 'builder_goal', 2, 'running', 4,
        NOW(), NULL, 'Fixed earlier feedback', '{"private":"RAW_CONTEXT_MARKER"}');
    INSERT INTO llm_calls (id, workspace_id, mission_id, task_id, run_id, hop, provider, model, status,
      request_hash, request_redacted, response_redacted) VALUES
      ('llm_current', 'ws_goal', 'mission_goal', 'task_goal', 'run_current', 4, 'observed-provider', 'observed-model',
        'succeeded', 'hash', '{"private":"RAW_REQUEST_MARKER"}', '{"private":"RAW_RESPONSE_MARKER"}');
    INSERT INTO task_acceptance_criteria (id, task_id, criterion_key, description, required, required_evidence_kinds)
      VALUES ('criterion_goal', 'task_goal', 'verification', 'Tests pass', TRUE, ARRAY['test_run']);
  `)
  const pool = poolAdapter(database)
  return { pool, missions: new MissionRepository(pool) }
}

async function addEvidence(database, {
  id, kind = 'test_run', runId = 'run_current', metadata = { passed: true, command: ['npm', 'test'] },
  expired = false, createdAt = '2026-01-01T00:00:00Z', criterion = true,
}) {
  await database.query(`
    INSERT INTO evidence (id, workspace_id, mission_id, task_id, run_id, acceptance_criterion_id,
      kind, uri, metadata, created_at, expires_at)
    VALUES ($1, 'ws_goal', 'mission_goal', 'task_goal', $2, $3, $4, 'evidence://summary', $5::jsonb, $6,
      CASE WHEN $7 THEN NOW() - INTERVAL '1 hour' ELSE NULL END)`,
  [id, runId, criterion ? 'criterion_goal' : null, kind, JSON.stringify(metadata), createdAt, expired])
}

async function addSubmission(database, { runId = 'run_current', status = 'submitted' } = {}) {
  await database.query(`
    INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, created_by)
      VALUES ('artifact_goal', 'ws_goal', 'project_goal', 'mission_goal', 'Deliverable', 'builder_goal')`)
  await database.query(`
    INSERT INTO artifact_versions (id, artifact_id, version, content, yjs_state_bytes, content_hash,
      yjs_state_hash, created_by_run_id, created_by_kind, created_by_id)
    VALUES ('version_goal', 'artifact_goal', 1, '{"private":"RAW_ARTIFACT_MARKER"}', decode('', 'hex'),
      'content-hash', 'state-hash', $1, 'agent', 'builder_goal')`, [runId])
  await database.query(`
    INSERT INTO task_submissions (id, workspace_id, mission_id, task_id, run_id, artifact_version_id,
      submitted_by_agent_id, evidence_bundle_hash, status)
    VALUES ('submission_goal', 'ws_goal', 'mission_goal', 'task_goal', $1, 'version_goal',
      'builder_goal', 'bundle-hash', $2)`, [runId, status])
}

test('Mission progress exposes scoped original criteria and the latest actual run without raw payloads', async () => {
  const database = new PGlite()
  try {
    const { missions } = await fixture(database)
    await addSubmission(database, { runId: 'run_old', status: 'superseded' })
    await database.exec(`
      INSERT INTO reviews (id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id,
        reviewer_kind, reviewer_id, status, summary, findings, completed_at)
      VALUES ('review_goal', 'ws_goal', 'mission_goal', 'task_goal', 'submission_goal', 'reviewer_goal',
        'agent', 'reviewer_goal', 'approved', 'Previous artifact approved', '[{"private":"RAW_FINDINGS_MARKER"}]', NOW());
    `)
    const snapshot = await missions.getMission('ws_goal', 'mission_goal')
    assert.deepEqual(snapshot.constraints, ['Keep the public API stable'])
    assert.deepEqual(snapshot.acceptanceCriteria, ['End-to-end behavior works'])
    const task = snapshot.tasks[0]
    assert.equal(task.description, 'Implement and verify the feature')
    assert.equal(task.attemptCount, 2)
    assert.equal(task.maxAttempts, 3)
    assert.equal(task.latestRun.id, 'run_current')
    assert.equal(task.latestRun.agentName, 'Actual Builder')
    assert.equal(task.latestRun.modelName, 'observed-model')
    assert.equal(task.latestRun.modelProvider, 'observed-provider')
    assert.equal(task.latestRun.modelSource, 'observed')
    assert.equal(task.latestRun.currentHop, 4)
    assert.equal(task.latestRun.finishedAt, null)
    assert.equal(task.latestRun.completionSummary, 'Fixed earlier feedback')
    assert.equal(task.latestReview.status, 'approved')
    assert.equal(task.latestReview.submissionStatus, 'superseded')
    assert.equal(task.latestReview.isCurrentAttempt, false)
    assert.equal(task.latestReview.reviewerName, 'Independent Reviewer')
    assert.equal(task.acceptanceCriteria[0].evidenceStatus, 'missing')
    assert.equal(snapshot.tasks[1].latestRun, null)
    assert.deepEqual(snapshot.tasks[1].dependsOn, ['task_goal'])
    assert.equal(await missions.getMission('different_workspace', 'mission_goal'), null)
    assert.doesNotMatch(JSON.stringify(snapshot), /RAW_\w+_MARKER/)
  } finally {
    await database.close()
  }
})

test('criterion progress follows the completion gate for stale, expired and later-failed evidence', async () => {
  const database = new PGlite()
  try {
    const { missions, pool } = await fixture(database)
    const assertEvidence = async (expected, ids) => {
      const snapshot = await missions.getMission('ws_goal', 'mission_goal')
      const criterion = snapshot.tasks[0].acceptanceCriteria[0]
      assert.equal(criterion.evidenceStatus, expected ? 'complete' : 'missing')
      assert.deepEqual(criterion.evidence.map((item) => item.id).sort(), ids.toSorted())
      assert.equal(await hasMissingTaskEvidence(await pool.connect(), 'task_goal'), !expected)
    }
    await addEvidence(database, { id: 'old_attempt', runId: 'run_old' })
    await addEvidence(database, { id: 'expired', expired: true })
    await assertEvidence(false, [])
    await addEvidence(database, { id: 'valid', metadata: { passed: true, command: ['npm', 'test'], raw: 'RAW_METADATA_MARKER' } })
    await assertEvidence(true, ['valid'])
    assert.doesNotMatch(JSON.stringify(await missions.getMission('ws_goal', 'mission_goal')), /RAW_METADATA_MARKER/)
    await addEvidence(database, { id: 'failed_later', createdAt: '2026-01-02T00:00:00Z', metadata: { passed: false, command: ['npm', 'test'] } })
    await assertEvidence(false, [])
    await database.query("UPDATE tasks SET status = 'completed' WHERE id = 'task_goal'")
    await assertEvidence(false, [])
  } finally {
    await database.close()
  }
})

test('review evidence must bind the current Submission and exact committed tree, independently of review status', async () => {
  const database = new PGlite()
  try {
    const { missions, pool } = await fixture(database)
    await database.exec(`
      UPDATE tasks SET review_required = TRUE WHERE id = 'task_goal';
      INSERT INTO task_worktrees (task_id, workspace_id, mission_id, project_id, repository_path, worktree_path,
        branch_name, base_ref, base_commit, head_commit, status, last_error)
      VALUES ('task_goal', 'ws_goal', 'mission_goal', 'project_goal', '/repo', '/worktree', 'task/goal',
        'main', 'base', 'head-current', 'committed', '{"message":"Integration pending","private":"RAW_ERROR_MARKER"}');
    `)
    await addEvidence(database, { id: 'commit', kind: 'file_diff', criterion: false, metadata: { commit: 'head-current', treeHash: 'tree-current' } })
    await addEvidence(database, { id: 'tests', metadata: {
      passed: true, command: ['npm', 'test'], headCommit: 'head-current', treeHash: 'tree-current', clean: true, stable: true,
    } })
    let snapshot = await missions.getMission('ws_goal', 'mission_goal')
    assert.equal(snapshot.tasks[0].acceptanceCriteria[0].evidenceStatus, 'missing')
    await addSubmission(database)
    await database.query("INSERT INTO task_submission_evidence (submission_id, evidence_id) VALUES ('submission_goal', 'tests')")
    snapshot = await missions.getMission('ws_goal', 'mission_goal')
    assert.equal(snapshot.tasks[0].acceptanceCriteria[0].evidenceStatus, 'complete')
    assert.equal(snapshot.tasks[0].acceptanceCriteria[0].evidence[0].artifactVersionId, 'version_goal')
    assert.equal(snapshot.tasks[0].latestReview, null)
    assert.equal(snapshot.tasks[0].integration.status, 'committed')
    assert.equal(snapshot.tasks[0].integration.lastError, 'Integration pending')
    assert.doesNotMatch(JSON.stringify(snapshot), /RAW_\w+_MARKER/)
    assert.equal(await hasMissingTaskEvidence(await pool.connect(), 'task_goal'), false)

    await database.query("UPDATE task_worktrees SET head_commit = 'different-head' WHERE task_id = 'task_goal'")
    snapshot = await missions.getMission('ws_goal', 'mission_goal')
    assert.equal(snapshot.tasks[0].acceptanceCriteria[0].evidenceStatus, 'missing')
    assert.equal(await hasMissingTaskEvidence(await pool.connect(), 'task_goal'), true)
    await database.query("UPDATE task_worktrees SET head_commit = 'head-current' WHERE task_id = 'task_goal'")
    await database.query("UPDATE task_submissions SET status = 'superseded' WHERE id = 'submission_goal'")
    snapshot = await missions.getMission('ws_goal', 'mission_goal')
    assert.equal(snapshot.tasks[0].acceptanceCriteria[0].evidenceStatus, 'missing')
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import {
  ReviewRepository,
  ReviewerExecutionRepository,
  TaskRepository,
  TaskWorktreeRepository,
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
  new URL('../migrations/0010_conversations.sql', import.meta.url),
  new URL('../migrations/0014_reviewer_execution.sql', import.meta.url),
]

function poolAdapter(database) {
  let queryInFlight = false
  const client = {
    async query(statement, params = []) {
      if (queryInFlight) throw new Error('Concurrent queries on one transaction client are forbidden')
      queryInFlight = true
      try {
        const result = await database.query(statement, params)
        return { ...result, rowCount: result.affectedRows ?? result.rows.length }
      } finally {
        queryInFlight = false
      }
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
    "INSERT INTO workspaces (id, name) VALUES ('ws_review', 'Review'), ('ws_other', 'Other');" +
    "INSERT INTO users (id, workspace_id, display_name) VALUES " +
    "('user_reviewer', 'ws_review', 'Human Reviewer'), ('user_other', 'ws_other', 'Other');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project_review', 'ws_review', 'Project');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('agent_builder', 'ws_review', 'Builder', 'builder', 'openai', 'test'), " +
    "('agent_reviewer', 'ws_review', 'Reviewer', 'reviewer', 'openai', 'test'), " +
    "('agent_peer_builder', 'ws_review', 'Peer Builder', 'builder', 'openai', 'test');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) " +
    "VALUES ('mission_review', 'ws_review', 'project_review', 'Mission', 'Ship report', 'running', 'user_reviewer');" +
    "INSERT INTO tasks (id, mission_id, title, status, attempt_count, max_attempts, review_required) " +
    "VALUES ('task_review', 'mission_review', 'Report', 'reviewing', 1, 3, TRUE);" +
    "INSERT INTO agent_runs " +
    "(id, workspace_id, mission_id, task_id, agent_id, attempt, status) VALUES " +
    "('run_builder', 'ws_review', 'mission_review', 'task_review', 'agent_builder', 1, 'succeeded');" +
    "INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, created_by) " +
    "VALUES ('artifact_review', 'ws_review', 'project_review', 'mission_review', 'Report', 'agent_builder');" +
    "INSERT INTO artifact_versions " +
    "(id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash, " +
    "through_update_seq, created_by_kind, created_by_id, created_by_run_id) VALUES " +
    "('version_review', 'artifact_review', 1, '{\"type\":\"doc\"}'::jsonb, " +
    "decode('0000', 'hex'), 'content_review', 'state_review', 1, 'agent', 'agent_builder', 'run_builder');" +
    "INSERT INTO evidence " +
    "(id, workspace_id, mission_id, task_id, run_id, kind, uri, content_hash) VALUES " +
    "('evidence_version', 'ws_review', 'mission_review', 'task_review', 'run_builder', " +
    "'artifact_version', 'artifact-version://version_review', 'content_review');",
  )
}

async function submit(repository) {
  return repository.submitArtifactVersion({
    submissionId: 'submission_review',
    workspaceId: 'ws_review',
    missionId: 'mission_review',
    taskId: 'task_review',
    runId: 'run_builder',
    agentId: 'agent_builder',
    artifactVersionId: 'version_review',
    note: 'Ready for independent review.',
  })
}

test('human approval of exact-version evidence completes the review-gated Task', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ReviewRepository(poolAdapter(database))
    const submission = await submit(repository)
    assert.equal(submission.status, 'submitted')
    assert.equal(submission.note, 'Ready for independent review.')
    assert.match(submission.evidenceBundleHash, /^[0-9a-f]{64}$/)
    assert.equal((await submit(repository)).id, submission.id)

    const result = await repository.reviewSubmission({
      reviewId: 'review_human',
      workspaceId: 'ws_review',
      submissionId: submission.id,
      reviewer: { kind: 'user', id: 'user_reviewer' },
      decision: 'approved',
      summary: 'The version and supporting evidence satisfy the acceptance gate.',
      findings: [{ severity: 'info', summary: 'Evidence hash matches the frozen version.' }],
      correlationId: 'correlation_human_review',
    })
    assert.equal(result.submission.status, 'approved')
    assert.equal(result.review.status, 'approved')
    assert.equal(result.review.reviewer.kind, 'user')
    assert.equal(result.taskCompletion.completed, true)

    const task = await database.query("SELECT status FROM tasks WHERE id = 'task_review'")
    assert.equal(task.rows[0].status, 'completed')
    const details = await repository.getSubmission('ws_review', submission.id)
    assert.equal(details.review.id, 'review_human')
  } finally {
    await database.close()
  }
})

test('independent reviewer Agent can request changes, while builders and foreign users cannot review', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ReviewRepository(poolAdapter(database))
    const submission = await submit(repository)

    await assert.rejects(repository.reviewSubmission({
      workspaceId: 'ws_review',
      submissionId: submission.id,
      reviewer: { kind: 'agent', id: 'agent_builder' },
      decision: 'approved',
      summary: 'Self approval.',
      findings: [],
      correlationId: 'correlation_self_review',
    }), /cannot review its own/)
    await assert.rejects(repository.reviewSubmission({
      workspaceId: 'ws_review',
      submissionId: submission.id,
      reviewer: { kind: 'agent', id: 'agent_peer_builder' },
      decision: 'approved',
      summary: 'Peer builder approval.',
      findings: [],
      correlationId: 'correlation_peer_review',
    }), /active reviewer/)
    await assert.rejects(repository.reviewSubmission({
      workspaceId: 'ws_review',
      submissionId: submission.id,
      reviewer: { kind: 'user', id: 'user_other' },
      decision: 'approved',
      summary: 'Foreign approval.',
      findings: [],
      correlationId: 'correlation_foreign_review',
    }), /outside the submission workspace/)

    const result = await repository.reviewSubmission({
      reviewId: 'review_agent',
      workspaceId: 'ws_review',
      submissionId: submission.id,
      reviewer: { kind: 'agent', id: 'agent_reviewer' },
      decision: 'changes_requested',
      summary: 'Add a citation for the central claim.',
      findings: [{ severity: 'error', summary: 'The central claim has no citation.' }],
      correlationId: 'correlation_agent_review',
    })
    assert.equal(result.submission.status, 'rejected')
    assert.equal(result.review.status, 'changes_requested')
    const task = await database.query("SELECT status FROM tasks WHERE id = 'task_review'")
    assert.equal(task.rows[0].status, 'ready')
  } finally {
    await database.close()
  }
})

test('approved code review cannot complete its Task before the exact reviewed commit is integrated', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const repository = new ReviewRepository(pool)
    await database.exec(
      "INSERT INTO task_worktrees " +
      "(task_id, workspace_id, mission_id, project_id, repository_path, worktree_path, " +
      "branch_name, base_ref, base_commit, head_commit, status, provision_token, provision_expires_at) " +
      "VALUES ('task_review', 'ws_review', 'mission_review', 'project_review', '/repo', '/trees/task', " +
      "'agent/task', 'main', '" + 'a'.repeat(40) + "', '" + 'b'.repeat(40) + "', " +
      "'committed', NULL, NULL);",
    )
    await assert.rejects(
      submit(repository),
      /exact Task Worktree commit/,
    )
    await database.exec(
      "INSERT INTO evidence " +
      "(id, workspace_id, mission_id, task_id, run_id, kind, uri, content_hash, metadata) VALUES " +
      "('evidence_commit', 'ws_review', 'mission_review', 'task_review', 'run_builder', " +
      "'file_diff', 'git://task_review/" + 'b'.repeat(40) + "', 'diff_review', " +
      "'{\"commit\":\"" + 'b'.repeat(40) + "\"}'::jsonb);",
    )
    const submission = await submit(repository)
    const approved = await repository.reviewSubmission({
      reviewId: 'review_integration_gate',
      workspaceId: 'ws_review',
      submissionId: submission.id,
      reviewer: { kind: 'user', id: 'user_reviewer' },
      decision: 'approved',
      summary: 'Code and evidence are approved for integration.',
      findings: [],
      correlationId: 'correlation_integration_gate',
    })
    assert.deepEqual(approved.taskCompletion, { completed: false, reason: 'missing_integration' })
    assert.equal((await database.query("SELECT status FROM tasks WHERE id = 'task_review'")).rows[0].status, 'reviewing')
    const worktrees = new TaskWorktreeRepository(pool)
    assert.equal((await worktrees.listApprovedPendingIntegration(10))[0].taskId, 'task_review')

    await database.exec(
      "UPDATE task_worktrees SET status = 'integrated', integrated_commit = '" +
      'b'.repeat(40) + "', integrated_at = NOW() WHERE task_id = 'task_review'",
    )
    const completed = await new TaskRepository(pool).completeTaskAndUnlockDependents({
      workspaceId: 'ws_review',
      missionId: 'mission_review',
      taskId: 'task_review',
      actor: { kind: 'system', id: 'git-integration-gate' },
      correlationId: 'correlation_integrated',
    })
    assert.equal(completed.completed, true)
    assert.equal((await worktrees.listCompletedPendingCleanup(10))[0].taskId, 'task_review')
  } finally {
    await database.close()
  }
})

test('Mission-room Reviewer receives durable work, defers until Task review, and resumes a stored model decision', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const reviews = new ReviewRepository(pool)
    const executions = new ReviewerExecutionRepository(pool)
    await database.exec(
      "INSERT INTO conversations (id, workspace_id, project_id, kind, title) " +
      "VALUES ('conversation_review', 'ws_review', 'project_review', 'mission_room', 'Mission room');" +
      "INSERT INTO conversation_members (workspace_id, conversation_id, participant_kind, participant_id) VALUES " +
      "('ws_review', 'conversation_review', 'agent', 'agent_builder'), " +
      "('ws_review', 'conversation_review', 'agent', 'agent_reviewer');" +
      "UPDATE missions SET conversation_id = 'conversation_review' WHERE id = 'mission_review';" +
      "UPDATE tasks SET status = 'running' WHERE id = 'task_review';",
    )

    const submission = await submit(reviews)
    assert.equal(submission.status, 'in_review')
    const queued = await database.query(
      "SELECT review.id, review.status, execution.status AS execution_status, inbox.kind, " +
      "outbox.payload->>'type' AS wake_type " +
      "FROM reviews review JOIN review_executions execution ON execution.review_id = review.id " +
      "JOIN inbox_messages inbox ON inbox.agent_id = execution.reviewer_agent_id " +
      "JOIN outbox_events outbox ON outbox.partition_key = execution.reviewer_agent_id " +
      "AND outbox.topic = 'mission.agent-wake.v1' " +
      "WHERE review.submission_id = 'submission_review'",
    )
    assert.equal(queued.rows[0].status, 'requested')
    assert.equal(queued.rows[0].execution_status, 'queued')
    assert.equal(queued.rows[0].kind, 'artifact.review_requested')
    assert.equal(queued.rows[0].wake_type, 'agent.wake')
    const reviewId = queued.rows[0].id

    const deferred = await executions.claim({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseSeconds: 60,
    })
    assert.deepEqual(deferred, { kind: 'not_ready', taskStatus: 'running' })

    await database.exec("UPDATE tasks SET status = 'reviewing' WHERE id = 'task_review'")
    const first = await executions.claim({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseSeconds: 60,
    })
    assert.equal(first.kind, 'work')
    assert.equal(first.work.materials.artifactVersion.id, 'version_review')
    assert.equal(first.work.materials.evidence[0].id, 'evidence_version')
    assert.equal(await executions.renew({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseToken: first.work.leaseToken,
      leaseSeconds: 60,
    }), true)
    assert.equal((await database.query(
      "SELECT COUNT(*)::int AS count FROM domain_events WHERE event_type = 'review.status_changed' " +
      "AND payload->>'to' = 'in_progress'",
    )).rows[0].count, 1)
    const decision = {
      decision: 'approved',
      summary: 'The frozen Artifact Version satisfies the evidence gate.',
      findings: [{ severity: 'info', summary: 'Exact version evidence is present.', evidenceIds: ['evidence_version'] }],
    }
    await executions.completeModel({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseToken: first.work.leaseToken,
      decision,
      promptSnapshot: { schemaVersion: 1, messages: [] },
      responseSnapshot: { toolCalls: [] },
      modelProvider: 'openai',
      modelName: 'test',
      inputTokens: 100,
      outputTokens: 25,
      latencyMs: 10,
    })
    assert.equal((await executions.fail({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseToken: first.work.leaseToken,
      message: 'simulated crash after model persistence',
    })).retryable, true)

    const resumed = await executions.claim({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseSeconds: 60,
    })
    assert.equal(resumed.kind, 'work')
    assert.deepEqual(resumed.work.storedDecision, decision)
    await reviews.reviewSubmission({
      reviewId,
      workspaceId: 'ws_review',
      submissionId: submission.id,
      reviewer: { kind: 'agent', id: 'agent_reviewer' },
      decision: decision.decision,
      summary: decision.summary,
      findings: decision.findings,
      correlationId: 'correlation_automatic_review',
    })
    await executions.complete({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseToken: resumed.work.leaseToken,
    })
    const finished = await database.query(
      'SELECT status, attempt, decision_hash, prompt_snapshot FROM review_executions WHERE review_id = $1',
      [reviewId],
    )
    assert.equal(finished.rows[0].status, 'completed')
    assert.equal(finished.rows[0].attempt, 1)
    assert.match(finished.rows[0].decision_hash, /^[0-9a-f]{64}$/)
    assert.equal(finished.rows[0].prompt_snapshot.schemaVersion, 1)
  } finally {
    await database.close()
  }
})

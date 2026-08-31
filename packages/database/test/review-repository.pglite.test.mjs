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
  new URL('../migrations/0016_submission_evidence.sql', import.meta.url),
  new URL('../migrations/0017_integration_conflict_recovery.sql', import.meta.url),
  new URL('../migrations/0018_reviewer_model_calls.sql', import.meta.url),
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

test('runtime can submit an Artifact Version while the submission tool owns the Run', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    await database.exec(
      "UPDATE tasks SET status = 'running' WHERE id = 'task_review';" +
      "UPDATE agent_runs SET status = 'waiting_tool' WHERE id = 'run_builder';",
    )
    const submission = await submit(new ReviewRepository(poolAdapter(database)))
    assert.equal(submission.status, 'submitted')
    assert.equal(submission.runId, 'run_builder')
  } finally {
    await database.close()
  }
})

test('project-bound Reviewer assignment recovers a submitted Evaluation Mission without a conversation', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    await database.exec(
      "INSERT INTO conversations (id, workspace_id, project_id, kind, title) " +
      "VALUES ('conversation_project', 'ws_review', 'project_review', 'project_room', 'Project room');" +
      "INSERT INTO conversation_members (workspace_id, conversation_id, participant_kind, participant_id) VALUES " +
      "('ws_review', 'conversation_project', 'agent', 'agent_reviewer');",
    )
    const repository = new ReviewRepository(poolAdapter(database))
    const submission = await submit(repository)
    assert.equal(submission.status, 'in_review')
    assert.equal((await database.query(
      "SELECT reviewer_agent_id FROM reviews WHERE submission_id = 'submission_review'",
    )).rows[0].reviewer_agent_id, 'agent_reviewer')

    await database.exec(
      "DELETE FROM reviews WHERE submission_id = 'submission_review';" +
      "UPDATE task_submissions SET status = 'submitted' WHERE id = 'submission_review';",
    )
    const recovered = await repository.recoverPendingReviewAssignments(10)
    assert.equal(recovered.length, 1)
    assert.match(recovered[0], /^review_/)
    const durable = await database.query(
      "SELECT s.status, e.status AS execution_status, i.agent_id FROM task_submissions s " +
      "JOIN reviews r ON r.submission_id = s.id " +
      "JOIN review_executions e ON e.review_id = r.id " +
      "JOIN inbox_messages i ON i.dedupe_key = 'artifact-review:' || r.id " +
      "WHERE s.id = 'submission_review'",
    )
    assert.deepEqual(durable.rows[0], {
      status: 'in_review',
      execution_status: 'queued',
      agent_id: 'agent_reviewer',
    })
  } finally {
    await database.close()
  }
})

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
    assert.equal((await worktrees.listApprovedPendingIntegration({
      workspaceId: 'ws_review', projectId: 'project_review', limit: 10,
    }))[0].taskId, 'task_review')

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
    assert.equal((await worktrees.listCompletedPendingCleanup({
      workspaceId: 'ws_review', projectId: 'project_review', limit: 10,
    }))[0].taskId, 'task_review')
  } finally {
    await database.close()
  }
})

test('evidence-only retry freezes exact commit and clean tested-HEAD evidence from earlier Task Runs', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const repository = new ReviewRepository(pool)
    const executions = new ReviewerExecutionRepository(pool)
    const baseCommit = 'a'.repeat(40)
    const headCommit = 'b'.repeat(40)
    const treeHash = 'c'.repeat(40)
    await database.exec(
      "INSERT INTO conversations (id, workspace_id, project_id, kind, title) " +
      "VALUES ('conversation_retry', 'ws_review', 'project_review', 'mission_room', 'Retry room');" +
      "INSERT INTO conversation_members (workspace_id, conversation_id, participant_kind, participant_id) VALUES " +
      "('ws_review', 'conversation_retry', 'agent', 'agent_builder'), " +
      "('ws_review', 'conversation_retry', 'agent', 'agent_reviewer');" +
      "UPDATE missions SET conversation_id = 'conversation_retry' WHERE id = 'mission_review';" +
      "UPDATE tasks SET status = 'running', attempt_count = 3, max_attempts = 4 WHERE id = 'task_review';" +
      "INSERT INTO agent_runs " +
      "(id, workspace_id, mission_id, task_id, agent_id, attempt, status) VALUES " +
      "('run_tests', 'ws_review', 'mission_review', 'task_review', 'agent_builder', 2, 'failed'), " +
      "('run_resubmit', 'ws_review', 'mission_review', 'task_review', 'agent_builder', 3, 'running');" +
      "INSERT INTO task_worktrees " +
      "(task_id, workspace_id, mission_id, project_id, repository_path, worktree_path, " +
      "branch_name, base_ref, base_commit, head_commit, status, provision_token, provision_expires_at) " +
      "VALUES ('task_review', 'ws_review', 'mission_review', 'project_review', '/repo', '/trees/task', " +
      "'agent/task', 'main', '" + baseCommit + "', '" + headCommit + "', 'committed', NULL, NULL);" +
      "INSERT INTO evidence " +
      "(id, workspace_id, mission_id, task_id, run_id, kind, uri, content_hash, metadata) VALUES " +
      "('evidence_commit_retry', 'ws_review', 'mission_review', 'task_review', 'run_builder', " +
      "'file_diff', 'git-diff://" + headCommit + "', 'diff_retry', " +
      "'{\"commit\":\"" + headCommit + "\",\"treeHash\":\"" + treeHash + "\",\"toolCallId\":\"call_commit\"}'::jsonb), " +
      "('evidence_test_retry', 'ws_review', 'mission_review', 'task_review', 'run_tests', " +
      "'test_run', 'test-run://retry', 'test_retry', " +
      "'{\"passed\":true,\"clean\":true,\"stable\":true,\"headCommit\":\"" + headCommit +
      "\",\"treeHash\":\"" + treeHash + "\",\"command\":[\"npm\",\"test\"],\"toolCallId\":\"call_test\"}'::jsonb), " +
      "('evidence_test_stale', 'ws_review', 'mission_review', 'task_review', 'run_tests', " +
      "'test_run', 'test-run://stale', 'test_stale', " +
      "'{\"passed\":true,\"clean\":true,\"stable\":true,\"headCommit\":\"" + baseCommit +
      "\",\"treeHash\":\"" + 'd'.repeat(40) + "\",\"command\":[\"npm\",\"test\"]}'::jsonb), " +
      "('evidence_test_dirty', 'ws_review', 'mission_review', 'task_review', 'run_tests', " +
      "'test_run', 'test-run://dirty', 'test_dirty', " +
      "'{\"passed\":true,\"clean\":false,\"stable\":true,\"headCommit\":\"" + headCommit +
      "\",\"treeHash\":\"" + treeHash + "\",\"command\":[\"npm\",\"test\"]}'::jsonb);",
    )

    const submission = await repository.submitArtifactVersion({
      submissionId: 'submission_retry',
      workspaceId: 'ws_review',
      missionId: 'mission_review',
      taskId: 'task_review',
      runId: 'run_resubmit',
      agentId: 'agent_builder',
      artifactVersionId: 'version_review',
      note: 'Evidence-only retry for the unchanged exact commit.',
    })
    assert.equal(submission.status, 'in_review')
    const frozen = await database.query(
      'SELECT evidence_id FROM task_submission_evidence WHERE submission_id = $1 ORDER BY evidence_id',
      [submission.id],
    )
    assert.deepEqual(frozen.rows.map((row) => row.evidence_id), [
      'evidence_commit_retry',
      'evidence_test_retry',
      'evidence_version',
    ])

    await database.exec("UPDATE tasks SET status = 'reviewing' WHERE id = 'task_review'")
    const queued = await database.query(
      "SELECT id FROM reviews WHERE submission_id = 'submission_retry'",
    )
    const claimed = await executions.claim({
      reviewId: queued.rows[0].id,
      reviewerAgentId: 'agent_reviewer',
      leaseSeconds: 60,
    })
    assert.equal(claimed.kind, 'work')
    const testEvidence = claimed.work.materials.evidence.find((item) => item.id === 'evidence_test_retry')
    assert.equal(testEvidence.producerRunId, 'run_tests')
    assert.equal(testEvidence.producerRunStatus, 'failed')
    assert.equal(testEvidence.producerAttempt, 2)
    assert.equal(claimed.work.materials.evidence.some((item) => item.id === 'evidence_test_stale'), false)
    assert.equal(claimed.work.materials.evidence.some((item) => item.id === 'evidence_test_dirty'), false)
  } finally {
    await database.close()
  }
})

test('human retry requeues only an exhausted Reviewer execution and preserves its frozen snapshot', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const reviews = new ReviewRepository(pool)
    const executions = new ReviewerExecutionRepository(pool)
    await database.exec(
      "INSERT INTO conversations (id, workspace_id, project_id, kind, title) " +
      "VALUES ('conversation_retry_review', 'ws_review', 'project_review', 'mission_room', 'Retry room');" +
      "INSERT INTO conversation_members (workspace_id, conversation_id, participant_kind, participant_id) VALUES " +
      "('ws_review', 'conversation_retry_review', 'agent', 'agent_builder'), " +
      "('ws_review', 'conversation_retry_review', 'agent', 'agent_reviewer');" +
      "UPDATE missions SET conversation_id = 'conversation_retry_review' WHERE id = 'mission_review';",
    )
    const submission = await submit(reviews)
    const selected = await database.query(
      "SELECT id FROM reviews WHERE submission_id = 'submission_review'",
    )
    const reviewId = selected.rows[0].id

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await executions.claim({
        reviewId,
        reviewerAgentId: 'agent_reviewer',
        leaseSeconds: 60,
      })
      assert.equal(claimed.kind, 'work')
      assert.equal(claimed.work.attempt, attempt)
      if (attempt === 1) {
        await executions.recordInvalidModelResponse({
          reviewId,
          reviewerAgentId: 'agent_reviewer',
          leaseToken: claimed.work.leaseToken,
          promptSnapshot: { schemaVersion: 1, messages: [{ role: 'user', content: 'Decide.' }] },
          responseSnapshot: { finishReason: 'stop', content: 'Approved in prose.', toolCalls: [] },
          modelProvider: 'openai',
          modelName: 'test',
          providerRequestId: 'response_invalid',
          inputTokens: 321,
          outputTokens: 17,
          cachedInputTokens: 123,
          latencyMs: 25,
          errorMessage: 'Reviewer must call review.submit_decision exactly once',
        })
      }
      assert.equal((await executions.fail({
        reviewId,
        reviewerAgentId: 'agent_reviewer',
        leaseToken: claimed.work.leaseToken,
        message: 'model input projection failed',
      })).retryable, attempt < 3)
    }
    const failed = await database.query(
      'SELECT status, attempt, max_attempts, materials_snapshot FROM review_executions WHERE review_id = $1',
      [reviewId],
    )
    assert.equal(failed.rows[0].status, 'failed')
    const invalidResponse = await database.query(
      'SELECT response_snapshot, provider_request_id, input_tokens, output_tokens ' +
      'FROM review_executions WHERE review_id = $1',
      [reviewId],
    )
    assert.equal(invalidResponse.rows[0].response_snapshot.content, 'Approved in prose.')
    assert.equal(invalidResponse.rows[0].provider_request_id, 'response_invalid')
    assert.equal(invalidResponse.rows[0].input_tokens, 321)
    assert.equal(invalidResponse.rows[0].output_tokens, 17)
    const invalidCalls = await database.query(
      'SELECT attempt, status, input_tokens, output_tokens, cached_input_tokens, error ' +
      'FROM reviewer_model_calls WHERE review_id = $1 ORDER BY attempt',
      [reviewId],
    )
    assert.deepEqual(invalidCalls.rows, [{
      attempt: 1,
      status: 'invalid',
      input_tokens: 321,
      output_tokens: 17,
      cached_input_tokens: 123,
      error: { message: 'Reviewer must call review.submit_decision exactly once' },
    }])
    const frozenSnapshot = JSON.stringify(failed.rows[0].materials_snapshot)

    assert.deepEqual(await executions.retryFailed({
      workspaceId: 'ws_review',
      reviewId,
      requestedBy: 'user_other',
      reason: 'Foreign user must not reopen this execution.',
      correlationId: 'correlation_foreign_retry',
    }), { retried: false, reason: 'not_found_or_forbidden' })

    assert.deepEqual(await executions.retryFailed({
      workspaceId: 'ws_review',
      reviewId,
      requestedBy: 'user_reviewer',
      reason: 'Deploy bounded duplicate-Evidence projection and retry once.',
      correlationId: 'correlation_review_retry',
    }), { retried: true, maxAttempts: 4 })
    const requeued = await database.query(
      'SELECT status, attempt, max_attempts, error, finished_at, materials_snapshot ' +
      'FROM review_executions WHERE review_id = $1',
      [reviewId],
    )
    assert.equal(requeued.rows[0].status, 'queued')
    assert.equal(requeued.rows[0].attempt, 3)
    assert.equal(requeued.rows[0].max_attempts, 4)
    assert.equal(requeued.rows[0].error, null)
    assert.equal(requeued.rows[0].finished_at, null)
    assert.equal(JSON.stringify(requeued.rows[0].materials_snapshot), frozenSnapshot)
    assert.equal((await database.query(
      "SELECT COUNT(*)::int AS count FROM inbox_messages WHERE dedupe_key LIKE 'artifact-review-retry:%'",
    )).rows[0].count, 1)
    assert.equal((await database.query(
      "SELECT COUNT(*)::int AS count FROM domain_events WHERE event_type = 'review.execution_retried'",
    )).rows[0].count, 1)

    const resumed = await executions.claim({
      reviewId,
      reviewerAgentId: 'agent_reviewer',
      leaseSeconds: 60,
    })
    assert.equal(resumed.kind, 'work')
    assert.equal(resumed.work.attempt, 4)
    assert.equal(JSON.stringify(resumed.work.materials), frozenSnapshot)
    assert.deepEqual(await executions.retryFailed({
      workspaceId: 'ws_review',
      reviewId,
      requestedBy: 'user_reviewer',
      reason: 'An active execution cannot be reopened.',
      correlationId: 'correlation_active_retry',
    }), { retried: false, reason: 'execution_not_failed' })
    assert.equal(submission.status, 'in_review')
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
      cachedInputTokens: 40,
      estimatedCostUsd: 0.01,
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
    const modelCalls = await database.query(
      'SELECT attempt, status, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd ' +
      'FROM reviewer_model_calls WHERE review_id = $1',
      [reviewId],
    )
    assert.deepEqual(modelCalls.rows, [{
      attempt: 1,
      status: 'succeeded',
      input_tokens: 100,
      output_tokens: 25,
      cached_input_tokens: 40,
      estimated_cost_usd: '0.01000000',
    }])
  } finally {
    await database.close()
  }
})

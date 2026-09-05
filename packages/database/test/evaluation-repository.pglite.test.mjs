import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import {
  EvaluationRepository,
  ExecutionContextRepository,
  MissionRepository,
} from '../dist/index.js'
import {
  EvaluationCoordinator,
  EvaluationMissionDriver,
  buildEvaluationReport,
} from '../../evaluation/dist/index.js'

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
  new URL('../migrations/0014_reviewer_execution.sql', import.meta.url),
  new URL('../migrations/0017_integration_conflict_recovery.sql', import.meta.url),
  new URL('../migrations/0018_reviewer_model_calls.sql', import.meta.url),
  new URL('../migrations/0021_authentication.sql', import.meta.url),
  new URL('../migrations/0023_project_lifecycle.sql', import.meta.url),
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

const criterion = {
  key: 'verified',
  description: 'Implementation is verified.',
  required: false,
  evidenceKinds: [],
}

const definition = {
  goal: 'Implement and verify the requested change.',
  constraints: ['Stay inside the assigned repository.'],
  acceptanceCriteria: ['The implementation is complete and verified.'],
  baselineCommit: 'a'.repeat(40),
  singleAgentPlan: {
    summary: 'One Builder owns the complete task.',
    tasks: [{
      key: 'build_all',
      title: 'Implement and verify',
      description: 'Inspect, implement, and test the change.',
      role: 'builder',
      priority: 100,
      dependsOn: [],
      reviewRequired: false,
      acceptanceCriteria: [criterion],
    }],
  },
  multiAgentPlan: {
    summary: 'Research and implementation are separated by a dependency.',
    tasks: [
      {
        key: 'research',
        title: 'Research the change',
        description: 'Inspect the repository and determine the implementation path.',
        role: 'researcher',
        priority: 50,
        dependsOn: [],
        reviewRequired: false,
        acceptanceCriteria: [criterion],
      },
      {
        key: 'build',
        title: 'Implement and verify',
        description: 'Implement the researched solution and run tests.',
        role: 'builder',
        priority: 100,
        dependsOn: ['research'],
        reviewRequired: false,
        acceptanceCriteria: [criterion],
      },
    ],
  },
}

async function setup(database) {
  for (const url of migrationUrls) await database.exec(await readFile(url, 'utf8'))
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws_eval', 'Evaluation');" +
    "INSERT INTO users (id, workspace_id, display_name) VALUES ('user_eval', 'ws_eval', 'Evaluator');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project_eval', 'ws_eval', 'Project');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('agent_eval_builder', 'ws_eval', 'Builder', 'builder', 'openai', 'model'), " +
    "('agent_eval_researcher', 'ws_eval', 'Researcher', 'researcher', 'openai', 'model'), " +
    "('agent_eval_reviewer', 'ws_eval', 'Reviewer', 'reviewer', 'openai', 'model');",
  )
}

async function createExperiment(repository) {
  const scenarioId = await repository.createScenario({
    id: 'evaluation_scenario_eval',
    workspaceId: 'ws_eval',
    projectId: 'project_eval',
    slug: 'paired-agent-strategies',
    name: 'Paired Agent strategies',
  })
  const version = await repository.createScenarioVersion({
    id: 'evaluation_scenario_version_eval',
    workspaceId: 'ws_eval',
    projectId: 'project_eval',
    scenarioId,
    definition,
    createdBy: 'user_eval',
  })
  const replay = await repository.createScenarioVersion({
    workspaceId: 'ws_eval',
    projectId: 'project_eval',
    scenarioId,
    definition,
    createdBy: 'user_eval',
  })
  assert.equal(replay.id, version.id)
  assert.equal(replay.reused, true)
  return repository.createExperiment({
    id: 'evaluation_experiment_eval',
    workspaceId: 'ws_eval',
    projectId: 'project_eval',
    scenarioVersionId: version.id,
    name: 'Single vs multi Agent',
    repetitions: 1,
    createdBy: 'user_eval',
  })
}

async function addMetricsFixture(database, trial) {
  const tasks = await database.query(
    'SELECT id, required_role FROM tasks WHERE mission_id = $1 ORDER BY position',
    [trial.missionId],
  )
  await database.query(
    "UPDATE missions SET status = 'reviewing', updated_at = NOW() WHERE id = $1",
    [trial.missionId],
  )
  let firstTask
  let firstRunId
  let firstAgentId
  for (const [index, task] of tasks.rows.entries()) {
    const attempts = trial.variant === 'single_agent' ? 2 : 1
    await database.query(
      "UPDATE tasks SET status = 'completed', attempt_count = $2, completed_at = NOW(), updated_at = NOW() " +
      'WHERE id = $1',
      [task.id, attempts],
    )
    const agentId = task.required_role === 'researcher'
      ? 'agent_eval_researcher'
      : 'agent_eval_builder'
    const suffix = trial.variant + '_' + index
    const runId = 'run_eval_' + suffix
    if (index === 0) {
      firstTask = task
      firstRunId = runId
      firstAgentId = agentId
    }
    await database.query(
      'INSERT INTO agent_runs ' +
      '(id, workspace_id, mission_id, task_id, agent_id, attempt, status, started_at, finished_at) ' +
      "VALUES ($1, 'ws_eval', $2, $3, $4, 1, 'succeeded', NOW(), NOW())",
      [runId, trial.missionId, task.id, agentId],
    )
    const context = await new ExecutionContextRepository(poolAdapter(database)).load(runId, agentId)
    assert.equal(context.expectedBaseCommit, definition.baselineCommit)
    assert.equal(context.allowBaseRefAdvance, true)
    assert.equal(context.defaultBranch.startsWith('evaluation/trial-' + trial.id), true)
    const contextId = 'context_eval_' + suffix
    await database.query(
      'INSERT INTO context_snapshots ' +
      '(id, workspace_id, mission_id, task_id, run_id, hop, strategy, token_budget, estimated_tokens, ' +
      "compacted, source_message_count, included_message_count, content_hash, content) VALUES " +
      "($1, 'ws_eval', $2, $3, $4, 1, 'full', 4096, 100, FALSE, 2, 2, $5, '{}'::jsonb)",
      [contextId, trial.missionId, task.id, runId, (index + 1).toString(16).padStart(64, '0')],
    )
    const cost = trial.variant === 'single_agent' ? 0.10 : 0.06
    await database.query(
      'INSERT INTO llm_calls ' +
      '(id, workspace_id, mission_id, task_id, run_id, hop, provider, model, status, request_hash, ' +
      "request_redacted, context_snapshot_id, input_tokens, output_tokens, cached_input_tokens, " +
      "estimated_cost_usd, started_at, finished_at) VALUES " +
      "($1, 'ws_eval', $2, $3, $4, 1, 'openai', 'model', 'succeeded', 'request', '{}', $5, " +
      '100, 20, 10, $6, NOW(), NOW())',
      ['llm_eval_' + suffix, trial.missionId, task.id, runId, contextId, cost],
    )
    await database.query(
      'INSERT INTO tool_executions ' +
      '(id, workspace_id, mission_id, task_id, run_id, agent_id, action, idempotency_key, ' +
      "request_hash, request, status, effect_state) VALUES " +
      "($1, 'ws_eval', $2, $3, $4, $5, 'repo.search', $6, 'request', '{}', 'succeeded', 'complete')",
      ['tool_eval_' + suffix, trial.missionId, task.id, runId, agentId, 'tool:' + suffix],
    )
  }
  assert.ok(firstTask && firstRunId && firstAgentId)
  const artifact = await database.query('SELECT id FROM artifacts WHERE mission_id = $1', [trial.missionId])
  const suffix = trial.variant
  const versionId = 'version_eval_review_' + suffix
  const submissionId = 'submission_eval_review_' + suffix
  const reviewId = 'review_eval_' + suffix
  await database.query(
    'INSERT INTO artifact_versions ' +
    '(id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash, ' +
    "created_by_kind, created_by_id) VALUES ($1, $2, 1, '{}'::jsonb, $3, $4, $5, 'user', 'user_eval')",
    [versionId, artifact.rows[0].id, Buffer.from([1]), 'content_' + suffix, 'state_' + suffix],
  )
  await database.query(
    'INSERT INTO task_submissions ' +
    '(id, workspace_id, mission_id, task_id, run_id, artifact_version_id, submitted_by_agent_id, ' +
    "status, evidence_bundle_hash) VALUES ($1, 'ws_eval', $2, $3, $4, $5, $6, 'approved', $7)",
    [submissionId, trial.missionId, firstTask.id, firstRunId, versionId, firstAgentId, 'bundle_' + suffix],
  )
  await database.query(
    'INSERT INTO reviews ' +
    '(id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id, reviewer_kind, reviewer_id, ' +
    "status, findings, summary, completed_at) VALUES ($1, 'ws_eval', $2, $3, $4, " +
    "'agent_eval_reviewer', 'agent', 'agent_eval_reviewer', 'approved', '[]'::jsonb, 'Approved', NOW())",
    [reviewId, trial.missionId, firstTask.id, submissionId],
  )
  const reviewerInput = trial.variant === 'single_agent' ? 50 : 80
  const reviewerOutput = trial.variant === 'single_agent' ? 10 : 16
  const reviewerCached = trial.variant === 'single_agent' ? 20 : 30
  const reviewerCost = trial.variant === 'single_agent' ? 0.01 : 0.02
  await database.query(
    'INSERT INTO review_executions ' +
    '(review_id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id, status, attempt, ' +
    'decision, decision_hash, model_provider, model_name, input_tokens, output_tokens, cached_input_tokens, ' +
    "estimated_cost_usd, latency_ms, finished_at) VALUES ($1, 'ws_eval', $2, $3, $4, " +
    "'agent_eval_reviewer', 'completed', 1, '{\"decision\":\"approved\"}'::jsonb, 'decision', " +
    "'openai', 'model', $5, $6, $7, $8, 10, NOW())",
    [reviewId, trial.missionId, firstTask.id, submissionId, reviewerInput, reviewerOutput, reviewerCached, reviewerCost],
  )
  await database.query(
    'INSERT INTO reviewer_model_calls ' +
    '(id, review_id, workspace_id, mission_id, task_id, attempt, status, provider, model, input_tokens, ' +
    "output_tokens, cached_input_tokens, estimated_cost_usd, latency_ms) VALUES ($1, $2, 'ws_eval', " +
    "$3, $4, 1, 'succeeded', 'openai', 'model', $5, $6, $7, $8, 10)",
    ['review_model_call_eval_' + suffix, reviewId, trial.missionId, firstTask.id,
      reviewerInput, reviewerOutput, reviewerCached, reviewerCost],
  )
}

test('paired trials materialize real Missions, freeze the Git baseline, collect ledger metrics, and report deltas', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const repository = new EvaluationRepository(pool)
    const created = await createExperiment(repository)
    assert.equal(created.trials.length, 2)
    assert.equal(created.trials[0].seed, created.trials[1].seed)

    const coordinator = new EvaluationCoordinator(
      repository,
      new EvaluationMissionDriver(new MissionRepository(pool)),
    )
    const firstTick = await coordinator.tick({
      materializationLimit: 10,
      collectionLimit: 10,
      leaseSeconds: 30,
    })
    assert.deepEqual(firstTick, {
      discovered: 2,
      materialized: 2,
      materializationFailed: 0,
      collected: 0,
      successful: 0,
    })
    const versions = await repository.listScenarioVersions({
      workspaceId: 'ws_eval', projectId: 'project_eval', limit: 10,
    })
    assert.equal(versions.length, 1)
    assert.equal(versions[0].baselineCommit, definition.baselineCommit)
    assert.equal(versions[0].singleAgentTaskCount, 1)
    assert.equal(versions[0].multiAgentTaskCount, 2)
    const summaries = await repository.listExperiments({
      workspaceId: 'ws_eval', projectId: 'project_eval', limit: 10,
    })
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].trialCount, 2)
    assert.equal(summaries[0].completedTrialCount, 0)
    assert.deepEqual(await repository.listExperiments({
      workspaceId: 'ws_eval', projectId: 'project_foreign', limit: 10,
    }), [])
    assert.equal(await repository.getExperiment('ws_eval', 'project_foreign', created.id), null)

    const running = await repository.getExperiment('ws_eval', 'project_eval', created.id)
    assert.equal(running.status, 'running')
    for (const trial of running.trials) {
      assert.ok(trial.missionId)
      const count = await database.query(
        'SELECT COUNT(*)::int AS count FROM tasks WHERE mission_id = $1',
        [trial.missionId],
      )
      assert.equal(count.rows[0].count, trial.variant === 'single_agent' ? 1 : 2)
      await addMetricsFixture(database, trial)
    }

    const secondTick = await coordinator.tick({
      materializationLimit: 10,
      collectionLimit: 10,
      leaseSeconds: 30,
    })
    assert.equal(secondTick.collected, 2)
    assert.equal(secondTick.successful, 2)
    const completed = await repository.getExperiment('ws_eval', 'project_eval', created.id)
    assert.equal(completed.status, 'completed')
    const report = buildEvaluationReport(completed)
    assert.equal(report.pairedTrials, 1)
    assert.equal(report.pairedSuccessDelta, 0)
    assert.ok(Math.abs(report.pairedMeanCostDeltaUsd - 0.03) < 0.000001)
    assert.equal(report.variants.find((item) => item.variant === 'single_agent').meanReworkAttempts, 1)
    assert.equal(report.variants.find((item) => item.variant === 'single_agent').meanInputTokens, 150)
    assert.equal(report.variants.find((item) => item.variant === 'single_agent').meanOutputTokens, 30)
    assert.equal(report.variants.find((item) => item.variant === 'multi_agent').meanInputTokens, 280)
    assert.equal(completed.trials.find((item) => item.variant === 'single_agent').metrics.modelCalls, 2)
    assert.equal(completed.trials.find((item) => item.variant === 'single_agent').metrics.cachedInputTokens, 30)
  } finally {
    await database.close()
  }
})

test('materialization reservations use fencing tokens and retry a failed worker safely', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new EvaluationRepository(poolAdapter(database))
    await createExperiment(repository)
    const [reservation] = await repository.reserveMaterialization({ limit: 1, leaseSeconds: 30 })
    assert.ok(reservation)
    await assert.rejects(repository.markMaterialized({
      trialId: reservation.trial.id,
      materializationToken: 'stale-token',
      missionId: 'mission_missing',
    }), /stale/)
    const retried = await repository.markMaterializationFailed({
      trialId: reservation.trial.id,
      materializationToken: reservation.materializationToken,
      error: { message: 'temporary failure' },
    })
    assert.equal(retried.status, 'queued')
    const reservations = await repository.reserveMaterialization({ limit: 10, leaseSeconds: 30 })
    assert.equal(reservations.some((item) => item.trial.id === reservation.trial.id), true)
  } finally {
    await database.close()
  }
})

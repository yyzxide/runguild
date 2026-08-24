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
    "('agent_eval_researcher', 'ws_eval', 'Researcher', 'researcher', 'openai', 'model');",
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
    const running = await repository.getExperiment('ws_eval', created.id)
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
    const completed = await repository.getExperiment('ws_eval', created.id)
    assert.equal(completed.status, 'completed')
    const report = buildEvaluationReport(completed)
    assert.equal(report.pairedTrials, 1)
    assert.equal(report.pairedSuccessDelta, 0)
    assert.ok(Math.abs(report.pairedMeanCostDeltaUsd - 0.02) < 0.000001)
    assert.equal(report.variants.find((item) => item.variant === 'single_agent').meanReworkAttempts, 1)
    assert.equal(report.variants.find((item) => item.variant === 'multi_agent').meanInputTokens, 200)
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

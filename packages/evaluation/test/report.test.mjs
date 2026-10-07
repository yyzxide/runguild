import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEvaluationReport } from '../dist/index.js'

const timestamp = '2026-09-14T00:00:00.000Z'

function metrics(cost, wallTimeMs, success = true) {
  return {
    success,
    taskCompletionRate: success ? 1 : 0.5,
    wallTimeMs,
    taskCount: 1,
    runAttempts: 1,
    reworkAttempts: 0,
    modelCalls: 1,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    estimatedCostUsd: cost,
    toolCalls: 2,
    toolFailures: 0,
    reviewChangesRequested: 0,
    contextSnapshots: 1,
    compactedContexts: 0,
    estimatedContextTokens: 100,
  }
}

function trial(repetition, variant, trialMetrics) {
  return {
    id: `trial_${repetition}_${variant}`,
    experimentId: 'experiment',
    scenarioVersionId: 'scenario_version',
    workspaceId: 'workspace',
    projectId: 'project',
    variant,
    repetition,
    seed: `seed_${repetition}`,
    status: 'completed',
    metrics: trialMetrics,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  }
}

function experiment(repetitions, trials, status = 'completed') {
  return {
    id: 'experiment',
    workspaceId: 'workspace',
    projectId: 'project',
    scenarioId: 'scenario',
    scenarioVersionId: 'scenario_version',
    name: 'Paired comparison',
    status,
    repetitions,
    variants: ['single_agent', 'multi_agent'],
    trials,
  }
}

test('report refuses to turn incomplete model pricing into zero-cost evidence', () => {
  const report = buildEvaluationReport(experiment(1, [
    trial(1, 'single_agent', metrics(0.1, 1_000)),
    trial(1, 'multi_agent', metrics(null, 800)),
  ]))

  assert.equal(report.pairedTrials, 1)
  assert.equal(report.pairedCostTrials, 0)
  assert.equal(report.pairedMeanCostDeltaUsd, null)
  assert.equal(report.variants[0].meanCostUsd, 0.1)
  assert.equal(report.variants[1].meanCostUsd, null)
  assert.equal(report.limitations.includes('incomplete_cost_coverage'), true)
})

test('three completed pairs cross only the repeatable engineering threshold', () => {
  const trials = [1, 2, 3].flatMap((repetition) => [
    trial(repetition, 'single_agent', metrics(0.1, 1_000)),
    trial(repetition, 'multi_agent', metrics(0.08, 900)),
  ])
  const report = buildEvaluationReport(experiment(3, trials))

  assert.equal(report.evidenceLevel, 'repeatable')
  assert.equal(report.pairedTrials, 3)
  assert.equal(report.pairedCostTrials, 3)
  assert.ok(Math.abs(report.pairedMeanCostDeltaUsd + 0.02) < 0.000001)
  assert.equal(report.limitations.includes('insufficient_paired_trials'), false)
  assert.equal(report.limitations.includes('statistical_significance_not_established'), true)
})

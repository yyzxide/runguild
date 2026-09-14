import type { EvaluationExperimentSnapshot } from '@runguild/database'
import type {
  EvaluationLimitation,
  EvaluationExperimentReport,
  EvaluationTrial,
  EvaluationVariant,
  EvaluationVariantAggregate,
} from '@runguild/protocol'
import { MINIMUM_EVIDENCE_PAIRED_TRIALS } from '@runguild/protocol'

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1
    ? ordered[middle] ?? 0
    : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
}

function aggregate(variant: EvaluationVariant, trials: readonly EvaluationTrial[]): EvaluationVariantAggregate {
  const completed = trials.filter((trial) => trial.variant === variant && trial.metrics !== undefined)
  const metrics = completed.flatMap((trial) => trial.metrics ? [trial.metrics] : [])
  const pricedMetrics = metrics.filter((item) => item.estimatedCostUsd !== null)
  const completeCostCoverage = metrics.length > 0 && pricedMetrics.length === metrics.length
  const successfulTrials = metrics.filter((item) => item.success).length
  return {
    variant,
    completedTrials: metrics.length,
    successfulTrials,
    successRate: metrics.length === 0 ? 0 : successfulTrials / metrics.length,
    meanWallTimeMs: mean(metrics.map((item) => item.wallTimeMs)),
    medianWallTimeMs: median(metrics.map((item) => item.wallTimeMs)),
    pricedTrials: pricedMetrics.length,
    meanCostUsd: completeCostCoverage
      ? mean(pricedMetrics.map((item) => item.estimatedCostUsd as number))
      : null,
    totalCostUsd: completeCostCoverage
      ? pricedMetrics.reduce((sum, item) => sum + (item.estimatedCostUsd as number), 0)
      : null,
    meanInputTokens: mean(metrics.map((item) => item.inputTokens)),
    meanOutputTokens: mean(metrics.map((item) => item.outputTokens)),
    meanReworkAttempts: mean(metrics.map((item) => item.reworkAttempts)),
  }
}

export function buildEvaluationReport(
  experiment: EvaluationExperimentSnapshot,
): EvaluationExperimentReport {
  const pairs = new Map<number, Partial<Record<EvaluationVariant, EvaluationTrial>>>()
  for (const trial of experiment.trials) {
    if (!trial.metrics) continue
    const pair = pairs.get(trial.repetition) ?? {}
    pair[trial.variant] = trial
    pairs.set(trial.repetition, pair)
  }
  const completePairs = [...pairs.values()].flatMap((pair) => {
    const single = pair.single_agent
    const multi = pair.multi_agent
    return single?.metrics && multi?.metrics ? [{ single: single.metrics, multi: multi.metrics }] : []
  })
  const pricedPairs = completePairs.filter((pair) =>
    pair.single.estimatedCostUsd !== null && pair.multi.estimatedCostUsd !== null)
  const completeCostCoverage = completePairs.length > 0 && pricedPairs.length === completePairs.length
  const evidenceLevel = experiment.status === 'completed'
    && completePairs.length >= MINIMUM_EVIDENCE_PAIRED_TRIALS
    ? 'repeatable'
    : 'exploratory'
  const limitations: EvaluationLimitation[] = []
  if (experiment.status !== 'completed') limitations.push('experiment_not_completed')
  if (completePairs.length < MINIMUM_EVIDENCE_PAIRED_TRIALS) {
    limitations.push('insufficient_paired_trials')
  }
  if (!completeCostCoverage) limitations.push('incomplete_cost_coverage')
  limitations.push('statistical_significance_not_established')
  return {
    experimentId: experiment.id,
    scenarioId: experiment.scenarioId,
    scenarioVersionId: experiment.scenarioVersionId,
    status: experiment.status,
    repetitions: experiment.repetitions,
    variants: experiment.variants.map((variant) => aggregate(variant, experiment.trials)),
    pairedTrials: completePairs.length,
    pairedCostTrials: pricedPairs.length,
    pairedSuccessDelta: mean(completePairs.map((pair) =>
      Number(pair.multi.success) - Number(pair.single.success))),
    pairedMeanCostDeltaUsd: completeCostCoverage
      ? mean(pricedPairs.map((pair) =>
        (pair.multi.estimatedCostUsd as number) - (pair.single.estimatedCostUsd as number)))
      : null,
    pairedMeanWallTimeDeltaMs: mean(completePairs.map((pair) =>
      pair.multi.wallTimeMs - pair.single.wallTimeMs)),
    evidenceLevel,
    minimumEvidencePairedTrials: MINIMUM_EVIDENCE_PAIRED_TRIALS,
    limitations,
    trials: experiment.trials,
  }
}

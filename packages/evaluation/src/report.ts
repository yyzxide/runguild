import type { EvaluationExperimentSnapshot } from '@runguild/database'
import type {
  EvaluationExperimentReport,
  EvaluationTrial,
  EvaluationVariant,
  EvaluationVariantAggregate,
} from '@runguild/protocol'

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
  const successfulTrials = metrics.filter((item) => item.success).length
  return {
    variant,
    completedTrials: metrics.length,
    successfulTrials,
    successRate: metrics.length === 0 ? 0 : successfulTrials / metrics.length,
    meanWallTimeMs: mean(metrics.map((item) => item.wallTimeMs)),
    medianWallTimeMs: median(metrics.map((item) => item.wallTimeMs)),
    meanCostUsd: mean(metrics.map((item) => item.estimatedCostUsd)),
    totalCostUsd: metrics.reduce((sum, item) => sum + item.estimatedCostUsd, 0),
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
  return {
    experimentId: experiment.id,
    scenarioId: experiment.scenarioId,
    scenarioVersionId: experiment.scenarioVersionId,
    status: experiment.status,
    repetitions: experiment.repetitions,
    variants: experiment.variants.map((variant) => aggregate(variant, experiment.trials)),
    pairedTrials: completePairs.length,
    pairedSuccessDelta: mean(completePairs.map((pair) =>
      Number(pair.multi.success) - Number(pair.single.success))),
    pairedMeanCostDeltaUsd: mean(completePairs.map((pair) =>
      pair.multi.estimatedCostUsd - pair.single.estimatedCostUsd)),
    pairedMeanWallTimeDeltaMs: mean(completePairs.map((pair) =>
      pair.multi.wallTimeMs - pair.single.wallTimeMs)),
    trials: experiment.trials,
  }
}

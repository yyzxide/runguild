import type {
  EvaluationExperimentId,
  EvaluationScenarioId,
  EvaluationScenarioVersionId,
  EvaluationTrialId,
  IsoTimestamp,
  MissionId,
  ProjectId,
  WorkspaceId,
} from './ids.js'
import type { MissionPlanDraft, MissionPlanError } from './plans.js'
import { validateMissionPlan } from './plans.js'

export const EVALUATION_VARIANTS = ['single_agent', 'multi_agent'] as const
export type EvaluationVariant = (typeof EVALUATION_VARIANTS)[number]

export const EVALUATION_TRIAL_STATUSES = [
  'queued',
  'materializing',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export type EvaluationTrialStatus = (typeof EVALUATION_TRIAL_STATUSES)[number]

export const EVALUATION_EXPERIMENT_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export type EvaluationExperimentStatus = (typeof EVALUATION_EXPERIMENT_STATUSES)[number]

export interface EvaluationScenarioDefinition {
  readonly goal: string
  readonly constraints: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly baselineCommit: string
  readonly singleAgentPlan: MissionPlanDraft
  readonly multiAgentPlan: MissionPlanDraft
}

export interface EvaluationScenarioValidation {
  readonly valid: boolean
  readonly errors: readonly {
    readonly path: string
    readonly message: string
  }[]
}

export function validateEvaluationScenario(
  definition: EvaluationScenarioDefinition,
): EvaluationScenarioValidation {
  const errors: { path: string; message: string }[] = []
  if (!definition.goal.trim() || definition.goal.length > 20_000) {
    errors.push({ path: 'goal', message: 'Goal must be between 1 and 20000 characters' })
  }
  if (definition.constraints.length > 100
      || definition.constraints.some((item) => !item.trim() || item.length > 2_000)) {
    errors.push({ path: 'constraints', message: 'Constraints must contain at most 100 bounded strings' })
  }
  if (definition.acceptanceCriteria.length > 100
      || definition.acceptanceCriteria.some((item) => !item.trim() || item.length > 2_000)) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'Acceptance criteria must contain at most 100 bounded strings',
    })
  }
  if (!/^[0-9a-f]{40,64}$/.test(definition.baselineCommit)) {
    errors.push({ path: 'baselineCommit', message: 'Baseline commit must be a full hexadecimal Git object id' })
  }
  const plans: readonly [string, MissionPlanDraft, number, (count: number) => boolean][] = [
    ['singleAgentPlan', definition.singleAgentPlan, 1, (count) => count === 1],
    ['multiAgentPlan', definition.multiAgentPlan, 2, (count) => count >= 2],
  ]
  for (const [path, plan, required, countValid] of plans) {
    const validation = validateMissionPlan(plan)
    if (!validation.valid) {
      errors.push(...validation.errors.map((error: MissionPlanError) => ({
        path: path + '.' + error.path,
        message: error.message,
      })))
    }
    if (!countValid(plan.tasks.length)) {
      errors.push({
        path: path + '.tasks',
        message: path + ' must contain ' + (required === 1 ? 'exactly one Task' : 'at least two Tasks'),
      })
    }
  }
  return { valid: errors.length === 0, errors }
}

export interface EvaluationTrialMetrics {
  readonly success: boolean
  readonly taskCompletionRate: number
  readonly wallTimeMs: number
  readonly taskCount: number
  readonly runAttempts: number
  readonly reworkAttempts: number
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly estimatedCostUsd: number
  readonly toolCalls: number
  readonly toolFailures: number
  readonly reviewChangesRequested: number
  readonly contextSnapshots: number
  readonly compactedContexts: number
  readonly estimatedContextTokens: number
}

export interface EvaluationTrial {
  readonly id: EvaluationTrialId
  readonly experimentId: EvaluationExperimentId
  readonly scenarioVersionId: EvaluationScenarioVersionId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly variant: EvaluationVariant
  readonly repetition: number
  readonly seed: string
  readonly status: EvaluationTrialStatus
  readonly missionId?: MissionId
  readonly metrics?: EvaluationTrialMetrics
  readonly createdAt: IsoTimestamp
  readonly completedAt?: IsoTimestamp
}

export interface EvaluationVariantAggregate {
  readonly variant: EvaluationVariant
  readonly completedTrials: number
  readonly successfulTrials: number
  readonly successRate: number
  readonly meanWallTimeMs: number
  readonly medianWallTimeMs: number
  readonly meanCostUsd: number
  readonly totalCostUsd: number
  readonly meanInputTokens: number
  readonly meanOutputTokens: number
  readonly meanReworkAttempts: number
}

export interface EvaluationExperimentReport {
  readonly experimentId: EvaluationExperimentId
  readonly scenarioId: EvaluationScenarioId
  readonly scenarioVersionId: EvaluationScenarioVersionId
  readonly status: EvaluationExperimentStatus
  readonly repetitions: number
  readonly variants: readonly EvaluationVariantAggregate[]
  readonly pairedTrials: number
  readonly pairedSuccessDelta: number
  readonly pairedMeanCostDeltaUsd: number
  readonly pairedMeanWallTimeDeltaMs: number
  readonly trials: readonly EvaluationTrial[]
}

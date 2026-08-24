import { createHash } from 'node:crypto'

import type {
  MissionRepository,
  ReservedEvaluationTrial,
} from '@runguild/database'
import type {
  CorrelationId,
  EvaluationVariant,
  MissionId,
  MissionPlanDraft,
} from '@runguild/protocol'

type Missions = Pick<
  MissionRepository,
  'approvePlan' | 'createMission' | 'getMission' | 'proposePlan'
>

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Evaluation value is not finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') + '}'
  }
  throw new TypeError('Evaluation value cannot be serialized')
}

function missionId(trialId: string): MissionId {
  return ('mission_evaluation_' + createHash('sha256').update(trialId).digest('hex')) as MissionId
}

function planFor(trial: ReservedEvaluationTrial): MissionPlanDraft {
  return trial.trial.variant === 'single_agent'
    ? trial.definition.singleAgentPlan
    : trial.definition.multiAgentPlan
}

function title(name: string, variant: EvaluationVariant, repetition: number): string {
  return ('[Evaluation ' + variant + ' #' + repetition + '] ' + name).slice(0, 200)
}

export class EvaluationMissionDriver {
  constructor(private readonly missions: Missions) {}

  async materialize(reservation: ReservedEvaluationTrial): Promise<MissionId> {
    const trial = reservation.trial
    const id = missionId(trial.id)
    const correlationId = ('evaluation_' + trial.id) as CorrelationId
    const plan = planFor(reservation)
    let snapshot = await this.missions.getMission(trial.workspaceId, id)
    if (!snapshot) {
      await this.missions.createMission({
        missionId: id,
        workspaceId: trial.workspaceId,
        projectId: trial.projectId,
        title: title(reservation.scenarioName, trial.variant, trial.repetition),
        goal: reservation.definition.goal,
        constraints: [
          ...reservation.definition.constraints,
          'Evaluation variant: ' + trial.variant,
          'Evaluation paired seed: ' + trial.seed,
          'Evaluation baseline commit: ' + reservation.definition.baselineCommit,
        ],
        acceptanceCriteria: reservation.definition.acceptanceCriteria,
        actor: { kind: 'user', id: reservation.createdBy },
        correlationId,
      })
      snapshot = await this.missions.getMission(trial.workspaceId, id)
    }
    if (!snapshot) throw new Error('Evaluation Mission could not be loaded after creation')
    if (snapshot.projectId !== trial.projectId || snapshot.goal !== reservation.definition.goal) {
      throw new Error('Deterministic Evaluation Mission id has conflicting semantics')
    }

    if (snapshot.status === 'planning' || snapshot.status === 'awaiting_approval') {
      const proposed = await this.missions.proposePlan({
        workspaceId: trial.workspaceId,
        missionId: id,
        plan,
        actor: { kind: 'system', id: 'evaluation-harness' },
        correlationId,
      })
      if (!proposed.proposed) throw new Error('Evaluation plan could not be proposed: ' + proposed.reason)
      snapshot = await this.missions.getMission(trial.workspaceId, id)
      if (!snapshot) throw new Error('Evaluation Mission disappeared after plan proposal')
    }

    if (snapshot.status === 'awaiting_approval') {
      const approved = await this.missions.approvePlan({
        workspaceId: trial.workspaceId,
        missionId: id,
        expectedVersion: snapshot.planVersion,
        approvedBy: reservation.createdBy,
        correlationId,
      })
      if (!approved.approved) throw new Error('Evaluation plan could not be approved: ' + approved.reason)
      snapshot = await this.missions.getMission(trial.workspaceId, id)
      if (!snapshot) throw new Error('Evaluation Mission disappeared after approval')
    }

    if (!['running', 'reviewing', 'completed'].includes(snapshot.status)) {
      throw new Error('Evaluation Mission is not executable: ' + snapshot.status)
    }
    if (!snapshot.proposedPlan || canonical(snapshot.proposedPlan.plan) !== canonical(plan)) {
      throw new Error('Evaluation Mission plan differs from the frozen Scenario Version')
    }
    return id
  }
}

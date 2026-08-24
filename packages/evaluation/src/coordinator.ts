import type { EvaluationRepository } from '@runguild/database'

import type { EvaluationMissionDriver } from './mission-driver.js'

type Evaluations = Pick<
  EvaluationRepository,
  'collectReadyTrials' | 'markMaterializationFailed' | 'markMaterialized' | 'reserveMaterialization'
>
type Driver = Pick<EvaluationMissionDriver, 'materialize'>

export interface EvaluationTickResult {
  readonly discovered: number
  readonly materialized: number
  readonly materializationFailed: number
  readonly collected: number
  readonly successful: number
}

export class EvaluationCoordinator {
  constructor(
    private readonly evaluations: Evaluations,
    private readonly driver: Driver,
  ) {}

  async tick(input: {
    readonly materializationLimit: number
    readonly collectionLimit: number
    readonly leaseSeconds: number
  }): Promise<EvaluationTickResult> {
    const reservations = await this.evaluations.reserveMaterialization({
      limit: input.materializationLimit,
      leaseSeconds: input.leaseSeconds,
    })
    let materialized = 0
    let materializationFailed = 0
    for (const reservation of reservations) {
      try {
        const missionId = await this.driver.materialize(reservation)
        await this.evaluations.markMaterialized({
          trialId: reservation.trial.id,
          materializationToken: reservation.materializationToken,
          missionId,
        })
        materialized += 1
      } catch (error) {
        await this.evaluations.markMaterializationFailed({
          trialId: reservation.trial.id,
          materializationToken: reservation.materializationToken,
          error: {
            code: 'evaluation_materialization_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        })
        materializationFailed += 1
      }
    }
    const collected = await this.evaluations.collectReadyTrials(input.collectionLimit)
    return {
      discovered: reservations.length,
      materialized,
      materializationFailed,
      collected: collected.length,
      successful: collected.filter((trial) => trial.metrics?.success).length,
    }
  }
}

import { randomUUID } from 'node:crypto'

import type {
  OutboxRepository,
  ReviewRepository,
  SchedulerRepository,
  TaskRepository,
} from '@runguild/database'
import type { CorrelationId } from '@runguild/protocol'

type Scheduler = Pick<SchedulerRepository, 'dispatchReadyTasks'>
type Tasks = Pick<TaskRepository, 'recoverExpiredLeases'>
type Reviews = Pick<ReviewRepository, 'recoverPendingReviewAssignments'>
type Outbox = Pick<OutboxRepository, 'claimBatch' | 'markPublished' | 'markFailed'>

export interface EventPublisher {
  publish(topic: string, payload: unknown): Promise<void>
}

export interface WorkerTickDependencies {
  readonly scheduler: Scheduler
  readonly tasks: Tasks
  readonly reviews: Reviews
  readonly outbox: Outbox
  readonly publisher: EventPublisher
}

export interface WorkerTickOptions {
  readonly recoveryLimit: number
  readonly reviewRecoveryLimit: number
  readonly dispatchLimit: number
  readonly dispatchSeconds: number
  readonly outboxLimit: number
  readonly outboxClaimSeconds: number
}

export interface WorkerTickResult {
  readonly recovered: number
  readonly reviewsRecovered: number
  readonly dispatched: number
  readonly published: number
  readonly publishFailed: number
}

function retryDelay(attempts: number): number {
  return Math.min(300, Math.max(1, 2 ** Math.min(attempts, 8)))
}

export async function runWorkerTick(
  dependencies: WorkerTickDependencies,
  options: WorkerTickOptions,
): Promise<WorkerTickResult> {
  const correlationId = ('scheduler_' + randomUUID()) as CorrelationId
  const recovered = await dependencies.tasks.recoverExpiredLeases(
    options.recoveryLimit,
    correlationId,
  )
  const recoveredReviews = await dependencies.reviews.recoverPendingReviewAssignments(
    options.reviewRecoveryLimit,
  )
  const dispatches = await dependencies.scheduler.dispatchReadyTasks({
    limit: options.dispatchLimit,
    dispatchSeconds: options.dispatchSeconds,
    correlationId,
  })
  const events = await dependencies.outbox.claimBatch({
    limit: options.outboxLimit,
    claimSeconds: options.outboxClaimSeconds,
  })

  let published = 0
  let publishFailed = 0
  for (const event of events) {
    try {
      await dependencies.publisher.publish(event.topic, event.payload)
      if (await dependencies.outbox.markPublished(event.id, event.claimToken)) {
        published += 1
      }
    } catch (error) {
      publishFailed += 1
      const message = error instanceof Error ? error.message : String(error)
      await dependencies.outbox.markFailed({
        id: event.id,
        claimToken: event.claimToken,
        error: message,
        retryDelaySeconds: retryDelay(event.attempts),
      })
    }
  }

  return {
    recovered: recovered.length,
    reviewsRecovered: recoveredReviews.length,
    dispatched: dispatches.length,
    published,
    publishFailed,
  }
}

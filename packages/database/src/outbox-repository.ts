import { randomUUID } from 'node:crypto'

import type { IsoTimestamp } from '@runguild/protocol'
import type { Pool } from 'pg'

export interface ClaimedOutboxEvent {
  readonly id: string
  readonly topic: string
  readonly partitionKey: string
  readonly payload: unknown
  readonly attempts: number
  readonly claimToken: string
  readonly claimExpiresAt: IsoTimestamp
}

export class OutboxRepository {
  constructor(private readonly pool: Pool) {}

  async claimBatch(input: {
    readonly limit: number
    readonly claimSeconds: number
  }): Promise<readonly ClaimedOutboxEvent[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be an integer between 1 and 500')
    }
    if (!Number.isInteger(input.claimSeconds) || input.claimSeconds < 5 || input.claimSeconds > 600) {
      throw new RangeError('claimSeconds must be an integer between 5 and 600')
    }

    const claimToken = 'outclaim_' + randomUUID()
    const result = await this.pool.query<{
      readonly id: string
      readonly topic: string
      readonly partition_key: string
      readonly payload: unknown
      readonly attempts: number
      readonly claim_expires_at: Date
    }>(
      'WITH picked AS (' +
      '  SELECT id FROM outbox_events ' +
      '  WHERE published_at IS NULL AND available_at <= NOW() ' +
      '  AND (claim_expires_at IS NULL OR claim_expires_at <= NOW()) ' +
      '  ORDER BY created_at ASC, id ASC ' +
      '  LIMIT $1 FOR UPDATE SKIP LOCKED' +
      ') ' +
      'UPDATE outbox_events o ' +
      'SET claim_token = $2, ' +
      "claim_expires_at = NOW() + ($3::double precision * INTERVAL '1 second') " +
      'FROM picked WHERE o.id = picked.id ' +
      'RETURNING o.id, o.topic, o.partition_key, o.payload, o.attempts, o.claim_expires_at',
      [input.limit, claimToken, input.claimSeconds],
    )

    return result.rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      partitionKey: row.partition_key,
      payload: row.payload,
      attempts: row.attempts,
      claimToken,
      claimExpiresAt: row.claim_expires_at.toISOString() as IsoTimestamp,
    }))
  }

  async markPublished(id: string, claimToken: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE outbox_events SET published_at = NOW(), claim_token = NULL, claim_expires_at = NULL ' +
      'WHERE id = $1 AND claim_token = $2 AND published_at IS NULL',
      [id, claimToken],
    )
    return result.rowCount === 1
  }

  async markFailed(input: {
    readonly id: string
    readonly claimToken: string
    readonly error: string
    readonly retryDelaySeconds: number
  }): Promise<boolean> {
    if (!Number.isFinite(input.retryDelaySeconds) || input.retryDelaySeconds < 0 || input.retryDelaySeconds > 86_400) {
      throw new RangeError('retryDelaySeconds must be between 0 and 86400')
    }
    const result = await this.pool.query(
      'UPDATE outbox_events SET attempts = attempts + 1, last_error = $3, ' +
      "available_at = NOW() + ($4::double precision * INTERVAL '1 second'), " +
      'claim_token = NULL, claim_expires_at = NULL ' +
      'WHERE id = $1 AND claim_token = $2 AND published_at IS NULL',
      [input.id, input.claimToken, input.error.slice(0, 4_000), input.retryDelaySeconds],
    )
    return result.rowCount === 1
  }
}

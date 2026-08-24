import { createHash, randomUUID } from 'node:crypto'

import {
  EVENT_TOPICS,
  type AgentId,
  type IsoTimestamp,
  type MissionId,
  type RunId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

export interface EnqueueInboxInput {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly agentId: AgentId
  readonly missionId?: MissionId
  readonly runId?: RunId
  readonly kind: string
  readonly payload: unknown
  readonly dedupeKey: string
}

export interface InboxMessage {
  readonly seq: bigint
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly agentId: AgentId
  readonly missionId: MissionId | null
  readonly runId: RunId | null
  readonly kind: string
  readonly payload: unknown
  readonly createdAt: IsoTimestamp
}

export interface InboxBatch {
  readonly cursor: bigint
  readonly messages: readonly InboxMessage[]
}

function hashPayload(payloadJson: string): string {
  return createHash('sha256').update(payloadJson).digest('hex')
}

export class InboxDedupeConflictError extends Error {
  constructor(agentId: AgentId, dedupeKey: string) {
    super('Inbox dedupe key reused with different payload for ' + agentId + ': ' + dedupeKey)
    this.name = 'InboxDedupeConflictError'
  }
}

export class InboxRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: EnqueueInboxInput): Promise<{ readonly seq: bigint; readonly inserted: boolean }> {
    if (!input.dedupeKey.trim()) {
      throw new Error('dedupeKey is required')
    }
    const payloadJson = canonicalJson(input.payload)
    const payloadHash = hashPayload(payloadJson)

    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ seq: string }>(
        'INSERT INTO inbox_messages ' +
        '(id, workspace_id, agent_id, mission_id, run_id, kind, payload, payload_hash, dedupe_key) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) ' +
        'ON CONFLICT (agent_id, dedupe_key) DO NOTHING RETURNING seq::text',
        [
          input.id,
          input.workspaceId,
          input.agentId,
          input.missionId ?? null,
          input.runId ?? null,
          input.kind,
          payloadJson,
          payloadHash,
          input.dedupeKey,
        ],
      )

      const newRow = inserted.rows[0]
      if (newRow) {
        const seq = BigInt(newRow.seq)
        const wakePayload = {
          schemaVersion: 1,
          type: 'agent.wake',
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          maxSeq: seq.toString(),
          reason: input.kind,
        }
        await client.query(
          'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
          ['wake_' + randomUUID(), EVENT_TOPICS.agentWake, input.agentId, JSON.stringify(wakePayload)],
        )
        return { seq, inserted: true }
      }

      const existing = await client.query<{ seq: string; payload_hash: string }>(
        'SELECT seq::text, payload_hash FROM inbox_messages WHERE agent_id = $1 AND dedupe_key = $2',
        [input.agentId, input.dedupeKey],
      )
      const row = existing.rows[0]
      if (!row) {
        throw new Error('Inbox dedupe conflict row disappeared')
      }
      if (row.payload_hash !== payloadHash) {
        throw new InboxDedupeConflictError(input.agentId, input.dedupeKey)
      }
      return { seq: BigInt(row.seq), inserted: false }
    })
  }

  async read(input: { readonly agentId: AgentId; readonly limit: number }): Promise<InboxBatch> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be an integer between 1 and 500')
    }

    return withTransaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO inbox_cursors (agent_id, last_seq) VALUES ($1, 0) ON CONFLICT (agent_id) DO NOTHING',
        [input.agentId],
      )
      const cursorResult = await client.query<{ last_seq: string }>(
        'SELECT last_seq::text FROM inbox_cursors WHERE agent_id = $1',
        [input.agentId],
      )
      const cursor = BigInt(cursorResult.rows[0]?.last_seq ?? '0')
      const messages = await client.query<{
        readonly seq: string
        readonly id: string
        readonly workspace_id: string
        readonly agent_id: string
        readonly mission_id: string | null
        readonly run_id: string | null
        readonly kind: string
        readonly payload: unknown
        readonly created_at: Date
      }>(
        'SELECT seq::text, id, workspace_id, agent_id, mission_id, run_id, kind, payload, created_at ' +
        'FROM inbox_messages WHERE agent_id = $1 AND seq > $2 ' +
        'ORDER BY seq ASC LIMIT $3',
        [input.agentId, cursor.toString(), input.limit],
      )

      return {
        cursor,
        messages: messages.rows.map((row) => ({
          seq: BigInt(row.seq),
          id: row.id,
          workspaceId: row.workspace_id as WorkspaceId,
          agentId: row.agent_id as AgentId,
          missionId: row.mission_id as MissionId | null,
          runId: row.run_id as RunId | null,
          kind: row.kind,
          payload: row.payload,
          createdAt: row.created_at.toISOString() as IsoTimestamp,
        })),
      }
    })
  }

  async acknowledge(input: {
    readonly agentId: AgentId
    readonly expectedCursor: bigint
    readonly throughSeq: bigint
  }): Promise<boolean> {
    if (input.expectedCursor < 0n || input.throughSeq < input.expectedCursor) {
      throw new RangeError('Invalid inbox cursor range')
    }

    return withTransaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO inbox_cursors (agent_id, last_seq) VALUES ($1, 0) ON CONFLICT (agent_id) DO NOTHING',
        [input.agentId],
      )
      const result = await client.query(
        'UPDATE inbox_cursors SET last_seq = $3, updated_at = NOW() ' +
        'WHERE agent_id = $1 AND last_seq = $2 ' +
        'AND ($3 = $2 OR EXISTS (' +
        '  SELECT 1 FROM inbox_messages WHERE agent_id = $1 AND seq = $3' +
        '))',
        [input.agentId, input.expectedCursor.toString(), input.throughSeq.toString()],
      )
      return result.rowCount === 1
    })
  }
}

import { randomUUID } from 'node:crypto'

import {
  type AgentId,
  type EvidenceKind,
  type EvidenceRef,
  type IsoTimestamp,
  type MissionId,
  type RunId,
  type TaskId,
  type ToolCallId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

export interface RecordToolEvidenceInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly toolCallId: ToolCallId
  readonly kind: EvidenceKind
  readonly uri: string
  readonly contentHash: string
  readonly metadata: Readonly<Record<string, unknown>>
}

interface EvidenceRow {
  readonly id: string
  readonly kind: EvidenceKind
  readonly uri: string
  readonly content_hash: string | null
  readonly run_id: string | null
  readonly created_at: Date
  readonly expires_at: Date | null
}

function asRef(row: EvidenceRow): EvidenceRef {
  return {
    id: row.id as EvidenceRef['id'],
    kind: row.kind,
    uri: row.uri,
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
    ...(row.run_id === null ? {} : { producerRunId: row.run_id as RunId }),
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() as IsoTimestamp }),
  }
}

export class EvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async recordToolEvidence(input: RecordToolEvidenceInput): Promise<readonly EvidenceRef[]> {
    if (!input.uri.trim() || !input.contentHash.trim()) {
      throw new Error('Evidence uri and contentHash are required')
    }
    return withTransaction(this.pool, async (client) => {
      const criteria = await client.query<{ id: string }>(
        'SELECT id FROM task_acceptance_criteria ' +
        'WHERE task_id = $1 AND required AND (' +
        'cardinality(required_evidence_kinds) = 0 OR $2 = ANY(required_evidence_kinds)' +
        ') ORDER BY criterion_key',
        [input.taskId, input.kind],
      )
      const criterionIds: Array<string | null> = criteria.rows.length === 0
        ? [null]
        : criteria.rows.map((row) => row.id)
      const evidence: EvidenceRef[] = []
      for (const criterionId of criterionIds) {
        evidence.push(asRef(await this.insertOrLoad(client, input, criterionId)))
      }
      return evidence
    })
  }

  private async insertOrLoad(
    client: PoolClient,
    input: RecordToolEvidenceInput,
    criterionId: string | null,
  ): Promise<EvidenceRow> {
    const metadata = canonicalJson({
      ...input.metadata,
      agentId: input.agentId,
      toolCallId: input.toolCallId,
    })
    const inserted = await client.query<EvidenceRow>(
      'INSERT INTO evidence ' +
      '(id, workspace_id, mission_id, task_id, run_id, acceptance_criterion_id, kind, uri, content_hash, metadata) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) ' +
      'ON CONFLICT DO NOTHING ' +
      'RETURNING id, kind, uri, content_hash, run_id, created_at, expires_at',
      [
        'evidence_' + randomUUID(),
        input.workspaceId,
        input.missionId,
        input.taskId,
        input.runId,
        criterionId,
        input.kind,
        input.uri,
        input.contentHash,
        metadata,
      ],
    )
    if (inserted.rows[0]) return inserted.rows[0]

    const existing = await client.query<EvidenceRow>(
      'SELECT id, kind, uri, content_hash, run_id, created_at, expires_at FROM evidence ' +
      'WHERE run_id = $1 AND acceptance_criterion_id IS NOT DISTINCT FROM $2 ' +
      'AND kind = $3 AND content_hash = $4',
      [input.runId, criterionId, input.kind, input.contentHash],
    )
    if (!existing.rows[0]) throw new Error('Evidence conflict row disappeared')
    return existing.rows[0]
  }
}

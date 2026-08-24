import { createHash, randomUUID } from 'node:crypto'

import {
  type AnyToolRequest,
  type ApprovalId,
  EVENT_TOPICS,
  type ToolFailure,
  type ToolResult,
  type ToolRetryMode,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

interface ToolExecutionRow {
  readonly id: string
  readonly request_hash: string
  readonly status: 'reserved' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed'
  readonly retry_mode: ToolRetryMode
  readonly result: ToolResult | null
  readonly execution_token: string | null
  readonly lease_expires_at: Date | null
}

export type ToolReservation =
  | { readonly kind: 'execute'; readonly executionId: string; readonly executionToken: string }
  | { readonly kind: 'replay'; readonly result: ToolResult }
  | { readonly kind: 'awaiting_approval'; readonly approvalId: ApprovalId }
  | { readonly kind: 'in_progress'; readonly retryAfterMs: number }

export interface ReserveToolExecutionInput {
  readonly request: AnyToolRequest
  readonly retryMode: ToolRetryMode
  readonly leaseMs?: number
}

export interface ResolveToolApprovalInput {
  readonly approvalId: ApprovalId
  readonly workspaceId: WorkspaceId
  readonly resolvedBy: string
  readonly decision: 'approved' | 'rejected'
}

function requestHash(request: AnyToolRequest): string {
  const semanticRequest = {
    action: request.action,
    workspaceId: request.workspaceId,
    missionId: request.missionId,
    taskId: request.taskId,
    runId: request.runId,
    agentId: request.agentId,
    risk: request.risk,
    input: request.input,
  }
  return createHash('sha256').update(canonicalJson(semanticRequest)).digest('hex')
}

function ambiguousResult(message: string): Extract<ToolResult, { readonly status: 'failed' }> {
  const error: ToolFailure = {
    code: 'ambiguous_effect',
    message,
    retryable: false,
  }
  return {
    status: 'failed',
    error,
    effectState: 'unknown',
    sideEffects: [],
  }
}

function leaseDuration(leaseMs = 30_000): number {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 600_000) {
    throw new RangeError('leaseMs must be an integer between 1000 and 600000')
  }
  return leaseMs
}

export class ToolExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveToolExecutionInput): Promise<ToolReservation> {
    const leaseMs = leaseDuration(input.leaseMs)
    const hash = requestHash(input.request)
    const requiresApproval = input.request.risk === 'external_write'
      || input.request.risk === 'destructive'

    return withTransaction(this.pool, async (client) => {
      const executionToken = requiresApproval ? null : 'tool_lease_' + randomUUID()
      const inserted = await client.query<ToolExecutionRow>(
        'INSERT INTO tool_executions ' +
        '(id, workspace_id, mission_id, task_id, run_id, agent_id, action, idempotency_key, ' +
        'request_hash, request, risk, retry_mode, status, execution_token, lease_expires_at, attempts, started_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, " +
        "CASE WHEN $14::text IS NULL THEN NULL ELSE NOW() + ($15::double precision * INTERVAL '1 millisecond') END, " +
        'CASE WHEN $14::text IS NULL THEN 0 ELSE 1 END, CASE WHEN $14::text IS NULL THEN NULL ELSE NOW() END) ' +
        'ON CONFLICT DO NOTHING RETURNING *',
        [
          input.request.id,
          input.request.workspaceId,
          input.request.missionId,
          input.request.taskId,
          input.request.runId,
          input.request.agentId,
          input.request.action,
          input.request.idempotencyKey,
          hash,
          JSON.stringify(input.request),
          input.request.risk,
          input.retryMode,
          requiresApproval ? 'awaiting_approval' : 'running',
          executionToken,
          leaseMs,
        ],
      )

      const created = inserted.rows[0]
      if (created) {
        if (requiresApproval) {
          const approvalId = ('approval_' + randomUUID()) as ApprovalId
          await client.query(
            'INSERT INTO approvals ' +
            '(id, workspace_id, mission_id, run_id, tool_execution_id, subject_type, subject_id, ' +
            'kind, requested_by, reason) ' +
            "VALUES ($1, $2, $3, $4, $5, 'tool_execution', $5, $6, $7, $8)",
            [
              approvalId,
              input.request.workspaceId,
              input.request.missionId,
              input.request.runId,
              input.request.id,
              'tool_risk:' + input.request.risk,
              input.request.agentId,
              'Tool action ' + input.request.action + ' requires human approval.',
            ],
          )
          return { kind: 'awaiting_approval', approvalId }
        }
        if (!executionToken) {
          throw new Error('Safe tool reservation did not receive an execution token')
        }
        return { kind: 'execute', executionId: created.id, executionToken }
      }

      const existing = await client.query<ToolExecutionRow>(
        'SELECT * FROM tool_executions WHERE workspace_id = $1 AND idempotency_key = $2 FOR UPDATE',
        [input.request.workspaceId, input.request.idempotencyKey],
      )
      const row = existing.rows[0]
      if (!row) {
        throw new Error('Tool call id already exists with a different idempotency key')
      }
      if (row.request_hash !== hash) {
        throw new Error('Idempotency key reused with a different tool request')
      }
      if (row.retry_mode !== input.retryMode) {
        throw new Error('Tool retry policy changed for an existing idempotency key')
      }
      if (row.status === 'succeeded' || row.status === 'failed') {
        if (!row.result) {
          throw new Error('Terminal tool execution is missing its result')
        }
        return { kind: 'replay', result: row.result }
      }

      if (row.status === 'awaiting_approval') {
        const approval = await client.query<{ id: string; status: string }>(
          'SELECT id, status FROM approvals WHERE tool_execution_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
          [row.id],
        )
        const decision = approval.rows[0]
        if (!decision) {
          throw new Error('Tool execution is awaiting a missing approval')
        }
        if (decision.status === 'pending') {
          return { kind: 'awaiting_approval', approvalId: decision.id as ApprovalId }
        }
        if (decision.status !== 'approved') {
          const result: ToolResult = {
            status: 'failed',
            error: { code: 'forbidden', message: 'Human approval was not granted.', retryable: false },
            effectState: 'none',
            sideEffects: [],
          }
          await client.query(
            "UPDATE tool_executions SET status = 'failed', result = $2::jsonb, error = $3::jsonb, " +
            "finished_at = NOW(), updated_at = NOW() WHERE id = $1",
            [row.id, JSON.stringify(result), JSON.stringify(result.error)],
          )
          return { kind: 'replay', result }
        }
        return this.acquire(client, row.id, leaseMs)
      }

      if (row.status === 'running' && row.lease_expires_at && row.lease_expires_at.getTime() > Date.now()) {
        return {
          kind: 'in_progress',
          retryAfterMs: Math.max(100, row.lease_expires_at.getTime() - Date.now()),
        }
      }

      if (row.retry_mode === 'none') {
        const result = ambiguousResult(
          'The previous execution lost its lease and this tool has no safe retry mechanism.',
        )
        await client.query(
          "UPDATE tool_executions SET status = 'failed', effect_state = 'unknown', result = $2::jsonb, " +
          "error = $3::jsonb, execution_token = NULL, lease_expires_at = NULL, finished_at = NOW(), " +
          'updated_at = NOW() WHERE id = $1',
          [row.id, JSON.stringify(result), JSON.stringify(result.error)],
        )
        return { kind: 'replay', result }
      }

      return this.acquire(client, row.id, leaseMs)
    })
  }

  private async acquire(
    client: { query: Pool['query'] },
    executionId: string,
    leaseMs: number,
  ): Promise<ToolReservation> {
    const executionToken = 'tool_lease_' + randomUUID()
    const acquired = await client.query<{ id: string }>(
      "UPDATE tool_executions SET status = 'running', execution_token = $2, " +
      "lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'), " +
      'attempts = attempts + 1, started_at = COALESCE(started_at, NOW()), updated_at = NOW() ' +
      'WHERE id = $1 RETURNING id',
      [executionId, executionToken, leaseMs],
    )
    if (acquired.rowCount !== 1) {
      throw new Error('Tool execution lease could not be acquired')
    }
    return { kind: 'execute', executionId, executionToken }
  }

  async finish(
    executionId: string,
    executionToken: string,
    result: ToolResult,
  ): Promise<void> {
    if (result.status === 'awaiting_approval' || result.status === 'in_progress') {
      throw new Error('A running execution can only finish with a terminal result')
    }
    const status = result.status === 'succeeded' ? 'succeeded' : 'failed'
    const effectState = result.status === 'succeeded' ? 'complete' : result.effectState
    const error = result.status === 'failed' ? result.error : null
    const updated = await this.pool.query(
      'UPDATE tool_executions SET status = $3, effect_state = $4, result = $5::jsonb, error = $6::jsonb, ' +
      'execution_token = NULL, lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW() ' +
      "WHERE id = $1 AND execution_token = $2 AND status = 'running'",
      [executionId, executionToken, status, effectState, JSON.stringify(result), JSON.stringify(error)],
    )
    if (updated.rowCount !== 1) {
      throw new Error('Tool execution fencing token is stale')
    }
  }

  async resolveApproval(input: ResolveToolApprovalInput): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const approval = await client.query<{
        status: string
        tool_execution_id: string
        mission_id: string
        run_id: string
        agent_id: string
      }>(
        'SELECT ap.status, ap.tool_execution_id, te.mission_id, te.run_id, te.agent_id ' +
        'FROM approvals ap JOIN tool_executions te ON te.id = ap.tool_execution_id ' +
        "WHERE ap.id = $1 AND ap.workspace_id = $2 AND ap.subject_type = 'tool_execution' " +
        'FOR UPDATE OF ap',
        [input.approvalId, input.workspaceId],
      )
      const row = approval.rows[0]
      if (!row || row.status !== 'pending') {
        return false
      }
      const updated = await client.query(
        'UPDATE approvals SET status = $2, resolved_by = $3, resolved_at = NOW() ' +
        "WHERE id = $1 AND status = 'pending'",
        [input.approvalId, input.decision, input.resolvedBy],
      )
      if (updated.rowCount !== 1) {
        return false
      }

      const wakeData = {
        schemaVersion: 1,
        type: 'agent.wake',
        reason: 'tool_approval_resolved',
        workspaceId: input.workspaceId,
        missionId: row.mission_id,
        runId: row.run_id,
        agentId: row.agent_id,
        approvalId: input.approvalId,
        decision: input.decision,
      }
      const payload = canonicalJson(wakeData)
      const payloadHash = createHash('sha256').update(payload).digest('hex')
      const dedupeKey = 'tool-approval:' + input.approvalId + ':' + input.decision
      await client.query(
        'INSERT INTO inbox_messages ' +
        '(id, workspace_id, agent_id, mission_id, run_id, kind, payload, payload_hash, dedupe_key) ' +
        "VALUES ($1, $2, $3, $4, $5, 'tool.approval_resolved', $6::jsonb, $7, $8) " +
        'ON CONFLICT (agent_id, dedupe_key) DO NOTHING',
        [
          'inbox_' + randomUUID(),
          input.workspaceId,
          row.agent_id,
          row.mission_id,
          row.run_id,
          payload,
          payloadHash,
          dedupeKey,
        ],
      )
      await client.query(
        'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
        ['wake_' + randomUUID(), EVENT_TOPICS.agentWake, row.agent_id, payload],
      )
      return true
    })
  }
}

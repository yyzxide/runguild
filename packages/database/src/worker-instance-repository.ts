import type { AgentId, WorkspaceId } from '@runguild/protocol'
import type { Pool } from 'pg'

import { withTransaction } from './transaction.js'

export const WORKER_KINDS = ['scheduler', 'agent', 'integration', 'evaluation'] as const
export type WorkerKind = typeof WORKER_KINDS[number]

export interface RegisterWorkerInput {
  readonly id: string
  readonly kind: WorkerKind
  readonly agentId?: AgentId
  readonly hostname: string
  readonly processId: number
  readonly heartbeatIntervalSeconds: number
  readonly heartbeatTimeoutSeconds: number
}

export interface WorkerInstanceRegistration {
  readonly id: string
  readonly kind: WorkerKind
  readonly workspaceId: WorkspaceId | null
  readonly agentId: AgentId | null
  readonly startedAt: string
  readonly expiresAt: string
}

export class WorkerAlreadyActiveError extends Error {
  constructor(readonly agentId: AgentId) {
    super('Agent already has an active Worker instance: ' + agentId)
    this.name = 'WorkerAlreadyActiveError'
  }
}

function assertInput(input: RegisterWorkerInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(input.id)) {
    throw new Error('Worker instance id must be 1-200 scoped-id characters')
  }
  if (!WORKER_KINDS.includes(input.kind)) throw new Error('Unsupported Worker kind')
  if ((input.kind === 'agent') !== Boolean(input.agentId)) {
    throw new Error('Agent Worker registration must include exactly one agentId')
  }
  if (!input.hostname.trim() || input.hostname.length > 255) {
    throw new Error('Worker hostname must be between 1 and 255 characters')
  }
  if (!Number.isInteger(input.processId) || input.processId < 1) {
    throw new Error('Worker process id must be a positive integer')
  }
  if (!Number.isInteger(input.heartbeatIntervalSeconds)
      || input.heartbeatIntervalSeconds < 1
      || input.heartbeatIntervalSeconds > 3_600) {
    throw new Error('Worker heartbeat interval must be between 1 and 3600 seconds')
  }
  if (!Number.isInteger(input.heartbeatTimeoutSeconds)
      || input.heartbeatTimeoutSeconds <= input.heartbeatIntervalSeconds
      || input.heartbeatTimeoutSeconds > 10_800) {
    throw new Error('Worker heartbeat timeout must be greater than its interval and at most 10800 seconds')
  }
}

export class WorkerInstanceRepository {
  constructor(private readonly pool: Pool) {}

  async register(input: RegisterWorkerInput): Promise<WorkerInstanceRegistration> {
    assertInput(input)
    return withTransaction(this.pool, async (client) => {
      let workspaceId: string | null = null
      if (input.kind === 'agent' && input.agentId) {
        const agent = await client.query<{ readonly workspace_id: string }>(
          'SELECT workspace_id FROM agents WHERE id = $1 FOR UPDATE',
          [input.agentId],
        )
        workspaceId = agent.rows[0]?.workspace_id ?? null
        if (!workspaceId) throw new Error('Agent Worker registration references an unknown Agent')

        await client.query(
          "UPDATE worker_instances SET status = 'stale', stopped_at = expires_at " +
          "WHERE agent_id = $1 AND kind = 'agent' AND status = 'running' AND expires_at <= NOW()",
          [input.agentId],
        )
        const active = await client.query<{ readonly id: string }>(
          "SELECT id FROM worker_instances WHERE agent_id = $1 AND kind = 'agent' " +
          "AND status = 'running' AND expires_at > NOW() LIMIT 1",
          [input.agentId],
        )
        if (active.rows[0]) throw new WorkerAlreadyActiveError(input.agentId)
      }

      const inserted = await client.query<{
        readonly started_at: Date
        readonly expires_at: Date
      }>(
        'INSERT INTO worker_instances ' +
        '(id, kind, workspace_id, agent_id, hostname, process_id, heartbeat_interval_seconds, ' +
        'heartbeat_timeout_seconds, expires_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7::integer, $8::integer, " +
        "NOW() + ($8::integer * INTERVAL '1 second')) " +
        'RETURNING started_at, expires_at',
        [
          input.id,
          input.kind,
          workspaceId,
          input.agentId ?? null,
          input.hostname.trim(),
          input.processId,
          input.heartbeatIntervalSeconds,
          input.heartbeatTimeoutSeconds,
        ],
      )
      const row = inserted.rows[0]
      if (!row) throw new Error('Worker registration was not persisted')
      return {
        id: input.id,
        kind: input.kind,
        workspaceId: workspaceId as WorkspaceId | null,
        agentId: input.agentId ?? null,
        startedAt: row.started_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
      }
    })
  }

  async heartbeat(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE worker_instances SET last_heartbeat_at = NOW(), ' +
      "expires_at = NOW() + (heartbeat_timeout_seconds::double precision * INTERVAL '1 second') " +
      "WHERE id = $1 AND status = 'running'",
      [id],
    )
    return (result.rowCount ?? 0) > 0
  }

  async hasActive(kind: WorkerKind, agentId?: AgentId): Promise<boolean> {
    if (!WORKER_KINDS.includes(kind)) throw new Error('Unsupported Worker kind')
    if ((kind === 'agent') !== Boolean(agentId)) {
      throw new Error('Agent Worker lookup must include exactly one agentId')
    }
    const result = await this.pool.query(
      "SELECT 1 FROM worker_instances WHERE kind = $1 AND status = 'running' AND expires_at > NOW() " +
      'AND (($1 = \'agent\' AND agent_id = $2) OR ($1 <> \'agent\' AND agent_id IS NULL)) LIMIT 1',
      [kind, agentId ?? null],
    )
    return result.rows.length > 0
  }

  async markStopped(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE worker_instances SET status = 'stopped', stopped_at = NOW(), " +
      'last_heartbeat_at = NOW(), expires_at = NOW() ' +
      "WHERE id = $1 AND status = 'running'",
      [id],
    )
    return (result.rowCount ?? 0) > 0
  }
}

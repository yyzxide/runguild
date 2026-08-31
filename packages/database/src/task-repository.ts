import { randomUUID } from 'node:crypto'

import {
  type ActorRef,
  type AgentId,
  type CorrelationId,
  type IsoTimestamp,
  type MissionId,
  type ProjectId,
  type RunId,
  type RunStatus,
  type TaskId,
  type TaskStatus,
  type UserId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { appendDomainEvent } from './events.js'
import { withTransaction } from './transaction.js'

export interface ClaimTaskInput {
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly agentId: AgentId
  readonly runId: RunId
  readonly correlationId: CorrelationId
  readonly dispatchToken: string
  readonly leaseSeconds: number
  readonly contextSnapshot?: Readonly<Record<string, unknown>>
}

export type ClaimTaskResult =
  | {
      readonly claimed: true
      readonly taskId: TaskId
      readonly runId: RunId
      readonly attempt: number
      readonly leaseToken: string
      readonly leaseExpiresAt: IsoTimestamp
    }
  | {
      readonly claimed: false
      readonly reason: 'not_claimable'
    }

export interface RenewLeaseInput {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly leaseToken: string
  readonly leaseSeconds: number
}

export interface ReleaseLeaseInput {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly leaseToken: string
}

export interface ResolveTerminalRunLeaseInput extends ReleaseLeaseInput {
  readonly correlationId: CorrelationId
}

export interface ResumeWaitingRunInput {
  readonly runId: RunId
  readonly agentId: AgentId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly leaseSeconds: number
}

export interface RunnableAgentRunScope {
  readonly agentId: AgentId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly limit: number
}

export type ResumeWaitingRunResult =
  | {
      readonly resumed: true
      readonly workspaceId: WorkspaceId
      readonly missionId: MissionId
      readonly taskId: TaskId
      readonly leaseToken: string
      readonly leaseExpiresAt: IsoTimestamp
    }
  | { readonly resumed: false; readonly reason: 'not_resumable' }

export interface RunnableAgentRun {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly leaseToken: string
}

export interface CompleteTaskInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly actor: ActorRef
  readonly correlationId: CorrelationId
}

export type CompleteTaskResult =
  | {
      readonly completed: true
      readonly unlockedTaskIds: readonly TaskId[]
      readonly missionReadyForReview: boolean
    }
  | {
      readonly completed: false
      readonly reason: 'not_completable' | 'missing_evidence' | 'missing_review' | 'missing_integration'
    }

export interface RetryFailedTaskInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly requestedBy: UserId
  readonly reason: string
  readonly correlationId: CorrelationId
}

export type RetryFailedTaskResult =
  | { readonly retried: true; readonly maxAttempts: number }
  | {
      readonly retried: false
      readonly reason: 'not_found_or_forbidden' | 'mission_not_running' | 'task_not_failed'
        | 'dependencies_incomplete' | 'retry_limit'
    }

interface ClaimableTaskRow {
  readonly project_id: string
  readonly attempt_count: number
  readonly dispatch_id: string
}

interface ExpiredLeaseRow {
  readonly workspace_id: string
  readonly project_id: string
  readonly mission_id: string
  readonly task_id: string
  readonly task_status: TaskStatus
  readonly attempt_count: number
  readonly max_attempts: number
  readonly run_id: string
  readonly run_status: RunStatus
}

function assertLeaseSeconds(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3_600) {
    throw new RangeError('leaseSeconds must be an integer between 5 and 3600')
  }
}

export class TaskRepository {
  constructor(private readonly pool: Pool) {}

  async retryFailedTask(input: RetryFailedTaskInput): Promise<RetryFailedTaskResult> {
    const reason = input.reason.trim()
    if (!reason || reason.length > 2_000) {
      throw new Error('Task retry reason must be between 1 and 2000 characters')
    }
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{
        readonly project_id: string
        readonly mission_status: string
        readonly task_status: TaskStatus
        readonly max_attempts: number
        readonly dependencies_complete: boolean
      }>(
        'SELECT m.project_id, m.status AS mission_status, t.status AS task_status, t.max_attempts, ' +
        'NOT EXISTS (' +
        '  SELECT 1 FROM task_dependencies d JOIN tasks parent ON parent.id = d.depends_on_task_id ' +
        '  WHERE d.task_id = t.id AND d.required AND parent.status <> $5' +
        ') AS dependencies_complete ' +
        'FROM tasks t JOIN missions m ON m.id = t.mission_id ' +
        'JOIN users u ON u.id = $4 AND u.workspace_id = m.workspace_id ' +
        'WHERE t.id = $1 AND t.mission_id = $2 AND m.workspace_id = $3 FOR UPDATE OF t',
        [input.taskId, input.missionId, input.workspaceId, input.requestedBy, 'completed'],
      )
      const row = result.rows[0]
      if (!row) return { retried: false, reason: 'not_found_or_forbidden' }
      if (row.mission_status !== 'running') return { retried: false, reason: 'mission_not_running' }
      if (row.task_status !== 'failed') return { retried: false, reason: 'task_not_failed' }
      if (!row.dependencies_complete) return { retried: false, reason: 'dependencies_incomplete' }
      if (row.max_attempts >= 1_000) return { retried: false, reason: 'retry_limit' }

      const maxAttempts = row.max_attempts + 1
      await client.query(
        "UPDATE tasks SET status = 'ready', max_attempts = $2, updated_at = NOW() " +
        "WHERE id = $1 AND status = 'failed'",
        [input.taskId, maxAttempts],
      )
      await appendDomainEvent(client, {
        type: 'task.status_changed',
        workspaceId: input.workspaceId,
        projectId: row.project_id as ProjectId,
        missionId: input.missionId,
        actor: { kind: 'user', id: input.requestedBy },
        correlationId: input.correlationId,
        payload: {
          taskId: input.taskId,
          from: 'failed',
          to: 'ready',
          reason,
        },
      })
      return { retried: true, maxAttempts }
    })
  }

  async claimTask(input: ClaimTaskInput): Promise<ClaimTaskResult> {
    assertLeaseSeconds(input.leaseSeconds)

    return withTransaction(this.pool, async (client) => {
      const claimable = await client.query<ClaimableTaskRow>(
        'SELECT m.project_id, t.attempt_count, d.id AS dispatch_id ' +
        'FROM tasks t ' +
        'JOIN missions m ON m.id = t.mission_id ' +
        'JOIN agents a ON a.id = $4 AND a.workspace_id = m.workspace_id ' +
        'JOIN task_dispatches d ON d.task_id = t.id AND d.agent_id = a.id ' +
        "AND d.dispatch_token = $6 AND d.status = 'pending' AND d.expires_at > NOW() " +
        'AND d.attempt = t.attempt_count + 1 ' +
        'WHERE t.id = $1 AND t.mission_id = $2 AND m.workspace_id = $3 AND m.project_id = $7 ' +
        "AND t.status = 'ready' AND m.status = 'running' AND a.status = 'active' " +
        'AND t.attempt_count < t.max_attempts ' +
        'AND (t.required_role IS NULL OR t.required_role = a.role) ' +
        'AND NOT EXISTS (' +
        '  SELECT 1 FROM task_dependencies d ' +
        '  JOIN tasks parent ON parent.id = d.depends_on_task_id ' +
        '  WHERE d.task_id = t.id AND d.required AND parent.status <> $5' +
        ') ' +
        'FOR UPDATE OF t, d',
        [
          input.taskId,
          input.missionId,
          input.workspaceId,
          input.agentId,
          'completed',
          input.dispatchToken,
          input.projectId,
        ],
      )

      const row = claimable.rows[0]
      if (!row) {
        return { claimed: false, reason: 'not_claimable' }
      }

      const attempt = row.attempt_count + 1
      const leaseToken = 'lease_' + randomUUID()

      await client.query(
        "UPDATE tasks SET status = 'claimed', attempt_count = $2, updated_at = NOW() WHERE id = $1",
        [input.taskId, attempt],
      )
      await client.query(
        'INSERT INTO agent_runs ' +
        '(id, workspace_id, mission_id, task_id, agent_id, attempt, status, context_snapshot) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, 'starting', $7::jsonb)",
        [
          input.runId,
          input.workspaceId,
          input.missionId,
          input.taskId,
          input.agentId,
          attempt,
          JSON.stringify(input.contextSnapshot ?? {}),
        ],
      )
      const lease = await client.query<{ expires_at: Date }>(
        'INSERT INTO task_leases ' +
        '(task_id, run_id, agent_id, lease_token, expires_at) ' +
        "VALUES ($1, $2, $3, $4, NOW() + ($5::double precision * INTERVAL '1 second')) " +
        'RETURNING expires_at',
        [input.taskId, input.runId, input.agentId, leaseToken, input.leaseSeconds],
      )
      const expiresAt = lease.rows[0]?.expires_at
      if (!expiresAt) {
        throw new Error('Lease insert did not return expires_at')
      }
      const consumed = await client.query(
        "UPDATE task_dispatches SET status = 'consumed', run_id = $2, consumed_at = NOW() " +
        "WHERE id = $1 AND status = 'pending'",
        [row.dispatch_id, input.runId],
      )
      if (consumed.rowCount !== 1) {
        throw new Error('Task dispatch was not consumed atomically')
      }

      const projectId = row.project_id as ProjectId
      const actor = { kind: 'agent', id: input.agentId, runId: input.runId } as const
      await appendDomainEvent(client, {
        type: 'task.status_changed',
        workspaceId: input.workspaceId,
        projectId,
        missionId: input.missionId,
        actor,
        correlationId: input.correlationId,
        payload: {
          taskId: input.taskId,
          from: 'ready',
          to: 'claimed',
          reason: 'atomic task claim',
        },
      })
      await appendDomainEvent(client, {
        type: 'task.claimed',
        workspaceId: input.workspaceId,
        projectId,
        missionId: input.missionId,
        actor,
        correlationId: input.correlationId,
        payload: {
          taskId: input.taskId,
          agentId: input.agentId,
          leaseExpiresAt: expiresAt.toISOString() as IsoTimestamp,
        },
      })
      await appendDomainEvent(client, {
        type: 'run.created',
        workspaceId: input.workspaceId,
        projectId,
        missionId: input.missionId,
        actor,
        correlationId: input.correlationId,
        payload: {
          runId: input.runId,
          taskId: input.taskId,
          agentId: input.agentId,
          attempt,
        },
      })

      return {
        claimed: true,
        taskId: input.taskId,
        runId: input.runId,
        attempt,
        leaseToken,
        leaseExpiresAt: expiresAt.toISOString() as IsoTimestamp,
      }
    })
  }

  async renewLease(input: RenewLeaseInput): Promise<IsoTimestamp | null> {
    assertLeaseSeconds(input.leaseSeconds)
    const result = await this.pool.query<{ expires_at: Date }>(
      'UPDATE task_leases l ' +
      "SET heartbeat_at = NOW(), expires_at = NOW() + ($5::double precision * INTERVAL '1 second') " +
      'FROM tasks t ' +
      'WHERE l.task_id = $1 AND l.run_id = $2 AND l.agent_id = $3 AND l.lease_token = $4 ' +
      'AND l.task_id = t.id AND l.expires_at > NOW() ' +
      "AND t.status IN ('claimed', 'running', 'waiting_human') " +
      'RETURNING l.expires_at',
      [input.taskId, input.runId, input.agentId, input.leaseToken, input.leaseSeconds],
    )
    const expiresAt = result.rows[0]?.expires_at
    return expiresAt ? expiresAt.toISOString() as IsoTimestamp : null
  }

  async releaseLease(input: ReleaseLeaseInput): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM task_leases WHERE task_id = $1 AND run_id = $2 ' +
      'AND agent_id = $3 AND lease_token = $4',
      [input.taskId, input.runId, input.agentId, input.leaseToken],
    )
    return result.rowCount === 1
  }

  async resolveTerminalRunLease(input: ResolveTerminalRunLeaseInput): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<ExpiredLeaseRow>(
        'SELECT m.workspace_id, m.project_id, t.mission_id, t.id AS task_id, ' +
        't.status AS task_status, t.attempt_count, t.max_attempts, ' +
        'r.id AS run_id, r.status AS run_status ' +
        'FROM task_leases l ' +
        'JOIN tasks t ON t.id = l.task_id ' +
        'JOIN missions m ON m.id = t.mission_id ' +
        'JOIN agent_runs r ON r.id = l.run_id ' +
        'WHERE l.task_id = $1 AND l.run_id = $2 AND l.agent_id = $3 AND l.lease_token = $4 ' +
        "AND t.status IN ('claimed', 'running', 'waiting_human') " +
        "AND r.status IN ('failed', 'cancelled', 'timed_out') " +
        'FOR UPDATE OF l, t',
        [input.taskId, input.runId, input.agentId, input.leaseToken],
      )
      const row = result.rows[0]
      if (!row) return false

      const nextTaskStatus: TaskStatus = row.attempt_count >= row.max_attempts ? 'failed' : 'ready'
      await client.query(
        'UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1',
        [row.task_id, nextTaskStatus],
      )
      await client.query('DELETE FROM task_leases WHERE task_id = $1', [row.task_id])
      await appendDomainEvent(client, {
        type: 'task.status_changed',
        workspaceId: row.workspace_id as WorkspaceId,
        projectId: row.project_id as ProjectId,
        missionId: row.mission_id as MissionId,
        actor: { kind: 'agent', id: input.agentId, runId: input.runId },
        correlationId: input.correlationId,
        payload: {
          taskId: row.task_id as TaskId,
          from: row.task_status,
          to: nextTaskStatus,
          reason: nextTaskStatus === 'ready'
            ? 'terminal Run released its lease for immediate retry'
            : 'maximum attempts exhausted by terminal Run',
        },
      })
      return true
    })
  }

  async resumeWaitingRun(input: ResumeWaitingRunInput): Promise<ResumeWaitingRunResult> {
    assertLeaseSeconds(input.leaseSeconds)
    return withTransaction(this.pool, async (client) => {
      const resumable = await client.query<{
        workspace_id: string
        mission_id: string
        task_id: string
      }>(
        'SELECT r.workspace_id, r.mission_id, r.task_id FROM agent_runs r ' +
        'JOIN tasks t ON t.id = r.task_id ' +
        'JOIN missions m ON m.id = r.mission_id AND m.workspace_id = r.workspace_id ' +
        'JOIN agents a ON a.id = r.agent_id ' +
        'WHERE r.id = $1 AND r.agent_id = $2 ' +
        'AND r.workspace_id = $3 AND m.project_id = $4 ' +
        "AND r.status = 'waiting_human' AND t.status = 'waiting_human' AND a.status = 'active' " +
        'AND NOT EXISTS (SELECT 1 FROM task_leases l WHERE l.task_id = r.task_id) ' +
        'FOR UPDATE OF r, t',
        [input.runId, input.agentId, input.workspaceId, input.projectId],
      )
      const row = resumable.rows[0]
      if (!row) return { resumed: false, reason: 'not_resumable' }
      const leaseToken = 'lease_' + randomUUID()
      const lease = await client.query<{ expires_at: Date }>(
        'INSERT INTO task_leases (task_id, run_id, agent_id, lease_token, expires_at) ' +
        "VALUES ($1, $2, $3, $4, NOW() + ($5::double precision * INTERVAL '1 second')) " +
        'RETURNING expires_at',
        [row.task_id, input.runId, input.agentId, leaseToken, input.leaseSeconds],
      )
      const expiresAt = lease.rows[0]?.expires_at
      if (!expiresAt) throw new Error('Resumed lease did not return expires_at')
      return {
        resumed: true,
        workspaceId: row.workspace_id as WorkspaceId,
        missionId: row.mission_id as MissionId,
        taskId: row.task_id as TaskId,
        leaseToken,
        leaseExpiresAt: expiresAt.toISOString() as IsoTimestamp,
      }
    })
  }

  async listRunnableAgentRuns(input: RunnableAgentRunScope): Promise<readonly RunnableAgentRun[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new RangeError('limit must be an integer between 1 and 50')
    }
    const result = await this.pool.query<{
      workspace_id: string
      mission_id: string
      task_id: string
      run_id: string
      lease_token: string
    }>(
      'SELECT r.workspace_id, r.mission_id, r.task_id, r.id AS run_id, l.lease_token ' +
      'FROM agent_runs r JOIN task_leases l ON l.run_id = r.id AND l.task_id = r.task_id ' +
      'JOIN missions m ON m.id = r.mission_id AND m.workspace_id = r.workspace_id ' +
      'WHERE r.agent_id = $1 AND l.agent_id = $1 AND r.workspace_id = $2 AND m.project_id = $3 ' +
      'AND l.expires_at > NOW() ' +
      "AND r.status IN ('starting', 'running', 'waiting_tool') " +
      'ORDER BY r.created_at, r.id LIMIT $4',
      [input.agentId, input.workspaceId, input.projectId, input.limit],
    )
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id as WorkspaceId,
      missionId: row.mission_id as MissionId,
      taskId: row.task_id as TaskId,
      runId: row.run_id as RunId,
      agentId: input.agentId,
      leaseToken: row.lease_token,
    }))
  }

  async recoverExpiredLeases(
    limit: number,
    correlationId: CorrelationId,
  ): Promise<readonly TaskId[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('limit must be an integer between 1 and 100')
    }

    return withTransaction(this.pool, async (client) => {
      const expired = await client.query<ExpiredLeaseRow>(
        'SELECT m.workspace_id, m.project_id, t.mission_id, t.id AS task_id, ' +
        't.status AS task_status, t.attempt_count, t.max_attempts, ' +
        'r.id AS run_id, r.status AS run_status ' +
        'FROM task_leases l ' +
        'JOIN tasks t ON t.id = l.task_id ' +
        'JOIN missions m ON m.id = t.mission_id ' +
        'JOIN agent_runs r ON r.id = l.run_id ' +
        'WHERE l.expires_at <= NOW() ' +
        "AND t.status IN ('claimed', 'running', 'waiting_human') " +
        'ORDER BY l.expires_at ASC ' +
        'LIMIT $1 ' +
        'FOR UPDATE OF l, t SKIP LOCKED',
        [limit],
      )

      const recovered: TaskId[] = []
      for (const row of expired.rows) {
        const nextTaskStatus: TaskStatus = row.attempt_count >= row.max_attempts ? 'failed' : 'ready'
        const runWasTerminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(row.run_status)
        if (!runWasTerminal) {
          await client.query(
            "UPDATE agent_runs SET status = 'timed_out', finished_at = NOW(), updated_at = NOW(), " +
            "error = jsonb_build_object('code', 'lease_expired') WHERE id = $1",
            [row.run_id],
          )
        }
        await client.query(
          'UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1',
          [row.task_id, nextTaskStatus],
        )
        await client.query('DELETE FROM task_leases WHERE task_id = $1', [row.task_id])

        const workspaceId = row.workspace_id as WorkspaceId
        const projectId = row.project_id as ProjectId
        const missionId = row.mission_id as MissionId
        const taskId = row.task_id as TaskId
        const runId = row.run_id as RunId
        const actor = { kind: 'system', id: 'lease-reaper' } as const

        if (!runWasTerminal) {
          await appendDomainEvent(client, {
            type: 'run.status_changed',
            workspaceId,
            projectId,
            missionId,
            actor,
            correlationId,
            payload: {
              runId,
              from: row.run_status,
              to: 'timed_out',
              reason: 'task lease expired',
            },
          })
        }
        await appendDomainEvent(client, {
          type: 'task.status_changed',
          workspaceId,
          projectId,
          missionId,
          actor,
          correlationId,
          payload: {
            taskId,
            from: row.task_status,
            to: nextTaskStatus,
            reason: nextTaskStatus === 'ready'
              ? 'expired lease recovered for retry'
              : 'maximum attempts exhausted after lease expiry',
          },
        })
        recovered.push(taskId)
      }
      return recovered
    })
  }

  async completeTaskAndUnlockDependents(input: CompleteTaskInput): Promise<CompleteTaskResult> {
    return withTransaction(this.pool, async (client) => {
      const task = await client.query<{
        readonly project_id: string
        readonly status: TaskStatus
        readonly review_required: boolean
      }>(
        'SELECT m.project_id, t.status, t.review_required ' +
        'FROM tasks t JOIN missions m ON m.id = t.mission_id ' +
        'WHERE t.id = $1 AND t.mission_id = $2 AND m.workspace_id = $3 ' +
        "AND m.status IN ('running', 'reviewing') FOR UPDATE OF t",
        [input.taskId, input.missionId, input.workspaceId],
      )
      const row = task.rows[0]
      if (!row || row.status !== 'reviewing') {
        return { completed: false, reason: 'not_completable' }
      }

      const missingEvidence = await client.query<{ missing: boolean }>(
        'SELECT EXISTS (' +
        '  SELECT 1 FROM task_acceptance_criteria c ' +
        '  WHERE c.task_id = $1 AND c.required ' +
        '  AND (' +
        '    (cardinality(c.required_evidence_kinds) = 0 AND NOT EXISTS (' +
        '      SELECT 1 FROM evidence e WHERE e.acceptance_criterion_id = c.id ' +
        '      AND (e.expires_at IS NULL OR e.expires_at > NOW())' +
        '    )) ' +
        '    OR EXISTS (' +
        '      SELECT 1 FROM unnest(c.required_evidence_kinds) required_kind ' +
        '      WHERE NOT EXISTS (' +
        '        SELECT 1 FROM evidence e WHERE e.acceptance_criterion_id = c.id ' +
        '        AND e.kind = required_kind ' +
        '        AND (e.expires_at IS NULL OR e.expires_at > NOW())' +
        '      )' +
        '    )' +
        '  )' +
        ') AS missing',
        [input.taskId],
      )
      if (missingEvidence.rows[0]?.missing) {
        return { completed: false, reason: 'missing_evidence' }
      }

      if (row.review_required) {
        const approvedReview = await client.query(
          'SELECT 1 FROM task_submissions s ' +
          'JOIN reviews r ON r.submission_id = s.id ' +
          "WHERE s.task_id = $1 AND s.status = 'approved' AND r.status = 'approved' LIMIT 1",
          [input.taskId],
        )
        if (approvedReview.rows.length === 0) {
          return { completed: false, reason: 'missing_review' }
        }
      }

      const pendingIntegration = await client.query<{ status: string }>(
        'SELECT status FROM task_worktrees WHERE task_id = $1',
        [input.taskId],
      )
      if (pendingIntegration.rows[0] && pendingIntegration.rows[0].status !== 'integrated') {
        return { completed: false, reason: 'missing_integration' }
      }

      await client.query(
        "UPDATE tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1",
        [input.taskId],
      )
      const unlocked = await client.query<{ id: string }>(
        'UPDATE tasks child SET status = $3, updated_at = NOW() ' +
        'WHERE child.mission_id = $1 AND child.status = $4 ' +
        'AND EXISTS (' +
        '  SELECT 1 FROM task_dependencies direct ' +
        '  WHERE direct.task_id = child.id AND direct.depends_on_task_id = $2' +
        ') ' +
        'AND NOT EXISTS (' +
        '  SELECT 1 FROM task_dependencies d ' +
        '  JOIN tasks parent ON parent.id = d.depends_on_task_id ' +
        '  WHERE d.task_id = child.id AND d.required AND parent.status <> $5' +
        ') ' +
        'RETURNING child.id',
        [input.missionId, input.taskId, 'ready', 'blocked', 'completed'],
      )

      const projectId = row.project_id as ProjectId
      await appendDomainEvent(client, {
        type: 'task.status_changed',
        workspaceId: input.workspaceId,
        projectId,
        missionId: input.missionId,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: {
          taskId: input.taskId,
          from: 'reviewing',
          to: 'completed',
          reason: 'evidence and review gates passed',
        },
      })

      const unlockedTaskIds = unlocked.rows.map((item) => item.id as TaskId)
      for (const taskId of unlockedTaskIds) {
        await appendDomainEvent(client, {
          type: 'task.status_changed',
          workspaceId: input.workspaceId,
          projectId,
          missionId: input.missionId,
          actor: { kind: 'system', id: 'dependency-scheduler' },
          correlationId: input.correlationId,
          payload: {
            taskId,
            from: 'blocked',
            to: 'ready',
            reason: 'all required dependencies completed',
          },
        })
      }

      const mission = await client.query(
        "UPDATE missions SET status = 'reviewing', updated_at = NOW() " +
        "WHERE id = $1 AND status = 'running' " +
        "AND NOT EXISTS (SELECT 1 FROM tasks WHERE mission_id = $1 AND status <> 'completed') " +
        'RETURNING id',
        [input.missionId],
      )
      const missionReadyForReview = mission.rowCount === 1
      if (missionReadyForReview) {
        await appendDomainEvent(client, {
          type: 'mission.status_changed',
          workspaceId: input.workspaceId,
          projectId,
          missionId: input.missionId,
          actor: { kind: 'system', id: 'mission-gate' },
          correlationId: input.correlationId,
          payload: {
            from: 'running',
            to: 'reviewing',
            reason: 'all required tasks completed',
          },
        })
      }

      return {
        completed: true,
        unlockedTaskIds,
        missionReadyForReview,
      }
    })
  }
}

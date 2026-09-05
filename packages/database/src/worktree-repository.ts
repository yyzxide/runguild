import { randomUUID } from 'node:crypto'

import type {
  CorrelationId,
  IsoTimestamp,
  MissionId,
  ProjectId,
  TaskId,
  TaskWorktree,
  TaskWorktreeStatus,
  WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { appendDomainEvent } from './events.js'
import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

interface WorktreeRow {
  readonly task_id: string
  readonly workspace_id: string
  readonly mission_id: string
  readonly project_id: string
  readonly repository_path: string
  readonly worktree_path: string
  readonly branch_name: string
  readonly base_ref: string
  readonly base_commit: string
  readonly reconciliation_base_commit: string | null
  readonly head_commit: string | null
  readonly integrated_commit: string | null
  readonly status: TaskWorktreeStatus
  readonly generation: number
  readonly provision_token: string | null
  readonly provision_expires_at: Date | null
  readonly integration_token: string | null
  readonly integration_expires_at: Date | null
  readonly cleanup_token: string | null
  readonly cleanup_expires_at: Date | null
  readonly last_error: Readonly<Record<string, unknown>> | null
  readonly created_at: Date
  readonly updated_at: Date
}

const WORKTREE_COLUMNS =
  'task_id, workspace_id, mission_id, project_id, repository_path, worktree_path, ' +
  'branch_name, base_ref, base_commit, head_commit, integrated_commit, status, generation, ' +
  'reconciliation_base_commit, ' +
  'provision_token, provision_expires_at, integration_token, integration_expires_at, ' +
  'cleanup_token, cleanup_expires_at, ' +
  'last_error, created_at, updated_at'

function asWorktree(row: WorktreeRow): TaskWorktree {
  return {
    taskId: row.task_id as TaskId,
    workspaceId: row.workspace_id as WorkspaceId,
    missionId: row.mission_id as MissionId,
    projectId: row.project_id as ProjectId,
    repositoryPath: row.repository_path,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    ...(row.reconciliation_base_commit === null
      ? {}
      : { reconciliationBaseCommit: row.reconciliation_base_commit }),
    ...(row.head_commit === null ? {} : { headCommit: row.head_commit }),
    ...(row.integrated_commit === null ? {} : { integratedCommit: row.integrated_commit }),
    status: row.status,
    generation: row.generation,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    updatedAt: row.updated_at.toISOString() as IsoTimestamp,
  }
}

export interface ReserveTaskWorktreeInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly repositoryPath: string
  readonly worktreePath: string
  readonly branchName: string
  readonly baseRef: string
  readonly baseCommit: string
  readonly leaseSeconds?: number
}

export type ReserveTaskWorktreeResult =
  | {
      readonly kind: 'provision'
      readonly worktree: TaskWorktree
      readonly provisionToken: string
    }
  | {
      readonly kind: 'ready'
      readonly worktree: TaskWorktree
    }
  | {
      readonly kind: 'busy'
      readonly retryAfterMs: number
    }

export type ReserveWorktreeIntegrationResult =
  | {
      readonly kind: 'integrate'
      readonly worktree: TaskWorktree
      readonly integrationToken: string
    }
  | { readonly kind: 'integrated'; readonly worktree: TaskWorktree }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }

export type ReserveWorktreeCleanupResult =
  | {
      readonly kind: 'cleanup'
      readonly worktree: TaskWorktree
      readonly cleanupToken: string
    }
  | { readonly kind: 'removed'; readonly worktree: TaskWorktree }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }

function leaseSeconds(value: number | undefined): number {
  const seconds = value ?? 120
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3_600) {
    throw new RangeError('Worktree provision lease must be between 5 and 3600 seconds')
  }
  return seconds
}

function assertPath(value: string, label: string): void {
  if (!value.trim() || value.length > 4_096 || value.includes('\0')) {
    throw new Error(label + ' is invalid')
  }
}

function sameSemantics(row: WorktreeRow, input: ReserveTaskWorktreeInput): boolean {
  return row.workspace_id === input.workspaceId
    && row.mission_id === input.missionId
    && row.project_id === input.projectId
    && row.repository_path === input.repositoryPath
    && row.worktree_path === input.worktreePath
    && row.branch_name === input.branchName
    && row.base_ref === input.baseRef
}

export class TaskWorktreeRepository {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveTaskWorktreeInput): Promise<ReserveTaskWorktreeResult> {
    const seconds = leaseSeconds(input.leaseSeconds)
    assertPath(input.repositoryPath, 'Repository path')
    assertPath(input.worktreePath, 'Worktree path')
    if (!input.branchName.trim() || !input.baseRef.trim() || !/^[0-9a-f]{40,64}$/.test(input.baseCommit)) {
      throw new Error('Worktree branch, base ref, or base commit is invalid')
    }
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<WorktreeRow>(
        'SELECT ' + WORKTREE_COLUMNS + ' FROM task_worktrees WHERE task_id = $1 FOR UPDATE',
        [input.taskId],
      )
      const row = existing.rows[0]
      if (!row) {
        const provisionToken = 'worktree_provision_' + randomUUID()
        const inserted = await client.query<WorktreeRow>(
          'INSERT INTO task_worktrees ' +
          '(task_id, workspace_id, mission_id, project_id, repository_path, worktree_path, ' +
          'branch_name, base_ref, base_commit, provision_token, provision_expires_at) ' +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + ($11 * INTERVAL '1 second')) " +
          'RETURNING ' + WORKTREE_COLUMNS,
          [
            input.taskId,
            input.workspaceId,
            input.missionId,
            input.projectId,
            input.repositoryPath,
            input.worktreePath,
            input.branchName,
            input.baseRef,
            input.baseCommit,
            provisionToken,
            seconds,
          ],
        )
        const created = inserted.rows[0]
        if (!created) throw new Error('Task Worktree reservation was not persisted')
        return { kind: 'provision', worktree: asWorktree(created), provisionToken }
      }
      if (!sameSemantics(row, input)) {
        throw new Error('Task Worktree was reserved with different repository semantics')
      }
      // The branch named by baseRef may advance between Run attempts. The
      // persisted Worktree row owns the immutable Task baseline; replay must
      // reconcile that exact baseCommit instead of treating the moving ref as
      // a new reservation.
      if (['ready', 'committed', 'integrated'].includes(row.status)) {
        return { kind: 'ready', worktree: asWorktree(row) }
      }
      if (row.status === 'provisioning'
          && row.provision_expires_at
          && row.provision_expires_at.getTime() > Date.now()) {
        return {
          kind: 'busy',
          retryAfterMs: Math.max(100, row.provision_expires_at.getTime() - Date.now()),
        }
      }
      if (!['provisioning', 'failed', 'removed'].includes(row.status)) {
        return { kind: 'busy', retryAfterMs: 1_000 }
      }

      const provisionToken = 'worktree_provision_' + randomUUID()
      const renewed = await client.query<WorktreeRow>(
        'UPDATE task_worktrees SET status = $2, generation = generation + 1, ' +
        "provision_token = $3, provision_expires_at = NOW() + ($4 * INTERVAL '1 second'), " +
        'last_error = NULL, removed_at = NULL, updated_at = NOW() WHERE task_id = $1 ' +
        'RETURNING ' + WORKTREE_COLUMNS,
        [input.taskId, 'provisioning', provisionToken, seconds],
      )
      const reserved = renewed.rows[0]
      if (!reserved) throw new Error('Task Worktree reservation disappeared')
      return { kind: 'provision', worktree: asWorktree(reserved), provisionToken }
    })
  }

  async markReady(input: {
    readonly taskId: TaskId
    readonly provisionToken: string
    readonly headCommit: string
  }): Promise<TaskWorktree> {
    if (!/^[0-9a-f]{40,64}$/.test(input.headCommit)) throw new Error('Invalid Worktree HEAD commit')
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'ready', head_commit = $3, " +
      'provision_token = NULL, provision_expires_at = NULL, last_error = NULL, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status = 'provisioning' AND provision_token = $2 " +
      'RETURNING ' + WORKTREE_COLUMNS,
      [input.taskId, input.provisionToken, input.headCommit],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Task Worktree provision token is stale')
    return asWorktree(row)
  }

  async markFailed(input: {
    readonly taskId: TaskId
    readonly provisionToken: string
    readonly error: Readonly<Record<string, unknown>>
  }): Promise<TaskWorktree | null> {
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'failed', provision_token = NULL, " +
      'provision_expires_at = NULL, last_error = $3::jsonb, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status = 'provisioning' AND provision_token = $2 " +
      'RETURNING ' + WORKTREE_COLUMNS,
      [input.taskId, input.provisionToken, canonicalJson(input.error)],
    )
    return result.rows[0] ? asWorktree(result.rows[0]) : null
  }

  async recordCommit(input: {
    readonly taskId: TaskId
    readonly headCommit: string
  }): Promise<TaskWorktree> {
    if (!/^[0-9a-f]{40,64}$/.test(input.headCommit)) throw new Error('Invalid Worktree commit')
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'committed', head_commit = $2, " +
      'base_commit = COALESCE(reconciliation_base_commit, base_commit), ' +
      'reconciliation_base_commit = NULL, last_error = NULL, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status IN ('ready', 'committed') RETURNING " + WORKTREE_COLUMNS,
      [input.taskId, input.headCommit],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Task Worktree is not ready to record a commit')
    return asWorktree(row)
  }

  async recordUnchangedIntegration(input: {
    readonly taskId: TaskId
    readonly headCommit: string
  }): Promise<TaskWorktree> {
    if (!/^[0-9a-f]{40,64}$/.test(input.headCommit)) throw new Error('Invalid unchanged Worktree commit')
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'integrated', integrated_commit = $2, integrated_at = NOW(), " +
      'last_error = NULL, updated_at = NOW() WHERE task_id = $1 AND status = $3 ' +
      'AND base_commit = $2 AND head_commit = $2 RETURNING ' + WORKTREE_COLUMNS,
      [input.taskId, input.headCommit, 'ready'],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Task Worktree is not a clean unchanged baseline')
    return asWorktree(row)
  }

  async markInvalid(input: {
    readonly taskId: TaskId
    readonly error: Readonly<Record<string, unknown>>
  }): Promise<TaskWorktree | null> {
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'failed', provision_token = NULL, " +
      'provision_expires_at = NULL, last_error = $2::jsonb, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status IN ('ready', 'committed') RETURNING " + WORKTREE_COLUMNS,
      [input.taskId, canonicalJson(input.error)],
    )
    return result.rows[0] ? asWorktree(result.rows[0]) : null
  }

  async listApprovedPendingIntegration(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly limit: number
  }): Promise<readonly TaskWorktree[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RangeError('Integration query limit must be between 1 and 1000')
    }
    const result = await this.pool.query<WorktreeRow>(
      'SELECT ' + WORKTREE_COLUMNS.split(', ').map((column) => 'w.' + column).join(', ') + ' ' +
      'FROM task_worktrees w JOIN tasks t ON t.id = w.task_id ' +
      "WHERE w.status IN ('committed', 'integrating') AND t.status = 'reviewing' " +
      'AND (NOT t.review_required OR EXISTS (' +
      '  SELECT 1 FROM task_submissions s JOIN reviews r ON r.submission_id = s.id ' +
      "  WHERE s.task_id = w.task_id AND s.status = 'approved' AND r.status = 'approved'" +
      ')) ' +
      'AND w.workspace_id = $1 AND w.project_id = $2 ' +
      'ORDER BY w.updated_at, w.task_id LIMIT $3',
      [input.workspaceId, input.projectId, input.limit],
    )
    return result.rows.map(asWorktree)
  }

  async reserveIntegration(input: {
    readonly taskId: TaskId
    readonly leaseSeconds?: number
  }): Promise<ReserveWorktreeIntegrationResult> {
    const seconds = leaseSeconds(input.leaseSeconds)
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<WorktreeRow>(
        'SELECT ' + WORKTREE_COLUMNS + ' FROM task_worktrees WHERE task_id = $1 FOR UPDATE',
        [input.taskId],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Task Worktree does not exist')
      if (row.status === 'integrated') return { kind: 'integrated', worktree: asWorktree(row) }
      if (row.status === 'integrating'
          && row.integration_expires_at
          && row.integration_expires_at.getTime() > Date.now()) {
        return {
          kind: 'busy',
          retryAfterMs: Math.max(100, row.integration_expires_at.getTime() - Date.now()),
        }
      }
      if (row.status !== 'committed' && row.status !== 'integrating') {
        throw new Error('Task Worktree is not committed for integration')
      }
      const integrationToken = 'worktree_integration_' + randomUUID()
      const reserved = await client.query<WorktreeRow>(
        "UPDATE task_worktrees SET status = 'integrating', integration_token = $2, " +
        "integration_expires_at = NOW() + ($3 * INTERVAL '1 second'), last_error = NULL, " +
        'updated_at = NOW() WHERE task_id = $1 RETURNING ' + WORKTREE_COLUMNS,
        [input.taskId, integrationToken, seconds],
      )
      const claimed = reserved.rows[0]
      if (!claimed) throw new Error('Task Worktree integration reservation disappeared')
      return { kind: 'integrate', worktree: asWorktree(claimed), integrationToken }
    })
  }

  async markIntegrated(input: {
    readonly taskId: TaskId
    readonly integrationToken: string
    readonly integratedCommit: string
  }): Promise<TaskWorktree> {
    if (!/^[0-9a-f]{40,64}$/.test(input.integratedCommit)) throw new Error('Invalid integrated commit')
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'integrated', integrated_commit = $3, " +
      'integration_token = NULL, integration_expires_at = NULL, integrated_at = NOW(), ' +
      'last_error = NULL, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status = 'integrating' AND integration_token = $2 " +
      'RETURNING ' + WORKTREE_COLUMNS,
      [input.taskId, input.integrationToken, input.integratedCommit],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Task Worktree integration token is stale')
    return asWorktree(row)
  }

  async markIntegrationFailed(input: {
    readonly taskId: TaskId
    readonly integrationToken: string
    readonly error: Readonly<Record<string, unknown>>
  }): Promise<TaskWorktree | null> {
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'committed', integration_token = NULL, " +
      'integration_expires_at = NULL, last_error = $3::jsonb, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status = 'integrating' AND integration_token = $2 " +
      'RETURNING ' + WORKTREE_COLUMNS,
      [input.taskId, input.integrationToken, canonicalJson(input.error)],
    )
    return result.rows[0] ? asWorktree(result.rows[0]) : null
  }

  async markIntegrationConflict(input: {
    readonly taskId: TaskId
    readonly integrationToken: string
    readonly reconciliationBaseCommit: string
    readonly error: Readonly<Record<string, unknown>>
    readonly correlationId: CorrelationId
  }): Promise<{ readonly worktree: TaskWorktree; readonly taskStatus: 'ready' | 'failed' }> {
    if (!/^[0-9a-f]{40,64}$/.test(input.reconciliationBaseCommit)) {
      throw new Error('Invalid Integration reconciliation base commit')
    }
    return withTransaction(this.pool, async (client) => {
      const scoped = await client.query<WorktreeRow & {
        readonly project_id: string
        readonly mission_status: string
        readonly task_status: string
        readonly attempt_count: number
        readonly max_attempts: number
      }>(
        'SELECT ' + WORKTREE_COLUMNS.split(', ').map((column) => 'w.' + column).join(', ') + ', ' +
        'm.status AS mission_status, t.status AS task_status, t.attempt_count, t.max_attempts ' +
        'FROM task_worktrees w JOIN tasks t ON t.id = w.task_id ' +
        'JOIN missions m ON m.id = w.mission_id ' +
        'WHERE w.task_id = $1 FOR UPDATE OF w, t',
        [input.taskId],
      )
      const row = scoped.rows[0]
      if (!row || row.status !== 'integrating' || row.integration_token !== input.integrationToken) {
        throw new Error('Task Worktree integration token is stale')
      }
      if (!['running', 'reviewing'].includes(row.mission_status) || row.task_status !== 'reviewing') {
        throw new Error('Task is not awaiting an approved Integration')
      }
      const gate = await client.query<{ readonly id: string }>(
        'SELECT s.id FROM task_submissions s JOIN reviews r ON r.submission_id = s.id ' +
        "WHERE s.task_id = $1 AND s.status = 'approved' AND r.status = 'approved' " +
        'FOR UPDATE OF s, r',
        [input.taskId],
      )
      const submission = gate.rows[0]
      if (!submission) throw new Error('Approved Integration gate disappeared')

      const taskStatus = row.attempt_count < row.max_attempts ? 'ready' : 'failed'
      await client.query(
        "UPDATE task_submissions SET status = 'superseded', updated_at = NOW() " +
        "WHERE id = $1 AND status = 'approved'",
        [submission.id],
      )
      await client.query(
        'UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1 AND status = $3',
        [input.taskId, taskStatus, 'reviewing'],
      )
      const updated = await client.query<WorktreeRow>(
        "UPDATE task_worktrees SET status = 'ready', reconciliation_base_commit = $3, " +
        'integration_token = NULL, integration_expires_at = NULL, last_error = $4::jsonb, ' +
        'updated_at = NOW() WHERE task_id = $1 AND status = $5 AND integration_token = $2 ' +
        'RETURNING ' + WORKTREE_COLUMNS,
        [
          input.taskId,
          input.integrationToken,
          input.reconciliationBaseCommit,
          canonicalJson(input.error),
          'integrating',
        ],
      )
      const worktree = updated.rows[0]
      if (!worktree) throw new Error('Task Worktree Integration conflict transition was not persisted')
      await appendDomainEvent(client, {
        type: 'task.status_changed',
        workspaceId: row.workspace_id as WorkspaceId,
        projectId: row.project_id as ProjectId,
        missionId: row.mission_id as MissionId,
        actor: { kind: 'system', id: 'git-integration-gate' },
        correlationId: input.correlationId,
        payload: {
          taskId: input.taskId,
          from: 'reviewing',
          to: taskStatus,
          reason: taskStatus === 'ready'
            ? 'Integration conflict requires a new Builder commit and independent Review'
            : 'Integration conflict requires human retry because the Task attempt budget is exhausted',
        },
      })
      return { worktree: asWorktree(worktree), taskStatus }
    })
  }

  async listCompletedPendingCleanup(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly limit: number
  }): Promise<readonly TaskWorktree[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RangeError('Cleanup query limit must be between 1 and 1000')
    }
    const result = await this.pool.query<WorktreeRow>(
      'SELECT ' + WORKTREE_COLUMNS.split(', ').map((column) => 'w.' + column).join(', ') + ' ' +
      'FROM task_worktrees w JOIN tasks t ON t.id = w.task_id ' +
      "WHERE w.status IN ('integrated', 'cleanup_pending') AND t.status = 'completed' " +
      'AND w.workspace_id = $1 AND w.project_id = $2 ' +
      'ORDER BY w.updated_at, w.task_id LIMIT $3',
      [input.workspaceId, input.projectId, input.limit],
    )
    return result.rows.map(asWorktree)
  }

  async reserveCleanup(input: {
    readonly taskId: TaskId
    readonly leaseSeconds?: number
  }): Promise<ReserveWorktreeCleanupResult> {
    const seconds = leaseSeconds(input.leaseSeconds)
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<WorktreeRow>(
        'SELECT ' + WORKTREE_COLUMNS + ' FROM task_worktrees WHERE task_id = $1 FOR UPDATE',
        [input.taskId],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Task Worktree does not exist')
      if (row.status === 'removed') return { kind: 'removed', worktree: asWorktree(row) }
      if (row.status === 'cleanup_pending'
          && row.cleanup_expires_at
          && row.cleanup_expires_at.getTime() > Date.now()) {
        return {
          kind: 'busy',
          retryAfterMs: Math.max(100, row.cleanup_expires_at.getTime() - Date.now()),
        }
      }
      if (row.status !== 'integrated' && row.status !== 'cleanup_pending') {
        throw new Error('Task Worktree is not integrated for cleanup')
      }
      const cleanupToken = 'worktree_cleanup_' + randomUUID()
      const reserved = await client.query<WorktreeRow>(
        "UPDATE task_worktrees SET status = 'cleanup_pending', cleanup_token = $2, " +
        "cleanup_expires_at = NOW() + ($3 * INTERVAL '1 second'), last_error = NULL, " +
        'updated_at = NOW() WHERE task_id = $1 RETURNING ' + WORKTREE_COLUMNS,
        [input.taskId, cleanupToken, seconds],
      )
      const claimed = reserved.rows[0]
      if (!claimed) throw new Error('Task Worktree cleanup reservation disappeared')
      return { kind: 'cleanup', worktree: asWorktree(claimed), cleanupToken }
    })
  }

  async markRemoved(input: {
    readonly taskId: TaskId
    readonly cleanupToken: string
  }): Promise<TaskWorktree> {
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'removed', cleanup_token = NULL, cleanup_expires_at = NULL, " +
      'removed_at = NOW(), last_error = NULL, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status = 'cleanup_pending' AND cleanup_token = $2 " +
      'RETURNING ' + WORKTREE_COLUMNS,
      [input.taskId, input.cleanupToken],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Task Worktree cleanup token is stale')
    return asWorktree(row)
  }

  async markCleanupFailed(input: {
    readonly taskId: TaskId
    readonly cleanupToken: string
    readonly error: Readonly<Record<string, unknown>>
  }): Promise<TaskWorktree | null> {
    const result = await this.pool.query<WorktreeRow>(
      "UPDATE task_worktrees SET status = 'integrated', cleanup_token = NULL, cleanup_expires_at = NULL, " +
      'last_error = $3::jsonb, updated_at = NOW() ' +
      "WHERE task_id = $1 AND status = 'cleanup_pending' AND cleanup_token = $2 " +
      'RETURNING ' + WORKTREE_COLUMNS,
      [input.taskId, input.cleanupToken, canonicalJson(input.error)],
    )
    return result.rows[0] ? asWorktree(result.rows[0]) : null
  }

  async get(taskId: TaskId): Promise<TaskWorktree | null> {
    const result = await this.pool.query<WorktreeRow>(
      'SELECT ' + WORKTREE_COLUMNS + ' FROM task_worktrees WHERE task_id = $1',
      [taskId],
    )
    return result.rows[0] ? asWorktree(result.rows[0]) : null
  }
}

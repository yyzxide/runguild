import { createHash, randomUUID } from 'node:crypto'

import type {
  IsoTimestamp,
  MissionId,
  ProjectId,
  RunId,
  TaskId,
  WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

export type WorktreeSetupStatus = 'running' | 'succeeded' | 'failed'

export interface WorktreeSetupCommandResult {
  readonly commandIndex: number
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly stdoutHash: string
  readonly stderrHash: string
}

export interface WorktreeSetupSnapshot {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly worktreeGeneration: number
  readonly commandsHash: string
  readonly commands: readonly (readonly string[])[]
  readonly status: WorktreeSetupStatus
  readonly attempt: number
  readonly results: readonly WorktreeSetupCommandResult[]
  readonly error?: Readonly<Record<string, unknown>>
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
  readonly startedAt: IsoTimestamp
  readonly finishedAt?: IsoTimestamp
}

interface SetupRow {
  readonly id: string
  readonly workspace_id: string
  readonly mission_id: string
  readonly project_id: string
  readonly task_id: string
  readonly run_id: string
  readonly worktree_generation: number
  readonly commands_hash: string
  readonly commands: readonly (readonly string[])[]
  readonly status: WorktreeSetupStatus
  readonly attempt: number
  readonly lease_token: string | null
  readonly lease_expires_at: Date | null
  readonly results: readonly WorktreeSetupCommandResult[]
  readonly error: Readonly<Record<string, unknown>> | null
  readonly created_at: Date
  readonly updated_at: Date
  readonly started_at: Date
  readonly finished_at: Date | null
}

const SETUP_COLUMNS =
  'id, workspace_id, mission_id, project_id, task_id, run_id, worktree_generation, ' +
  'commands_hash, commands, status, attempt, lease_token, lease_expires_at, results, error, ' +
  'created_at, updated_at, started_at, finished_at'

function asSnapshot(row: SetupRow): WorktreeSetupSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    missionId: row.mission_id as MissionId,
    projectId: row.project_id as ProjectId,
    taskId: row.task_id as TaskId,
    runId: row.run_id as RunId,
    worktreeGeneration: row.worktree_generation,
    commandsHash: row.commands_hash,
    commands: row.commands,
    status: row.status,
    attempt: row.attempt,
    results: row.results,
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    updatedAt: row.updated_at.toISOString() as IsoTimestamp,
    startedAt: row.started_at.toISOString() as IsoTimestamp,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at.toISOString() as IsoTimestamp }),
  }
}

function setupLeaseSeconds(value: number | undefined): number {
  const seconds = value ?? 60
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3_600) {
    throw new RangeError('Worktree setup lease must be between 5 and 3600 seconds')
  }
  return seconds
}

function validateCommands(commands: readonly (readonly string[])[]): void {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20
      || commands.some((command) => !Array.isArray(command)
        || command.length < 1 || command.length > 30
        || command.some((part) => typeof part !== 'string' || !part.trim() || part.length > 1_000))) {
    throw new Error('Worktree setup commands must contain 1-20 non-empty argument arrays')
  }
}

function commandsHash(commands: readonly (readonly string[])[]): string {
  return createHash('sha256').update(canonicalJson(commands)).digest('hex')
}

function validateResults(results: readonly WorktreeSetupCommandResult[]): void {
  if (!Array.isArray(results) || results.length > 20 || results.some((result, index) =>
    result.commandIndex !== index
    || !Array.isArray(result.argv) || result.argv.length < 1 || result.argv.length > 30
    || !Number.isInteger(result.durationMs) || result.durationMs < 0
    || (result.exitCode !== null && !Number.isInteger(result.exitCode))
    || !/^[0-9a-f]{64}$/.test(result.stdoutHash)
    || !/^[0-9a-f]{64}$/.test(result.stderrHash))) {
    throw new Error('Worktree setup results are invalid')
  }
}

export type ReserveWorktreeSetupResult =
  | { readonly kind: 'execute'; readonly setup: WorktreeSetupSnapshot; readonly leaseToken: string }
  | { readonly kind: 'succeeded'; readonly setup: WorktreeSetupSnapshot; readonly reused: boolean }
  | { readonly kind: 'failed'; readonly setup: WorktreeSetupSnapshot }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }

export class WorktreeSetupRepository {
  constructor(private readonly pool: Pool) {}

  async reserve(input: {
    readonly workspaceId: WorkspaceId
    readonly missionId: MissionId
    readonly projectId: ProjectId
    readonly taskId: TaskId
    readonly runId: RunId
    readonly worktreeGeneration: number
    readonly commands: readonly (readonly string[])[]
    readonly leaseSeconds?: number
  }): Promise<ReserveWorktreeSetupResult> {
    validateCommands(input.commands)
    const seconds = setupLeaseSeconds(input.leaseSeconds)
    const hash = commandsHash(input.commands)
    return withTransaction(this.pool, async (client) => {
      const scope = await client.query<{ readonly generation: number; readonly status: string }>(
        'SELECT worktree.generation, worktree.status FROM task_worktrees worktree ' +
        'JOIN agent_runs run ON run.task_id = worktree.task_id AND run.id = $5 ' +
        'AND run.workspace_id = worktree.workspace_id AND run.mission_id = worktree.mission_id ' +
        'WHERE worktree.workspace_id = $1 AND worktree.mission_id = $2 ' +
        'AND worktree.project_id = $3 AND worktree.task_id = $4 FOR UPDATE OF worktree',
        [input.workspaceId, input.missionId, input.projectId, input.taskId, input.runId],
      )
      const worktree = scope.rows[0]
      if (!worktree || worktree.generation !== input.worktreeGeneration) {
        throw new Error('Worktree setup scope or generation does not match the active Run')
      }

      const succeeded = await client.query<SetupRow>(
        'SELECT ' + SETUP_COLUMNS + ' FROM task_worktree_setups WHERE task_id = $1 ' +
        "AND worktree_generation = $2 AND commands_hash = $3 AND status = 'succeeded' " +
        'ORDER BY updated_at DESC LIMIT 1',
        [input.taskId, input.worktreeGeneration, hash],
      )
      if (succeeded.rows[0]) {
        return { kind: 'succeeded', setup: asSnapshot(succeeded.rows[0]), reused: true }
      }
      if (worktree.status !== 'ready') {
        throw new Error('New Worktree setup commands can run only while the Task Worktree is ready')
      }

      const existing = await client.query<SetupRow>(
        'SELECT ' + SETUP_COLUMNS + ' FROM task_worktree_setups ' +
        'WHERE run_id = $1 AND commands_hash = $2 FOR UPDATE',
        [input.runId, hash],
      )
      const row = existing.rows[0]
      if (row?.status === 'succeeded') {
        return { kind: 'succeeded', setup: asSnapshot(row), reused: false }
      }
      if (row?.status === 'failed') return { kind: 'failed', setup: asSnapshot(row) }
      if (row?.lease_expires_at && row.lease_expires_at.getTime() > Date.now()) {
        return {
          kind: 'busy',
          retryAfterMs: Math.max(100, row.lease_expires_at.getTime() - Date.now()),
        }
      }
      if (row && row.attempt >= 3) {
        const exhausted = await client.query<SetupRow>(
          "UPDATE task_worktree_setups SET status = 'failed', lease_token = NULL, " +
          "lease_expires_at = NULL, error = '{\"code\":\"lease_expired\",\"message\":\"Setup retry budget exhausted after an expired lease\"}'::jsonb, " +
          'finished_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING ' + SETUP_COLUMNS,
          [row.id],
        )
        const failed = exhausted.rows[0]
        if (!failed) throw new Error('Expired Worktree setup disappeared')
        return { kind: 'failed', setup: asSnapshot(failed) }
      }

      const leaseToken = 'worktree_setup_' + randomUUID()
      if (row) {
        const recovered = await client.query<SetupRow>(
          "UPDATE task_worktree_setups SET attempt = attempt + 1, lease_token = $2, " +
          "lease_expires_at = NOW() + ($3 * INTERVAL '1 second'), results = '[]'::jsonb, " +
          'updated_at = NOW(), started_at = NOW() WHERE id = $1 RETURNING ' + SETUP_COLUMNS,
          [row.id, leaseToken, seconds],
        )
        const setup = recovered.rows[0]
        if (!setup) throw new Error('Worktree setup recovery reservation disappeared')
        return { kind: 'execute', setup: asSnapshot(setup), leaseToken }
      }

      const id = 'worktree_setup_' + randomUUID()
      const inserted = await client.query<SetupRow>(
        'INSERT INTO task_worktree_setups ' +
        '(id, workspace_id, mission_id, project_id, task_id, run_id, worktree_generation, ' +
        'commands_hash, commands, status, lease_token, lease_expires_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'running', $10, " +
        "NOW() + ($11 * INTERVAL '1 second')) RETURNING " + SETUP_COLUMNS,
        [
          id,
          input.workspaceId,
          input.missionId,
          input.projectId,
          input.taskId,
          input.runId,
          input.worktreeGeneration,
          hash,
          canonicalJson(input.commands),
          leaseToken,
          seconds,
        ],
      )
      const setup = inserted.rows[0]
      if (!setup) throw new Error('Worktree setup reservation was not persisted')
      return { kind: 'execute', setup: asSnapshot(setup), leaseToken }
    })
  }

  async renew(input: {
    readonly setupId: string
    readonly leaseToken: string
    readonly leaseSeconds?: number
  }): Promise<boolean> {
    const seconds = setupLeaseSeconds(input.leaseSeconds)
    const result = await this.pool.query(
      "UPDATE task_worktree_setups SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second'), " +
      "updated_at = NOW() WHERE id = $1 AND status = 'running' AND lease_token = $2",
      [input.setupId, input.leaseToken, seconds],
    )
    return (result.rowCount ?? 0) === 1
  }

  async markSucceeded(input: {
    readonly setupId: string
    readonly leaseToken: string
    readonly results: readonly WorktreeSetupCommandResult[]
  }): Promise<WorktreeSetupSnapshot> {
    validateResults(input.results)
    const result = await this.pool.query<SetupRow>(
      "UPDATE task_worktree_setups SET status = 'succeeded', lease_token = NULL, " +
      'lease_expires_at = NULL, results = $3::jsonb, finished_at = NOW(), updated_at = NOW() ' +
      "WHERE id = $1 AND status = 'running' AND lease_token = $2 RETURNING " + SETUP_COLUMNS,
      [input.setupId, input.leaseToken, canonicalJson(input.results)],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Worktree setup lease token is stale')
    return asSnapshot(row)
  }

  async markFailed(input: {
    readonly setupId: string
    readonly leaseToken: string
    readonly results: readonly WorktreeSetupCommandResult[]
    readonly error: Readonly<Record<string, unknown>>
  }): Promise<WorktreeSetupSnapshot | null> {
    validateResults(input.results)
    const result = await this.pool.query<SetupRow>(
      "UPDATE task_worktree_setups SET status = 'failed', lease_token = NULL, " +
      'lease_expires_at = NULL, results = $3::jsonb, error = $4::jsonb, ' +
      "finished_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'running' " +
      'AND lease_token = $2 RETURNING ' + SETUP_COLUMNS,
      [input.setupId, input.leaseToken, canonicalJson(input.results), canonicalJson(input.error)],
    )
    return result.rows[0] ? asSnapshot(result.rows[0]) : null
  }

  async listRecentForProject(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly limit?: number
  }): Promise<readonly WorktreeSetupSnapshot[]> {
    const limit = input.limit ?? 10
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Worktree setup query limit must be between 1 and 100')
    }
    const result = await this.pool.query<SetupRow>(
      'SELECT ' + SETUP_COLUMNS + ' FROM task_worktree_setups ' +
      'WHERE workspace_id = $1 AND project_id = $2 ORDER BY updated_at DESC, id LIMIT $3',
      [input.workspaceId, input.projectId, limit],
    )
    return result.rows.map(asSnapshot)
  }
}

import type { ProjectId, UserId, WorkspaceId } from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { withTransaction } from './transaction.js'

export type ProjectLifecycleAction =
  | { readonly action: 'rename'; readonly name: string }
  | { readonly action: 'archive' }
  | { readonly action: 'restore' }

export interface ProjectLifecycleState {
  readonly id: ProjectId
  readonly name: string
  readonly role: 'owner'
  readonly archivedAt: string | null
}

export class ProjectLifecycleError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message)
  }
}

interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly archived_at: Date | null
}

async function requireOwner(
  client: PoolClient,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  actorId: UserId,
): Promise<ProjectRow> {
  const result = await client.query<ProjectRow>(
    'SELECT project.id, project.name, project.archived_at FROM projects project ' +
    'JOIN project_memberships membership ON membership.workspace_id = project.workspace_id ' +
    'AND membership.project_id = project.id AND membership.user_id = $3 ' +
    "AND membership.role = 'owner' " +
    'WHERE project.workspace_id = $1 AND project.id = $2 FOR UPDATE OF project',
    [workspaceId, projectId, actorId],
  )
  if (!result.rows[0]) {
    throw new ProjectLifecycleError('project_owner_required', '只有工作区 Owner 可以修改或归档工作区', 403)
  }
  return result.rows[0]
}

function projectState(row: ProjectRow): ProjectLifecycleState {
  return {
    id: row.id as ProjectId,
    name: row.name,
    role: 'owner',
    archivedAt: row.archived_at?.toISOString() ?? null,
  }
}

function projectName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 200) {
    throw new ProjectLifecycleError('project_name_invalid', '工作区名称必须是 1 至 200 个字符')
  }
  return name
}

export class ProjectLifecycleRepository {
  constructor(private readonly pool: Pool) {}

  async update(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly actorId: UserId
    readonly change: ProjectLifecycleAction
  }): Promise<ProjectLifecycleState> {
    const nextName = input.change.action === 'rename' ? projectName(input.change.name) : null
    return withTransaction(this.pool, async (client) => {
      const current = await requireOwner(client, input.workspaceId, input.projectId, input.actorId)

      if (input.change.action === 'rename') {
        if (current.archived_at) {
          throw new ProjectLifecycleError('project_archived', '请先恢复工作区，再修改名称', 409)
        }
        if (current.name === nextName) return projectState(current)
        const renamed = await client.query<ProjectRow>(
          'UPDATE projects SET name = $3, updated_at = NOW() ' +
          'WHERE workspace_id = $1 AND id = $2 RETURNING id, name, archived_at',
          [input.workspaceId, input.projectId, nextName],
        )
        await client.query(
          'INSERT INTO project_lifecycle_events ' +
          '(workspace_id, project_id, actor_id, kind, previous_name, next_name) ' +
          "VALUES ($1, $2, $3, 'renamed', $4, $5)",
          [input.workspaceId, input.projectId, input.actorId, current.name, nextName],
        )
        return projectState(renamed.rows[0]!)
      }

      if (input.change.action === 'restore') {
        if (!current.archived_at) return projectState(current)
        const restored = await client.query<ProjectRow>(
          'UPDATE projects SET archived_at = NULL, archived_by = NULL, updated_at = NOW() ' +
          'WHERE workspace_id = $1 AND id = $2 RETURNING id, name, archived_at',
          [input.workspaceId, input.projectId],
        )
        await client.query(
          'INSERT INTO project_lifecycle_events (workspace_id, project_id, actor_id, kind) ' +
          "VALUES ($1, $2, $3, 'restored')",
          [input.workspaceId, input.projectId, input.actorId],
        )
        return projectState(restored.rows[0]!)
      }

      if (current.archived_at) return projectState(current)
      const activity = await client.query<{
        readonly active_missions: boolean
        readonly active_evaluations: boolean
        readonly active_workers: boolean
      }>(
        'SELECT ' +
        'EXISTS (SELECT 1 FROM missions WHERE workspace_id = $1 AND project_id = $2 ' +
        "AND status NOT IN ('completed', 'failed', 'cancelled')) AS active_missions, " +
        'EXISTS (SELECT 1 FROM evaluation_experiments WHERE workspace_id = $1 AND project_id = $2 ' +
        "AND status IN ('queued', 'running')) AS active_evaluations, " +
        'EXISTS (SELECT 1 FROM worker_instances WHERE workspace_id = $1 AND project_id = $2 ' +
        "AND status = 'running' AND expires_at > NOW()) AS active_workers",
        [input.workspaceId, input.projectId],
      )
      const state = activity.rows[0]
      if (state?.active_missions) {
        throw new ProjectLifecycleError('project_has_active_missions', '请先完成或取消所有未结束的 Mission', 409)
      }
      if (state?.active_evaluations) {
        throw new ProjectLifecycleError('project_has_active_evaluations', '请先等待或取消排队和运行中的评测实验', 409)
      }
      if (state?.active_workers) {
        throw new ProjectLifecycleError('project_has_active_workers', '请先停止该工作区的 Agent 与 Integration Worker', 409)
      }

      const archived = await client.query<ProjectRow>(
        'UPDATE projects SET archived_at = NOW(), archived_by = $3, updated_at = NOW() ' +
        'WHERE workspace_id = $1 AND id = $2 RETURNING id, name, archived_at',
        [input.workspaceId, input.projectId, input.actorId],
      )
      await client.query(
        'INSERT INTO project_lifecycle_events (workspace_id, project_id, actor_id, kind) ' +
        "VALUES ($1, $2, $3, 'archived')",
        [input.workspaceId, input.projectId, input.actorId],
      )
      return projectState(archived.rows[0]!)
    })
  }
}

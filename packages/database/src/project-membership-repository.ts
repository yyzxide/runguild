import type { ProjectId, UserId, WorkspaceId } from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import type { UserRole } from './authentication-repository.js'
import { withTransaction } from './transaction.js'

export interface ProjectMember {
  readonly userId: UserId
  readonly displayName: string
  readonly role: UserRole
  readonly joinedAt: string
}

export interface ProjectAccess {
  readonly role: UserRole
  readonly archivedAt: string | null
}

export type ProjectResourceKind =
  | 'mission'
  | 'run'
  | 'artifact'
  | 'artifact_version'
  | 'conversation'
  | 'planning_request'
  | 'approval'
  | 'agent'
  | 'review'
  | 'submission'

export class ProjectMembershipError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message)
  }
}

interface MemberRow {
  readonly user_id: string
  readonly display_name: string
  readonly role: UserRole
  readonly joined_at: Date
}

function asMember(row: MemberRow): ProjectMember {
  return {
    userId: row.user_id as UserId,
    displayName: row.display_name,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
  }
}

async function loadMembers(
  client: Pick<Pool, 'query'> | PoolClient,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  actorId: UserId,
): Promise<readonly ProjectMember[]> {
  const result = await client.query<MemberRow>(
    'SELECT membership.user_id, user_account.display_name, membership.role, membership.joined_at ' +
    'FROM project_memberships membership ' +
    'JOIN project_memberships actor ON actor.workspace_id = membership.workspace_id ' +
    'AND actor.project_id = membership.project_id AND actor.user_id = $3 ' +
    'JOIN users user_account ON user_account.workspace_id = membership.workspace_id ' +
    'AND user_account.id = membership.user_id ' +
    'WHERE membership.workspace_id = $1 AND membership.project_id = $2 ' +
    "ORDER BY CASE membership.role WHEN 'owner' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END, " +
    'membership.joined_at, membership.user_id',
    [workspaceId, projectId, actorId],
  )
  return result.rows.map(asMember)
}

async function requireOwner(
  client: PoolClient,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  actorId: UserId,
): Promise<void> {
  const project = await client.query(
    'SELECT id FROM projects WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [workspaceId, projectId],
  )
  if (!project.rows[0]) throw new ProjectMembershipError('project_not_found', '工作区不存在', 404)
  const owner = await client.query(
    'SELECT 1 FROM project_memberships WHERE workspace_id = $1 AND project_id = $2 ' +
    "AND user_id = $3 AND role = 'owner' FOR UPDATE",
    [workspaceId, projectId, actorId],
  )
  if (!owner.rows[0]) throw new ProjectMembershipError('project_owner_required', '只有工作区 Owner 可以管理成员', 403)
}

async function ownerCount(client: PoolClient, workspaceId: WorkspaceId, projectId: ProjectId): Promise<number> {
  const result = await client.query<{ readonly count: string }>(
    "SELECT COUNT(*)::text AS count FROM project_memberships WHERE workspace_id = $1 AND project_id = $2 AND role = 'owner'",
    [workspaceId, projectId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function refreshTenantRole(client: PoolClient, workspaceId: WorkspaceId, userId: UserId): Promise<void> {
  await client.query(
    'UPDATE users SET role = COALESCE((' +
    "SELECT CASE MIN(CASE role WHEN 'owner' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END) " +
    "WHEN 1 THEN 'owner' WHEN 2 THEN 'operator' ELSE 'viewer' END " +
    'FROM project_memberships WHERE workspace_id = $1 AND user_id = $2' +
    "), 'viewer') WHERE workspace_id = $1 AND id = $2",
    [workspaceId, userId],
  )
}

export class ProjectMembershipRepository {
  constructor(private readonly pool: Pool) {}

  async getAccess(workspaceId: WorkspaceId, projectId: ProjectId, userId: UserId): Promise<ProjectAccess | null> {
    const result = await this.pool.query<{ readonly role: UserRole; readonly archived_at: Date | null }>(
      'SELECT membership.role, project.archived_at FROM project_memberships membership ' +
      'JOIN projects project ON project.workspace_id = membership.workspace_id ' +
      'AND project.id = membership.project_id ' +
      'WHERE membership.workspace_id = $1 AND membership.project_id = $2 AND membership.user_id = $3',
      [workspaceId, projectId, userId],
    )
    const row = result.rows[0]
    return row ? { role: row.role, archivedAt: row.archived_at?.toISOString() ?? null } : null
  }

  async getRole(workspaceId: WorkspaceId, projectId: ProjectId, userId: UserId): Promise<UserRole | null> {
    return (await this.getAccess(workspaceId, projectId, userId))?.role ?? null
  }

  async getResourceAccess(
    workspaceId: WorkspaceId,
    userId: UserId,
    resource: ProjectResourceKind,
    resourceId: string,
  ): Promise<ProjectAccess | null> {
    const resourceJoin = {
      mission: 'JOIN missions resource ON resource.project_id = membership.project_id AND resource.workspace_id = membership.workspace_id AND resource.id = $3',
      run: 'JOIN agent_runs run ON run.workspace_id = membership.workspace_id AND run.id = $3 ' +
        'JOIN missions resource ON resource.id = run.mission_id AND resource.workspace_id = run.workspace_id AND resource.project_id = membership.project_id',
      artifact: 'JOIN artifacts resource ON resource.project_id = membership.project_id AND resource.workspace_id = membership.workspace_id AND resource.id = $3',
      artifact_version: 'JOIN artifact_versions version ON version.id = $3 ' +
        'JOIN artifacts resource ON resource.id = version.artifact_id AND resource.workspace_id = membership.workspace_id AND resource.project_id = membership.project_id',
      conversation: 'JOIN conversations resource ON resource.id = $3 ' +
        'AND resource.workspace_id = membership.workspace_id AND resource.project_id = membership.project_id',
      planning_request: 'JOIN conversation_planning_requests resource ON resource.id = $3 ' +
        'AND resource.workspace_id = membership.workspace_id AND resource.project_id = membership.project_id',
      approval: 'JOIN approvals approval ON approval.id = $3 AND approval.workspace_id = membership.workspace_id ' +
        'JOIN missions resource ON resource.id = approval.mission_id ' +
        'AND resource.workspace_id = membership.workspace_id AND resource.project_id = membership.project_id',
      agent: 'JOIN conversation_members agent_member ON agent_member.participant_id = $3 ' +
        "AND agent_member.workspace_id = membership.workspace_id AND agent_member.participant_kind = 'agent' " +
        'JOIN conversations resource ON resource.id = agent_member.conversation_id ' +
        'AND resource.workspace_id = membership.workspace_id AND resource.project_id = membership.project_id',
      review: 'JOIN reviews review ON review.id = $3 AND review.workspace_id = membership.workspace_id ' +
        'JOIN missions resource ON resource.id = review.mission_id ' +
        'AND resource.workspace_id = membership.workspace_id AND resource.project_id = membership.project_id',
      submission: 'JOIN task_submissions submission ON submission.id = $3 ' +
        'AND submission.workspace_id = membership.workspace_id ' +
        'JOIN missions resource ON resource.id = submission.mission_id ' +
        'AND resource.workspace_id = membership.workspace_id AND resource.project_id = membership.project_id',
    }[resource]
    const result = await this.pool.query<{ readonly role: UserRole; readonly archived_at: Date | null }>(
      'SELECT membership.role, project.archived_at FROM project_memberships membership ' + resourceJoin + ' ' +
      'JOIN projects project ON project.workspace_id = membership.workspace_id ' +
      'AND project.id = membership.project_id ' +
      'WHERE membership.workspace_id = $1 AND membership.user_id = $2',
      [workspaceId, userId, resourceId],
    )
    const row = result.rows[0]
    return row ? { role: row.role, archivedAt: row.archived_at?.toISOString() ?? null } : null
  }

  async getResourceRole(
    workspaceId: WorkspaceId,
    userId: UserId,
    resource: ProjectResourceKind,
    resourceId: string,
  ): Promise<UserRole | null> {
    return (await this.getResourceAccess(workspaceId, userId, resource, resourceId))?.role ?? null
  }

  async listMembers(workspaceId: WorkspaceId, projectId: ProjectId, actorId: UserId): Promise<readonly ProjectMember[]> {
    const members = await loadMembers(this.pool, workspaceId, projectId, actorId)
    if (!members.length && await this.getRole(workspaceId, projectId, actorId) === null) {
      throw new ProjectMembershipError('project_membership_required', '当前用户不是这个工作区的成员', 404)
    }
    return members
  }

  async addMember(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly actorId: UserId
    readonly userId: UserId
    readonly displayName: string
    readonly role: UserRole
    readonly passwordHash?: string
  }): Promise<readonly ProjectMember[]> {
    return withTransaction(this.pool, async (client) => {
      await requireOwner(client, input.workspaceId, input.projectId, input.actorId)
      const existingUser = await client.query<{ readonly workspace_id: string }>(
        'SELECT workspace_id FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
      )
      if (existingUser.rows[0] && existingUser.rows[0].workspace_id !== input.workspaceId) {
        throw new ProjectMembershipError('user_id_conflict', '这个用户名已经属于其他组织')
      }
      if (!existingUser.rows[0]) {
        if (!input.passwordHash) throw new ProjectMembershipError('password_required', '新成员需要初始密码')
        await client.query(
          'INSERT INTO users (id, workspace_id, display_name, role) VALUES ($1, $2, $3, $4)',
          [input.userId, input.workspaceId, input.displayName, input.role],
        )
        await client.query(
          'INSERT INTO user_credentials (workspace_id, user_id, password_hash) VALUES ($1, $2, $3)',
          [input.workspaceId, input.userId, input.passwordHash],
        )
      }
      const inserted = await client.query(
        'INSERT INTO project_memberships (workspace_id, project_id, user_id, role, added_by) ' +
        'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, user_id) DO NOTHING RETURNING user_id',
        [input.workspaceId, input.projectId, input.userId, input.role, input.actorId],
      )
      if (!inserted.rows[0]) throw new ProjectMembershipError('member_exists', '该用户已经在这个工作区中', 409)
      await client.query(
        'INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) ' +
        "SELECT conversation.id, conversation.workspace_id, 'user', $3 FROM conversations conversation " +
        "WHERE conversation.workspace_id = $1 AND conversation.project_id = $2 AND conversation.kind = 'project_room' " +
        'ON CONFLICT (conversation_id, participant_kind, participant_id) DO UPDATE SET notifications = TRUE',
        [input.workspaceId, input.projectId, input.userId],
      )
      await refreshTenantRole(client, input.workspaceId, input.userId)
      await client.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [input.workspaceId, input.userId],
      )
      await client.query(
        'INSERT INTO project_membership_events ' +
        '(workspace_id, project_id, user_id, actor_id, kind, next_role) ' +
        "VALUES ($1, $2, $3, $4, 'member_added', $5)",
        [input.workspaceId, input.projectId, input.userId, input.actorId, input.role],
      )
      return loadMembers(client, input.workspaceId, input.projectId, input.actorId)
    })
  }

  async updateRole(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly actorId: UserId
    readonly userId: UserId
    readonly role: UserRole
  }): Promise<readonly ProjectMember[]> {
    return withTransaction(this.pool, async (client) => {
      await requireOwner(client, input.workspaceId, input.projectId, input.actorId)
      const current = await client.query<{ readonly role: UserRole }>(
        'SELECT role FROM project_memberships WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3 FOR UPDATE',
        [input.workspaceId, input.projectId, input.userId],
      )
      const previousRole = current.rows[0]?.role
      if (!previousRole) throw new ProjectMembershipError('member_not_found', '工作区成员不存在', 404)
      if (previousRole === 'owner' && input.role !== 'owner' && await ownerCount(client, input.workspaceId, input.projectId) <= 1) {
        throw new ProjectMembershipError('last_owner_required', '工作区必须保留至少一位 Owner', 409)
      }
      await client.query(
        'UPDATE project_memberships SET role = $4 WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3',
        [input.workspaceId, input.projectId, input.userId, input.role],
      )
      await refreshTenantRole(client, input.workspaceId, input.userId)
      await client.query(
        'INSERT INTO project_membership_events ' +
        '(workspace_id, project_id, user_id, actor_id, kind, previous_role, next_role) ' +
        "VALUES ($1, $2, $3, $4, 'role_changed', $5, $6)",
        [input.workspaceId, input.projectId, input.userId, input.actorId, previousRole, input.role],
      )
      await client.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [input.workspaceId, input.userId],
      )
      return loadMembers(client, input.workspaceId, input.projectId, input.actorId)
    })
  }

  async removeMember(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly actorId: UserId
    readonly userId: UserId
  }): Promise<readonly ProjectMember[]> {
    return withTransaction(this.pool, async (client) => {
      await requireOwner(client, input.workspaceId, input.projectId, input.actorId)
      const current = await client.query<{ readonly role: UserRole }>(
        'SELECT role FROM project_memberships WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3 FOR UPDATE',
        [input.workspaceId, input.projectId, input.userId],
      )
      const previousRole = current.rows[0]?.role
      if (!previousRole) throw new ProjectMembershipError('member_not_found', '工作区成员不存在', 404)
      if (previousRole === 'owner' && await ownerCount(client, input.workspaceId, input.projectId) <= 1) {
        throw new ProjectMembershipError('last_owner_required', '不能移除工作区最后一位 Owner', 409)
      }
      await client.query(
        'DELETE FROM conversation_members member USING conversations conversation ' +
        'WHERE member.conversation_id = conversation.id AND member.workspace_id = conversation.workspace_id ' +
        'AND conversation.workspace_id = $1 AND conversation.project_id = $2 ' +
        "AND member.participant_kind = 'user' AND member.participant_id = $3",
        [input.workspaceId, input.projectId, input.userId],
      )
      await client.query(
        'DELETE FROM project_memberships WHERE workspace_id = $1 AND project_id = $2 AND user_id = $3',
        [input.workspaceId, input.projectId, input.userId],
      )
      await refreshTenantRole(client, input.workspaceId, input.userId)
      await client.query(
        'INSERT INTO project_membership_events ' +
        '(workspace_id, project_id, user_id, actor_id, kind, previous_role) ' +
        "VALUES ($1, $2, $3, $4, 'member_removed', $5)",
        [input.workspaceId, input.projectId, input.userId, input.actorId, previousRole],
      )
      await client.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [input.workspaceId, input.userId],
      )
      return loadMembers(client, input.workspaceId, input.projectId, input.actorId)
    })
  }
}

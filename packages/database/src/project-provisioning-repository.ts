import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { AgentRole, ProjectId, UserId, WorkspaceId } from '@runguild/protocol'
import type { Pool } from 'pg'

import { withTransaction } from './transaction.js'

const PROJECT_AGENT_ROLES = ['planner', 'researcher', 'builder', 'reviewer'] as const satisfies readonly AgentRole[]

const roleNames: Record<typeof PROJECT_AGENT_ROLES[number], string> = {
  planner: '规划 Agent',
  researcher: '研究 Agent',
  builder: '构建 Agent',
  reviewer: '审查 Agent',
}

export interface CreateProjectInput {
  readonly workspaceId: WorkspaceId
  readonly actorId: UserId
  readonly projectId: ProjectId
  readonly name: string
  readonly repositoryPath?: string
  readonly defaultBranch: string
  readonly modelProvider: string
  readonly modelName: string
}

export interface CreatedProject {
  readonly id: ProjectId
  readonly name: string
  readonly role: 'owner'
  readonly conversationId: string
  readonly agents: readonly {
    readonly id: string
    readonly role: typeof PROJECT_AGENT_ROLES[number]
    readonly name: string
  }[]
}

export class ProjectProvisioningError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message)
  }
}

function validateProjectId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(value)) {
    throw new ProjectProvisioningError('project_id_invalid', '服务器生成的工作区标识无效')
  }
}

function validateName(value: string, code: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200) {
    throw new ProjectProvisioningError(code, `${label}必须是 1 至 200 个字符`)
  }
  return trimmed
}

function validateBranch(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200 || trimmed.startsWith('-') || /[\s~^:?*[\\]/.test(trimmed)) {
    throw new ProjectProvisioningError('default_branch_invalid', '默认分支名称无效')
  }
  return trimmed
}

function validateRepositoryPath(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  if (trimmed.length > 4_096 || trimmed.includes('\0') || !isAbsolute(trimmed)) {
    throw new ProjectProvisioningError('repository_path_invalid', '代码仓库必须是 API 所在机器上的绝对路径')
  }
  const normalized = resolve(trimmed)
  if (normalized === '/') {
    throw new ProjectProvisioningError('repository_path_invalid', '代码仓库不能是文件系统根目录')
  }
  return normalized
}

export class ProjectProvisioningRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateProjectInput): Promise<CreatedProject> {
    validateProjectId(input.projectId)
    const name = validateName(input.name, 'project_name_invalid', '工作区名称')
    const defaultBranch = validateBranch(input.defaultBranch)
    const repositoryPath = validateRepositoryPath(input.repositoryPath)
    const worktreeRoot = repositoryPath === null
      ? null
      : join(dirname(repositoryPath), '.runguild-worktrees', input.projectId)
    const modelProvider = validateName(input.modelProvider, 'model_provider_invalid', '模型提供商')
    const modelName = validateName(input.modelName, 'model_name_invalid', '模型名称')

    return withTransaction(this.pool, async (client) => {
      const actor = await client.query<{ readonly role: 'owner' | 'operator' | 'viewer' }>(
        'SELECT role FROM users WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [input.workspaceId, input.actorId],
      )
      if (!actor.rows[0]) {
        throw new ProjectProvisioningError('project_creator_not_found', '当前用户不属于这个组织', 404)
      }
      if (actor.rows[0].role === 'viewer') {
        throw new ProjectProvisioningError('project_creation_forbidden', 'Viewer 不能创建工作区', 403)
      }

      const inserted = await client.query(
        'INSERT INTO projects (id, workspace_id, name, repository_path, default_branch) ' +
        'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id',
        [input.projectId, input.workspaceId, name, repositoryPath, defaultBranch],
      )
      if (!inserted.rows[0]) {
        throw new ProjectProvisioningError('project_id_conflict', '工作区标识冲突，请重试', 409)
      }

      await client.query(
        'INSERT INTO project_memberships (workspace_id, project_id, user_id, role, added_by) ' +
        "VALUES ($1, $2, $3, 'owner', $3)",
        [input.workspaceId, input.projectId, input.actorId],
      )
      await client.query(
        'INSERT INTO project_membership_events ' +
        '(workspace_id, project_id, user_id, actor_id, kind, next_role) ' +
        "VALUES ($1, $2, $3, $3, 'member_added', 'owner')",
        [input.workspaceId, input.projectId, input.actorId],
      )
      await client.query(
        "UPDATE users SET role = 'owner' WHERE workspace_id = $1 AND id = $2",
        [input.workspaceId, input.actorId],
      )
      await client.query(
        'INSERT INTO project_runtime_configs (project_id, workspace_id, worktree_root) VALUES ($1, $2, $3)',
        [input.projectId, input.workspaceId, worktreeRoot],
      )

      const agents = []
      for (const role of PROJECT_AGENT_ROLES) {
        const id = `${input.projectId}:agent:${role}`
        const agent = await client.query(
          'INSERT INTO agents (id, workspace_id, name, role, status, model_provider, model_name) ' +
          "VALUES ($1, $2, $3, $4, 'active', $5, $6) ON CONFLICT (id) DO NOTHING RETURNING id",
          [id, input.workspaceId, roleNames[role], role, modelProvider, modelName],
        )
        if (!agent.rows[0]) {
          throw new ProjectProvisioningError('generated_agent_id_conflict', 'Agent 标识冲突，请重试', 409)
        }
        agents.push({ id, role, name: roleNames[role] })
      }

      const conversationId = `${input.projectId}:conversation:team`
      const conversation = await client.query(
        'INSERT INTO conversations (id, workspace_id, project_id, kind, title) ' +
        "VALUES ($1, $2, $3, 'project_room', $4) ON CONFLICT (id) DO NOTHING RETURNING id",
        [conversationId, input.workspaceId, input.projectId, `${name} · 团队协作室`],
      )
      if (!conversation.rows[0]) {
        throw new ProjectProvisioningError('generated_conversation_id_conflict', '协作室标识冲突，请重试', 409)
      }
      await client.query(
        'INSERT INTO conversation_members ' +
        '(conversation_id, workspace_id, participant_kind, participant_id) ' +
        "VALUES ($1, $2, 'user', $3)",
        [conversationId, input.workspaceId, input.actorId],
      )
      for (const agent of agents) {
        await client.query(
          'INSERT INTO conversation_members ' +
          '(conversation_id, workspace_id, participant_kind, participant_id) ' +
          "VALUES ($1, $2, 'agent', $3)",
          [conversationId, input.workspaceId, agent.id],
        )
      }

      return { id: input.projectId, name, role: 'owner', conversationId, agents }
    })
  }
}

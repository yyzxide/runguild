import type { Pool } from 'pg'

import { withTransaction } from './transaction.js'

const DEVELOPMENT_ROLES = ['planner', 'researcher', 'builder', 'reviewer'] as const

export interface DevelopmentBootstrapInput {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly projectId: string
  readonly projectName: string
  readonly userId: string
  readonly displayName: string
  readonly modelProvider: string
  readonly modelName: string
}

export interface DevelopmentBootstrapResult {
  readonly workspaceId: string
  readonly projectId: string
  readonly userId: string
  readonly conversationId: string
  readonly agents: readonly {
    readonly id: string
    readonly role: typeof DEVELOPMENT_ROLES[number]
    readonly name: string
  }[]
}

function assertScopedId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(value)) {
    throw new Error(label + ' must be 1-120 letters, numbers, colon, underscore, or hyphen characters')
  }
}

function assertName(value: string, label: string): void {
  if (!value.trim() || value.length > 200) {
    throw new Error(label + ' must be between 1 and 200 characters')
  }
}

const roleNames: Record<typeof DEVELOPMENT_ROLES[number], string> = {
  planner: '规划 Agent',
  researcher: '研究 Agent',
  builder: '构建 Agent',
  reviewer: '审查 Agent',
}

export class DevelopmentSetupRepository {
  constructor(private readonly pool: Pool) {}

  async bootstrap(input: DevelopmentBootstrapInput): Promise<DevelopmentBootstrapResult> {
    assertScopedId(input.workspaceId, 'workspaceId')
    assertScopedId(input.projectId, 'projectId')
    assertScopedId(input.userId, 'userId')
    assertName(input.workspaceName, 'workspaceName')
    assertName(input.projectName, 'projectName')
    assertName(input.displayName, 'displayName')
    assertName(input.modelProvider, 'modelProvider')
    assertName(input.modelName, 'modelName')

    return withTransaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO workspaces (id, name) VALUES ($1, $2) ' +
        'ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name',
        [input.workspaceId, input.workspaceName.trim()],
      )

      const existingUser = await client.query<{ readonly workspace_id: string }>(
        'SELECT workspace_id FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
      )
      if (existingUser.rows[0] && existingUser.rows[0].workspace_id !== input.workspaceId) {
        throw new Error('userId already belongs to another workspace')
      }
      await client.query(
        'INSERT INTO users (id, workspace_id, display_name) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name',
        [input.userId, input.workspaceId, input.displayName.trim()],
      )

      const existingProject = await client.query<{ readonly workspace_id: string }>(
        'SELECT workspace_id FROM projects WHERE id = $1 FOR UPDATE',
        [input.projectId],
      )
      if (existingProject.rows[0] && existingProject.rows[0].workspace_id !== input.workspaceId) {
        throw new Error('projectId already belongs to another workspace')
      }
      await client.query(
        'INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()',
        [input.projectId, input.workspaceId, input.projectName.trim()],
      )
      await client.query(
        'INSERT INTO project_memberships (workspace_id, project_id, user_id, role, added_by) ' +
        "VALUES ($1, $2, $3, 'owner', $3) ON CONFLICT (project_id, user_id) DO NOTHING",
        [input.workspaceId, input.projectId, input.userId],
      )

      const agents = []
      for (const role of DEVELOPMENT_ROLES) {
        const id = input.projectId + ':agent:' + role
        const existingAgent = await client.query<{ readonly workspace_id: string }>(
          'SELECT workspace_id FROM agents WHERE id = $1 FOR UPDATE',
          [id],
        )
        if (existingAgent.rows[0] && existingAgent.rows[0].workspace_id !== input.workspaceId) {
          throw new Error('Generated agent id already belongs to another workspace')
        }
        const name = roleNames[role]
        await client.query(
          'INSERT INTO agents (id, workspace_id, name, role, status, model_provider, model_name) ' +
          "VALUES ($1, $2, $3, $4, 'active', $5, $6) " +
          'ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, ' +
          'model_provider = EXCLUDED.model_provider, model_name = EXCLUDED.model_name, updated_at = NOW()',
          [id, input.workspaceId, name, role, input.modelProvider.trim(), input.modelName.trim()],
        )
        agents.push({ id, role, name })
      }

      const conversationId = input.projectId + ':conversation:team'
      const existingConversation = await client.query<{ readonly workspace_id: string }>(
        'SELECT workspace_id FROM conversations WHERE id = $1 FOR UPDATE',
        [conversationId],
      )
      if (existingConversation.rows[0] && existingConversation.rows[0].workspace_id !== input.workspaceId) {
        throw new Error('Generated Conversation id already belongs to another Workspace')
      }
      await client.query(
        'INSERT INTO conversations (id, workspace_id, project_id, kind, title) ' +
        "VALUES ($1, $2, $3, 'project_room', $4) " +
        'ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()',
        [conversationId, input.workspaceId, input.projectId, input.projectName.trim() + ' · 团队协作室'],
      )
      await client.query(
        'INSERT INTO conversation_members ' +
        "(conversation_id, workspace_id, participant_kind, participant_id) VALUES ($1, $2, 'user', $3) " +
        'ON CONFLICT (conversation_id, participant_kind, participant_id) ' +
        'DO UPDATE SET notifications = TRUE',
        [conversationId, input.workspaceId, input.userId],
      )
      for (const agent of agents) {
        await client.query(
          'INSERT INTO conversation_members ' +
          "(conversation_id, workspace_id, participant_kind, participant_id) VALUES ($1, $2, 'agent', $3) " +
          'ON CONFLICT (conversation_id, participant_kind, participant_id) ' +
          'DO UPDATE SET notifications = TRUE',
          [conversationId, input.workspaceId, agent.id],
        )
      }

      return {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        userId: input.userId,
        conversationId,
        agents,
      }
    })
  }
}

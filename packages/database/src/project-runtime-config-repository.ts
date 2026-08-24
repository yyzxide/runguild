import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { AgentId, AgentRole, ProjectId, UserId, WorkspaceId } from '@runguild/protocol'
import type { Pool } from 'pg'

import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

const DEFAULT_TEST_COMMANDS = [['npm', 'test'], ['npm', 'run', 'typecheck']] as const

export interface ProjectRuntimeConfiguration {
  readonly project: {
    readonly id: ProjectId
    readonly workspaceId: WorkspaceId
    readonly name: string
    readonly repositoryPath: string | null
    readonly defaultBranch: string
  }
  readonly runtime: {
    readonly worktreeRoot: string | null
    readonly testCommands: readonly (readonly string[])[]
    readonly agentContextInputTokens: number
    readonly agentMaxTestTimeoutMs: number
  }
  readonly agents: readonly {
    readonly id: AgentId
    readonly name: string
    readonly role: AgentRole
    readonly status: 'active' | 'paused' | 'disabled'
    readonly modelProvider: string
    readonly modelName: string
  }[]
}

export interface UpdateProjectRuntimeConfigurationInput {
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly userId: UserId
  readonly repositoryPath: string
  readonly defaultBranch: string
  readonly worktreeRoot: string
  readonly testCommands: readonly (readonly string[])[]
  readonly agentContextInputTokens: number
  readonly agentMaxTestTimeoutMs: number
  readonly agentModels: readonly {
    readonly agentId: AgentId
    readonly modelProvider: string
    readonly modelName: string
  }[]
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))
}

function assertPath(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 4_096 || trimmed.includes('\0') || !isAbsolute(trimmed)) {
    throw new Error(label + ' must be an absolute path between 1 and 4096 characters')
  }
  const normalized = resolve(trimmed)
  if (normalized === '/') throw new Error(label + ' cannot be the filesystem root')
  return normalized
}

function validateInput(input: UpdateProjectRuntimeConfigurationInput): {
  readonly repositoryPath: string
  readonly worktreeRoot: string
} {
  const repositoryPath = assertPath(input.repositoryPath, 'Repository path')
  const worktreeRoot = assertPath(input.worktreeRoot, 'Worktree root')
  if (contains(repositoryPath, worktreeRoot) || contains(worktreeRoot, repositoryPath)) {
    throw new Error('Repository and Worktree roots must be distinct non-nested directories')
  }
  if (!input.defaultBranch.trim() || input.defaultBranch.length > 200
      || input.defaultBranch.startsWith('-') || /[\s~^:?*[\\]/.test(input.defaultBranch)) {
    throw new Error('Default branch is invalid')
  }
  if (!Array.isArray(input.testCommands) || input.testCommands.length < 1 || input.testCommands.length > 50
      || input.testCommands.some((command) => !Array.isArray(command)
        || command.length < 1 || command.length > 30
        || command.some((part) => typeof part !== 'string' || !part.trim() || part.length > 1_000))) {
    throw new Error('Test commands must contain 1-50 non-empty argument arrays')
  }
  if (!Number.isInteger(input.agentContextInputTokens)
      || input.agentContextInputTokens < 256 || input.agentContextInputTokens > 2_000_000) {
    throw new Error('Agent context input tokens must be between 256 and 2000000')
  }
  if (!Number.isInteger(input.agentMaxTestTimeoutMs)
      || input.agentMaxTestTimeoutMs < 1_000 || input.agentMaxTestTimeoutMs > 900_000) {
    throw new Error('Agent test timeout must be between 1000 and 900000 milliseconds')
  }
  const agentIds = new Set<string>()
  for (const model of input.agentModels) {
    if (agentIds.has(model.agentId)) throw new Error('Agent model entries must be unique')
    agentIds.add(model.agentId)
    if (!model.modelProvider.trim() || model.modelProvider.length > 200
        || !model.modelName.trim() || model.modelName.length > 200) {
      throw new Error('Agent model provider and name must be between 1 and 200 characters')
    }
  }
  return { repositoryPath, worktreeRoot }
}

export class ProjectRuntimeConfigRepository {
  constructor(private readonly pool: Pool) {}

  async get(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    userId: UserId,
  ): Promise<ProjectRuntimeConfiguration | null> {
    return withTransaction(this.pool, async (client) => {
      const project = await client.query<{
        readonly id: string
        readonly workspace_id: string
        readonly name: string
        readonly repository_path: string | null
        readonly default_branch: string
        readonly worktree_root: string | null
        readonly test_commands: readonly (readonly string[])[] | null
        readonly agent_context_input_tokens: number | null
        readonly agent_max_test_timeout_ms: number | null
        readonly conversation_id: string | null
      }>(
        'SELECT project.id, project.workspace_id, project.name, project.repository_path, ' +
        'project.default_branch, config.worktree_root, config.test_commands, ' +
        'config.agent_context_input_tokens, config.agent_max_test_timeout_ms, room.id AS conversation_id ' +
        'FROM projects project ' +
        'JOIN users actor ON actor.id = $3 AND actor.workspace_id = project.workspace_id ' +
        'LEFT JOIN project_runtime_configs config ON config.project_id = project.id ' +
        'AND config.workspace_id = project.workspace_id ' +
        'LEFT JOIN LATERAL (SELECT conversation.id FROM conversations conversation ' +
        'WHERE conversation.workspace_id = project.workspace_id AND conversation.project_id = project.id ' +
        "ORDER BY (conversation.kind = 'project_room') DESC, conversation.updated_at DESC, conversation.id LIMIT 1" +
        ') room ON TRUE WHERE project.workspace_id = $1 AND project.id = $2',
        [workspaceId, projectId, userId],
      )
      const row = project.rows[0]
      if (!row) return null
      const agents = row.conversation_id
        ? await client.query<{
            readonly id: string
            readonly name: string
            readonly role: AgentRole
            readonly status: 'active' | 'paused' | 'disabled'
            readonly model_provider: string
            readonly model_name: string
          }>(
            'SELECT agent.id, agent.name, agent.role, agent.status, agent.model_provider, agent.model_name ' +
            'FROM conversation_members member JOIN agents agent ON agent.id = member.participant_id ' +
            'AND agent.workspace_id = member.workspace_id WHERE member.conversation_id = $1 ' +
            "AND member.workspace_id = $2 AND member.participant_kind = 'agent' " +
            "ORDER BY CASE agent.role WHEN 'planner' THEN 1 WHEN 'researcher' THEN 2 " +
            "WHEN 'builder' THEN 3 WHEN 'reviewer' THEN 4 ELSE 5 END, agent.name, agent.id",
            [row.conversation_id, workspaceId],
          )
        : { rows: [] }
      return {
        project: {
          id: row.id as ProjectId,
          workspaceId: row.workspace_id as WorkspaceId,
          name: row.name,
          repositoryPath: row.repository_path,
          defaultBranch: row.default_branch,
        },
        runtime: {
          worktreeRoot: row.worktree_root,
          testCommands: row.test_commands?.length ? row.test_commands : DEFAULT_TEST_COMMANDS,
          agentContextInputTokens: row.agent_context_input_tokens ?? 65_536,
          agentMaxTestTimeoutMs: row.agent_max_test_timeout_ms ?? 120_000,
        },
        agents: agents.rows.map((agent) => ({
          id: agent.id as AgentId,
          name: agent.name,
          role: agent.role,
          status: agent.status,
          modelProvider: agent.model_provider,
          modelName: agent.model_name,
        })),
      }
    }, 'repeatable read')
  }

  async update(input: UpdateProjectRuntimeConfigurationInput): Promise<ProjectRuntimeConfiguration> {
    const normalized = validateInput(input)
    await withTransaction(this.pool, async (client) => {
      const project = await client.query<{ readonly id: string }>(
        'SELECT project.id FROM projects project ' +
        'JOIN users actor ON actor.id = $3 AND actor.workspace_id = project.workspace_id ' +
        'WHERE project.workspace_id = $1 AND project.id = $2 FOR UPDATE OF project',
        [input.workspaceId, input.projectId, input.userId],
      )
      if (!project.rows[0]) throw new Error('Project not found or forbidden')

      const agentIds = input.agentModels.map((model) => model.agentId)
      if (agentIds.length > 0) {
        const allowed = await client.query<{ readonly id: string }>(
          'SELECT DISTINCT agent.id FROM conversations conversation ' +
          'JOIN conversation_members member ON member.conversation_id = conversation.id ' +
          "AND member.workspace_id = conversation.workspace_id AND member.participant_kind = 'agent' " +
          'JOIN agents agent ON agent.id = member.participant_id AND agent.workspace_id = member.workspace_id ' +
          'WHERE conversation.workspace_id = $1 AND conversation.project_id = $2 ' +
          'AND agent.id = ANY($3::text[])',
          [input.workspaceId, input.projectId, agentIds],
        )
        if (allowed.rows.length !== agentIds.length) throw new Error('Agent model update is outside the Project team')
      }

      await client.query(
        'UPDATE projects SET repository_path = $3, default_branch = $4, updated_at = NOW() ' +
        'WHERE workspace_id = $1 AND id = $2',
        [input.workspaceId, input.projectId, normalized.repositoryPath, input.defaultBranch.trim()],
      )
      await client.query(
        'INSERT INTO project_runtime_configs ' +
        '(project_id, workspace_id, worktree_root, test_commands, agent_context_input_tokens, agent_max_test_timeout_ms) ' +
        'VALUES ($1, $2, $3, $4::jsonb, $5, $6) ON CONFLICT (project_id) DO UPDATE SET ' +
        'worktree_root = EXCLUDED.worktree_root, test_commands = EXCLUDED.test_commands, ' +
        'agent_context_input_tokens = EXCLUDED.agent_context_input_tokens, ' +
        'agent_max_test_timeout_ms = EXCLUDED.agent_max_test_timeout_ms, updated_at = NOW()',
        [
          input.projectId,
          input.workspaceId,
          normalized.worktreeRoot,
          canonicalJson(input.testCommands),
          input.agentContextInputTokens,
          input.agentMaxTestTimeoutMs,
        ],
      )
      for (const model of input.agentModels) {
        await client.query(
          'UPDATE agents SET model_provider = $3, model_name = $4, updated_at = NOW() ' +
          'WHERE workspace_id = $1 AND id = $2',
          [input.workspaceId, model.agentId, model.modelProvider.trim(), model.modelName.trim()],
        )
      }
    })
    const updated = await this.get(input.workspaceId, input.projectId, input.userId)
    if (!updated) throw new Error('Updated Project Runtime Configuration disappeared')
    return updated
  }
}

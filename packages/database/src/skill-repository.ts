import { createHash, randomUUID } from 'node:crypto'

import type {
  AgentId,
  AgentSkillContext,
  SkillId,
  SkillVersionId,
  WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { withTransaction } from './transaction.js'

export interface SkillDefinition {
  readonly id: SkillId
  readonly workspaceId: WorkspaceId
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly status: 'active' | 'disabled'
}

function tokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 3))
}

function instructions(input: string): string {
  const value = input.trim()
  if (!value || value.length > 65_536) {
    throw new RangeError('Skill instructions must be between 1 and 65536 characters')
  }
  return value
}

export class SkillRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    readonly id?: SkillId
    readonly workspaceId: WorkspaceId
    readonly slug: string
    readonly name: string
    readonly description?: string
  }): Promise<SkillDefinition> {
    const slug = input.slug.trim()
    const name = input.name.trim()
    const description = input.description?.trim() ?? ''
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('Skill slug is invalid')
    if (!name || name.length > 200 || description.length > 2_000) throw new Error('Skill metadata is invalid')
    const result = await this.pool.query<{
      id: string
      workspace_id: string
      slug: string
      name: string
      description: string
      status: 'active' | 'disabled'
    }>(
      'INSERT INTO skills (id, workspace_id, slug, name, description) ' +
      'VALUES ($1, $2, $3, $4, $5) RETURNING id, workspace_id, slug, name, description, status',
      [input.id ?? 'skill_' + randomUUID(), input.workspaceId, slug, name, description],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Skill was not persisted')
    return {
      id: row.id as SkillId,
      workspaceId: row.workspace_id as WorkspaceId,
      slug: row.slug,
      name: row.name,
      description: row.description,
      status: row.status,
    }
  }

  async createVersion(input: {
    readonly id?: SkillVersionId
    readonly workspaceId: WorkspaceId
    readonly skillId: SkillId
    readonly instructions: string
  }): Promise<AgentSkillContext> {
    const content = instructions(input.instructions)
    const contentHash = createHash('sha256').update(content).digest('hex')
    return withTransaction(this.pool, async (client) => {
      const skill = await client.query<{
        id: string
        name: string
        description: string
      }>(
        "SELECT id, name, description FROM skills " +
        "WHERE id = $1 AND workspace_id = $2 AND status = 'active' FOR UPDATE",
        [input.skillId, input.workspaceId],
      )
      const definition = skill.rows[0]
      if (!definition) throw new Error('Active Skill not found')
      const existing = await client.query<{
        id: string
        version: number
        estimated_tokens: number
      }>(
        'SELECT id, version, estimated_tokens FROM skill_versions ' +
        'WHERE skill_id = $1 AND content_hash = $2',
        [input.skillId, contentHash],
      )
      if (existing.rows[0]) {
        return {
          skillId: input.skillId,
          versionId: existing.rows[0].id as SkillVersionId,
          name: definition.name,
          description: definition.description,
          instructions: content,
          contentHash,
          estimatedTokens: existing.rows[0].estimated_tokens,
          priority: 100,
        }
      }
      const latest = await client.query<{ version: number }>(
        'SELECT version FROM skill_versions WHERE skill_id = $1 ORDER BY version DESC LIMIT 1',
        [input.skillId],
      )
      const version = (latest.rows[0]?.version ?? 0) + 1
      const estimatedTokens = tokenEstimate(content)
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO skill_versions ' +
        '(id, skill_id, version, instructions, content_hash, estimated_tokens) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [input.id ?? 'skill_version_' + randomUUID(), input.skillId, version, content, contentHash, estimatedTokens],
      )
      const id = inserted.rows[0]?.id
      if (!id) throw new Error('Skill Version was not persisted')
      return {
        skillId: input.skillId,
        versionId: id as SkillVersionId,
        name: definition.name,
        description: definition.description,
        instructions: content,
        contentHash,
        estimatedTokens,
        priority: 100,
      }
    })
  }

  async assign(input: {
    readonly workspaceId: WorkspaceId
    readonly agentId: AgentId
    readonly skillId: SkillId
    readonly pinnedVersionId?: SkillVersionId
    readonly priority?: number
    readonly enabled?: boolean
  }): Promise<void> {
    const priority = input.priority ?? 100
    if (!Number.isInteger(priority) || priority < 0 || priority > 10_000) {
      throw new RangeError('Skill priority must be between 0 and 10000')
    }
    await this.pool.query(
      'INSERT INTO agent_skill_assignments ' +
      '(workspace_id, agent_id, skill_id, pinned_version_id, priority, enabled) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) ' +
      'ON CONFLICT (agent_id, skill_id) DO UPDATE SET ' +
      'pinned_version_id = EXCLUDED.pinned_version_id, priority = EXCLUDED.priority, ' +
      'enabled = EXCLUDED.enabled, updated_at = NOW()',
      [
        input.workspaceId,
        input.agentId,
        input.skillId,
        input.pinnedVersionId ?? null,
        priority,
        input.enabled ?? true,
      ],
    )
  }

  async listForAgent(
    workspaceId: WorkspaceId,
    agentId: AgentId,
  ): Promise<readonly AgentSkillContext[]> {
    const result = await this.pool.query<{
      skill_id: string
      version_id: string
      name: string
      description: string
      instructions: string
      content_hash: string
      estimated_tokens: number
      priority: number
    }>(
      'SELECT s.id AS skill_id, v.id AS version_id, s.name, s.description, ' +
      'v.instructions, v.content_hash, v.estimated_tokens, a.priority ' +
      'FROM agent_skill_assignments a JOIN skills s ON s.id = a.skill_id ' +
      'JOIN skill_versions v ON v.id = COALESCE(a.pinned_version_id, (' +
      '  SELECT latest.id FROM skill_versions latest WHERE latest.skill_id = s.id ' +
      '  ORDER BY latest.version DESC LIMIT 1' +
      ')) WHERE a.agent_id = $1 AND a.workspace_id = $2 AND a.enabled AND s.status = $3 ' +
      'ORDER BY a.priority, s.id',
      [agentId, workspaceId, 'active'],
    )
    return result.rows.map((row) => ({
      skillId: row.skill_id as SkillId,
      versionId: row.version_id as SkillVersionId,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      contentHash: row.content_hash,
      estimatedTokens: row.estimated_tokens,
      priority: row.priority,
    }))
  }
}

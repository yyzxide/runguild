import { createHash } from 'node:crypto'

import type {
  AgentId,
  AgentRole,
  AgentSkillContext,
  ArtifactId,
  ConversationId,
  EvidenceKind,
  IsoTimestamp,
  MessageId,
  MissionId,
  ProjectId,
  RunId,
  SkillId,
  SkillVersionId,
  TaskId,
  WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { canonicalJson } from './json.js'
import { ensurePrimaryMissionArtifact, type MissionArtifactSummary } from './mission-artifact.js'
import { withTransaction } from './transaction.js'

interface FrozenExecutionContext {
  readonly schemaVersion: 1
  readonly agentRole: AgentRole
  readonly modelProvider: string
  readonly modelName: string
  readonly defaultBranch: string
  readonly expectedBaseCommit?: string
  readonly allowBaseRefAdvance?: boolean
  readonly integrationRecovery?: AgentExecutionContext['integrationRecovery']
  readonly missionTitle: string
  readonly missionGoal: string
  readonly missionConstraints: readonly unknown[]
  readonly taskTitle: string
  readonly taskDescription: string
  readonly reviewRequired?: boolean
  readonly acceptanceCriteria: AgentExecutionContext['acceptanceCriteria']
  readonly missionArtifacts?: readonly MissionArtifactSummary[]
  readonly skills: readonly AgentSkillContext[]
  readonly conversationId?: ConversationId
  readonly conversationMessages?: readonly AgentConversationContextMessage[]
}

export interface AgentConversationContextMessage {
  readonly id: MessageId
  readonly authorKind: 'user' | 'agent' | 'system'
  readonly authorId: string
  readonly authorName: string
  readonly body: string
  readonly createdAt: IsoTimestamp
}

export interface AgentExecutionContext {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly agentRole: AgentRole
  readonly modelProvider: string
  readonly modelName: string
  readonly defaultBranch: string
  readonly expectedBaseCommit?: string
  readonly allowBaseRefAdvance?: boolean
  readonly integrationRecovery?: {
    readonly baseCommit: string
    readonly error: Readonly<Record<string, unknown>>
  }
  readonly missionTitle: string
  readonly missionGoal: string
  readonly missionConstraints: readonly unknown[]
  readonly taskTitle: string
  readonly taskDescription: string
  readonly reviewRequired: boolean
  readonly acceptanceCriteria: readonly {
    readonly key: string
    readonly description: string
    readonly required: boolean
    readonly evidenceKinds: readonly EvidenceKind[]
  }[]
  readonly missionArtifacts: readonly MissionArtifactSummary[]
  readonly skills: readonly AgentSkillContext[]
  readonly conversationId?: ConversationId
  readonly conversationMessages: readonly AgentConversationContextMessage[]
  readonly frozenContextHash: string
}

function isFrozen(value: unknown): value is FrozenExecutionContext {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return item['schemaVersion'] === 1
    && typeof item['agentRole'] === 'string'
    && typeof item['modelProvider'] === 'string'
    && typeof item['modelName'] === 'string'
    && typeof item['defaultBranch'] === 'string'
    && (item['expectedBaseCommit'] === undefined || typeof item['expectedBaseCommit'] === 'string')
    && (item['allowBaseRefAdvance'] === undefined || typeof item['allowBaseRefAdvance'] === 'boolean')
    && (item['integrationRecovery'] === undefined
      || (typeof item['integrationRecovery'] === 'object' && item['integrationRecovery'] !== null))
    && typeof item['missionTitle'] === 'string'
    && typeof item['missionGoal'] === 'string'
    && Array.isArray(item['missionConstraints'])
    && typeof item['taskTitle'] === 'string'
    && typeof item['taskDescription'] === 'string'
    && (item['reviewRequired'] === undefined || typeof item['reviewRequired'] === 'boolean')
    && Array.isArray(item['acceptanceCriteria'])
    && (item['missionArtifacts'] === undefined || Array.isArray(item['missionArtifacts']))
    && Array.isArray(item['skills'])
    && (item['conversationId'] === undefined || typeof item['conversationId'] === 'string')
    && (item['conversationMessages'] === undefined || Array.isArray(item['conversationMessages']))
}

function hash(value: FrozenExecutionContext): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export class ExecutionContextRepository {
  constructor(private readonly pool: Pool) {}

  async load(runId: RunId, agentId: AgentId): Promise<AgentExecutionContext | null> {
    return withTransaction(this.pool, async (client) => {
      const base = await client.query<{
        workspace_id: string
        mission_id: string
        project_id: string
        task_id: string
        agent_role: AgentRole
        model_provider: string
        model_name: string
        default_branch: string
        expected_base_commit: string | null
        allow_base_ref_advance: boolean
        reconciliation_base_commit: string | null
        worktree_last_error: Readonly<Record<string, unknown>> | null
        mission_title: string
        mission_goal: string
        constraints: readonly unknown[]
        mission_created_by: string
        task_title: string
        task_description: string
        review_required: boolean
        conversation_id: string | null
        context_snapshot: Readonly<Record<string, unknown>>
      }>(
        'SELECT r.workspace_id, r.mission_id, r.task_id, r.context_snapshot, m.project_id, m.conversation_id, ' +
        'a.role AS agent_role, a.model_provider, a.model_name, m.title AS mission_title, ' +
        'm.goal AS mission_goal, m.constraints, m.created_by AS mission_created_by, ' +
        "t.title AS task_title, t.description AS task_description, t.review_required, " +
        'tw.reconciliation_base_commit, tw.last_error AS worktree_last_error, ' +
        "CASE WHEN et.id IS NULL THEN p.default_branch " +
        "ELSE 'evaluation/trial-' || et.id END AS default_branch, " +
        "ev.definition->>'baselineCommit' AS expected_base_commit, " +
        '(et.id IS NOT NULL) AS allow_base_ref_advance ' +
        'FROM agent_runs r JOIN agents a ON a.id = r.agent_id ' +
        'JOIN missions m ON m.id = r.mission_id JOIN projects p ON p.id = m.project_id ' +
        'JOIN tasks t ON t.id = r.task_id ' +
        'LEFT JOIN task_worktrees tw ON tw.task_id = t.id ' +
        'LEFT JOIN evaluation_trials et ON et.mission_id = r.mission_id ' +
        'LEFT JOIN evaluation_scenario_versions ev ON ev.id = et.scenario_version_id ' +
        'WHERE r.id = $1 AND r.agent_id = $2 FOR UPDATE OF r',
        [runId, agentId],
      )
      const row = base.rows[0]
      if (!row) return null

      const storedContext = row.context_snapshot['executionContext']
      let frozen: FrozenExecutionContext
      if (isFrozen(storedContext)) {
        frozen = storedContext
      } else {
        const criteria = await client.query<{
          criterion_key: string
          description: string
          required: boolean
          required_evidence_kinds: EvidenceKind[]
        }>(
          'SELECT criterion_key, description, required, required_evidence_kinds ' +
          'FROM task_acceptance_criteria WHERE task_id = $1 ORDER BY criterion_key',
          [row.task_id],
        )
        const skills = await client.query<{
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
          ')) WHERE a.agent_id = $1 AND a.enabled AND s.status = $2 ' +
          'ORDER BY a.priority, s.id',
          [agentId, 'active'],
        )
        const conversationMessages = row.conversation_id === null
          ? { rows: [] as {
              id: string
              author_kind: 'user' | 'agent' | 'system'
              author_id: string
              author_name: string
              body: string
              created_at: Date
            }[] }
          : await client.query<{
              id: string
              author_kind: 'user' | 'agent' | 'system'
              author_id: string
              author_name: string
              body: string
              created_at: Date
            }>(
              'SELECT message.id, message.author_kind, message.author_id, ' +
              "COALESCE(user_account.display_name, agent.name, message.author_id) AS author_name, " +
              'message.body, message.created_at FROM messages message ' +
              "LEFT JOIN users user_account ON message.author_kind = 'user' AND user_account.id = message.author_id " +
              "LEFT JOIN agents agent ON message.author_kind = 'agent' AND agent.id = message.author_id " +
              'WHERE message.conversation_id = $1 ' +
              "AND message.entity_refs->>'missionId' = $2 " +
              'ORDER BY message.sequence DESC LIMIT 30',
              [row.conversation_id, row.mission_id],
            )
        await ensurePrimaryMissionArtifact(client, {
          workspaceId: row.workspace_id as WorkspaceId,
          projectId: row.project_id as ProjectId,
          missionId: row.mission_id as MissionId,
          missionTitle: row.mission_title,
          createdBy: row.mission_created_by,
        })
        const artifacts = await client.query<{
          readonly id: string
          readonly title: string
          readonly kind: string
        }>(
          'SELECT id, title, kind FROM artifacts ' +
          'WHERE workspace_id = $1 AND project_id = $2 AND mission_id = $3 ' +
          "ORDER BY CASE WHEN kind = 'mission_deliverable' THEN 0 ELSE 1 END, created_at, id",
          [row.workspace_id, row.project_id, row.mission_id],
        )
        frozen = {
          schemaVersion: 1,
          agentRole: row.agent_role,
          modelProvider: row.model_provider,
          modelName: row.model_name,
          defaultBranch: row.default_branch,
          ...(row.expected_base_commit === null ? {} : { expectedBaseCommit: row.expected_base_commit }),
          ...(row.allow_base_ref_advance ? { allowBaseRefAdvance: true } : {}),
          ...(row.reconciliation_base_commit === null
            ? {}
            : {
                integrationRecovery: {
                  baseCommit: row.reconciliation_base_commit,
                  error: row.worktree_last_error ?? {},
                },
              }),
          missionTitle: row.mission_title,
          missionGoal: row.mission_goal,
          missionConstraints: row.constraints,
          taskTitle: row.task_title,
          taskDescription: row.task_description,
          reviewRequired: row.review_required,
          acceptanceCriteria: criteria.rows.map((criterion) => ({
            key: criterion.criterion_key,
            description: criterion.description,
            required: criterion.required,
            evidenceKinds: criterion.required_evidence_kinds,
          })),
          missionArtifacts: artifacts.rows.map((artifact) => ({
            id: artifact.id as ArtifactId,
            title: artifact.title,
            kind: artifact.kind,
          })),
          skills: skills.rows.map((skill) => ({
            skillId: skill.skill_id as SkillId,
            versionId: skill.version_id as SkillVersionId,
            name: skill.name,
            description: skill.description,
            instructions: skill.instructions,
            contentHash: skill.content_hash,
            estimatedTokens: skill.estimated_tokens,
            priority: skill.priority,
          })),
          ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id as ConversationId }),
          conversationMessages: [...conversationMessages.rows].reverse().map((message) => ({
            id: message.id as MessageId,
            authorKind: message.author_kind,
            authorId: message.author_id,
            authorName: message.author_name,
            body: message.body,
            createdAt: message.created_at.toISOString() as IsoTimestamp,
          })),
        } satisfies FrozenExecutionContext
        if (conversationMessages.rows.length > 0) {
          await client.query(
            "UPDATE conversation_message_deliveries SET status = 'context_loaded', run_id = $1, delivered_at = NOW() " +
            "WHERE agent_id = $2 AND status = 'context_pending' AND message_id = ANY($3::text[])",
            [runId, agentId, conversationMessages.rows.map((message) => message.id)],
          )
        }
        const frozenHash = hash(frozen)
        await client.query(
          'UPDATE agent_runs SET context_snapshot = context_snapshot || $2::jsonb, updated_at = NOW() ' +
          'WHERE id = $1',
          [runId, canonicalJson({ executionContext: frozen, executionContextHash: frozenHash })],
        )
      }
      const frozenHash = hash(frozen)
      const storedHash = row.context_snapshot['executionContextHash']
      if (storedHash !== undefined && storedHash !== frozenHash) {
        throw new Error('Frozen execution context hash does not match its durable content')
      }
      return {
        workspaceId: row.workspace_id as WorkspaceId,
        missionId: row.mission_id as MissionId,
        projectId: row.project_id as ProjectId,
        taskId: row.task_id as TaskId,
        runId,
        agentId,
        agentRole: frozen.agentRole,
        modelProvider: frozen.modelProvider,
        modelName: frozen.modelName,
        defaultBranch: frozen.defaultBranch,
        ...(frozen.expectedBaseCommit === undefined ? {} : { expectedBaseCommit: frozen.expectedBaseCommit }),
        ...(frozen.allowBaseRefAdvance === undefined ? {} : { allowBaseRefAdvance: frozen.allowBaseRefAdvance }),
        ...(frozen.integrationRecovery === undefined
          ? {}
          : { integrationRecovery: frozen.integrationRecovery }),
        missionTitle: frozen.missionTitle,
        missionGoal: frozen.missionGoal,
        missionConstraints: frozen.missionConstraints,
        taskTitle: frozen.taskTitle,
        taskDescription: frozen.taskDescription,
        reviewRequired: frozen.reviewRequired ?? false,
        acceptanceCriteria: frozen.acceptanceCriteria,
        missionArtifacts: frozen.missionArtifacts ?? [],
        skills: frozen.skills,
        ...(frozen.conversationId === undefined ? {} : { conversationId: frozen.conversationId }),
        conversationMessages: frozen.conversationMessages ?? [],
        frozenContextHash: frozenHash,
      }
    })
  }
}

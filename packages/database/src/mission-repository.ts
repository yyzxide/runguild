import { createHash, randomUUID } from 'node:crypto'

import {
  type ActorRef,
  type AgentRole,
  type ArtifactId,
  type ArtifactVersionId,
  type CorrelationId,
  type IsoTimestamp,
  type MissionId,
  type MissionPlanDraft,
  type MissionStatus,
  type ProjectId,
  type TaskId,
  type TaskStatus,
  type UserId,
  type WorkspaceId,
  validateMissionPlan,
} from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { appendDomainEvent } from './events.js'
import { canonicalJson } from './json.js'
import { ensurePrimaryMissionArtifact } from './mission-artifact.js'
import { withTransaction } from './transaction.js'

function actorId(actor: ActorRef): string {
  return actor.id
}

function planHash(planJson: string): string {
  return createHash('sha256').update(planJson).digest('hex')
}

export interface CreateMissionInput {
  readonly missionId?: MissionId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly conversationId?: string
  readonly title: string
  readonly goal: string
  readonly constraints?: readonly string[]
  readonly acceptanceCriteria?: readonly string[]
  readonly actor: ActorRef
  readonly correlationId: CorrelationId
}

export interface ProposePlanInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly plan: MissionPlanDraft
  readonly actor: ActorRef
  readonly correlationId: CorrelationId
}

export type ProposePlanResult =
  | {
      readonly proposed: true
      readonly version: number
      readonly hash: string
      readonly reused: boolean
    }
  | {
      readonly proposed: false
      readonly reason: 'invalid_plan' | 'mission_not_plannable'
      readonly errors?: readonly { readonly path: string; readonly message: string }[]
    }

export interface ApprovePlanInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly expectedVersion: number
  readonly approvedBy: UserId
  readonly correlationId: CorrelationId
}

export type ApprovePlanResult =
  | {
      readonly approved: true
      readonly version: number
      readonly taskIdsByKey: Readonly<Record<string, TaskId>>
    }
  | {
      readonly approved: false
      readonly reason: 'version_conflict' | 'mission_not_approvable' | 'invalid_stored_plan'
    }

export interface ApproveMissionDeliveryInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly expectedArtifactVersionId: ArtifactVersionId
  readonly approvedBy: UserId
  readonly correlationId: CorrelationId
}

export type ApproveMissionDeliveryResult =
  | {
      readonly approved: true
      readonly artifactVersionId: ArtifactVersionId
      readonly reused: boolean
    }
  | {
      readonly approved: false
      readonly reason:
        | 'mission_not_approvable'
        | 'incomplete_tasks'
        | 'delivery_not_found'
        | 'version_conflict'
        | 'approver_not_member'
    }

export interface MissionDeliverySnapshot {
  readonly artifactVersionId: ArtifactVersionId
  readonly artifactId: ArtifactId
  readonly version: number
  readonly contentHash: string
  readonly approvalStatus: 'ready' | 'approved'
  readonly approvedBy?: UserId
  readonly approvedAt?: IsoTimestamp
}

export interface MissionSnapshot {
  readonly id: MissionId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly title: string
  readonly goal: string
  readonly status: MissionStatus
  readonly planVersion: number
  readonly updatedAt: string
  readonly finalDelivery: MissionDeliverySnapshot | null
  readonly proposedPlan: {
    readonly version: number
    readonly status: string
    readonly summary: string
    readonly hash: string
    readonly plan: MissionPlanDraft
  } | null
  readonly tasks: readonly {
    readonly id: TaskId
    readonly title: string
    readonly status: TaskStatus
    readonly role: AgentRole | null
    readonly priority: number
    readonly dependsOn: readonly TaskId[]
  }[]
}

export class MissionRepository {
  constructor(private readonly pool: Pool) {}

  async createMission(input: CreateMissionInput): Promise<MissionId> {
    if (!input.title.trim() || input.title.length > 200) {
      throw new Error('Mission title must be between 1 and 200 characters')
    }
    if (!input.goal.trim() || input.goal.length > 20_000) {
      throw new Error('Mission goal must be between 1 and 20000 characters')
    }
    const missionId = input.missionId ?? ('mission_' + randomUUID()) as MissionId

    await withTransaction(this.pool, async (client) => {
      const project = await client.query(
        'SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2 ' +
        'AND archived_at IS NULL FOR SHARE',
        [input.projectId, input.workspaceId],
      )
      if (!project.rows[0]) throw new Error('Project was not found or is archived')
      await client.query(
        'INSERT INTO missions ' +
        '(id, workspace_id, project_id, conversation_id, title, goal, constraints, acceptance_criteria, status, created_by) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'planning', $9)",
        [
          missionId,
          input.workspaceId,
          input.projectId,
          input.conversationId ?? null,
          input.title.trim(),
          input.goal.trim(),
          canonicalJson(input.constraints ?? []),
          canonicalJson(input.acceptanceCriteria ?? []),
          actorId(input.actor),
        ],
      )
      await ensurePrimaryMissionArtifact(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        missionId,
        missionTitle: input.title.trim(),
        createdBy: actorId(input.actor),
      })
      await appendDomainEvent(client, {
        type: 'mission.created',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        missionId,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { title: input.title.trim() },
      })
      await appendDomainEvent(client, {
        type: 'mission.status_changed',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        missionId,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: {
          from: 'draft',
          to: 'planning',
          reason: 'mission created and ready for planning',
        },
      })
    })
    return missionId
  }

  async proposePlan(input: ProposePlanInput): Promise<ProposePlanResult> {
    const validation = validateMissionPlan(input.plan)
    if (!validation.valid) {
      return {
        proposed: false,
        reason: 'invalid_plan',
        errors: validation.errors.map((error) => ({ path: error.path, message: error.message })),
      }
    }
    const planJson = canonicalJson(input.plan)
    const hash = planHash(planJson)

    return withTransaction(this.pool, async (client) => {
      const mission = await client.query<{
        readonly project_id: string
        readonly status: MissionStatus
        readonly plan_version: number
      }>(
        'SELECT project_id, status, plan_version FROM missions ' +
        'WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [input.missionId, input.workspaceId],
      )
      const row = mission.rows[0]
      if (!row || !['planning', 'awaiting_approval'].includes(row.status)) {
        return { proposed: false, reason: 'mission_not_plannable' }
      }

      const existing = await client.query<{ version: number }>(
        "SELECT version FROM mission_plan_revisions WHERE mission_id = $1 AND plan_hash = $2 AND status = 'proposed'",
        [input.missionId, hash],
      )
      if (existing.rows[0]) {
        return {
          proposed: true,
          version: existing.rows[0].version,
          hash,
          reused: true,
        }
      }

      await client.query(
        "UPDATE mission_plan_revisions SET status = 'superseded' " +
        "WHERE mission_id = $1 AND status = 'proposed'",
        [input.missionId],
      )
      const version = row.plan_version + 1
      await client.query(
        'INSERT INTO mission_plan_revisions ' +
        '(id, workspace_id, mission_id, version, summary, plan, plan_hash, created_by) ' +
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)",
        [
          'plan_' + randomUUID(),
          input.workspaceId,
          input.missionId,
          version,
          input.plan.summary,
          planJson,
          hash,
          actorId(input.actor),
        ],
      )
      await client.query(
        "UPDATE missions SET status = 'awaiting_approval', plan_version = $2, updated_at = NOW() WHERE id = $1",
        [input.missionId, version],
      )
      await client.query(
        "UPDATE approvals SET status = 'cancelled', resolved_at = NOW(), resolved_by = $2 " +
        "WHERE mission_id = $1 AND subject_type = 'mission' " +
        "AND kind LIKE 'mission_plan:%' AND status = 'pending'",
        [input.missionId, actorId(input.actor)],
      )
      await client.query(
        'INSERT INTO approvals ' +
        '(id, workspace_id, mission_id, subject_type, subject_id, kind, status, requested_by, reason) ' +
        "VALUES ($1, $2, $3, 'mission', $3, $4, 'pending', $5, $6)",
        [
          'approval_' + randomUUID(),
          input.workspaceId,
          input.missionId,
          'mission_plan:' + version,
          actorId(input.actor),
          'Approve executable mission plan version ' + version,
        ],
      )

      const projectId = row.project_id as ProjectId
      if (row.status === 'planning') {
        await appendDomainEvent(client, {
          type: 'mission.status_changed',
          workspaceId: input.workspaceId,
          projectId,
          missionId: input.missionId,
          actor: input.actor,
          correlationId: input.correlationId,
          payload: {
            from: 'planning',
            to: 'awaiting_approval',
            reason: 'planner proposed an executable task graph',
          },
        })
      }
      await appendDomainEvent(client, {
        type: 'mission.plan_proposed',
        workspaceId: input.workspaceId,
        projectId,
        missionId: input.missionId,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: {
          version,
          planHash: hash,
          taskCount: input.plan.tasks.length,
        },
      })
      return { proposed: true, version, hash, reused: false }
    })
  }

  async approvePlan(input: ApprovePlanInput): Promise<ApprovePlanResult> {
    return withTransaction(this.pool, async (client) => {
      const mission = await client.query<{
        readonly project_id: string
        readonly status: MissionStatus
        readonly plan_version: number
      }>(
        'SELECT project_id, status, plan_version FROM missions ' +
        'WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [input.missionId, input.workspaceId],
      )
      const missionRow = mission.rows[0]
      if (!missionRow || missionRow.status !== 'awaiting_approval') {
        return { approved: false, reason: 'mission_not_approvable' }
      }
      if (missionRow.plan_version !== input.expectedVersion) {
        return { approved: false, reason: 'version_conflict' }
      }

      const revision = await client.query<{ readonly id: string; readonly plan: MissionPlanDraft }>(
        "SELECT id, plan FROM mission_plan_revisions " +
        "WHERE mission_id = $1 AND version = $2 AND status = 'proposed' FOR UPDATE",
        [input.missionId, input.expectedVersion],
      )
      const revisionRow = revision.rows[0]
      if (!revisionRow) {
        return { approved: false, reason: 'version_conflict' }
      }
      const validation = validateMissionPlan(revisionRow.plan)
      if (!validation.valid) {
        return { approved: false, reason: 'invalid_stored_plan' }
      }

      const existingTasks = await client.query('SELECT 1 FROM tasks WHERE mission_id = $1 LIMIT 1', [input.missionId])
      if ((existingTasks.rowCount ?? 0) > 0) {
        return { approved: false, reason: 'mission_not_approvable' }
      }
      const approval = await client.query(
        "UPDATE approvals SET status = 'approved', resolved_by = $3, resolved_at = NOW() " +
        "WHERE mission_id = $1 AND kind = $2 AND status = 'pending' RETURNING id",
        [input.missionId, 'mission_plan:' + input.expectedVersion, input.approvedBy],
      )
      if (approval.rowCount !== 1) {
        return { approved: false, reason: 'mission_not_approvable' }
      }

      const taskIdsByKey: Record<string, TaskId> = {}
      for (const task of revisionRow.plan.tasks) {
        taskIdsByKey[task.key] = ('task_' + randomUUID()) as TaskId
      }

      for (const [position, task] of revisionRow.plan.tasks.entries()) {
        const taskId = taskIdsByKey[task.key]
        if (!taskId) throw new Error('Task id mapping is missing for ' + task.key)
        await client.query(
          'INSERT INTO tasks ' +
          '(id, mission_id, title, description, status, required_role, priority, position, review_required) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            taskId,
            input.missionId,
            task.title,
            task.description,
            task.dependsOn.length === 0 ? 'ready' : 'blocked',
            task.role as AgentRole,
            task.priority,
            position,
            task.reviewRequired,
          ],
        )
        for (const criterion of task.acceptanceCriteria) {
          await client.query(
            'INSERT INTO task_acceptance_criteria ' +
            '(id, task_id, criterion_key, description, required, required_evidence_kinds) ' +
            'VALUES ($1, $2, $3, $4, $5, $6)',
            [
              'criterion_' + randomUUID(),
              taskId,
              criterion.key,
              criterion.description,
              criterion.required,
              criterion.evidenceKinds,
            ],
          )
        }
      }

      for (const task of revisionRow.plan.tasks) {
        const taskId = taskIdsByKey[task.key]
        if (!taskId) throw new Error('Task id mapping is missing for ' + task.key)
        for (const parentKey of task.dependsOn) {
          const parentId = taskIdsByKey[parentKey]
          if (!parentId) throw new Error('Dependency mapping is missing for ' + parentKey)
          await client.query(
            'INSERT INTO task_dependencies (mission_id, task_id, depends_on_task_id) VALUES ($1, $2, $3)',
            [input.missionId, taskId, parentId],
          )
        }
      }

      await client.query(
        "UPDATE mission_plan_revisions SET status = 'approved', approved_by = $3, approved_at = NOW() " +
        'WHERE id = $1 AND version = $2',
        [revisionRow.id, input.expectedVersion, input.approvedBy],
      )
      await client.query(
        "UPDATE missions SET status = 'running', approved_by = $2, approved_at = NOW(), updated_at = NOW() " +
        'WHERE id = $1',
        [input.missionId, input.approvedBy],
      )

      const projectId = missionRow.project_id as ProjectId
      const actor = { kind: 'user', id: input.approvedBy } as const
      for (const task of revisionRow.plan.tasks) {
        const taskId = taskIdsByKey[task.key]
        if (!taskId) continue
        await appendDomainEvent(client, {
          type: 'task.created',
          workspaceId: input.workspaceId,
          projectId,
          missionId: input.missionId,
          actor,
          correlationId: input.correlationId,
          payload: {
            taskId,
            title: task.title,
            dependsOn: task.dependsOn.map((key) => taskIdsByKey[key]).filter((id): id is TaskId => id !== undefined),
          },
        })
      }
      await appendDomainEvent(client, {
        type: 'mission.plan_approved',
        workspaceId: input.workspaceId,
        projectId,
        missionId: input.missionId,
        actor,
        correlationId: input.correlationId,
        payload: { taskIds: Object.values(taskIdsByKey) },
      })
      await appendDomainEvent(client, {
        type: 'mission.status_changed',
        workspaceId: input.workspaceId,
        projectId,
        missionId: input.missionId,
        actor,
        correlationId: input.correlationId,
        payload: {
          from: 'awaiting_approval',
          to: 'running',
          reason: 'human approved plan version ' + input.expectedVersion,
        },
      })

      return {
        approved: true,
        version: input.expectedVersion,
        taskIdsByKey,
      }
    })
  }

  async approveDelivery(input: ApproveMissionDeliveryInput): Promise<ApproveMissionDeliveryResult> {
    return withTransaction(this.pool, async (client) => {
      const mission = await client.query<{
        readonly project_id: string
        readonly status: MissionStatus
      }>(
        'SELECT project_id, status FROM missions WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [input.missionId, input.workspaceId],
      )
      const row = mission.rows[0]
      if (!row) return { approved: false, reason: 'mission_not_approvable' }

      if (row.status === 'completed') {
        const existing = await client.query<{ readonly artifact_version_id: string; readonly resolved_by: string | null }>(
          "SELECT artifact_version_id, resolved_by FROM approvals WHERE mission_id = $1 " +
          "AND kind = 'mission_delivery' AND status = 'approved' ORDER BY resolved_at DESC LIMIT 1",
          [input.missionId],
        )
        const approval = existing.rows[0]
        if (approval?.artifact_version_id === input.expectedArtifactVersionId
            && approval.resolved_by === input.approvedBy) {
          return {
            approved: true,
            artifactVersionId: input.expectedArtifactVersionId,
            reused: true,
          }
        }
        return { approved: false, reason: 'mission_not_approvable' }
      }
      if (row.status !== 'reviewing') {
        return { approved: false, reason: 'mission_not_approvable' }
      }

      const member = await client.query(
        'SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2',
        [input.approvedBy, input.workspaceId],
      )
      if (!member.rows[0]) return { approved: false, reason: 'approver_not_member' }

      const incomplete = await client.query<{ readonly incomplete: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM tasks WHERE mission_id = $1 AND status <> 'completed') AS incomplete",
        [input.missionId],
      )
      if (incomplete.rows[0]?.incomplete) {
        return { approved: false, reason: 'incomplete_tasks' }
      }

      const candidate = await this.readDeliveryCandidate(client, input.missionId)
      if (!candidate) return { approved: false, reason: 'delivery_not_found' }
      if (candidate.artifactVersionId !== input.expectedArtifactVersionId) {
        return { approved: false, reason: 'version_conflict' }
      }

      await client.query(
        'INSERT INTO approvals ' +
        '(id, workspace_id, mission_id, artifact_version_id, subject_type, subject_id, kind, status, ' +
        'requested_by, resolved_by, reason, resolved_at) ' +
        "VALUES ($1, $2, $3, $4, 'artifact_version', $4, 'mission_delivery', 'approved', " +
        "$5, $5, 'Human approved the exact final Mission deliverable', NOW())",
        [
          'approval_' + randomUUID(),
          input.workspaceId,
          input.missionId,
          candidate.artifactVersionId,
          input.approvedBy,
        ],
      )
      await client.query(
        "UPDATE missions SET status = 'completed', updated_at = NOW() WHERE id = $1 AND status = 'reviewing'",
        [input.missionId],
      )
      await appendDomainEvent(client, {
        type: 'mission.status_changed',
        workspaceId: input.workspaceId,
        projectId: row.project_id as ProjectId,
        missionId: input.missionId,
        actor: { kind: 'user', id: input.approvedBy },
        correlationId: input.correlationId,
        payload: {
          from: 'reviewing',
          to: 'completed',
          reason: 'human approved final Artifact Version ' + candidate.artifactVersionId,
        },
      })
      return {
        approved: true,
        artifactVersionId: candidate.artifactVersionId,
        reused: false,
      }
    })
  }

  async getMission(workspaceId: WorkspaceId, missionId: MissionId): Promise<MissionSnapshot | null> {
    return withTransaction(this.pool, async (client) => {
      const mission = await client.query<{
        readonly id: string
        readonly workspace_id: string
        readonly project_id: string
        readonly title: string
        readonly goal: string
        readonly status: MissionStatus
        readonly plan_version: number
        readonly updated_at: Date
      }>(
        'SELECT id, workspace_id, project_id, title, goal, status, plan_version, updated_at ' +
        'FROM missions WHERE id = $1 AND workspace_id = $2',
        [missionId, workspaceId],
      )
      const row = mission.rows[0]
      if (!row) return null

      const plan = await client.query<{
          readonly version: number
          readonly status: string
          readonly summary: string
          readonly plan_hash: string
          readonly plan: MissionPlanDraft
        }>(
          'SELECT version, status, summary, plan_hash, plan FROM mission_plan_revisions ' +
          'WHERE mission_id = $1 ORDER BY version DESC LIMIT 1',
          [missionId],
        )
      const tasks = await client.query<{
          readonly id: string
          readonly title: string
          readonly status: TaskStatus
          readonly required_role: AgentRole | null
          readonly priority: number
          readonly depends_on: string[]
        }>(
          'SELECT t.id, t.title, t.status, t.required_role, t.priority, ' +
          "COALESCE(array_agg(d.depends_on_task_id ORDER BY d.depends_on_task_id) " +
          "FILTER (WHERE d.depends_on_task_id IS NOT NULL), ARRAY[]::TEXT[]) AS depends_on " +
          'FROM tasks t LEFT JOIN task_dependencies d ON d.task_id = t.id ' +
          'WHERE t.mission_id = $1 GROUP BY t.id ORDER BY t.position, t.created_at',
          [missionId],
        )
      const approvedDelivery = await client.query<{
          readonly artifact_version_id: string
          readonly artifact_id: string
          readonly version: number
          readonly content_hash: string
          readonly resolved_by: string
          readonly resolved_at: Date
        }>(
          'SELECT approval.artifact_version_id, version.artifact_id, version.version, version.content_hash, ' +
          'approval.resolved_by, approval.resolved_at FROM approvals approval ' +
          'JOIN artifact_versions version ON version.id = approval.artifact_version_id ' +
          "WHERE approval.mission_id = $1 AND approval.kind = 'mission_delivery' " +
          "AND approval.status = 'approved' ORDER BY approval.resolved_at DESC LIMIT 1",
          [missionId],
        )
      const planRow = plan.rows[0]
      const approvedDeliveryRow = approvedDelivery.rows[0]
      const finalDelivery = approvedDeliveryRow
        ? {
            artifactVersionId: approvedDeliveryRow.artifact_version_id as ArtifactVersionId,
            artifactId: approvedDeliveryRow.artifact_id as ArtifactId,
            version: approvedDeliveryRow.version,
            contentHash: approvedDeliveryRow.content_hash,
            approvalStatus: 'approved' as const,
            approvedBy: approvedDeliveryRow.resolved_by as UserId,
            approvedAt: approvedDeliveryRow.resolved_at.toISOString() as IsoTimestamp,
          }
        : await this.readDeliveryCandidate(client, missionId)
      return {
        id: row.id as MissionId,
        workspaceId: row.workspace_id as WorkspaceId,
        projectId: row.project_id as ProjectId,
        title: row.title,
        goal: row.goal,
        status: row.status,
        planVersion: row.plan_version,
        updatedAt: row.updated_at.toISOString(),
        finalDelivery,
        proposedPlan: planRow
          ? {
              version: planRow.version,
              status: planRow.status,
              summary: planRow.summary,
              hash: planRow.plan_hash,
              plan: planRow.plan,
            }
          : null,
        tasks: tasks.rows.map((task) => ({
          id: task.id as TaskId,
          title: task.title,
          status: task.status,
          role: task.required_role,
          priority: task.priority,
          dependsOn: task.depends_on.map((id) => id as TaskId),
        })),
      }
    }, 'repeatable read')
  }

  private async readDeliveryCandidate(
    client: Pick<PoolClient, 'query'>,
    missionId: MissionId,
  ): Promise<MissionDeliverySnapshot | null> {
    const result = await client.query<{
      readonly id: string
      readonly artifact_id: string
      readonly version: number
      readonly content_hash: string
    }>(
      'SELECT version.id, version.artifact_id, version.version, version.content_hash ' +
      'FROM artifact_versions version JOIN artifacts artifact ON artifact.id = version.artifact_id ' +
      'WHERE artifact.mission_id = $1 ' +
      'ORDER BY EXISTS (' +
      '  SELECT 1 FROM task_submissions submission JOIN reviews review ON review.submission_id = submission.id ' +
      "  WHERE submission.artifact_version_id = version.id AND submission.status = 'approved' " +
      "  AND review.status = 'approved'" +
      ') DESC, version.created_at DESC, version.version DESC, version.id DESC LIMIT 1',
      [missionId],
    )
    const row = result.rows[0]
    return row
      ? {
          artifactVersionId: row.id as ArtifactVersionId,
          artifactId: row.artifact_id as ArtifactId,
          version: row.version,
          contentHash: row.content_hash,
          approvalStatus: 'ready',
        }
      : null
  }
}

import { createHash, randomUUID } from 'node:crypto'

import type {
  ActorRef,
  AgentId,
  ArtifactReview,
  ArtifactVersionId,
  CorrelationId,
  IsoTimestamp,
  MissionId,
  ProjectId,
  ReviewFinding,
  ReviewId,
  RunId,
  TaskId,
  TaskSubmission,
  TaskSubmissionId,
  TaskSubmissionStatus,
  UserId,
  WorkspaceId,
} from '@runguild/protocol'
import { EVENT_TOPICS } from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { appendDomainEvent } from './events.js'
import { canonicalJson } from './json.js'
import { TaskRepository, type CompleteTaskResult } from './task-repository.js'
import { withTransaction } from './transaction.js'

interface SubmissionRow {
  readonly id: string
  readonly workspace_id: string
  readonly mission_id: string
  readonly task_id: string
  readonly run_id: string
  readonly artifact_version_id: string
  readonly submitted_by_agent_id: string
  readonly status: TaskSubmissionStatus
  readonly evidence_bundle_hash: string
  readonly note: string
  readonly created_at: Date
  readonly updated_at: Date
}

interface ReviewRow {
  readonly id: string
  readonly submission_id: string
  readonly reviewer_kind: 'user' | 'agent'
  readonly reviewer_id: string
  readonly reviewer_run_id: string | null
  readonly status: ArtifactReview['status']
  readonly findings: readonly ReviewFinding[]
  readonly summary: string
  readonly created_at: Date
  readonly completed_at: Date | null
}

const SUBMISSION_COLUMNS =
  'id, workspace_id, mission_id, task_id, run_id, artifact_version_id, ' +
  'submitted_by_agent_id, status, evidence_bundle_hash, note, created_at, updated_at'

const REVIEW_COLUMNS =
  'id, submission_id, reviewer_kind, reviewer_id, reviewer_run_id, status, ' +
  'findings, summary, created_at, completed_at'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asSubmission(row: SubmissionRow): TaskSubmission {
  return {
    id: row.id as TaskSubmissionId,
    workspaceId: row.workspace_id as WorkspaceId,
    missionId: row.mission_id as MissionId,
    taskId: row.task_id as TaskId,
    runId: row.run_id as RunId,
    artifactVersionId: row.artifact_version_id as ArtifactVersionId,
    submittedByAgentId: row.submitted_by_agent_id as AgentId,
    status: row.status,
    evidenceBundleHash: row.evidence_bundle_hash,
    note: row.note,
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    updatedAt: row.updated_at.toISOString() as IsoTimestamp,
  }
}

function asReview(row: ReviewRow): ArtifactReview {
  const reviewer: ActorRef = row.reviewer_kind === 'user'
    ? { kind: 'user', id: row.reviewer_id as UserId }
    : {
        kind: 'agent',
        id: row.reviewer_id as AgentId,
        ...(row.reviewer_run_id === null ? {} : { runId: row.reviewer_run_id as RunId }),
      }
  return {
    id: row.id as ReviewId,
    submissionId: row.submission_id as TaskSubmissionId,
    status: row.status,
    reviewer,
    summary: row.summary,
    findings: row.findings,
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() as IsoTimestamp }),
  }
}

export interface SubmitArtifactVersionInput {
  readonly submissionId?: TaskSubmissionId
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly artifactVersionId: ArtifactVersionId
  readonly note?: string
}

export interface ReviewSubmissionInput {
  readonly reviewId?: ReviewId
  readonly workspaceId: WorkspaceId
  readonly submissionId: TaskSubmissionId
  readonly reviewer: Extract<ActorRef, { readonly kind: 'user' | 'agent' }>
  readonly decision: ArtifactReview['status']
  readonly summary: string
  readonly findings: readonly ReviewFinding[]
  readonly correlationId: CorrelationId
}

export interface ReviewSubmissionResult {
  readonly submission: TaskSubmission
  readonly review: ArtifactReview
  readonly taskCompletion?: CompleteTaskResult
}

export interface SubmissionDetails {
  readonly submission: TaskSubmission
  readonly review: ArtifactReview | null
}

export class ReviewRepository {
  private readonly tasks: TaskRepository

  constructor(private readonly pool: Pool) {
    this.tasks = new TaskRepository(pool)
  }

  async submitArtifactVersion(input: SubmitArtifactVersionInput): Promise<TaskSubmission> {
    const note = input.note?.trim() ?? ''
    if (note.length > 10_000) throw new RangeError('Submission note exceeds 10000 characters')
    return withTransaction(this.pool, async (client) => {
      const scope = await client.query<{
        task_status: string
        run_status: string
        content_hash: string
        version_run_id: string | null
        worktree_status: string | null
        worktree_head_commit: string | null
        worktree_base_commit: string | null
        worktree_integrated_commit: string | null
        review_required: boolean
      }>(
        'SELECT t.status AS task_status, r.status AS run_status, v.content_hash, ' +
        'v.created_by_run_id AS version_run_id, tw.status AS worktree_status, ' +
        'tw.head_commit AS worktree_head_commit, tw.base_commit AS worktree_base_commit, ' +
        'tw.integrated_commit AS worktree_integrated_commit, t.review_required ' +
        'FROM agent_runs r JOIN tasks t ON t.id = r.task_id ' +
        'JOIN artifact_versions v ON v.id = $6 ' +
        'JOIN artifacts a ON a.id = v.artifact_id ' +
        'LEFT JOIN task_worktrees tw ON tw.task_id = t.id ' +
        'WHERE r.id = $4 AND r.workspace_id = $1 AND r.mission_id = $2 ' +
        'AND r.task_id = $3 AND r.agent_id = $5 ' +
        'AND a.workspace_id = $1 AND a.mission_id = $2 FOR UPDATE OF t',
        [
          input.workspaceId,
          input.missionId,
          input.taskId,
          input.runId,
          input.agentId,
          input.artifactVersionId,
        ],
      )
      const scoped = scope.rows[0]
      if (!scoped) throw new Error('Submission Run, Task, or Artifact Version is outside scope')
      if (!['running', 'reviewing'].includes(scoped.task_status)) {
        throw new Error('Task is not accepting Artifact submissions')
      }
      if (!['running', 'waiting_human', 'succeeded'].includes(scoped.run_status)) {
        throw new Error('Run is not in a submittable state')
      }
      if (scoped.version_run_id !== input.runId) {
        throw new Error('Artifact Version was not created by the submitting Run')
      }

      const evidence = await client.query<{
        id: string
        kind: string
        content_hash: string | null
        metadata: Readonly<Record<string, unknown>>
      }>(
        'SELECT id, kind, content_hash, metadata FROM evidence ' +
        'WHERE task_id = $1 AND run_id = $2 AND (expires_at IS NULL OR expires_at > NOW()) ' +
        'ORDER BY kind, id',
        [input.taskId, input.runId],
      )
      if (!evidence.rows.some((item) =>
        item.kind === 'artifact_version' && item.content_hash === scoped.content_hash)) {
        throw new Error('Submission requires durable evidence for the exact Artifact Version')
      }
      if (scoped.worktree_status !== null) {
        const unchangedIntegrated = scoped.worktree_status === 'integrated'
          && scoped.worktree_base_commit !== null
          && scoped.worktree_head_commit === scoped.worktree_base_commit
          && scoped.worktree_integrated_commit === scoped.worktree_head_commit
        if (scoped.worktree_status !== 'committed' && !unchangedIntegrated) {
          throw new Error('Code submission requires a committed Task Worktree')
        }
        if (!unchangedIntegrated && !evidence.rows.some((item) =>
          item.kind === 'file_diff' && item.metadata.commit === scoped.worktree_head_commit)) {
          throw new Error('Submission requires durable evidence for the exact Task Worktree commit')
        }
      }
      const evidenceBundleHash = digest(canonicalJson({
        artifactVersionId: input.artifactVersionId,
        contentHash: scoped.content_hash,
        evidence: evidence.rows,
      }))

      const active = await client.query<SubmissionRow>(
        'SELECT ' + SUBMISSION_COLUMNS + ' FROM task_submissions ' +
        "WHERE task_id = $1 AND status IN ('submitted', 'in_review', 'approved') FOR UPDATE",
        [input.taskId],
      )
      if (active.rows[0]) {
        const current = active.rows[0]
        if (current.run_id === input.runId
            && current.artifact_version_id === input.artifactVersionId
            && current.evidence_bundle_hash === evidenceBundleHash) {
          return asSubmission(current)
        }
        throw new Error('Task already has an active Artifact submission')
      }

      const inserted = await client.query<SubmissionRow>(
        'INSERT INTO task_submissions ' +
        '(id, workspace_id, mission_id, task_id, run_id, artifact_version_id, ' +
        'submitted_by_agent_id, evidence_bundle_hash, note) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ' + SUBMISSION_COLUMNS,
        [
          input.submissionId ?? 'submission_' + randomUUID(),
          input.workspaceId,
          input.missionId,
          input.taskId,
          input.runId,
          input.artifactVersionId,
          input.agentId,
          evidenceBundleHash,
          note,
        ],
      )
      let row = inserted.rows[0]
      if (!row) throw new Error('Artifact submission was not persisted')
      if (scoped.review_required) {
        const reviewer = await client.query<{
          id: string
          model_provider: string
          model_name: string
        }>(
          'SELECT agent.id, agent.model_provider, agent.model_name FROM missions mission ' +
          'JOIN conversation_members member ON member.conversation_id = mission.conversation_id ' +
          "AND member.workspace_id = mission.workspace_id AND member.participant_kind = 'agent' " +
          'JOIN agents agent ON agent.id = member.participant_id AND agent.workspace_id = member.workspace_id ' +
          "WHERE mission.id = $1 AND mission.workspace_id = $2 AND agent.role = 'reviewer' " +
          "AND agent.status = 'active' AND agent.id <> $3 ORDER BY agent.created_at, agent.id LIMIT 1",
          [input.missionId, input.workspaceId, input.agentId],
        )
        const assigned = reviewer.rows[0]
        if (assigned) {
          const reviewId = ('review_' + randomUUID()) as ReviewId
          await client.query(
            'INSERT INTO reviews ' +
            '(id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id, ' +
            "reviewer_kind, reviewer_id, status, findings, summary) VALUES ($1, $2, $3, $4, $5, $6, 'agent', $6, " +
            "'requested', '[]'::jsonb, '')",
            [reviewId, input.workspaceId, input.missionId, input.taskId, row.id, assigned.id],
          )
          await client.query(
            'INSERT INTO review_executions ' +
            '(review_id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id, model_provider, model_name) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              reviewId,
              input.workspaceId,
              input.missionId,
              input.taskId,
              row.id,
              assigned.id,
              assigned.model_provider,
              assigned.model_name,
            ],
          )
          const inboxPayload = {
            schemaVersion: 1,
            type: 'artifact.review_requested',
            reviewId,
            submissionId: row.id,
            missionId: input.missionId,
            taskId: input.taskId,
          }
          const payloadJson = canonicalJson(inboxPayload)
          await client.query(
            'INSERT INTO inbox_messages ' +
            '(id, workspace_id, agent_id, mission_id, kind, payload, payload_hash, dedupe_key) ' +
            "VALUES ($1, $2, $3, $4, 'artifact.review_requested', $5::jsonb, $6, $7)",
            [
              'inbox_' + randomUUID(),
              input.workspaceId,
              assigned.id,
              input.missionId,
              payloadJson,
              digest(payloadJson),
              'artifact-review:' + reviewId,
            ],
          )
          await client.query(
            'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
            [
              'wake_' + randomUUID(),
              EVENT_TOPICS.agentWake,
              assigned.id,
              canonicalJson({
                schemaVersion: 1,
                type: 'agent.wake',
                workspaceId: input.workspaceId,
                missionId: input.missionId,
                agentId: assigned.id,
                reason: 'artifact.review_requested',
                reviewId,
              }),
            ],
          )
          const updated = await client.query<SubmissionRow>(
            "UPDATE task_submissions SET status = 'in_review', updated_at = NOW() WHERE id = $1 RETURNING " +
            SUBMISSION_COLUMNS,
            [row.id],
          )
          row = updated.rows[0] ?? row
        }
      }
      return asSubmission(row)
    })
  }

  async reviewSubmission(input: ReviewSubmissionInput): Promise<ReviewSubmissionResult> {
    if (!input.summary.trim() || input.summary.length > 20_000) {
      throw new Error('Review summary must be between 1 and 20000 characters')
    }
    if (!['approved', 'rejected', 'changes_requested'].includes(input.decision)) {
      throw new Error('Invalid review decision')
    }
    if (input.findings.length > 200 || Buffer.byteLength(JSON.stringify(input.findings)) > 256 * 1024) {
      throw new RangeError('Review findings exceed the safety limit')
    }

    const stored = await withTransaction(this.pool, async (client) => {
      const result = await client.query<SubmissionRow & {
        project_id: string
        task_status: string
        attempt_count: number
        max_attempts: number
      }>(
        'SELECT ' + SUBMISSION_COLUMNS.split(', ').map((column) => 's.' + column).join(', ') + ', ' +
        'm.project_id, t.status AS task_status, t.attempt_count, t.max_attempts ' +
        'FROM task_submissions s JOIN tasks t ON t.id = s.task_id ' +
        'JOIN missions m ON m.id = s.mission_id ' +
        'WHERE s.id = $1 AND s.workspace_id = $2 FOR UPDATE OF s, t',
        [input.submissionId, input.workspaceId],
      )
      const submission = result.rows[0]
      if (!submission) throw new Error('Artifact submission not found in workspace')
      const existingResult = await client.query<ReviewRow>(
        'SELECT ' + REVIEW_COLUMNS + ' FROM reviews WHERE submission_id = $1 FOR UPDATE',
        [input.submissionId],
      )
      const existingRow = existingResult.rows[0]
      if (!['submitted', 'in_review'].includes(submission.status)) {
        const existing = existingRow ? asReview(existingRow) : null
        if (existing
            && existing.status === input.decision
            && existing.reviewer.kind === input.reviewer.kind
            && existing.reviewer.id === input.reviewer.id) {
          return { submission: asSubmission(submission), review: existing }
        }
        throw new Error('Artifact submission already has a terminal review')
      }
      if (submission.task_status !== 'reviewing') {
        throw new Error('Task must be awaiting review before a decision is recorded')
      }
      if (input.reviewer.kind === 'agent' && input.reviewer.id === submission.submitted_by_agent_id) {
        throw new Error('Submitting Agent cannot review its own Artifact')
      }

      if (existingRow && !['requested', 'in_progress'].includes(existingRow.status)) {
        throw new Error('Artifact submission already has a terminal review')
      }
      if (existingRow && input.reviewer.kind === 'agent'
          && (existingRow.reviewer_kind !== 'agent' || existingRow.reviewer_id !== input.reviewer.id)) {
        throw new Error('Artifact submission is assigned to a different Reviewer Agent')
      }

      const reviewId = existingRow?.id as ReviewId | undefined
        ?? input.reviewId
        ?? ('review_' + randomUUID()) as ReviewId
      const storedReview = existingRow
        ? await client.query<ReviewRow>(
            'UPDATE reviews SET reviewer_agent_id = $2, reviewer_kind = $3, reviewer_id = $4, ' +
            'reviewer_run_id = $5, status = $6, findings = $7::jsonb, summary = $8, completed_at = NOW() ' +
            'WHERE id = $1 RETURNING ' + REVIEW_COLUMNS,
            [
              reviewId,
              input.reviewer.kind === 'agent' ? input.reviewer.id : null,
              input.reviewer.kind,
              input.reviewer.id,
              input.reviewer.kind === 'agent' ? input.reviewer.runId ?? null : null,
              input.decision,
              canonicalJson(input.findings),
              input.summary.trim(),
            ],
          )
        : await client.query<ReviewRow>(
            'INSERT INTO reviews ' +
            '(id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id, ' +
            'reviewer_kind, reviewer_id, reviewer_run_id, status, findings, summary, completed_at) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, NOW()) ' +
            'RETURNING ' + REVIEW_COLUMNS,
            [
              reviewId,
              submission.workspace_id,
              submission.mission_id,
              submission.task_id,
              submission.id,
              input.reviewer.kind === 'agent' ? input.reviewer.id : null,
              input.reviewer.kind,
              input.reviewer.id,
              input.reviewer.kind === 'agent' ? input.reviewer.runId ?? null : null,
              input.decision,
              canonicalJson(input.findings),
              input.summary.trim(),
            ],
          )
      const review = storedReview.rows[0]
      if (!review) throw new Error('Review decision was not persisted')
      if (existingRow && input.reviewer.kind === 'user') {
        await client.query(
          "UPDATE review_executions SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL, " +
          'finished_at = NOW(), updated_at = NOW() WHERE review_id = $1',
          [reviewId],
        )
      }
      const submissionStatus: TaskSubmissionStatus = input.decision === 'approved' ? 'approved' : 'rejected'
      const updated = await client.query<SubmissionRow>(
        'UPDATE task_submissions SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING ' +
        SUBMISSION_COLUMNS,
        [submission.id, submissionStatus],
      )
      const updatedSubmission = updated.rows[0]
      if (!updatedSubmission) throw new Error('Submission decision was not persisted')

      await appendDomainEvent(client, {
        type: 'review.status_changed',
        workspaceId: input.workspaceId,
        projectId: submission.project_id as ProjectId,
        missionId: submission.mission_id as MissionId,
        actor: input.reviewer,
        correlationId: input.correlationId,
        payload: {
          reviewId,
          from: existingRow?.status ?? 'requested',
          to: input.decision,
          evidence: [],
        },
      })

      if (input.decision !== 'approved') {
        const nextTaskStatus = input.decision === 'changes_requested'
          && submission.attempt_count < submission.max_attempts
          ? 'ready'
          : 'failed'
        await client.query(
          'UPDATE tasks SET status = $2, updated_at = NOW() WHERE id = $1',
          [submission.task_id, nextTaskStatus],
        )
        await appendDomainEvent(client, {
          type: 'task.status_changed',
          workspaceId: input.workspaceId,
          projectId: submission.project_id as ProjectId,
          missionId: submission.mission_id as MissionId,
          actor: input.reviewer,
          correlationId: input.correlationId,
          payload: {
            taskId: submission.task_id as TaskId,
            from: 'reviewing',
            to: nextTaskStatus,
            reason: input.summary.trim(),
          },
        })
      }
      return { submission: asSubmission(updatedSubmission), review: asReview(review) }
    })

    if (input.decision !== 'approved') return stored
    const taskCompletion = await this.tasks.completeTaskAndUnlockDependents({
      workspaceId: stored.submission.workspaceId as WorkspaceId,
      missionId: stored.submission.missionId as MissionId,
      taskId: stored.submission.taskId,
      actor: input.reviewer,
      correlationId: input.correlationId,
    })
    return { ...stored, taskCompletion }
  }

  async getSubmission(
    workspaceId: WorkspaceId,
    submissionId: TaskSubmissionId,
  ): Promise<SubmissionDetails | null> {
    const result = await this.pool.query<SubmissionRow>(
      'SELECT ' + SUBMISSION_COLUMNS + ' FROM task_submissions WHERE id = $1 AND workspace_id = $2',
      [submissionId, workspaceId],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      submission: asSubmission(row),
      review: await this.readReview(this.pool, submissionId),
    }
  }

  private async readReview(
    client: Pick<Pool, 'query'> | PoolClient,
    submissionId: TaskSubmissionId,
  ): Promise<ArtifactReview | null> {
    const result = await client.query<ReviewRow>(
      'SELECT ' + REVIEW_COLUMNS + ' FROM reviews WHERE submission_id = $1',
      [submissionId],
    )
    return result.rows[0] ? asReview(result.rows[0]) : null
  }
}

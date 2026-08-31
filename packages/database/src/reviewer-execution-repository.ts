import { createHash, randomUUID } from 'node:crypto'

import type {
  AgentId,
  ArtifactReview,
  ArtifactVersionId,
  EvidenceId,
  CorrelationId,
  MissionId,
  ProjectId,
  ReviewFinding,
  ReviewId,
  TaskId,
  TaskSubmissionId,
  UserId,
  WorkspaceId,
} from '@runguild/protocol'
import { EVENT_TOPICS } from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { canonicalJson } from './json.js'
import { appendDomainEvent } from './events.js'
import { withTransaction } from './transaction.js'

export type ReviewerDecisionStatus = 'approved' | 'rejected' | 'changes_requested'

export interface ReviewerDecision {
  readonly decision: ReviewerDecisionStatus
  readonly summary: string
  readonly findings: readonly ReviewFinding[]
}

export interface ReviewMaterialSnapshot {
  readonly schemaVersion: 1
  readonly mission: {
    readonly id: MissionId
    readonly title: string
    readonly goal: string
    readonly constraints: readonly unknown[]
  }
  readonly task: {
    readonly id: TaskId
    readonly title: string
    readonly description: string
    readonly acceptanceCriteria: readonly {
      readonly key: string
      readonly description: string
      readonly required: boolean
      readonly evidenceKinds: readonly string[]
    }[]
  }
  readonly submission: {
    readonly id: TaskSubmissionId
    readonly note: string
    readonly evidenceBundleHash: string
    readonly submittedByAgentId: AgentId
  }
  readonly artifactVersion: {
    readonly id: ArtifactVersionId
    readonly artifactId: string
    readonly title: string
    readonly kind: string
    readonly contentHash: string
    readonly content: unknown
  }
  readonly worktree: null | {
    readonly baseCommit: string
    readonly headCommit: string | null
    readonly integratedCommit: string | null
    readonly status: string
  }
  readonly evidence: readonly {
    readonly id: EvidenceId
    readonly kind: string
    readonly uri: string
    readonly contentHash: string | null
    readonly metadata: Readonly<Record<string, unknown>>
    readonly producerRunId: string
    readonly producerRunStatus: string
    readonly producerAttempt: number
    readonly createdAt: string
  }[]
  readonly successfulToolResults: readonly {
    readonly action: string
    readonly result: unknown
  }[]
}

interface ExecutionRow {
  readonly review_id: string
  readonly workspace_id: string
  readonly mission_id: string
  readonly task_id: string
  readonly submission_id: string
  readonly reviewer_agent_id: string
  readonly status: 'queued' | 'running' | 'model_complete' | 'completed' | 'failed' | 'cancelled'
  readonly attempt: number
  readonly max_attempts: number
  readonly lease_token: string | null
  readonly lease_expires_at: Date | string | null
  readonly materials_snapshot: ReviewMaterialSnapshot | null
  readonly decision: ReviewerDecision | null
  readonly model_provider: string
  readonly model_name: string
  readonly review_status: ArtifactReview['status']
  readonly task_status: string
  readonly project_id: string
}

export interface ReviewerExecutionWork {
  readonly reviewId: ReviewId
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly submissionId: TaskSubmissionId
  readonly reviewerAgentId: AgentId
  readonly leaseToken: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly modelProvider: string
  readonly modelName: string
  readonly materials: ReviewMaterialSnapshot
  readonly storedDecision?: ReviewerDecision
}

export type ClaimReviewerExecutionResult =
  | { readonly kind: 'work'; readonly work: ReviewerExecutionWork }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }
  | { readonly kind: 'not_ready'; readonly taskStatus: string }
  | { readonly kind: 'terminal'; readonly status: ExecutionRow['status'] }

export type RetryFailedReviewerExecutionResult =
  | { readonly retried: true; readonly maxAttempts: number }
  | {
      readonly retried: false
      readonly reason: 'not_found_or_forbidden' | 'execution_not_failed' | 'review_not_pending'
        | 'mission_not_running' | 'task_not_reviewing' | 'reviewer_inactive' | 'retry_limit'
    }

export interface CompleteReviewerModelInput {
  readonly reviewId: ReviewId
  readonly reviewerAgentId: AgentId
  readonly leaseToken: string
  readonly decision: ReviewerDecision
  readonly promptSnapshot: Readonly<Record<string, unknown>>
  readonly responseSnapshot: Readonly<Record<string, unknown>>
  readonly modelProvider: string
  readonly modelName: string
  readonly providerRequestId?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
  readonly estimatedCostUsd?: number
  readonly latencyMs: number
}

export interface RecordInvalidReviewerModelResponseInput {
  readonly reviewId: ReviewId
  readonly reviewerAgentId: AgentId
  readonly leaseToken: string
  readonly promptSnapshot: Readonly<Record<string, unknown>>
  readonly responseSnapshot: Readonly<Record<string, unknown>>
  readonly modelProvider: string
  readonly modelName: string
  readonly providerRequestId?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
  readonly estimatedCostUsd?: number
  readonly latencyMs: number
  readonly errorMessage: string
}

function validateDecision(decision: ReviewerDecision): void {
  if (!['approved', 'rejected', 'changes_requested'].includes(decision.decision)) {
    throw new Error('Invalid Reviewer decision')
  }
  if (!decision.summary.trim() || decision.summary.length > 20_000) {
    throw new Error('Reviewer summary must be between 1 and 20000 characters')
  }
  if (!Array.isArray(decision.findings)
      || decision.findings.length > 200
      || Buffer.byteLength(JSON.stringify(decision.findings)) > 256 * 1024) {
    throw new Error('Reviewer findings exceed the safety limit')
  }
  for (const finding of decision.findings) {
    if (!finding || !['info', 'warning', 'error'].includes(finding.severity)
        || typeof finding.summary !== 'string' || !finding.summary.trim()
        || finding.summary.length > 10_000
        || (finding.evidenceIds !== undefined
          && (!Array.isArray(finding.evidenceIds)
            || finding.evidenceIds.some((id: unknown) => typeof id !== 'string')))) {
      throw new Error('Reviewer returned an invalid finding')
    }
  }
}

export class ReviewerExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async retryFailed(input: {
    readonly workspaceId: WorkspaceId
    readonly reviewId: ReviewId
    readonly requestedBy: UserId
    readonly reason: string
    readonly correlationId: CorrelationId
  }): Promise<RetryFailedReviewerExecutionResult> {
    const reason = input.reason.trim()
    if (!reason || reason.length > 2_000) {
      throw new Error('Reviewer retry reason must be between 1 and 2000 characters')
    }
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{
        readonly execution_status: ExecutionRow['status']
        readonly review_status: ArtifactReview['status']
        readonly mission_status: string
        readonly task_status: string
        readonly reviewer_status: string
        readonly project_id: string
        readonly mission_id: string
        readonly task_id: string
        readonly submission_id: string
        readonly reviewer_agent_id: string
        readonly decision: ReviewerDecision | null
        readonly max_attempts: number
      }>(
        'SELECT execution.status AS execution_status, review.status AS review_status, ' +
        'mission.status AS mission_status, task.status AS task_status, agent.status AS reviewer_status, ' +
        'mission.project_id, execution.mission_id, execution.task_id, execution.submission_id, ' +
        'execution.reviewer_agent_id, execution.decision, execution.max_attempts ' +
        'FROM review_executions execution ' +
        'JOIN reviews review ON review.id = execution.review_id ' +
        'JOIN missions mission ON mission.id = execution.mission_id ' +
        'JOIN tasks task ON task.id = execution.task_id ' +
        'JOIN agents agent ON agent.id = execution.reviewer_agent_id AND agent.workspace_id = execution.workspace_id ' +
        'JOIN users requester ON requester.id = $3 AND requester.workspace_id = execution.workspace_id ' +
        'WHERE execution.review_id = $1 AND execution.workspace_id = $2 FOR UPDATE OF execution',
        [input.reviewId, input.workspaceId, input.requestedBy],
      )
      const row = found.rows[0]
      if (!row) return { retried: false, reason: 'not_found_or_forbidden' }
      if (row.execution_status !== 'failed') return { retried: false, reason: 'execution_not_failed' }
      if (!['requested', 'in_progress'].includes(row.review_status)) {
        return { retried: false, reason: 'review_not_pending' }
      }
      if (row.mission_status !== 'running') return { retried: false, reason: 'mission_not_running' }
      if (row.task_status !== 'reviewing') return { retried: false, reason: 'task_not_reviewing' }
      if (row.reviewer_status !== 'active') return { retried: false, reason: 'reviewer_inactive' }
      if (row.max_attempts >= 10) return { retried: false, reason: 'retry_limit' }

      const maxAttempts = row.max_attempts + 1
      const status = row.decision === null ? 'queued' : 'model_complete'
      await client.query(
        'UPDATE review_executions SET status = $2, max_attempts = $3, lease_token = NULL, ' +
        'lease_expires_at = NULL, error = NULL, finished_at = NULL, updated_at = NOW() WHERE review_id = $1',
        [input.reviewId, status, maxAttempts],
      )
      await client.query(
        "UPDATE reviews SET summary = '' WHERE id = $1 AND status IN ('requested', 'in_progress')",
        [input.reviewId],
      )

      const inboxPayload = {
        schemaVersion: 1,
        type: 'artifact.review_requested',
        reviewId: input.reviewId,
        submissionId: row.submission_id as TaskSubmissionId,
        missionId: row.mission_id as MissionId,
        taskId: row.task_id as TaskId,
      }
      const payloadJson = canonicalJson(inboxPayload)
      const payloadHash = createHash('sha256').update(payloadJson).digest('hex')
      await client.query(
        'INSERT INTO inbox_messages ' +
        '(id, workspace_id, agent_id, mission_id, kind, payload, payload_hash, dedupe_key) ' +
        "VALUES ($1, $2, $3, $4, 'artifact.review_requested', $5::jsonb, $6, $7)",
        [
          'inbox_' + randomUUID(),
          input.workspaceId,
          row.reviewer_agent_id,
          row.mission_id,
          payloadJson,
          payloadHash,
          'artifact-review-retry:' + input.reviewId + ':' + maxAttempts,
        ],
      )
      await client.query(
        'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
        [
          'wake_' + randomUUID(),
          EVENT_TOPICS.agentWake,
          row.reviewer_agent_id,
          canonicalJson({
            schemaVersion: 1,
            type: 'agent.wake',
            workspaceId: input.workspaceId,
            missionId: row.mission_id,
            agentId: row.reviewer_agent_id,
            reason: 'artifact.review_retried',
            reviewId: input.reviewId,
          }),
        ],
      )
      await appendDomainEvent(client, {
        type: 'review.execution_retried',
        workspaceId: input.workspaceId,
        projectId: row.project_id as ProjectId,
        missionId: row.mission_id as MissionId,
        actor: { kind: 'user', id: input.requestedBy },
        correlationId: input.correlationId,
        payload: { reviewId: input.reviewId, from: 'failed', to: status, reason, maxAttempts },
      })
      return { retried: true, maxAttempts }
    })
  }

  async claim(input: {
    readonly reviewId: ReviewId
    readonly reviewerAgentId: AgentId
    readonly leaseSeconds: number
  }): Promise<ClaimReviewerExecutionResult> {
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 1_800) {
      throw new RangeError('Reviewer lease must be between 30 and 1800 seconds')
    }
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<ExecutionRow>(
        'SELECT execution.*, review.status AS review_status, task.status AS task_status, ' +
        'mission.project_id FROM review_executions execution ' +
        'JOIN missions mission ON mission.id = execution.mission_id ' +
        'JOIN reviews review ON review.id = execution.review_id ' +
        'JOIN tasks task ON task.id = execution.task_id ' +
        'WHERE execution.review_id = $1 AND execution.reviewer_agent_id = $2 FOR UPDATE OF execution, review',
        [input.reviewId, input.reviewerAgentId],
      )
      const row = found.rows[0]
      if (!row) throw new Error('Reviewer execution not found for this Agent')
      if (['approved', 'rejected', 'changes_requested', 'cancelled'].includes(row.review_status)) {
        const status = row.review_status === 'cancelled' ? 'cancelled' : 'completed'
        await client.query(
          'UPDATE review_executions SET status = $2, lease_token = NULL, lease_expires_at = NULL, ' +
          'finished_at = COALESCE(finished_at, NOW()), updated_at = NOW() WHERE review_id = $1',
          [row.review_id, status],
        )
        return { kind: 'terminal', status }
      }
      if (['completed', 'failed', 'cancelled'].includes(row.status)) {
        return { kind: 'terminal', status: row.status }
      }
      if (row.task_status !== 'reviewing') {
        return { kind: 'not_ready', taskStatus: row.task_status }
      }
      const leaseExpiry = row.lease_expires_at === null ? 0 : new Date(row.lease_expires_at).getTime()
      if (['running', 'model_complete'].includes(row.status) && leaseExpiry > Date.now()) {
        return { kind: 'busy', retryAfterMs: Math.max(250, leaseExpiry - Date.now()) }
      }
      if (row.decision === null && row.attempt >= row.max_attempts) {
        await client.query(
          "UPDATE review_executions SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, " +
          "error = '{\"message\":\"Reviewer retry budget exhausted\"}'::jsonb, " +
          'finished_at = NOW(), updated_at = NOW() WHERE review_id = $1',
          [row.review_id],
        )
        return { kind: 'terminal', status: 'failed' }
      }

      const materials = row.materials_snapshot ?? await this.loadMaterials(client, row)
      const leaseToken = 'review_lease_' + randomUUID()
      const claimed = await client.query<Pick<ExecutionRow, 'attempt'>>(
        "UPDATE review_executions SET status = CASE WHEN decision IS NULL THEN 'running' ELSE 'model_complete' END, " +
        'attempt = CASE WHEN decision IS NULL THEN attempt + 1 ELSE attempt END, lease_token = $2, ' +
        "lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 second'), " +
        'materials_snapshot = COALESCE(materials_snapshot, $4::jsonb), started_at = COALESCE(started_at, NOW()), ' +
        'updated_at = NOW() WHERE review_id = $1 RETURNING attempt',
        [row.review_id, leaseToken, input.leaseSeconds, canonicalJson(materials)],
      )
      if (row.review_status === 'requested') {
        await client.query("UPDATE reviews SET status = 'in_progress' WHERE id = $1", [row.review_id])
        await appendDomainEvent(client, {
          type: 'review.status_changed',
          workspaceId: row.workspace_id as WorkspaceId,
          projectId: row.project_id as ProjectId,
          missionId: row.mission_id as MissionId,
          actor: { kind: 'agent', id: row.reviewer_agent_id as AgentId },
          correlationId: ('review_execution_' + row.review_id) as CorrelationId,
          payload: {
            reviewId: row.review_id as ReviewId,
            from: 'requested',
            to: 'in_progress',
            evidence: [],
          },
        })
      }
      return {
        kind: 'work',
        work: {
          reviewId: row.review_id as ReviewId,
          workspaceId: row.workspace_id as WorkspaceId,
          missionId: row.mission_id as MissionId,
          taskId: row.task_id as TaskId,
          submissionId: row.submission_id as TaskSubmissionId,
          reviewerAgentId: row.reviewer_agent_id as AgentId,
          leaseToken,
          attempt: claimed.rows[0]?.attempt ?? row.attempt + (row.decision === null ? 1 : 0),
          maxAttempts: row.max_attempts,
          modelProvider: row.model_provider,
          modelName: row.model_name,
          materials,
          ...(row.decision === null ? {} : { storedDecision: row.decision }),
        },
      }
    })
  }

  async completeModel(input: CompleteReviewerModelInput): Promise<void> {
    validateDecision(input.decision)
    const decisionJson = canonicalJson(input.decision)
    const decisionHash = createHash('sha256').update(decisionJson).digest('hex')
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<Pick<ExecutionRow,
        'workspace_id' | 'mission_id' | 'task_id' | 'attempt'
      >>(
        "UPDATE review_executions SET status = 'model_complete', decision = $4::jsonb, decision_hash = $5, " +
        'prompt_snapshot = $6::jsonb, response_snapshot = $7::jsonb, model_provider = $8, model_name = $9, ' +
        'provider_request_id = $10, input_tokens = $11, output_tokens = $12, cached_input_tokens = $13, ' +
        'estimated_cost_usd = $14, latency_ms = $15, updated_at = NOW() ' +
        'WHERE review_id = $1 AND reviewer_agent_id = $2 ' +
        "AND status = 'running' AND lease_token = $3 AND lease_expires_at > NOW() " +
        'RETURNING workspace_id, mission_id, task_id, attempt',
        [
          input.reviewId,
          input.reviewerAgentId,
          input.leaseToken,
          decisionJson,
          decisionHash,
          canonicalJson(input.promptSnapshot),
          canonicalJson(input.responseSnapshot),
          input.modelProvider,
          input.modelName,
          input.providerRequestId ?? null,
          input.inputTokens,
          input.outputTokens,
          input.cachedInputTokens ?? 0,
          input.estimatedCostUsd ?? null,
          input.latencyMs,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Reviewer lease was lost before model completion')
      await this.insertModelCall(client, row, input, 'succeeded')
    })
  }

  async recordInvalidModelResponse(input: RecordInvalidReviewerModelResponseInput): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const error = canonicalJson({ message: input.errorMessage })
      const result = await client.query<Pick<ExecutionRow,
        'workspace_id' | 'mission_id' | 'task_id' | 'attempt'
      >>(
        'UPDATE review_executions SET prompt_snapshot = $4::jsonb, response_snapshot = $5::jsonb, ' +
        'model_provider = $6, model_name = $7, provider_request_id = $8, input_tokens = $9, ' +
        'output_tokens = $10, cached_input_tokens = $11, estimated_cost_usd = $12, latency_ms = $13, ' +
        'error = $14::jsonb, updated_at = NOW() WHERE review_id = $1 AND reviewer_agent_id = $2 ' +
        "AND status = 'running' AND lease_token = $3 AND lease_expires_at > NOW() " +
        'RETURNING workspace_id, mission_id, task_id, attempt',
        [
          input.reviewId,
          input.reviewerAgentId,
          input.leaseToken,
          canonicalJson(input.promptSnapshot),
          canonicalJson(input.responseSnapshot),
          input.modelProvider,
          input.modelName,
          input.providerRequestId ?? null,
          input.inputTokens,
          input.outputTokens,
          input.cachedInputTokens ?? 0,
          input.estimatedCostUsd ?? null,
          input.latencyMs,
          error,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Reviewer lease was lost before invalid model response persistence')
      await this.insertModelCall(client, row, input, 'invalid', error)
    })
  }

  private async insertModelCall(
    client: PoolClient,
    scope: Pick<ExecutionRow, 'workspace_id' | 'mission_id' | 'task_id' | 'attempt'>,
    input: CompleteReviewerModelInput | RecordInvalidReviewerModelResponseInput,
    status: 'succeeded' | 'invalid',
    error?: string,
  ): Promise<void> {
    await client.query(
      'INSERT INTO reviewer_model_calls ' +
      '(id, review_id, workspace_id, mission_id, task_id, attempt, status, provider, model, ' +
      'provider_request_id, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, ' +
      'latency_ms, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)',
      [
        'review_model_call_' + randomUUID(),
        input.reviewId,
        scope.workspace_id,
        scope.mission_id,
        scope.task_id,
        scope.attempt,
        status,
        input.modelProvider,
        input.modelName,
        input.providerRequestId ?? null,
        input.inputTokens,
        input.outputTokens,
        input.cachedInputTokens ?? 0,
        input.estimatedCostUsd ?? null,
        input.latencyMs,
        error ?? null,
      ],
    )
  }

  async renew(input: {
    readonly reviewId: ReviewId
    readonly reviewerAgentId: AgentId
    readonly leaseToken: string
    readonly leaseSeconds: number
  }): Promise<boolean> {
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 1_800) {
      throw new RangeError('Reviewer lease must be between 30 and 1800 seconds')
    }
    const result = await this.pool.query(
      "UPDATE review_executions SET lease_expires_at = NOW() + ($4::double precision * INTERVAL '1 second'), " +
      'updated_at = NOW() WHERE review_id = $1 AND reviewer_agent_id = $2 AND lease_token = $3 ' +
      "AND status IN ('running', 'model_complete') AND lease_expires_at > NOW()",
      [input.reviewId, input.reviewerAgentId, input.leaseToken, input.leaseSeconds],
    )
    return result.rowCount === 1
  }

  async complete(input: {
    readonly reviewId: ReviewId
    readonly reviewerAgentId: AgentId
    readonly leaseToken: string
  }): Promise<void> {
    const result = await this.pool.query(
      "UPDATE review_executions SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, " +
      'finished_at = NOW(), updated_at = NOW() WHERE review_id = $1 AND reviewer_agent_id = $2 ' +
      "AND status = 'model_complete' AND lease_token = $3",
      [input.reviewId, input.reviewerAgentId, input.leaseToken],
    )
    if (result.rowCount !== 1) throw new Error('Reviewer execution was not ready to complete')
  }

  async fail(input: {
    readonly reviewId: ReviewId
    readonly reviewerAgentId: AgentId
    readonly leaseToken: string
    readonly message: string
  }): Promise<{ readonly retryable: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<ExecutionRow>(
        'SELECT execution.*, review.status AS review_status, task.status AS task_status, ' +
        'mission.project_id FROM review_executions execution ' +
        'JOIN missions mission ON mission.id = execution.mission_id ' +
        'JOIN reviews review ON review.id = execution.review_id ' +
        'JOIN tasks task ON task.id = execution.task_id ' +
        'WHERE execution.review_id = $1 AND execution.reviewer_agent_id = $2 FOR UPDATE OF execution',
        [input.reviewId, input.reviewerAgentId],
      )
      const row = current.rows[0]
      if (!row) throw new Error('Reviewer execution not found')
      if (!['running', 'model_complete'].includes(row.status) || row.lease_token !== input.leaseToken) {
        return { retryable: false }
      }
      const retryable = row.decision !== null || row.attempt < row.max_attempts
      const nextStatus = retryable ? (row.decision === null ? 'queued' : 'model_complete') : 'failed'
      await client.query(
        'UPDATE review_executions SET status = $2, lease_token = NULL, lease_expires_at = NULL, ' +
        'error = $3::jsonb, updated_at = NOW(), finished_at = CASE WHEN $2 = \'failed\' THEN NOW() ELSE NULL END ' +
        'WHERE review_id = $1',
        [row.review_id, nextStatus, canonicalJson({ message: input.message })],
      )
      if (!retryable) {
        await client.query(
          'UPDATE reviews SET summary = $2 WHERE id = $1 AND status IN (\'requested\', \'in_progress\')',
          [
            row.review_id,
            '自动 Reviewer 执行失败，等待人工接管：' + input.message.slice(0, 10_000),
          ],
        )
      }
      return { retryable }
    })
  }

  private async loadMaterials(client: PoolClient, row: ExecutionRow): Promise<ReviewMaterialSnapshot> {
    const scope = await client.query<{
      mission_title: string
      mission_goal: string
      mission_constraints: readonly unknown[]
      task_title: string
      task_description: string
      note: string
      evidence_bundle_hash: string
      submitted_by_agent_id: string
      artifact_version_id: string
      artifact_id: string
      artifact_title: string
      artifact_kind: string
      content_hash: string
      content: unknown
    }>(
      'SELECT mission.title AS mission_title, mission.goal AS mission_goal, mission.constraints AS mission_constraints, ' +
      'task.title AS task_title, task.description AS task_description, submission.note, ' +
      'submission.evidence_bundle_hash, submission.submitted_by_agent_id, submission.artifact_version_id, ' +
      'artifact.id AS artifact_id, artifact.title AS artifact_title, artifact.kind AS artifact_kind, ' +
      'version.content_hash, version.content ' +
      'FROM task_submissions submission JOIN missions mission ON mission.id = submission.mission_id ' +
      'JOIN tasks task ON task.id = submission.task_id ' +
      'JOIN artifact_versions version ON version.id = submission.artifact_version_id ' +
      'JOIN artifacts artifact ON artifact.id = version.artifact_id WHERE submission.id = $1',
      [row.submission_id],
    )
    const item = scope.rows[0]
    if (!item) throw new Error('Review materials are outside the Submission scope')
    const criteria = await client.query<{
        criterion_key: string
        description: string
        required: boolean
        required_evidence_kinds: readonly string[]
      }>(
        'SELECT criterion_key, description, required, required_evidence_kinds ' +
        'FROM task_acceptance_criteria WHERE task_id = $1 ORDER BY criterion_key, id',
        [row.task_id],
      )
    const evidence = await client.query<{
        id: string
        kind: string
        uri: string
        content_hash: string | null
        metadata: Readonly<Record<string, unknown>>
        run_id: string
        created_at: Date
        producer_run_status: string
        producer_attempt: number
      }>(
        'SELECT evidence.id, evidence.kind, evidence.uri, evidence.content_hash, evidence.metadata, ' +
        'evidence.run_id, evidence.created_at, producer.status AS producer_run_status, ' +
        'producer.attempt AS producer_attempt FROM task_submission_evidence selected ' +
        'JOIN evidence ON evidence.id = selected.evidence_id ' +
        'JOIN agent_runs producer ON producer.id = evidence.run_id ' +
        'WHERE selected.submission_id = $1 ORDER BY evidence.kind, evidence.id',
        [row.submission_id],
      )
    const tools = await client.query<{ action: string; result: unknown }>(
        'SELECT execution.action, execution.result FROM tool_executions execution ' +
        "WHERE execution.status = 'succeeded' " +
        "AND execution.action IN ('repo.status', 'repo.diff', 'repo.commit', 'test.run', 'shell.run') " +
        'AND EXISTS (SELECT 1 FROM task_submission_evidence selected ' +
        'JOIN evidence ON evidence.id = selected.evidence_id ' +
        'WHERE selected.submission_id = $1 AND evidence.run_id = execution.run_id ' +
        "AND evidence.metadata->>'toolCallId' = execution.request->>'id') " +
        'ORDER BY execution.created_at, execution.id',
        [row.submission_id],
      )
    const worktree = await client.query<{
        base_commit: string
        head_commit: string | null
        integrated_commit: string | null
        status: string
      }>(
        'SELECT base_commit, head_commit, integrated_commit, status FROM task_worktrees WHERE task_id = $1',
        [row.task_id],
      )
    const tree = worktree.rows[0]
    return {
      schemaVersion: 1,
      mission: {
        id: row.mission_id as MissionId,
        title: item.mission_title,
        goal: item.mission_goal,
        constraints: item.mission_constraints,
      },
      task: {
        id: row.task_id as TaskId,
        title: item.task_title,
        description: item.task_description,
        acceptanceCriteria: criteria.rows.map((criterion) => ({
          key: criterion.criterion_key,
          description: criterion.description,
          required: criterion.required,
          evidenceKinds: criterion.required_evidence_kinds,
        })),
      },
      submission: {
        id: row.submission_id as TaskSubmissionId,
        note: item.note,
        evidenceBundleHash: item.evidence_bundle_hash,
        submittedByAgentId: item.submitted_by_agent_id as AgentId,
      },
      artifactVersion: {
        id: item.artifact_version_id as ArtifactVersionId,
        artifactId: item.artifact_id,
        title: item.artifact_title,
        kind: item.artifact_kind,
        contentHash: item.content_hash,
        content: item.content,
      },
      worktree: tree
        ? {
            baseCommit: tree.base_commit,
            headCommit: tree.head_commit,
            integratedCommit: tree.integrated_commit,
            status: tree.status,
          }
        : null,
      evidence: evidence.rows.map((record) => ({
        id: record.id as EvidenceId,
        kind: record.kind,
        uri: record.uri,
        contentHash: record.content_hash,
        metadata: record.metadata,
        producerRunId: record.run_id,
        producerRunStatus: record.producer_run_status,
        producerAttempt: record.producer_attempt,
        createdAt: record.created_at.toISOString(),
      })),
      successfulToolResults: tools.rows,
    }
  }
}

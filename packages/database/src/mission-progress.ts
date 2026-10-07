import type { AgentRole, EvidenceKind, TaskId, TaskStatus } from '@runguild/protocol'
import type { PoolClient } from 'pg'

import { validTaskEvidencePredicate } from './evidence-gate.js'

export interface MissionTaskProgress {
  readonly id: TaskId
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly role: AgentRole | null
  readonly priority: number
  readonly dependsOn: readonly TaskId[]
  readonly attemptCount: number
  readonly maxAttempts: number
  readonly reviewRequired: boolean
  readonly latestRun: {
    readonly id: string
    readonly agentId: string
    readonly agentName: string
    readonly modelProvider: string
    readonly modelName: string
    readonly modelSource: 'observed' | 'configured'
    readonly status: string
    readonly currentHop: number
    readonly maxHops: number
    readonly startedAt: string | null
    readonly finishedAt: string | null
    readonly completionSummary: string | null
  } | null
  readonly acceptanceCriteria: readonly {
    readonly id: string
    readonly key: string
    readonly description: string
    readonly required: boolean
    readonly requiredEvidenceKinds: readonly EvidenceKind[]
    /** Current evidence completeness, never a claim that a Reviewer approved it. */
    readonly evidenceStatus: 'complete' | 'missing'
    readonly evidence: readonly {
      readonly id: string
      readonly kind: EvidenceKind
      readonly summary: string
      readonly createdAt: string
      readonly artifactVersionId: string | null
    }[]
  }[]
  readonly latestReview: {
    readonly id: string
    readonly status: string
    readonly submissionStatus: string
    readonly artifactVersionId: string
    readonly isCurrentAttempt: boolean
    readonly summary: string
    readonly reviewerName: string | null
    readonly createdAt: string
    readonly resolvedAt: string | null
  } | null
  readonly integration: {
    readonly status: string
    readonly headCommit: string | null
    readonly integratedCommit: string | null
    readonly lastError: string | null
  } | null
}

interface TaskRow {
  readonly id: TaskId
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly required_role: AgentRole | null
  readonly priority: number
  readonly depends_on: TaskId[]
  readonly attempt_count: number
  readonly max_attempts: number
  readonly review_required: boolean
}

interface CriterionRow {
  readonly id: string
  readonly task_id: TaskId
  readonly criterion_key: string
  readonly description: string
  readonly required: boolean
  readonly required_evidence_kinds: EvidenceKind[]
}

const evidenceLabels: Readonly<Record<EvidenceKind, string>> = {
  test_run: '测试通过',
  command_result: '命令验证通过',
  file_diff: '代码变更已记录',
  artifact_version: '产物版本已记录',
  trace_span: '执行记录已保存',
  citation: '引用来源已记录',
  human_attestation: '人工证明已记录',
}

/** Batch projections only; model/tool payloads, evidence metadata and file content stay private. */
export async function readMissionTaskProgress(
  client: PoolClient,
  missionId: string,
): Promise<readonly MissionTaskProgress[]> {
  const tasks = await client.query<TaskRow>(`
    SELECT t.id, t.title, t.description, t.status, t.required_role, t.priority,
      t.attempt_count, t.max_attempts, t.review_required,
      COALESCE(array_agg(d.depends_on_task_id ORDER BY d.depends_on_task_id)
        FILTER (WHERE d.depends_on_task_id IS NOT NULL), ARRAY[]::TEXT[]) AS depends_on
    FROM tasks t LEFT JOIN task_dependencies d ON d.task_id = t.id
    WHERE t.mission_id = $1 GROUP BY t.id ORDER BY t.position, t.created_at, t.id`, [missionId])
  if (tasks.rows.length === 0) return []

  const runs = await client.query<{
    task_id: TaskId; id: string; agent_id: string; agent_name: string
    model_provider: string; model_name: string; model_source: 'observed' | 'configured'
    status: string; current_hop: number; max_hops: number
    started_at: Date | null; finished_at: Date | null; completion_summary: string | null
  }>(`
    SELECT DISTINCT ON (r.task_id) r.task_id, r.id, r.agent_id, a.name AS agent_name,
      COALESCE(model.provider, a.model_provider) AS model_provider,
      COALESCE(model.model, a.model_name) AS model_name,
      CASE WHEN model.provider IS NULL THEN 'configured' ELSE 'observed' END AS model_source,
      r.status, r.current_hop, r.max_hops, r.started_at, r.finished_at,
      LEFT(r.completion_summary, 4000) AS completion_summary
    FROM agent_runs r JOIN agents a ON a.id = r.agent_id
    LEFT JOIN LATERAL (
      SELECT provider, model FROM llm_calls WHERE run_id = r.id
      ORDER BY hop DESC, started_at DESC, id DESC LIMIT 1
    ) model ON TRUE
    WHERE r.mission_id = $1 ORDER BY r.task_id, r.attempt DESC, r.created_at DESC, r.id DESC`, [missionId])

  const criteria = await client.query<CriterionRow>(`
    SELECT c.id, c.task_id, c.criterion_key, c.description, c.required, c.required_evidence_kinds
    FROM task_acceptance_criteria c JOIN tasks t ON t.id = c.task_id
    WHERE t.mission_id = $1 ORDER BY c.task_id, c.criterion_key, c.id`, [missionId])
  const evidence = await client.query<{
    criterion_id: string; id: string; kind: EvidenceKind; created_at: Date
    artifact_version_id: string | null; commit: string | null
  }>(`
    SELECT c.id AS criterion_id, e.id, e.kind, e.created_at,
      LEFT(COALESCE(e.metadata->>'headCommit', e.metadata->>'commit'), 12) AS commit,
      (SELECT s.artifact_version_id FROM task_submission_evidence se
       JOIN task_submissions s ON s.id = se.submission_id
       JOIN agent_runs sr ON sr.id = s.run_id
       WHERE se.evidence_id = e.id AND s.task_id = t.id AND sr.attempt = t.attempt_count
         AND s.status IN ('submitted', 'in_review', 'approved')
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS artifact_version_id
    FROM task_acceptance_criteria c JOIN tasks t ON t.id = c.task_id
    LEFT JOIN task_worktrees w ON w.task_id = t.id
    JOIN evidence e ON e.acceptance_criterion_id = c.id
    JOIN agent_runs producer ON producer.id = e.run_id
    WHERE t.mission_id = $1 AND ${validTaskEvidencePredicate}
    ORDER BY c.id, e.created_at DESC, e.id`, [missionId])

  const reviews = await client.query<{
    task_id: TaskId; id: string; status: string; submission_status: string
    artifact_version_id: string; is_current_attempt: boolean; summary: string
    reviewer_name: string | null; created_at: Date; completed_at: Date | null
  }>(`
    SELECT DISTINCT ON (review.task_id) review.task_id, review.id, review.status,
      s.status AS submission_status, s.artifact_version_id,
      producer.attempt = t.attempt_count AS is_current_attempt,
      LEFT(review.summary, 4000) AS summary,
      CASE WHEN review.reviewer_kind = 'agent' THEN a.name ELSE u.display_name END AS reviewer_name,
      review.created_at, review.completed_at
    FROM reviews review JOIN task_submissions s ON s.id = review.submission_id
    JOIN tasks t ON t.id = review.task_id JOIN agent_runs producer ON producer.id = s.run_id
    LEFT JOIN agents a ON review.reviewer_kind = 'agent' AND a.id = review.reviewer_id
    LEFT JOIN users u ON review.reviewer_kind = 'user' AND u.id = review.reviewer_id
    WHERE review.mission_id = $1
    ORDER BY review.task_id, producer.attempt DESC, review.created_at DESC, review.id DESC`, [missionId])
  const worktrees = await client.query<{
    task_id: TaskId; status: string; head_commit: string | null
    integrated_commit: string | null; last_error: string | null
  }>(`
    SELECT task_id, status, head_commit, integrated_commit,
      LEFT(last_error->>'message', 2000) AS last_error
    FROM task_worktrees WHERE mission_id = $1`, [missionId])

  const runByTask = new Map(runs.rows.map((row) => [row.task_id, row]))
  const reviewByTask = new Map(reviews.rows.map((row) => [row.task_id, row]))
  const worktreeByTask = new Map(worktrees.rows.map((row) => [row.task_id, row]))
  const evidenceByCriterion = new Map<string, typeof evidence.rows>()
  for (const item of evidence.rows) {
    const group = evidenceByCriterion.get(item.criterion_id) ?? []
    group.push(item)
    evidenceByCriterion.set(item.criterion_id, group)
  }
  const criteriaByTask = new Map<TaskId, MissionTaskProgress['acceptanceCriteria'][number][]>()
  for (const criterion of criteria.rows) {
    const validEvidence = evidenceByCriterion.get(criterion.id) ?? []
    const kinds = new Set(validEvidence.map((item) => item.kind))
    const complete = criterion.required_evidence_kinds.length > 0
      ? criterion.required_evidence_kinds.every((kind) => kinds.has(kind))
      : validEvidence.length > 0
    const group = criteriaByTask.get(criterion.task_id) ?? []
    group.push({
      id: criterion.id, key: criterion.criterion_key, description: criterion.description,
      required: criterion.required, requiredEvidenceKinds: criterion.required_evidence_kinds,
      evidenceStatus: complete ? 'complete' : 'missing',
      evidence: validEvidence.map((item) => ({
        id: item.id, kind: item.kind,
        summary: evidenceLabels[item.kind] + (item.commit ? ' · ' + item.commit : ''),
        createdAt: item.created_at.toISOString(), artifactVersionId: item.artifact_version_id,
      })),
    })
    criteriaByTask.set(criterion.task_id, group)
  }
  return tasks.rows.map((task) => {
    const run = runByTask.get(task.id)
    const review = reviewByTask.get(task.id)
    const worktree = worktreeByTask.get(task.id)
    return {
      id: task.id, title: task.title, description: task.description, status: task.status,
      role: task.required_role, priority: task.priority, dependsOn: task.depends_on,
      attemptCount: task.attempt_count, maxAttempts: task.max_attempts, reviewRequired: task.review_required,
      latestRun: run ? {
        id: run.id, agentId: run.agent_id, agentName: run.agent_name,
        modelProvider: run.model_provider, modelName: run.model_name, modelSource: run.model_source,
        status: run.status, currentHop: run.current_hop, maxHops: run.max_hops,
        startedAt: run.started_at?.toISOString() ?? null, finishedAt: run.finished_at?.toISOString() ?? null,
        completionSummary: run.completion_summary,
      } : null,
      acceptanceCriteria: criteriaByTask.get(task.id) ?? [],
      latestReview: review ? {
        id: review.id, status: review.status, submissionStatus: review.submission_status,
        artifactVersionId: review.artifact_version_id, isCurrentAttempt: review.is_current_attempt,
        summary: review.summary, reviewerName: review.reviewer_name,
        createdAt: review.created_at.toISOString(), resolvedAt: review.completed_at?.toISOString() ?? null,
      } : null,
      integration: worktree ? {
        status: worktree.status, headCommit: worktree.head_commit,
        integratedCommit: worktree.integrated_commit, lastError: worktree.last_error,
      } : null,
    }
  })
}

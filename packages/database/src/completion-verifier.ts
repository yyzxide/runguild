import {
  type CorrelationId,
  type CompletionDecision,
  type EvidenceRef,
  type ProjectId,
  type RuntimeRunContext,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { appendDomainEvent } from './events.js'
import { TaskRepository } from './task-repository.js'
import { withTransaction } from './transaction.js'

export class DatabaseCompletionVerifier {
  private readonly tasks: TaskRepository

  constructor(private readonly pool: Pool) {
    this.tasks = new TaskRepository(pool)
  }

  async verify(input: {
    readonly run: RuntimeRunContext
    readonly summary: string
    readonly evidence: readonly EvidenceRef[]
  }): Promise<CompletionDecision> {
    const gate = await withTransaction(this.pool, async (client) => {
      const task = await client.query<{
        project_id: string
        status: string
        review_required: boolean
      }>(
        'SELECT m.project_id, t.status, t.review_required FROM tasks t ' +
        'JOIN missions m ON m.id = t.mission_id ' +
        'WHERE t.id = $1 AND t.mission_id = $2 AND m.workspace_id = $3 FOR UPDATE OF t',
        [input.run.taskId, input.run.missionId, input.run.workspaceId],
      )
      const row = task.rows[0]
      if (!row) return { accepted: false, reason: 'Task scope no longer exists.' }
      if (row.status === 'completed') return { accepted: true, reviewRequired: false }
      if (row.status !== 'running' && row.status !== 'reviewing') {
        return { accepted: false, reason: 'Task is not in a completable execution state.' }
      }

      const missing = await client.query<{ missing: boolean }>(
        'SELECT EXISTS (' +
        '  SELECT 1 FROM task_acceptance_criteria c WHERE c.task_id = $1 AND c.required AND (' +
        '    (cardinality(c.required_evidence_kinds) = 0 AND NOT EXISTS (' +
        '      SELECT 1 FROM evidence e WHERE e.acceptance_criterion_id = c.id ' +
        '      AND (e.expires_at IS NULL OR e.expires_at > NOW())' +
        '    )) OR EXISTS (' +
        '      SELECT 1 FROM unnest(c.required_evidence_kinds) required_kind WHERE NOT EXISTS (' +
        '        SELECT 1 FROM evidence e WHERE e.acceptance_criterion_id = c.id ' +
        '        AND e.kind = required_kind AND (e.expires_at IS NULL OR e.expires_at > NOW())' +
        '      )' +
        '    )' +
        '  )' +
        ') AS missing',
        [input.run.taskId],
      )
      if (missing.rows[0]?.missing) {
        return { accepted: false, reason: 'Required durable evidence is missing.' }
      }

      if (row.status === 'running') {
        await client.query(
          "UPDATE tasks SET status = 'reviewing', updated_at = NOW() WHERE id = $1 AND status = 'running'",
          [input.run.taskId],
        )
        await appendDomainEvent(client, {
          type: 'task.status_changed',
          workspaceId: input.run.workspaceId,
          projectId: row.project_id as ProjectId,
          missionId: input.run.missionId,
          actor: { kind: 'agent', id: input.run.agentId, runId: input.run.runId },
          correlationId: ('completion_' + input.run.runId + '_' + input.run.currentHop) as CorrelationId,
          payload: {
            taskId: input.run.taskId,
            from: 'running',
            to: 'reviewing',
            reason: input.summary,
          },
        })
      }
      return { accepted: true, reviewRequired: row.review_required }
    })

    if (!gate.accepted) return gate
    if (gate.reviewRequired) {
      return { accepted: true, reason: 'Run finished; Task is awaiting independent review.' }
    }
    const completed = await this.tasks.completeTaskAndUnlockDependents({
      workspaceId: input.run.workspaceId,
      missionId: input.run.missionId,
      taskId: input.run.taskId,
      actor: { kind: 'agent', id: input.run.agentId, runId: input.run.runId },
      correlationId: ('completion_' + input.run.runId + '_' + input.run.currentHop) as CorrelationId,
    })
    return completed.completed
      ? { accepted: true }
      : { accepted: false, reason: 'Task completion gate rejected: ' + completed.reason }
  }
}

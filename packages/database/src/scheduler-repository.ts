import { createHash, randomUUID } from 'node:crypto'

import {
  EVENT_TOPICS,
  type AgentId,
  type AgentRole,
  type CorrelationId,
  type IsoTimestamp,
  type MissionId,
  type ProjectId,
  type TaskId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { appendDomainEvent } from './events.js'
import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

interface ReadyTaskRow {
  readonly workspace_id: string
  readonly project_id: string
  readonly mission_id: string
  readonly task_id: string
  readonly required_role: AgentRole
  readonly attempt: number
}

export interface TaskDispatch {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly agentId: AgentId
  readonly attempt: number
  readonly dispatchToken: string
  readonly expiresAt: IsoTimestamp
}

function payloadHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

function assertDispatchSeconds(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3_600) {
    throw new RangeError('dispatchSeconds must be an integer between 5 and 3600')
  }
}

export class SchedulerRepository {
  constructor(private readonly pool: Pool) {}

  async dispatchReadyTasks(input: {
    readonly limit: number
    readonly dispatchSeconds: number
    readonly correlationId: CorrelationId
  }): Promise<readonly TaskDispatch[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('limit must be an integer between 1 and 100')
    }
    assertDispatchSeconds(input.dispatchSeconds)

    return withTransaction(this.pool, async (client) => {
      await client.query(
        "UPDATE task_dispatches SET status = 'expired' " +
        "WHERE status = 'pending' AND expires_at <= NOW()",
      )

      const candidates = await client.query<ReadyTaskRow>(
        'SELECT m.workspace_id, m.project_id, t.mission_id, t.id AS task_id, ' +
        't.required_role, t.attempt_count + 1 AS attempt ' +
        'FROM tasks t JOIN missions m ON m.id = t.mission_id ' +
        "WHERE t.status = 'ready' AND m.status = 'running' " +
        'AND t.required_role IS NOT NULL AND t.attempt_count < t.max_attempts ' +
        'AND NOT EXISTS (' +
        '  SELECT 1 FROM task_dependencies d ' +
        '  JOIN tasks parent ON parent.id = d.depends_on_task_id ' +
        '  WHERE d.task_id = t.id AND d.required AND parent.status <> $2' +
        ') ' +
        'AND NOT EXISTS (' +
        '  SELECT 1 FROM task_dispatches active ' +
        '  WHERE active.task_id = t.id AND active.attempt = t.attempt_count + 1 ' +
        "  AND active.status IN ('pending', 'consumed')" +
        ') ' +
        'ORDER BY t.priority ASC, t.created_at ASC, t.id ASC ' +
        'LIMIT $1 FOR UPDATE OF t SKIP LOCKED',
        [input.limit, 'completed'],
      )

      const dispatches: TaskDispatch[] = []
      for (const task of candidates.rows) {
        const agent = await client.query<{ id: string }>(
          'SELECT a.id FROM agents a ' +
          "WHERE a.workspace_id = $1 AND a.status = 'active' AND a.role = $2 " +
          'ORDER BY (' +
          '  SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id = a.id ' +
          "  AND r.status IN ('queued', 'starting', 'running', 'waiting_tool', 'waiting_human')" +
          ') + (' +
          '  SELECT COUNT(*) FROM task_dispatches d WHERE d.agent_id = a.id ' +
          "  AND d.status = 'pending' AND d.expires_at > NOW()" +
          ') ASC, a.id ASC LIMIT 1',
          [task.workspace_id, task.required_role],
        )
        const agentIdRaw = agent.rows[0]?.id
        if (!agentIdRaw) continue

        const dispatchId = 'dispatch_' + randomUUID()
        const dispatchToken = 'dispatch_token_' + randomUUID()
        const dispatched = await client.query<{ expires_at: Date; dispatch_count: number }>(
          'INSERT INTO task_dispatches ' +
          '(id, workspace_id, mission_id, task_id, agent_id, attempt, dispatch_token, expires_at) ' +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8::double precision * INTERVAL '1 second')) " +
          'ON CONFLICT (task_id, attempt) DO UPDATE SET ' +
          'id = EXCLUDED.id, agent_id = EXCLUDED.agent_id, dispatch_token = EXCLUDED.dispatch_token, ' +
          "status = 'pending', run_id = NULL, dispatch_count = task_dispatches.dispatch_count + 1, " +
          'dispatched_at = NOW(), expires_at = EXCLUDED.expires_at, consumed_at = NULL ' +
          "WHERE task_dispatches.status = 'expired' " +
          'RETURNING expires_at, dispatch_count',
          [
            dispatchId,
            task.workspace_id,
            task.mission_id,
            task.task_id,
            agentIdRaw,
            task.attempt,
            dispatchToken,
            input.dispatchSeconds,
          ],
        )
        const dispatchRow = dispatched.rows[0]
        if (!dispatchRow) continue

        const workspaceId = task.workspace_id as WorkspaceId
        const projectId = task.project_id as ProjectId
        const missionId = task.mission_id as MissionId
        const taskId = task.task_id as TaskId
        const agentId = agentIdRaw as AgentId
        const expiresAt = dispatchRow.expires_at.toISOString() as IsoTimestamp
        const inboxId = 'inbox_' + randomUUID()
        const inboxPayload = canonicalJson({
          schemaVersion: 1,
          type: 'task.dispatch',
          dispatchId,
          dispatchToken,
          taskId,
          missionId,
          attempt: task.attempt,
          expiresAt,
        })

        await client.query(
          'INSERT INTO inbox_messages ' +
          '(id, workspace_id, agent_id, mission_id, kind, payload, payload_hash, dedupe_key) ' +
          "VALUES ($1, $2, $3, $4, 'task.dispatch', $5::jsonb, $6, $7)",
          [
            inboxId,
            workspaceId,
            agentId,
            missionId,
            inboxPayload,
            payloadHash(inboxPayload),
            'dispatch:' + dispatchId + ':' + dispatchRow.dispatch_count,
          ],
        )
        const wakePayload = canonicalJson({
          schemaVersion: 1,
          type: 'agent.wake',
          workspaceId,
          agentId,
          reason: 'task.dispatch',
        })
        await client.query(
          'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
          ['wake_' + randomUUID(), EVENT_TOPICS.agentWake, agentId, wakePayload],
        )
        await appendDomainEvent(client, {
          type: 'task.dispatched',
          workspaceId,
          projectId,
          missionId,
          actor: { kind: 'system', id: 'task-scheduler' },
          correlationId: input.correlationId,
          payload: {
            taskId,
            agentId,
            attempt: task.attempt,
            expiresAt,
          },
        })
        dispatches.push({
          id: dispatchId,
          workspaceId,
          missionId,
          taskId,
          agentId,
          attempt: task.attempt,
          dispatchToken,
          expiresAt,
        })
      }
      return dispatches
    })
  }
}

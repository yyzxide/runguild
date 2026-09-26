import { createHash, randomUUID } from 'node:crypto'
import {
  EVENT_TOPICS,
  type MissionBudgetSnapshot,
  type ModelUsage,
  type RuntimeRunContext,
  type WorkspaceId,
  type MissionId,
  type ProjectId,
  type UserId,
  type CorrelationId,
} from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'
import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'
import { appendDomainEvent } from './events.js'

export type { MissionBudgetSnapshot } from '@runguild/protocol'

interface BudgetScope { readonly workspaceId: WorkspaceId; readonly missionId: MissionId }
export interface BudgetCallReservation extends BudgetScope {
  readonly callId: string
  readonly role: 'planner' | 'execution' | 'reviewer' | 'acceptance'
  readonly operationId: string
  readonly leaseToken?: string
  readonly agentId: string
  readonly runId?: string
  readonly kind: 'conversation.plan_requested' | 'artifact.review_requested' | 'run.control'
  readonly payload: Readonly<Record<string, unknown>>
}

async function lockMission(client: PoolClient, scope: BudgetScope): Promise<boolean> {
  const result = await client.query('SELECT id FROM missions WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
    [scope.missionId, scope.workspaceId])
  return result.rows.length === 1
}

export async function readMissionBudget(client: Pick<PoolClient, 'query'>, scope: BudgetScope): Promise<MissionBudgetSnapshot | null> {
  const found = await client.query<{
    budget_tokens: string | number | null; input_tokens: string; output_tokens: string
    in_flight: string; unknown_calls: string; unpriced: string; known_cost: string | null
  }>(`SELECT m.budget_tokens,
    COALESCE(SUM(c.input_tokens) FILTER (WHERE c.status = 'completed'), 0)::text AS input_tokens,
    COALESCE(SUM(c.output_tokens) FILTER (WHERE c.status = 'completed'), 0)::text AS output_tokens,
    COUNT(c.id) FILTER (WHERE c.status = 'running')::text AS in_flight,
    COUNT(c.id) FILTER (WHERE c.status = 'unknown')::text AS unknown_calls,
    COUNT(c.id) FILTER (WHERE c.status IN ('completed', 'unknown') AND c.estimated_cost_usd IS NULL)::text AS unpriced,
    SUM(c.estimated_cost_usd) FILTER (WHERE c.status IN ('completed', 'unknown'))::text AS known_cost
    FROM missions m LEFT JOIN mission_model_calls c ON c.mission_id = m.id
    WHERE m.id = $1 AND m.workspace_id = $2 GROUP BY m.id`, [scope.missionId, scope.workspaceId])
  const row = found.rows[0]
  if (!row) return null
  const tokenLimit = row.budget_tokens === null ? null : Number(row.budget_tokens)
  const inputTokens = Number(row.input_tokens)
  const outputTokens = Number(row.output_tokens)
  const totalTokens = inputTokens + outputTokens
  const unknownUsageCalls = Number(row.unknown_calls)
  const unpricedCalls = Number(row.unpriced)
  return {
    tokenLimit, inputTokens, outputTokens, totalTokens,
    remainingTokens: tokenLimit === null ? null : Math.max(0, tokenLimit - totalTokens),
    inFlightCalls: Number(row.in_flight), unknownUsageCalls, unpricedCalls,
    estimatedCostUsd: unpricedCalls > 0 ? null : Number(row.known_cost ?? 0),
    status: tokenLimit === null ? 'unlimited' : unknownUsageCalls > 0 ? 'usage_unknown'
      : totalTokens >= tokenLimit ? 'exhausted' : 'available',
  }
}

// Called while the same Mission lock used by admission and budget changes is held.
async function markAbandonedCalls(client: PoolClient, missionId: MissionId): Promise<void> {
  await client.query(`UPDATE mission_model_calls c SET status = 'unknown', finished_at = NOW()
    WHERE c.mission_id = $1 AND c.status = 'running' AND (
      (c.role = 'execution' AND NOT EXISTS (SELECT 1 FROM task_leases l
        WHERE l.run_id = c.operation_id AND l.lease_token = c.lease_token AND l.expires_at > NOW()))
      OR (c.role = 'planner' AND NOT EXISTS (SELECT 1 FROM conversation_planning_requests p
        WHERE p.id = c.operation_id AND p.lease_token = c.lease_token AND p.lease_expires_at > NOW()))
      OR (c.role = 'reviewer' AND NOT EXISTS (SELECT 1 FROM review_executions r
        WHERE r.review_id = c.operation_id AND r.lease_token = c.lease_token AND r.lease_expires_at > NOW())))`, [missionId])
}

export async function reserveMissionModelCall(client: PoolClient, input: BudgetCallReservation): Promise<boolean> {
  if (!await lockMission(client, input)) throw new Error('Mission not found for model budget')
  await markAbandonedCalls(client, input.missionId)
  // An operation never runs two model calls concurrently. An unclosed prior
  // call means a crash interrupted settlement, even if its lease still lives.
  await client.query(`UPDATE mission_model_calls SET status = 'unknown', finished_at = NOW()
    WHERE mission_id = $1 AND role = $2 AND operation_id = $3 AND status = 'running'`,
    [input.missionId, input.role, input.operationId])
  const budget = await readMissionBudget(client, input)
  if (!budget) throw new Error('Mission not found for model budget')
  if (budget.status === 'exhausted' || budget.status === 'usage_unknown') {
    await client.query(`INSERT INTO mission_budget_waits
      (mission_id, workspace_id, kind, operation_id, agent_id, run_id, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (mission_id, kind, operation_id) DO UPDATE SET payload = EXCLUDED.payload`,
    [input.missionId, input.workspaceId, input.kind, input.operationId, input.agentId,
      input.runId ?? null, canonicalJson(input.payload)])
    if (input.runId) {
      await client.query(`UPDATE agent_runs SET status = 'waiting_human',
        completion_summary = $2, updated_at = NOW() WHERE id = $1 AND status = 'running'`,
      [input.runId, budget.status === 'usage_unknown'
        ? 'Mission model usage is unknown; review the budget before continuing.' : 'Mission token budget exhausted.'])
      await client.query(`UPDATE tasks SET status = 'waiting_human', updated_at = NOW()
        WHERE id = (SELECT task_id FROM agent_runs WHERE id = $1) AND status = 'running'`, [input.runId])
      // Pause and lease release commit together. A Worker crash must not let the
      // lease reaper turn a budget pause into a failed attempt, or lose a resume.
      await client.query('DELETE FROM task_leases WHERE run_id = $1 AND lease_token = $2',
        [input.runId, input.leaseToken])
    }
    return false
  }
  await client.query(`INSERT INTO mission_model_calls
    (id, workspace_id, mission_id, role, operation_id, lease_token, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'running')`,
  [input.callId, input.workspaceId, input.missionId, input.role, input.operationId, input.leaseToken ?? null])
  await client.query('DELETE FROM mission_budget_waits WHERE mission_id = $1 AND kind = $2 AND operation_id = $3',
    [input.missionId, input.kind, input.operationId])
  return true
}

async function wakeBudgetWaiters(client: PoolClient, scope: BudgetScope, budget: MissionBudgetSnapshot): Promise<void> {
  if (budget.status === 'available' || budget.status === 'unlimited') {
    const waits = await client.query<{
      kind: string; operation_id: string; agent_id: string; run_id: string | null; payload: Record<string, unknown>
    }>('DELETE FROM mission_budget_waits WHERE mission_id = $1 RETURNING *', [scope.missionId])
    for (const wait of waits.rows) {
      const payload = canonicalJson(wait.payload)
      const id = 'budget_resume_' + randomUUID()
      await client.query(`INSERT INTO inbox_messages
        (id, workspace_id, mission_id, agent_id, run_id, kind, payload, payload_hash, dedupe_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $1)`,
      [id, scope.workspaceId, scope.missionId, wait.agent_id, wait.run_id, wait.kind, payload,
        createHash('sha256').update(payload).digest('hex')])
      await client.query('INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
        ['wake_' + randomUUID(), EVENT_TOPICS.agentWake, wait.agent_id,
          canonicalJson({ schemaVersion: 1, type: 'agent.wake', workspaceId: scope.workspaceId,
            agentId: wait.agent_id, missionId: scope.missionId, reason: 'mission.budget_resumed' })])
    }
  }
}

export class MissionBudgetRepository {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(scope: BudgetScope): Promise<MissionBudgetSnapshot | null> {
    return withTransaction(this.pool, async (client) => {
      if (!await lockMission(client, scope)) return null
      await markAbandonedCalls(client, scope.missionId)
      return readMissionBudget(client, scope)
    })
  }

  async reserveRunCall(run: RuntimeRunContext, callId: string, leaseToken?: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      if (!await lockMission(client, run)) throw new Error('Mission not found for model budget')
      const lease = await client.query<{ lease_token: string }>(`SELECT l.lease_token FROM task_leases l
        JOIN agent_runs r ON r.id = l.run_id AND r.task_id = l.task_id
        WHERE l.run_id = $1 AND l.agent_id = $2 AND l.expires_at > NOW() AND r.status = 'running'
        AND ($3::text IS NULL OR l.lease_token = $3) FOR UPDATE OF l`, [run.runId, run.agentId, leaseToken ?? null])
      if (!lease.rows[0]) throw new Error('Task lease was lost before model budget admission')
      return reserveMissionModelCall(client, {
        ...run, callId, role: 'execution', operationId: run.runId, kind: 'run.control', leaseToken: lease.rows[0].lease_token,
        payload: { schemaVersion: 1, type: 'run.control', reason: 'mission.budget_resumed', runId: run.runId },
      })
    })
  }

  async settleModelCall(callId: string, usage: ModelUsage): Promise<void> {
    const reported = usage.usageReported !== false && Number.isSafeInteger(usage.inputTokens)
      && Number.isSafeInteger(usage.outputTokens) && usage.inputTokens >= 0 && usage.outputTokens >= 0
    await this.updateCall(callId, reported ? 'completed' : 'unknown', reported ? usage : undefined)
  }

  async recordUnknownModelCall(callId: string): Promise<void> { await this.updateCall(callId, 'unknown') }
  async cancelModelCall(callId: string): Promise<void> { await this.updateCall(callId, 'cancelled') }

  private async updateCall(callId: string, status: string, usage?: ModelUsage): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const found = await client.query<{ workspace_id: WorkspaceId; mission_id: MissionId }>(
        'SELECT workspace_id, mission_id FROM mission_model_calls WHERE id = $1', [callId])
      const row = found.rows[0]
      if (!row) throw new Error('Mission model budget call not found: ' + callId)
      await lockMission(client, { workspaceId: row.workspace_id, missionId: row.mission_id })
      await client.query(`UPDATE mission_model_calls SET status = $2, input_tokens = $3,
        output_tokens = $4, estimated_cost_usd = $5, finished_at = NOW()
        WHERE id = $1 AND (status = 'running' OR (status = 'unknown' AND $2 = 'completed'))`,
      [callId, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.estimatedCostUsd ?? null])
      const scope = { workspaceId: row.workspace_id, missionId: row.mission_id }
      const budget = (await readMissionBudget(client, scope))!
      await wakeBudgetWaiters(client, scope, budget)
    })
  }

  async setTokenLimit(input: BudgetScope & { readonly tokenLimit: number | null; readonly actorId: string }): Promise<MissionBudgetSnapshot | null> {
    if (input.tokenLimit !== null && (!Number.isSafeInteger(input.tokenLimit) || input.tokenLimit < 0)) {
      throw new RangeError('Mission token budget must be a non-negative safe integer or null')
    }
    return withTransaction(this.pool, async (client) => {
      if (!await lockMission(client, input)) return null
      await markAbandonedCalls(client, input.missionId)
      const previous = (await readMissionBudget(client, input))!
      await client.query('UPDATE missions SET budget_tokens = $2, updated_at = NOW() WHERE id = $1',
        [input.missionId, input.tokenLimit])
      const budget = (await readMissionBudget(client, input))!
      const project = await client.query<{ project_id: ProjectId }>('SELECT project_id FROM missions WHERE id = $1', [input.missionId])
      await appendDomainEvent(client, {
        type: 'mission.budget_changed', workspaceId: input.workspaceId, missionId: input.missionId,
        projectId: project.rows[0]!.project_id, actor: { kind: 'user', id: input.actorId as UserId },
        correlationId: ('budget_' + randomUUID()) as CorrelationId,
        payload: { previousTokenLimit: previous.tokenLimit, tokenLimit: budget.tokenLimit,
          measuredTokens: budget.totalTokens, unknownUsageCalls: budget.unknownUsageCalls },
      })
      await wakeBudgetWaiters(client, input, budget)
      return budget
    })
  }
}

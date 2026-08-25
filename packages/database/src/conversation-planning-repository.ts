import { createHash, randomUUID } from 'node:crypto'

import {
  EVENT_TOPICS,
  validateMissionPlan,
  type AgentId,
  type AgentRole,
  type ConversationId,
  type ConversationPlanningRequestId,
  type ConversationPlanningRequestSnapshot,
  type ConversationPlanningStatus,
  type CorrelationId,
  type IsoTimestamp,
  type MessageId,
  type MissionId,
  type MissionPlanDraft,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { appendDomainEvent } from './events.js'
import { canonicalJson } from './json.js'
import { ensurePrimaryMissionArtifact } from './mission-artifact.js'
import { withTransaction } from './transaction.js'

const MAX_SOURCE_MESSAGES = 50
const MAX_GOAL_BYTES = 20_000

export class ConversationPlanningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationPlanningError'
  }
}

interface PlanningRow {
  readonly id: string
  readonly workspace_id: string
  readonly project_id: string
  readonly conversation_id: string
  readonly mission_id: string
  readonly planner_agent_id: string
  readonly source_message_ids: readonly string[]
  readonly status: ConversationPlanningStatus
  readonly attempt: number
  readonly max_attempts: number
  readonly plan_version: number | null
  readonly error: Readonly<Record<string, unknown>> | null
  readonly plan: MissionPlanDraft | null
  readonly lease_token: string | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
}

interface PlanningScopeRow extends PlanningRow {
  readonly mission_title: string
  readonly mission_goal: string
  readonly mission_constraints: readonly unknown[]
  readonly conversation_title: string
  readonly model_provider: string
  readonly model_name: string
  readonly lease_expires_at: Date | string | null
}

export interface PlanningSourceMessage {
  readonly id: MessageId
  readonly authorKind: 'user' | 'agent' | 'system'
  readonly authorId: string
  readonly authorName: string
  readonly body: string
  readonly createdAt: IsoTimestamp
}

export interface CreateConversationPlanningRequestInput {
  readonly id?: ConversationPlanningRequestId
  readonly missionId?: MissionId
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
  readonly sourceMessageIds: readonly MessageId[]
  readonly title: string
  readonly goal?: string
  readonly constraints?: readonly string[]
  readonly acceptanceCriteria?: readonly string[]
  readonly plannerAgentId?: AgentId
  readonly createdBy: UserId
  readonly correlationId: CorrelationId
  readonly idempotencyKey?: string
}

export interface ConversationPlanningWork {
  readonly request: ConversationPlanningRequestSnapshot
  readonly leaseToken: string
  readonly missionTitle: string
  readonly missionGoal: string
  readonly missionConstraints: readonly unknown[]
  readonly conversationTitle: string
  readonly sourceMessages: readonly PlanningSourceMessage[]
  readonly availableRoles: readonly AgentRole[]
  readonly modelProvider: string
  readonly modelName: string
  readonly storedPlan?: MissionPlanDraft
}

export type ClaimConversationPlanningResult =
  | { readonly kind: 'work'; readonly work: ConversationPlanningWork }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }
  | { readonly kind: 'terminal'; readonly request: ConversationPlanningRequestSnapshot }

export interface CompletePlanningModelInput {
  readonly requestId: ConversationPlanningRequestId
  readonly plannerAgentId: AgentId
  readonly leaseToken: string
  readonly plan: MissionPlanDraft
  readonly promptSnapshot: Readonly<Record<string, unknown>>
  readonly responseSnapshot: Readonly<Record<string, unknown>>
  readonly modelProvider: string
  readonly modelName: string
  readonly providerRequestId?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estimatedCostUsd?: number
  readonly latencyMs: number
}

function iso(value: Date | string): IsoTimestamp {
  return (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) as IsoTimestamp
}

function snapshot(row: PlanningRow): ConversationPlanningRequestSnapshot {
  const errorMessage = typeof row.error?.['message'] === 'string' ? row.error['message'] : undefined
  return {
    id: row.id as ConversationPlanningRequestId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as ProjectId,
    conversationId: row.conversation_id as ConversationId,
    missionId: row.mission_id as MissionId,
    plannerAgentId: row.planner_agent_id as AgentId,
    sourceMessageIds: row.source_message_ids as readonly MessageId[],
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    ...(row.plan_version === null ? {} : { planVersion: row.plan_version }),
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function requestHash(input: {
  readonly conversationId: ConversationId
  readonly sourceMessageIds: readonly MessageId[]
  readonly title: string
  readonly goal?: string
  readonly plannerAgentId?: AgentId
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

function validateCreateInput(input: CreateConversationPlanningRequestInput): void {
  if (!input.title.trim() || input.title.length > 200) {
    throw new ConversationPlanningError('Planning Mission title must be between 1 and 200 characters')
  }
  const unique = new Set(input.sourceMessageIds)
  if (unique.size !== input.sourceMessageIds.length
      || unique.size < 1
      || unique.size > MAX_SOURCE_MESSAGES) {
    throw new ConversationPlanningError('Planning requires between 1 and 50 unique source messages')
  }
  if (input.goal !== undefined
      && (!input.goal.trim() || Buffer.byteLength(input.goal.trim(), 'utf8') > MAX_GOAL_BYTES)) {
    throw new ConversationPlanningError('Planning Mission goal must be between 1 and 20000 UTF-8 bytes')
  }
  if (input.idempotencyKey !== undefined
      && (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)) {
    throw new ConversationPlanningError('Planning idempotency key must be between 1 and 200 characters')
  }
}

function sourceGoal(messages: readonly PlanningSourceMessage[]): string {
  const value = [
    '根据以下项目协作消息，规划并交付一个可验证的软件工程 Mission：',
    '',
    ...messages.map((message) => message.authorName + '：' + message.body),
  ].join('\n')
  if (Buffer.byteLength(value, 'utf8') > MAX_GOAL_BYTES) {
    throw new ConversationPlanningError('Selected messages exceed the Mission goal limit; select fewer messages')
  }
  return value
}

export class ConversationPlanningRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateConversationPlanningRequestInput): Promise<{
    readonly request: ConversationPlanningRequestSnapshot
    readonly reused: boolean
  }> {
    validateCreateInput(input)
    const title = input.title.trim()
    const hash = requestHash({
      conversationId: input.conversationId,
      sourceMessageIds: input.sourceMessageIds,
      title,
      ...(input.goal === undefined ? {} : { goal: input.goal.trim() }),
      ...(input.plannerAgentId === undefined ? {} : { plannerAgentId: input.plannerAgentId }),
    })

    return withTransaction(this.pool, async (client) => {
      if (input.idempotencyKey !== undefined) {
        const existing = await client.query<PlanningRow & { request_hash: string }>(
          'SELECT * FROM conversation_planning_requests WHERE workspace_id = $1 AND idempotency_key = $2',
          [input.workspaceId, input.idempotencyKey.trim()],
        )
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== hash) {
            throw new ConversationPlanningError('Planning idempotency key was reused with different input')
          }
          return { request: snapshot(existing.rows[0]), reused: true }
        }
      }

      const conversation = await client.query<{ project_id: string; title: string }>(
        'SELECT conversation.project_id, conversation.title FROM conversations conversation ' +
        'JOIN conversation_members member ON member.conversation_id = conversation.id ' +
        "AND member.participant_kind = 'user' AND member.participant_id = $3 " +
        'WHERE conversation.id = $1 AND conversation.workspace_id = $2',
        [input.conversationId, input.workspaceId, input.createdBy],
      )
      const conversationRow = conversation.rows[0]
      if (!conversationRow) throw new ConversationPlanningError('Conversation was not found or the user is not a member')

      const sourceMessages = await this.loadSourceMessages(client, input.conversationId, input.sourceMessageIds)
      if (sourceMessages.length !== input.sourceMessageIds.length) {
        throw new ConversationPlanningError('Every source message must belong to the selected Conversation')
      }
      const planner = await client.query<{
        id: string
        model_provider: string
        model_name: string
      }>(
        'SELECT agent.id, agent.model_provider, agent.model_name FROM agents agent ' +
        'JOIN conversation_members member ON member.participant_id = agent.id ' +
        "AND member.participant_kind = 'agent' AND member.conversation_id = $2 " +
        "WHERE agent.workspace_id = $1 AND agent.role = 'planner' AND agent.status = 'active' " +
        'AND ($3::text IS NULL OR agent.id = $3) ORDER BY agent.created_at, agent.id LIMIT 1',
        [input.workspaceId, input.conversationId, input.plannerAgentId ?? null],
      )
      const plannerRow = planner.rows[0]
      if (!plannerRow) throw new ConversationPlanningError('Conversation has no active Planner Agent')

      const missionId = input.missionId ?? ('mission_' + randomUUID()) as MissionId
      const requestId = input.id ?? ('planning_' + randomUUID()) as ConversationPlanningRequestId
      const projectId = conversationRow.project_id as ProjectId
      const goal = input.goal?.trim() ?? sourceGoal(sourceMessages)
      await client.query(
        'INSERT INTO missions ' +
        '(id, workspace_id, project_id, conversation_id, source_message_ids, title, goal, constraints, ' +
        "acceptance_criteria, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'planning', $10)",
        [
          missionId,
          input.workspaceId,
          projectId,
          input.conversationId,
          input.sourceMessageIds,
          title,
          goal,
          canonicalJson(input.constraints ?? ['保留可审计的执行与验收证据']),
          canonicalJson(input.acceptanceCriteria ?? ['计划形成有效 DAG', '所有必需验收项均有持久化证据']),
          input.createdBy,
        ],
      )
      await ensurePrimaryMissionArtifact(client, {
        workspaceId: input.workspaceId,
        projectId,
        missionId,
        missionTitle: title,
        createdBy: input.createdBy,
      })
      await appendDomainEvent(client, {
        type: 'mission.created',
        workspaceId: input.workspaceId,
        projectId,
        missionId,
        actor: { kind: 'user', id: input.createdBy },
        correlationId: input.correlationId,
        payload: { title },
      })
      await appendDomainEvent(client, {
        type: 'mission.status_changed',
        workspaceId: input.workspaceId,
        projectId,
        missionId,
        actor: { kind: 'user', id: input.createdBy },
        correlationId: input.correlationId,
        payload: { from: 'draft', to: 'planning', reason: 'selected Conversation messages promoted to a Mission' },
      })
      const inserted = await client.query<PlanningRow>(
        'INSERT INTO conversation_planning_requests ' +
        '(id, workspace_id, project_id, conversation_id, mission_id, planner_agent_id, source_message_ids, ' +
        'idempotency_key, request_hash, model_provider, model_name, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *',
        [
          requestId,
          input.workspaceId,
          projectId,
          input.conversationId,
          missionId,
          plannerRow.id,
          input.sourceMessageIds,
          input.idempotencyKey?.trim() ?? null,
          hash,
          plannerRow.model_provider,
          plannerRow.model_name,
          input.createdBy,
        ],
      )
      await appendDomainEvent(client, {
        type: 'conversation.planning_requested',
        workspaceId: input.workspaceId,
        projectId,
        missionId,
        actor: { kind: 'user', id: input.createdBy },
        correlationId: input.correlationId,
        payload: {
          conversationId: input.conversationId,
          requestId,
          sourceMessageIds: input.sourceMessageIds,
          plannerAgentId: plannerRow.id as AgentId,
        },
      })

      const inboxPayload = {
        schemaVersion: 1,
        type: 'conversation.plan_requested',
        requestId,
        conversationId: input.conversationId,
        missionId,
      }
      const payloadJson = canonicalJson(inboxPayload)
      await client.query(
        'INSERT INTO inbox_messages ' +
        '(id, workspace_id, agent_id, mission_id, kind, payload, payload_hash, dedupe_key) ' +
        "VALUES ($1, $2, $3, $4, 'conversation.plan_requested', $5::jsonb, $6, $7)",
        [
          'inbox_' + randomUUID(),
          input.workspaceId,
          plannerRow.id,
          missionId,
          payloadJson,
          createHash('sha256').update(payloadJson).digest('hex'),
          'conversation-planning:' + requestId,
        ],
      )
      await client.query(
        'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
        [
          'wake_' + randomUUID(),
          EVENT_TOPICS.agentWake,
          plannerRow.id,
          canonicalJson({
            schemaVersion: 1,
            type: 'agent.wake',
            workspaceId: input.workspaceId,
            missionId,
            agentId: plannerRow.id,
            reason: 'conversation.plan_requested',
            requestId,
          }),
        ],
      )
      await client.query(
        "UPDATE conversation_message_deliveries SET status = 'context_loaded', delivered_at = NOW() " +
        "WHERE agent_id = $1 AND status = 'context_pending' AND message_id = ANY($2::text[])",
        [plannerRow.id, input.sourceMessageIds],
      )
      return { request: snapshot(inserted.rows[0]!), reused: false }
    })
  }

  async get(
    workspaceId: WorkspaceId,
    requestId: ConversationPlanningRequestId,
    actor: { readonly kind: 'user' | 'agent'; readonly id: string },
  ): Promise<ConversationPlanningRequestSnapshot | null> {
    const table = actor.kind === 'user' ? 'users' : 'agents'
    const found = await this.pool.query<PlanningRow>(
      "SELECT request.*, CASE WHEN request.status = 'awaiting_approval' " +
      "AND mission.approved_at IS NOT NULL THEN 'approved' ELSE request.status END AS status " +
      'FROM conversation_planning_requests request JOIN missions mission ON mission.id = request.mission_id ' +
      'JOIN ' + table + ' actor ON actor.id = $3 AND actor.workspace_id = request.workspace_id ' +
      'JOIN conversation_members member ON member.conversation_id = request.conversation_id ' +
      'AND member.workspace_id = request.workspace_id AND member.participant_kind = $4 ' +
      'AND member.participant_id = actor.id ' +
      'WHERE request.workspace_id = $1 AND request.id = $2',
      [workspaceId, requestId, actor.id, actor.kind],
    )
    return found.rows[0] ? snapshot(found.rows[0]) : null
  }

  async claim(input: {
    readonly requestId: ConversationPlanningRequestId
    readonly plannerAgentId: AgentId
    readonly leaseSeconds: number
  }): Promise<ClaimConversationPlanningResult> {
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 1_800) {
      throw new RangeError('Planning lease must be between 30 and 1800 seconds')
    }
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<PlanningScopeRow>(
        'SELECT request.*, mission.title AS mission_title, mission.goal AS mission_goal, ' +
        'mission.constraints AS mission_constraints, conversation.title AS conversation_title ' +
        'FROM conversation_planning_requests request ' +
        'JOIN missions mission ON mission.id = request.mission_id ' +
        'JOIN conversations conversation ON conversation.id = request.conversation_id ' +
        'WHERE request.id = $1 AND request.planner_agent_id = $2 FOR UPDATE OF request',
        [input.requestId, input.plannerAgentId],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Conversation Planning Request not found for this Planner')
      if (['awaiting_approval', 'approved', 'failed'].includes(row.status)) {
        return { kind: 'terminal', request: snapshot(row) }
      }
      const leaseExpiry = row.lease_expires_at === null ? 0 : new Date(row.lease_expires_at).getTime()
      if ((row.status === 'running' || row.status === 'model_complete') && leaseExpiry > Date.now()) {
        return { kind: 'busy', retryAfterMs: Math.max(250, leaseExpiry - Date.now()) }
      }
      if (row.plan === null && row.attempt >= row.max_attempts) {
        const failed = await client.query<PlanningRow>(
          "UPDATE conversation_planning_requests SET status = 'failed', lease_token = NULL, " +
          "lease_expires_at = NULL, error = '{\"message\":\"Planning retry budget exhausted\"}'::jsonb, " +
          'finished_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
          [row.id],
        )
        return { kind: 'terminal', request: snapshot(failed.rows[0]!) }
      }
      const leaseToken = 'planning_lease_' + randomUUID()
      const claimed = await client.query<PlanningScopeRow>(
        "UPDATE conversation_planning_requests SET status = CASE WHEN plan IS NULL THEN 'running' ELSE 'model_complete' END, " +
        'attempt = CASE WHEN plan IS NULL THEN attempt + 1 ELSE attempt END, lease_token = $2, ' +
        'error = NULL, ' +
        "lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 second'), " +
        'started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = $1 RETURNING *',
        [row.id, leaseToken, input.leaseSeconds],
      )
      const claimedRow = { ...row, ...claimed.rows[0] } as PlanningScopeRow
      const sources = await this.loadSourceMessages(
        client,
        row.conversation_id as ConversationId,
        row.source_message_ids as readonly MessageId[],
      )
      const roles = await client.query<{ readonly role: AgentRole }>(
        'SELECT DISTINCT agent.role FROM conversation_members member ' +
        'JOIN agents agent ON agent.id = member.participant_id AND agent.workspace_id = member.workspace_id ' +
        "WHERE member.conversation_id = $1 AND member.workspace_id = $2 AND member.participant_kind = 'agent' " +
        "AND agent.status = 'active' ORDER BY agent.role",
        [row.conversation_id, row.workspace_id],
      )
      return {
        kind: 'work',
        work: {
          request: snapshot(claimedRow),
          leaseToken,
          missionTitle: row.mission_title,
          missionGoal: row.mission_goal,
          missionConstraints: row.mission_constraints,
          conversationTitle: row.conversation_title,
          sourceMessages: sources,
          availableRoles: roles.rows.map((agent) => agent.role),
          modelProvider: row.model_provider,
          modelName: row.model_name,
          ...(row.plan === null ? {} : { storedPlan: row.plan }),
        },
      }
    })
  }

  async completeModel(input: CompletePlanningModelInput): Promise<void> {
    const validation = validateMissionPlan(input.plan)
    if (!validation.valid) {
      throw new Error('Planner returned an invalid Mission plan: ' + validation.errors.map((error) => error.message).join('; '))
    }
    const planJson = canonicalJson(input.plan)
    const planHash = createHash('sha256').update(planJson).digest('hex')
    const result = await this.pool.query(
      "UPDATE conversation_planning_requests SET status = 'model_complete', error = NULL, " +
      'plan = $4::jsonb, plan_hash = $5, ' +
      'prompt_snapshot = $6::jsonb, response_snapshot = $7::jsonb, model_provider = $8, model_name = $9, ' +
      'provider_request_id = $10, input_tokens = $11, output_tokens = $12, estimated_cost_usd = $13, ' +
      'latency_ms = $14, updated_at = NOW() WHERE id = $1 AND planner_agent_id = $2 ' +
      "AND status = 'running' AND lease_token = $3 AND lease_expires_at > NOW()",
      [
        input.requestId,
        input.plannerAgentId,
        input.leaseToken,
        planJson,
        planHash,
        canonicalJson(input.promptSnapshot),
        canonicalJson(input.responseSnapshot),
        input.modelProvider,
        input.modelName,
        input.providerRequestId ?? null,
        input.inputTokens,
        input.outputTokens,
        input.estimatedCostUsd ?? null,
        input.latencyMs,
      ],
    )
    if (result.rowCount !== 1) throw new Error('Conversation Planning lease was lost before model completion')
  }

  async markAwaitingApproval(input: {
    readonly requestId: ConversationPlanningRequestId
    readonly plannerAgentId: AgentId
    readonly leaseToken: string
    readonly planVersion: number
  }): Promise<ConversationPlanningRequestSnapshot> {
    const result = await this.pool.query<PlanningRow>(
      "UPDATE conversation_planning_requests SET status = 'awaiting_approval', error = NULL, plan_version = $4, " +
      'lease_token = NULL, lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW() ' +
      "WHERE id = $1 AND planner_agent_id = $2 AND status = 'model_complete' AND lease_token = $3 RETURNING *",
      [input.requestId, input.plannerAgentId, input.leaseToken, input.planVersion],
    )
    if (!result.rows[0]) throw new Error('Conversation Planning Request is not ready for approval')
    return snapshot(result.rows[0])
  }

  async fail(input: {
    readonly requestId: ConversationPlanningRequestId
    readonly plannerAgentId: AgentId
    readonly leaseToken: string
    readonly message: string
  }): Promise<{ readonly retryable: boolean; readonly request: ConversationPlanningRequestSnapshot }> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<PlanningRow>(
        'SELECT * FROM conversation_planning_requests WHERE id = $1 AND planner_agent_id = $2 FOR UPDATE',
        [input.requestId, input.plannerAgentId],
      )
      const row = current.rows[0]
      if (!row) throw new Error('Conversation Planning Request not found')
      if (!['running', 'model_complete'].includes(row.status) || row.lease_token !== input.leaseToken) {
        return { retryable: false, request: snapshot(row) }
      }
      const retryable = row.plan !== null || row.attempt < row.max_attempts
      const nextStatus = retryable ? (row.plan === null ? 'queued' : 'model_complete') : 'failed'
      const updated = await client.query<PlanningRow>(
        'UPDATE conversation_planning_requests SET status = $2, lease_token = NULL, lease_expires_at = NULL, ' +
        'error = $3::jsonb, updated_at = NOW(), finished_at = CASE WHEN $2 = \'failed\' THEN NOW() ELSE NULL END ' +
        'WHERE id = $1 RETURNING *',
        [row.id, nextStatus, canonicalJson({ message: input.message })],
      )
      return { retryable, request: snapshot(updated.rows[0]!) }
    })
  }

  private async loadSourceMessages(
    client: PoolClient,
    conversationId: ConversationId,
    ids: readonly MessageId[],
  ): Promise<readonly PlanningSourceMessage[]> {
    const messages = await client.query<{
      id: string
      author_kind: 'user' | 'agent' | 'system'
      author_id: string
      author_name: string
      body: string
      created_at: Date | string
    }>(
      'SELECT message.id, message.author_kind, message.author_id, ' +
      "COALESCE(user_account.display_name, agent.name, message.author_id) AS author_name, " +
      'message.body, message.created_at FROM messages message ' +
      "LEFT JOIN users user_account ON message.author_kind = 'user' AND user_account.id = message.author_id " +
      "LEFT JOIN agents agent ON message.author_kind = 'agent' AND agent.id = message.author_id " +
      'WHERE message.conversation_id = $1 AND message.id = ANY($2::text[]) ORDER BY message.sequence',
      [conversationId, ids],
    )
    return messages.rows.map((message) => ({
      id: message.id as MessageId,
      authorKind: message.author_kind,
      authorId: message.author_id,
      authorName: message.author_name,
      body: message.body,
      createdAt: iso(message.created_at),
    }))
  }
}

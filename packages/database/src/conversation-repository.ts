import { createHash, randomUUID } from 'node:crypto'

import {
  EVENT_TOPICS,
  type ActorRef,
  type AgentId,
  type ArtifactId,
  type ConversationEntityRefs,
  type ConversationId,
  type ConversationKind,
  type ConversationMember,
  type ConversationMessage,
  type ConversationSnapshot,
  type CorrelationId,
  type IsoTimestamp,
  type MessageDelivery,
  type MessageDeliveryStatus,
  type MessageId,
  type MissionId,
  type PostConversationMessageResult,
  type ProjectId,
  type RunId,
  type TaskId,
  type UserId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { appendDomainEvent } from './events.js'
import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_MENTIONS = 32

type ParticipantActor = Extract<ActorRef, { readonly kind: 'user' | 'agent' }>

interface ConversationRow {
  readonly id: string
  readonly workspace_id: string
  readonly project_id: string
  readonly kind: ConversationKind
  readonly title: string
  readonly latest_message_at: Date | string | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
}

interface MessageRow {
  readonly id: string
  readonly workspace_id: string
  readonly conversation_id: string
  readonly sequence: string | number | bigint
  readonly author_kind: 'user' | 'agent' | 'system'
  readonly author_id: string
  readonly author_name: string | null
  readonly body: string
  readonly mentioned_agent_ids: readonly string[]
  readonly entity_refs: Readonly<Record<string, unknown>>
  readonly reply_to_message_id: string | null
  readonly created_at: Date | string
}

interface DeliveryRow {
  readonly message_id: string
  readonly agent_id: string
  readonly run_id: string | null
  readonly status: MessageDeliveryStatus
  readonly delivered_at: Date | string | null
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super('Conversation was not found in the requested Workspace')
    this.name = 'ConversationNotFoundError'
  }
}

export class ConversationAccessError extends Error {
  constructor(message = 'Actor is not a member of this Conversation') {
    super(message)
    this.name = 'ConversationAccessError'
  }
}

export class ConversationScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationScopeError'
  }
}

export interface CreateConversationInput {
  readonly id?: ConversationId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly kind: ConversationKind
  readonly title: string
  readonly members: readonly { readonly kind: 'user' | 'agent'; readonly id: string }[]
  readonly actor: ParticipantActor
  readonly correlationId: CorrelationId
}

export interface PostConversationMessageInput {
  readonly id?: MessageId
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
  readonly author: ParticipantActor
  readonly body: string
  readonly mentions?: readonly AgentId[]
  readonly entityRefs?: ConversationEntityRefs
  readonly replyToMessageId?: MessageId
  readonly idempotencyKey?: string
  readonly correlationId: CorrelationId
}

export interface ListConversationMessagesInput {
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
  readonly actor: ParticipantActor
  readonly beforeSequence?: string
  readonly limit?: number
}

function iso(value: Date | string): IsoTimestamp {
  return (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) as IsoTimestamp
}

function actorKey(actor: ParticipantActor): string {
  return actor.kind + ':' + actor.id
}

function validateBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) throw new ConversationScopeError('Conversation message cannot be empty')
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new ConversationScopeError('Conversation message exceeds 64 KiB')
  }
  return trimmed
}

function validateTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed || trimmed.length > 200) {
    throw new ConversationScopeError('Conversation title must be between 1 and 200 characters')
  }
  return trimmed
}

function uniqueMentions(mentions: readonly AgentId[]): readonly AgentId[] {
  const output = [...new Set(mentions)]
  if (output.length > MAX_MENTIONS) {
    throw new ConversationScopeError('A message can mention at most 32 Agents')
  }
  return output
}

function entityRefs(value: Readonly<Record<string, unknown>>): ConversationEntityRefs {
  const result: {
    missionId?: MissionId
    taskId?: TaskId
    runId?: RunId
    artifactId?: ArtifactId
  } = {}
  if (typeof value['missionId'] === 'string') result.missionId = value['missionId'] as MissionId
  if (typeof value['taskId'] === 'string') result.taskId = value['taskId'] as TaskId
  if (typeof value['runId'] === 'string') result.runId = value['runId'] as RunId
  if (typeof value['artifactId'] === 'string') result.artifactId = value['artifactId'] as ArtifactId
  return result
}

function messageActor(row: MessageRow): ActorRef {
  if (row.author_kind === 'agent') {
    const refs = entityRefs(row.entity_refs)
    return {
      kind: 'agent',
      id: row.author_id as AgentId,
      ...(refs.runId === undefined ? {} : { runId: refs.runId }),
    }
  }
  if (row.author_kind === 'user') return { kind: 'user', id: row.author_id as UserId }
  return { kind: 'system', id: row.author_id }
}

function deliverySnapshot(row: DeliveryRow): MessageDelivery {
  return {
    agentId: row.agent_id as AgentId,
    status: row.status,
    ...(row.run_id === null ? {} : { runId: row.run_id as RunId }),
    ...(row.delivered_at === null ? {} : { deliveredAt: iso(row.delivered_at) }),
  }
}

function messageSnapshot(row: MessageRow, deliveries: readonly DeliveryRow[]): ConversationMessage {
  return {
    id: row.id as MessageId,
    workspaceId: row.workspace_id as WorkspaceId,
    conversationId: row.conversation_id as ConversationId,
    sequence: row.sequence.toString(),
    author: messageActor(row),
    authorName: row.author_name ?? (row.author_kind === 'system' ? 'RunGuild' : row.author_id),
    body: row.body,
    mentions: row.mentioned_agent_ids as readonly AgentId[],
    entityRefs: entityRefs(row.entity_refs),
    deliveries: deliveries.map(deliverySnapshot),
    ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id as MessageId }),
    createdAt: iso(row.created_at),
  }
}

async function loadMembers(client: PoolClient, conversationIds: readonly string[]): Promise<Map<string, ConversationMember[]>> {
  const result = new Map<string, ConversationMember[]>()
  if (conversationIds.length === 0) return result
  const members = await client.query<{
    conversation_id: string
    participant_kind: 'user' | 'agent'
    participant_id: string
    notifications: boolean
    name: string
    role: Exclude<ConversationMember['role'], undefined> | null
    status: Exclude<ConversationMember['status'], undefined> | null
  }>(
    'SELECT member.conversation_id, member.participant_kind, member.participant_id, member.notifications, ' +
    "COALESCE(user_account.display_name, agent.name, member.participant_id) AS name, agent.role, agent.status " +
    'FROM conversation_members member ' +
    'LEFT JOIN users user_account ON member.participant_kind = \'user\' AND user_account.id = member.participant_id ' +
    'LEFT JOIN agents agent ON member.participant_kind = \'agent\' AND agent.id = member.participant_id ' +
    'WHERE member.conversation_id = ANY($1::text[]) ' +
    'ORDER BY member.conversation_id, CASE member.participant_kind WHEN \'user\' THEN 0 ELSE 1 END, member.joined_at',
    [conversationIds],
  )
  for (const member of members.rows) {
    const values = result.get(member.conversation_id) ?? []
    values.push({
      kind: member.participant_kind,
      id: member.participant_id,
      name: member.name,
      notifications: member.notifications,
      ...(member.role === null ? {} : { role: member.role }),
      ...(member.status === null ? {} : { status: member.status }),
    })
    result.set(member.conversation_id, values)
  }
  return result
}

function conversationSnapshot(row: ConversationRow, members: readonly ConversationMember[]): ConversationSnapshot {
  return {
    id: row.id as ConversationId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as ProjectId,
    kind: row.kind,
    title: row.title,
    members,
    ...(row.latest_message_at === null ? {} : { latestMessageAt: iso(row.latest_message_at) }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export class ConversationRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateConversationInput): Promise<ConversationSnapshot> {
    const title = validateTitle(input.title)
    const members = [
      ...input.members,
      { kind: input.actor.kind, id: input.actor.id },
    ].filter((member, index, all) =>
      all.findIndex((candidate) => candidate.kind === member.kind && candidate.id === member.id) === index)
    if (members.length === 0 || members.length > 100) {
      throw new ConversationScopeError('Conversation requires between 1 and 100 members')
    }

    return withTransaction(this.pool, async (client) => {
      await this.assertProject(client, input.workspaceId, input.projectId)
      await this.assertActorWorkspace(client, input.workspaceId, input.actor)
      const id = input.id ?? ('conversation_' + randomUUID()) as ConversationId
      const inserted = await client.query<ConversationRow>(
        'INSERT INTO conversations (id, workspace_id, project_id, kind, title) ' +
        'VALUES ($1, $2, $3, $4, $5) RETURNING id, workspace_id, project_id, kind, title, ' +
        'NULL::timestamptz AS latest_message_at, created_at, updated_at',
        [id, input.workspaceId, input.projectId, input.kind, title],
      )
      for (const member of members) {
        await client.query(
          'INSERT INTO conversation_members ' +
          '(conversation_id, workspace_id, participant_kind, participant_id) VALUES ($1, $2, $3, $4)',
          [id, input.workspaceId, member.kind, member.id],
        )
      }
      await appendDomainEvent(client, {
        type: 'conversation.created',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: input.actor,
        correlationId: input.correlationId,
        payload: { conversationId: id, title },
      })
      const memberMap = await loadMembers(client, [id])
      return conversationSnapshot(inserted.rows[0]!, memberMap.get(id) ?? [])
    })
  }

  async listProject(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    actor: ParticipantActor,
  ): Promise<readonly ConversationSnapshot[]> {
    return withTransaction(this.pool, async (client) => {
      await this.assertActorWorkspace(client, workspaceId, actor)
      const conversations = await client.query<ConversationRow>(
        'SELECT conversation.id, conversation.workspace_id, conversation.project_id, conversation.kind, ' +
        'conversation.title, MAX(message.created_at) AS latest_message_at, ' +
        'conversation.created_at, conversation.updated_at ' +
        'FROM conversations conversation ' +
        'JOIN conversation_members current_member ON current_member.conversation_id = conversation.id ' +
        'AND current_member.participant_kind = $3 AND current_member.participant_id = $4 ' +
        'LEFT JOIN messages message ON message.conversation_id = conversation.id ' +
        'WHERE conversation.workspace_id = $1 AND conversation.project_id = $2 ' +
        'GROUP BY conversation.id ORDER BY COALESCE(MAX(message.created_at), conversation.updated_at) DESC',
        [workspaceId, projectId, actor.kind, actor.id],
      )
      const memberMap = await loadMembers(client, conversations.rows.map((row) => row.id))
      return conversations.rows.map((row) => conversationSnapshot(row, memberMap.get(row.id) ?? []))
    })
  }

  async listMessages(input: ListConversationMessagesInput): Promise<readonly ConversationMessage[]> {
    const limit = input.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ConversationScopeError('Message page limit must be between 1 and 200')
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertConversationAccess(client, input.workspaceId, input.conversationId, input.actor)
      const before = input.beforeSequence === undefined ? null : BigInt(input.beforeSequence).toString()
      const messages = await client.query<MessageRow>(
        'SELECT message.id, message.workspace_id, message.conversation_id, message.sequence, ' +
        'message.author_kind, message.author_id, ' +
        'COALESCE(user_account.display_name, agent.name) AS author_name, message.body, ' +
        'message.mentioned_agent_ids, message.entity_refs, message.reply_to_message_id, message.created_at ' +
        'FROM messages message ' +
        'LEFT JOIN users user_account ON message.author_kind = \'user\' AND user_account.id = message.author_id ' +
        'LEFT JOIN agents agent ON message.author_kind = \'agent\' AND agent.id = message.author_id ' +
        'WHERE message.workspace_id = $1 AND message.conversation_id = $2 ' +
        'AND ($3::bigint IS NULL OR message.sequence < $3) ' +
        'ORDER BY message.sequence DESC LIMIT $4',
        [input.workspaceId, input.conversationId, before, limit],
      )
      const ordered = [...messages.rows].reverse()
      const deliveryMap = await this.loadDeliveries(client, ordered.map((message) => message.id))
      return ordered.map((message) => messageSnapshot(message, deliveryMap.get(message.id) ?? []))
    })
  }

  async postMessage(input: PostConversationMessageInput): Promise<PostConversationMessageResult> {
    const body = validateBody(input.body)
    const mentions = uniqueMentions(input.mentions ?? [])
    const refs = input.entityRefs ?? {}
    if (input.idempotencyKey !== undefined && (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)) {
      throw new ConversationScopeError('Message idempotency key must be between 1 and 200 characters')
    }

    return withTransaction(this.pool, async (client) => {
      const conversation = await this.assertConversationAccess(
        client,
        input.workspaceId,
        input.conversationId,
        input.author,
      )
      await this.assertEntityRefs(client, conversation, refs)
      const id = input.id ?? ('message_' + randomUUID()) as MessageId
      const inserted = await client.query<MessageRow>(
        'INSERT INTO messages ' +
        '(id, workspace_id, conversation_id, author_kind, author_id, body, entity_refs, ' +
        'mentioned_agent_ids, reply_to_message_id, idempotency_key) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9, $10) ' +
        'ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING ' +
        'RETURNING id, workspace_id, conversation_id, sequence, author_kind, author_id, NULL::text AS author_name, ' +
        'body, mentioned_agent_ids, entity_refs, reply_to_message_id, created_at',
        [
          id,
          input.workspaceId,
          input.conversationId,
          input.author.kind,
          input.author.id,
          body,
          canonicalJson(refs),
          mentions,
          input.replyToMessageId ?? null,
          input.idempotencyKey?.trim() ?? null,
        ],
      )
      let row = inserted.rows[0]
      const reused = !row
      if (!row) {
        const existing = await client.query<MessageRow>(
          'SELECT message.id, message.workspace_id, message.conversation_id, message.sequence, ' +
          'message.author_kind, message.author_id, NULL::text AS author_name, message.body, ' +
          'message.mentioned_agent_ids, message.entity_refs, message.reply_to_message_id, message.created_at ' +
          'FROM messages message WHERE message.workspace_id = $1 AND message.idempotency_key = $2',
          [input.workspaceId, input.idempotencyKey?.trim()],
        )
        row = existing.rows[0]
        if (!row) throw new Error('Idempotent Conversation message was not found')
        if (row.conversation_id !== input.conversationId
            || row.author_kind !== input.author.kind
            || row.author_id !== input.author.id
            || row.body !== body
            || canonicalJson(row.entity_refs) !== canonicalJson(refs)
            || canonicalJson(row.mentioned_agent_ids) !== canonicalJson(mentions)) {
          throw new ConversationScopeError('Message idempotency key was reused with different content')
        }
      }

      if (!reused) {
        await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [input.conversationId])
        await appendDomainEvent(client, {
          type: 'message.posted',
          workspaceId: input.workspaceId,
          projectId: conversation.project_id as ProjectId,
          ...(refs.missionId === undefined ? {} : { missionId: refs.missionId }),
          actor: input.author,
          correlationId: input.correlationId,
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          payload: {
            conversationId: input.conversationId,
            messageId: row.id as MessageId,
            mentionedAgentIds: mentions,
          },
        })
        await this.routeMentions(client, row.id as MessageId, input, body, mentions, refs)
      }

      const enriched = await this.loadMessage(client, row.id as MessageId)
      if (!enriched) throw new Error('Conversation message was not persisted')
      return { message: enriched, reused }
    })
  }

  private async routeMentions(
    client: PoolClient,
    messageId: MessageId,
    input: PostConversationMessageInput,
    body: string,
    mentions: readonly AgentId[],
    refs: ConversationEntityRefs,
  ): Promise<void> {
    for (const agentId of mentions) {
      const currentRun = input.author.kind === 'agent' && input.author.id === agentId
        ? input.author.runId
        : undefined
      if (currentRun !== undefined) {
        await this.insertDelivery(client, messageId, input.conversationId, agentId, 'context_loaded', currentRun)
        continue
      }
      const active = refs.missionId === undefined ? null : await client.query<{ id: string }>(
        'SELECT run.id FROM agent_runs run WHERE run.workspace_id = $1 AND run.mission_id = $2 ' +
        'AND run.agent_id = $3 AND run.status IN ' +
        "('starting', 'running', 'waiting_tool', 'waiting_human') " +
        'AND ($4::text IS NULL OR run.task_id = $4) ORDER BY run.updated_at DESC, run.id DESC LIMIT 1',
        [input.workspaceId, refs.missionId, agentId, refs.taskId ?? null],
      )
      const runId = active?.rows[0]?.id as RunId | undefined
      if (runId === undefined) {
        await this.insertDelivery(client, messageId, input.conversationId, agentId, 'context_pending')
        continue
      }

      const controlId = 'control_' + randomUUID()
      const controlPayload = {
        message: '[RunGuild team room] ' + input.author.kind + ' ' + input.author.id + ': ' + body,
        conversationId: input.conversationId,
        messageId,
        author: input.author,
      }
      await client.query(
        'INSERT INTO run_control_requests ' +
        '(id, workspace_id, run_id, kind, payload, created_by, dedupe_key) ' +
        "VALUES ($1, $2, $3, 'steer', $4::jsonb, $5, $6) ON CONFLICT (run_id, dedupe_key) DO NOTHING",
        [
          controlId,
          input.workspaceId,
          runId,
          canonicalJson(controlPayload),
          actorKey(input.author),
          'conversation:' + messageId,
        ],
      )
      const wakeData = {
        schemaVersion: 1,
        type: 'agent.wake',
        reason: 'run.control',
        workspaceId: input.workspaceId,
        missionId: refs.missionId,
        runId,
        agentId,
        controlId,
        controlKind: 'steer',
      }
      const wakePayload = canonicalJson(wakeData)
      const inbox = await client.query<{ id: string }>(
        'INSERT INTO inbox_messages ' +
        '(id, workspace_id, agent_id, mission_id, run_id, kind, payload, payload_hash, dedupe_key) ' +
        "VALUES ($1, $2, $3, $4, $5, 'run.control', $6::jsonb, $7, $8) " +
        'ON CONFLICT (agent_id, dedupe_key) DO NOTHING RETURNING id',
        [
          'inbox_' + randomUUID(),
          input.workspaceId,
          agentId,
          refs.missionId,
          runId,
          wakePayload,
          createHash('sha256').update(wakePayload).digest('hex'),
          'run-control:' + controlId,
        ],
      )
      if (inbox.rows[0]) {
        await client.query(
          'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
          ['wake_' + randomUUID(), EVENT_TOPICS.agentWake, agentId, wakePayload],
        )
      }
      await this.insertDelivery(client, messageId, input.conversationId, agentId, 'steered', runId)
    }
  }

  private async insertDelivery(
    client: PoolClient,
    messageId: MessageId,
    conversationId: ConversationId,
    agentId: AgentId,
    status: MessageDeliveryStatus,
    runId?: RunId,
  ): Promise<void> {
    await client.query(
      'INSERT INTO conversation_message_deliveries ' +
      '(message_id, conversation_id, agent_id, run_id, status, delivered_at) ' +
      'VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = \'context_pending\' THEN NULL ELSE NOW() END)',
      [messageId, conversationId, agentId, runId ?? null, status],
    )
  }

  private async loadMessage(client: PoolClient, messageId: MessageId): Promise<ConversationMessage | null> {
    const message = await client.query<MessageRow>(
      'SELECT message.id, message.workspace_id, message.conversation_id, message.sequence, ' +
      'message.author_kind, message.author_id, COALESCE(user_account.display_name, agent.name) AS author_name, ' +
      'message.body, message.mentioned_agent_ids, message.entity_refs, message.reply_to_message_id, message.created_at ' +
      'FROM messages message ' +
      'LEFT JOIN users user_account ON message.author_kind = \'user\' AND user_account.id = message.author_id ' +
      'LEFT JOIN agents agent ON message.author_kind = \'agent\' AND agent.id = message.author_id ' +
      'WHERE message.id = $1',
      [messageId],
    )
    const row = message.rows[0]
    if (!row) return null
    const deliveries = await this.loadDeliveries(client, [row.id])
    return messageSnapshot(row, deliveries.get(row.id) ?? [])
  }

  private async loadDeliveries(client: PoolClient, messageIds: readonly string[]): Promise<Map<string, DeliveryRow[]>> {
    const result = new Map<string, DeliveryRow[]>()
    if (messageIds.length === 0) return result
    const deliveries = await client.query<DeliveryRow>(
      'SELECT message_id, agent_id, run_id, status, delivered_at ' +
      'FROM conversation_message_deliveries WHERE message_id = ANY($1::text[]) ORDER BY created_at, agent_id',
      [messageIds],
    )
    for (const delivery of deliveries.rows) {
      const values = result.get(delivery.message_id) ?? []
      values.push(delivery)
      result.set(delivery.message_id, values)
    }
    return result
  }

  private async assertProject(client: PoolClient, workspaceId: WorkspaceId, projectId: ProjectId): Promise<void> {
    const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2', [projectId, workspaceId])
    if (!project.rows[0]) throw new ConversationScopeError('Project was not found in the requested Workspace')
  }

  private async assertActorWorkspace(client: PoolClient, workspaceId: WorkspaceId, actor: ParticipantActor): Promise<void> {
    const table = actor.kind === 'user' ? 'users' : 'agents'
    const found = await client.query('SELECT 1 FROM ' + table + ' WHERE id = $1 AND workspace_id = $2', [actor.id, workspaceId])
    if (!found.rows[0]) throw new ConversationAccessError('Actor is outside the requested Workspace')
  }

  private async assertConversationAccess(
    client: PoolClient,
    workspaceId: WorkspaceId,
    conversationId: ConversationId,
    actor: ParticipantActor,
  ): Promise<ConversationRow> {
    await this.assertActorWorkspace(client, workspaceId, actor)
    const conversation = await client.query<ConversationRow>(
      'SELECT conversation.id, conversation.workspace_id, conversation.project_id, conversation.kind, ' +
      'conversation.title, NULL::timestamptz AS latest_message_at, conversation.created_at, conversation.updated_at ' +
      'FROM conversations conversation WHERE conversation.id = $1 AND conversation.workspace_id = $2',
      [conversationId, workspaceId],
    )
    const row = conversation.rows[0]
    if (!row) throw new ConversationNotFoundError()
    const member = await client.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND workspace_id = $2 ' +
      'AND participant_kind = $3 AND participant_id = $4',
      [conversationId, workspaceId, actor.kind, actor.id],
    )
    if (!member.rows[0]) throw new ConversationAccessError()
    return row
  }

  private async assertEntityRefs(
    client: PoolClient,
    conversation: ConversationRow,
    refs: ConversationEntityRefs,
  ): Promise<void> {
    if (refs.missionId !== undefined) {
      const mission = await client.query<{ conversation_id: string | null }>(
        'SELECT conversation_id FROM missions WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE',
        [refs.missionId, conversation.workspace_id, conversation.project_id],
      )
      const row = mission.rows[0]
      if (!row) throw new ConversationScopeError('Referenced Mission is outside the Conversation project')
      if (row.conversation_id !== null && row.conversation_id !== conversation.id) {
        throw new ConversationScopeError('Referenced Mission belongs to another Conversation')
      }
      if (row.conversation_id === null) {
        await client.query('UPDATE missions SET conversation_id = $2, updated_at = NOW() WHERE id = $1', [refs.missionId, conversation.id])
      }
    }
    if (refs.taskId !== undefined) {
      if (refs.missionId === undefined) throw new ConversationScopeError('A Task reference requires a Mission reference')
      const task = await client.query('SELECT 1 FROM tasks WHERE id = $1 AND mission_id = $2', [refs.taskId, refs.missionId])
      if (!task.rows[0]) throw new ConversationScopeError('Referenced Task is outside the Mission')
    }
    if (refs.runId !== undefined) {
      if (refs.taskId === undefined || refs.missionId === undefined) {
        throw new ConversationScopeError('A Run reference requires Mission and Task references')
      }
      const run = await client.query(
        'SELECT 1 FROM agent_runs WHERE id = $1 AND workspace_id = $2 AND mission_id = $3 AND task_id = $4',
        [refs.runId, conversation.workspace_id, refs.missionId, refs.taskId],
      )
      if (!run.rows[0]) throw new ConversationScopeError('Referenced Run is outside the Task')
    }
    if (refs.artifactId !== undefined) {
      const artifact = await client.query(
        'SELECT 1 FROM artifacts WHERE id = $1 AND workspace_id = $2 AND project_id = $3 ' +
        'AND ($4::text IS NULL OR mission_id IS NULL OR mission_id = $4)',
        [refs.artifactId, conversation.workspace_id, conversation.project_id, refs.missionId ?? null],
      )
      if (!artifact.rows[0]) throw new ConversationScopeError('Referenced Artifact is outside the Conversation scope')
    }
  }
}

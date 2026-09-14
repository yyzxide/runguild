import { createHash } from 'node:crypto'

import {
  type AgentId,
  type ConversationId,
  type ConversationMessage,
  type ConversationPlanningRequestSnapshot,
  type CorrelationId,
  type MessageId,
  type UserId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { ConversationPlanningRepository } from './conversation-planning-repository.js'
import { ConversationRepository, ConversationScopeError } from './conversation-repository.js'
import { withTransaction } from './transaction.js'

export interface SubmitConversationTaskInput {
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
  readonly createdBy: UserId
  readonly body: string
  readonly mentions?: readonly AgentId[]
  readonly replyToMessageId?: MessageId
  readonly title: string
  readonly plannerAgentId?: AgentId
  readonly clientRequestId: string
  readonly correlationId: CorrelationId
}

export interface SubmitConversationTaskResult {
  readonly message: ConversationMessage
  readonly request: ConversationPlanningRequestSnapshot
  readonly reused: boolean
}

function commandKey(kind: 'message' | 'planning', clientRequestId: string): string {
  const normalized = clientRequestId.trim()
  if (normalized.length < 8 || normalized.length > 200) {
    throw new ConversationScopeError('Client request id must be between 8 and 200 characters')
  }
  return `conversation-task:${kind}:${createHash('sha256').update(normalized).digest('hex')}`
}

/**
 * Persists the user's task message and its first Planning request as one command.
 * A response-loss retry uses the same clientRequestId and returns the original pair.
 */
export class ConversationTaskSubmissionRepository {
  private readonly conversations: ConversationRepository
  private readonly planning: ConversationPlanningRepository

  constructor(private readonly pool: Pool) {
    this.conversations = new ConversationRepository(pool)
    this.planning = new ConversationPlanningRepository(pool)
  }

  async submit(input: SubmitConversationTaskInput): Promise<SubmitConversationTaskResult> {
    const messageIdempotencyKey = commandKey('message', input.clientRequestId)
    const planningIdempotencyKey = commandKey('planning', input.clientRequestId)

    return withTransaction(this.pool, async (client) => {
      const posted = await this.conversations.postMessageInTransaction(client, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        author: { kind: 'user', id: input.createdBy },
        body: input.body,
        ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
        ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
        idempotencyKey: messageIdempotencyKey,
        correlationId: input.correlationId,
      })
      const planned = await this.planning.createInTransaction(client, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        sourceMessageIds: [posted.message.id],
        title: input.title,
        ...(input.plannerAgentId === undefined ? {} : { plannerAgentId: input.plannerAgentId }),
        createdBy: input.createdBy,
        correlationId: input.correlationId,
        idempotencyKey: planningIdempotencyKey,
      })
      return {
        message: posted.message,
        request: planned.request,
        reused: posted.reused && planned.reused,
      }
    })
  }
}

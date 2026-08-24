import type { ConversationRepository } from '@runguild/database'
import type {
  CorrelationId,
  ToolAction,
  TypedSideEffect,
} from '@runguild/protocol'
import type { ToolHandler } from '@runguild/tool-gateway'

export interface ConversationToolHandlersOptions {
  readonly repository: Pick<ConversationRepository, 'postMessage'>
}

export function createConversationToolHandlers(
  options: ConversationToolHandlersOptions,
): readonly [ToolHandler<'conversation.reply'>] {
  const reply: ToolHandler<'conversation.reply'> = {
    action: 'conversation.reply',
    risk: 'workspace_write',
    retryMode: 'native_idempotency',
    async execute(input, context) {
      const request = context.request
      const result = await options.repository.postMessage({
        workspaceId: request.workspaceId,
        conversationId: input.conversationId,
        author: { kind: 'agent', id: request.agentId, runId: request.runId },
        body: input.body,
        mentions: input.mentions ?? [],
        entityRefs: {
          missionId: request.missionId,
          taskId: request.taskId,
          runId: request.runId,
        },
        ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
        idempotencyKey: request.idempotencyKey,
        correlationId: ('conversation_tool_' + request.id) as CorrelationId,
      })
      const sideEffects: readonly TypedSideEffect[] = result.reused
        ? []
        : [{
            type: 'message.posted',
            conversationId: input.conversationId,
            messageId: result.message.id,
          }]
      return {
        output: {
          messageId: result.message.id,
          deliveredAgentIds: result.message.deliveries
            .filter((delivery) => delivery.status !== 'context_pending')
            .map((delivery) => delivery.agentId),
          pendingAgentIds: result.message.deliveries
            .filter((delivery) => delivery.status === 'context_pending')
            .map((delivery) => delivery.agentId),
        },
        sideEffects,
      }
    },
  }
  return [reply]
}

export const CONVERSATION_TOOL_DEFINITIONS = [
  {
    action: 'conversation.reply' as const,
    description: 'Post a durable progress update or coordination request to the Mission team room. Mention Agents only when they need to act.',
    inputSchema: {
      type: 'object',
      required: ['conversationId', 'body'],
      properties: {
        conversationId: { type: 'string' },
        body: { type: 'string', minLength: 1, maxLength: 65_536 },
        mentions: {
          type: 'array',
          maxItems: 32,
          uniqueItems: true,
          items: { type: 'string' },
        },
        replyToMessageId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
] as const satisfies readonly {
  readonly action: ToolAction
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}[]

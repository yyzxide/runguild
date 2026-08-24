import type { IsoTimestamp, ToolCallId } from './ids.js'
import type { ModelContextMetadata } from './context.js'
import type { ToolAction, ToolActionInputs } from './tools.js'

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ModelToolCall<Action extends ToolAction = ToolAction> {
  readonly id: ToolCallId
  readonly action: Action
  readonly input: ToolActionInputs[Action]
}

export interface ModelMessage {
  readonly role: ModelMessageRole
  readonly content: string
  readonly toolCallId?: ToolCallId
  readonly toolCalls?: readonly ModelToolCall[]
  readonly createdAt?: IsoTimestamp
  readonly hop?: number
}

export interface ModelContinuation {
  readonly provider: string
  readonly model: string
  readonly responseId: string
  readonly hop: number
}

export interface ModelToolDefinition {
  readonly action: ToolAction
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly context?: ModelContextMetadata
  readonly abortSignal?: AbortSignal
  readonly continuation?: ModelContinuation
}

export interface ModelUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens?: number
  readonly estimatedCostUsd?: number
}

export interface ModelResponse {
  readonly content: string
  readonly toolCalls: readonly ModelToolCall[]
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error'
  readonly usage: ModelUsage
  readonly providerRequestId?: string
}

export interface ModelAdapter {
  readonly provider: string
  readonly model: string
  complete(request: ModelRequest): Promise<ModelResponse>
}

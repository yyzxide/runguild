import OpenAI from 'openai'
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInput,
} from 'openai/resources/responses/responses'

import {
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ToolAction,
  type ToolCallId,
} from '@runguild/protocol'

interface ResponsesClient {
  readonly responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Response>
  }
}

export interface OpenAIResponsesAdapterOptions {
  readonly apiKey: string
  readonly model: string
  readonly baseURL?: string
  readonly maxOutputTokens?: number
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  readonly client?: ResponsesClient
}

function assertOptions(options: OpenAIResponsesAdapterOptions): void {
  if (!options.apiKey.trim() && !options.client) {
    throw new Error('OPENAI_API_KEY is required for the OpenAI model adapter')
  }
  if (!options.model.trim()) {
    throw new Error('A non-empty OpenAI model name is required')
  }
  if (options.maxOutputTokens !== undefined
      && (!Number.isInteger(options.maxOutputTokens)
        || options.maxOutputTokens < 1
        || options.maxOutputTokens > 128_000)) {
    throw new RangeError('maxOutputTokens must be an integer between 1 and 128000')
  }
}

function systemInstructions(messages: readonly ModelMessage[]): string | undefined {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter(Boolean)
  return instructions.length === 0 ? undefined : instructions.join('\n\n')
}

function messagesAfterContinuation(request: ModelRequest): readonly ModelMessage[] {
  const continuation = request.continuation
  if (!continuation || continuation.provider !== 'openai') {
    return request.messages
  }
  return request.messages.filter((message) => {
    const hop = message.hop ?? 0
    if (hop > continuation.hop) return true
    if (hop < continuation.hop) return false
    return message.role !== 'assistant' && message.role !== 'system'
  })
}

function toResponseInput(request: ModelRequest, useContinuation: boolean): ResponseInput {
  const source = useContinuation ? messagesAfterContinuation(request) : request.messages
  const input: ResponseInput = []
  for (const message of source) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      if (!message.toolCallId) {
        throw new Error('Tool message is missing toolCallId')
      }
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      })
      continue
    }
    if (message.content) {
      input.push({ role: message.role, content: message.content })
    }
    if (!useContinuation || (message.hop ?? 0) > (request.continuation?.hop ?? -1)) {
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.action,
          arguments: JSON.stringify(call.input),
        } satisfies ResponseFunctionToolCall)
      }
    }
  }
  return input
}

function parseToolCall(item: ResponseFunctionToolCall): ModelToolCall {
  let input: unknown
  try {
    input = JSON.parse(item.arguments)
  } catch (error) {
    throw new Error('OpenAI returned invalid JSON arguments for ' + item.name, { cause: error })
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('OpenAI tool arguments must be a JSON object for ' + item.name)
  }
  return {
    id: item.call_id as ToolCallId,
    action: item.name as ToolAction,
    input: input as never,
  }
}

function finishReason(response: Response, hasTools: boolean): ModelResponse['finishReason'] {
  if (response.status === 'completed') return hasTools ? 'tool_calls' : 'stop'
  if (response.incomplete_details?.reason === 'max_output_tokens') return 'length'
  if (response.incomplete_details?.reason === 'content_filter') return 'content_filter'
  return 'error'
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly provider = 'openai'
  readonly model: string
  private readonly client: ResponsesClient

  constructor(private readonly options: OpenAIResponsesAdapterOptions) {
    assertOptions(options)
    this.model = options.model
    this.client = options.client ?? new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    })
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const continuation = request.continuation
    const useContinuation = continuation?.provider === this.provider
      && continuation.model === this.model
    const instructions = systemInstructions(request.messages)
    const body: ResponseCreateParamsNonStreaming = {
      model: this.model,
      input: toResponseInput(request, useContinuation),
      tools: request.tools.map((tool) => ({
        type: 'function' as const,
        name: tool.action,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false,
      })),
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: true,
      ...(instructions === undefined ? {} : { instructions }),
      ...(useContinuation ? { previous_response_id: continuation.responseId } : {}),
      ...(this.options.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: this.options.maxOutputTokens }),
      ...(this.options.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: this.options.reasoningEffort } }),
    }
    const response = await this.client.responses.create(
      body,
      request.abortSignal === undefined ? undefined : { signal: request.abortSignal },
    )
    const toolCalls = response.output
      .filter((item): item is ResponseFunctionToolCall => item.type === 'function_call')
      .map(parseToolCall)
    return {
      content: response.output_text,
      toolCalls,
      finishReason: finishReason(response, toolCalls.length > 0),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details.cached_tokens ?? 0,
      },
      providerRequestId: response.id,
    }
  }
}

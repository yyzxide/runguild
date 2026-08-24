import { createHash } from 'node:crypto'

import type {
  ContextSnapshot,
  ContextSnapshotContent,
  ContextSnapshotId,
  ModelMessage,
  ModelToolDefinition,
  RunId,
  SkillSnapshotRef,
} from '@runguild/protocol'

const MESSAGE_OVERHEAD_TOKENS = 8
const REQUEST_OVERHEAD_TOKENS = 32

function canonical(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('Context contains a non-finite number')
      return input
    }
    if (Array.isArray(input)) return input.map((item) => item === undefined ? null : visit(item))
    if (typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, visit(item)]))
    }
    throw new TypeError('Context contains a value that cannot be serialized')
  }
  return JSON.stringify(visit(value))
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * A deterministic conservative estimator for providers without a local model
 * tokenizer. UTF-8 bytes / 3 intentionally budgets more tightly than the
 * common bytes / 4 approximation.
 */
export function estimateContextTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 3))
}

function messageTokens(message: ModelMessage): number {
  return estimateContextTokens(canonical(message)) + MESSAGE_OVERHEAD_TOKENS
}

function messagesTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0)
}

function toolTokens(tools: readonly ModelToolDefinition[]): number {
  return estimateContextTokens(canonical(tools)) + REQUEST_OVERHEAD_TOKENS
}

function compactMessage(message: ModelMessage): ModelMessage {
  const bytes = Buffer.byteLength(message.content, 'utf8')
  if (bytes <= 768) return message
  const first = message.content.slice(0, 384)
  const last = message.content.slice(-192)
  return {
    ...message,
    content: canonical({
      contextCompacted: true,
      originalBytes: bytes,
      contentHash: digest(message.content),
      first,
      last,
    }),
  }
}

interface MessageUnit {
  readonly messages: readonly ModelMessage[]
}

function historyUnits(messages: readonly ModelMessage[]): readonly MessageUnit[] {
  const units: MessageUnit[] = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index]
    if (!message) break
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      const ids = new Set(message.toolCalls?.map((call) => call.id) ?? [])
      const grouped = [message]
      let next = index + 1
      while (next < messages.length) {
        const candidate = messages[next]
        if (!candidate || candidate.role !== 'tool' || !candidate.toolCallId || !ids.has(candidate.toolCallId)) break
        grouped.push(candidate)
        next += 1
      }
      units.push({ messages: grouped })
      index = next
      continue
    }
    units.push({ messages: [message] })
    index += 1
  }
  return units
}

function isInitial(message: ModelMessage): boolean {
  return message.hop === undefined || message.hop === 0
}

function compactionDigest(
  omitted: readonly ModelMessage[],
  tokenLimit: number,
): ModelMessage {
  const transcriptHash = digest(canonical(omitted))
  const summarized = omitted.length <= 16
    ? omitted
    : [...omitted.slice(0, 4), ...omitted.slice(-12)]
  const lines = summarized.map((message) => {
    const actions = message.toolCalls?.map((call) => call.action).join(',')
    return '- hop=' + (message.hop ?? 0) + ' role=' + message.role +
      (message.toolCallId ? ' toolCall=' + message.toolCallId : '') +
      (actions ? ' actions=' + actions : '') +
      ' hash=' + digest(message.content).slice(0, 16)
  })
  const header = [
    'Earlier durable transcript compacted deterministically.',
    'Omitted messages: ' + omitted.length + '; transcript SHA-256: ' + transcriptHash + '.',
    'Do not infer omitted command output. Re-read facts with tools when needed.',
  ]
  let content = [...header, ...lines].join('\n')
  while (estimateContextTokens(content) + MESSAGE_OVERHEAD_TOKENS > tokenLimit && lines.length > 0) {
    lines.splice(Math.floor(lines.length / 2), 1)
    content = [...header, ...lines].join('\n')
  }
  if (estimateContextTokens(content) + MESSAGE_OVERHEAD_TOKENS > tokenLimit) {
    content = header.slice(0, 2).join('\n')
  }
  return { role: 'user', content, hop: omitted.at(-1)?.hop ?? 0 }
}

export interface BuildContextInput {
  readonly runId: RunId
  readonly hop: number
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly skills?: readonly SkillSnapshotRef[]
}

export interface BuildContextResult {
  readonly messages: readonly ModelMessage[]
  readonly snapshot: ContextSnapshot
}

export interface DeterministicContextBuilderOptions {
  readonly tokenBudget: number
  readonly digestTokenBudget?: number
}

export class DeterministicContextBuilder {
  private readonly tokenBudget: number
  private readonly digestTokenBudget: number

  constructor(options: DeterministicContextBuilderOptions) {
    if (!Number.isInteger(options.tokenBudget) || options.tokenBudget < 256 || options.tokenBudget > 2_000_000) {
      throw new RangeError('Context token budget must be an integer between 256 and 2000000')
    }
    const digestBudget = options.digestTokenBudget ?? Math.min(768, Math.max(128, Math.floor(options.tokenBudget / 10)))
    if (!Number.isInteger(digestBudget) || digestBudget < 64 || digestBudget >= options.tokenBudget) {
      throw new RangeError('Context digest token budget is invalid')
    }
    this.tokenBudget = options.tokenBudget
    this.digestTokenBudget = digestBudget
  }

  build(input: BuildContextInput): BuildContextResult {
    if (!Number.isInteger(input.hop) || input.hop < 1) throw new RangeError('Context hop must be positive')
    const definitionsTokens = toolTokens(input.tools)
    const fullTokens = definitionsTokens + messagesTokens(input.messages)
    if (fullTokens <= this.tokenBudget) {
      return this.result(input, input.messages, definitionsTokens, fullTokens, 0, 'full')
    }

    let prefixLength = 0
    while (prefixLength < input.messages.length && isInitial(input.messages[prefixLength]!)) {
      prefixLength += 1
    }
    const prefix = input.messages.slice(0, prefixLength)
    const prefixTokens = messagesTokens(prefix)
    const available = this.tokenBudget - definitionsTokens - prefixTokens - this.digestTokenBudget
    if (available < 1) {
      throw new Error(
        'Pinned execution context and tool definitions exceed the model input budget; ' +
        'reduce assigned Skills or increase AGENT_CONTEXT_INPUT_TOKENS',
      )
    }

    const units = historyUnits(input.messages.slice(prefixLength))
    const selected: MessageUnit[] = []
    let selectedTokens = 0
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index]!
      const exactTokens = messagesTokens(unit.messages)
      if (selectedTokens + exactTokens <= available) {
        selected.unshift(unit)
        selectedTokens += exactTokens
        continue
      }
      if (selected.length === 0) {
        const compacted = unit.messages.map(compactMessage)
        const compactedTokens = messagesTokens(compacted)
        if (compactedTokens > available) {
          throw new Error('The latest atomic model/tool exchange exceeds the context token budget')
        }
        selected.unshift({ messages: compacted })
        selectedTokens += compactedTokens
      }
      break
    }

    const selectedCount = selected.reduce((total, unit) => total + unit.messages.length, 0)
    const omittedCount = input.messages.length - prefixLength - selectedCount
    if (omittedCount <= 0) {
      const output = [...prefix, ...selected.flatMap((unit) => unit.messages)]
      const estimated = definitionsTokens + messagesTokens(output)
      return this.result(input, output, definitionsTokens, estimated, 0, 'deterministic_window_v1')
    }
    const omitted = input.messages.slice(prefixLength, prefixLength + omittedCount)
    const summary = compactionDigest(omitted, this.digestTokenBudget)
    const output = [
      ...prefix,
      summary,
      ...selected.flatMap((unit) => unit.messages),
    ]
    const estimated = definitionsTokens + messagesTokens(output)
    if (estimated > this.tokenBudget) throw new Error('Context compaction exceeded its deterministic budget')
    return this.result(
      input,
      output,
      definitionsTokens,
      estimated,
      omittedCount,
      'deterministic_window_v1',
    )
  }

  private result(
    input: BuildContextInput,
    messages: readonly ModelMessage[],
    definitionsTokens: number,
    estimatedTokens: number,
    omittedMessageCount: number,
    strategy: ContextSnapshotContent['strategy'],
  ): BuildContextResult {
    const content: ContextSnapshotContent = {
      schemaVersion: 1,
      strategy,
      tokenBudget: this.tokenBudget,
      estimatedTokens,
      toolDefinitionTokens: definitionsTokens,
      toolDefinitions: [...input.tools],
      sourceMessageCount: input.messages.length,
      includedMessageCount: input.messages.length - omittedMessageCount,
      omittedMessageCount,
      compacted: strategy !== 'full',
      skills: [...(input.skills ?? [])],
      messages: [...messages],
    }
    const contentHash = digest(canonical(content))
    const id = ('context_' + digest(input.runId + ':' + input.hop + ':' + contentHash)) as ContextSnapshotId
    return {
      messages,
      snapshot: { id, runId: input.runId, hop: input.hop, contentHash, content },
    }
  }
}

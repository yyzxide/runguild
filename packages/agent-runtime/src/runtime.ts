import { randomUUID } from 'node:crypto'

import {
  type AnyToolRequest,
  type CompletionDecision,
  type ContextSnapshot,
  type EvidenceRef,
  type IsoTimestamp,
  type LlmCallId,
  type ModelAdapter,
  type ModelContinuation,
  type ModelMessage,
  type ModelRequest,
  type ModelToolCall,
  type ModelToolDefinition,
  type RunControlRequest,
  type RunId,
  type RunStatus,
  type RuntimeOutcome,
  type RuntimeRunContext,
  type SkillSnapshotRef,
  type ToolAction,
  type ToolResult,
  type ToolRisk,
} from '@runguild/protocol'

import type { DeterministicContextBuilder } from './context-builder.js'

const RUNTIME_CONTRACT =
  'Runtime contract: work is complete only after calling run.set_status with status done. ' +
  'A normal assistant response, silence, or a model stop reason never completes the run.'

const MODEL_PROTOCOL_CORRECTION_MARKER = '[Model protocol correction]'
const HOP_BUDGET_GATE_MARKER = '[Hop budget gate]'

const STATUS_TOOL: ModelToolDefinition = {
  action: 'run.set_status',
  description: 'Request a verified terminal or waiting state for this run.',
  inputSchema: {
    type: 'object',
    required: ['status', 'summary'],
    properties: {
      status: { enum: ['done', 'blocked', 'failed', 'waiting_human'] },
      summary: { type: 'string' },
      evidence: { type: 'array' },
      nextStep: { type: 'string' },
    },
  },
}

export interface RuntimePersistence {
  loadRun(runId: RunId): Promise<RuntimeRunContext | null>
  startRun(runId: RunId): Promise<RuntimeRunContext>
  beginHop(runId: RunId): Promise<number | null>
  transitionRun(runId: RunId, to: RunStatus, summary: string): Promise<void>
  initializeMessages(runId: RunId, messages: readonly ModelMessage[]): Promise<void>
  loadMessages(runId: RunId): Promise<readonly ModelMessage[]>
  loadModelContinuation(runId: RunId): Promise<ModelContinuation | null>
  saveContextSnapshot(snapshot: ContextSnapshot): Promise<void>
  appendMessage(runId: RunId, hop: number, message: ModelMessage): Promise<void>
  recordEvent(
    runId: RunId,
    hop: number,
    kind: 'tool_requested' | 'tool_completed' | 'steering_applied' | 'completion_rejected'
      | 'model_protocol_rejected',
    data: Readonly<Record<string, unknown>>,
  ): Promise<void>
  beginModelCall(
    callId: LlmCallId,
    runId: RunId,
    hop: number,
    provider: string,
    model: string,
    request: ModelRequest,
  ): Promise<number>
  finishModelCall(
    callId: LlmCallId,
    runId: RunId,
    hop: number,
    startedAt: number,
    response: Awaited<ReturnType<ModelAdapter['complete']>>,
  ): Promise<void>
  failModelCall(callId: LlmCallId, startedAt: number, error: unknown): Promise<void>
  takePendingControls(runId: RunId): Promise<readonly RunControlRequest[]>
}

export interface RuntimeToolExecutor {
  riskFor(action: ToolAction): ToolRisk | null
  execute<Action extends ToolAction>(
    request: Extract<AnyToolRequest, { readonly action: Action }>,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult<Action>>
}

export interface CompletionVerifier {
  verify(input: {
    readonly run: RuntimeRunContext
    readonly summary: string
    readonly evidence: readonly EvidenceRef[]
  }): Promise<CompletionDecision>
}

export interface AgentRuntimeOptions {
  readonly persistence: RuntimePersistence
  readonly model: ModelAdapter
  readonly tools: RuntimeToolExecutor
  readonly completionVerifier: CompletionVerifier
  readonly contextBuilder: Pick<DeterministicContextBuilder, 'build'>
  readonly toolDefinitions?: readonly ModelToolDefinition[]
  readonly implementationGate?: {
    readonly maxDiscoveryHops: number
    readonly discoveryActions: readonly ToolAction[]
    readonly implementationActions: readonly ToolAction[]
  }
  /**
   * Model-originated protocol mistakes are safe to retry because no Tool
   * Gateway side effect has started. The persisted correction marker keeps
   * the retry budget stable across process restarts.
   */
  readonly maxModelProtocolRepairs?: number
  /**
   * Progressively remove non-delivery tools as the durable Run approaches its
   * maximum hop count. Runtime enforcement remains authoritative even when a
   * provider repeats a previously visible function call.
   */
  readonly hopBudgetGates?: readonly {
    readonly remainingHops: number
    readonly blockedActions: readonly ToolAction[]
    readonly instruction: string
  }[]
  readonly now?: () => Date
}

export interface RunAgentInput {
  readonly runId: RunId
  readonly initialMessages: readonly ModelMessage[]
  readonly skills?: readonly SkillSnapshotRef[]
  readonly resumeWaiting?: boolean
  readonly abortSignal?: AbortSignal
}

type ToolProcessingOutcome = RuntimeOutcome | null

function terminalOutcome(context: RuntimeRunContext): RuntimeOutcome | null {
  const summary = 'Run is already ' + context.status + '.'
  switch (context.status) {
    case 'succeeded': return { status: 'succeeded', summary, hops: context.currentHop }
    case 'failed': return { status: 'failed', summary, hops: context.currentHop }
    case 'cancelled': return { status: 'cancelled', summary, hops: context.currentHop }
    case 'timed_out': return { status: 'timed_out', summary, hops: context.currentHop }
    default: return null
  }
}

function pendingToolCalls(messages: readonly ModelMessage[]): readonly ModelToolCall[] {
  const completed = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.toolCallId !== undefined)
      .map((message) => message.toolCallId),
  )
  return messages.flatMap((message) => message.toolCalls ?? [])
    .filter((call) => !completed.has(call.id))
}

function statusCall(calls: readonly ModelToolCall[]): ModelToolCall<'run.set_status'> | null {
  const statuses = calls.filter((call) => call.action === 'run.set_status')
  return (statuses.at(-1) as ModelToolCall<'run.set_status'> | undefined) ?? null
}

const IMPLEMENTATION_GATE_MARKER = '[Implementation gate]'

function lastSucceededActionHop(
  messages: readonly ModelMessage[],
  actions: ReadonlySet<ToolAction>,
): number | null {
  const pendingActions = new Map<string, { readonly action: ToolAction; readonly hop: number }>()
  let lastHop: number | null = null
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      pendingActions.set(call.id, { action: call.action, hop: message.hop ?? 0 })
    }
    if (message.role !== 'tool' || message.toolCallId === undefined) continue
    const pending = pendingActions.get(message.toolCallId)
    try {
      const result = JSON.parse(message.content) as { readonly status?: unknown }
      if (result.status === 'succeeded' && pending !== undefined && actions.has(pending.action)) {
        lastHop = Math.max(lastHop ?? 0, message.hop ?? pending.hop)
      }
    } catch {
      // Malformed historical tool output cannot prove that an implementation action succeeded.
    }
    pendingActions.delete(message.toolCallId)
  }
  return lastHop
}

export class AgentRuntime {
  private readonly now: () => Date
  private readonly definitions: readonly ModelToolDefinition[]
  private readonly maxModelProtocolRepairs: number
  private readonly hopBudgetGates: NonNullable<AgentRuntimeOptions['hopBudgetGates']>

  constructor(private readonly options: AgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date())
    this.maxModelProtocolRepairs = options.maxModelProtocolRepairs ?? 2
    if (!Number.isInteger(this.maxModelProtocolRepairs)
        || this.maxModelProtocolRepairs < 0
        || this.maxModelProtocolRepairs > 10) {
      throw new RangeError('maxModelProtocolRepairs must be an integer between 0 and 10')
    }
    const supplied = options.toolDefinitions ?? []
    if (supplied.some((definition) => definition.action === 'run.set_status')) {
      throw new Error('run.set_status definition is supplied by AgentRuntime')
    }
    this.definitions = [...supplied, STATUS_TOOL]
    const registered = new Set(this.definitions.map((definition) => definition.action))
    const gate = options.implementationGate
    if (gate) {
      if (!Number.isInteger(gate.maxDiscoveryHops) || gate.maxDiscoveryHops < 1 || gate.maxDiscoveryHops > 1_000) {
        throw new RangeError('implementationGate.maxDiscoveryHops must be an integer between 1 and 1000')
      }
      if (gate.discoveryActions.length === 0 || gate.implementationActions.length === 0) {
        throw new Error('implementationGate action lists must be non-empty')
      }
      for (const action of [...gate.discoveryActions, ...gate.implementationActions]) {
        if (!registered.has(action)) {
          throw new Error('implementationGate action is not registered: ' + action)
        }
      }
      const implementation = new Set(gate.implementationActions)
      if (gate.discoveryActions.some((action) => implementation.has(action))) {
        throw new Error('implementationGate discovery and implementation actions must not overlap')
      }
    }
    const budgetThresholds = new Set<number>()
    for (const gate of options.hopBudgetGates ?? []) {
      if (!Number.isInteger(gate.remainingHops) || gate.remainingHops < 1 || gate.remainingHops > 1_000) {
        throw new RangeError('hopBudgetGates remainingHops must be an integer between 1 and 1000')
      }
      if (budgetThresholds.has(gate.remainingHops)) {
        throw new Error('hopBudgetGates remainingHops thresholds must be unique')
      }
      budgetThresholds.add(gate.remainingHops)
      if (gate.blockedActions.length === 0 || new Set(gate.blockedActions).size !== gate.blockedActions.length) {
        throw new Error('hopBudgetGates blockedActions must be non-empty and unique')
      }
      for (const action of gate.blockedActions) {
        if (!registered.has(action)) throw new Error('hopBudgetGates action is not registered: ' + action)
        if (action === 'run.set_status') throw new Error('hopBudgetGates cannot block run.set_status')
      }
      if (gate.instruction.trim() === '' || gate.instruction.length > 4_000) {
        throw new Error('hopBudgetGates instruction must contain between 1 and 4000 characters')
      }
    }
    this.hopBudgetGates = [...options.hopBudgetGates ?? []]
      .sort((left, right) => right.remainingHops - left.remainingHops)
  }

  async run(input: RunAgentInput): Promise<RuntimeOutcome> {
    let context = await this.options.persistence.loadRun(input.runId)
    if (!context) {
      throw new Error('Run not found: ' + input.runId)
    }
    const existingTerminal = terminalOutcome(context)
    if (existingTerminal) {
      return existingTerminal
    }

    await this.options.persistence.initializeMessages(input.runId, [
      { role: 'system', content: RUNTIME_CONTRACT },
      ...input.initialMessages,
    ])
    const messages = [...await this.options.persistence.loadMessages(input.runId)]

    const earlyControl = await this.applyControls(context, context.currentHop, messages)
    if (earlyControl) {
      return earlyControl
    }
    if (input.abortSignal?.aborted) {
      return this.finish(input.runId, 'cancelled', 'Run cancelled by abort signal.', context.currentHop)
    }
    context = await this.requireRun(input.runId)

    if (context.status === 'waiting_human' && !input.resumeWaiting) {
      return {
        status: 'waiting_human',
        summary: 'Run is waiting for a human decision.',
        hops: context.currentHop,
      }
    }
    if (context.status === 'waiting_human' || context.status === 'waiting_tool') {
      await this.options.persistence.transitionRun(input.runId, 'running', 'Runtime resumed.')
    }
    context = await this.options.persistence.startRun(input.runId)

    while (true) {
      if (input.abortSignal?.aborted) {
        return this.finish(input.runId, 'cancelled', 'Run cancelled by abort signal.', context.currentHop)
      }

      const controlOutcome = await this.applyControls(context, context.currentHop, messages)
      if (controlOutcome) {
        return controlOutcome
      }
      context = await this.requireRun(input.runId)

      const unfinished = pendingToolCalls(messages)
      if (unfinished.length > 0) {
        const outcome = await this.processToolCalls(context, context.currentHop, unfinished, messages, input.abortSignal)
        if (outcome) {
          return outcome
        }
        context = await this.requireRun(input.runId)
      }

      const hop = await this.options.persistence.beginHop(input.runId)
      if (hop === null) {
        return this.finish(input.runId, 'timed_out', 'Maximum model hops reached.', context.currentHop)
      }
      context = { ...context, currentHop: hop }
      await this.ensureImplementationGateMessage(input.runId, hop, messages)
      await this.ensureHopBudgetGateMessages(context, hop, messages)
      const continuation = await this.options.persistence.loadModelContinuation(input.runId)
      const definitions = this.definitionsFor(context, hop, messages)
      let builtContext
      try {
        builtContext = this.options.contextBuilder.build({
          runId: input.runId,
          hop,
          messages,
          tools: definitions,
          ...(input.skills === undefined ? {} : { skills: input.skills }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return this.finish(input.runId, 'failed', 'Context build failed: ' + message, hop)
      }
      await this.options.persistence.saveContextSnapshot(builtContext.snapshot)
      const request: ModelRequest = {
        messages: builtContext.messages,
        tools: definitions,
        context: {
          snapshotId: builtContext.snapshot.id,
          contentHash: builtContext.snapshot.contentHash,
          strategy: builtContext.snapshot.content.strategy,
          tokenBudget: builtContext.snapshot.content.tokenBudget,
          estimatedTokens: builtContext.snapshot.content.estimatedTokens,
          compacted: builtContext.snapshot.content.compacted,
        },
        ...(continuation === null ? {} : { continuation }),
        ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      }
      const callId = ('llm_' + randomUUID()) as LlmCallId
      const startedAt = await this.options.persistence.beginModelCall(
        callId,
        input.runId,
        hop,
        this.options.model.provider,
        this.options.model.model,
        request,
      )

      let response: Awaited<ReturnType<ModelAdapter['complete']>>
      try {
        response = await this.options.model.complete(request)
        await this.options.persistence.finishModelCall(callId, input.runId, hop, startedAt, response)
      } catch (error) {
        await this.options.persistence.failModelCall(callId, startedAt, error)
        if (input.abortSignal?.aborted) {
          return this.finish(input.runId, 'cancelled', 'Run cancelled during model call.', hop)
        }
        const message = error instanceof Error ? error.message : String(error)
        return this.finish(input.runId, 'failed', 'Model call failed: ' + message, hop)
      }

      const assistantMessage: ModelMessage = {
        role: 'assistant',
        content: response.content,
        hop,
        ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }),
      }
      await this.options.persistence.appendMessage(input.runId, hop, assistantMessage)
      messages.push(assistantMessage)

      if (response.protocolError !== undefined && response.finishReason === 'tool_calls') {
        const repairCount = messages.filter(
          (message) => message.role === 'user'
            && message.content.startsWith(MODEL_PROTOCOL_CORRECTION_MARKER),
        ).length
        await this.options.persistence.recordEvent(input.runId, hop, 'model_protocol_rejected', {
          code: response.protocolError.code,
          toolCallId: response.protocolError.toolCallId,
          toolName: response.protocolError.toolName,
          repairCount: repairCount + 1,
        })
        if (repairCount >= this.maxModelProtocolRepairs) {
          return this.finish(
            input.runId,
            'failed',
            'Model protocol repair budget exhausted after ' + String(repairCount + 1) +
              ' invalid responses: ' + response.protocolError.code + '.',
            hop,
          )
        }
        const correction: ModelMessage = {
          role: 'user',
          hop,
          content: MODEL_PROTOCOL_CORRECTION_MARKER + ' ' + response.protocolError.message +
            ' No tool from that response was executed. Retry with a currently declared function and one valid JSON object. ' +
            'Repair ' + String(repairCount + 1) + ' of ' + String(this.maxModelProtocolRepairs) + '.',
        }
        await this.options.persistence.appendMessage(input.runId, hop, correction)
        messages.push(correction)
        continue
      }

      if (response.toolCalls.length > 0) {
        const outcome = await this.processToolCalls(context, hop, response.toolCalls, messages, input.abortSignal)
        if (outcome) {
          return outcome
        }
        context = await this.requireRun(input.runId)
        continue
      }

      if (response.finishReason !== 'stop') {
        return this.finish(
          input.runId,
          'failed',
          'Model response ended with ' + response.finishReason + ' before producing an executable tool call.',
          hop,
        )
      }

      const nudge: ModelMessage = {
        role: 'user',
        content: 'No explicit run status was provided. Continue working or call run.set_status; silence is not completion.',
        hop,
      }
      await this.options.persistence.appendMessage(input.runId, hop, nudge)
      messages.push(nudge)
    }
  }

  private async processToolCalls(
    context: RuntimeRunContext,
    hop: number,
    calls: readonly ModelToolCall[],
    messages: ModelMessage[],
    abortSignal?: AbortSignal,
  ): Promise<ToolProcessingOutcome> {
    const normalCalls = calls.filter((call) => call.action !== 'run.set_status')
    if (normalCalls.length > 0) {
      await this.options.persistence.transitionRun(context.runId, 'waiting_tool', 'Executing model-requested tools.')
    }

    for (const call of normalCalls) {
      await this.options.persistence.recordEvent(context.runId, hop, 'tool_requested', {
        toolCallId: call.id,
        action: call.action,
      })
      let result: ToolResult
      const budgetGate = this.blockingHopBudgetGate(context, hop, call.action)
      if (budgetGate !== null) {
        result = {
          status: 'failed',
          error: {
            code: 'conflict',
            message: 'Hop delivery budget is active with ' + String(this.remainingHops(context, hop)) +
              ' hops remaining. This action is no longer available: ' + call.action + '. ' + budgetGate.instruction,
            retryable: false,
          },
          effectState: 'none',
          sideEffects: [],
        }
      } else if (this.discoveryActionBlocked(hop, call.action, messages)) {
        result = {
          status: 'failed',
          error: {
            code: 'conflict',
            message: 'Discovery budget is exhausted. One implementation action must succeed before more repository discovery: ' +
              this.options.implementationGate!.implementationActions.join(', '),
            retryable: false,
          },
          effectState: 'none',
          sideEffects: [],
        }
      } else {
        const risk = this.options.tools.riskFor(call.action)
        if (!risk) {
          result = {
            status: 'failed',
            error: { code: 'invalid_input', message: 'Tool is not registered: ' + call.action, retryable: false },
            effectState: 'none',
            sideEffects: [],
          }
        } else {
          const request = {
            schemaVersion: 1,
            id: call.id,
            action: call.action,
            workspaceId: context.workspaceId,
            missionId: context.missionId,
            taskId: context.taskId,
            runId: context.runId,
            agentId: context.agentId,
            idempotencyKey: context.runId + ':' + call.id,
            risk,
            input: call.input,
            createdAt: this.now().toISOString() as IsoTimestamp,
          } as AnyToolRequest
          result = await this.options.tools.execute(request, abortSignal)
        }
      }

      await this.options.persistence.recordEvent(context.runId, hop, 'tool_completed', {
        toolCallId: call.id,
        action: call.action,
        status: result.status,
      })
      if (result.status === 'awaiting_approval') {
        await this.options.persistence.transitionRun(context.runId, 'running', 'Tool execution paused for approval.')
        await this.options.persistence.transitionRun(context.runId, 'waiting_human', 'Tool approval required.')
        return {
          status: 'waiting_human',
          summary: 'Tool approval required: ' + result.approvalId,
          hops: hop,
        }
      }
      if (result.status === 'in_progress') {
        return {
          status: 'waiting_tool',
          summary: 'Another worker owns the tool execution lease.',
          hops: hop,
        }
      }

      const toolMessage: ModelMessage = {
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(result),
        hop,
      }
      await this.options.persistence.appendMessage(context.runId, hop, toolMessage)
      messages.push(toolMessage)
    }

    if (normalCalls.length > 0) {
      await this.options.persistence.transitionRun(context.runId, 'running', 'Tool execution finished.')
    }

    const completionCall = statusCall(calls)
    if (!completionCall) {
      return null
    }
    for (const ignored of calls.filter(
      (call) => call.action === 'run.set_status' && call.id !== completionCall.id,
    )) {
      const superseded: ModelMessage = {
        role: 'tool',
        toolCallId: ignored.id,
        hop,
        content: JSON.stringify({
          status: 'failed',
          error: {
            code: 'conflict',
            message: 'A later run.set_status call superseded this request.',
            retryable: false,
          },
          effectState: 'none',
          sideEffects: [],
        }),
      }
      await this.options.persistence.appendMessage(context.runId, hop, superseded)
      messages.push(superseded)
    }
    const status = completionCall.input.status
    const summary = completionCall.input.summary
    if (status === 'done') {
      const decision = await this.options.completionVerifier.verify({
        run: await this.requireRun(context.runId),
        summary,
        evidence: completionCall.input.evidence ?? [],
      })
      const toolMessage: ModelMessage = {
        role: 'tool',
        toolCallId: completionCall.id,
        hop,
        content: JSON.stringify({ status: 'succeeded', output: { accepted: decision.accepted }, sideEffects: [], evidence: [] }),
      }
      await this.options.persistence.appendMessage(context.runId, hop, toolMessage)
      messages.push(toolMessage)
      if (!decision.accepted) {
        await this.options.persistence.recordEvent(context.runId, hop, 'completion_rejected', {
          reason: decision.reason ?? 'Completion evidence gate rejected the request.',
        })
        const nudge: ModelMessage = {
          role: 'user',
          content: 'Completion rejected: ' + (decision.reason ?? 'evidence or review gates are not satisfied.'),
          hop,
        }
        await this.options.persistence.appendMessage(context.runId, hop, nudge)
        messages.push(nudge)
        return null
      }
      return this.finish(context.runId, 'succeeded', summary, hop)
    }
    if (status === 'failed') {
      return this.finish(context.runId, 'failed', summary, hop)
    }

    const toolMessage: ModelMessage = {
      role: 'tool',
      toolCallId: completionCall.id,
      hop,
      content: JSON.stringify({ status: 'succeeded', output: { accepted: true }, sideEffects: [], evidence: [] }),
    }
    await this.options.persistence.appendMessage(context.runId, hop, toolMessage)
    messages.push(toolMessage)
    await this.options.persistence.transitionRun(context.runId, 'waiting_human', summary)
    return { status: 'waiting_human', summary, hops: hop }
  }

  private async applyControls(
    context: RuntimeRunContext,
    hop: number,
    messages?: ModelMessage[],
  ): Promise<RuntimeOutcome | null> {
    const controls = await this.options.persistence.takePendingControls(context.runId)
    const cancellation = controls.find((control) => control.kind === 'cancel')
    if (cancellation) {
      return this.finish(context.runId, 'cancelled', 'Cancelled by ' + cancellation.createdBy + '.', hop)
    }
    for (const control of controls.filter((item) => item.kind === 'steer')) {
      const instruction = control.payload['message']
      if (typeof instruction !== 'string' || instruction.trim() === '') {
        continue
      }
      const message: ModelMessage = { role: 'user', content: '[Steering] ' + instruction, hop }
      await this.options.persistence.appendMessage(context.runId, hop, message)
      messages?.push(message)
      await this.options.persistence.recordEvent(context.runId, hop, 'steering_applied', {
        controlId: control.id,
        createdBy: control.createdBy,
      })
    }
    return null
  }

  private discoveryDeadline(messages: readonly ModelMessage[]): number {
    const gate = this.options.implementationGate
    if (!gate) return Number.POSITIVE_INFINITY
    const lastImplementationHop = lastSucceededActionHop(
      messages,
      new Set(gate.implementationActions),
    )
    return (lastImplementationHop ?? 0) + gate.maxDiscoveryHops
  }

  private discoveryActionBlocked(
    hop: number,
    action: ToolAction,
    messages: readonly ModelMessage[],
  ): boolean {
    const gate = this.options.implementationGate
    return Boolean(gate
      && hop > this.discoveryDeadline(messages)
      && gate.discoveryActions.includes(action)
    )
  }

  private definitionsFor(
    context: RuntimeRunContext,
    hop: number,
    messages: readonly ModelMessage[],
  ): readonly ModelToolDefinition[] {
    const gate = this.options.implementationGate
    let definitions = this.definitions
    if (gate && hop > this.discoveryDeadline(messages)) {
      const discovery = new Set(gate.discoveryActions)
      definitions = definitions.filter((definition) => !discovery.has(definition.action))
    }
    const blocked = new Set(
      this.activeHopBudgetGates(context, hop).flatMap((item) => item.blockedActions),
    )
    return blocked.size === 0
      ? definitions
      : definitions.filter((definition) => !blocked.has(definition.action))
  }

  private async ensureImplementationGateMessage(
    runId: RunId,
    hop: number,
    messages: ModelMessage[],
  ): Promise<void> {
    const gate = this.options.implementationGate
    if (!gate || hop <= this.discoveryDeadline(messages)) {
      return
    }
    const lastImplementationHop = lastSucceededActionHop(
      messages,
      new Set(gate.implementationActions),
    )
    const cycleMarker = IMPLEMENTATION_GATE_MARKER + ' cycle=' + String(lastImplementationHop ?? 'initial')
    if (messages.some((message) => message.content.startsWith(cycleMarker))) return
    const message: ModelMessage = {
      role: 'user',
      hop,
      content:
        cycleMarker + '. The current ' + String(gate.maxDiscoveryHops) +
        '-hop discovery window is exhausted. Repository discovery tools are temporarily unavailable. ' +
        'Use the facts already gathered and make one bounded change now with one of these actions: ' +
        gate.implementationActions.join(', ') +
        '. A successful implementation action opens one new bounded discovery window.',
    }
    await this.options.persistence.appendMessage(runId, hop, message)
    messages.push(message)
  }

  private remainingHops(context: RuntimeRunContext, hop: number): number {
    return Math.max(0, context.maxHops - hop + 1)
  }

  private activeHopBudgetGates(
    context: RuntimeRunContext,
    hop: number,
  ): NonNullable<AgentRuntimeOptions['hopBudgetGates']> {
    const remaining = this.remainingHops(context, hop)
    return this.hopBudgetGates.filter((gate) => remaining <= gate.remainingHops)
  }

  private blockingHopBudgetGate(
    context: RuntimeRunContext,
    hop: number,
    action: ToolAction,
  ): NonNullable<AgentRuntimeOptions['hopBudgetGates']>[number] | null {
    return this.activeHopBudgetGates(context, hop)
      .find((gate) => gate.blockedActions.includes(action)) ?? null
  }

  private async ensureHopBudgetGateMessages(
    context: RuntimeRunContext,
    hop: number,
    messages: ModelMessage[],
  ): Promise<void> {
    const remaining = this.remainingHops(context, hop)
    for (const gate of this.activeHopBudgetGates(context, hop)) {
      const marker = HOP_BUDGET_GATE_MARKER + ' remaining<=' + String(gate.remainingHops)
      if (messages.some((message) => message.role === 'user' && message.content.startsWith(marker))) continue
      const message: ModelMessage = {
        role: 'user',
        hop,
        content: marker + '. ' + String(remaining) + ' model hops remain, including this hop. ' +
          gate.instruction + ' These actions are now unavailable: ' + gate.blockedActions.join(', ') + '.',
      }
      await this.options.persistence.appendMessage(context.runId, hop, message)
      messages.push(message)
    }
  }

  private async requireRun(runId: RunId): Promise<RuntimeRunContext> {
    const run = await this.options.persistence.loadRun(runId)
    if (!run) {
      throw new Error('Run not found: ' + runId)
    }
    return run
  }

  private async finish(
    runId: RunId,
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
    summary: string,
    hops: number,
  ): Promise<RuntimeOutcome> {
    await this.options.persistence.transitionRun(runId, status, summary)
    return { status, summary, hops }
  }
}

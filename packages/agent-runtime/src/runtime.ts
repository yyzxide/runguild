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
    kind: 'tool_requested' | 'tool_completed' | 'steering_applied' | 'completion_rejected',
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

export class AgentRuntime {
  private readonly now: () => Date
  private readonly definitions: readonly ModelToolDefinition[]

  constructor(private readonly options: AgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date())
    const supplied = options.toolDefinitions ?? []
    if (supplied.some((definition) => definition.action === 'run.set_status')) {
      throw new Error('run.set_status definition is supplied by AgentRuntime')
    }
    this.definitions = [...supplied, STATUS_TOOL]
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
      const continuation = await this.options.persistence.loadModelContinuation(input.runId)
      let builtContext
      try {
        builtContext = this.options.contextBuilder.build({
          runId: input.runId,
          hop,
          messages,
          tools: this.definitions,
          ...(input.skills === undefined ? {} : { skills: input.skills }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return this.finish(input.runId, 'failed', 'Context build failed: ' + message, hop)
      }
      await this.options.persistence.saveContextSnapshot(builtContext.snapshot)
      const request: ModelRequest = {
        messages: builtContext.messages,
        tools: this.definitions,
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

      if (response.toolCalls.length > 0) {
        const outcome = await this.processToolCalls(context, hop, response.toolCalls, messages, input.abortSignal)
        if (outcome) {
          return outcome
        }
        context = await this.requireRun(input.runId)
        continue
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
      const risk = this.options.tools.riskFor(call.action)
      await this.options.persistence.recordEvent(context.runId, hop, 'tool_requested', {
        toolCallId: call.id,
        action: call.action,
      })
      let result: ToolResult
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

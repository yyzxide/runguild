import type {
  AnyToolRequest,
  EvidenceRef,
  ToolAction,
  ToolActionInputs,
  ToolActionOutputs,
  ToolResult,
  ToolRetryMode,
  ToolRisk,
  TypedSideEffect,
} from '@runguild/protocol'

export interface ToolExecutionStore {
  reserve(input: {
    readonly request: AnyToolRequest
    readonly retryMode: ToolRetryMode
    readonly leaseMs?: number
  }): Promise<
    | { readonly kind: 'execute'; readonly executionId: string; readonly executionToken: string }
    | { readonly kind: 'replay'; readonly result: ToolResult }
    | { readonly kind: 'awaiting_approval'; readonly approvalId: string }
    | { readonly kind: 'in_progress'; readonly retryAfterMs: number }
  >
  finish(executionId: string, executionToken: string, result: ToolResult): Promise<void>
}

export interface ToolHandlerContext {
  readonly request: AnyToolRequest
  readonly abortSignal?: AbortSignal
}

export interface ToolHandlerResult<Action extends ToolAction> {
  readonly output: ToolActionOutputs[Action]
  readonly sideEffects?: readonly TypedSideEffect[]
  readonly evidence?: readonly EvidenceRef[]
}

export interface ToolHandler<Action extends ToolAction> {
  readonly action: Action
  readonly risk: ToolRisk
  readonly retryMode: ToolRetryMode
  readonly leaseMs?: number
  execute(
    input: ToolActionInputs[Action],
    context: ToolHandlerContext,
  ): Promise<ToolHandlerResult<Action>>
}

type AnyToolHandler = {
  readonly [Action in ToolAction]: ToolHandler<Action>
}[ToolAction]

export class ToolGateway {
  private readonly handlers = new Map<ToolAction, AnyToolHandler>()

  constructor(
    private readonly store: ToolExecutionStore,
    handlers: readonly AnyToolHandler[] = [],
  ) {
    for (const handler of handlers) {
      this.register(handler)
    }
  }

  register(handler: AnyToolHandler): void {
    if (handler.action === 'run.set_status') {
      throw new Error('run.set_status is owned by the runtime completion gate')
    }
    if (this.handlers.has(handler.action)) {
      throw new Error('Duplicate tool handler: ' + handler.action)
    }
    this.handlers.set(handler.action, handler)
  }

  definitions(): readonly Pick<AnyToolHandler, 'action' | 'risk' | 'retryMode'>[] {
    return [...this.handlers.values()].map((handler) => ({
      action: handler.action,
      risk: handler.risk,
      retryMode: handler.retryMode,
    }))
  }

  riskFor(action: ToolAction): ToolRisk | null {
    return this.handlers.get(action)?.risk ?? null
  }

  async execute<Action extends ToolAction>(
    request: Extract<AnyToolRequest, { readonly action: Action }>,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult<Action>> {
    const handler = this.handlers.get(request.action)
    if (!handler) {
      return {
        status: 'failed',
        error: {
          code: 'invalid_input',
          message: 'No handler is registered for ' + request.action,
          retryable: false,
        },
        effectState: 'none',
        sideEffects: [],
      }
    }
    if (handler.risk !== request.risk) {
      return {
        status: 'failed',
        error: {
          code: 'forbidden',
          message: 'Declared tool risk does not match the server-side handler policy.',
          retryable: false,
        },
        effectState: 'none',
        sideEffects: [],
      }
    }

    const reservation = await this.store.reserve({
      request,
      retryMode: handler.retryMode,
      ...(handler.leaseMs === undefined ? {} : { leaseMs: handler.leaseMs }),
    })
    if (reservation.kind === 'replay') {
      return reservation.result as ToolResult<Action>
    }
    if (reservation.kind === 'awaiting_approval') {
      return {
        status: 'awaiting_approval',
        approvalId: reservation.approvalId as never,
      }
    }
    if (reservation.kind === 'in_progress') {
      return { status: 'in_progress', retryAfterMs: reservation.retryAfterMs }
    }

    let result: ToolResult<Action>
    try {
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new Error('Tool execution aborted')
      }
      const handled = await handler.execute(request.input as never, {
        request,
        ...(abortSignal === undefined ? {} : { abortSignal }),
      })
      result = {
        status: 'succeeded',
        output: handled.output as ToolActionOutputs[Action],
        sideEffects: handled.sideEffects ?? [],
        evidence: handled.evidence ?? [],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = {
        status: 'failed',
        error: {
          code: abortSignal?.aborted ? 'timeout' : 'execution_failed',
          message,
          retryable: handler.retryMode !== 'none',
        },
        effectState: handler.risk === 'read_only' ? 'none' : 'unknown',
        sideEffects: [],
      }
    }

    await this.store.finish(
      reservation.executionId,
      reservation.executionToken,
      result,
    )
    return result
  }
}

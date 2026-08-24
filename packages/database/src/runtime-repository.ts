import { createHash, randomUUID } from 'node:crypto'

import {
  assertRunTransition,
  type ContextSnapshot,
  EVENT_TOPICS,
  type IsoTimestamp,
  type LlmCallId,
  type ModelMessage,
  type ModelContinuation,
  type ModelRequest,
  type ModelResponse,
  type RunControlKind,
  type RunControlRequest,
  type RunControlRequestId,
  type RunId,
  type RunStatus,
  type RuntimeRunContext,
  type WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

interface RuntimeRunRow {
  readonly workspace_id: string
  readonly mission_id: string
  readonly task_id: string
  readonly run_id: string
  readonly agent_id: string
  readonly status: RunStatus
  readonly current_hop: number
  readonly max_hops: number
  readonly context_snapshot: Readonly<Record<string, unknown>>
}

function asRunContext(row: RuntimeRunRow): RuntimeRunContext {
  return {
    workspaceId: row.workspace_id as RuntimeRunContext['workspaceId'],
    missionId: row.mission_id as RuntimeRunContext['missionId'],
    taskId: row.task_id as RuntimeRunContext['taskId'],
    runId: row.run_id as RuntimeRunContext['runId'],
    agentId: row.agent_id as RuntimeRunContext['agentId'],
    status: row.status,
    currentHop: row.current_hop,
    maxHops: row.max_hops,
    contextSnapshot: row.context_snapshot,
  }
}

function redactedRequest(request: ModelRequest): Readonly<Record<string, unknown>> {
  return {
    messages: request.messages.map((message) => ({
      role: message.role,
      contentHash: createHash('sha256').update(message.content).digest('hex'),
      contentLength: message.content.length,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      toolActions: message.toolCalls?.map((call) => call.action) ?? [],
    })),
    tools: request.tools.map((tool) => tool.action),
    ...(request.context === undefined ? {} : { context: request.context }),
  }
}

function redactedResponse(response: ModelResponse): Readonly<Record<string, unknown>> {
  return {
    contentHash: createHash('sha256').update(response.content).digest('hex'),
    contentLength: response.content.length,
    toolCalls: response.toolCalls.map((call) => ({ id: call.id, action: call.action })),
    finishReason: response.finishReason,
  }
}

export class RuntimeRepository {
  constructor(private readonly pool: Pool) {}

  async loadRun(runId: RunId): Promise<RuntimeRunContext | null> {
    const result = await this.pool.query<RuntimeRunRow>(
      'SELECT workspace_id, mission_id, task_id, id AS run_id, agent_id, status, ' +
      'current_hop, max_hops, context_snapshot FROM agent_runs WHERE id = $1',
      [runId],
    )
    return result.rows[0] ? asRunContext(result.rows[0]) : null
  }

  async initializeMessages(runId: RunId, messages: readonly ModelMessage[]): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const run = await client.query(
        'SELECT 1 FROM agent_runs WHERE id = $1 FOR UPDATE',
        [runId],
      )
      if (!run.rows[0]) {
        throw new Error('Run not found: ' + runId)
      }
      const existing = await client.query(
        'SELECT 1 FROM agent_run_messages WHERE run_id = $1 LIMIT 1 FOR UPDATE',
        [runId],
      )
      if ((existing.rowCount ?? 0) > 0) {
        return
      }
      for (const message of messages) {
        await this.insertMessage(client, runId, 0, message)
      }
    })
  }

  async loadMessages(runId: RunId): Promise<readonly ModelMessage[]> {
    const result = await this.pool.query<{
      hop: number
      role: ModelMessage['role']
      content: string
      tool_call_id: string | null
      tool_calls: ModelMessage['toolCalls'] | null
      created_at: Date
    }>(
      'SELECT hop, role, content, tool_call_id, tool_calls, created_at ' +
      'FROM agent_run_messages WHERE run_id = $1 ORDER BY seq',
      [runId],
    )
    return result.rows.map((row) => ({
      role: row.role,
      content: row.content,
      hop: row.hop,
      ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id as never }),
      ...(row.tool_calls == null ? {} : { toolCalls: row.tool_calls }),
      createdAt: row.created_at.toISOString() as IsoTimestamp,
    }))
  }

  async loadModelContinuation(runId: RunId): Promise<ModelContinuation | null> {
    const result = await this.pool.query<{
      provider: string
      model: string
      provider_request_id: string
      hop: number
    }>(
      'SELECT provider, model, provider_request_id, hop FROM llm_calls ' +
      "WHERE run_id = $1 AND status = 'succeeded' AND provider_request_id IS NOT NULL " +
      'ORDER BY hop DESC, finished_at DESC LIMIT 1',
      [runId],
    )
    const row = result.rows[0]
    return row ? {
      provider: row.provider,
      model: row.model,
      responseId: row.provider_request_id,
      hop: row.hop,
    } : null
  }

  async saveContextSnapshot(snapshot: ContextSnapshot): Promise<void> {
    const run = await this.loadRun(snapshot.runId)
    if (!run) throw new Error('Run not found: ' + snapshot.runId)
    await withTransaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO context_snapshots ' +
        '(id, workspace_id, mission_id, task_id, run_id, hop, strategy, token_budget, ' +
        'estimated_tokens, compacted, source_message_count, included_message_count, ' +
        'content_hash, content) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb) ' +
        'ON CONFLICT (run_id, hop) DO NOTHING',
        [
          snapshot.id,
          run.workspaceId,
          run.missionId,
          run.taskId,
          snapshot.runId,
          snapshot.hop,
          snapshot.content.strategy,
          snapshot.content.tokenBudget,
          snapshot.content.estimatedTokens,
          snapshot.content.compacted,
          snapshot.content.sourceMessageCount,
          snapshot.content.includedMessageCount,
          snapshot.contentHash,
          canonicalJson(snapshot.content),
        ],
      )
      const stored = await client.query<{ id: string; content_hash: string }>(
        'SELECT id, content_hash FROM context_snapshots WHERE run_id = $1 AND hop = $2 FOR UPDATE',
        [snapshot.runId, snapshot.hop],
      )
      const row = stored.rows[0]
      if (!row || row.id !== snapshot.id || row.content_hash !== snapshot.contentHash) {
        throw new Error('Context Snapshot replay differs from the durable hop snapshot')
      }
    })
  }

  async appendMessage(runId: RunId, hop: number, message: ModelMessage): Promise<void> {
    await this.insertMessage(this.pool, runId, hop, message)
  }

  async startRun(runId: RunId): Promise<RuntimeRunContext> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<RuntimeRunRow>(
        'SELECT workspace_id, mission_id, task_id, id AS run_id, agent_id, status, ' +
        'current_hop, max_hops, context_snapshot FROM agent_runs WHERE id = $1 FOR UPDATE',
        [runId],
      )
      const row = current.rows[0]
      if (!row) {
        throw new Error('Run not found: ' + runId)
      }
      if (row.status === 'starting') {
        assertRunTransition(row.status, 'running')
        await client.query(
          "UPDATE agent_runs SET status = 'running', started_at = COALESCE(started_at, NOW()), " +
          'last_heartbeat_at = NOW(), updated_at = NOW() WHERE id = $1',
          [runId],
        )
        await client.query(
          "UPDATE tasks SET status = 'running', updated_at = NOW() " +
          "WHERE id = $1 AND status = 'claimed'",
          [row.task_id],
        )
        await this.insertRunEvent(client, row, row.current_hop, 'run_started', {})
        return asRunContext({ ...row, status: 'running' })
      }
      if (row.status !== 'running' && row.status !== 'waiting_human') {
        throw new Error('Run cannot be started from status ' + row.status)
      }
      return asRunContext(row)
    })
  }

  async beginHop(runId: RunId): Promise<number | null> {
    const updated = await this.pool.query<{ current_hop: number }>(
      'UPDATE agent_runs SET current_hop = current_hop + 1, last_heartbeat_at = NOW(), updated_at = NOW() ' +
      "WHERE id = $1 AND status = 'running' AND current_hop < max_hops RETURNING current_hop",
      [runId],
    )
    return updated.rows[0]?.current_hop ?? null
  }

  async transitionRun(runId: RunId, to: RunStatus, summary: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<RuntimeRunRow>(
        'SELECT workspace_id, mission_id, task_id, id AS run_id, agent_id, status, ' +
        'current_hop, max_hops, context_snapshot FROM agent_runs WHERE id = $1 FOR UPDATE',
        [runId],
      )
      const row = current.rows[0]
      if (!row) {
        throw new Error('Run not found: ' + runId)
      }
      if (row.status === to) {
        return
      }
      assertRunTransition(row.status, to)
      const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(to)
      await client.query(
        'UPDATE agent_runs SET status = $2, completion_summary = $3, last_heartbeat_at = NOW(), ' +
        'finished_at = CASE WHEN $4 THEN NOW() ELSE finished_at END, updated_at = NOW() WHERE id = $1',
        [runId, to, summary, terminal],
      )
      if (to === 'waiting_human') {
        await client.query(
          "UPDATE tasks SET status = 'waiting_human', updated_at = NOW() " +
          "WHERE id = $1 AND status = 'running'",
          [row.task_id],
        )
      } else if (to === 'running' && row.status === 'waiting_human') {
        await client.query(
          "UPDATE tasks SET status = 'running', updated_at = NOW() " +
          "WHERE id = $1 AND status = 'waiting_human'",
          [row.task_id],
        )
      }
      if (terminal) {
        await this.insertRunEvent(client, row, row.current_hop, 'run_finished', {
          from: row.status,
          to,
          summary,
        })
      }
    })
  }

  async recordEvent(
    runId: RunId,
    hop: number,
    kind: 'tool_requested' | 'tool_completed' | 'steering_applied' | 'completion_rejected',
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const row = await this.pool.query<RuntimeRunRow>(
      'SELECT workspace_id, mission_id, task_id, id AS run_id, agent_id, status, ' +
      'current_hop, max_hops, context_snapshot FROM agent_runs WHERE id = $1',
      [runId],
    )
    if (!row.rows[0]) {
      throw new Error('Run not found: ' + runId)
    }
    await this.insertRunEvent(this.pool, row.rows[0], hop, kind, data)
  }

  async beginModelCall(
    callId: LlmCallId,
    runId: RunId,
    hop: number,
    provider: string,
    model: string,
    request: ModelRequest,
  ): Promise<number> {
    const startedAt = Date.now()
    const run = await this.loadRun(runId)
    if (!run) {
      throw new Error('Run not found: ' + runId)
    }
    const redacted = redactedRequest(request)
    const hash = createHash('sha256').update(canonicalJson(redacted)).digest('hex')
    await withTransaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO llm_calls ' +
        '(id, workspace_id, mission_id, task_id, run_id, hop, provider, model, status, ' +
        "request_hash, request_redacted, context_snapshot_id) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10::jsonb, $11)",
        [
          callId,
          run.workspaceId,
          run.missionId,
          run.taskId,
          runId,
          hop,
          provider,
          model,
          hash,
          JSON.stringify(redacted),
          request.context?.snapshotId ?? null,
        ],
      )
      await this.insertRunEvent(client, {
        workspace_id: run.workspaceId,
        mission_id: run.missionId,
        task_id: run.taskId,
        run_id: run.runId,
        agent_id: run.agentId,
        status: run.status,
        current_hop: run.currentHop,
        max_hops: run.maxHops,
        context_snapshot: run.contextSnapshot,
      }, hop, 'model_requested', { callId, provider, model })
    })
    return startedAt
  }

  async finishModelCall(
    callId: LlmCallId,
    runId: RunId,
    hop: number,
    startedAt: number,
    response: ModelResponse,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        "UPDATE llm_calls SET status = 'succeeded', response_redacted = $2::jsonb, " +
        'provider_request_id = $3, input_tokens = $4, output_tokens = $5, cached_input_tokens = $6, ' +
        'estimated_cost_usd = $7, latency_ms = $8, finished_at = NOW() ' +
        "WHERE id = $1 AND status = 'running'",
        [
          callId,
          JSON.stringify(redactedResponse(response)),
          response.providerRequestId ?? null,
          response.usage.inputTokens,
          response.usage.outputTokens,
          response.usage.cachedInputTokens ?? null,
          response.usage.estimatedCostUsd ?? null,
          Math.max(0, Date.now() - startedAt),
        ],
      )
      if (updated.rowCount !== 1) {
        throw new Error('LLM call is not running: ' + callId)
      }
      const found = await client.query<RuntimeRunRow>(
        'SELECT workspace_id, mission_id, task_id, id AS run_id, agent_id, status, ' +
        'current_hop, max_hops, context_snapshot FROM agent_runs WHERE id = $1',
        [runId],
      )
      const run = found.rows[0]
      if (!run) {
        throw new Error('Run not found: ' + runId)
      }
      await this.insertRunEvent(client, run, hop, 'model_responded', {
        callId,
        finishReason: response.finishReason,
        toolCount: response.toolCalls.length,
      })
    })
  }

  async failModelCall(
    callId: LlmCallId,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await this.pool.query(
      "UPDATE llm_calls SET status = 'failed', error = $2::jsonb, latency_ms = $3, " +
      "finished_at = NOW() WHERE id = $1 AND status = 'running'",
      [callId, JSON.stringify({ message }), Math.max(0, Date.now() - startedAt)],
    )
  }

  async createControl(input: {
    readonly id: RunControlRequestId
    readonly workspaceId: WorkspaceId
    readonly runId: RunId
    readonly kind: RunControlKind
    readonly payload: Readonly<Record<string, unknown>>
    readonly createdBy: string
    readonly dedupeKey: string
  }): Promise<RunControlRequestId> {
    return withTransaction(this.pool, async (client) => {
      const run = await client.query<{ agent_id: string; mission_id: string }>(
        'SELECT agent_id, mission_id FROM agent_runs WHERE id = $1 AND workspace_id = $2',
        [input.runId, input.workspaceId],
      )
      const scope = run.rows[0]
      if (!scope) throw new Error('Run not found in workspace: ' + input.runId)
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO run_control_requests ' +
        '(id, workspace_id, run_id, kind, payload, created_by, dedupe_key) ' +
        'VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) ' +
        'ON CONFLICT (run_id, dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key RETURNING id',
        [input.id, input.workspaceId, input.runId, input.kind, canonicalJson(input.payload), input.createdBy, input.dedupeKey],
      )
      const id = inserted.rows[0]?.id
      if (!id) throw new Error('Run control request was not persisted')

      const wakeData = {
        schemaVersion: 1,
        type: 'agent.wake',
        reason: 'run.control',
        workspaceId: input.workspaceId,
        missionId: scope.mission_id,
        runId: input.runId,
        agentId: scope.agent_id,
        controlId: id,
        controlKind: input.kind,
      }
      const payload = canonicalJson(wakeData)
      const inbox = await client.query<{ id: string }>(
        'INSERT INTO inbox_messages ' +
        '(id, workspace_id, agent_id, mission_id, run_id, kind, payload, payload_hash, dedupe_key) ' +
        "VALUES ($1, $2, $3, $4, $5, 'run.control', $6::jsonb, $7, $8) " +
        'ON CONFLICT (agent_id, dedupe_key) DO NOTHING RETURNING id',
        [
          'inbox_' + randomUUID(),
          input.workspaceId,
          scope.agent_id,
          scope.mission_id,
          input.runId,
          payload,
          createHash('sha256').update(payload).digest('hex'),
          'run-control:' + id,
        ],
      )
      if (inbox.rows[0]) {
        await client.query(
          'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
          ['wake_' + randomUUID(), EVENT_TOPICS.agentWake, scope.agent_id, payload],
        )
      }
      return id as RunControlRequestId
    })
  }

  async takePendingControls(runId: RunId): Promise<readonly RunControlRequest[]> {
    return withTransaction(this.pool, async (client) => {
      const pending = await client.query<{
        id: string
        workspace_id: string
        kind: RunControlKind
        payload: Readonly<Record<string, unknown>>
        created_by: string
        created_at: Date
      }>(
        "SELECT id, workspace_id, kind, payload, created_by, created_at FROM run_control_requests " +
        "WHERE run_id = $1 AND status = 'pending' ORDER BY created_at, id FOR UPDATE",
        [runId],
      )
      if ((pending.rowCount ?? 0) > 0) {
        await client.query(
          "UPDATE run_control_requests SET status = 'applied', applied_at = NOW() " +
          "WHERE run_id = $1 AND status = 'pending'",
          [runId],
        )
      }
      return pending.rows.map((row) => ({
        id: row.id as RunControlRequestId,
        workspaceId: row.workspace_id as WorkspaceId,
        runId,
        kind: row.kind,
        payload: row.payload,
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString() as IsoTimestamp,
      }))
    })
  }

  private async insertRunEvent(
    client: { query: Pool['query'] },
    run: RuntimeRunRow,
    hop: number,
    kind: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await client.query(
      'INSERT INTO agent_run_events ' +
      '(id, workspace_id, mission_id, task_id, run_id, hop, kind, data) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)',
      [
        'run_event_' + randomUUID(),
        run.workspace_id,
        run.mission_id,
        run.task_id,
        run.run_id,
        hop,
        kind,
        JSON.stringify(data),
      ],
    )
  }

  private async insertMessage(
    client: { query: Pool['query'] },
    runId: RunId,
    hop: number,
    message: ModelMessage,
  ): Promise<void> {
    await client.query(
      'INSERT INTO agent_run_messages ' +
      '(id, run_id, hop, role, content, tool_call_id, tool_calls) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
      [
        'run_message_' + randomUUID(),
        runId,
        hop,
        message.role,
        message.content,
        message.toolCallId ?? null,
        message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
      ],
    )
  }
}

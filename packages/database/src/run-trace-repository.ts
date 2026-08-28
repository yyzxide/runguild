import type { Pool } from 'pg'

/**
 * Read-only, strictly Workspace/Project scoped projection over the real run
 * ledger. Every query constrains `agent_runs.workspace_id` (the actor Workspace),
 * `missions.project_id` (the requested Project), AND a `users` membership join
 * proving the requesting actor belongs to that Workspace, then joins through
 * `agent_runs -> tasks -> missions` so a Run can never leak across Projects.
 *
 * REDACTION CONTRACT: this repository only exposes identifiers, status fields,
 * token/cost aggregates and summary projections. It never selects
 * `llm_calls.request_redacted` / `response_redacted` message bodies nor
 * `tool_executions.request` / `result` raw payloads, and it never reads
 * secrets/API keys.
 */

export interface RunTraceAgentSummary {
  readonly id: string
  readonly name: string
  readonly role: string | null
}

export interface RunTraceTaskSummary {
  readonly id: string
  readonly title: string
  readonly role: string | null
}

export interface RunTraceMissionSummary {
  readonly id: string
  readonly title: string
}

export interface RunTraceListEntry {
  readonly runId: string
  readonly status: string
  readonly attempt: number
  readonly currentHop: number
  readonly maxHops: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly createdAt: string
  readonly agent: RunTraceAgentSummary
  readonly task: RunTraceTaskSummary
  readonly mission: RunTraceMissionSummary
}

export interface RunTraceEvent {
  readonly seq: number
  readonly id: string
  readonly runId: string
  readonly hop: number
  readonly kind: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

export interface RunLlmCallSummary {
  readonly id: string
  readonly runId: string
  readonly hop: number
  readonly provider: string
  readonly model: string
  readonly status: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly estimatedCostUsd: number | null
  readonly latencyMs: number | null
  readonly errorCode: string | null
  readonly startedAt: string
  readonly finishedAt: string | null
}

export interface RunToolExecutionSummary {
  readonly id: string
  readonly runId: string
  readonly action: string
  readonly status: string
  readonly effectState: string
  readonly errorCode: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export interface RunTraceDetail extends RunTraceListEntry {
  readonly modelProvider: string | null
  readonly modelName: string | null
  readonly contextSummary: Readonly<Record<string, unknown>>
  readonly completionSummary: string | null
  readonly events: readonly RunTraceEvent[]
  readonly llmCalls: readonly RunLlmCallSummary[]
  readonly toolExecutions: readonly RunToolExecutionSummary[]
}

export interface RunTraceScope {
  readonly workspaceId: string
  readonly projectId: string
  readonly actorId: string
}

/** pg returns TIMESTAMPTZ as Date and BIGSERIAL as string; normalize to JSON-safe values. */
function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/**
 * Build the redacted Context Snapshot summary. Only explicit scalar summary
 * fields are projected; the full context_snapshot payload (which may embed
 * model message content) is never returned verbatim.
 */
function buildContextSummary(
  snapshot: Readonly<Record<string, unknown>>,
  fallbackProvider: string | null,
  fallbackModel: string | null,
  taskTitle: string,
  missionTitle: string,
): Readonly<Record<string, unknown>> {
  const summary: Record<string, unknown> = {
    taskTitle,
    missionTitle,
    modelProvider: typeof snapshot.modelProvider === 'string' ? snapshot.modelProvider : fallbackProvider,
    modelName: typeof snapshot.modelName === 'string' ? snapshot.modelName : fallbackModel,
  }
  for (const key of ['tokenBudget', 'estimatedTokens', 'compacted'] as const) {
    if (snapshot[key] !== undefined && snapshot[key] !== null) {
      summary[key] = snapshot[key]
    }
  }
  return summary
}

interface RunTraceListRow {
  run_id: string
  status: string
  attempt: number
  current_hop: number
  max_hops: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  agent_id: string
  agent_name: string
  agent_role: string | null
  task_id: string
  task_title: string
  task_role: string | null
  mission_id: string
  mission_title: string
}

interface RunTraceDetailRow extends RunTraceListRow {
  model_provider: string | null
  model_name: string | null
  context_snapshot: Readonly<Record<string, unknown>>
  completion_summary: string | null
}

function mapListRow(row: RunTraceListRow): RunTraceListEntry {
  return {
    runId: row.run_id,
    status: row.status,
    attempt: row.attempt,
    currentHop: row.current_hop,
    maxHops: row.max_hops,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at) ?? '',
    agent: { id: row.agent_id, name: row.agent_name, role: row.agent_role },
    task: { id: row.task_id, title: row.task_title, role: row.task_role },
    mission: { id: row.mission_id, title: row.mission_title },
  }
}

const listSelect = `
  SELECT
    r.id AS run_id,
    r.status,
    r.attempt,
    r.current_hop,
    r.max_hops,
    r.started_at,
    r.finished_at,
    r.context_snapshot,
    r.completion_summary,
    r.created_at,
    a.id AS agent_id,
    a.name AS agent_name,
    a.role AS agent_role,
    a.model_provider AS model_provider,
    a.model_name AS model_name,
    t.id AS task_id,
    t.title AS task_title,
    t.required_role AS task_role,
    m.id AS mission_id,
    m.title AS mission_title
  FROM agent_runs r
  JOIN agents a ON a.id = r.agent_id AND a.workspace_id = r.workspace_id
  JOIN tasks t ON t.id = r.task_id AND t.mission_id = r.mission_id
  JOIN missions m ON m.id = r.mission_id AND m.workspace_id = r.workspace_id AND m.project_id = $2
  JOIN users actor ON actor.id = $3 AND actor.workspace_id = r.workspace_id
  WHERE r.workspace_id = $1
`

export class RunTraceRepository {
  constructor(private readonly pool: Pool) {}

  /** List the most recent Runs for one Project inside one Workspace. */
  async listRecentRuns(scope: RunTraceScope, limit = 20): Promise<readonly RunTraceListEntry[]> {
    const { rows } = await this.pool.query<RunTraceListRow>(
      listSelect + ' ORDER BY r.created_at DESC, r.id DESC LIMIT $4',
      [scope.workspaceId, scope.projectId, scope.actorId, limit],
    )
    return rows.map(mapListRow)
  }

  /**
   * Read one Run plus its full redacted audit summary (events, llm_calls,
   * tool_executions in persistent order). Returns null when the Run does not
   * exist or is outside the requested Workspace/Project scope.
   */
  async getRun(scope: RunTraceScope, runId: string): Promise<RunTraceDetail | null> {
    const { rows } = await this.pool.query<RunTraceDetailRow>(
      listSelect + `
        AND r.id = $4
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1`,
      [scope.workspaceId, scope.projectId, scope.actorId, runId],
    )
    const row = rows[0]
    if (!row) return null
    const [events, llmCalls, toolExecutions] = await Promise.all([
      this.listEvents(scope, runId),
      this.listLlmCalls(scope, runId),
      this.listToolExecutions(scope, runId),
    ])
    const snapshot = row.context_snapshot ?? {}
    return {
      ...mapListRow(row),
      modelProvider: row.model_provider ?? null,
      modelName: row.model_name ?? null,
      contextSummary: buildContextSummary(
        snapshot,
        row.model_provider ?? null,
        row.model_name ?? null,
        row.task_title,
        row.mission_title,
      ),
      completionSummary: row.completion_summary,
      events,
      llmCalls,
      toolExecutions,
    }
  }

  /** Persistent-order projection of agent_run_events (seq ascending). */
  async listEvents(scope: RunTraceScope, runId: string): Promise<readonly RunTraceEvent[]> {
    const { rows } = await this.pool.query<{
      seq: number
      id: string
      run_id: string
      hop: number
      kind: string
      data: Readonly<Record<string, unknown>>
      created_at: string
    }>(
      `SELECT e.seq, e.id, e.run_id, e.hop, e.kind, e.data, e.created_at
       FROM agent_run_events e
       JOIN agent_runs r ON r.id = e.run_id AND r.workspace_id = e.workspace_id
       JOIN tasks t ON t.id = r.task_id AND t.mission_id = r.mission_id
       JOIN missions m ON m.id = r.mission_id AND m.workspace_id = r.workspace_id AND m.project_id = $3
       JOIN users actor ON actor.id = $4 AND actor.workspace_id = r.workspace_id
       WHERE e.run_id = $1 AND e.workspace_id = $2
       ORDER BY e.seq ASC`,
      [runId, scope.workspaceId, scope.projectId, scope.actorId],
    )
    return rows.map((row) => ({
      seq: Number(row.seq),
      id: row.id,
      runId: row.run_id,
      hop: row.hop,
      kind: row.kind,
      data: row.data ?? {},
      createdAt: iso(row.created_at) ?? '',
    }))
  }

  /**
   * Redacted llm_calls summary: tokens, estimated cost, latency, status and
   * hop only. Message bodies (request_redacted/response_redacted) are never
   * selected.
   */
  async listLlmCalls(scope: RunTraceScope, runId: string): Promise<readonly RunLlmCallSummary[]> {
    const { rows } = await this.pool.query<{
      id: string
      run_id: string
      hop: number
      provider: string
      model: string
      status: string
      input_tokens: number | null
      output_tokens: number | null
      cached_input_tokens: number | null
      estimated_cost_usd: string | null
      latency_ms: number | null
      error_code: string | null
      started_at: string
      finished_at: string | null
    }>(
      `SELECT c.id, c.run_id, c.hop, c.provider, c.model, c.status,
              c.input_tokens, c.output_tokens, c.cached_input_tokens,
              c.estimated_cost_usd, c.latency_ms,
              c.error->>'code' AS error_code,
              c.started_at, c.finished_at
       FROM llm_calls c
       JOIN agent_runs r ON r.id = c.run_id AND r.workspace_id = c.workspace_id
       JOIN tasks t ON t.id = r.task_id AND t.mission_id = r.mission_id
       JOIN missions m ON m.id = r.mission_id AND m.workspace_id = r.workspace_id AND m.project_id = $3
       JOIN users actor ON actor.id = $4 AND actor.workspace_id = r.workspace_id
       WHERE c.run_id = $1 AND c.workspace_id = $2
       ORDER BY c.hop ASC, c.started_at ASC, c.id ASC`,
      [runId, scope.workspaceId, scope.projectId, scope.actorId],
    )
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      hop: row.hop,
      provider: row.provider,
      model: row.model,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedInputTokens: row.cached_input_tokens,
      estimatedCostUsd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
      latencyMs: row.latency_ms,
      errorCode: row.error_code,
      startedAt: iso(row.started_at) ?? '',
      finishedAt: iso(row.finished_at),
    }))
  }

  /**
   * Redacted tool_executions summary: action/status/effect_state, timing and
   * error code only. Raw request/result payloads are never selected.
   */
  async listToolExecutions(scope: RunTraceScope, runId: string): Promise<readonly RunToolExecutionSummary[]> {
    const { rows } = await this.pool.query<{
      id: string
      run_id: string
      action: string
      status: string
      effect_state: string
      error_code: string | null
      started_at: string | null
      finished_at: string | null
    }>(
      `SELECT x.id, x.run_id, x.action, x.status, x.effect_state,
              x.error->>'code' AS error_code,
              x.started_at, x.finished_at
       FROM tool_executions x
       JOIN agent_runs r ON r.id = x.run_id AND r.workspace_id = x.workspace_id
       JOIN tasks t ON t.id = r.task_id AND t.mission_id = r.mission_id
       JOIN missions m ON m.id = r.mission_id AND m.workspace_id = r.workspace_id AND m.project_id = $3
       JOIN users actor ON actor.id = $4 AND actor.workspace_id = r.workspace_id
       WHERE x.run_id = $1 AND x.workspace_id = $2
       ORDER BY x.created_at ASC, x.id ASC`,
      [runId, scope.workspaceId, scope.projectId, scope.actorId],
    )
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      action: row.action,
      status: row.status,
      effectState: row.effect_state,
      errorCode: row.error_code,
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
    }))
  }
}

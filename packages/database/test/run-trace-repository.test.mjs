import assert from 'node:assert/strict'
import test from 'node:test'

import { RunTraceRepository } from '../dist/index.js'

function scriptedPool(rowsByNeedle) {
  const statements = []
  const pool = {
    async query(statement, params) {
      statements.push({ statement, params })
      const needle = Object.keys(rowsByNeedle).find((key) => statement.includes(key))
      if (!needle) return { rows: [], rowCount: 0 }
      const rows = rowsByNeedle[needle]
      return { rows, rowCount: rows.length }
    },
  }
  return { pool, statements }
}

function scope() {
  return { workspaceId: 'ws_test', projectId: 'project_test', actorId: 'user_test' }
}

const listRow = {
  run_id: 'run_list_1',
  status: 'completed',
  attempt: 1,
  current_hop: 2,
  max_hops: 5,
  started_at: new Date('2030-01-01T00:00:00.000Z'),
  finished_at: new Date('2030-01-01T00:10:00.000Z'),
  created_at: new Date('2030-01-01T00:00:00.000Z'),
  agent_id: 'agent_build',
  agent_name: '构建 Agent',
  agent_role: 'builder',
  task_id: 'task_1',
  task_title: 'Build',
  task_role: 'builder',
  mission_id: 'mission_1',
  mission_title: 'Mission',
}

test('listRecentRuns maps rows, normalizes timestamps, and enforces scope', async () => {
  const { pool, statements } = scriptedPool({ 'AS run_id,': [listRow] })
  const repository = new RunTraceRepository(pool)
  const runs = await repository.listRecentRuns(scope(), 5)

  assert.equal(runs.length, 1)
  assert.equal(runs[0].runId, 'run_list_1')
  assert.equal(runs[0].startedAt, '2030-01-01T00:00:00.000Z')
  assert.equal(runs[0].finishedAt, '2030-01-01T00:10:00.000Z')
  assert.equal(runs[0].agent.name, '构建 Agent')
  assert.equal(runs[0].mission.title, 'Mission')
  assert.deepEqual(statements[0].params, ['ws_test', 'project_test', 'user_test', 5])

  const sql = statements[0].statement
  assert.match(sql, /WHERE r\.workspace_id = \$1/)
  assert.match(sql, /JOIN missions m ON m\.id = r\.mission_id AND m\.workspace_id = r\.workspace_id AND m\.project_id = \$2/)
  assert.match(sql, /JOIN users actor ON actor\.id = \$3 AND actor\.workspace_id = r\.workspace_id/)
  assert.match(sql, /ORDER BY r\.created_at DESC, r\.id DESC LIMIT \$4/)
})

test('getRun returns redacted detail with stable serialization and scoped joins', async () => {
  const detailRow = {
    ...listRow,
    run_id: 'run_detail_1',
    model_provider: 'openai',
    model_name: 'gpt-test',
    context_snapshot: {
      modelProvider: 'openai',
      modelName: 'gpt-test',
      tokenBudget: 65536,
      estimatedTokens: 12000,
      compacted: false,
      rawMessages: [{ role: 'user', content: 'SECRET PROMPT' }],
      apiKey: 'sk-secret',
    },
    completion_summary: 'Build completed',
  }
  const eventRows = [{
    seq: '1', id: 'event_1', run_id: 'run_detail_1', hop: 1,
    kind: 'observation', data: { note: 'plan' },
    created_at: new Date('2030-01-01T00:00:01.000Z'),
  }]
  const llmRows = [{
    id: 'llm_1', run_id: 'run_detail_1', hop: 1, provider: 'openai', model: 'gpt-test',
    status: 'completed', input_tokens: 1000, output_tokens: 500, cached_input_tokens: 0,
    estimated_cost_usd: '0.0123', latency_ms: 1200, error_code: null,
    started_at: new Date('2030-01-01T00:00:00.000Z'),
    finished_at: new Date('2030-01-01T00:00:01.000Z'),
  }]
  const toolRows = [{
    id: 'tool_1', run_id: 'run_detail_1', action: 'file.read', status: 'success',
    effect_state: 'none', error_code: null,
    started_at: new Date('2030-01-01T00:00:01.000Z'),
    finished_at: new Date('2030-01-01T00:00:02.000Z'),
  }]
  const { pool, statements } = scriptedPool({
    'AS run_id,': [detailRow],
    'FROM agent_run_events e': eventRows,
    'FROM llm_calls c': llmRows,
    'FROM tool_executions': toolRows,
  })
  const repository = new RunTraceRepository(pool)
  const detail = await repository.getRun(scope(), 'run_detail_1')

  assert.ok(detail)
  assert.equal(detail.runId, 'run_detail_1')
  assert.equal(detail.modelProvider, 'openai')
  assert.equal(detail.completionSummary, 'Build completed')
  // BIGSERIAL seq and pg NUMERIC cost are JSON-safe numbers.
  assert.equal(detail.events[0].seq, 1)
  assert.equal(detail.llmCalls[0].estimatedCostUsd, 0.0123)
  assert.equal(detail.toolExecutions[0].action, 'file.read')
  // Context summary only projects explicit summary fields; no secrets or raw messages.
  assert.equal(detail.contextSummary.modelProvider, 'openai')
  assert.equal(detail.contextSummary.taskTitle, 'Build')
  assert.equal(detail.contextSummary.missionTitle, 'Mission')
  assert.equal(detail.contextSummary.tokenBudget, 65536)
  assert.equal('rawMessages' in detail.contextSummary, false)
  assert.equal('apiKey' in detail.contextSummary, false)
  // Events keep persistent order; calls keep hop/timing order.
  assert.match(statements[1].statement, /ORDER BY e\.seq ASC/)
  assert.match(statements[2].statement, /ORDER BY c\.hop ASC, c\.started_at ASC, c\.id ASC/)
  assert.match(statements[3].statement, /JOIN missions m ON m\.id = r\.mission_id/)
  assert.match(statements[3].statement, /JOIN users actor ON actor\.id = \$4/)
  // Redaction contract: no model message bodies or raw tool payloads are selected.
  const allSql = statements.map(({ statement }) => statement).join('\n')
  assert.equal(allSql.includes('request_redacted'), false)
  assert.equal(allSql.includes('response_redacted'), false)
  assert.equal(allSql.includes('x.request'), false)
  assert.equal(allSql.includes('x.result'), false)
})

test('getRun returns null when the run is outside Workspace/Project scope', async () => {
  const { pool } = scriptedPool({ 'AS run_id,': [] })
  const repository = new RunTraceRepository(pool)
  const detail = await repository.getRun(scope(), 'run_other_workspace')
  assert.equal(detail, null)
})

test('listRecentRuns returns an empty array for a foreign Project', async () => {
  const { pool } = scriptedPool({ 'AS run_id,': [] })
  const repository = new RunTraceRepository(pool)
  const runs = await repository.listRecentRuns({
    workspaceId: 'ws_test',
    projectId: 'project_foreign',
    actorId: 'user_test',
  })
  assert.deepEqual(runs, [])
})

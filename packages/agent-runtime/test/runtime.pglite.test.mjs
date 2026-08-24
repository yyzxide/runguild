import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { RuntimeRepository, ToolExecutionRepository } from '@runguild/database'
import { ToolGateway } from '@runguild/tool-gateway'
import { AgentRuntime, DeterministicContextBuilder, ScriptedModelAdapter } from '../dist/index.js'

const migrationUrls = [
  new URL('../../database/migrations/0001_core.sql', import.meta.url),
  new URL('../../database/migrations/0002_orchestration.sql', import.meta.url),
  new URL('../../database/migrations/0003_runtime.sql', import.meta.url),
  new URL('../../database/migrations/0004_execution.sql', import.meta.url),
  new URL('../../database/migrations/0005_artifacts.sql', import.meta.url),
  new URL('../../database/migrations/0006_reviews.sql', import.meta.url),
  new URL('../../database/migrations/0007_worktrees.sql', import.meta.url),
  new URL('../../database/migrations/0008_context.sql', import.meta.url),
  new URL('../../database/migrations/0009_evaluation.sql', import.meta.url),
]

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return {
    async connect() { return client },
    query: client.query,
  }
}

test('real persistence runs model, idempotent tool, ledger, and completion gate end to end', async () => {
  const database = new PGlite()
  try {
    for (const url of migrationUrls) {
      await database.exec(await readFile(url, 'utf8'))
    }
    await database.exec(
      "INSERT INTO workspaces (id, name) VALUES ('ws_e2e', 'Runtime');" +
      "INSERT INTO projects (id, workspace_id, name) VALUES ('project_e2e', 'ws_e2e', 'Project');" +
      "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) " +
      "VALUES ('agent_e2e', 'ws_e2e', 'Builder', 'builder', 'scripted', 'deterministic');" +
      "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) " +
      "VALUES ('mission_e2e', 'ws_e2e', 'project_e2e', 'Mission', 'Goal', 'running', 'user');" +
      "INSERT INTO tasks (id, mission_id, title, status, required_role, attempt_count) " +
      "VALUES ('task_e2e', 'mission_e2e', 'Task', 'claimed', 'builder', 1);" +
      "INSERT INTO agent_runs " +
      "(id, workspace_id, mission_id, task_id, agent_id, attempt, status, max_hops) " +
      "VALUES ('run_e2e', 'ws_e2e', 'mission_e2e', 'task_e2e', 'agent_e2e', 1, 'starting', 5);",
    )
    const pool = poolAdapter(database)
    let searches = 0
    const gateway = new ToolGateway(new ToolExecutionRepository(pool), [{
      action: 'repo.search',
      risk: 'read_only',
      retryMode: 'read_only',
      async execute(input) {
        searches += 1
        return { output: { matches: [{ path: 'README.md', line: 1, preview: input.query }] } }
      },
    }])
    const model = new ScriptedModelAdapter('scripted', 'deterministic', [{
      content: '',
      toolCalls: [
        { id: 'call_e2e_search', action: 'repo.search', input: { query: 'runtime' } },
        { id: 'call_e2e_done', action: 'run.set_status', input: { status: 'done', summary: 'Verified.' } },
      ],
      finishReason: 'tool_calls',
      usage: { inputTokens: 23, outputTokens: 8, estimatedCostUsd: 0.001 },
      providerRequestId: 'provider_e2e',
    }])
    const runtime = new AgentRuntime({
      persistence: new RuntimeRepository(pool),
      model,
      tools: gateway,
      completionVerifier: { verify: async () => ({ accepted: true }) },
      contextBuilder: new DeterministicContextBuilder({ tokenBudget: 4_096 }),
      toolDefinitions: [{ action: 'repo.search', description: 'Search repository', inputSchema: { type: 'object' } }],
    })

    const outcome = await runtime.run({
      runId: 'run_e2e',
      initialMessages: [{ role: 'user', content: 'Inspect and finish.' }],
    })
    assert.deepEqual(outcome, { status: 'succeeded', summary: 'Verified.', hops: 1 })
    assert.equal(searches, 1)

    const run = await database.query(
      "SELECT status, current_hop, completion_summary FROM agent_runs WHERE id = 'run_e2e'",
    )
    assert.deepEqual(run.rows[0], {
      status: 'succeeded',
      current_hop: 1,
      completion_summary: 'Verified.',
    })
    const ledger = await database.query(
      "SELECT status, input_tokens, output_tokens, provider_request_id, context_snapshot_id " +
      "FROM llm_calls WHERE run_id = 'run_e2e'",
    )
    assert.deepEqual(ledger.rows[0], {
      status: 'succeeded',
      input_tokens: 23,
      output_tokens: 8,
      provider_request_id: 'provider_e2e',
      context_snapshot_id: model.requests[0].context.snapshotId,
    })
    const snapshots = await database.query(
      "SELECT hop, strategy, compacted, content_hash FROM context_snapshots WHERE run_id = 'run_e2e'",
    )
    assert.equal(snapshots.rows.length, 1)
    assert.deepEqual(snapshots.rows[0], {
      hop: 1,
      strategy: 'full',
      compacted: false,
      content_hash: model.requests[0].context.contentHash,
    })
    const execution = await database.query(
      "SELECT status, attempts, effect_state FROM tool_executions WHERE run_id = 'run_e2e'",
    )
    assert.deepEqual(execution.rows[0], { status: 'succeeded', attempts: 1, effect_state: 'complete' })
    const messages = await database.query(
      "SELECT role, tool_call_id FROM agent_run_messages WHERE run_id = 'run_e2e' ORDER BY seq",
    )
    assert.deepEqual(messages.rows.map((row) => row.role), ['system', 'user', 'assistant', 'tool', 'tool'])
    assert.deepEqual(messages.rows.slice(-2).map((row) => row.tool_call_id), ['call_e2e_search', 'call_e2e_done'])
    const events = await database.query(
      "SELECT kind FROM agent_run_events WHERE run_id = 'run_e2e' ORDER BY seq",
    )
    assert.deepEqual(events.rows.map((row) => row.kind), [
      'run_started',
      'model_requested',
      'model_responded',
      'tool_requested',
      'tool_completed',
      'run_finished',
    ])
  } finally {
    await database.close()
  }
})

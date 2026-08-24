import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { ToolExecutionRepository } from '@runguild/database'
import { ToolGateway } from '../dist/index.js'

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

async function fixture() {
  const database = new PGlite()
  for (const url of migrationUrls) {
    await database.exec(await readFile(url, 'utf8'))
  }
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws_tool', 'Tool');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project_tool', 'ws_tool', 'Project');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) " +
    "VALUES ('agent_tool', 'ws_tool', 'Builder', 'builder', 'test', 'test');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) " +
    "VALUES ('mission_tool', 'ws_tool', 'project_tool', 'Mission', 'Goal', 'running', 'user');" +
    "INSERT INTO tasks (id, mission_id, title, status, required_role, attempt_count) " +
    "VALUES ('task_tool', 'mission_tool', 'Task', 'running', 'builder', 1);" +
    "INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status) " +
    "VALUES ('run_tool', 'ws_tool', 'mission_tool', 'task_tool', 'agent_tool', 1, 'running');",
  )
  return { database, pool: poolAdapter(database) }
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'call_search',
    action: 'repo.search',
    workspaceId: 'ws_tool',
    missionId: 'mission_tool',
    taskId: 'task_tool',
    runId: 'run_tool',
    agentId: 'agent_tool',
    idempotencyKey: 'run_tool:call_search',
    risk: 'read_only',
    input: { query: 'mission' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

test('tool gateway enforces replay, approval, and ambiguity rules in durable state', async () => {
  const { database, pool } = await fixture()
  const repository = new ToolExecutionRepository(pool)
  try {
    {
      let executions = 0
      const gateway = new ToolGateway(repository, [{
        action: 'repo.search',
        risk: 'read_only',
        retryMode: 'read_only',
        async execute(input) {
          executions += 1
          return {
            output: { matches: [{ path: 'README.md', line: 1, preview: input.query }] },
          }
        },
      }])

      const first = await gateway.execute(request())
      const replay = await gateway.execute(request({ id: 'call_search_retry' }))
      assert.equal(first.status, 'succeeded')
      assert.deepEqual(replay, first)
      assert.equal(executions, 1)

      await assert.rejects(
        gateway.execute(request({ id: 'call_drift', input: { query: 'different' } })),
        /Idempotency key reused with a different tool request/,
      )
    }

    {
      let writes = 0
      const gateway = new ToolGateway(repository, [{
        action: 'conversation.reply',
        risk: 'external_write',
        retryMode: 'native_idempotency',
        async execute() {
          writes += 1
          return { output: { messageId: 'message_external' } }
        },
      }])
      const external = request({
        id: 'call_external',
        action: 'conversation.reply',
        idempotencyKey: 'run_tool:call_external',
        risk: 'external_write',
        input: { conversationId: 'conversation_tool', body: 'Ship it' },
      })

      const waiting = await gateway.execute(external)
      assert.equal(waiting.status, 'awaiting_approval')
      assert.equal(writes, 0)
      assert.equal(await repository.resolveApproval({
        approvalId: waiting.approvalId,
        workspaceId: 'ws_tool',
        resolvedBy: 'human_reviewer',
        decision: 'approved',
      }), true)
      const wake = await database.query(
        "SELECT i.kind, o.topic FROM inbox_messages i " +
        "JOIN outbox_events o ON o.partition_key = i.agent_id " +
        "WHERE i.dedupe_key = 'tool-approval:' || $1 || ':approved' " +
        "AND o.payload->>'approvalId' = $1",
        [waiting.approvalId],
      )
      assert.deepEqual(wake.rows[0], {
        kind: 'tool.approval_resolved',
        topic: 'mission.agent-wake.v1',
      })

      const completed = await gateway.execute(external)
      const replay = await gateway.execute(external)
      assert.equal(completed.status, 'succeeded')
      assert.deepEqual(replay, completed)
      assert.equal(writes, 1)
    }

    {
      const unsafe = request({
        id: 'call_unsafe',
        action: 'shell.run',
        idempotencyKey: 'run_tool:call_unsafe',
        risk: 'workspace_write',
        input: { command: ['deploy'], timeoutMs: 1000 },
      })
      const reserved = await repository.reserve({ request: unsafe, retryMode: 'none', leaseMs: 1000 })
      assert.equal(reserved.kind, 'execute')
      await database.exec(
        "UPDATE tool_executions SET lease_expires_at = NOW() - INTERVAL '1 second' " +
        "WHERE id = 'call_unsafe'",
      )

      const recovered = await repository.reserve({ request: unsafe, retryMode: 'none', leaseMs: 1000 })
      assert.equal(recovered.kind, 'replay')
      assert.equal(recovered.result.status, 'failed')
      assert.equal(recovered.result.error.code, 'ambiguous_effect')
      assert.equal(recovered.result.effectState, 'unknown')
    }
  } finally {
    await database.close()
  }
})

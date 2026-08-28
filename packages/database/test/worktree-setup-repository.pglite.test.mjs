import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { WorktreeSetupRepository } from '../dist/index.js'

const migrations = [
  '0001_core.sql',
  '0002_orchestration.sql',
  '0003_runtime.sql',
  '0004_execution.sql',
  '0005_artifacts.sql',
  '0006_reviews.sql',
  '0007_worktrees.sql',
  '0008_context.sql',
  '0009_evaluation.sql',
  '0010_conversations.sql',
  '0011_conversation_planning.sql',
  '0012_worker_instances.sql',
  '0013_project_runtime_config.sql',
  '0014_reviewer_execution.sql',
  '0015_worktree_setup.sql',
  '0016_submission_evidence.sql',
]

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return { async connect() { return client }, query: client.query }
}

async function setup(database) {
  for (const migration of migrations) {
    await database.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'))
  }
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project', 'ws', 'Project'), ('other', 'ws', 'Other');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('builder', 'ws', 'Builder', 'builder', 'openai', 'model');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) VALUES " +
    "('mission', 'ws', 'project', 'Mission', 'Goal', 'running', 'user');" +
    "INSERT INTO tasks (id, mission_id, title, status) VALUES ('task', 'mission', 'Task', 'running');" +
    "INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status) VALUES " +
    "('run_1', 'ws', 'mission', 'task', 'builder', 1, 'running'), " +
    "('run_2', 'ws', 'mission', 'task', 'builder', 2, 'running');" +
    "INSERT INTO task_worktrees " +
    "(task_id, workspace_id, mission_id, project_id, repository_path, worktree_path, branch_name, " +
    "base_ref, base_commit, head_commit, status, generation) VALUES " +
    "('task', 'ws', 'mission', 'project', '/repo', '/worktrees/task', 'agent/task', " +
    "'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', " +
    "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ready', 1);",
  )
}

function reserve(runId = 'run_1', commands = [['npm', 'ci']]) {
  return {
    workspaceId: 'ws', missionId: 'mission', projectId: 'project', taskId: 'task', runId,
    worktreeGeneration: 1, commands, leaseSeconds: 60,
  }
}

function result(argv = ['npm', 'ci']) {
  return {
    commandIndex: 0,
    argv,
    exitCode: 0,
    timedOut: false,
    durationMs: 123,
    stdoutHash: 'a'.repeat(64),
    stderrHash: 'b'.repeat(64),
  }
}

test('Worktree setup reservations are fenced, durable, and reusable for the exact generation and argv', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new WorktreeSetupRepository(poolAdapter(database))
    const first = await repository.reserve(reserve())
    assert.equal(first.kind, 'execute')
    assert.equal(first.setup.attempt, 1)
    assert.equal((await repository.reserve(reserve())).kind, 'busy')
    assert.equal(await repository.renew({ setupId: first.setup.id, leaseToken: first.leaseToken }), true)

    const succeeded = await repository.markSucceeded({
      setupId: first.setup.id,
      leaseToken: first.leaseToken,
      results: [result()],
    })
    assert.equal(succeeded.status, 'succeeded')
    assert.equal('stdout' in succeeded.results[0], false)

    const reused = await repository.reserve(reserve('run_2'))
    assert.equal(reused.kind, 'succeeded')
    assert.equal(reused.reused, true)
    assert.equal(reused.setup.id, first.setup.id)
    assert.equal((await repository.listRecentForProject({ workspaceId: 'ws', projectId: 'project' })).length, 1)
  } finally {
    await database.close()
  }
})

test('Worktree setup recovers expired leases and records failures without raw command output', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new WorktreeSetupRepository(poolAdapter(database))
    const commands = [['npm', 'install']]
    const first = await repository.reserve(reserve('run_1', commands))
    assert.equal(first.kind, 'execute')
    await database.exec(
      "UPDATE task_worktree_setups SET lease_expires_at = NOW() - INTERVAL '1 second' " +
      "WHERE id = '" + first.setup.id + "'",
    )
    const recovered = await repository.reserve(reserve('run_1', commands))
    assert.equal(recovered.kind, 'execute')
    assert.equal(recovered.setup.attempt, 2)
    assert.notEqual(recovered.leaseToken, first.leaseToken)

    const failed = await repository.markFailed({
      setupId: recovered.setup.id,
      leaseToken: recovered.leaseToken,
      results: [{ ...result(commands[0]), exitCode: 7 }],
      error: { code: 'exit_nonzero', commandIndex: 0, exitCode: 7 },
    })
    assert.equal(failed.status, 'failed')
    assert.equal(JSON.stringify(failed).includes('raw package manager output'), false)
    const replay = await repository.reserve(reserve('run_1', commands))
    assert.equal(replay.kind, 'failed')
    await assert.rejects(
      repository.reserve({ ...reserve('run_2', [['npm', 'ci']]), projectId: 'other' }),
      /scope or generation/,
    )
  } finally {
    await database.close()
  }
})

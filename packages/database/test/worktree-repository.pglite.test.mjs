import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { TaskWorktreeRepository } from '../dist/index.js'

const migrationUrls = [
  new URL('../migrations/0001_core.sql', import.meta.url),
  new URL('../migrations/0002_orchestration.sql', import.meta.url),
  new URL('../migrations/0003_runtime.sql', import.meta.url),
  new URL('../migrations/0004_execution.sql', import.meta.url),
  new URL('../migrations/0005_artifacts.sql', import.meta.url),
  new URL('../migrations/0006_reviews.sql', import.meta.url),
  new URL('../migrations/0007_worktrees.sql', import.meta.url),
  new URL('../migrations/0008_context.sql', import.meta.url),
  new URL('../migrations/0009_evaluation.sql', import.meta.url),
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

async function setup(database) {
  for (const url of migrationUrls) await database.exec(await readFile(url, 'utf8'))
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws_tree', 'Worktrees');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES " +
    "('project_tree', 'ws_tree', 'Project'), ('project_other', 'ws_tree', 'Other');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) VALUES " +
    "('mission_tree', 'ws_tree', 'project_tree', 'Mission', 'Goal', 'running', 'user');" +
    "INSERT INTO tasks (id, mission_id, title, status) VALUES " +
    "('task_tree', 'mission_tree', 'One', 'running'), " +
    "('task_recovery', 'mission_tree', 'Two', 'running'), " +
    "('task_scope', 'mission_tree', 'Three', 'running');",
  )
}

function reservation(taskId, overrides = {}) {
  return {
    workspaceId: 'ws_tree',
    missionId: 'mission_tree',
    projectId: 'project_tree',
    taskId,
    repositoryPath: '/srv/repos/project',
    worktreePath: '/srv/worktrees/' + taskId,
    branchName: 'agent/' + taskId,
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    leaseSeconds: 60,
    ...overrides,
  }
}

test('Task Worktree reservation is fenced, replay-safe, and records commits', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new TaskWorktreeRepository(poolAdapter(database))
    const first = await repository.reserve(reservation('task_tree'))
    assert.equal(first.kind, 'provision')
    assert.equal(first.worktree.generation, 1)
    const busy = await repository.reserve(reservation('task_tree'))
    assert.equal(busy.kind, 'busy')

    await assert.rejects(repository.markReady({
      taskId: 'task_tree',
      provisionToken: 'stale_token',
      headCommit: 'a'.repeat(40),
    }), /stale/)
    const ready = await repository.markReady({
      taskId: 'task_tree',
      provisionToken: first.provisionToken,
      headCommit: 'a'.repeat(40),
    })
    assert.equal(ready.status, 'ready')
    const replay = await repository.reserve(reservation('task_tree'))
    assert.equal(replay.kind, 'ready')

    await assert.rejects(repository.recordUnchangedIntegration({
      taskId: 'task_tree', headCommit: 'b'.repeat(40),
    }), /unchanged baseline/)

    const committed = await repository.recordCommit({
      taskId: 'task_tree',
      headCommit: 'b'.repeat(40),
    })
    assert.equal(committed.status, 'committed')
    assert.equal(committed.headCommit, 'b'.repeat(40))
    const integration = await repository.reserveIntegration({ taskId: 'task_tree', leaseSeconds: 60 })
    assert.equal(integration.kind, 'integrate')
    assert.equal((await repository.reserveIntegration({ taskId: 'task_tree' })).kind, 'busy')
    await assert.rejects(repository.markIntegrated({
      taskId: 'task_tree',
      integrationToken: 'stale_integration',
      integratedCommit: 'b'.repeat(40),
    }), /stale/)
    const integrated = await repository.markIntegrated({
      taskId: 'task_tree',
      integrationToken: integration.integrationToken,
      integratedCommit: 'b'.repeat(40),
    })
    assert.equal(integrated.status, 'integrated')
    assert.equal(integrated.integratedCommit, 'b'.repeat(40))
    const cleanup = await repository.reserveCleanup({ taskId: 'task_tree', leaseSeconds: 60 })
    assert.equal(cleanup.kind, 'cleanup')
    assert.equal((await repository.reserveCleanup({ taskId: 'task_tree' })).kind, 'busy')
    const removed = await repository.markRemoved({
      taskId: 'task_tree',
      cleanupToken: cleanup.cleanupToken,
    })
    assert.equal(removed.status, 'removed')
    await assert.rejects(repository.reserve(reservation('task_tree', {
      worktreePath: '/srv/worktrees/different',
    })), /different repository semantics/)
  } finally {
    await database.close()
  }
})

test('clean baseline Worktree can be finalized without entering the integration queue', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new TaskWorktreeRepository(poolAdapter(database))
    const reserved = await repository.reserve(reservation('task_scope'))
    assert.equal(reserved.kind, 'provision')
    const ready = await repository.markReady({
      taskId: 'task_scope', provisionToken: reserved.provisionToken, headCommit: 'a'.repeat(40),
    })
    assert.equal(ready.status, 'ready')
    const integrated = await repository.recordUnchangedIntegration({
      taskId: 'task_scope', headCommit: 'a'.repeat(40),
    })
    assert.equal(integrated.status, 'integrated')
    assert.equal(integrated.integratedCommit, 'a'.repeat(40))
    assert.deepEqual(await repository.listApprovedPendingIntegration(10), [])
  } finally {
    await database.close()
  }
})

test('expired provisioning can be recovered only by a new fencing token', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new TaskWorktreeRepository(poolAdapter(database))
    const first = await repository.reserve(reservation('task_recovery'))
    assert.equal(first.kind, 'provision')
    await database.exec(
      "UPDATE task_worktrees SET provision_expires_at = NOW() - INTERVAL '1 second' " +
      "WHERE task_id = 'task_recovery'",
    )
    const recovered = await repository.reserve(reservation('task_recovery'))
    assert.equal(recovered.kind, 'provision')
    assert.equal(recovered.worktree.generation, 2)
    assert.notEqual(recovered.provisionToken, first.provisionToken)
    await assert.rejects(repository.markReady({
      taskId: 'task_recovery',
      provisionToken: first.provisionToken,
      headCommit: 'a'.repeat(40),
    }), /stale/)
    const failed = await repository.markFailed({
      taskId: 'task_recovery',
      provisionToken: recovered.provisionToken,
      error: { code: 'git_failed', message: 'simulated' },
    })
    assert.equal(failed.status, 'failed')

    await assert.rejects(repository.reserve(reservation('task_scope', {
      projectId: 'project_other',
    })), /scope/)
  } finally {
    await database.close()
  }
})

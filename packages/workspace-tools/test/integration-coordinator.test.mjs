import assert from 'node:assert/strict'
import test from 'node:test'

import { IntegrationCoordinator } from '../dist/index.js'

function worktree(taskId) {
  return {
    taskId,
    workspaceId: 'ws',
    missionId: 'mission',
    projectId: 'project',
    repositoryPath: '/repo',
    worktreePath: '/trees/' + taskId,
    branchName: 'agent/' + taskId,
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    status: 'committed',
    generation: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

test('Integration coordinator isolates busy/failing Tasks and completes only integrated gates', async () => {
  const completed = []
  const candidates = [
    worktree('task_success'),
    worktree('task_busy'),
    worktree('task_conflict'),
    worktree('task_failed'),
  ]
  const coordinator = new IntegrationCoordinator({
    worktrees: {
      async listApprovedPendingIntegration(limit) {
        assert.equal(limit, 10)
        return candidates
      },
      async listCompletedPendingCleanup() {
        return [worktree('task_cleanup')]
      },
    },
    manager: {
      async integrate(input) {
        if (input.taskId === 'task_busy') return { kind: 'busy', retryAfterMs: 1_000 }
        if (input.taskId === 'task_conflict') {
          return {
            kind: 'conflict',
            worktree: { ...candidates[2], status: 'ready' },
            taskStatus: 'ready',
          }
        }
        if (input.taskId === 'task_failed') throw new Error('stale base')
        return { kind: 'integrated', worktree: { ...candidates[0], status: 'integrated' } }
      },
      async cleanup() {
        return { kind: 'removed', worktree: { ...worktree('task_cleanup'), status: 'removed' } }
      },
    },
    tasks: {
      async completeTaskAndUnlockDependents(input) {
        completed.push(input)
        return { completed: true, unlockedTaskIds: [], missionReadyForReview: false }
      },
    },
  })
  const result = await coordinator.tick({ limit: 10, leaseSeconds: 60 })
  assert.deepEqual(result, {
    discovered: 4,
    integrated: 1,
    completed: 1,
    busy: 1,
    conflicts: 1,
    failed: 1,
    gateRejected: 0,
    cleanupDiscovered: 1,
    cleaned: 1,
    cleanupBusy: 0,
    cleanupFailed: 0,
  })
  assert.equal(completed.length, 1)
  assert.equal(completed[0].taskId, 'task_success')
  assert.equal(completed[0].actor.id, 'git-integration-gate')
})

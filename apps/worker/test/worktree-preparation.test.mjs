import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareWorktree } from '../dist/worktree-preparation.js'

const setup = {
  id: 'setup_1',
  workspaceId: 'ws',
  missionId: 'mission',
  projectId: 'project',
  taskId: 'task',
  runId: 'run',
  worktreeGeneration: 1,
  commandsHash: 'a'.repeat(64),
  commands: [['npm', 'ci']],
  status: 'running',
  attempt: 1,
  results: [],
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
  startedAt: '2030-01-01T00:00:00.000Z',
}

const input = {
  workspaceId: 'ws', missionId: 'mission', projectId: 'project', taskId: 'task', runId: 'run',
  worktreeGeneration: 1, worktreePath: '/worktree', commands: [['npm', 'ci']],
  timeoutMs: 30_000, leaseSeconds: 60,
}

const result = {
  commandIndex: 0, argv: ['npm', 'ci'], exitCode: 0, timedOut: false, durationMs: 20,
  stdoutHash: 'b'.repeat(64), stderrHash: 'c'.repeat(64),
}

test('Worktree preparation persists success only after all exact argv pass', async () => {
  const events = []
  await prepareWorktree({
    setups: {
      async reserve(reservation) {
        events.push(['reserve', reservation.runId, reservation.worktreeGeneration])
        return { kind: 'execute', setup, leaseToken: 'lease' }
      },
      async renew() { return true },
      async markSucceeded({ results }) {
        events.push(['succeeded', results.length])
        return { ...setup, status: 'succeeded', results }
      },
      async markFailed() { throw new Error('not expected') },
    },
    async execute(execution) {
      events.push(['execute', execution.root, execution.commands])
      return { passed: true, results: [result] }
    },
  }, input)
  assert.deepEqual(events, [
    ['reserve', 'run', 1],
    ['execute', '/worktree', [['npm', 'ci']]],
    ['succeeded', 1],
  ])
})

test('Worktree preparation persists a failed gate and prevents model runtime construction', async () => {
  let failure
  await assert.rejects(prepareWorktree({
    setups: {
      async reserve() { return { kind: 'execute', setup, leaseToken: 'lease' } },
      async renew() { return true },
      async markSucceeded() { throw new Error('not expected') },
      async markFailed(inputFailure) {
        failure = inputFailure
        return { ...setup, status: 'failed', results: inputFailure.results, error: inputFailure.error }
      },
    },
    async execute() {
      return {
        passed: false,
        results: [{ ...result, exitCode: 7 }],
        failure: { commandIndex: 0, code: 'exit_nonzero', exitCode: 7 },
      }
    },
  }, input), /command 1 did not pass/)
  assert.equal(failure.error.code, 'exit_nonzero')
  assert.equal(failure.results[0].exitCode, 7)
  assert.equal('stdout' in failure.results[0], false)
})

test('Worktree preparation reuses durable success and skips command execution', async () => {
  let executions = 0
  await prepareWorktree({
    setups: {
      async reserve() { return { kind: 'succeeded', setup: { ...setup, status: 'succeeded' }, reused: true } },
      async renew() { return true },
      async markSucceeded() { throw new Error('not expected') },
      async markFailed() { throw new Error('not expected') },
    },
    async execute() { executions += 1; return { passed: true, results: [] } },
  }, input)
  assert.equal(executions, 0)
})

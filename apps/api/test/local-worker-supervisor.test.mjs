import assert from 'node:assert/strict'
import test from 'node:test'

import { LocalWorkerSupervisor } from '../dist/local-worker-supervisor.js'

const configuration = {
  project: {
    id: 'project', workspaceId: 'workspace', name: 'Project',
    repositoryPath: '/workspace/project', defaultBranch: 'main',
  },
  runtime: {
    worktreeRoot: '/workspace/worktrees',
    testCommands: [['npm', 'test']],
    agentContextInputTokens: 65_536,
    agentMaxTestTimeoutMs: 120_000,
  },
  agents: [{
    id: 'builder', name: 'Builder', role: 'builder', status: 'active',
    modelProvider: 'openai', modelName: 'gpt-test',
  }],
}

test('local supervisor exposes readiness without exposing API credentials', () => {
  const supervisor = new LocalWorkerSupervisor({
    databaseUrl: 'postgres://database',
    activity: { async hasActive() { return false } },
  })
  const capabilities = supervisor.capabilities(configuration)
  assert.equal(capabilities.enabled, true)
  assert.equal(capabilities.secretSource, 'api_environment')
  assert.deepEqual(
    capabilities.workers.find((worker) => worker.kind === 'scheduler').missing,
    ['REDIS_URL'],
  )
  assert.deepEqual(
    capabilities.workers.find((worker) => worker.kind === 'agent').missing,
    ['OPENAI_API_KEY'],
  )
  assert.equal(JSON.stringify(capabilities).includes('postgres://database'), false)
})

test('local supervisor refuses duplicate and non-owned process control', async () => {
  const calls = []
  const supervisor = new LocalWorkerSupervisor({
    databaseUrl: 'postgres://database',
    redisUrl: 'redis://cache',
    openaiApiKey: 'secret-value',
    activity: {
      async hasActive(kind, agentId) {
        calls.push({ kind, agentId })
        return true
      },
    },
  })
  const result = await supervisor.start({ kind: 'scheduler' }, configuration)
  assert.equal(result.state, 'already_running')
  assert.deepEqual(calls, [{ kind: 'scheduler', agentId: undefined }])
  const stopped = await supervisor.stop({ kind: 'scheduler' })
  assert.equal(stopped.state, 'not_owned')
})

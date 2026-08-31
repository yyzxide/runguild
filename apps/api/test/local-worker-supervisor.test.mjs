import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureWorkspaceRoots, LocalWorkerSupervisor } from '../dist/local-worker-supervisor.js'

const configuration = {
  project: {
    id: 'project', workspaceId: 'workspace', name: 'Project',
    repositoryPath: '/workspace/project', defaultBranch: 'main',
  },
  runtime: {
    worktreeRoot: '/workspace/worktrees',
    worktreeSetupCommands: [['npm', 'ci', '--ignore-scripts']],
    worktreeSetupTimeoutMs: 240_000,
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

test('local supervisor injects persisted Worktree setup argv into only the Agent child environment', () => {
  const supervisor = new LocalWorkerSupervisor({
    databaseUrl: 'postgres://database',
    openaiApiKey: 'secret-value',
    activity: { async hasActive() { return false } },
  })
  const environment = supervisor.environmentFor({ kind: 'agent', agentId: 'builder' }, configuration)
  assert.equal(environment.AGENT_WORKTREE_SETUP_COMMANDS_JSON, '[["npm","ci","--ignore-scripts"]]')
  assert.equal(environment.AGENT_WORKTREE_SETUP_TIMEOUT_MS, '240000')
  assert.equal(environment.WORKSPACE_ID, 'workspace')
  assert.equal(environment.PROJECT_ID, 'project')
  assert.equal(environment.OPENAI_API_KEY, 'secret-value')
  const integration = supervisor.environmentFor({ kind: 'integration' }, configuration)
  assert.equal(integration.WORKSPACE_ID, 'workspace')
  assert.equal(integration.PROJECT_ID, 'project')
  assert.equal(integration.AGENT_WORKTREE_SETUP_COMMANDS_JSON, undefined)
  assert.equal(integration.OPENAI_API_KEY, undefined)
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
  const stopped = await supervisor.stop({ kind: 'scheduler' }, configuration)
  assert.equal(stopped.state, 'not_owned')
})

test('local supervisor checks Integration activity in the exact Project scope', async () => {
  const calls = []
  const supervisor = new LocalWorkerSupervisor({
    databaseUrl: 'postgres://database',
    activity: {
      async hasActive(kind, agentId, scope) {
        calls.push({ kind, agentId, scope })
        return true
      },
    },
  })
  const result = await supervisor.start({ kind: 'integration' }, configuration)
  assert.equal(result.state, 'already_running')
  assert.deepEqual(calls, [{
    kind: 'integration',
    agentId: undefined,
    scope: { workspaceId: 'workspace', projectId: 'project' },
  }])
})

test('local supervisor checks Agent activity in the exact Project scope', async () => {
  const calls = []
  const supervisor = new LocalWorkerSupervisor({
    databaseUrl: 'postgres://database',
    openaiApiKey: 'secret-value',
    activity: {
      async hasActive(kind, agentId, scope) {
        calls.push({ kind, agentId, scope })
        return true
      },
    },
  })
  const result = await supervisor.start({ kind: 'agent', agentId: 'builder' }, configuration)
  assert.equal(result.state, 'already_running')
  assert.deepEqual(calls, [{
    kind: 'agent',
    agentId: 'builder',
    scope: { workspaceId: 'workspace', projectId: 'project' },
  }])
})

test('ensureWorkspaceRoots creates missing Worktree root with 0700 permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runguild-lws-'))
  try {
    const repositoryPath = join(directory, 'repository')
    const worktreeRoot = join(directory, 'worktrees', 'nested')
    await mkdir(repositoryPath)
    await ensureWorkspaceRoots(repositoryPath, worktreeRoot)
    const created = await stat(worktreeRoot)
    assert.equal(created.isDirectory(), true)
    assert.equal(created.mode & 0o777, 0o700)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ensureWorkspaceRoots rejects an existing non-directory Worktree root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runguild-lws-'))
  try {
    const repositoryPath = join(directory, 'repository')
    const worktreeRoot = join(directory, 'worktrees')
    await mkdir(repositoryPath)
    await writeFile(worktreeRoot, 'not a directory')
    await assert.rejects(
      ensureWorkspaceRoots(repositoryPath, worktreeRoot),
      /已存在但不是目录/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ensureWorkspaceRoots validates repository path before creating Worktree root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runguild-lws-'))
  try {
    const repositoryPath = join(directory, 'missing-repository')
    const worktreeRoot = join(directory, 'worktrees')
    await assert.rejects(ensureWorkspaceRoots(repositoryPath, worktreeRoot))
    await assert.rejects(stat(worktreeRoot), (error) => error?.code === 'ENOENT')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

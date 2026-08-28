import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { GitWorktreeManager } from '../dist/index.js'

const execute = promisify(execFile)

async function git(cwd, ...args) {
  return (await execute('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim()
}

function fakeStore() {
  let record = null
  let tokenCounter = 0
  let failFirstReady = true
  let failFirstIntegration = true
  let failFirstCleanup = true
  return {
    get record() { return record },
    async reserve(input) {
      if (record?.status === 'ready' || record?.status === 'committed') {
        return { kind: 'ready', worktree: record }
      }
      tokenCounter += 1
      const now = new Date().toISOString()
      record = {
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        missionId: input.missionId,
        projectId: input.projectId,
        repositoryPath: input.repositoryPath,
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        baseRef: input.baseRef,
        baseCommit: input.baseCommit,
        status: 'provisioning',
        generation: tokenCounter,
        createdAt: now,
        updatedAt: now,
      }
      return {
        kind: 'provision',
        worktree: record,
        provisionToken: 'token_' + tokenCounter,
      }
    },
    async markReady(input) {
      if (failFirstReady) {
        failFirstReady = false
        throw new Error('Task Worktree provision token is stale')
      }
      record = { ...record, status: 'ready', headCommit: input.headCommit }
      return record
    },
    async markFailed(input) {
      record = { ...record, status: 'failed', lastError: input.error }
      return record
    },
    async markInvalid(input) {
      record = { ...record, status: 'failed', lastError: input.error }
      return record
    },
    setCommitted(headCommit) {
      record = { ...record, status: 'committed', headCommit }
    },
    async reserveIntegration() {
      if (record.status === 'integrated') return { kind: 'integrated', worktree: record }
      record = { ...record, status: 'integrating' }
      return { kind: 'integrate', worktree: record, integrationToken: 'integration_token' }
    },
    async markIntegrated(input) {
      if (failFirstIntegration) {
        failFirstIntegration = false
        throw new Error('Task Worktree integration token is stale')
      }
      record = { ...record, status: 'integrated', integratedCommit: input.integratedCommit }
      return record
    },
    async markIntegrationFailed(input) {
      record = { ...record, status: 'committed', lastError: input.error }
      return record
    },
    async markIntegrationConflict(input) {
      record = {
        ...record,
        status: 'ready',
        reconciliationBaseCommit: input.reconciliationBaseCommit,
        lastError: input.error,
      }
      return { worktree: record, taskStatus: 'ready' }
    },
    async reserveCleanup() {
      if (record.status === 'removed') return { kind: 'removed', worktree: record }
      record = { ...record, status: 'cleanup_pending' }
      return { kind: 'cleanup', worktree: record, cleanupToken: 'cleanup_token' }
    },
    async markRemoved() {
      if (failFirstCleanup) {
        failFirstCleanup = false
        throw new Error('Task Worktree cleanup token is stale')
      }
      record = { ...record, status: 'removed' }
      return record
    },
    async markCleanupFailed(input) {
      record = { ...record, status: 'integrated', lastError: input.error }
      return record
    },
  }
}

test('Git Worktree manager provisions, reconciles a post-create crash, and verifies replay', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'runguild-worktree-'))
  const repositoryPath = join(temporary, 'repository')
  const worktreeRoot = join(temporary, 'worktrees')
  await mkdir(repositoryPath)
  try {
    await execute('git', ['init', repositoryPath])
    await git(repositoryPath, 'checkout', '-b', 'main')
    await writeFile(join(repositoryPath, 'README.md'), 'baseline\n')
    await git(repositoryPath, 'add', 'README.md')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'baseline',
    )
    const store = fakeStore()
    const manager = await GitWorktreeManager.create({ repositoryPath, worktreeRoot, store })
    const input = {
      workspaceId: 'ws_git',
      missionId: 'mission_git',
      projectId: 'project_git',
      taskId: 'task:unsafe/name',
      baseRef: 'main',
    }

    await assert.rejects(manager.ensure({
      ...input,
      expectedBaseCommit: 'f'.repeat(40),
    }), /frozen Evaluation Scenario baseline/)
    const baselineCommit = await git(repositoryPath, 'rev-parse', 'HEAD')
    input.expectedBaseCommit = baselineCommit

    await assert.rejects(manager.ensure(input), /token is stale/)
    assert.equal(store.record.status, 'failed')
    const recovered = await manager.ensure(input)
    assert.equal(recovered.kind, 'ready')
    assert.equal(recovered.worktree.generation, 2)
    assert.equal(await readFile(join(recovered.worktree.worktreePath, 'README.md'), 'utf8'), 'baseline\n')
    assert.equal(
      await git(recovered.worktree.worktreePath, 'branch', '--show-current'),
      recovered.worktree.branchName,
    )

    const replay = await manager.ensure(input)
    assert.equal(replay.kind, 'ready')
    assert.equal(replay.worktree.worktreePath, recovered.worktree.worktreePath)

    await git(recovered.worktree.worktreePath, 'switch', '-c', 'wrong-branch')
    await assert.rejects(manager.ensure(input), /wrong branch/)
    assert.equal(store.record.status, 'failed')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Git Worktree manager rejects a Worktree root nested inside the source repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'runguild-worktree-boundary-'))
  const repositoryPath = join(temporary, 'repository')
  const nested = join(repositoryPath, 'nested-worktrees')
  await mkdir(repositoryPath)
  try {
    await execute('git', ['init', repositoryPath])
    await git(repositoryPath, 'checkout', '-b', 'main')
    await writeFile(join(repositoryPath, 'README.md'), 'baseline\n')
    await git(repositoryPath, 'add', 'README.md')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'baseline',
    )
    await assert.rejects(GitWorktreeManager.create({
      repositoryPath,
      worktreeRoot: nested,
      store: fakeStore(),
    }), /cannot be inside/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Git integration retains the reviewed HEAD across a conflict-free merge and database crash', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'runguild-integration-'))
  const repositoryPath = join(temporary, 'repository')
  const worktreeRoot = join(temporary, 'worktrees')
  await mkdir(repositoryPath)
  try {
    await execute('git', ['init', repositoryPath])
    await git(repositoryPath, 'checkout', '-b', 'main')
    await writeFile(join(repositoryPath, 'README.md'), 'baseline\n')
    await git(repositoryPath, 'add', 'README.md')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'baseline',
    )
    const store = fakeStore()
    const manager = await GitWorktreeManager.create({ repositoryPath, worktreeRoot, store })
    const input = {
      workspaceId: 'ws_git',
      missionId: 'mission_git',
      projectId: 'project_git',
      taskId: 'task_integration',
      baseRef: 'main',
    }
    await assert.rejects(manager.ensure(input), /token is stale/)
    const assigned = await manager.ensure(input)
    assert.equal(assigned.kind, 'ready')
    await writeFile(join(assigned.worktree.worktreePath, 'feature.txt'), 'reviewed change\n')
    await git(assigned.worktree.worktreePath, 'add', 'feature.txt')
    await git(
      assigned.worktree.worktreePath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'reviewed feature',
    )
    const taskHead = await git(assigned.worktree.worktreePath, 'rev-parse', 'HEAD')
    await writeFile(join(repositoryPath, 'platform.txt'), 'platform advanced\n')
    await git(repositoryPath, 'add', 'platform.txt')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'platform advanced',
    )
    const sourceHead = await git(repositoryPath, 'rev-parse', 'HEAD')
    store.setCommitted(taskHead)

    await assert.rejects(manager.integrate({ taskId: input.taskId }), /token is stale/)
    const integratedHead = await git(repositoryPath, 'rev-parse', 'HEAD')
    assert.notEqual(integratedHead, taskHead)
    assert.deepEqual(
      (await git(repositoryPath, 'rev-list', '--parents', '-n', '1', integratedHead)).split(' '),
      [integratedHead, sourceHead, taskHead],
    )
    assert.equal(store.record.status, 'committed')
    await writeFile(join(repositoryPath, 'README.md'), 'dirty after merge\n')
    await assert.rejects(manager.integrate({ taskId: input.taskId }), /must be clean/)
    await writeFile(join(repositoryPath, 'README.md'), 'baseline\n')
    const recovered = await manager.integrate({ taskId: input.taskId })
    assert.equal(recovered.kind, 'integrated')
    assert.equal(recovered.worktree.integratedCommit, integratedHead)
    assert.equal(await readFile(join(repositoryPath, 'feature.txt'), 'utf8'), 'reviewed change\n')
    assert.equal(await readFile(join(repositoryPath, 'platform.txt'), 'utf8'), 'platform advanced\n')
    await assert.rejects(manager.cleanup({ taskId: input.taskId }), /token is stale/)
    assert.equal(store.record.status, 'integrated')
    const cleaned = await manager.cleanup({ taskId: input.taskId })
    assert.equal(cleaned.kind, 'removed')
    assert.equal(cleaned.worktree.status, 'removed')
    await assert.rejects(readFile(join(assigned.worktree.worktreePath, 'feature.txt')), /ENOENT/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Git integration rejects conflicts without changing the current base branch', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'runguild-integration-conflict-'))
  const repositoryPath = join(temporary, 'repository')
  const worktreeRoot = join(temporary, 'worktrees')
  await mkdir(repositoryPath)
  try {
    await execute('git', ['init', repositoryPath])
    await git(repositoryPath, 'checkout', '-b', 'main')
    await writeFile(join(repositoryPath, 'README.md'), 'baseline\n')
    await git(repositoryPath, 'add', 'README.md')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'baseline',
    )
    const store = fakeStore()
    const manager = await GitWorktreeManager.create({ repositoryPath, worktreeRoot, store })
    const input = {
      workspaceId: 'ws_conflict',
      missionId: 'mission_conflict',
      projectId: 'project_conflict',
      taskId: 'task_conflict',
      baseRef: 'main',
    }
    await assert.rejects(manager.ensure(input), /token is stale/)
    const assigned = await manager.ensure(input)
    await writeFile(join(assigned.worktree.worktreePath, 'README.md'), 'reviewed Task change\n')
    await git(assigned.worktree.worktreePath, 'add', 'README.md')
    await git(
      assigned.worktree.worktreePath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'reviewed conflicting change',
    )
    const taskHead = await git(assigned.worktree.worktreePath, 'rev-parse', 'HEAD')
    store.setCommitted(taskHead)
    await writeFile(join(repositoryPath, 'README.md'), 'current base change\n')
    await git(repositoryPath, 'add', 'README.md')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'conflicting base change',
    )
    const sourceHead = await git(repositoryPath, 'rev-parse', 'HEAD')

    const conflict = await manager.integrate({ taskId: input.taskId })
    assert.equal(conflict.kind, 'conflict')
    assert.equal(conflict.taskStatus, 'ready')
    assert.equal(await git(repositoryPath, 'rev-parse', 'HEAD'), sourceHead)
    assert.equal(await git(repositoryPath, 'status', '--porcelain=v1'), '')
    assert.equal(await readFile(join(repositoryPath, 'README.md'), 'utf8'), 'current base change\n')
    assert.equal(store.record.status, 'ready')
    assert.equal(store.record.reconciliationBaseCommit, sourceHead)
    assert.match(
      await readFile(join(assigned.worktree.worktreePath, 'README.md'), 'utf8'),
      /<<<<<<< HEAD[\s\S]*reviewed Task change[\s\S]*current base change[\s\S]*>>>>>>>/,
    )
    assert.equal(await git(assigned.worktree.worktreePath, 'rev-parse', 'MERGE_HEAD'), sourceHead)
    assert.match(store.record.lastError.message, /conflicts with the current base/)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Evaluation Trials advance isolated refs without mutating the checked-out project branch', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'runguild-evaluation-ref-'))
  const repositoryPath = join(temporary, 'repository')
  const worktreeRoot = join(temporary, 'worktrees')
  await mkdir(repositoryPath)
  try {
    await execute('git', ['init', repositoryPath])
    await git(repositoryPath, 'checkout', '-b', 'main')
    await writeFile(join(repositoryPath, 'README.md'), 'baseline\n')
    await git(repositoryPath, 'add', 'README.md')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'baseline',
    )
    const baselineCommit = await git(repositoryPath, 'rev-parse', 'HEAD')
    const evaluationRef = 'evaluation/trial-evaluation_trial_abc123'
    const store = fakeStore()
    const manager = await GitWorktreeManager.create({ repositoryPath, worktreeRoot, store })
    const input = {
      workspaceId: 'ws_eval',
      missionId: 'mission_eval',
      projectId: 'project_eval',
      taskId: 'task_eval_first',
      baseRef: evaluationRef,
      expectedBaseCommit: baselineCommit,
      allowBaseRefAdvance: true,
    }

    await assert.rejects(manager.ensure(input), /token is stale/)
    const assigned = await manager.ensure(input)
    assert.equal(assigned.kind, 'ready')
    assert.equal(assigned.worktree.baseCommit, baselineCommit)
    await writeFile(join(assigned.worktree.worktreePath, 'evaluation.txt'), 'isolated change\n')
    await git(assigned.worktree.worktreePath, 'add', 'evaluation.txt')
    await git(
      assigned.worktree.worktreePath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'evaluation change',
    )
    const taskHead = await git(assigned.worktree.worktreePath, 'rev-parse', 'HEAD')
    await writeFile(join(repositoryPath, 'README.md'), 'platform baseline advanced\n')
    await git(repositoryPath, 'add', 'README.md')
    await git(
      repositoryPath,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'advance project main independently',
    )
    const projectMain = await git(repositoryPath, 'rev-parse', 'HEAD')
    await git(repositoryPath, 'branch', '-f', evaluationRef, projectMain)
    store.setCommitted(taskHead)

    await assert.rejects(manager.integrate({ taskId: input.taskId }), /token is stale/)
    const integrated = await manager.integrate({ taskId: input.taskId })
    assert.equal(integrated.kind, 'integrated')
    const evaluationHead = await git(repositoryPath, 'rev-parse', evaluationRef)
    assert.equal(integrated.worktree.integratedCommit, evaluationHead)
    assert.notEqual(evaluationHead, taskHead)
    await git(repositoryPath, 'merge-base', '--is-ancestor', taskHead, evaluationHead)
    assert.equal(await git(repositoryPath, 'rev-parse', 'main'), projectMain)
    assert.equal(await readFile(join(repositoryPath, 'README.md'), 'utf8'), 'platform baseline advanced\n')
    await assert.rejects(readFile(join(repositoryPath, 'evaluation.txt')), /ENOENT/)

    await assert.rejects(manager.cleanup({ taskId: input.taskId }), /token is stale/)
    await manager.cleanup({ taskId: input.taskId })

    const nextStore = fakeStore()
    const nextManager = await GitWorktreeManager.create({
      repositoryPath,
      worktreeRoot,
      store: nextStore,
    })
    await assert.rejects(nextManager.ensure({
      ...input,
      missionId: 'mission_eval_next',
      taskId: 'task_eval_next',
    }), /token is stale/)
    const next = await nextManager.ensure({
      ...input,
      missionId: 'mission_eval_next',
      taskId: 'task_eval_next',
    })
    assert.equal(next.kind, 'ready')
    assert.equal(next.worktree.baseCommit, evaluationHead)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

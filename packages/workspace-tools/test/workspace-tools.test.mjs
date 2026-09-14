import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { buildBubblewrapTestInvocation, createWorkspaceToolHandlers } from '../dist/index.js'

const execute = promisify(execFile)

function request(action, input, id = 'call_test') {
  return {
    schemaVersion: 1,
    id,
    action,
    workspaceId: 'ws_tools',
    missionId: 'mission_tools',
    taskId: 'task_tools',
    runId: 'run_tools',
    agentId: 'agent_tools',
    idempotencyKey: 'run_tools:' + id,
    risk: ['repo.search', 'repo.status', 'repo.diff', 'file.read'].includes(action)
      ? 'read_only'
      : 'workspace_write',
    input,
    createdAt: new Date().toISOString(),
  }
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mission-workspace-tools-'))
  await writeFile(join(root, 'sample.txt'), 'alpha\nsecond line\n', 'utf8')
  await execute('git', ['init', root])
  await execute('git', ['-C', root, 'config', 'user.name', 'RunGuild Test'])
  await execute('git', ['-C', root, 'config', 'user.email', 'runguild-test@example.invalid'])
  await execute('git', ['-C', root, 'checkout', '-b', 'main'])
  await execute('git', ['-C', root, 'add', 'sample.txt'])
  await execute('git', [
    '-C', root,
    '-c', 'user.name=RunGuild',
    '-c', 'user.email=runguild@example.invalid',
    'commit', '-m', 'baseline',
  ])
  const baseCommit = (await execute('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
  let worktree = {
    taskId: 'task_tools',
    workspaceId: 'ws_tools',
    missionId: 'mission_tools',
    projectId: 'project_tools',
    repositoryPath: root,
    worktreePath: root,
    branchName: 'main',
    baseRef: 'main',
    baseCommit,
    headCommit: baseCommit,
    status: 'ready',
    generation: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const evidence = []
  const command = options.command ?? ['/bin/echo', 'tests ok']
  const handlers = await createWorkspaceToolHandlers({
    root,
    allowedTestCommands: [command],
    protectedTestPaths: options.protectedTestPaths ?? [],
    ...(options.testSandbox ? { testSandbox: options.testSandbox } : {}),
    evidence: {
      async record(context, draft) {
        const item = {
          id: 'evidence_' + (evidence.length + 1),
          kind: draft.kind,
          uri: draft.uri,
          contentHash: draft.contentHash,
          producerRunId: context.request.runId,
          createdAt: new Date().toISOString(),
        }
        evidence.push({ item, draft })
        return [item]
      },
    },
    worktrees: {
      async get(taskId) {
        return taskId === worktree.taskId ? worktree : null
      },
      async recordCommit(input) {
        worktree = {
          ...worktree,
          status: 'committed',
          headCommit: input.headCommit,
          baseCommit: worktree.reconciliationBaseCommit ?? worktree.baseCommit,
          reconciliationBaseCommit: undefined,
          lastError: undefined,
        }
        return worktree
      },
      async recordUnchangedIntegration(input) {
        worktree = { ...worktree, status: 'integrated', integratedCommit: input.headCommit }
        return worktree
      },
    },
  })
  return {
    root,
    evidence,
    command,
    handlers: new Map(handlers.map((handler) => [handler.action, handler])),
    get worktree() { return worktree },
    setWorktree(next) { worktree = next },
  }
}

test('workspace read/search tools stay inside the assigned root', async () => {
  const setup = await fixture()
  try {
    const search = setup.handlers.get('repo.search')
    const read = setup.handlers.get('file.read')
    const found = await search.execute(
      { query: 'second line', paths: ['.'] },
      { request: request('repo.search', { query: 'second line' }) },
    )
    assert.equal(found.output.matches.some((match) => match.path.endsWith('sample.txt') && match.line === 2), true)
    assert.deepEqual(found.evidence.map((item) => item.kind), ['citation', 'command_result'])

    const content = await read.execute(
      { path: 'sample.txt', startLine: 2, endLine: 2 },
      { request: request('file.read', { path: 'sample.txt' }) },
    )
    assert.deepEqual(content.output, { path: 'sample.txt', content: 'second line', truncated: true })
    assert.deepEqual(content.evidence.map((item) => item.kind), ['citation'])

    const status = await setup.handlers.get('repo.status').execute(
      {},
      { request: request('repo.status', {}) },
    )
    assert.equal(status.output.clean, true)
    assert.deepEqual(status.evidence.map((item) => item.kind), ['command_result'])

    await symlink('/etc/passwd', join(setup.root, 'escape.txt'))
    await assert.rejects(
      read.execute(
        { path: 'escape.txt' },
        { request: request('file.read', { path: 'escape.txt' }) },
      ),
      /escapes the assigned workspace/,
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('workspace patch is replay-safe and produces file diff evidence', async () => {
  const setup = await fixture()
  try {
    const patch = setup.handlers.get('file.patch')
    const unifiedDiff = [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1,2 +1,2 @@',
      '-alpha',
      '+beta',
      ' second line',
      '',
    ].join('\n')
    const context = { request: request('file.patch', { path: 'sample.txt', unifiedDiff }, 'call_patch') }

    const first = await patch.execute({ path: 'sample.txt', unifiedDiff }, context)
    const recovered = await patch.execute({ path: 'sample.txt', unifiedDiff }, context)
    assert.equal(await readFile(join(setup.root, 'sample.txt'), 'utf8'), 'beta\nsecond line\n')
    assert.equal(first.output.changed, true)
    assert.equal(recovered.output.diffHash, first.output.diffHash)
    assert.equal(setup.evidence[0].draft.metadata.alreadyApplied, false)
    assert.equal(setup.evidence[1].draft.metadata.alreadyApplied, true)

    const wrongCounts = [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -999,99 +999,101 @@',
      '-beta',
      '+gamma',
      ' second line',
    ].join('\n')
    await patch.execute(
      { path: 'sample.txt', unifiedDiff: wrongCounts },
      { request: request('file.patch', { path: 'sample.txt', unifiedDiff: wrongCounts }, 'call_counts') },
    )
    assert.equal(await readFile(join(setup.root, 'sample.txt'), 'utf8'), 'gamma\nsecond line\n')
    assert.equal(setup.evidence[2].draft.metadata.normalizedHunkCounts, true)
    assert.equal(setup.evidence[2].draft.metadata.normalizedHunkStarts, true)
    assert.equal(setup.evidence[2].draft.metadata.appendedTrailingNewline, true)

    const headerless = [
      '@@ -1,2 +1,2 @@',
      '-gamma',
      '+delta',
      ' second line',
      '',
    ].join('\n')
    await patch.execute(
      { path: 'sample.txt', unifiedDiff: headerless },
      { request: request('file.patch', { path: 'sample.txt', unifiedDiff: headerless }, 'call_headerless') },
    )
    assert.equal(await readFile(join(setup.root, 'sample.txt'), 'utf8'), 'delta\nsecond line\n')

    const zeroContextEnvelope = [
      '*** Begin Patch',
      '*** Update File: sample.txt',
      '@@ -1,1 +1,1 @@',
      '-delta',
      '+epsilon',
      '*** End Patch',
      '',
    ].join('\n')
    await patch.execute(
      { path: 'sample.txt', unifiedDiff: zeroContextEnvelope },
      { request: request('file.patch', { path: 'sample.txt', unifiedDiff: zeroContextEnvelope }, 'call_zero_context') },
    )
    assert.equal(await readFile(join(setup.root, 'sample.txt'), 'utf8'), 'epsilon\nsecond line\n')

    const ambiguous = [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -999,1 +999,1 @@',
      '-second line',
      '+ambiguous line',
      '',
    ].join('\n')
    await writeFile(join(setup.root, 'sample.txt'), 'second line\nsecond line\n', 'utf8')
    await assert.rejects(
      patch.execute(
        { path: 'sample.txt', unifiedDiff: ambiguous },
        { request: request('file.patch', { path: 'sample.txt', unifiedDiff: ambiguous }, 'call_ambiguous') },
      ),
      /old-side context is ambiguous/,
    )

    await assert.rejects(
      patch.execute(
        { path: '../outside.txt', unifiedDiff: unifiedDiff.replaceAll('sample.txt', '../outside.txt') },
        { request: request('file.patch', {}, 'call_escape') },
      ),
      /unsafe path/,
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('workspace patch safely creates nested files beneath missing directories', async () => {
  const setup = await fixture()
  try {
    const patch = setup.handlers.get('file.patch')
    const unifiedDiff = [
      'diff --git a/src/core/types.ts b/src/core/types.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/core/types.ts',
      '@@ -0,0 +1,1 @@',
      '+export const direction = "north"',
      '',
    ].join('\n')
    await patch.execute(
      { path: 'src/core/types.ts', unifiedDiff },
      { request: request('file.patch', { path: 'src/core/types.ts', unifiedDiff }, 'call_nested') },
    )
    assert.equal(
      await readFile(join(setup.root, 'src/core/types.ts'), 'utf8'),
      'export const direction = "north"\n',
    )

    const headerless = '@@ -0,0 +1,1 @@\n+export const speed = 1\n'
    await patch.execute(
      { path: 'src/config/speed.ts', unifiedDiff: headerless },
      { request: request('file.patch', { path: 'src/config/speed.ts', unifiedDiff: headerless }, 'call_nested_headerless') },
    )
    assert.equal(await readFile(join(setup.root, 'src/config/speed.ts'), 'utf8'), 'export const speed = 1\n')
    await assert.rejects(
      patch.execute(
        { path: 'safe.ts\n+++ b/escape.ts', unifiedDiff: headerless },
        { request: request('file.patch', {}, 'call_header_injection') },
      ),
      /control characters/,
    )

    await symlink('/tmp', join(setup.root, 'linked'))
    const escapingDiff = unifiedDiff.replaceAll('src/core/types.ts', 'linked/core/types.ts')
    await assert.rejects(
      patch.execute(
        { path: 'linked/core/types.ts', unifiedDiff: escapingDiff },
        { request: request('file.patch', {}, 'call_nested_escape') },
      ),
      /outside the workspace/,
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('workspace delete removes only tracked regular files and is replay-safe', async () => {
  const setup = await fixture()
  try {
    const deleteFile = setup.handlers.get('file.delete')
    const context = { request: request('file.delete', { path: 'sample.txt' }, 'call_delete') }

    const first = await deleteFile.execute({ path: 'sample.txt' }, context)
    const replay = await deleteFile.execute({ path: 'sample.txt' }, context)
    await assert.rejects(readFile(join(setup.root, 'sample.txt'), 'utf8'), { code: 'ENOENT' })
    assert.deepEqual(first.output, {
      path: 'sample.txt',
      deleted: true,
      alreadyDeleted: false,
      diffHash: first.output.diffHash,
    })
    assert.equal(replay.output.alreadyDeleted, true)
    assert.equal(replay.output.diffHash, first.output.diffHash)
    assert.deepEqual(setup.evidence.map((item) => item.draft.kind), ['file_diff', 'file_diff'])
    assert.deepEqual(setup.evidence[0].draft.metadata, {
      paths: ['sample.txt'],
      deleted: true,
      alreadyDeleted: false,
    })

    await writeFile(join(setup.root, 'untracked.txt'), 'temporary\n', 'utf8')
    await assert.rejects(
      deleteFile.execute(
        { path: 'untracked.txt' },
        { request: request('file.delete', { path: 'untracked.txt' }, 'call_delete_untracked') },
      ),
      /Only tracked files can be deleted/,
    )
    await assert.rejects(
      deleteFile.execute(
        { path: '../outside.txt' },
        { request: request('file.delete', { path: '../outside.txt' }, 'call_delete_escape') },
      ),
      /unsafe path/,
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('test tool executes only an exact allowlisted argv and records test evidence', async () => {
  const setup = await fixture()
  try {
    const run = setup.handlers.get('test.run')
    const result = await run.execute(
      { command: setup.command, timeoutMs: 10_000 },
      { request: request('test.run', { command: setup.command, timeoutMs: 10_000 }, 'call_tests') },
    )
    assert.equal(result.output.passed, true)
    assert.equal(result.output.stdout, 'tests ok\n')
    assert.equal(result.evidence[0].kind, 'test_run')
    assert.deepEqual(result.evidence.map((item) => item.kind), ['test_run', 'command_result'])
    assert.equal(setup.evidence[0].draft.metadata.headCommit, setup.worktree.baseCommit)
    assert.match(setup.evidence[0].draft.metadata.treeHash, /^[0-9a-f]{40}$/)
    assert.equal(setup.evidence[0].draft.metadata.clean, true)
    assert.equal(setup.evidence[0].draft.metadata.stable, true)
    assert.equal(setup.evidence[0].draft.metadata.sandboxMode, 'trusted_process')
    assert.equal(setup.evidence[0].draft.metadata.networkMode, 'host')
    assert.match(setup.evidence[0].draft.metadata.stateHash, /^[0-9a-f]{64}$/)

    await writeFile(join(setup.root, 'sample.txt'), 'dirty before test\n', 'utf8')
    await run.execute(
      { command: setup.command, timeoutMs: 10_000 },
      { request: request('test.run', { command: setup.command, timeoutMs: 10_000 }, 'call_dirty_tests') },
    )
    assert.equal(setup.evidence[2].draft.metadata.clean, false)
    assert.equal(setup.evidence[2].draft.metadata.stable, true)

    await assert.rejects(
      run.execute(
        { command: ['/bin/echo', 'not allowlisted'], timeoutMs: 10_000 },
        { request: request('test.run', {}, 'call_denied') },
      ),
      /not in the workspace allowlist/,
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('Bubblewrap test invocation mounts only runtime roots and the Task Worktree', () => {
  const policy = {
    mode: 'bubblewrap', network: 'none',
    maxProcesses: 64, maxOpenFiles: 512, maxFileSizeMb: 128,
  }
  const invocation = buildBubblewrapTestInvocation({
    root: '/srv/runguild/task-1',
    command: ['npm', 'test'],
    timeoutMs: 25_000,
    policy,
  })
  assert.equal(invocation.command[0], '/usr/bin/bwrap')
  assert.equal(invocation.cwd, '/srv/runguild/task-1')
  assert.equal(invocation.command.includes('--unshare-net'), true)
  assert.equal(invocation.command.includes('--clearenv'), true)
  assert.equal(invocation.command.join(' ').includes('--ro-bind / /'), false)
  assert.equal(invocation.command.join(' ').includes('--bind /srv/runguild/task-1 /workspace'), true)
  assert.equal(invocation.command.join(' ').includes('--cpu=30:30'), true)
  assert.equal(invocation.command.join(' ').endsWith('-- npm test'), true)

  const hostNetwork = buildBubblewrapTestInvocation({
    root: '/srv/runguild/task-1', command: ['npm', 'test'], timeoutMs: 25_000,
    policy: { ...policy, network: 'host' },
  })
  assert.equal(hostNetwork.command.includes('--unshare-net'), false)
})

test('protected acceptance tests cannot be patched and a mutating zero-exit test is failed', async () => {
  const command = ['/bin/sh', '-c', 'printf "tampered\\n" > sample.txt']
  const setup = await fixture({ command, protectedTestPaths: ['sample.txt'] })
  try {
    const patch = setup.handlers.get('file.patch')
    const unifiedDiff = [
      'diff --git a/sample.txt b/sample.txt',
      '--- a/sample.txt',
      '+++ b/sample.txt',
      '@@ -1,2 +1,2 @@',
      '-alpha',
      '+forged test',
      ' second line',
      '',
    ].join('\n')
    await assert.rejects(
      patch.execute(
        { path: 'sample.txt', unifiedDiff },
        { request: request('file.patch', { path: 'sample.txt', unifiedDiff }, 'call_protected_patch') },
      ),
      /cannot modify protected acceptance test path/,
    )
    assert.equal(await readFile(join(setup.root, 'sample.txt'), 'utf8'), 'alpha\nsecond line\n')

    const result = await setup.handlers.get('test.run').execute(
      { command, timeoutMs: 10_000 },
      { request: request('test.run', { command, timeoutMs: 10_000 }, 'call_mutating_test') },
    )
    assert.equal(result.output.exitCode, 0)
    assert.equal(result.output.passed, false)
    assert.equal(setup.evidence[0].draft.metadata.stable, false)
    assert.equal(setup.evidence[0].draft.metadata.protectedTestsIntact, false)
    assert.match(setup.evidence[0].draft.metadata.protectedTestIntegrityError, /changed/)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('repository status, diff, and commit stay on the assigned Task branch and emit exact evidence', async () => {
  const setup = await fixture()
  try {
    await writeFile(join(setup.root, 'sample.txt'), 'changed\nsecond line\n', 'utf8')
    const status = setup.handlers.get('repo.status')
    const diff = setup.handlers.get('repo.diff')
    const commit = setup.handlers.get('repo.commit')
    const dirty = await status.execute({}, {
      request: request('repo.status', {}, 'call_status_dirty'),
    })
    assert.equal(dirty.output.branch, 'main')
    assert.equal(dirty.output.clean, false)
    assert.equal(dirty.output.entries.some((entry) => entry.includes('sample.txt')), true)

    const preview = await diff.execute({}, {
      request: request('repo.diff', {}, 'call_diff'),
    })
    assert.equal(preview.output.diff.includes('-alpha'), true)
    assert.equal(preview.output.truncated, false)

    const committed = await commit.execute({ message: 'Implement Task change' }, {
      request: request('repo.commit', { message: 'Implement Task change' }, 'call_commit'),
    })
    assert.equal(committed.output.committed, true)
    assert.match(committed.output.commit, /^[0-9a-f]{40}$/)
    assert.equal(setup.worktree.status, 'committed')
    assert.equal(setup.worktree.headCommit, committed.output.commit)
    assert.equal(committed.sideEffects[0].type, 'repo.committed')
    assert.equal(committed.evidence[0].kind, 'file_diff')
    assert.match(setup.evidence.at(-1).draft.metadata.diff, /-alpha/)
    assert.match(setup.evidence.at(-1).draft.metadata.diff, /\+changed/)
    assert.equal(
      (await execute('git', ['-C', setup.root, 'log', '-1', '--pretty=%s'])).stdout.trim(),
      'Implement Task change',
    )

    const clean = await status.execute({}, {
      request: request('repo.status', {}, 'call_status_clean'),
    })
    assert.equal(clean.output.clean, true)
    const replay = await commit.execute({ message: 'No duplicate commit' }, {
      request: request('repo.commit', { message: 'No duplicate commit' }, 'call_commit_replay'),
    })
    assert.equal(replay.output.committed, false)
    assert.equal(replay.output.commit, committed.output.commit)
    assert.equal(replay.evidence[0].kind, 'file_diff')
    assert.equal(setup.evidence.at(-1).draft.metadata.commit, committed.output.commit)
    assert.equal(setup.evidence.at(-1).draft.metadata.recovered, true)
    assert.match(setup.evidence.at(-1).draft.metadata.diff, /\+changed/)

    await writeFile(join(setup.root, 'sample.txt'), 'changed\nsecond line\nthird line\n', 'utf8')
    const followup = await commit.execute({ message: 'Address review feedback' }, {
      request: request('repo.commit', { message: 'Address review feedback' }, 'call_commit_followup'),
    })
    assert.equal(followup.output.committed, true)
    assert.match(setup.evidence.at(-1).draft.metadata.diff, /-alpha/)
    assert.match(setup.evidence.at(-1).draft.metadata.diff, /\+third line/)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('repository commit finalizes a clean unchanged Worktree without inventing a commit', async () => {
  const setup = await fixture()
  try {
    const commit = setup.handlers.get('repo.commit')
    const unchanged = await commit.execute({ message: 'No changes required' }, {
      request: request('repo.commit', { message: 'No changes required' }, 'call_commit_unchanged'),
    })
    assert.equal(unchanged.output.committed, false)
    assert.equal(unchanged.output.commit, setup.worktree.baseCommit)
    assert.equal(setup.worktree.status, 'integrated')
    assert.equal(setup.worktree.integratedCommit, setup.worktree.baseCommit)
    assert.equal((await execute('git', ['-C', setup.root, 'rev-list', '--count', 'HEAD'])).stdout.trim(), '1')
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('repository commit restores the index when staged evidence exceeds its size limit', async () => {
  const setup = await fixture()
  try {
    await writeFile(join(setup.root, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1024), 'utf8')
    const commit = setup.handlers.get('repo.commit')
    await assert.rejects(
      commit.execute(
        { message: 'Do not commit oversized evidence' },
        { request: request('repo.commit', {}, 'call_commit_oversized') },
      ),
      /Staged diff exceeds the 2 MiB evidence limit/,
    )
    const staged = await execute('git', ['-C', setup.root, 'diff', '--cached', '--name-only'])
    assert.equal(staged.stdout, '')
    assert.equal(await readFile(join(setup.root, 'large.txt'), 'utf8'), 'x'.repeat(2 * 1024 * 1024 + 1024))
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('Integration resolution evidence is based on the reconciled current branch, not the stale Task base', async () => {
  const setup = await fixture()
  try {
    const originalBase = setup.worktree.baseCommit
    await writeFile(join(setup.root, 'sample.txt'), 'reviewed Task change\n', 'utf8')
    await execute('git', ['-C', setup.root, 'add', 'sample.txt'])
    await execute('git', [
      '-C', setup.root,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'old reviewed task',
    ])
    const oldTaskHead = (await execute('git', ['-C', setup.root, 'rev-parse', 'HEAD'])).stdout.trim()
    await execute('git', ['-C', setup.root, 'switch', '-c', 'current-base', originalBase])
    await writeFile(join(setup.root, 'platform.txt'), 'current platform\n', 'utf8')
    await execute('git', ['-C', setup.root, 'add', 'platform.txt'])
    await execute('git', [
      '-C', setup.root,
      '-c', 'user.name=RunGuild',
      '-c', 'user.email=runguild@example.invalid',
      'commit', '-m', 'advance platform',
    ])
    const currentBase = (await execute('git', ['-C', setup.root, 'rev-parse', 'HEAD'])).stdout.trim()
    await execute('git', ['-C', setup.root, 'switch', 'main'])
    await execute('git', ['-C', setup.root, 'merge', '--no-ff', '--no-commit', 'current-base'])
    setup.setWorktree({
      ...setup.worktree,
      status: 'ready',
      headCommit: oldTaskHead,
      reconciliationBaseCommit: currentBase,
      lastError: { code: 'worktree_integration_conflict' },
    })

    const committed = await setup.handlers.get('repo.commit').execute(
      { message: 'Resolve Integration conflict' },
      { request: request('repo.commit', {}, 'call_reconcile_commit') },
    )
    assert.equal(committed.output.committed, true)
    assert.equal(setup.worktree.baseCommit, currentBase)
    assert.equal(setup.worktree.reconciliationBaseCommit, undefined)
    const parents = (await execute(
      'git', ['-C', setup.root, 'rev-list', '--parents', '-n', '1', committed.output.commit],
    )).stdout.trim().split(' ')
    assert.deepEqual(parents, [committed.output.commit, oldTaskHead, currentBase])
    const exactDiff = setup.evidence.at(-1).draft.metadata.diff
    assert.match(exactDiff, /reviewed Task change/)
    assert.doesNotMatch(exactDiff, /platform\.txt/)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('repository commit rejects dependency links outside the Task Worktree and restores the index', async () => {
  const setup = await fixture()
  try {
    await symlink('/tmp/shared-node_modules', join(setup.root, 'node_modules'))
    const commit = setup.handlers.get('repo.commit')
    await assert.rejects(
      commit.execute({ message: 'Do not commit dependency mount' }, {
        request: request('repo.commit', { message: 'Do not commit dependency mount' }, 'call_commit_external_link'),
      }),
      /relative in-Worktree target/,
    )
    assert.equal(
      (await execute('git', ['-C', setup.root, 'diff', '--cached', '--name-only'])).stdout,
      '',
    )
    assert.equal(
      (await execute('git', ['-C', setup.root, 'rev-parse', 'HEAD'])).stdout.trim(),
      setup.worktree.baseCommit,
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('repository commit permits a relative symlink whose target resolves inside the Task Worktree', async () => {
  const setup = await fixture()
  try {
    await symlink('sample.txt', join(setup.root, 'sample-link.txt'))
    const committed = await setup.handlers.get('repo.commit').execute({ message: 'Add internal link' }, {
      request: request('repo.commit', { message: 'Add internal link' }, 'call_commit_internal_link'),
    })
    assert.equal(committed.output.committed, true)
    assert.equal(
      (await execute('git', ['-C', setup.root, 'show', 'HEAD:sample-link.txt'])).stdout,
      'sample.txt',
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

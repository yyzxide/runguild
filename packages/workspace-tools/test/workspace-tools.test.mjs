import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { createWorkspaceToolHandlers } from '../dist/index.js'

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mission-workspace-tools-'))
  await writeFile(join(root, 'sample.txt'), 'alpha\nsecond line\n', 'utf8')
  await execute('git', ['init', root])
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
  const command = ['/bin/echo', 'tests ok']
  const handlers = await createWorkspaceToolHandlers({
    root,
    allowedTestCommands: [command],
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
        worktree = { ...worktree, status: 'committed', headCommit: input.headCommit }
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
      '@@ -1,99 +1,101 @@',
      '-beta',
      '+gamma',
      ' second line',
      '',
    ].join('\n')
    await patch.execute(
      { path: 'sample.txt', unifiedDiff: wrongCounts },
      { request: request('file.patch', { path: 'sample.txt', unifiedDiff: wrongCounts }, 'call_counts') },
    )
    assert.equal(await readFile(join(setup.root, 'sample.txt'), 'utf8'), 'gamma\nsecond line\n')
    assert.equal(setup.evidence[2].draft.metadata.normalizedHunkCounts, true)

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

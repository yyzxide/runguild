import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executeWorktreeSetupCommands } from '../dist/index.js'

test('Worktree setup runs exact argv sequentially and stores hashes instead of command output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runguild-worktree-setup-'))
  try {
    const first = [process.execPath, '-e', "require('node:fs').writeFileSync('prepared.txt','ready')"]
    const second = [process.execPath, '-e', "if(require('node:fs').readFileSync('prepared.txt','utf8')!=='ready')process.exit(7)"]
    const result = await executeWorktreeSetupCommands({ root, commands: [first, second], timeoutMs: 10_000 })
    assert.equal(result.passed, true)
    assert.equal(await readFile(join(root, 'prepared.txt'), 'utf8'), 'ready')
    assert.deepEqual(result.results.map((item) => item.argv), [first, second])
    assert.equal(result.results.every((item) => /^[0-9a-f]{64}$/.test(item.stdoutHash)), true)
    assert.equal('stdout' in result.results[0], false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Worktree setup stops on the first failure and does not execute later argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runguild-worktree-setup-failure-'))
  try {
    const failed = [process.execPath, '-e', 'process.exit(9)']
    const forbidden = [process.execPath, '-e', "require('node:fs').writeFileSync('should-not-exist','bad')"]
    const result = await executeWorktreeSetupCommands({ root, commands: [failed, forbidden], timeoutMs: 10_000 })
    assert.equal(result.passed, false)
    assert.equal(result.failure.code, 'exit_nonzero')
    assert.equal(result.failure.exitCode, 9)
    assert.equal(result.results.length, 1)
    await assert.rejects(readFile(join(root, 'should-not-exist')), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

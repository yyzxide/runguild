import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const materializer = join(repositoryRoot, 'scripts', 'materialize-evaluation-target.mjs')
const liveHarness = join(repositoryRoot, 'scripts', 'run-live-evaluation.mjs')
const families = ['local-bug', 'api-implementation', 'cross-module']

function run(command, args, cwd) {
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  return spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('bounded evaluation fixtures materialize as clean intentionally failing baselines', (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'runguild-evaluation-targets-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))

  for (const family of families) {
    const destination = join(temporaryRoot, family)
    const materialized = run(process.execPath, [materializer, family, destination], repositoryRoot)
    assert.equal(materialized.status, 0, materialized.stderr)

    const revision = run('git', ['rev-parse', 'HEAD'], destination)
    assert.equal(revision.status, 0, revision.stderr)
    assert.match(revision.stdout.trim(), /^[0-9a-f]{40}$/)
    assert.equal(run('git', ['status', '--porcelain'], destination).stdout, '')
    assert.equal(
      run('git', ['ls-files', '--error-unmatch', 'test/acceptance.test.mjs'], destination).status,
      0,
    )

    const typecheck = run('npm', ['run', 'typecheck'], destination)
    assert.equal(typecheck.status, 0, typecheck.stderr)
    const smoke = run(process.execPath, ['--test', 'test/smoke.test.mjs'], destination)
    assert.equal(smoke.status, 0, `${family} public smoke must pass at baseline`)
    const acceptance = run(process.execPath, ['--test', 'test/acceptance.test.mjs'], destination)
    assert.equal(acceptance.status, 1, `${family} must start with an unmet acceptance contract`)
  }
})

test('live harness exposes and validates bounded variant and policy-probe options', () => {
  const help = run(process.execPath, [liveHarness, '--help'], repositoryRoot)
  assert.equal(help.status, 0, help.stderr)

  const invalid = run(process.execPath, [
    liveHarness,
    '--family', 'local-bug',
    '--target', '/tmp/runguild-invalid-target',
    '--worktree-root', '/tmp/runguild-invalid-worktrees',
    '--output', '/tmp/runguild-invalid-evidence.json',
    '--variants', 'single_agent,single_agent',
  ], repositoryRoot)
  assert.equal(invalid.status, 1)
})

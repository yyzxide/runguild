import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const GOAL_SMOKE_GOAL = 'Implement normalizeLabels(values) in src/labels.mjs. Accept only arrays of strings; throw TypeError for non-arrays or arrays containing any non-string. Trim and lowercase each string, discard empty results, and remove duplicates while preserving first-occurrence order. Return a new array without modifying the input. Add regression tests and verify the completed implementation.'

export const GOAL_SMOKE_CRITERIA = Object.freeze([
  'normalizeLabels is a named export from src/labels.mjs and returns an array.',
  'Only arrays of strings are accepted. Non-arrays and any non-string array element cause TypeError. Every numeric index from 0 through length - 1 must be an own property; a missing own slot causes TypeError even when the prototype provides a string at that index, including for frozen arrays.',
  'Strings are trimmed and lowercased; empty and whitespace-only strings are discarded.',
  'Duplicates after normalization are removed, preserving the first occurrence order.',
  'Input arrays are not mutated, frozen arrays are supported, and the returned array is a new array.',
  'Regression tests cover valid inputs, invalid inputs, normalization, deduplication, ordering, and input preservation; npm test passes.',
])

export const GOAL_SMOKE_CONTRACT = Object.freeze({
  goal: GOAL_SMOKE_GOAL,
  acceptanceCriteria: GOAL_SMOKE_CRITERIA,
  constraints: Object.freeze([
    'Use the existing dependency-free ESM repository and the Node built-in test runner.',
    'Keep the named export and file path stable. Do not add npm dependencies.',
    'Research notes must accurately distinguish array-hole behavior. For ordinary holes with no inherited indexed property, for...of and array spread yield undefined, while map, forEach, and filter skip the absent indices without invoking their callbacks. Explain inherited indexed properties separately rather than treating all iteration methods as hole-skipping.',
  ]),
})

/** Seed only a new or empty directory; never overwrite an existing repository. */
export async function createGoalSmokeFixture(directory) {
  const repoDir = resolve(directory)
  await mkdir(repoDir, { recursive: true })
  const stat = await lstat(repoDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Goal smoke fixture requires a real directory: ' + repoDir)
  }
  if ((await readdir(repoDir)).length !== 0) {
    throw new Error('Goal smoke fixture refuses a non-empty directory: ' + repoDir)
  }
  await mkdir(resolve(repoDir, 'src'))
  await mkdir(resolve(repoDir, 'test'))
  const files = {
    'package.json': JSON.stringify({
      name: 'runguild-goal-smoke',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { test: 'node --test' },
      engines: { node: '>=22' },
    }, null, 2) + '\n',
    'src/labels.mjs': 'export function normalizeLabels(values) {\n  return []\n}\n',
    'test/labels.test.mjs': [
      "import assert from 'node:assert/strict'",
      "import test from 'node:test'",
      "import { normalizeLabels } from '../src/labels.mjs'",
      '',
      "test('normalizes an empty array', () => {",
      '  assert.deepEqual(normalizeLabels([]), [])',
      '})',
      '',
    ].join('\n'),
    'README.md': [
      '# Goal smoke fixture',
      '',
      'This is a small dependency-free ESM repository for a bounded RunGuild Goal.',
      'The initial implementation is intentionally incomplete. The baseline test only checks an empty array.',
      '',
      '## Requested change',
      '',
      GOAL_SMOKE_GOAL,
      '',
      '## Acceptance criteria',
      '',
      ...GOAL_SMOKE_CRITERIA.map((criterion) => '- ' + criterion),
      '',
      '## Constraints and verification',
      '',
      ...GOAL_SMOKE_CONTRACT.constraints.map((constraint) => '- ' + constraint),
      '- Run `npm test`. No install step or network access is needed.',
      '- Keep changes within this small implementation, its tests, and useful documentation.',
      '- The run operator also checks the final implementation with a host-controlled oracle outside this repository.',
      '- Report the exact checks and results; passing the original empty-array test alone does not satisfy the Goal.',
      '',
    ].join('\n'),
  }
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(resolve(repoDir, name), contents, { encoding: 'utf8', flag: 'wx' })
  }
  return Object.freeze({
    repoDir,
    contract: GOAL_SMOKE_CONTRACT,
    testCommand: Object.freeze(['npm', 'test']),
    files: Object.freeze(Object.keys(files)),
  })
}

const CHECK_NAMES = Object.freeze([
  'named function export',
  'empty array returns a new array',
  'trim, lowercase, and discard blanks',
  'deduplicate normalized labels in first occurrence order',
  'preserve input array and support frozen input',
  'reject non-array inputs with TypeError',
  'reject non-string elements with TypeError',
  'reject sparse arrays with TypeError',
  'reject inherited strings masking missing own slots, including frozen arrays',
])

// This program is passed directly to the host Node process. It is never written
// into the repository that the Agent can modify. This is an independent smoke
// oracle, not an OS sandbox or a general-purpose business acceptance framework.
const ORACLE_SOURCE = String.raw`
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

const checks = []
const expectedCheckNames = ${JSON.stringify(CHECK_NAMES)}
function check(name, run) {
  try {
    run()
    checks.push({ name, passed: true })
  } catch (error) {
    checks.push({ name, passed: false, error: String(error?.stack ?? error) })
  }
}
try {
  const { normalizeLabels } = await import(process.argv[1])
  check('named function export', () => assert.equal(typeof normalizeLabels, 'function'))
  check('empty array returns a new array', () => {
    const input = []
    const result = normalizeLabels(input)
    assert.deepEqual(result, [])
    assert.notEqual(result, input)
  })
  check('trim, lowercase, and discard blanks', () => {
    assert.deepEqual(normalizeLabels([' Alpha ', '', ' \t\n ', 'BETA', '\tGamma\n']), ['alpha', 'beta', 'gamma'])
  })
  check('deduplicate normalized labels in first occurrence order', () => {
    assert.deepEqual(normalizeLabels([' Z ', 'alpha', 'z', ' BETA ', 'ALPHA', 'beta', ' c ']), ['z', 'alpha', 'beta', 'c'])
  })
  check('preserve input array and support frozen input', () => {
    const input = [' B ', 'a', ' B ', ' ']
    const before = [...input]
    const result = normalizeLabels(input)
    assert.deepEqual(input, before)
    assert.notEqual(result, input)
    assert.deepEqual(result, ['b', 'a'])
    assert.deepEqual(normalizeLabels(Object.freeze([' C ', 'c', ' D '])), ['c', 'd'])
  })
  check('reject non-array inputs with TypeError', () => {
    for (const value of [undefined, null, 'label', 42, true, {}, new Set(['label']), { 0: 'label', length: 1 }]) {
      assert.throws(() => normalizeLabels(value), TypeError)
    }
  })
  check('reject non-string elements with TypeError', () => {
    for (const value of [undefined, null, 42, false, {}, [], new String('label')]) {
      assert.throws(() => normalizeLabels(['valid', value]), TypeError)
    }
  })
  check('reject sparse arrays with TypeError', () => {
    assert.throws(() => normalizeLabels(new Array(1)), TypeError)
    const sparse = ['valid']
    sparse.length = 3
    assert.throws(() => normalizeLabels(sparse), TypeError)
  })
  check('reject inherited strings masking missing own slots, including frozen arrays', () => {
    for (const frozen of [false, true]) {
      const input = new Array(1)
      const prototype = Object.create(Array.prototype)
      Object.defineProperty(prototype, '0', { value: ' Inherited ', enumerable: true })
      Object.setPrototypeOf(input, prototype)
      if (frozen) Object.freeze(input)
      assert.equal(Array.isArray(input), true)
      assert.equal(Object.hasOwn(input, 0), false)
      assert.equal(0 in input, true)
      assert.throws(() => normalizeLabels(input), TypeError,
        'A missing own slot must be rejected even when a prototype supplies a string; frozen=' + frozen)
    }
  })
} catch (error) {
  checks.push({ name: 'load implementation', passed: false, error: String(error?.stack ?? error) })
}
const report = {
  passed: checks.length === expectedCheckNames.length
    && checks.every((check, index) => check.passed && check.name === expectedCheckNames[index]),
  checks,
}
writeFileSync(3, JSON.stringify(report))
process.exitCode = report.passed ? 0 : 1
`

/** Run the fixed oracle against the final repository implementation. */
export async function verifyGoalSmokeResult(directory) {
  const repoDir = resolve(directory)
  const entry = pathToFileURL(resolve(repoDir, 'src/labels.mjs')).href
  const child = spawn(process.execPath, ['--input-type=module', '--eval', ORACLE_SOURCE, entry], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  const chunks = ['', '', '']
  let outputBytes = 0
  let timedOut = false
  let outputLimitExceeded = false
  let processError
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 15_000)
  for (const [index, stream] of [child.stdout, child.stderr, child.stdio[3]].entries()) {
    stream.setEncoding('utf8')
    stream.on('data', (data) => {
      outputBytes += Buffer.byteLength(data)
      if (outputBytes > 256 * 1024) {
        outputLimitExceeded = true
        child.kill('SIGKILL')
        return
      }
      chunks[index] += data
    })
  }
  child.on('error', (error) => { processError = error.message })
  const outcome = await new Promise((done) => {
    child.on('close', (exitCode, signal) => done({ exitCode, signal }))
  })
  clearTimeout(timer)
  let report
  let reportError
  try {
    report = JSON.parse(chunks[2])
    if (!Array.isArray(report.checks) || report.checks.some((check) =>
      typeof check?.name !== 'string' || typeof check?.passed !== 'boolean')) {
      throw new Error('Invalid oracle check report')
    }
  } catch (error) {
    report = undefined
    reportError = 'Oracle did not return a valid complete report: ' + error.message
  }
  const complete = report?.checks.length === CHECK_NAMES.length
    && report.checks.every((check, index) => check.name === CHECK_NAMES[index] && check.passed)
  return {
    passed: outcome.exitCode === 0 && outcome.signal === null && !processError
      && !timedOut && !outputLimitExceeded && report?.passed === true && complete === true,
    checks: report?.checks ?? [],
    ...outcome,
    timedOut,
    outputLimitExceeded,
    stdout: chunks[0],
    stderr: chunks[1],
    ...(processError ? { processError } : {}),
    ...(reportError ? { reportError } : {}),
  }
}

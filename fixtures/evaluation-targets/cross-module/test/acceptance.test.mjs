import assert from 'node:assert/strict'
import test from 'node:test'
import { parseExecutionPolicy } from '../src/config.mjs'
import { buildRunReport } from '../src/report.mjs'

test('parses a bounded failure budget with a zero default', () => {
  assert.deepEqual(parseExecutionPolicy({ maxAttempts: 3 }), {
    maxAttempts: 3,
    maxFailures: 0,
  })
  assert.deepEqual(parseExecutionPolicy({ maxAttempts: 4, maxFailures: 2 }), {
    maxAttempts: 4,
    maxFailures: 2,
  })
  assert.throws(() => parseExecutionPolicy({ maxAttempts: 2, maxFailures: 2 }), TypeError)
  assert.throws(() => parseExecutionPolicy({ maxAttempts: 3, maxFailures: -1 }), TypeError)
})

test('reports pass, retry, and exhausted failure-budget states', () => {
  const policy = parseExecutionPolicy({ maxAttempts: 4, maxFailures: 2 })
  assert.deepEqual(buildRunReport(policy, [{ passed: false }, { passed: false }]), {
    status: 'retry_allowed',
    attemptsUsed: 2,
    failures: 2,
    remainingFailureBudget: 0,
  })
  assert.equal(
    buildRunReport(policy, [{ passed: false }, { passed: false }, { passed: false }]).status,
    'failed',
  )
  assert.equal(buildRunReport(policy, [{ passed: false }, { passed: true }]).status, 'passed')
})

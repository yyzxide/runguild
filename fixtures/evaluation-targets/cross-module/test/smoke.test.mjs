import assert from 'node:assert/strict'
import test from 'node:test'
import { parseExecutionPolicy } from '../src/config.mjs'
import { buildRunReport } from '../src/report.mjs'

test('retains the existing max-attempt and pass behavior', () => {
  const policy = parseExecutionPolicy({ maxAttempts: 3 })
  assert.equal(policy.maxAttempts, 3)
  assert.equal(buildRunReport(policy, [{ passed: true }]).status, 'passed')
})

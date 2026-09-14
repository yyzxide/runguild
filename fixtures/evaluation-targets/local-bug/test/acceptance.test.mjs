import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTags } from '../src/tags.mjs'

test('normalizes, filters, deduplicates, and preserves first-seen order', () => {
  assert.deepEqual(
    normalizeTags([' Beta ', 'ALPHA', 'beta', ' ', 'Gamma', 'alpha']),
    ['beta', 'alpha', 'gamma'],
  )
})

test('rejects invalid containers and elements', () => {
  assert.throws(() => normalizeTags('alpha'), TypeError)
  assert.throws(() => normalizeTags(['alpha', 7]), TypeError)
})

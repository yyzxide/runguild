import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTags } from '../src/tags.mjs'

test('normalizes simple unique tags', () => {
  assert.deepEqual(normalizeTags(['alpha', 'Beta']), ['alpha', 'beta'])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalJson } from '../dist/index.js'

test('canonical JSON is stable across object key order', () => {
  assert.equal(
    canonicalJson({ z: 1, nested: { b: 2, a: 1 } }),
    canonicalJson({ nested: { a: 1, b: 2 }, z: 1 }),
  )
})

test('canonical JSON rejects non-finite and cyclic values', () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite/)
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalJson(cyclic), /Cyclic/)
})

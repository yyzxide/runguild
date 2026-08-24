import assert from 'node:assert/strict'
import test from 'node:test'

import { DeterministicContextBuilder } from '../dist/index.js'

const tools = [{
  action: 'repo.search',
  description: 'Search the assigned repository.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
}]

test('Context Builder preserves the complete transcript when it fits and hashes deterministically', () => {
  const builder = new DeterministicContextBuilder({ tokenBudget: 4_096 })
  const input = {
    runId: 'run_context',
    hop: 1,
    tools,
    skills: [{
      skillId: 'skill_testing',
      versionId: 'skill_version_testing_1',
      name: 'Testing',
      contentHash: 'a'.repeat(64),
      estimatedTokens: 20,
      priority: 10,
    }],
    messages: [
      { role: 'system', content: 'Runtime contract.', hop: 0 },
      { role: 'user', content: 'Implement and verify.', hop: 0 },
      { role: 'assistant', content: 'I will inspect the repository.', hop: 1 },
    ],
  }
  const first = builder.build(input)
  const replay = builder.build(input)

  assert.deepEqual(replay, first)
  assert.equal(first.snapshot.content.strategy, 'full')
  assert.equal(first.snapshot.content.compacted, false)
  assert.equal(first.snapshot.content.omittedMessageCount, 0)
  assert.deepEqual(first.messages, input.messages)
  assert.match(first.snapshot.contentHash, /^[0-9a-f]{64}$/)
  assert.match(first.snapshot.id, /^context_[0-9a-f]{64}$/)
})

test('Context Builder compacts old history while preserving pinned instructions and the latest atomic tool exchange', () => {
  const builder = new DeterministicContextBuilder({ tokenBudget: 1_000, digestTokenBudget: 160 })
  const latestCall = {
    id: 'call_latest',
    action: 'repo.search',
    input: { query: 'latest fact' },
  }
  const result = builder.build({
    runId: 'run_compaction',
    hop: 8,
    tools,
    messages: [
      { role: 'system', content: 'Runtime safety contract.', hop: 0 },
      { role: 'user', content: 'Frozen mission and acceptance criteria.', hop: 0 },
      { role: 'assistant', content: 'old analysis '.repeat(800), hop: 1 },
      { role: 'user', content: 'old steering '.repeat(500), hop: 2 },
      { role: 'assistant', content: '', toolCalls: [latestCall], hop: 7 },
      { role: 'tool', toolCallId: 'call_latest', content: 'large result '.repeat(900), hop: 7 },
    ],
  })

  assert.equal(result.snapshot.content.strategy, 'deterministic_window_v1')
  assert.equal(result.snapshot.content.compacted, true)
  assert.equal(result.snapshot.content.estimatedTokens <= 1_000, true)
  assert.equal(result.snapshot.content.omittedMessageCount, 2)
  assert.equal(result.messages[0].content, 'Runtime safety contract.')
  assert.equal(result.messages[1].content, 'Frozen mission and acceptance criteria.')
  assert.match(result.messages[2].content, /Earlier durable transcript compacted deterministically/)
  assert.equal(result.messages.at(-2).toolCalls[0].id, 'call_latest')
  assert.equal(result.messages.at(-1).toolCallId, 'call_latest')
  assert.match(result.messages.at(-1).content, /contextCompacted/)
})

test('Context Builder rejects pinned instructions that cannot fit instead of silently truncating them', () => {
  const builder = new DeterministicContextBuilder({ tokenBudget: 256, digestTokenBudget: 64 })
  assert.throws(() => builder.build({
    runId: 'run_oversized',
    hop: 1,
    tools,
    messages: [
      { role: 'system', content: 'mandatory '.repeat(300), hop: 0 },
      { role: 'user', content: 'Task.', hop: 0 },
      { role: 'assistant', content: 'history', hop: 1 },
    ],
  }), /Pinned execution context/)
})

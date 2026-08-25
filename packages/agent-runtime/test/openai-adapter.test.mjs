import assert from 'node:assert/strict'
import test from 'node:test'

import { OpenAIResponsesAdapter } from '../dist/index.js'

function response(overrides = {}) {
  return {
    id: 'resp_test',
    status: 'completed',
    output_text: '',
    output: [],
    usage: {
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
    incomplete_details: null,
    ...overrides,
  }
}

function fakeClient(responses) {
  const requests = []
  return {
    requests,
    client: {
      responses: {
        async create(body, options) {
          requests.push({ body, options })
          const next = responses.shift()
          if (!next) throw new Error('No fake response')
          return next
        },
      },
    },
  }
}

test('OpenAI adapter maps protocol messages and function calls to Responses API items', async () => {
  const fake = fakeClient([response({
    id: 'resp_first',
    output: [{
      type: 'function_call',
      call_id: 'call_search',
      name: 'repo__search',
      arguments: '{"query":"runtime"}',
      status: 'completed',
    }],
  })])
  const adapter = new OpenAIResponsesAdapter({
    apiKey: '',
    model: 'model-test',
    client: fake.client,
    reasoningEffort: 'medium',
  })

  const result = await adapter.complete({
    messages: [
      { role: 'system', content: 'Follow the runtime contract.', hop: 0 },
      { role: 'user', content: 'Search the repository.', hop: 0 },
    ],
    tools: [{
      action: 'repo.search',
      description: 'Search repository text.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }],
  })

  assert.equal(fake.requests[0].body.instructions, 'Follow the runtime contract.')
  assert.deepEqual(fake.requests[0].body.input, [
    { role: 'user', content: 'Search the repository.' },
  ])
  assert.equal(fake.requests[0].body.tools[0].name, 'repo__search')
  assert.match(fake.requests[0].body.tools[0].name, /^[a-zA-Z0-9_-]+$/)
  assert.equal(fake.requests[0].body.store, true)
  assert.equal(result.providerRequestId, 'resp_first')
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.toolCalls, [{
    id: 'call_search',
    action: 'repo.search',
    input: { query: 'runtime' },
  }])
  assert.deepEqual(result.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cachedInputTokens: 3,
  })
})

test('OpenAI continuation sends only post-response tool outputs and repeats instructions', async () => {
  const fake = fakeClient([response({ id: 'resp_second', output_text: 'Continuing.' })])
  const adapter = new OpenAIResponsesAdapter({ apiKey: '', model: 'model-test', client: fake.client })

  await adapter.complete({
    messages: [
      { role: 'system', content: 'Persistent system instruction.', hop: 0 },
      { role: 'user', content: 'Original request.', hop: 0 },
      {
        role: 'assistant',
        content: '',
        hop: 1,
        toolCalls: [{ id: 'call_one', action: 'repo.search', input: { query: 'one' } }],
      },
      { role: 'tool', toolCallId: 'call_one', content: '{"status":"succeeded"}', hop: 1 },
      { role: 'user', content: '[Steering] Check tests too.', hop: 1 },
    ],
    tools: [],
    continuation: {
      provider: 'openai',
      model: 'model-test',
      responseId: 'resp_first',
      hop: 1,
    },
  })

  assert.equal(fake.requests[0].body.previous_response_id, 'resp_first')
  assert.equal(fake.requests[0].body.instructions, 'Persistent system instruction.')
  assert.deepEqual(fake.requests[0].body.input, [
    { type: 'function_call_output', call_id: 'call_one', output: '{"status":"succeeded"}' },
    { role: 'user', content: '[Steering] Check tests too.' },
  ])
})

test('OpenAI adapter rejects malformed function arguments before the Runtime sees them', async () => {
  const fake = fakeClient([response({
    output: [{
      type: 'function_call',
      call_id: 'call_bad',
      name: 'repo__search',
      arguments: '{bad json',
      status: 'completed',
    }],
  })])
  const adapter = new OpenAIResponsesAdapter({ apiKey: '', model: 'model-test', client: fake.client })

  await assert.rejects(
    adapter.complete({
      messages: [],
      tools: [{
        action: 'repo.search',
        description: 'Search repository text.',
        inputSchema: { type: 'object' },
      }],
    }),
    /invalid JSON arguments/,
  )
})

test('OpenAI adapter rejects provider function names that are not declared by the Runtime', async () => {
  const fake = fakeClient([response({
    output: [{
      type: 'function_call',
      call_id: 'call_unknown',
      name: 'unknown_tool',
      arguments: '{}',
      status: 'completed',
    }],
  })])
  const adapter = new OpenAIResponsesAdapter({ apiKey: '', model: 'model-test', client: fake.client })

  await assert.rejects(
    adapter.complete({ messages: [], tools: [] }),
    /unknown function name/,
  )
})

test('OpenAI adapter rejects ambiguous function-name encodings before calling the provider', async () => {
  const fake = fakeClient([])
  const adapter = new OpenAIResponsesAdapter({ apiKey: '', model: 'model-test', client: fake.client })

  await assert.rejects(
    adapter.complete({
      messages: [],
      tools: [
        { action: 'repo.search', description: 'First.', inputSchema: { type: 'object' } },
        { action: 'repo__search', description: 'Second.', inputSchema: { type: 'object' } },
      ],
    }),
    /collide after OpenAI function-name encoding/,
  )
  assert.equal(fake.requests.length, 0)
})

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
  assert.equal(fake.requests[0].body.tool_choice, 'auto')
  assert.equal(fake.requests[0].body.parallel_tool_calls, true)
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

test('OpenAI adapter can require non-thinking one-at-a-time structured control-plane output', async () => {
  const fake = fakeClient([response({ id: 'resp_required' })])
  const adapter = new OpenAIResponsesAdapter({
    apiKey: '', model: 'model-test', client: fake.client, reasoningEffort: 'medium',
  })

  await adapter.complete({
    messages: [{ role: 'user', content: 'Return a structured decision.' }],
    tools: [{
      action: 'review.submit_decision',
      description: 'Submit one decision.',
      inputSchema: { type: 'object' },
    }],
    toolChoice: 'required',
    parallelToolCalls: false,
    reasoningEffort: 'none',
  })

  assert.equal(fake.requests[0].body.tool_choice, 'required')
  assert.equal(fake.requests[0].body.parallel_tool_calls, false)
  assert.deepEqual(fake.requests[0].body.reasoning, { effort: 'none' })
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

test('OpenAI-compatible custom endpoints replay complete tool history instead of assuming stateful responses', async () => {
  const fake = fakeClient([response({ id: 'resp_second', output_text: 'Continuing.' })])
  const adapter = new OpenAIResponsesAdapter({
    apiKey: '',
    model: 'compatible-model',
    baseURL: 'https://compatible.example.test',
    client: fake.client,
  })

  await adapter.complete({
    messages: [
      { role: 'system', content: 'Persistent system instruction.', hop: 0 },
      { role: 'user', content: 'Original request.', hop: 0 },
      {
        role: 'assistant',
        content: '',
        hop: 1,
        toolCalls: [
          { id: 'call_one', action: 'repo.search', input: { query: 'one' } },
          { id: 'call_two', action: 'repo.status', input: {} },
        ],
      },
      { role: 'tool', toolCallId: 'call_one', content: '{"matches":[]}', hop: 1 },
      { role: 'tool', toolCallId: 'call_two', content: '{"clean":true}', hop: 1 },
    ],
    tools: [
      { action: 'repo.search', description: 'Search.', inputSchema: { type: 'object' } },
      { action: 'repo.status', description: 'Status.', inputSchema: { type: 'object' } },
    ],
    continuation: {
      provider: 'openai',
      model: 'compatible-model',
      responseId: 'resp_first',
      hop: 1,
    },
  })

  assert.equal(fake.requests[0].body.previous_response_id, undefined)
  assert.deepEqual(fake.requests[0].body.input, [
    { role: 'user', content: 'Original request.' },
    {
      type: 'function_call',
      call_id: 'call_one',
      name: 'repo__search',
      arguments: '{"query":"one"}',
    },
    {
      type: 'function_call',
      call_id: 'call_two',
      name: 'repo__status',
      arguments: '{}',
    },
    { type: 'function_call_output', call_id: 'call_one', output: '{"matches":[]}' },
    { type: 'function_call_output', call_id: 'call_two', output: '{"clean":true}' },
  ])
})

test('custom endpoint continuation can be explicitly enabled for a stateful proxy', async () => {
  const fake = fakeClient([response({ id: 'resp_second', output_text: 'Continuing.' })])
  const adapter = new OpenAIResponsesAdapter({
    apiKey: '',
    model: 'proxy-model',
    baseURL: 'https://stateful-proxy.example.test',
    usePreviousResponseId: true,
    client: fake.client,
  })

  await adapter.complete({
    messages: [
      { role: 'user', content: 'Original request.', hop: 0 },
      {
        role: 'assistant',
        content: '',
        hop: 1,
        toolCalls: [{ id: 'call_one', action: 'repo.search', input: { query: 'one' } }],
      },
      { role: 'tool', toolCallId: 'call_one', content: '{"matches":[]}', hop: 1 },
    ],
    tools: [],
    continuation: {
      provider: 'openai',
      model: 'proxy-model',
      responseId: 'resp_first',
      hop: 1,
    },
  })

  assert.equal(fake.requests[0].body.previous_response_id, 'resp_first')
  assert.deepEqual(fake.requests[0].body.input, [
    { type: 'function_call_output', call_id: 'call_one', output: '{"matches":[]}' },
  ])
})

test('OpenAI adapter returns a redacted protocol error for malformed function arguments', async () => {
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

  const result = await adapter.complete({
    messages: [],
    tools: [{
      action: 'repo.search',
      description: 'Search repository text.',
      inputSchema: { type: 'object' },
    }],
  })

  assert.deepEqual(result.toolCalls, [])
  assert.deepEqual(result.protocolError, {
    code: 'invalid_tool_arguments',
    toolCallId: 'call_bad',
    toolName: 'repo__search',
    message: 'Tool function "repo__search" did not contain one complete valid JSON object. ' +
      'Retry it with arguments matching the declared schema.',
  })
  assert.doesNotMatch(JSON.stringify(result), /bad json/)
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 5, cachedInputTokens: 3 })
})

test('OpenAI-compatible endpoint normalizes literal control characters inside JSON string arguments', async () => {
  const fake = fakeClient([response({
    output: [{
      type: 'function_call',
      call_id: 'call_patch',
      name: 'file__patch',
      arguments: '{"path":"src/example.ts","patch":"first line\nsecond\tline"}',
      status: 'completed',
    }],
  })])
  const adapter = new OpenAIResponsesAdapter({
    apiKey: '',
    model: 'compatible-model',
    baseURL: 'https://compatible.example.test',
    client: fake.client,
  })

  const result = await adapter.complete({
    messages: [],
    tools: [{
      action: 'file.patch',
      description: 'Apply a patch.',
      inputSchema: { type: 'object' },
    }],
  })

  assert.deepEqual(result.toolCalls[0].input, {
    path: 'src/example.ts',
    patch: 'first line\nsecond\tline',
  })
})

test('OpenAI-compatible endpoint reports structurally malformed JSON without exposing arguments', async () => {
  const fake = fakeClient([response({
    output: [{
      type: 'function_call',
      call_id: 'call_bad',
      name: 'repo__search',
      arguments: '{"query":"unterminated\nstring}',
      status: 'completed',
    }],
  })])
  const adapter = new OpenAIResponsesAdapter({
    apiKey: '',
    model: 'compatible-model',
    baseURL: 'https://compatible.example.test',
    client: fake.client,
  })

  const result = await adapter.complete({
    messages: [],
    tools: [{
      action: 'repo.search',
      description: 'Search repository text.',
      inputSchema: { type: 'object' },
    }],
  })

  assert.equal(result.protocolError.code, 'invalid_tool_arguments')
  assert.deepEqual(result.toolCalls, [])
  assert.doesNotMatch(JSON.stringify(result), /unterminated/)
})

test('OpenAI adapter reports provider function names that are not declared for the current hop', async () => {
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

  const result = await adapter.complete({ messages: [], tools: [] })

  assert.deepEqual(result.toolCalls, [])
  assert.deepEqual(result.protocolError, {
    code: 'unknown_tool',
    toolCallId: 'call_unknown',
    toolName: 'unknown_tool',
    message: 'Tool function "unknown_tool" was not declared for this model hop. ' +
      'Use exactly one of the currently declared tool functions.',
  })
})

test('OpenAI adapter rejects a malformed multi-call response without executing its valid prefix', async () => {
  const fake = fakeClient([response({
    output: [
      {
        type: 'function_call', call_id: 'call_valid', name: 'repo__search',
        arguments: '{"query":"runtime"}', status: 'completed',
      },
      {
        type: 'function_call', call_id: 'call_invalid', name: 'file__patch',
        arguments: '{broken', status: 'completed',
      },
    ],
  })])
  const adapter = new OpenAIResponsesAdapter({ apiKey: '', model: 'model-test', client: fake.client })

  const result = await adapter.complete({
    messages: [],
    tools: [
      { action: 'repo.search', description: 'Search.', inputSchema: { type: 'object' } },
      { action: 'file.patch', description: 'Patch.', inputSchema: { type: 'object' } },
    ],
  })

  assert.deepEqual(result.toolCalls, [])
  assert.equal(result.protocolError.toolCallId, 'call_invalid')
  assert.equal(result.finishReason, 'tool_calls')
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

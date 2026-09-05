import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentRuntime, DeterministicContextBuilder, ScriptedModelAdapter } from '../dist/index.js'

function response({
  content = '', toolCalls = [], finishReason = toolCalls.length ? 'tool_calls' : 'stop', protocolError,
} = {}) {
  return {
    content,
    toolCalls,
    finishReason,
    usage: { inputTokens: 10, outputTokens: 5 },
    ...(protocolError ? { protocolError } : {}),
  }
}

function statusCall(id, status, summary) {
  return { id, action: 'run.set_status', input: { status, summary } }
}

class MemoryPersistence {
  messages = []
  events = []
  controls = []
  modelCalls = []
  contextSnapshots = []

  constructor(maxHops = 10) {
    this.run = {
      workspaceId: 'ws_runtime',
      missionId: 'mission_runtime',
      taskId: 'task_runtime',
      runId: 'run_runtime',
      agentId: 'agent_runtime',
      status: 'starting',
      currentHop: 0,
      maxHops,
      contextSnapshot: {},
    }
  }

  async loadRun() { return { ...this.run } }
  async startRun() {
    if (this.run.status === 'starting') this.run.status = 'running'
    if (this.run.status !== 'running') throw new Error('not runnable: ' + this.run.status)
    return { ...this.run }
  }
  async beginHop() {
    if (this.run.status !== 'running' || this.run.currentHop >= this.run.maxHops) return null
    this.run.currentHop += 1
    return this.run.currentHop
  }
  async transitionRun(_runId, to, summary) {
    this.events.push({ kind: 'transition', from: this.run.status, to, summary })
    this.run.status = to
  }
  async initializeMessages(_runId, messages) {
    if (this.messages.length === 0) this.messages.push(...structuredClone(messages))
  }
  async loadMessages() { return structuredClone(this.messages) }
  async loadModelContinuation() { return null }
  async saveContextSnapshot(snapshot) { this.contextSnapshots.push(structuredClone(snapshot)) }
  async appendMessage(_runId, _hop, message) { this.messages.push(structuredClone(message)) }
  async recordEvent(_runId, hop, kind, data) { this.events.push({ hop, kind, data }) }
  async beginModelCall(callId, _runId, hop, provider, model, request) {
    this.modelCalls.push({ callId, hop, provider, model, request })
    return Date.now()
  }
  async finishModelCall() {}
  async failModelCall() {}
  async takePendingControls() {
    const controls = this.controls
    this.controls = []
    return controls
  }
}

class MemoryTools {
  calls = []
  constructor(handler = async () => ({ status: 'succeeded', output: { matches: [] }, sideEffects: [], evidence: [] })) {
    this.handler = handler
  }
  riskFor(action) {
    if (action === 'repo.search') return 'read_only'
    if (action === 'file.read') return 'read_only'
    if (action === 'file.patch') return 'workspace_write'
    if (action === 'conversation.reply') return 'external_write'
    return null
  }
  async execute(request) {
    this.calls.push(structuredClone(request))
    return this.handler(request, this.calls.length)
  }
}

function runtime({
  persistence,
  responses,
  tools = new MemoryTools(),
  verify = async () => ({ accepted: true }),
  contextBuilder = new DeterministicContextBuilder({ tokenBudget: 4_096 }),
  implementationGate,
  maxModelProtocolRepairs,
  hopBudgetGates,
  toolDefinitions = [{ action: 'repo.search', description: 'Search', inputSchema: { type: 'object' } }],
}) {
  const model = new ScriptedModelAdapter('scripted', 'deterministic', responses)
  return {
    model,
    tools,
    runtime: new AgentRuntime({
      persistence,
      model,
      tools,
      completionVerifier: { verify },
      contextBuilder,
      toolDefinitions,
      ...(implementationGate ? { implementationGate } : {}),
      ...(maxModelProtocolRepairs === undefined ? {} : { maxModelProtocolRepairs }),
      ...(hopBudgetGates === undefined ? {} : { hopBudgetGates }),
    }),
  }
}

test('model silence is nudged and only explicit verified completion succeeds', async () => {
  const persistence = new MemoryPersistence()
  const tools = new MemoryTools()
  const setup = runtime({
    persistence,
    tools,
    responses: [
      response({ content: 'I think this is done.' }),
      response({
        toolCalls: [
          { id: 'call_search', action: 'repo.search', input: { query: 'mission' } },
          statusCall('call_done', 'done', 'Evidence verified.'),
        ],
      }),
    ],
  })

  const outcome = await setup.runtime.run({
    runId: 'run_runtime',
    initialMessages: [{ role: 'user', content: 'Complete the mission.' }],
  })

  assert.deepEqual(outcome, { status: 'succeeded', summary: 'Evidence verified.', hops: 2 })
  assert.equal(tools.calls.length, 1)
  assert.equal(setup.model.requests.length, 2)
  assert.equal(
    setup.model.requests[1].messages.some((message) => message.content.includes('silence is not completion')),
    true,
  )
  assert.equal(persistence.run.status, 'succeeded')
  assert.equal(persistence.contextSnapshots.length, 2)
  assert.equal(setup.model.requests.every((request) => request.context.contentHash), true)
  assert.equal(setup.model.requests.every((request) => request.toolChoice === 'required'), true)
  assert.equal(setup.model.requests.every((request) => request.reasoningEffort === 'none'), true)
})

test('completion gate rejection returns evidence feedback to the next model hop', async () => {
  const persistence = new MemoryPersistence()
  let checks = 0
  const setup = runtime({
    persistence,
    responses: [
      response({ toolCalls: [statusCall('done_too_early', 'done', 'Done once.')] }),
      response({ toolCalls: [statusCall('done_verified', 'done', 'Done twice.')] }),
    ],
    verify: async () => {
      checks += 1
      return checks === 1
        ? { accepted: false, reason: 'Required test evidence is missing.' }
        : { accepted: true }
    },
  })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })
  assert.equal(outcome.status, 'succeeded')
  assert.equal(outcome.hops, 2)
  assert.equal(checks, 2)
  assert.equal(
    setup.model.requests[1].messages.some((message) => message.content.includes('Required test evidence is missing')),
    true,
  )
  assert.equal(persistence.events.some((event) => event.kind === 'completion_rejected'), true)
})

test('pending approved tool call survives a runtime pause without another model guess', async () => {
  const persistence = new MemoryPersistence()
  const tools = new MemoryTools(async (_request, attempt) => {
    if (attempt === 1) return { status: 'awaiting_approval', approvalId: 'approval_runtime' }
    return {
      status: 'succeeded',
      output: { messageId: 'message_runtime' },
      sideEffects: [],
      evidence: [],
    }
  })
  const setup = runtime({
    persistence,
    tools,
    responses: [
      response({
        toolCalls: [{
          id: 'call_external',
          action: 'conversation.reply',
          input: { conversationId: 'conversation_runtime', body: 'Publish' },
        }],
      }),
      response({ toolCalls: [statusCall('done_after_approval', 'done', 'Published once.')] }),
    ],
  })

  const first = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })
  assert.equal(first.status, 'waiting_human')
  assert.equal(setup.model.requests.length, 1)
  assert.equal(persistence.messages.some((message) => message.toolCallId === 'call_external'), false)

  const resumed = await setup.runtime.run({
    runId: 'run_runtime',
    initialMessages: [],
    resumeWaiting: true,
  })
  assert.deepEqual(resumed, { status: 'succeeded', summary: 'Published once.', hops: 2 })
  assert.equal(tools.calls.length, 2)
  assert.equal(tools.calls[0].idempotencyKey, tools.calls[1].idempotencyKey)
  assert.equal(setup.model.requests.length, 2)
})

test('durable cancellation wins before a model call', async () => {
  const persistence = new MemoryPersistence()
  persistence.controls.push({
    id: 'control_cancel',
    workspaceId: 'ws_runtime',
    runId: 'run_runtime',
    kind: 'cancel',
    payload: {},
    createdBy: 'human_operator',
    createdAt: new Date().toISOString(),
  })
  const setup = runtime({ persistence, responses: [] })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })
  assert.equal(outcome.status, 'cancelled')
  assert.equal(outcome.hops, 0)
  assert.equal(setup.model.requests.length, 0)
})

test('hop budget times out repeated non-terminal model responses', async () => {
  const persistence = new MemoryPersistence(2)
  const setup = runtime({
    persistence,
    responses: [response({ content: 'Still thinking.' }), response({ content: 'Still thinking again.' })],
  })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })
  assert.deepEqual(outcome, { status: 'timed_out', summary: 'Maximum model hops reached.', hops: 2 })
  assert.equal(setup.model.requests.length, 2)
})

test('output-limit truncation without a tool call fails once instead of burning the remaining hops', async () => {
  const persistence = new MemoryPersistence(30)
  const setup = runtime({
    persistence,
    responses: [response({ content: 'partial patch', finishReason: 'length' })],
  })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })

  assert.deepEqual(outcome, {
    status: 'failed',
    summary: 'Model response ended with length before producing an executable tool call.',
    hops: 1,
  })
  assert.equal(setup.model.requests.length, 1)
  assert.equal(persistence.messages.some((message) => message.content.includes('silence is not completion')), false)
})

test('model protocol errors receive a durable bounded correction without executing tools', async () => {
  const persistence = new MemoryPersistence()
  const setup = runtime({
    persistence,
    responses: [
      response({
        finishReason: 'tool_calls',
        protocolError: {
          code: 'unknown_tool',
          toolCallId: 'call_hidden_search',
          toolName: 'repo__search',
          message: 'Tool function "repo__search" was not declared for this model hop.',
        },
      }),
      response({ toolCalls: [statusCall('call_done_after_repair', 'done', 'Recovered.')] }),
    ],
  })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })

  assert.deepEqual(outcome, { status: 'succeeded', summary: 'Recovered.', hops: 2 })
  assert.equal(setup.tools.calls.length, 0)
  assert.equal(setup.model.requests.length, 2)
  assert.equal(
    setup.model.requests[1].messages.some((message) =>
      message.content.startsWith('[Model protocol correction]') && message.content.includes('No tool')),
    true,
  )
  assert.equal(
    persistence.events.some((event) => event.kind === 'model_protocol_rejected'
      && event.data.code === 'unknown_tool'),
    true,
  )
})

test('an incomplete malformed tool call fails once instead of entering protocol repair', async () => {
  const persistence = new MemoryPersistence(10)
  const setup = runtime({
    persistence,
    responses: [response({
      finishReason: 'length',
      protocolError: {
        code: 'invalid_tool_arguments',
        toolCallId: 'call_truncated',
        toolName: 'file__patch',
        message: 'Tool arguments were incomplete.',
      },
    })],
  })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })

  assert.deepEqual(outcome, {
    status: 'failed',
    summary: 'Model response ended with length before producing an executable tool call.',
    hops: 1,
  })
  assert.equal(setup.model.requests.length, 1)
  assert.equal(
    persistence.messages.some((message) => message.content.startsWith('[Model protocol correction]')),
    false,
  )
})

test('model protocol repair budget survives repeated invalid responses and fails visibly', async () => {
  const persistence = new MemoryPersistence(10)
  const invalid = () => response({
    finishReason: 'tool_calls',
    protocolError: {
      code: 'invalid_tool_arguments',
      toolCallId: 'call_bad_json',
      toolName: 'file__patch',
      message: 'Tool arguments were invalid.',
    },
  })
  const setup = runtime({ persistence, responses: [invalid(), invalid(), invalid()] })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })

  assert.deepEqual(outcome, {
    status: 'failed',
    summary: 'Model protocol repair budget exhausted after 3 invalid responses: invalid_tool_arguments.',
    hops: 3,
  })
  assert.equal(
    persistence.messages.filter((message) => message.content.startsWith('[Model protocol correction]')).length,
    2,
  )
})

test('hop budget gate preserves final calls and rejects stale blocked actions without side effects', async () => {
  const persistence = new MemoryPersistence(5)
  const setup = runtime({
    persistence,
    hopBudgetGates: [{
      remainingHops: 3,
      blockedActions: ['repo.search'],
      instruction: 'Finish verification and durable delivery now.',
    }],
    responses: [
      response({ toolCalls: [{ id: 'call_search_one', action: 'repo.search', input: { query: 'one' } }] }),
      response({ toolCalls: [{ id: 'call_search_two', action: 'repo.search', input: { query: 'two' } }] }),
      response({ toolCalls: [{ id: 'call_stale_search', action: 'repo.search', input: { query: 'three' } }] }),
      response({ toolCalls: [statusCall('call_done_in_reserve', 'done', 'Delivered.')] }),
    ],
  })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })

  assert.deepEqual(outcome, { status: 'succeeded', summary: 'Delivered.', hops: 4 })
  assert.deepEqual(setup.tools.calls.map((call) => call.id), ['call_search_one', 'call_search_two'])
  assert.equal(setup.model.requests[2].tools.some((tool) => tool.action === 'repo.search'), false)
  assert.equal(
    setup.model.requests[2].messages.filter((message) =>
      message.content.startsWith('[Hop budget gate] remaining<=3')).length,
    1,
  )
  const rejected = persistence.messages.find((message) => message.toolCallId === 'call_stale_search')
  assert.match(rejected.content, /Hop delivery budget is active/)
  assert.match(rejected.content, /Finish verification and durable delivery now/)
})

test('implementation gate repeatedly bounds discovery between durable file.patch results', async () => {
  const persistence = new MemoryPersistence()
  const setup = runtime({
    persistence,
    implementationGate: {
      maxDiscoveryHops: 1,
      discoveryActions: ['repo.search', 'file.read'],
      implementationActions: ['file.patch'],
    },
    toolDefinitions: [
      { action: 'repo.search', description: 'Search', inputSchema: { type: 'object' } },
      { action: 'file.read', description: 'Read', inputSchema: { type: 'object' } },
      { action: 'file.patch', description: 'Patch', inputSchema: { type: 'object' } },
    ],
    responses: [
      response({ toolCalls: [{ id: 'call_reused', action: 'repo.search', input: { query: 'mission' } }] }),
      response({ toolCalls: [{ id: 'call_discovery_blocked', action: 'repo.search', input: { query: 'more' } }] }),
      response({ toolCalls: [
        { id: 'call_stale_discovery', action: 'file.read', input: { path: 'src.ts' } },
        { id: 'call_reused', action: 'file.patch', input: { path: 'src.ts', unifiedDiff: 'patch' } },
      ] }),
      response({ toolCalls: [{ id: 'call_discovery_restored', action: 'repo.search', input: { query: 'verify' } }] }),
      response({ toolCalls: [{ id: 'call_discovery_blocked_again', action: 'file.read', input: { path: 'other.ts' } }] }),
      response({ toolCalls: [{ id: 'call_second_patch', action: 'file.patch', input: { path: 'other.ts', unifiedDiff: 'patch' } }] }),
      response({ toolCalls: [statusCall('call_done_after_patch', 'done', 'Implemented.')] }),
    ],
  })

  const outcome = await setup.runtime.run({ runId: 'run_runtime', initialMessages: [] })

  assert.equal(outcome.status, 'succeeded')
  assert.deepEqual(setup.tools.calls.map((call) => call.action), [
    'repo.search',
    'file.patch',
    'repo.search',
    'file.patch',
  ])
  assert.equal(setup.model.requests[1].tools.some((tool) => tool.action === 'repo.search'), false)
  assert.equal(setup.model.requests[1].tools.some((tool) => tool.action === 'file.patch'), true)
  assert.equal(setup.model.requests[2].tools.some((tool) => tool.action === 'file.read'), false)
  assert.equal(setup.model.requests[3].tools.some((tool) => tool.action === 'repo.search'), true)
  assert.equal(setup.model.requests[4].tools.some((tool) => tool.action === 'file.read'), false)
  assert.equal(setup.model.requests[4].tools.some((tool) => tool.action === 'file.patch'), true)
  const blocked = persistence.messages.find((message) => message.toolCallId === 'call_discovery_blocked')
  assert.match(blocked.content, /Discovery budget is exhausted/)
  const stale = persistence.messages.find((message) => message.toolCallId === 'call_stale_discovery')
  assert.match(stale.content, /Discovery budget is exhausted/)
  const blockedAgain = persistence.messages.find((message) => message.toolCallId === 'call_discovery_blocked_again')
  assert.match(blockedAgain.content, /Discovery budget is exhausted/)
  assert.equal(
    persistence.messages.filter((message) => message.content.startsWith('[Implementation gate]')).length,
    2,
  )
})

test('an oversized pinned context fails visibly without calling the model or retrying forever', async () => {
  const persistence = new MemoryPersistence()
  const setup = runtime({
    persistence,
    responses: [],
    contextBuilder: new DeterministicContextBuilder({ tokenBudget: 256, digestTokenBudget: 64 }),
  })

  const outcome = await setup.runtime.run({
    runId: 'run_runtime',
    initialMessages: [{ role: 'user', content: 'mandatory '.repeat(300) }],
  })
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.summary, /Context build failed/)
  assert.equal(setup.model.requests.length, 0)
  assert.equal(persistence.contextSnapshots.length, 0)
})

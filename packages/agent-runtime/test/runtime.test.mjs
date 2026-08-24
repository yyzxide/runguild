import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentRuntime, DeterministicContextBuilder, ScriptedModelAdapter } from '../dist/index.js'

function response({ content = '', toolCalls = [], finishReason = toolCalls.length ? 'tool_calls' : 'stop' } = {}) {
  return {
    content,
    toolCalls,
    finishReason,
    usage: { inputTokens: 10, outputTokens: 5 },
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
      toolDefinitions: [{ action: 'repo.search', description: 'Search', inputSchema: { type: 'object' } }],
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

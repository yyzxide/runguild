import assert from 'node:assert/strict'
import test from 'node:test'

import { EVIDENCE_KINDS } from '@runguild/protocol'

import {
  ConversationPlanner,
  missionPlanToolDefinition,
  planningMessages,
} from '../dist/conversation-planner.js'

const plan = {
  summary: '研究、实现、审查形成可验证交付。',
  tasks: [{
    key: 'build', title: '实现功能', description: '完成范围内实现并验证。',
    role: 'builder', priority: 10, dependsOn: [], reviewRequired: true,
    acceptanceCriteria: [{
      key: 'tests', description: '相关测试通过', required: true, evidenceKinds: ['test_run'],
    }],
  }],
}

function work(storedPlan) {
  return {
    request: {
      id: 'planning', workspaceId: 'ws', projectId: 'project', conversationId: 'conversation',
      missionId: 'mission', plannerAgentId: 'planner', sourceMessageIds: ['message'],
      status: storedPlan ? 'model_complete' : 'running', attempt: 1, maxAttempts: 3,
      createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
    },
    leaseToken: 'lease', missionTitle: 'Mission', missionGoal: 'Goal', missionConstraints: [],
    missionAcceptanceCriteria: ['错误行可预览'],
    conversationTitle: 'Team room',
    sourceMessages: [{
      id: 'message', authorKind: 'user', authorId: 'user', authorName: 'Developer',
      body: 'Please build it.', createdAt: '2030-01-01T00:00:00.000Z',
    }],
    availableRoles: ['planner', 'builder'],
    modelProvider: 'test', modelName: 'planner-model',
    ...(storedPlan ? { storedPlan } : {}),
  }
}

test('Planner tool schema exposes only executable roles and Agent-producible evidence', () => {
  const definition = missionPlanToolDefinition(['planner', 'builder', 'reviewer'])
  const evidenceKinds = definition.inputSchema
    .properties.tasks.items.properties.acceptanceCriteria.items.properties.evidenceKinds.items.enum
  assert.deepEqual(evidenceKinds, EVIDENCE_KINDS.filter((kind) => kind !== 'human_attestation'))
  assert.deepEqual(definition.inputSchema.properties.tasks.items.properties.role.enum, ['builder'])
  assert.equal(definition.inputSchema.properties.tasks.maxItems, 100)
  assert.equal(missionPlanToolDefinition(['builder'], true).inputSchema.properties.tasks.maxItems, 99)
})

test('Goal-specific invalid model plans are never frozen and invalid stored plans stop replay', async () => {
  const invalidPlans = [
    { ...plan, tasks: Array.from({ length: 100 }, (_, index) => ({ ...plan.tasks[0], key: 'task-' + index })) },
    { ...plan, tasks: [{ ...plan.tasks[0], key: 'runguild-goal-verification' }] },
  ]
  for (const invalid of invalidPlans) {
    for (const stored of [false, true]) {
      let failure
      let visibleMessage
      const planner = new ConversationPlanner({
        planning: {
          async claim() { return { kind: 'work', work: { ...work(stored ? invalid : undefined), missionGoalVerification: true } } },
          async completeModel() { assert.fail('A Goal-invalid plan must not be persisted') },
          async markAwaitingApproval() { assert.fail('A Goal-invalid plan must not await approval') },
          async fail(input) { failure = input; return { retryable: !input.terminal, request: {} } },
        },
        missions: { async proposePlan() { assert.fail('Invalid Goal plans must be caught before proposing') } },
        conversations: { async postMessage(input) { visibleMessage = input.body; return { reused: false, message: { id: 'message' } } } },
        modelFor() {
          assert.equal(stored, false)
          return { provider: 'test', model: 'test', async complete() {
            return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call', action: 'mission.propose_plan', input: invalid }],
              usage: { inputTokens: 10, outputTokens: 10 } }
          } }
        },
      })
      const process = () => planner.process({ schemaVersion: 1, type: 'conversation.plan_requested', requestId: 'planning',
        conversationId: 'conversation', missionId: 'mission' }, 'planner')
      if (stored) {
        await process()
        assert.equal(failure.terminal, true)
        assert.match(visibleMessage, /Stored Goal plan cannot be proposed/)
        assert.match(visibleMessage, /1–99/)
      } else {
        await assert.rejects(process, /1–99/)
        assert.equal(failure.terminal, undefined)
      }
    }
  }
})

test('a deterministic repository rejection stops replay and exposes its validation detail', async () => {
  let failure
  let visibleMessage
  const planner = new ConversationPlanner({
    planning: {
      async claim() { return { kind: 'work', work: work(plan) } },
      async fail(input) { failure = input; return { retryable: !input.terminal, request: {} } },
    },
    missions: { async proposePlan() { return { proposed: false, reason: 'invalid_plan', errors: [{ path: 'tasks', message: 'Reserved key is invalid.' }] } } },
    conversations: { async postMessage(input) { visibleMessage = input.body; return { reused: false, message: { id: 'message' } } } },
    modelFor() { assert.fail('Do not repeat the model for a stored plan') },
  })
  await planner.process({ schemaVersion: 1, type: 'conversation.plan_requested', requestId: 'planning',
    conversationId: 'conversation', missionId: 'mission' }, 'planner')
  assert.equal(failure.terminal, true)
  assert.match(visibleMessage, /Reserved key is invalid/)
})

test('Planner receives user acceptance criteria and must cover them with Task evidence', () => {
  const messages = planningMessages(work())
  assert.match(messages[0].content, /Cover every Mission acceptance criterion/)
  assert.match(messages[1].content, /Mission acceptance criteria: \["错误行可预览"\]/)
  const goalMessages = planningMessages({ ...work(), missionGoalVerification: true })
  assert.match(goalMessages[0].content, /at most 99 original tasks/)
  assert.match(goalMessages[0].content, /reserved runguild-goal-verification/)
})

test('Conversation Planner converts one durable model tool call into a human-approval proposal', async () => {
  const calls = []
  const planning = {
    async claim() { calls.push('claim'); return { kind: 'work', work: work() } },
    async completeModel(input) { calls.push(['model.complete', input.plan]) },
    async markAwaitingApproval(input) { calls.push(['awaiting', input.planVersion]); return {} },
    async fail(input) { calls.push(['failed', input.message]); return { retryable: false, request: {} } },
  }
  const model = {
    provider: 'test', model: 'planner-model',
    async complete(request) {
      calls.push(['model.call', request.tools[0].action])
      return {
        content: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'call', action: 'mission.propose_plan', input: plan }],
        usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.02 },
        providerRequestId: 'response',
      }
    },
  }
  const planner = new ConversationPlanner({
    planning,
    missions: {
      async proposePlan(input) { calls.push(['proposal', input.plan]); return { proposed: true, version: 2, hash: 'hash', reused: false } },
    },
    conversations: {
      async postMessage(input) { calls.push(['message', input.body]); return { reused: false, message: { id: 'message' } } },
    },
    modelFor(provider, name) { calls.push(['modelFor', provider, name]); return model },
  })

  await planner.process({
    schemaVersion: 1, type: 'conversation.plan_requested', requestId: 'planning',
    conversationId: 'conversation', missionId: 'mission',
  }, 'planner')

  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === 'model.call').length, 1)
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'proposal')[1], plan)
  assert.match(calls.find((call) => Array.isArray(call) && call[0] === 'message')[1], /等待人工批准/)
  assert.deepEqual(calls.at(-1), ['awaiting', 2])
})

test('Conversation Planner resumes a stored plan without repeating the model call', async () => {
  let modelCalls = 0
  const planner = new ConversationPlanner({
    planning: {
      async claim() { return { kind: 'work', work: work(plan) } },
      async completeModel() { throw new Error('must not repeat model completion') },
      async markAwaitingApproval() { return {} },
      async fail() { return { retryable: false, request: {} } },
    },
    missions: { async proposePlan() { return { proposed: true, version: 1, hash: 'hash', reused: true } } },
    conversations: { async postMessage() { return { reused: true, message: { id: 'message' } } } },
    modelFor() {
      modelCalls += 1
      throw new Error('must not create model')
    },
  })
  await planner.process({
    schemaVersion: 1, type: 'conversation.plan_requested', requestId: 'planning',
    conversationId: 'conversation', missionId: 'mission',
  }, 'planner')
  assert.equal(modelCalls, 0)
})

test('Conversation Planner rejects a role that no active project Agent can execute', async () => {
  let failure = ''
  let proposals = 0
  const unavailablePlan = {
    ...plan,
    tasks: [{ ...plan.tasks[0], role: 'custom' }],
  }
  const planner = new ConversationPlanner({
    planning: {
      async claim() { return { kind: 'work', work: work() } },
      async completeModel() { throw new Error('unavailable plan must not be persisted') },
      async markAwaitingApproval() { throw new Error('unavailable plan must not await approval') },
      async fail(input) {
        failure = input.message
        return { retryable: false, request: {} }
      },
    },
    missions: {
      async proposePlan() {
        proposals += 1
        return { proposed: true, version: 1, hash: 'hash', reused: false }
      },
    },
    conversations: { async postMessage() { return { reused: false, message: { id: 'message' } } } },
    modelFor() {
      return {
        provider: 'test', model: 'planner-model',
        async complete() {
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'call', action: 'mission.propose_plan', input: unavailablePlan }],
            usage: { inputTokens: 10, outputTokens: 10 },
          }
        },
      }
    },
  })

  await planner.process({
    schemaVersion: 1, type: 'conversation.plan_requested', requestId: 'planning',
    conversationId: 'conversation', missionId: 'mission',
  }, 'planner')
  assert.match(failure, /unavailable task-execution Agent roles: custom/)
  assert.equal(proposals, 0)
})

test('Conversation Planner rejects human-only evidence even if a model bypasses the tool schema', async () => {
  let failure = ''
  let proposals = 0
  const humanOnlyPlan = {
    ...plan,
    tasks: [{
      ...plan.tasks[0],
      acceptanceCriteria: [{
        key: 'approval', description: 'A human approves the design.', required: true,
        evidenceKinds: ['human_attestation'],
      }],
    }],
  }
  const planner = new ConversationPlanner({
    planning: {
      async claim() { return { kind: 'work', work: work() } },
      async completeModel() { throw new Error('invalid plan must not be persisted') },
      async markAwaitingApproval() { throw new Error('invalid plan must not await approval') },
      async fail(input) { failure = input.message; return { retryable: false, request: {} } },
    },
    missions: {
      async proposePlan() { proposals += 1; return { proposed: true, version: 1, hash: 'hash', reused: false } },
    },
    conversations: { async postMessage() { return { reused: false, message: { id: 'message' } } } },
    modelFor() {
      return {
        provider: 'test', model: 'planner-model',
        async complete() {
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'call', action: 'mission.propose_plan', input: humanOnlyPlan }],
            usage: { inputTokens: 10, outputTokens: 10 },
          }
        },
      }
    },
  })

  await planner.process({
    schemaVersion: 1, type: 'conversation.plan_requested', requestId: 'planning',
    conversationId: 'conversation', missionId: 'mission',
  }, 'planner')
  assert.match(failure, /human_attestation/)
  assert.equal(proposals, 0)
})

test('Planner prompt pins source message ids and requires a minimal executable DAG', () => {
  const messages = planningMessages(work())
  assert.match(messages[0].content, /mission\.propose_plan exactly once/)
  assert.match(messages[0].content, /reviewRequired=true/)
  assert.match(messages[0].content, /Never create DAG Tasks assigned to planner or reviewer/)
  assert.match(messages[0].content, /Never require human_attestation/)
  assert.match(messages[0].content, /active task-execution Agent roles: builder/)
  assert.match(messages[1].content, /\[message\] Developer/)
  assert.match(messages[1].content, /Avoid ceremonial Tasks/)
})

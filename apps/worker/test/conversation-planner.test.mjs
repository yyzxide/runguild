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

test('Planner tool schema derives evidence kinds from the protocol source of truth', () => {
  const definition = missionPlanToolDefinition(['planner', 'builder'])
  const evidenceKinds = definition.inputSchema
    .properties.tasks.items.properties.acceptanceCriteria.items.properties.evidenceKinds.items.enum
  assert.deepEqual(evidenceKinds, EVIDENCE_KINDS)
  assert.deepEqual(definition.inputSchema.properties.tasks.items.properties.role.enum, ['planner', 'builder'])
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
  assert.match(failure, /unavailable project Agent roles: custom/)
  assert.equal(proposals, 0)
})

test('Planner prompt pins source message ids and requires a minimal executable DAG', () => {
  const messages = planningMessages(work())
  assert.match(messages[0].content, /mission\.propose_plan exactly once/)
  assert.match(messages[0].content, /reviewRequired=true/)
  assert.match(messages[0].content, /Do not create a reviewer-role DAG Task/)
  assert.match(messages[0].content, /active project Agent roles: planner, builder/)
  assert.match(messages[1].content, /\[message\] Developer/)
  assert.match(messages[1].content, /Avoid ceremonial Tasks/)
})

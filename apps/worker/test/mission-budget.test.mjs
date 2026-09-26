import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationPlanner } from '../dist/conversation-planner.js'
import { ArtifactReviewer } from '../dist/artifact-reviewer.js'

test('Budget-blocked Planner and Reviewer work is acknowledged without a model call or retry failure', async () => {
  const unexpected = async () => { throw new Error('Budget pause must not make a model call or consume a failed attempt') }
  const planner = new ConversationPlanner({
    planning: { claim: async () => ({ kind: 'budget_blocked' }), fail: unexpected },
    missions: {}, conversations: {}, modelFor: unexpected,
  })
  await planner.process({ requestId: 'plan' }, 'planner')
  const reviewer = new ArtifactReviewer({
    executions: { claim: async () => ({ kind: 'budget_blocked' }), fail: unexpected },
    reviews: {}, modelFor: unexpected,
  })
  assert.equal(await reviewer.process({ reviewId: 'review' }, 'reviewer'), 'processed')
})

test('Planner charges an invalid response before recording its ordinary parse failure', async () => {
  const calls = []
  const planner = new ConversationPlanner({
    budget: {
      async settleModelCall(id, usage) { calls.push(['settled', id, usage.inputTokens + usage.outputTokens]) },
      async recordUnknownModelCall() { throw new Error('Returned usage is known') },
    },
    planning: {
      async claim() { return { kind: 'work', work: {
        request: { id: 'planning', workspaceId: 'ws', missionId: 'mission', conversationId: 'conversation' },
        leaseToken: 'lease', budgetCallId: 'budget-planning', missionTitle: 'Goal', missionGoal: 'Deliver',
        missionConstraints: [], missionAcceptanceCriteria: [], conversationTitle: 'Team', sourceMessages: [],
        availableRoles: ['builder'], modelProvider: 'test', modelName: 'test',
      } } },
      async fail() { calls.push(['failed']); return { retryable: false } },
    },
    missions: {}, conversations: { async postMessage() {} },
    modelFor() { return { provider: 'test', model: 'test', async complete() {
      return { content: 'Unstructured plan', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 10 } }
    } } },
  })
  await planner.process({ requestId: 'planning' }, 'planner')
  assert.deepEqual(calls, [['settled', 'budget-planning', 30], ['failed']])
})

test('Reviewer charges an invalid response before recording invalid output and retry failure', async () => {
  const calls = []
  const reviewer = new ArtifactReviewer({
    budget: {
      async settleModelCall(id, usage) { calls.push(['settled', id, usage.inputTokens + usage.outputTokens]) },
      async recordUnknownModelCall() { throw new Error('Returned usage is known') },
    },
    executions: {
      async claim() { return { kind: 'work', work: {
        reviewId: 'review', workspaceId: 'ws', missionId: 'mission', taskId: 'task', submissionId: 'submission',
        leaseToken: 'lease', budgetCallId: 'budget-reviewer', modelProvider: 'test', modelName: 'test', materials: {},
      } } },
      async recordInvalidModelResponse() { calls.push(['invalid']) },
      async fail() { calls.push(['failed']); return { retryable: false } },
    },
    reviews: {}, modelFor() { return { provider: 'test', model: 'test', async complete() {
      return { content: 'Looks good', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 10 } }
    } } },
  })
  assert.equal(await reviewer.process({ reviewId: 'review' }, 'reviewer'), 'processed')
  assert.deepEqual(calls, [['settled', 'budget-reviewer', 30], ['invalid'], ['failed']])
})

import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

register(new URL('./tsx-loader.mjs', import.meta.url))
const { missionApi } = await import('../src/api.ts')
const identity = { workspaceId: 'workspace', projectId: 'project', userId: 'user' }

test('goal API preserves a zero or removed limit and supplies verification to planning', async (context) => {
  const requests = []
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } })
  context.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
  })
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    return Response.json(url.endsWith('/budget') ? { tokenLimit: requests.at(-1).body.tokenLimit } : { request: { id: 'planning' } })
  })
  assert.deepEqual(await missionApi.setMissionBudget(identity, 'mission', 0), { tokenLimit: 0 })
  assert.deepEqual(await missionApi.setMissionBudget(identity, 'mission', null), { tokenLimit: null })
  await missionApi.createPlanningRequest({ identity, conversationId: 'room', sourceMessageIds: ['message'], title: 'Goal', budgetTokens: 0, goalVerification: true, idempotencyKey: 'fixed-operation' })
  await missionApi.submitConversationTask({ identity, conversationId: 'room', body: '/goal Goal', mentions: [], title: 'Goal', goal: 'Goal', constraints: ['keep API'], acceptanceCriteria: ['tests pass'], budgetTokens: 0, goalVerification: true, plannerAgentId: 'planner', clientRequestId: 'atomic-operation' })
  await missionApi.submitConversationTask({ identity, conversationId: 'room', body: 'old task', mentions: ['planner'], title: 'old task', plannerAgentId: 'planner', clientRequestId: 'legacy-operation' })
  assert.deepEqual(requests[0].body, { tokenLimit: 0 })
  assert.deepEqual(requests[1].body, { tokenLimit: null })
  assert.equal(requests[0].url, '/api/v1/workspaces/workspace/missions/mission/budget')
  assert.equal(requests[2].body.budgetTokens, 0)
  assert.equal(requests[2].body.goalVerification, true)
  assert.equal(requests[2].options.headers.get('x-idempotency-key'), 'fixed-operation')
  assert.equal(requests[3].url, '/api/v1/workspaces/workspace/conversations/room/task-submissions')
  assert.equal(requests[3].options.headers.get('x-client-request-id'), 'atomic-operation')
  assert.deepEqual(requests[3].body, { body: '/goal Goal', mentions: [], title: 'Goal', goal: 'Goal', constraints: ['keep API'], acceptanceCriteria: ['tests pass'], budgetTokens: 0, goalVerification: true, plannerAgentId: 'planner' })
  assert.deepEqual(requests[4].body, { body: 'old task', mentions: ['planner'], title: 'old task', plannerAgentId: 'planner' })
  assert.ok(requests.every(({ options }) => options.method === 'POST' && options.credentials === 'include'))
})

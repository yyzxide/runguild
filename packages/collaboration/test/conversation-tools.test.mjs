import assert from 'node:assert/strict'
import test from 'node:test'

import { CONVERSATION_TOOL_DEFINITIONS, createConversationToolHandlers } from '../dist/index.js'

test('conversation.reply carries frozen Run scope and reports real delivery state', async () => {
  const calls = []
  const [handler] = createConversationToolHandlers({
    repository: {
      async postMessage(input) {
        calls.push(input)
        return {
          reused: false,
          message: {
            id: 'message_tool',
            deliveries: [
              { agentId: 'agent_reviewer', status: 'steered', runId: 'run_reviewer' },
              { agentId: 'agent_researcher', status: 'context_pending' },
            ],
          },
        }
      },
    },
  })
  const request = {
    schemaVersion: 1,
    id: 'tool_conversation',
    action: 'conversation.reply',
    workspaceId: 'workspace',
    missionId: 'mission',
    taskId: 'task',
    runId: 'run_builder',
    agentId: 'agent_builder',
    idempotencyKey: 'reply-once',
    risk: 'workspace_write',
    input: {
      conversationId: 'conversation',
      body: '实现完成，请独立检查边界。',
      mentions: ['agent_reviewer', 'agent_researcher'],
    },
    createdAt: '2030-01-01T00:00:00.000Z',
  }
  const result = await handler.execute(request.input, { request })

  assert.deepEqual(calls[0].entityRefs, {
    missionId: 'mission', taskId: 'task', runId: 'run_builder',
  })
  assert.deepEqual(calls[0].author, {
    kind: 'agent', id: 'agent_builder', runId: 'run_builder',
  })
  assert.deepEqual(result.output, {
    messageId: 'message_tool',
    deliveredAgentIds: ['agent_reviewer'],
    pendingAgentIds: ['agent_researcher'],
  })
  assert.deepEqual(result.sideEffects, [{
    type: 'message.posted', conversationId: 'conversation', messageId: 'message_tool',
  }])
  assert.equal(CONVERSATION_TOOL_DEFINITIONS[0].action, 'conversation.reply')
})

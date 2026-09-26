import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/goal-command.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
const { parseGoalCommand, parseGoalBudget, createRoomSubmission, submitRoomSubmission } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputText).toString('base64'))

const input = {
  identity: { workspaceId: 'workspace', projectId: 'project', userId: 'user' },
  conversationId: 'room', draft: '/goal 增加 CSV 错误行预览',
  acceptanceText: '可预览错误行\n\n重复导入不重复写入', constraintText: '保持接口兼容',
  missionId: 'old_mission', planningActive: true, plannerAgentId: 'planner',
  selectedAgents: ['builder'], replyToMessageId: 'old_message',
}

test('/goal creates an independent goal without steering the old Mission or Run', () => {
  const submission = createRoomSubmission(input, 'operation')
  assert.equal(submission.planning.goal, '增加 CSV 错误行预览')
  assert.deepEqual(submission.planning.acceptanceCriteria, ['可预览错误行', '重复导入不重复写入'])
  assert.deepEqual(submission.planning.constraints, ['保持接口兼容'])
  assert.equal(submission.planning.goalVerification, true)
  assert.equal(submission.planning.budgetTokens, null)
  assert.deepEqual(submission.message.mentions, [])
  assert.equal('missionId' in submission.message, false)
  assert.equal('replyToMessageId' in submission.message, false)
  assert.match(submission.message.body, /验收条件：[\s\S]*保持接口兼容/)
})

test('budget input accepts unlimited or a nonnegative safe integer and rejects ambiguous amounts', () => {
  assert.equal(parseGoalBudget('  '), null)
  assert.equal(parseGoalBudget('0'), 0)
  assert.equal(parseGoalBudget(' 200000 '), 200000)
  assert.equal(parseGoalBudget(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)
  for (const value of ['-1', '1.5', '1e6', '200,000', 'Infinity', 'NaN', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => parseGoalBudget(value), /非负整数/)
  }
  assert.throws(() => createRoomSubmission({ ...input, budgetText: '-2' }, 'invalid'), /非负整数/)
})

test('budget and verification are frozen into the planning request but do not affect ordinary follow-up', async () => {
  const draft = { ...input, budgetText: '50000' }
  const submission = createRoomSubmission(draft, 'budget-operation')
  draft.budgetText = '100000'
  assert.equal(submission.planning.budgetTokens, 50000)
  const attempts = []
  const api = {
    async postMessage() { return { id: 'message' } },
    async createPlanningRequest(request) {
      attempts.push({ limit: request.budgetTokens, verify: request.goalVerification, key: request.idempotencyKey })
      if (attempts.length === 1) throw new Error('response lost')
      return { missionId: 'mission' }
    },
    async getMission() { return { id: 'mission' } },
  }
  await assert.rejects(submitRoomSubmission(api, submission), /response lost/)
  await submitRoomSubmission(api, submission)
  assert.deepEqual(attempts, Array(2).fill({ limit: 50000, verify: true, key: 'web-planning-budget-operation' }))
  const followup = createRoomSubmission({ ...input, draft: '补充说明', budgetText: 'invalid' }, 'followup')
  assert.equal(followup.planning, undefined)
})

test('ordinary first task remains compatible and ordinary follow-up preserves steering', () => {
  const first = createRoomSubmission({ ...input, draft: '增加 CSV 预览', missionId: undefined, planningActive: false }, 'first')
  assert.equal(first.planning.goal, '增加 CSV 预览')
  const followup = createRoomSubmission({ ...input, draft: '请保持按钮的位置' }, 'followup')
  assert.equal(followup.planning, undefined)
  assert.equal(followup.message.body, '请保持按钮的位置')
  assert.equal(followup.message.missionId, 'old_mission')
  assert.deepEqual(followup.message.mentions, ['builder'])
  assert.equal(followup.message.replyToMessageId, 'old_message')
})

test('empty goal and invalid criteria fail before any operation is submitted', () => {
  assert.throws(() => parseGoalCommand(' /goal \n '), /请在 \/goal 后描述/)
  assert.deepEqual(parseGoalCommand('/goalkeeper 状态'), { explicit: false, goal: '/goalkeeper 状态' })
  assert.throws(() => createRoomSubmission({ ...input, acceptanceText: 'x'.repeat(2_001) }, 'bad'), /验收条件最多/)
  assert.throws(() => createRoomSubmission({ ...input, draft: '/goal ' + '中'.repeat(6_667) }, 'bad'), /目标过长/)
})

test('combined Chinese goal materials honor the exact 65536 UTF-8 byte message limit', () => {
  const baseText = Array(32).fill('x'.repeat(2_000)).join('\n')
  const base = createRoomSubmission({ ...input, acceptanceText: baseText, constraintText: '' }, 'base')
  const remaining = 65_536 - new TextEncoder().encode(base.message.body).length - 3
  const acceptanceText = baseText + '\n' + '中'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3)
  const boundary = createRoomSubmission({ ...input, acceptanceText, constraintText: '' }, 'boundary')
  assert.equal(new TextEncoder().encode(boundary.message.body).length, 65_536)
  assert.ok(boundary.message.body.length < 65_536)
  assert.throws(() => createRoomSubmission({ ...input, acceptanceText: acceptanceText + 'x', constraintText: '' }, 'overflow'), /目标及验收材料过长/)
})

for (const lostResponse of ['message', 'planning', 'mission']) {
  test(`retry after lost ${lostResponse} response reuses both writes and selects the new Mission`, async () => {
    const submission = createRoomSubmission(input, 'retry-operation')
    const messages = new Map()
    const requests = new Map()
    let failed = false
    const api = {
      async postMessage(value) {
        if (!messages.has(value.idempotencyKey)) messages.set(value.idempotencyKey, { id: 'new_message', ...value })
        if (lostResponse === 'message' && !failed) { failed = true; throw new Error('response lost') }
        return messages.get(value.idempotencyKey)
      },
      async createPlanningRequest(value) {
        assert.deepEqual(value.sourceMessageIds, ['new_message'])
        if (!requests.has(value.idempotencyKey)) requests.set(value.idempotencyKey, { id: 'request', missionId: 'new_mission', status: 'queued' })
        if (lostResponse === 'planning' && !failed) { failed = true; throw new Error('response lost') }
        return requests.get(value.idempotencyKey)
      },
      async getMission(identity, id) {
        assert.deepEqual(identity, input.identity)
        assert.equal(id, 'new_mission')
        if (lostResponse === 'mission' && !failed) { failed = true; throw new Error('response lost') }
        return { id, status: 'planning' }
      },
    }
    await assert.rejects(submitRoomSubmission(api, submission), /response lost/)
    const result = await submitRoomSubmission(api, submission)
    assert.equal(messages.size, 1)
    assert.equal(requests.size, 1)
    assert.equal(result.mission.id, 'new_mission')
    assert.equal(result.mission.status, 'planning')
  })
}

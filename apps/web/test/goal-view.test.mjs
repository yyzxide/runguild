import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

register(new URL('./tsx-loader.mjs', import.meta.url))
const { GoalView } = await import('../src/GoalView.tsx')
const { goalNextStep } = await import('../src/goal-progress.ts')
const noop = () => {}
const props = {
  identity: { workspaceId: 'workspace', projectId: 'project', userId: 'user' },
  busy: null, error: null, canOperate: true,
  onNavigate: noop, onRefresh: noop, onApprovePlan: noop, onStartExecution: noop,
  onOpenRuntime: noop, onOpenRun: noop, onRetryTask: noop,
  onApproveDelivery: noop, onRequestDeliveryChanges: noop,
  onUpdateBudget: noop,
}

function missionFixture() {
  return {
    id: 'mission', workspaceId: 'workspace', projectId: 'project',
    title: 'CSV 导入', goal: '幂等导入', constraints: ['不改接口'], acceptanceCriteria: ['重试不重复'],
    status: 'running', planVersion: 1, updatedAt: '2026-09-26T00:00:00Z',
    finalDelivery: null, proposedPlan: null,
    goalVerification: false, verificationTaskId: null,
    budget: {
      tokenLimit: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, remainingTokens: null,
      inFlightCalls: 0, unknownUsageCalls: 0, estimatedCostUsd: null, unpricedCalls: 0, status: 'unlimited',
    },
    tasks: [{
      id: 'task', title: '实现幂等', description: '重复文件防护', status: 'running', role: 'builder',
      priority: 1, dependsOn: [], attemptCount: 2, maxAttempts: 3, reviewRequired: true,
      latestRun: {
        id: 'run', agentId: 'builder', agentName: '真实 Builder', modelProvider: 'openai',
        modelName: 'observed-model', modelSource: 'observed', status: 'running', currentHop: 2,
        maxHops: 10, startedAt: '2026-09-26T00:00:00Z', finishedAt: '2026-09-26T00:00:10Z',
        completionSummary: '正在修复',
      },
      acceptanceCriteria: [{
        id: 'criterion', key: 'dedupe', description: '重试不能重复写', required: true,
        requiredEvidenceKinds: ['test_run'], evidenceStatus: 'missing', evidence: [],
      }],
      latestReview: {
        id: 'review', status: 'approved', submissionStatus: 'approved', artifactVersionId: 'old',
        isCurrentAttempt: false, summary: '旧版本通过', reviewerName: 'Reviewer',
        createdAt: '2026-09-25T00:00:00Z', resolvedAt: null,
      },
      integration: null,
    }],
  }
}

function render(mission, extra = {}) {
  return renderToStaticMarkup(React.createElement(GoalView, { ...props, ...extra, mission }))
}

test('empty workspace directs the user to create a goal', () => {
  assert.match(render(null), /创建目标/)
})

test('plan approval is offered only while awaiting approval and only to operators', () => {
  const mission = { ...missionFixture(), status: 'awaiting_approval', tasks: [] }
  assert.match(render(mission), /批准计划并开始执行/)
  assert.doesNotMatch(render(mission, { canOperate: false }), /批准计划并开始执行/)
  assert.doesNotMatch(render(missionFixture()), /批准计划并开始执行/)
})

test('actual run identity, model, attempt and duration are shown', () => {
  const html = render(missionFixture())
  for (const text of ['真实 Builder', 'observed-model', '2 / 3', '10 秒', '正在修复']) {
    assert.ok(html.includes(text), text)
  }
})

test('task completion does not turn missing evidence or mission criteria into passed checks', () => {
  const mission = missionFixture()
  mission.tasks[0].status = 'completed'
  const html = render(mission)
  assert.match(html, /证据待补/)
  assert.match(html, /0\/1<\/strong>必需任务验收项证据齐备/)
  assert.match(html, /<li>重试不重复<\/li>/)
  assert.doesNotMatch(html, /确认交付并完成目标/)
})

test('historical or superseded review approval does not appear as current approval', () => {
  const mission = missionFixture()
  assert.match(render(mission), /审查通过（历史提交）/)
  assert.doesNotMatch(render(mission), /当前提交审查通过/)
  mission.tasks[0].latestReview.isCurrentAttempt = true
  assert.match(render(mission), /当前提交审查通过/)
  mission.tasks[0].latestReview.submissionStatus = 'superseded'
  assert.doesNotMatch(render(mission), /当前提交审查通过/)
})

test('final delivery requires the reviewing state, a frozen version and operator access', () => {
  const mission = { ...missionFixture(), status: 'reviewing' }
  assert.doesNotMatch(render(mission), /确认交付并完成目标/)
  mission.finalDelivery = { artifactVersionId: 'version', artifactId: 'artifact', version: 1, contentHash: 'hash', approvalStatus: 'ready' }
  assert.match(render(mission), /退回并追加修复任务/)
  assert.match(render(mission), /确认交付并完成目标/)
  assert.doesNotMatch(render(mission, { canOperate: false }), /确认交付并完成目标/)
  mission.status = 'completed'
  assert.doesNotMatch(render(mission), /确认交付并完成目标/)
})

test('task and evidence text is escaped rather than rendered as agent-supplied HTML', () => {
  const mission = missionFixture()
  mission.tasks[0].description = '<script>window.compromised=true</script>'
  mission.tasks[0].acceptanceCriteria[0].evidence = [{
    id: 'evidence', kind: 'test_run', summary: '<img src=x onerror=alert(1)>',
    createdAt: '2026-09-26T00:00:00Z', artifactVersionId: null,
  }]
  const html = render(mission)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<script>|<img src=x/)
})

test('exhausted budget preserves task state and presents budget controls instead of a failure', () => {
  const mission = missionFixture()
  mission.tasks[0].status = 'waiting_human'
  mission.budget = { ...mission.budget, tokenLimit: 1000, inputTokens: 800, outputTokens: 250, totalTokens: 1050, remainingTokens: 0, status: 'exhausted', inFlightCalls: 1 }
  const html = render(mission)
  assert.match(html, /等待追加预算/)
  assert.match(html, /1,050/)
  assert.match(html, /保存限额并继续/)
  assert.match(html, /移除限额并继续/)
  assert.match(html, /当前有 1 次模型调用尚未结算/)
  assert.match(html, /在途调用结算后可能超过限额/)
  assert.doesNotMatch(html, /批准额外一次尝试|已失败|\$0\.0000/)
  assert.equal(goalNextStep(mission).title, '等待追加预算')
  assert.match(html, /disabled=""[^>]*><svg[^]*?继续执行/)
})

test('unknown usage and unpriced calls are disclosed without implying zero cost or that more tokens resolve uncertainty', () => {
  const mission = missionFixture()
  mission.budget = { ...mission.budget, tokenLimit: 10000, inputTokens: 500, totalTokens: 500, remainingTokens: 9500, unknownUsageCalls: 2, unpricedCalls: 3, status: 'usage_unknown' }
  const html = render(mission)
  assert.match(html, /2 次调用未返回用量/)
  assert.match(html, /提高限额不会补齐缺失用量/)
  assert.match(html, /3 次调用未计价/)
  assert.doesNotMatch(html, /\$0\.0000/)
  assert.equal(goalNextStep(mission).title, '等待核实模型用量')
})

test('budget controls respect access and distinguish saving while planning from resuming a running goal', () => {
  const mission = missionFixture()
  mission.budget = { ...mission.budget, tokenLimit: 10000, status: 'available' }
  assert.doesNotMatch(render(mission, { canOperate: false }), /调整 Token 总限额|保存限额|移除限额/)
  mission.status = 'planning'
  const planning = render(mission)
  assert.match(planning, />保存限额<\/button>/)
  assert.match(planning, />移除限额<\/button>/)
  assert.doesNotMatch(planning, /保存限额并继续|移除限额并继续/)
  mission.status = 'completed'
  assert.doesNotMatch(render(mission), /调整 Token 总限额/)
})

test('goal verification is identified separately and never substitutes for human delivery approval', () => {
  const mission = missionFixture()
  mission.goalVerification = true
  mission.verificationTaskId = 'task'
  assert.match(render(mission), /目标终验：基于整合后的成果/)
  assert.equal(goalNextStep(mission).title, '正在核对完整目标')
  mission.status = 'reviewing'
  mission.finalDelivery = { artifactVersionId: 'version', artifactId: 'artifact', version: 1, contentHash: 'hash', approvalStatus: 'ready' }
  assert.doesNotMatch(render(mission), /确认交付并完成目标/)
  assert.match(render(mission), /目标终验尚未完成/)
  mission.tasks[0].status = 'completed'
  assert.match(render(mission), /确认交付并完成目标/)
  assert.match(render(mission), /通过后仍需你确认交付/)
})

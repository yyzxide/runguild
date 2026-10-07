import type { missionApi } from './api'

type MessageInput = Parameters<typeof missionApi.postMessage>[0]
type PlanningInput = Parameters<typeof missionApi.createPlanningRequest>[0]
export type ComposerIntent = 'message' | 'task'

export function inferComposerIntent(value: string): ComposerIntent {
  if (/^\/goal(?:\s|$)/.test(value.trim())) return 'task'
  const taskMarker = /(?:帮我|请.{0,12}(?:实现|开发|完成|修复|优化|重构|新增|添加|设计|测试|部署|编写|创建|构建|搭建|接入|排查)|实现|开发|完成|修复|优化|重构|新增|添加|设计|测试|部署|编写|创建|构建|搭建|接入|排查|做一个|build|implement|fix|refactor|create|deploy|test)/iu
  return taskMarker.test(value.trim()) ? 'task' : 'message'
}

export function parseGoalCommand(value: string): { readonly explicit: boolean; readonly goal: string } {
  const body = value.trim()
  const explicit = /^\/goal(?:\s|$)/.test(body)
  const goal = explicit ? body.slice(5).trim() : body
  if (explicit && !goal) throw new Error('请在 /goal 后描述要完成的目标，例如：/goal 为导入功能增加错误行预览。')
  if (!goal) throw new Error('请先描述目标或补充内容。')
  return { explicit, goal }
}

export function goalItems(value: string, label: string): readonly string[] {
  const items = value.split('\n').map((item) => item.trim()).filter(Boolean)
  if (items.length > 100 || items.some((item) => item.length > 2_000)) {
    throw new Error(`${label}最多 100 项，每项最多 2000 个字符，请分行填写。`)
  }
  return items
}

export function parseGoalBudget(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error('Token 总限额请输入非负整数；留空表示不限额。')
  }
  return Number(trimmed)
}

export interface RoomSubmission {
  readonly message: MessageInput
  readonly planning?: Omit<PlanningInput, 'sourceMessageIds'>
}

/** Freeze routing and operation keys together so a retry cannot drift into another Mission. */
export function createRoomSubmission(input: {
  readonly identity: MessageInput['identity']
  readonly conversationId: string
  readonly draft: string
  readonly acceptanceText: string
  readonly constraintText: string
  readonly budgetText?: string
  readonly missionId?: string
  readonly planningActive: boolean
  readonly intent?: ComposerIntent
  readonly plannerAgentId?: string
  readonly selectedAgents: readonly string[]
  readonly replyToMessageId?: string
}, operationId: string): RoomSubmission {
  const parsed = parseGoalCommand(input.draft)
  const createsGoal = parsed.explicit || (!input.missionId && !input.planningActive && input.intent !== 'message')
  if (createsGoal && !input.plannerAgentId) throw new Error('当前工作区缺少规划 Agent，请先完成团队配置。')
  const acceptanceCriteria = createsGoal ? goalItems(input.acceptanceText, '验收条件') : []
  const constraints = createsGoal ? goalItems(input.constraintText, '约束') : []
  const budgetTokens = createsGoal ? parseGoalBudget(input.budgetText ?? '') : null
  if (createsGoal && new TextEncoder().encode(parsed.goal).length > 20_000) {
    throw new Error('目标过长，请缩短到 20000 UTF-8 字节以内，再把验收条件和约束分项填写。')
  }
  const body = [
    input.draft.trim(),
    ...(acceptanceCriteria.length ? ['\n验收条件：', ...acceptanceCriteria.map((item) => '- ' + item)] : []),
    ...(constraints.length ? ['\n约束：', ...constraints.map((item) => '- ' + item)] : []),
  ].join('\n')
  if (new TextEncoder().encode(body).length > 65_536) throw new Error('目标及验收材料过长，请精简后再提交。')
  return {
    message: {
      identity: input.identity,
      conversationId: input.conversationId,
      body,
      // Planning consumes the source explicitly. Do not also route a new goal into a live Agent Run.
      mentions: createsGoal ? [] : input.selectedAgents,
      clientRequestId: operationId,
      ...(!createsGoal && input.missionId ? { missionId: input.missionId } : {}),
      ...(!createsGoal && input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      idempotencyKey: 'web-message-' + operationId,
    },
    ...(createsGoal ? { planning: {
      identity: input.identity,
      conversationId: input.conversationId,
      title: parsed.goal.split('\n')[0]!.slice(0, 80),
      goal: parsed.goal,
      budgetTokens,
      goalVerification: true,
      ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
      ...(constraints.length ? { constraints } : {}),
      plannerAgentId: input.plannerAgentId,
      idempotencyKey: 'web-planning-' + operationId,
    } } : {}),
  }
}

/** A new goal and its source message share one transaction and one durable request ID. */
export async function submitRoomSubmission(
  api: Pick<typeof missionApi, 'postMessage' | 'submitConversationTask' | 'getMission'>,
  submission: RoomSubmission,
) {
  if (!submission.planning) return { message: await api.postMessage(submission.message) }
  const { idempotencyKey: _planningKey, ...planning } = submission.planning
  const { idempotencyKey: _messageKey, missionId: _missionId, ...message } = submission.message
  const result = await api.submitConversationTask({ ...message, ...planning, plannerAgentId: planning.plannerAgentId! })
  const mission = await api.getMission(planning.identity, result.request.missionId)
  return { message: result.message, planningRequest: result.request, mission }
}

/** Version 1 remains readable after upgrades; omitted Goal fields must stay omitted on replay. */
export interface PendingConversationSubmission {
  readonly version: 1
  readonly clientRequestId: string
  readonly conversationId: string
  readonly intent: ComposerIntent
  readonly body: string
  readonly mentions: readonly string[]
  readonly replyToMessageId?: string
  readonly missionId?: string
  readonly title?: string
  readonly plannerAgentId?: string
  readonly goal?: string
  readonly constraints?: readonly string[]
  readonly acceptanceCriteria?: readonly string[]
  readonly budgetTokens?: number | null
  readonly goalVerification?: boolean
}

export function pendingSubmissionKey(identity: MessageInput['identity'], conversationId: string): string {
  return ['runguild:pending-submission', identity.workspaceId, identity.userId, conversationId].join(':')
}

export function readPendingSubmission(storage: Pick<Storage, 'getItem'>, identity: MessageInput['identity'], conversationId: string): PendingConversationSubmission | null {
  const raw = storage.getItem(pendingSubmissionKey(identity, conversationId))
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PendingConversationSubmission>
    if (value.version !== 1 || typeof value.clientRequestId !== 'string' || !value.clientRequestId
        || value.conversationId !== conversationId
        || (value.intent !== 'message' && value.intent !== 'task')
        || typeof value.body !== 'string' || !Array.isArray(value.mentions)
        || !value.mentions.every((id) => typeof id === 'string')) return null
    if (value.intent === 'task' && (typeof value.title !== 'string' || typeof value.plannerAgentId !== 'string')) return null
    for (const field of ['goal', 'replyToMessageId', 'missionId'] as const) {
      if (value[field] !== undefined && typeof value[field] !== 'string') return null
    }
    for (const field of ['constraints', 'acceptanceCriteria'] as const) {
      if (value[field] !== undefined && (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === 'string'))) return null
    }
    if (value.goalVerification !== undefined && typeof value.goalVerification !== 'boolean') return null
    if (value.budgetTokens !== undefined && value.budgetTokens !== null
        && (!Number.isSafeInteger(value.budgetTokens) || value.budgetTokens < 0)) return null
    return value as PendingConversationSubmission
  } catch {
    return null
  }
}

export function pendingRoomSubmission(submission: RoomSubmission): PendingConversationSubmission {
  const { identity: _identity, idempotencyKey: _messageKey, ...message } = submission.message
  const { identity: _planningIdentity, idempotencyKey: _planningKey, ...planning } = submission.planning ?? {}
  return { version: 1, intent: submission.planning ? 'task' : 'message', ...message, ...planning }
}

export function restoreRoomSubmission(identity: MessageInput['identity'], pending: PendingConversationSubmission): RoomSubmission {
  const { version: _version, intent, title, plannerAgentId, goal, constraints, acceptanceCriteria, budgetTokens, goalVerification, ...message } = pending
  return {
    message: { identity, ...message },
    ...(intent === 'task' ? { planning: {
      identity, conversationId: pending.conversationId, title: title!, plannerAgentId: plannerAgentId!,
      ...(goal === undefined ? {} : { goal }),
      ...(constraints === undefined ? {} : { constraints }),
      ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
      ...(budgetTokens === undefined ? {} : { budgetTokens }),
      ...(goalVerification === undefined ? {} : { goalVerification }),
    } } : {}),
  }
}

export function sameSubmission(left: PendingConversationSubmission, right: PendingConversationSubmission): boolean {
  // Normalize optional-field ordering as persisted requests can come from the previous UI.
  const comparable = (value: PendingConversationSubmission) => Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'clientRequestId').sort(([a], [b]) => a.localeCompare(b)),
  )
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
}

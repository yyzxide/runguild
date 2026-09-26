import type { missionApi } from './api'

type MessageInput = Parameters<typeof missionApi.postMessage>[0]
type PlanningInput = Parameters<typeof missionApi.createPlanningRequest>[0]

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
  readonly plannerAgentId?: string
  readonly selectedAgents: readonly string[]
  readonly replyToMessageId?: string
}, operationId: string): RoomSubmission {
  const parsed = parseGoalCommand(input.draft)
  const createsGoal = parsed.explicit || (!input.missionId && !input.planningActive)
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

/** Both POSTs deliberately replay with the frozen keys if either response was lost. */
export async function submitRoomSubmission(
  api: Pick<typeof missionApi, 'postMessage' | 'createPlanningRequest' | 'getMission'>,
  submission: RoomSubmission,
) {
  const message = await api.postMessage(submission.message)
  if (!submission.planning) return { message }
  const planningRequest = await api.createPlanningRequest({ ...submission.planning, sourceMessageIds: [message.id] })
  const mission = await api.getMission(submission.planning.identity, planningRequest.missionId)
  return { message, planningRequest, mission }
}

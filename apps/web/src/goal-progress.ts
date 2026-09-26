import type { MissionSnapshot } from './api'
import type { MissionTask, TaskStatus } from './data'

export const goalStatusLabels: Record<string, string> = {
  draft: '草稿', planning: '规划中', awaiting_approval: '等待批准计划', running: '执行中',
  paused: '已暂停', reviewing: '等待最终验收', completed: '已完成', failed: '已失败', cancelled: '已取消',
}

export const taskStatusLabels: Record<string, string> = {
  blocked: '等待依赖', ready: '等待领取', claimed: '已领取', running: '执行中',
  waiting_human: '需要人工处理', reviewing: '评审或集成中', completed: '已完成',
  failed: '尝试已停止', cancelled: '已取消',
}

export const roleLabels: Record<string, string> = {
  planner: '规划', researcher: '研究', builder: '实现', reviewer: '审查', custom: '自定义',
}

export const budgetStatusLabels: Record<MissionSnapshot['budget']['status'], string> = {
  unlimited: '未设限额', available: '预算可用', exhausted: '等待追加预算', usage_unknown: '等待核实用量',
}

export function budgetBlocksExecution(mission: MissionSnapshot): boolean {
  return mission.budget?.status === 'exhausted' || mission.budget?.status === 'usage_unknown'
}

export function goalVerificationComplete(mission: MissionSnapshot): boolean {
  return !mission.goalVerification || mission.tasks.some((task) => task.id === mission.verificationTaskId && task.status === 'completed')
}

export function goalTaskTitle(mission: MissionSnapshot, task: MissionSnapshot['tasks'][number]): string {
  return task.id === mission.verificationTaskId ? '目标终验' : task.title
}

export function currentReviewApproved(task: MissionSnapshot['tasks'][number]): boolean {
  return task.latestReview?.isCurrentAttempt === true
    && task.latestReview.status === 'approved'
    && task.latestReview.submissionStatus === 'approved'
}

export function canRetryTask(mission: MissionSnapshot, task: MissionSnapshot['tasks'][number]): boolean {
  return mission.status === 'running' && task.status === 'failed'
    && task.dependsOn.every((id) => mission.tasks.some((dependency) => dependency.id === id && dependency.status === 'completed'))
}

export function goalNextStep(mission: MissionSnapshot): { title: string; detail: string } {
  if (mission.status === 'completed') return { title: '交付已确认', detail: '可以查看批准版本与对应的任务、评审和证据。' }
  if (['failed', 'cancelled', 'paused'].includes(mission.status)) return {
    title: goalStatusLabels[mission.status] ?? mission.status,
    detail: '当前目标没有继续执行。已有成果和执行记录保留在下方。',
  }
  if (['planning', 'running'].includes(mission.status) && budgetBlocksExecution(mission)) return mission.budget.status === 'exhausted'
    ? { title: '等待追加预算', detail: '已知 Token 用量达到限额，后续模型调用正在等待。已有成果保留；提高或移除限额后可以继续。' }
    : { title: '等待核实模型用量', detail: '部分调用未返回用量，无法核实剩余预算，后续模型调用正在等待。请检查运行记录；继续保持限额时，提高额度不能消除这项缺口。' }
  if (mission.status === 'awaiting_approval') return { title: '请确认计划与验收条件', detail: '批准后按依赖分配任务；互不依赖的任务可由可用 Agent 并行执行。' }
  if (mission.status === 'reviewing') return {
    title: mission.finalDelivery ? '请验收最终交付' : '任务已完成，交付版本尚未就绪',
    detail: '逐项核对原始目标。发现遗漏可以填写修改要求，系统将追加修复任务。',
  }
  const failed = mission.tasks.filter((task) => task.status === 'failed')
  if (failed.length) return { title: `${failed.length} 项任务需要处理`, detail: '查看失败记录与评审意见；确认修复方向后，可以批准额外一次尝试。' }
  const waiting = mission.tasks.filter((task) => task.status === 'waiting_human')
  if (waiting.length) return { title: `${waiting.length} 项任务等待人工处理`, detail: '打开对应运行记录查看等待原因，或进入协作室补充说明。' }
  if (!mission.tasks.length) return { title: '正在形成执行计划', detail: 'Planner 将根据目标、约束和验收条件提出分工，提交后由你确认。' }
  const verification = mission.tasks.find((task) => task.id === mission.verificationTaskId)
  if (verification && !['blocked', 'completed', 'failed', 'cancelled'].includes(verification.status)) return {
    title: '正在核对完整目标', detail: '终验任务基于已集成的结果，逐项核对原始目标和验收条件。通过后仍由你确认最终交付。',
  }
  const active = mission.tasks.filter((task) => ['running', 'claimed', 'reviewing'].includes(task.status)).length
  return active
    ? { title: `${active} 项任务正在推进`, detail: '查看团队当前分工、依赖交接以及证据和评审结果。' }
    : { title: '等待任务调度', detail: '如果状态持续不变，请检查执行环境和依赖任务。' }
}

export function runDuration(start: string | null, end: string | null, now = Date.now()): string {
  if (!start) return '尚未开始'
  const elapsed = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000))
  if (!Number.isFinite(elapsed)) return '未知'
  return elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
}

export function graphTasks(mission: MissionSnapshot): MissionTask[] {
  return mission.tasks.map((task, index) => {
    const status: TaskStatus = task.status === 'completed' ? 'verified'
      : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled'
      : ['claimed', 'running', 'reviewing'].includes(task.status) ? 'running'
      : ['blocked', 'waiting_human'].includes(task.status) ? 'waiting' : 'queued'
    return {
      id: task.id, key: task.id === mission.verificationTaskId ? '目标终验' : `任务 ${index + 1}`, title: goalTaskTitle(mission, task),
      role: roleLabels[task.role ?? 'custom'] ?? task.role ?? '待分配',
      agent: task.latestRun?.agentName ?? '尚未领取', status,
      statusLabel: taskStatusLabels[task.status] ?? task.status,
      summary: task.description,
      duration: task.latestRun ? runDuration(task.latestRun.startedAt, task.latestRun.finishedAt) : '尚未开始',
      attempts: task.attemptCount, model: task.latestRun?.modelName ?? '尚无模型调用', dependsOn: task.dependsOn,
      criteria: task.acceptanceCriteria.map((criterion) => ({ label: criterion.description, passed: criterion.evidenceStatus === 'complete' })),
    }
  })
}

/** Plain text from the canonical document, never HTML supplied by an Agent. */
export function artifactText(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 30) return ''
  const node = value as Record<string, unknown>
  if (typeof node.text === 'string') return node.text
  if (!Array.isArray(node.content)) return ''
  return node.content.map((child) => artifactText(child, depth + 1)).join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n')
}

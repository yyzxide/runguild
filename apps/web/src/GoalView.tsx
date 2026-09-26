import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, CircleAlert, Clock3, FileStack, LoaderCircle, MessageCircle, Play, RefreshCw, RotateCcw, Settings, ShieldCheck, Target } from 'lucide-react'
import { missionApi, type MissionSnapshot, type TestIdentity } from './api'
import { MissionGraph } from './MissionGraph'
import { artifactText, budgetBlocksExecution, budgetStatusLabels, canRetryTask, currentReviewApproved, goalNextStep, goalStatusLabels, goalTaskTitle, goalVerificationComplete, graphTasks, roleLabels, runDuration, taskStatusLabels } from './goal-progress'
import { parseGoalBudget } from './goal-command'
import './GoalView.css'

type Task = MissionSnapshot['tasks'][number]
const evidenceLabels: Record<string, string> = {
  test_run: '测试', file_diff: '代码改动', command_result: '命令验证', artifact_version: '交付版本',
  citation: '来源', human_attestation: '人工确认', trace_span: '执行记录',
}
const reviewLabels: Record<string, string> = {
  requested: '等待审查', in_progress: '审查中', approved: '审查通过', rejected: '审查拒绝',
  changes_requested: '要求修改', cancelled: '审查已取消',
}
const integrationLabels: Record<string, string> = {
  pending: '等待准备', provisioning: '准备中', ready: '隔离执行中', failed: '准备失败',
  awaiting_integration: '等待合并验证', integrating: '合并验证中', integrated: '已集成',
  conflict: '需要解决合并冲突', integration_failed: '集成失败', cleaned: '已清理',
  committed: '已提交，等待审查与集成', cleanup_pending: '集成完成，等待清理', removed: '隔离工作区已清理',
}

function EvidenceChecklist({ task }: { readonly task: Task }) {
  return <div className="goal-evidence-list">
    {task.acceptanceCriteria.length === 0 ? <p className="goal-muted">这项任务没有记录验收条件。</p> : task.acceptanceCriteria.map((criterion) => (
      <div className="goal-criterion" key={criterion.id}>
        <div className="goal-criterion-heading">
          {criterion.evidenceStatus === 'complete' ? <Check size={17} /> : <Clock3 size={17} />}
          <strong>{criterion.description}</strong>
          <span>{criterion.evidenceStatus === 'complete' ? '证据齐备' : '证据待补'}{criterion.required ? '' : ' · 可选'}</span>
        </div>
        <p className="goal-muted">需要：{criterion.requiredEvidenceKinds.length ? criterion.requiredEvidenceKinds.map((kind) => evidenceLabels[kind] ?? kind).join('、') : '至少一份有效证据'}</p>
        {criterion.evidence.length ? <details><summary>查看 {criterion.evidence.length} 份有效证据</summary><ul>{criterion.evidence.map((evidence) => <li key={evidence.id}>
          <span>{evidenceLabels[evidence.kind] ?? evidence.kind} · {new Date(evidence.createdAt).toLocaleString('zh-CN')}</span>
          <p>{evidence.summary || '已记录证据，尚无文字摘要。'}</p>
          <code>{evidence.id}</code>
        </li>)}</ul></details> : null}
      </div>
    ))}
    <p className="goal-muted">证据按当前尝试、提交版本和有效期核对；独立评审与集成结果另列。</p>
  </div>
}

function TaskDetail({ task, mission, busy, canOperate, onSelectTask, onOpenRun, onRetryTask }: {
  readonly task: Task
  readonly mission: MissionSnapshot
  readonly busy: string | null
  readonly canOperate: boolean
  readonly onSelectTask: (id: string) => void
  readonly onOpenRun: (id: string) => void
  readonly onRetryTask: (id: string, reason: string) => void
}) {
  const [retryReason, setRetryReason] = useState('')
  const run = task.latestRun
  const review = task.latestReview
  const reviewCurrent = review?.isCurrentAttempt && !['superseded', 'cancelled'].includes(review.submissionStatus)
  const consumers = mission.tasks.filter((item) => item.dependsOn.includes(task.id))
  return <section className="goal-task-detail" aria-label="任务详情">
    <div className="goal-section-heading"><div><span className="micro-label">{roleLabels[task.role ?? 'custom'] ?? task.role} · {taskStatusLabels[task.status] ?? task.status}</span><h2>{goalTaskTitle(mission, task)}</h2></div></div>
    {task.id === mission.verificationTaskId ? <p className="goal-verification-note"><ShieldCheck size={16} />目标终验：基于整合后的成果，核对原始目标与验收条件。通过后仍需人工确认交付。</p> : null}
    <p className="goal-description">{task.description}</p>
    <dl className="goal-run-facts">
      <div><dt>{['running', 'claimed'].includes(task.status) ? '执行者' : '最近执行者'}</dt><dd>{run?.agentName ?? '尚未领取'}</dd></div>
      <div><dt>尝试次数</dt><dd>{task.attemptCount} / {task.maxAttempts}</dd></div>
      <div><dt>最近运行耗时</dt><dd>{run ? runDuration(run.startedAt, run.finishedAt) : '尚未开始'}</dd></div>
      <div><dt>{run?.modelSource === 'configured' ? '配置模型（尚无调用）' : '实际调用模型'}</dt><dd>{run?.modelName || '尚无模型调用'}</dd></div>
    </dl>
    {run ? <div className="goal-run-summary">{run.completionSummary ? <p>{run.completionSummary}</p> : null}<button className="quiet-action" onClick={() => onOpenRun(run.id)}>查看这次运行与错误记录<ArrowRight size={14} /></button></div> : null}
    <div className="goal-handoffs">
      <h3>依赖与交接</h3>
      {task.dependsOn.length ? <div><span>接收上游结果</span>{task.dependsOn.map((id) => {
        const upstream = mission.tasks.find((item) => item.id === id)
        return <button key={id} onClick={() => onSelectTask(id)}>{upstream?.title ?? '依赖任务'}<small>{upstream?.status === 'completed' ? '已完成，可使用结果' : '等待完成'}</small></button>
      })}</div> : <p className="goal-muted">没有前置任务，可独立领取。</p>}
      {consumers.length ? <div><span>结果交给</span>{consumers.map((item) => <button key={item.id} onClick={() => onSelectTask(item.id)}>{item.title}<small>{taskStatusLabels[item.status] ?? item.status}</small></button>)}</div> : null}
    </div>
    <h3>任务验收证据</h3>
    <EvidenceChecklist task={task} />
    <div className="goal-review">
      <h3>独立评审与集成</h3>
      {review ? <><strong>{currentReviewApproved(task) ? '当前提交审查通过' : `${reviewLabels[review.status] ?? review.status}${reviewCurrent ? '' : '（历史提交）'}`}</strong><p>{review.summary || '尚未记录评审意见。'}</p><small>{review.reviewerName ?? '待分配审查者'} · {new Date(review.resolvedAt ?? review.createdAt).toLocaleString('zh-CN')}</small></>
        : <p className="goal-muted">{task.reviewRequired ? '尚无独立评审结果。' : '这项任务未要求独立评审。'}</p>}
      {task.integration ? <div className="goal-integration"><strong>{task.integration.integratedCommit ? '已集成已审查提交' : integrationLabels[task.integration.status] ?? task.integration.status}</strong>{task.integration.lastError ? <p role="status">{task.integration.lastError}</p> : null}<details><summary>提交记录</summary><p>当前提交：<code>{task.integration.headCommit ?? '尚未提交'}</code></p><p>集成提交：<code>{task.integration.integratedCommit ?? '尚未集成'}</code></p></details></div> : null}
    </div>
    {canOperate && canRetryTask(mission, task) ? <form className="goal-retry" onSubmit={(event) => { event.preventDefault(); if (retryReason.trim()) onRetryTask(task.id, retryReason.trim()) }}>
      <label htmlFor={`retry-${task.id}`}>重试原因</label>
      <textarea id={`retry-${task.id}`} value={retryReason} onChange={(event) => setRetryReason(event.target.value)} maxLength={2_000} placeholder="例如：测试环境已修复，请基于保留的改动重新验证。" required />
      <p className="goal-muted">原因写入操作记录，保留已有成果并增加一次执行机会。补充实现要求请通过协作室发送。</p>
      <button className="secondary-action" disabled={Boolean(busy) || !retryReason.trim()}><RotateCcw size={15} />批准额外一次尝试</button>
    </form> : null}
  </section>
}

function GoalBudget({ mission, canOperate, busy, onUpdateBudget }: {
  readonly mission: MissionSnapshot
  readonly canOperate: boolean
  readonly busy: string | null
  readonly onUpdateBudget: (tokenLimit: number | null) => void
}) {
  const budget = mission.budget
  const [limit, setLimit] = useState(budget.tokenLimit?.toString() ?? '')
  const [inputError, setInputError] = useState<string | null>(null)
  useEffect(() => {
    setLimit(budget.tokenLimit?.toString() ?? '')
    setInputError(null)
  }, [mission.id, budget.tokenLimit])
  return <section className="goal-budget" aria-label="目标预算">
    <div className="goal-section-heading"><div><span className="micro-label">规划 · 执行 · 审查 · 终验</span><h2>目标预算</h2></div><span role="status">{budgetStatusLabels[budget.status]}</span></div>
    <dl className="goal-budget-facts">
      <div><dt>已知 Token 用量</dt><dd>{budget.totalTokens.toLocaleString('zh-CN')}<small>输入 {budget.inputTokens.toLocaleString('zh-CN')} · 输出 {budget.outputTokens.toLocaleString('zh-CN')}</small></dd></div>
      <div><dt>Token 总限额</dt><dd>{budget.tokenLimit === null ? '不限额' : budget.tokenLimit.toLocaleString('zh-CN')}{budget.remainingTokens !== null ? <small>已知剩余 {budget.remainingTokens.toLocaleString('zh-CN')}</small> : null}</dd></div>
      <div><dt>{budget.unpricedCalls ? '已计价部分的估算费用' : '估算费用'}</dt><dd>{budget.estimatedCostUsd === null ? '暂无完整计价' : `$${budget.estimatedCostUsd.toFixed(4)}`}{budget.unpricedCalls ? <small>{budget.unpricedCalls} 次调用未计价</small> : null}</dd></div>
    </dl>
    {budget.unknownUsageCalls ? <p className="goal-budget-notice" role="status">{budget.unknownUsageCalls} 次调用未返回用量，上方数字仅包含已知部分。{budget.status === 'usage_unknown' ? '为遵守限额，后续模型调用正在等待；提高限额不会补齐缺失用量。移除限额可继续，但无法保证总用量。' : '实际总用量可能更高。'}</p> : null}
    {budget.status === 'exhausted' ? <p className="goal-budget-notice" role="status">已达到 Token 限额，后续模型调用正在等待，已有成果保留。提高或移除限额后可以继续。</p> : null}
    <p className="goal-muted">{budget.inFlightCalls ? `当前有 ${budget.inFlightCalls} 次模型调用尚未结算。` : ''}限额在新调用前检查；在途调用结算后可能超过限额。</p>
    {canOperate && !['completed', 'cancelled', 'failed'].includes(mission.status) ? <form className="goal-budget-form" onSubmit={(event) => {
      event.preventDefault()
      try {
        const tokenLimit = parseGoalBudget(limit)
        if (tokenLimit === null) throw new Error('请输入 Token 总限额；取消限制请使用“移除限额并继续”按钮。')
        setInputError(null)
        onUpdateBudget(tokenLimit)
      } catch (error) {
        setInputError(error instanceof Error ? error.message : '请输入有效限额。')
      }
    }}>
      <label htmlFor="goal-budget-limit">调整 Token 总限额<input id="goal-budget-limit" inputMode="numeric" disabled={Boolean(busy)} value={limit} onChange={(event) => { setLimit(event.target.value); setInputError(null) }} placeholder="例如 200000" aria-describedby="goal-budget-help" /></label>
      <div className="goal-budget-actions"><button className="secondary-action" disabled={Boolean(busy) || !limit.trim()}>{busy === 'update-budget' ? <LoaderCircle size={15} className="is-spinning" /> : null}{mission.status === 'running' ? '保存限额并继续' : '保存限额'}</button>{budget.tokenLimit !== null ? <button className="quiet-action" type="button" disabled={Boolean(busy)} onClick={() => { setInputError(null); onUpdateBudget(null) }}>{mission.status === 'running' ? '移除限额并继续' : '移除限额'}</button> : null}</div>
      <p id="goal-budget-help" className="goal-muted">这是整个目标累计用量的上限，修改不会清零已有用量。0 会阻止新的模型调用。</p>
      {inputError ? <p className="goal-budget-validation" role="alert">{inputError}</p> : null}
    </form> : null}
  </section>
}

function DeliveryPreview({ identity, mission }: { readonly identity: TestIdentity; readonly mission: MissionSnapshot }) {
  const [preview, setPreview] = useState<{ text?: string; error?: string } | null>(null)
  const versionId = mission.finalDelivery?.artifactVersionId
  useEffect(() => {
    setPreview(null)
    if (!versionId) return
    let active = true
    void missionApi.getArtifactVersion(identity, versionId)
      .then((version) => { if (active) setPreview({ text: artifactText(version.content).slice(0, 8_000) }) })
      .catch((error: unknown) => { if (active) setPreview({ error: error instanceof Error ? error.message : '交付内容读取失败' }) })
    return () => { active = false }
  }, [identity, versionId])
  if (!versionId) return <p className="goal-muted">最终交付版本尚未生成。</p>
  if (!preview) return <p className="goal-muted">正在读取交付内容…</p>
  if (preview.error) return <p role="alert">{preview.error}</p>
  return <div className="goal-delivery-preview">{preview.text || '该版本没有可显示的文本，请打开产物查看完整内容。'}</div>
}

export function GoalView({ identity, mission, busy, error, canOperate, onNavigate, onRefresh, onApprovePlan, onStartExecution, onOpenRuntime, onOpenRun, onUpdateBudget, onRetryTask, onApproveDelivery, onRequestDeliveryChanges }: {
  readonly identity: TestIdentity
  readonly mission: MissionSnapshot | null
  readonly busy: string | null
  readonly error: string | null
  readonly canOperate: boolean
  readonly onNavigate: (view: 'team' | 'artifacts' | 'trace' | 'start') => void
  readonly onRefresh: () => void
  readonly onApprovePlan: () => void
  readonly onStartExecution: () => void
  readonly onOpenRuntime: () => void
  readonly onOpenRun: (id: string) => void
  readonly onUpdateBudget: (tokenLimit: number | null) => void
  readonly onRetryTask: (id: string, reason: string) => void
  readonly onApproveDelivery: () => void
  readonly onRequestDeliveryChanges: (reason: string) => void
}) {
  const [selectedId, setSelectedId] = useState('')
  const [feedback, setFeedback] = useState('')
  const tasks = useMemo(() => mission ? graphTasks(mission) : [], [mission])
  useEffect(() => { setSelectedId(''); setFeedback('') }, [mission?.id])
  const selected = mission?.tasks.find((task) => task.id === selectedId) ?? mission?.tasks.find((task) => task.status === 'failed') ?? mission?.tasks.find((task) => task.status !== 'completed') ?? mission?.tasks[0]
  if (!mission) return <section className="product-empty-state"><span><Target size={26} /></span><div><span className="micro-label">目标工作区</span><h1>把一个可验收的目标交给团队</h1><p>在协作室输入 /goal 和你的目标，补充验收条件与约束。确认计划后，在这里跟进分工、证据和交付。</p></div><button className="primary-action" onClick={() => onNavigate('team')}>创建目标<ArrowRight size={15} /></button></section>
  const next = goalNextStep(mission)
  const required = mission.tasks.flatMap((task) => task.acceptanceCriteria.filter((criterion) => criterion.required))
  const complete = required.filter((criterion) => criterion.evidenceStatus === 'complete').length
  return <div className="goal-workspace">
    <section className="page-heading"><div><div className="breadcrumb"><span>目标</span><i>/</i><span>{goalStatusLabels[mission.status]}</span></div><h1>{mission.title}</h1><p className="goal-description">{mission.goal}</p></div><div className="page-actions"><button className="secondary-action" disabled={Boolean(busy)} onClick={onRefresh}><RefreshCw size={15} />刷新</button><button className="secondary-action" onClick={() => onNavigate('team')}><MessageCircle size={15} />协作室</button></div></section>
    {error ? <div className="goal-error" role="alert"><CircleAlert size={18} /><span>{error}</span></div> : null}
    <section className="goal-next-step" aria-label="下一步">
      <div><span className="micro-label">下一步</span><h2>{next.title}</h2><p>{next.detail}</p></div>
      <div className="goal-next-actions">
        {canOperate && mission.status === 'awaiting_approval' ? <button className="primary-action" disabled={Boolean(busy)} onClick={onApprovePlan}>{busy === 'approve' ? <LoaderCircle className="is-spinning" size={15} /> : <Play size={15} />}批准计划并开始执行</button> : null}
        {canOperate && mission.status === 'running' ? <><button className="secondary-action" disabled={Boolean(busy) || budgetBlocksExecution(mission)} onClick={onStartExecution}><Play size={15} />继续执行</button><button className="quiet-action" onClick={onOpenRuntime}><Settings size={15} />执行环境</button></> : null}
        {!canOperate ? <span className="goal-muted">当前为只读访问</span> : null}
      </div>
    </section>
    {mission.budget ? <GoalBudget mission={mission} canOperate={canOperate} busy={busy} onUpdateBudget={onUpdateBudget} /> : null}
    <section className="goal-contract">
      <div><h2>目标验收清单</h2>{mission.acceptanceCriteria.length ? <ol>{mission.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol> : <p className="goal-muted">没有单独填写目标验收条件；请结合原始目标与下方任务计划核对交付范围。</p>}<p className="goal-muted">这份清单在最终交付时逐项核对；任务完成数不代表目标覆盖率。</p></div>
      <div><h2>执行约束</h2>{mission.constraints.length ? <ul>{mission.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul> : <p className="goal-muted">未额外指定约束。</p>}<div className="goal-counts"><span><strong>{mission.tasks.filter((task) => task.status === 'completed').length}/{mission.tasks.length}</strong>任务完成</span><span><strong>{complete}/{required.length}</strong>必需任务验收项证据齐备</span></div></div>
    </section>
    {mission.goalVerification ? <section className="goal-verification" aria-label="目标终验"><ShieldCheck size={20} /><div><h2>交付前核对完整目标</h2><p>{mission.verificationTaskId ? '终验任务检查整合后的成果是否满足原始目标与验收条件。' : '计划批准后，团队将在各项工作完成后执行目标终验。'}通过后仍需你确认交付，目标才会完成。</p>{mission.verificationTaskId ? <button className="quiet-action" onClick={() => setSelectedId(mission.verificationTaskId!)}>查看目标终验任务<ArrowRight size={14} /></button> : null}</div></section> : null}
    {mission.proposedPlan ? <details className="goal-plan" open={mission.status === 'awaiting_approval'}><summary>分工计划 · 版本 {mission.planVersion}</summary><p>{mission.proposedPlan.summary}</p>{!mission.tasks.length ? <ol>{mission.proposedPlan.plan.tasks.map((task) => <li key={task.key}><strong>{task.key === 'runguild-goal-verification' ? '目标终验' : task.title} · {roleLabels[task.role]}</strong><p>{task.description}</p><small>{task.dependsOn.length ? `依赖：${task.dependsOn.map((key) => mission.proposedPlan?.plan.tasks.find((item) => item.key === key)?.title ?? key).join('、')}` : '没有前置任务'} · {task.reviewRequired ? '需要独立评审' : '未要求独立评审'}</small><ul>{task.acceptanceCriteria.map((criterion) => <li key={criterion.key}>{criterion.description}{criterion.required ? '' : '（可选）'}</li>)}</ul></li>)}</ol> : null}</details> : null}
    {selected ? <>
      <div className="goal-team-work"><section className="goal-task-list" aria-label="团队分工"><div className="goal-section-heading"><h2>团队分工</h2><span>{mission.tasks.length} 项任务</span></div>{mission.tasks.map((task) => <button key={task.id} className={`goal-task-row${selected.id === task.id ? ' is-selected' : ''}`} aria-pressed={selected.id === task.id} onClick={() => setSelectedId(task.id)}><span className={`goal-task-status goal-task-status--${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span><strong>{goalTaskTitle(mission, task)}</strong><small>{task.latestRun?.agentName ?? '尚未领取'} · {roleLabels[task.role ?? 'custom'] ?? task.role}</small><span>{task.acceptanceCriteria.filter((criterion) => criterion.evidenceStatus === 'complete').length}/{task.acceptanceCriteria.length} 项证据齐备</span></button>)}</section>
      <TaskDetail key={selected.id} task={selected} mission={mission} busy={busy} canOperate={canOperate} onSelectTask={setSelectedId} onOpenRun={onOpenRun} onRetryTask={onRetryTask} /></div>
      <details className="goal-topology"><summary>查看任务依赖图</summary><MissionGraph tasks={tasks} selectedTaskId={selected.id} onSelectTask={setSelectedId} /></details>
    </> : <p className="goal-muted">批准计划后，这里会显示实际任务与交接关系。</p>}
    {mission.finalDelivery || mission.status === 'reviewing' || mission.status === 'completed' ? <section className="goal-delivery" aria-label="交付与最终验收"><div className="goal-section-heading"><div><span className="micro-label">{mission.status === 'completed' ? '已确认交付' : '交付候选'}</span><h2>交付内容</h2></div><button className="secondary-action" onClick={() => onNavigate('artifacts')}><FileStack size={15} />完整产物与历史版本</button></div><DeliveryPreview identity={identity} mission={mission} />
      {mission.finalDelivery ? <details><summary>当前交付版本 v{mission.finalDelivery.version}</summary><code>{mission.finalDelivery.artifactVersionId}</code><p>内容校验值：<code>{mission.finalDelivery.contentHash}</code></p></details> : null}
      {mission.status === 'reviewing' && !goalVerificationComplete(mission) ? <p className="goal-muted">目标终验尚未完成，完成后才能确认最终交付。</p> : null}
      {canOperate && mission.status === 'reviewing' && mission.finalDelivery && goalVerificationComplete(mission) ? <form className="goal-delivery-actions" onSubmit={(event) => { event.preventDefault(); if (feedback.trim()) onRequestDeliveryChanges(feedback.trim()) }}><label htmlFor="goal-feedback">未满足的验收项或具体修改要求</label><textarea id="goal-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={20_000} placeholder="例如：重复导入仍会产生重复数据，请修复并补充回归测试。" /><div><button className="secondary-action" disabled={Boolean(busy) || !feedback.trim()}><RotateCcw size={15} />退回并追加修复任务</button><button className="primary-action" type="button" disabled={Boolean(busy)} onClick={onApproveDelivery}><ShieldCheck size={15} />确认交付并完成目标</button></div></form> : null}
    </section> : null}
  </div>
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownRight,
  CircleAlert,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'

import {
  missionApi,
  type EvaluationExperimentReport,
  type EvaluationExperimentSummary,
  type EvaluationScenarioVersionSummary,
  type EvaluationTrial,
  type EvaluationVariant,
  type EvaluationVariantAggregate,
  type TestIdentity,
} from './api'

export interface EvaluationViewProps {
  readonly identity: TestIdentity
}

const statusLabels: Readonly<Record<string, string>> = {
  queued: '排队中',
  materializing: '创建 Mission',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest}秒`
  return `${minutes}分${String(rest).padStart(2, '0')}秒`
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`
}

function variantName(variant: EvaluationVariant): string {
  return variant === 'single_agent' ? '单 Agent' : '多 Agent'
}

function variantAggregate(
  report: EvaluationExperimentReport,
  variant: EvaluationVariant,
): EvaluationVariantAggregate | undefined {
  return report.variants.find((item) => item.variant === variant)
}

function errorSummary(error: Readonly<Record<string, unknown>> | undefined): string | null {
  if (!error) return null
  if (typeof error.message === 'string') return error.message
  if (typeof error.code === 'string') return error.code
  return 'Evaluation Worker 记录了未分类错误'
}

function TrialLane({ trial, maximumMs }: {
  readonly trial: EvaluationTrial | undefined
  readonly maximumMs: number
}) {
  if (!trial) return <div className="trial-lane trial-lane--missing"><span>未创建</span><i /><code>—</code></div>
  const metrics = trial.metrics
  const width = metrics ? Math.max(4, (metrics.wallTimeMs / Math.max(1, maximumMs)) * 100) : 4
  return (
    <div className={`trial-lane${trial.variant === 'multi_agent' ? ' trial-lane--multi' : ''}`}>
      <span>{variantName(trial.variant)}</span>
      <i style={{ width: `${width}%` }} />
      <code>{metrics ? `${formatDuration(metrics.wallTimeMs)} · ${formatCost(metrics.estimatedCostUsd)}` : statusLabels[trial.status] ?? trial.status}</code>
      {errorSummary(trial.error) ? <small>{errorSummary(trial.error)}</small> : null}
    </div>
  )
}

export function EvaluationView({ identity }: EvaluationViewProps) {
  const [experiments, setExperiments] = useState<readonly EvaluationExperimentSummary[] | null>(null)
  const [scenarioVersions, setScenarioVersions] = useState<readonly EvaluationScenarioVersionSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [report, setReport] = useState<EvaluationExperimentReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [reportLoading, setReportLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [scenarioVersionId, setScenarioVersionId] = useState('')
  const [experimentName, setExperimentName] = useState('单 Agent / 多 Agent 配对实验')
  const [repetitions, setRepetitions] = useState(1)

  const loadIndex = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextExperiments, nextVersions] = await Promise.all([
        missionApi.listEvaluationExperiments(identity),
        missionApi.listEvaluationScenarioVersions(identity),
      ])
      setExperiments(nextExperiments)
      setScenarioVersions(nextVersions)
      setScenarioVersionId((current) => current || nextVersions[0]?.id || '')
      setSelectedId((current) => current && nextExperiments.some((item) => item.id === current)
        ? current
        : nextExperiments[0]?.id ?? null)
      if (nextExperiments.length === 0) setReport(null)
    } catch (caught) {
      setExperiments([])
      setScenarioVersions([])
      setError(caught instanceof Error ? caught.message : 'Evaluation 数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [identity])

  useEffect(() => { void loadIndex() }, [loadIndex])

  useEffect(() => {
    if (!selectedId) {
      setReport(null)
      return
    }
    let cancelled = false
    setReportLoading(true)
    setReportError(null)
    void missionApi.getEvaluationReport(identity, selectedId)
      .then((next) => { if (!cancelled) setReport(next) })
      .catch((caught: unknown) => {
        if (!cancelled) setReportError(caught instanceof Error ? caught.message : 'Evaluation 报告加载失败')
      })
      .finally(() => { if (!cancelled) setReportLoading(false) })
    return () => { cancelled = true }
  }, [identity, revision, selectedId])

  const selected = experiments?.find((item) => item.id === selectedId) ?? null
  const pairs = useMemo(() => {
    if (!report) return []
    return Array.from({ length: report.repetitions }, (_, index) => {
      const repetition = index + 1
      return {
        repetition,
        single: report.trials.find((trial) => trial.repetition === repetition && trial.variant === 'single_agent'),
        multi: report.trials.find((trial) => trial.repetition === repetition && trial.variant === 'multi_agent'),
      }
    })
  }, [report])
  const maximumWallTime = Math.max(1, ...(report?.trials.map((trial) => trial.metrics?.wallTimeMs ?? 0) ?? [0]))
  const single = report ? variantAggregate(report, 'single_agent') : undefined
  const multi = report ? variantAggregate(report, 'multi_agent') : undefined

  async function refresh(): Promise<void> {
    await loadIndex()
    setRevision((current) => current + 1)
  }

  async function createExperiment(): Promise<void> {
    if (!scenarioVersionId || !experimentName.trim()) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      const created = await missionApi.createEvaluationExperiment(identity, {
        scenarioVersionId,
        name: experimentName.trim(),
        repetitions,
      })
      await loadIndex()
      setSelectedId(created.id)
      setRevision((current) => current + 1)
      setCreating(false)
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : '实验创建失败')
    } finally {
      setCreateBusy(false)
    }
  }

  const deltaHeadline = report && report.pairedTrials > 0
    ? `多 Agent 平均${report.pairedMeanWallTimeDeltaMs <= 0 ? '快' : '慢'} ` +
      `${formatDuration(Math.abs(report.pairedMeanWallTimeDeltaMs))}，每个 Mission ` +
      `${report.pairedMeanCostDeltaUsd <= 0 ? '少花' : '多花'} ${formatCost(Math.abs(report.pairedMeanCostDeltaUsd))}。`
    : '等待同一 repetition 的单 Agent 与多 Agent Trial 都形成终态指标。'

  return (
    <>
      <section className="page-heading">
        <div>
          <div className="breadcrumb"><span>当前工作区</span><i>/</i><span>评测实验室</span></div>
          <h1>单 Agent 与协作团队对照</h1>
          <p>读取项目真实 Evaluation 账本。每组配对共享不可变 Scenario Version、Git 基线和 seed；指标从 Mission、Run、模型、工具、审查与 Context 事实重新聚合。</p>
        </div>
        <div className="page-actions">
          <span className="status-pill status-pill--verified"><ShieldCheck size={13} />差值仅统计完整配对</span>
          <button className="secondary-action" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? 'is-spinning' : ''} size={15} />刷新</button>
          <button className="primary-action" onClick={() => setCreating(true)} disabled={(scenarioVersions?.length ?? 0) === 0}><Plus size={15} />新建配对实验</button>
        </div>
      </section>

      {creating ? (
        <section className="evaluation-create" aria-label="新建配对实验">
          <header><div><span className="micro-label">冻结输入</span><h2>从 Scenario Version 创建实验</h2></div><button aria-label="关闭" onClick={() => setCreating(false)}><X size={16} /></button></header>
          <div className="evaluation-create__fields">
            <label><span>Scenario Version</span><select value={scenarioVersionId} onChange={(event) => setScenarioVersionId(event.target.value)}>{scenarioVersions?.map((version) => <option key={version.id} value={version.id}>{version.scenarioName} · v{version.version} · {version.baselineCommit.slice(0, 8)}</option>)}</select></label>
            <label><span>实验名称</span><input value={experimentName} maxLength={200} onChange={(event) => setExperimentName(event.target.value)} /></label>
            <label><span>配对次数</span><input type="number" min={1} max={100} value={repetitions} onChange={(event) => setRepetitions(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} /></label>
          </div>
          <footer><p>创建后 Trial 进入排队；需启动 Evaluation、Scheduler、对应 Agent 与 Integration Worker 才会执行。</p>{createError ? <span>{createError}</span> : null}<button className="primary-action" disabled={createBusy || !scenarioVersionId || !experimentName.trim()} onClick={() => void createExperiment()}>{createBusy ? <LoaderCircle className="is-spinning" size={15} /> : <Plus size={15} />}创建并排队</button></footer>
        </section>
      ) : null}

      {loading ? (
        <section className="evaluation-state"><LoaderCircle className="is-spinning" size={22} /><strong>正在读取 Evaluation 账本</strong></section>
      ) : error ? (
        <section className="evaluation-state evaluation-state--error"><CircleAlert size={22} /><strong>Evaluation 数据加载失败</strong><p>{error}</p><button className="secondary-action" onClick={() => void refresh()}>重试</button></section>
      ) : (experiments?.length ?? 0) === 0 ? (
        <section className="evaluation-state"><strong>还没有真实实验</strong><p>{(scenarioVersions?.length ?? 0) > 0 ? '已有不可变 Scenario Version，可以新建第一组配对实验。' : '先通过 Evaluation Scenario API 创建元数据和不可变版本；页面不会显示示例结果。'}</p>{(scenarioVersions?.length ?? 0) > 0 ? <button className="primary-action" onClick={() => setCreating(true)}><Plus size={15} />新建配对实验</button> : <code>POST …/evaluation-scenarios/:scenarioId/versions</code>}</section>
      ) : (
        <div className="evaluation-workspace">
          <aside className="evaluation-register">
            <div className="panel-heading"><div><span className="micro-label">项目最近实验</span><h2>实验账本</h2></div><code>{experiments?.length}</code></div>
            <div>{experiments?.map((item) => <button key={item.id} className={item.id === selectedId ? 'is-selected' : ''} onClick={() => setSelectedId(item.id)}><span className={`evaluation-status evaluation-status--${item.status}`}><i />{statusLabels[item.status] ?? item.status}</span><strong>{item.name}</strong><small>{item.scenarioName} · {item.completedTrialCount}/{item.trialCount} Trial</small><code>{item.baselineCommit.slice(0, 10)}</code></button>)}</div>
          </aside>

          <main className="evaluation-report">
            {reportLoading ? <section className="evaluation-state"><LoaderCircle className="is-spinning" size={20} /><strong>正在重建报告投影</strong></section> : reportError ? <section className="evaluation-state evaluation-state--error"><CircleAlert size={20} /><strong>报告加载失败</strong><p>{reportError}</p></section> : report && selected ? <>
              <section className="evaluation-thesis"><div className="evaluation-thesis__copy"><span className="micro-label">配对结果 · 多 Agent 减单 Agent</span><h2>{deltaHeadline}</h2><p>{report.pairedTrials}/{report.repetitions} 组形成完整配对。当前状态：{statusLabels[report.status] ?? report.status}。所有数字来自持久化账本，不采用 Agent 自述。</p></div><div className="delta-seal"><span>成功率差值</span><strong>{report.pairedTrials > 0 ? `${report.pairedSuccessDelta >= 0 ? '+' : ''}${Math.round(report.pairedSuccessDelta * 100)}` : '—'}</strong><small>个百分点</small></div></section>

              <section className="strategy-comparison"><div className="comparison-header comparison-grid"><span>策略</span><span>成功率</span><span>平均时间</span><span>平均成本</span><span>平均返工</span></div>{(['single_agent', 'multi_agent'] as const).map((variant) => { const aggregate = variant === 'single_agent' ? single : multi; return <div className={`comparison-row comparison-grid${variant === 'multi_agent' ? ' comparison-row--winner' : ''}`} key={variant}><div><span className={`strategy-mark strategy-mark--${variant === 'single_agent' ? 'single' : 'multi'}`}>{variant === 'single_agent' ? '1' : 'N'}</span><strong>{variantName(variant)}</strong></div><strong>{aggregate && aggregate.completedTrials > 0 ? `${Math.round(aggregate.successRate * 100)}%` : '—'}</strong><code>{aggregate && aggregate.completedTrials > 0 ? formatDuration(aggregate.meanWallTimeMs) : '—'}</code><code>{aggregate && aggregate.completedTrials > 0 ? formatCost(aggregate.meanCostUsd) : '—'}</code><code>{aggregate && aggregate.completedTrials > 0 ? aggregate.meanReworkAttempts.toFixed(1) : '—'}</code></div> })}</section>

              <section className="paired-trials"><div className="panel-heading"><div><span className="micro-label">同版本 · 同 seed</span><h2>配对 Trial</h2></div><code>基线 {selected.baselineCommit.slice(0, 10)}</code></div><div className="trial-list">{pairs.map((pair) => { const delta = pair.single?.metrics && pair.multi?.metrics ? pair.multi.metrics.wallTimeMs - pair.single.metrics.wallTimeMs : null; return <article className="trial-row" key={pair.repetition}><div className="trial-row__label"><span>配对 {String(pair.repetition).padStart(2, '0')}</span><code>seed {(pair.single ?? pair.multi)?.seed.slice(0, 12) ?? '—'}</code></div><TrialLane trial={pair.single} maximumMs={maximumWallTime} /><TrialLane trial={pair.multi} maximumMs={maximumWallTime} /><div className="trial-delta"><ArrowDownRight size={15} /><strong>{delta === null ? '等待配对' : `${delta >= 0 ? '+' : '−'}${formatDuration(Math.abs(delta))}`}</strong></div><div className="trial-missions"><code>{pair.single?.missionId ? '单 Agent Mission 已创建' : '单 Agent Mission 未创建'}</code><code>{pair.multi?.missionId ? '多 Agent Mission 已创建' : '多 Agent Mission 未创建'}</code></div></article> })}</div></section>
            </> : <section className="evaluation-state"><strong>选择一个实验查看真实报告</strong></section>}
          </main>
        </div>
      )}
    </>
  )
}

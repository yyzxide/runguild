import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react'
import {
  missionApi,
  type RunTraceDetail,
  type RunTraceEventSummary,
  type RunTraceLlmCallSummary,
  type RunTraceSummary,
  type TestIdentity,
} from './api'

export interface TraceViewProps {
  readonly identity: TestIdentity
}

const statusLabels: Readonly<Record<string, string>> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  blocked: '受阻',
  waiting_human: '等待人工',
  approved: '已批准',
  rejected: '已拒绝',
  cancelled: '已取消',
}

const eventKindLabels: Readonly<Record<string, string>> = {
  llm: '模型',
  model: '模型',
  tool: '工具',
  context: '上下文',
  observation: '观测',
  state: '状态',
  log: '日志',
  message: '消息',
  review: '审查',
  run: '运行',
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('zh-CN')
}

function formatCost(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `$${Number(value).toFixed(4)}`
}

function summarizeEvent(event: RunTraceEventSummary): string {
  const data = event.data ?? {}
  if (typeof data.note === 'string' && data.note) return data.note
  if (typeof data.message === 'string' && data.message) return data.message
  const keys = Object.keys(data)
  if (keys.length === 0) return '无附加数据'
  return `附加字段：${keys.slice(0, 4).join('、')}`
}

function RunTraceDetailPanel({ detail }: { readonly detail: RunTraceDetail }) {
  const events = [...detail.events].sort((a, b) => a.seq - b.seq)
  const totalInput = detail.llmCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0)
  const totalOutput = detail.llmCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0)
  const totalCached = detail.llmCalls.reduce((sum, call) => sum + (call.cachedInputTokens ?? 0), 0)
  const totalCost = detail.llmCalls.reduce((sum, call) => sum + (call.estimatedCostUsd ?? 0), 0)
  const context = detail.contextSummary
  return (
    <>
      <section className="trace-contract">
        <div><span>Agent</span><strong>{detail.agent.name}{detail.agent.role ? ` · ${detail.agent.role}` : ''}</strong></div>
        <div><span>任务 / Mission</span><code>{detail.task.title} · {detail.mission.title}</code></div>
        <div><span>模型</span><code>{detail.modelProvider && detail.modelName ? `${detail.modelProvider}/${detail.modelName}` : '—'}</code></div>
        <div><span>尝试 / Hop</span><code>{detail.attempt} 次 · {detail.currentHop}/{detail.maxHops}</code></div>
        <div><span>成本</span><code>{formatCost(totalCost)}</code></div>
        <div><span>时间</span><code>{formatDateTime(detail.startedAt)} → {formatDateTime(detail.finishedAt)}</code></div>
      </section>

      <section className="trace-context">
        <span className="micro-label">Context Snapshot 摘要 · 脱敏</span>
        <dl>
          <div><dt>模型</dt><dd><code>{context.modelProvider && context.modelName ? `${context.modelProvider}/${context.modelName}` : '—'}</code></dd></div>
          <div><dt>任务</dt><dd>{context.taskTitle}</dd></div>
          <div><dt>Mission</dt><dd>{context.missionTitle}</dd></div>
          <div><dt>Token 预算</dt><dd>{formatNumber(context.tokenBudget)}</dd></div>
          <div><dt>估算 Token</dt><dd>{formatNumber(context.estimatedTokens)}</dd></div>
          <div><dt>已压缩</dt><dd>{context.compacted === null ? '—' : context.compacted ? '是' : '否'}</dd></div>
        </dl>
      </section>

      {detail.completionSummary ? (
        <section className="trace-completion">
          <span className="micro-label">完成摘要</span>
          <p>{detail.completionSummary}</p>
        </section>
      ) : null}

      <section className="trace-summary-block">
        <div className="panel-heading">
          <div><span className="micro-label">按持久化顺序</span><h3>事件瀑布流</h3></div>
          <code>{events.length} 条</code>
        </div>
        <div className="trace-list">
          {events.map((event, index) => (
            <div className="trace-event" key={event.id ?? event.seq}>
              <span className="trace-event__index">{String(index + 1).padStart(2, '0')}</span>
              <code className="trace-event__time">{event.createdAt ? new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</code>
              <span className="trace-event__type">{eventKindLabels[event.kind] ?? event.kind}</span>
              <div><strong>第 {event.hop} 跳 · {event.kind}</strong><p>{summarizeEvent(event)}</p></div>
              <code className="trace-event__duration">seq {event.seq}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="trace-summary-block">
        <div className="panel-heading">
          <div><span className="micro-label">仅 Token / 成本 / 延迟</span><h3>模型调用摘要</h3></div>
          <code>{detail.llmCalls.length} 次</code>
        </div>
        <p className="trace-redaction-note">不包含 request / response 消息正文。Token 与成本为账面聚合值。</p>
        <div className="trace-calls">
          {detail.llmCalls.map((call: RunTraceLlmCallSummary) => (
            <div className="trace-call" key={call.id}>
              <span className="trace-event__index">{String(call.hop).padStart(2, '0')}</span>
              <code className="trace-call__hop">hop {call.hop}</code>
              <strong>{statusLabels[call.status] ?? call.status}</strong>
              <p>{formatNumber(call.inputTokens)} 输入 · {formatNumber(call.outputTokens)} 输出 · {formatNumber(call.cachedInputTokens)} 缓存</p>
              <code>{formatCost(call.estimatedCostUsd)}</code>
              <code>{call.latencyMs === null ? '—' : `${call.latencyMs} ms`}</code>
            </div>
          ))}
        </div>
        <div className="trace-totals">
          <span>合计 <strong>{formatNumber(totalInput)}</strong> 输入 · <strong>{formatNumber(totalOutput)}</strong> 输出 · <strong>{formatNumber(totalCached)}</strong> 缓存</span>
          <code>估算成本 {formatCost(totalCost)}</code>
        </div>
      </section>

      <section className="trace-summary-block">
        <div className="panel-heading">
          <div><span className="micro-label">仅动作 / 状态 / 错误码</span><h3>工具执行摘要</h3></div>
          <code>{detail.toolExecutions.length} 次</code>
        </div>
        <p className="trace-redaction-note">不包含工具请求与结果原文。</p>
        <div className="trace-tool-list">
          {detail.toolExecutions.map((tool) => (
            <div className="trace-tool" key={tool.id}>
              <code className="trace-tool__action">{tool.action}</code>
              <span>{statusLabels[tool.status] ?? tool.status}</span>
              <code>{tool.effectState}</code>
              <code>{tool.errorCode ?? '—'}</code>
              <small>{formatDateTime(tool.startedAt)} → {formatDateTime(tool.finishedAt)}</small>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

export function TraceView({ identity }: TraceViewProps) {
  const [runs, setRuns] = useState<readonly RunTraceSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunTraceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await missionApi.listRunTraces(identity)
      setRuns(next)
      setSelectedId((current) => {
        if (current && next.some((run) => run.runId === current)) return current
        return next[0]?.runId ?? null
      })
      if (next.length === 0) setDetail(null)
    } catch (caught) {
      setRuns([])
      setError(caught instanceof Error ? caught.message : '运行记录加载失败')
    } finally {
      setLoading(false)
    }
  }, [identity])

  useEffect(() => { void loadRuns() }, [loadRuns])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    void missionApi.getRunTrace(identity, selectedId)
      .then((next) => { if (!cancelled) setDetail(next) })
      .catch((caught: unknown) => { if (!cancelled) setDetailError(caught instanceof Error ? caught.message : '运行详情加载失败') })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedId, identity])

  return (
    <>
      <section className="page-heading">
        <div>
          <div className="breadcrumb"><span>运行记录</span><i>/</i><code>{selectedId ? selectedId.slice(0, 12) : '项目账本'}</code></div>
          <h1>项目运行账本</h1>
          <p>读取项目最近 Run 的真实审计摘要：状态、模型、Token 与估算成本、Context Snapshot 摘要，以及按持久化顺序排列的事件、模型调用与工具执行。仅返回脱敏摘要，不包含密钥或未脱敏模型内容。</p>
        </div>
        <div className="page-actions">
          <button className="secondary-action" onClick={() => void loadRuns()}><RefreshCw size={14} />刷新</button>
        </div>
      </section>

      <section className="trace-contract">
        <div><span>范围</span><strong>{identity.workspaceId} / {identity.projectId}</strong></div>
        <div><span>最近运行</span><code>{runs ? `${runs.length} 条` : loading ? '加载中…' : '—'}</code></div>
        <div><span>数据来源</span><code>真实 agent_runs 账本</code></div>
        <div><span>脱敏</span><code>仅摘要字段</code></div>
      </section>

      {loading ? (
        <section className="trace-loading">
          <LoaderCircle className="is-spinning" size={22} />
          <strong>正在读取项目运行账本</strong>
          <p>仅请求最近 20 条 Run 的摘要字段。</p>
        </section>
      ) : error && (runs?.length ?? 0) === 0 ? (
        <section className="trace-error">
          <CircleAlert size={22} />
          <strong>运行记录加载失败</strong>
          <p>{error}</p>
          <button className="secondary-action" onClick={() => void loadRuns()}>重试</button>
        </section>
      ) : (runs?.length ?? 0) === 0 ? (
        <section className="trace-empty">
          <strong>还没有运行记录</strong>
          <p>当本项目第一次 Run 落账后，这里会显示真实 Trace。</p>
        </section>
      ) : (
        <div className="trace-workspace">
          <section className="trace-list-panel">
            <div className="panel-heading">
              <div><span className="micro-label">项目最近 Run</span><h2>选择一次运行</h2></div>
              <code>{runs?.length} 条</code>
            </div>
            <div className="trace-list">
              {runs?.map((run, index) => (
                <button
                  key={run.runId}
                  className={`trace-event${run.runId === selectedId ? ' is-selected' : ''}`}
                  onClick={() => setSelectedId(run.runId)}
                >
                  <span className="trace-event__index">{String(index + 1).padStart(2, '0')}</span>
                  <code className="trace-event__time">{run.startedAt ? new Date(run.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</code>
                  <span className="trace-event__type">{statusLabels[run.status] ?? run.status}</span>
                  <div><strong>{run.task.title}</strong><p>{run.mission.title} · {run.agent.name} · 尝试 {run.attempt} · Hop {run.currentHop}/{run.maxHops}</p></div>
                  <code className="trace-event__duration">{run.runId.slice(0, 12)}</code>
                </button>
              ))}
            </div>
          </section>
          <aside className="trace-detail">
            {detailLoading ? (
              <div className="trace-detail-state"><LoaderCircle className="is-spinning" size={20} /><p>正在加载 Run 详情…</p></div>
            ) : detailError ? (
              <div className="trace-detail-state trace-detail-state--error"><CircleAlert size={20} /><strong>详情加载失败</strong><p>{detailError}</p></div>
            ) : detail ? (
              <RunTraceDetailPanel detail={detail} />
            ) : (
              <p className="trace-placeholder">选择一个 Run 查看脱敏审计摘要。</p>
            )}
          </aside>
        </div>
      )}
    </>
  )
}

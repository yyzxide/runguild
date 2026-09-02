import {
  CircleAlert,
  FileClock,
  FileText,
  Fingerprint,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Waves,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  missionApi,
  type ArtifactActor,
  type ArtifactVersionSnapshot,
  type ArtifactVersionSummary,
  type ProjectArtifactDetail,
  type ProjectArtifactSummary,
  type TestIdentity,
} from './api'

export interface ArtifactViewProps {
  readonly identity: TestIdentity
  readonly missionId?: string
}

type DocumentNode = {
  readonly type?: unknown
  readonly text?: unknown
  readonly attrs?: unknown
  readonly marks?: unknown
  readonly content?: unknown
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {}
}

function asNodes(value: unknown): readonly DocumentNode[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []
}

function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^https?:\/\//i.test(value) ? value : null
}

function markedText(node: DocumentNode, key: string): ReactNode {
  let rendered: ReactNode = typeof node.text === 'string' ? node.text : null
  const marks = asNodes(node.marks)
  marks.forEach((mark, index) => {
    const markKey = `${key}-mark-${index}`
    if (mark.type === 'bold' || mark.type === 'strong') rendered = <strong key={markKey}>{rendered}</strong>
    else if (mark.type === 'italic' || mark.type === 'em') rendered = <em key={markKey}>{rendered}</em>
    else if (mark.type === 'code') rendered = <code key={markKey}>{rendered}</code>
    else if (mark.type === 'strike') rendered = <s key={markKey}>{rendered}</s>
    else if (mark.type === 'link') {
      const href = safeHref(asRecord(mark.attrs).href)
      rendered = href
        ? <a key={markKey} href={href} rel="noreferrer" target="_blank">{rendered}</a>
        : <span key={markKey}>{rendered}</span>
    }
  })
  return rendered
}

function renderChildren(node: DocumentNode, key: string): ReactNode {
  return asNodes(node.content).map((child, index) => renderNode(child, `${key}-${index}`))
}

function renderNode(node: DocumentNode, key: string): ReactNode {
  if (node.type === 'text') return <Fragment key={key}>{markedText(node, key)}</Fragment>
  if (node.type === 'hardBreak') return <br key={key} />
  if (node.type === 'horizontalRule') return <hr key={key} />
  const children = renderChildren(node, key)
  if (node.type === 'doc') return <Fragment key={key}>{children}</Fragment>
  if (node.type === 'paragraph') return <p key={key}>{children}</p>
  if (node.type === 'heading') {
    const level = Number(asRecord(node.attrs).level)
    if (level === 1) return <h2 key={key}>{children}</h2>
    if (level === 2) return <h3 key={key}>{children}</h3>
    return <h4 key={key}>{children}</h4>
  }
  if (node.type === 'bulletList') return <ul key={key}>{children}</ul>
  if (node.type === 'orderedList') {
    const order = Number(asRecord(node.attrs).order)
    return <ol key={key} start={Number.isInteger(order) && order > 0 ? order : 1}>{children}</ol>
  }
  if (node.type === 'listItem') return <li key={key}>{children}</li>
  if (node.type === 'blockquote') return <blockquote key={key}>{children}</blockquote>
  if (node.type === 'codeBlock') return <pre key={key}><code>{children}</code></pre>
  return <div className="artifact-unknown-block" key={key}>{children}</div>
}

function renderDocument(content: Readonly<Record<string, unknown>> | null): ReactNode {
  if (!content) return null
  return renderNode(content, 'document')
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value
}

function actorLabel(actor: ArtifactActor): string {
  const kind = actor.kind === 'agent' ? 'Agent' : actor.kind === 'user' ? '用户' : actor.kind
  return `${kind} · ${actor.id}`
}

function versionLabel(version: ArtifactVersionSummary): string {
  return `v${String(version.version).padStart(2, '0')}`
}

export function ArtifactView({ identity, missionId }: ArtifactViewProps) {
  const [artifacts, setArtifacts] = useState<readonly ProjectArtifactSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectArtifactDetail | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<'live' | string>('live')
  const [version, setVersion] = useState<ArtifactVersionSnapshot | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [versionLoading, setVersionLoading] = useState(false)
  const [freezing, setFreezing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const detailRequest = useRef(0)

  const loadIndex = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await missionApi.listArtifacts(identity)
      setArtifacts(next)
      setSelectedId((current) => {
        if (current && next.some((artifact) => artifact.id === current)) return current
        return next.find((artifact) => missionId && artifact.missionId === missionId)?.id ?? next[0]?.id ?? null
      })
      if (next.length === 0) setDetail(null)
    } catch (caught) {
      setArtifacts([])
      setError(caught instanceof Error ? caught.message : 'Artifact 账本加载失败')
    } finally {
      setLoading(false)
    }
  }, [identity, missionId])

  const loadDetail = useCallback(async (artifactId: string) => {
    const request = ++detailRequest.current
    setDetailLoading(true)
    setDetailError(null)
    try {
      const next = await missionApi.getArtifact(identity, artifactId)
      if (request !== detailRequest.current) return
      setDetail(next)
      setSelectedVersionId('live')
      setVersion(null)
    } catch (caught) {
      if (request !== detailRequest.current) return
      setDetail(null)
      setDetailError(caught instanceof Error ? caught.message : 'Artifact 详情加载失败')
    } finally {
      if (request === detailRequest.current) setDetailLoading(false)
    }
  }, [identity])

  useEffect(() => { void loadIndex() }, [loadIndex])
  useEffect(() => {
    if (!selectedId) return
    void loadDetail(selectedId)
  }, [loadDetail, selectedId])

  useEffect(() => {
    if (selectedVersionId === 'live') {
      setVersion(null)
      return
    }
    let cancelled = false
    setVersion(null)
    setVersionLoading(true)
    setDetailError(null)
    void missionApi.getArtifactVersion(identity, selectedVersionId)
      .then((next) => { if (!cancelled) setVersion(next) })
      .catch((caught: unknown) => {
        if (!cancelled) setDetailError(caught instanceof Error ? caught.message : 'Artifact Version 加载失败')
      })
      .finally(() => { if (!cancelled) setVersionLoading(false) })
    return () => { cancelled = true }
  }, [identity, selectedVersionId])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    if (!needle) return artifacts ?? []
    return (artifacts ?? []).filter((artifact) =>
      [artifact.title, artifact.id, artifact.kind, artifact.missionId ?? '']
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(needle)))
  }, [artifacts, query])

  const selected = artifacts?.find((artifact) => artifact.id === selectedId) ?? null
  const selectedSummary = selectedVersionId === 'live'
    ? null
    : detail?.versions.find((item) => item.id === selectedVersionId) ?? null
  const content = selectedVersionId === 'live' ? detail?.live.content ?? null : version?.content ?? null

  async function refresh(): Promise<void> {
    setNotice(null)
    await loadIndex()
    if (selectedId) await loadDetail(selectedId)
  }

  async function freeze(): Promise<void> {
    if (!selectedId || selectedVersionId !== 'live') return
    setFreezing(true)
    setDetailError(null)
    setNotice(null)
    try {
      const frozen = await missionApi.freezeArtifact(identity, selectedId)
      const [nextDetail, nextArtifacts] = await Promise.all([
        missionApi.getArtifact(identity, selectedId),
        missionApi.listArtifacts(identity),
      ])
      setDetail(nextDetail)
      setArtifacts(nextArtifacts)
      setVersion(frozen)
      setSelectedVersionId(frozen.id)
      setNotice(`已冻结 ${versionLabel(frozen)}；内容哈希 ${shortHash(frozen.contentHash)}`)
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : '当前状态冻结失败')
    } finally {
      setFreezing(false)
    }
  }

  return (
    <>
      <section className="page-heading artifact-heading">
        <div>
          <div className="breadcrumb"><span>当前工作区</span><i>/</i><span>协作产物</span></div>
          <h1>活文档与冻结版本</h1>
          <p>读取项目真实 Yjs 状态和不可变 Artifact Version。这里用于核对 Agent 交付、哈希与版本来源；不会展示虚构协作者或样例评论。</p>
        </div>
        <div className="page-actions">
          <span className="status-pill status-pill--verified"><Fingerprint size={13} />内容寻址</span>
          <button className="secondary-action" onClick={() => void refresh()} disabled={loading || detailLoading}><RefreshCw className={loading || detailLoading ? 'is-spinning' : ''} size={15} />刷新账本</button>
          <button className="primary-action" onClick={() => void freeze()} disabled={!selectedId || selectedVersionId !== 'live' || freezing || detailLoading}>{freezing ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}{selectedVersionId === 'live' ? '冻结当前状态' : '切回 LIVE 后冻结'}</button>
        </div>
      </section>

      {notice ? <div className="artifact-notice"><ShieldCheck size={15} /><span>{notice}</span></div> : null}
      {detailError && detail ? <div className="artifact-notice artifact-notice--error"><CircleAlert size={15} /><span>{detailError}</span></div> : null}

      {loading ? (
        <section className="artifact-state"><LoaderCircle className="is-spinning" size={22} /><strong>正在读取 Artifact 账本</strong></section>
      ) : error ? (
        <section className="artifact-state artifact-state--error"><CircleAlert size={22} /><strong>Artifact 数据加载失败</strong><p>{error}</p><button className="secondary-action" onClick={() => void loadIndex()}>重试</button></section>
      ) : (artifacts?.length ?? 0) === 0 ? (
        <section className="artifact-state"><FileText size={24} /><strong>这个项目还没有真实 Artifact</strong><p>Mission 开始运行后会自动创建主交付 Artifact；Agent 也可通过受限工具追加内容并冻结 Version。</p></section>
      ) : (
        <div className="artifact-workspace artifact-ops-workspace">
          <aside className="artifact-register">
            <div className="panel-heading"><div><span className="micro-label">项目产物</span><h2>Artifact 账本</h2></div><code>{artifacts?.length}</code></div>
            <label className="artifact-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题、Mission 或 Artifact id" /></label>
            <div className="artifact-register__list">
              {filtered.map((artifact) => (
                <button className={artifact.id === selectedId ? 'is-selected' : ''} key={artifact.id} onClick={() => setSelectedId(artifact.id)}>
                  <span className="artifact-kind"><FileText size={12} />{artifact.kind}</span>
                  <strong>{artifact.title}</strong>
                  <small>{artifact.missionId ? '已关联 Mission' : '工作区级 Artifact'}</small>
                  <div><code>update {artifact.throughUpdateSeq}</code><span>{artifact.versionCount} 个 Version</span></div>
                </button>
              ))}
              {filtered.length === 0 ? <p className="artifact-register__empty">没有匹配的 Artifact。</p> : null}
            </div>
          </aside>

          <main className="artifact-document">
            {detailLoading ? <section className="artifact-state"><LoaderCircle className="is-spinning" size={21} /><strong>正在重建 Yjs 状态</strong></section> : detailError && !detail ? <section className="artifact-state artifact-state--error"><CircleAlert size={20} /><strong>Artifact 详情加载失败</strong><p>{detailError}</p></section> : detail ? <>
              <header className="artifact-document__header">
                <div><span className="document-kicker">{detail.artifact.kind} · {selectedVersionId === 'live' ? '可变状态' : '不可变切片'}</span><h2>{detail.artifact.title}</h2><p>{detail.artifact.missionId ? '属于当前关联 Mission' : '工作区级协作产物'}</p></div>
                <span className={`artifact-mode artifact-mode--${selectedVersionId === 'live' ? 'live' : 'frozen'}`}>{selectedVersionId === 'live' ? <Waves size={13} /> : <ShieldCheck size={13} />}{selectedVersionId === 'live' ? 'LIVE' : selectedSummary ? versionLabel(selectedSummary) : 'VERSION'}</span>
              </header>

              <nav className="artifact-slice-track" aria-label="Artifact 状态切片">
                <button className={selectedVersionId === 'live' ? 'is-selected is-live' : 'is-live'} onClick={() => setSelectedVersionId('live')}><i /><span>LIVE</span><small>update {detail.live.throughUpdateSeq}</small></button>
                {[...detail.versions].reverse().map((item) => <button className={selectedVersionId === item.id ? 'is-selected' : ''} key={item.id} onClick={() => setSelectedVersionId(item.id)}><i /><span>{versionLabel(item)}</span><small>{item.contentHash.slice(0, 8)}</small></button>)}
              </nav>

              <section className="artifact-document__meta">
                <div><span>状态哈希</span><code>{shortHash(selectedVersionId === 'live' ? detail.live.stateHash : selectedSummary?.yjsStateHash ?? '—')}</code></div>
                <div><span>内容哈希</span><code>{selectedVersionId === 'live' ? '冻结后生成' : shortHash(selectedSummary?.contentHash ?? '—')}</code></div>
                <div><span>Update 序号</span><code>{selectedVersionId === 'live' ? detail.live.throughUpdateSeq : selectedSummary?.throughUpdateSeq ?? '—'}</code></div>
              </section>

              <article className="artifact-prosemirror">
                {versionLoading ? <div className="artifact-document-loading"><LoaderCircle className="is-spinning" size={20} /><span>正在读取不可变 Version</span></div> : asNodes(content?.content).length > 0 ? renderDocument(content) : <div className="artifact-document-empty"><FileText size={24} /><strong>当前状态没有可显示的 ProseMirror 内容</strong><p>Artifact 元数据和 Yjs 状态已经真实存在；等待 Agent 或协作客户端写入正文。</p></div>}
              </article>
            </> : <section className="artifact-state"><strong>选择一个 Artifact</strong></section>}
          </main>

          <aside className="artifact-ledger">
            <section className="artifact-live-card">
              <div><span className="micro-label">当前活状态</span><Waves size={16} /></div>
              <strong>update {detail?.live.throughUpdateSeq ?? selected?.throughUpdateSeq ?? '—'}</strong>
              <code>{detail ? shortHash(detail.live.stateHash) : '读取中'}</code>
              <small>{detail ? `${formatBytes(detail.live.stateBytes)} · 更新于 ${formatDateTime(detail.artifact.updatedAt)}` : '正在重建状态'}</small>
            </section>
            <section className="artifact-version-ledger">
              <div className="panel-heading"><div><span className="micro-label">不可变切片</span><h2>Version 历史</h2></div><code>{detail?.versions.length ?? selected?.versionCount ?? 0}</code></div>
              <div>{detail?.versions.map((item) => <button className={selectedVersionId === item.id ? 'is-selected' : ''} key={item.id} onClick={() => setSelectedVersionId(item.id)}><span><ShieldCheck size={12} />{versionLabel(item)}</span><strong>{shortHash(item.contentHash)}</strong><small>{actorLabel(item.createdBy)}</small><time>{formatDateTime(item.createdAt)}</time>{item.createdByRunId ? <code>Run · {item.createdByRunId}</code> : null}</button>)}</div>
              {detail?.versions.length === 0 ? <p className="artifact-ledger-empty"><FileClock size={18} />还没有冻结 Version。确认 LIVE 内容后使用页面顶部按钮冻结。</p> : null}
            </section>
          </aside>
        </div>
      )}
    </>
  )
}

import {
  Activity,
  AtSign,
  ArrowDownRight,
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  Command,
  Database,
  FileStack,
  FolderGit2,
  FlaskConical,
  GitCommitHorizontal,
  LayoutDashboard,
  KeyRound,
  LoaderCircle,
  Link2,
  MessageCircle,
  Network,
  Plus,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  guidedPlan,
  missionApi,
  type ConversationMessage,
  type ConversationPlanningRequest,
  type ConversationSnapshot,
  type DevelopmentSetup,
  type MissionSnapshot,
  type ProjectOperatorOverview,
  type ProjectRuntimeConfigurationResponse,
  type TestIdentity,
  type UpdateProjectRuntimeConfiguration,
  type WorkerKind,
} from './api'
import { MissionGraph } from './MissionGraph'
import { experiments, type EvidenceFact, type MissionTask, type TaskStatus } from './data'
import { TraceView } from './TraceView'

type View = 'start' | 'mission' | 'team' | 'artifacts' | 'evaluation' | 'trace'
type ConnectionState = 'checking' | 'online' | 'offline'

const viewMeta: Record<View, { readonly label: string; readonly icon: LucideIcon; readonly eyebrow: string }> = {
  start: { label: '工作台', icon: LayoutDashboard, eyebrow: '状态、上下文与下一步操作' },
  mission: { label: 'Mission', icon: Network, eyebrow: '任务依赖与执行状态' },
  team: { label: '协作室', icon: MessageCircle, eyebrow: '讨论、规划与运行中干预' },
  artifacts: { label: '协作产物', icon: FileStack, eyebrow: '实时协作 · 冻结版本' },
  evaluation: { label: '评测实验', icon: FlaskConical, eyebrow: '单 Agent 与多 Agent 对照' },
  trace: { label: '运行记录', icon: Activity, eyebrow: '可审计执行账本' },
}
const primaryViews: readonly View[] = ['start', 'team', 'mission']

const defaultIdentity: TestIdentity = {
  workspaceId: 'demo_workspace',
  projectId: 'demo_project',
  userId: 'demo_user',
}

const roleLabels: Record<string, string> = {
  planner: '规划者', researcher: '研究员', builder: '构建者', reviewer: '审查者', custom: '自定义角色',
}

const missionStatusLabels: Record<string, string> = {
  draft: '草稿', planning: '规划中', awaiting_approval: '等待批准', running: '运行中', paused: '已暂停',
  reviewing: '审查中', completed: '已完成', failed: '失败', cancelled: '已取消',
}

const workerStateLabels: Record<string, string> = {
  online: '在线', stale: '心跳失联', stopped: '已停止', never_seen: '未启动',
}

const workerKindLabels: Record<string, { readonly label: string; readonly purpose: string }> = {
  scheduler: { label: 'Scheduler', purpose: '分派任务' },
  agent: { label: 'Agent Worker', purpose: '调用模型与工具' },
  integration: { label: 'Integration', purpose: '合并已审查代码' },
  evaluation: { label: 'Evaluation', purpose: '运行对照评测' },
}

function heartbeatTime(value: string | null): string {
  if (!value) return '尚无心跳'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value))
}

function fromHash(): View {
  const value = window.location.hash.replace('#/', '')
  return value in viewMeta ? value as View : 'start'
}

function StatusPill({ tone, children }: { readonly tone: string; readonly children: React.ReactNode }) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>
}

function AppNavigation({ view, onNavigate }: { readonly view: View; readonly onNavigate: (view: View) => void }) {
  return (
    <nav className="app-nav" aria-label="主导航">
      <button className="brand-mark" aria-label="RunGuild" onClick={() => onNavigate('start')}>
        <span className="brand-mark__orbit" /><strong>RG</strong>
      </button>
      <div className="app-nav__main">
        {primaryViews.map((key) => {
          const item = viewMeta[key]
          const Icon = item.icon
          return (
            <button key={key} className={`nav-button${view === key ? ' is-active' : ''}`} aria-current={view === key ? 'page' : undefined} aria-label={item.label} onClick={() => onNavigate(key)}>
              <Icon size={19} strokeWidth={1.8} /><span>{item.label}</span>
            </button>
          )
        })}
      </div>
      <div className="user-avatar" aria-label="当前用户：本地开发者">本地</div>
    </nav>
  )
}

function TopBar({ view, connection, projectId, onOpenCommand }: { readonly view: View; readonly connection: ConnectionState; readonly projectId: string; readonly onOpenCommand: () => void }) {
  return (
    <header className="topbar">
      <div className="workspace-switcher" aria-label={`当前项目：${projectId}`}><span className="workspace-glyph">R</span><span>{projectId}</span></div>
      <div className="topbar__context"><span>{viewMeta[view].eyebrow}</span></div>
      <button className="command-trigger" onClick={onOpenCommand}><Search size={15} /><span>查找页面或功能</span><kbd><Command size={11} />K</kbd></button>
      <div className={`system-state system-state--${connection}`}>
        <span className="system-state__signal" />
        <span><strong>API</strong> · {connection === 'online' ? '已连接' : connection === 'checking' ? '检查中' : '未连接'}</span>
      </div>
    </header>
  )
}

function StepMarker({ number, state }: { readonly number: number; readonly state: 'done' | 'active' | 'pending' }) {
  return <span className={`step-marker step-marker--${state}`}>{state === 'done' ? <Check size={16} /> : number}</span>
}

function RuntimeConfigPanel({
  runtime,
  overview,
  busy,
  error,
  onClose,
  onSave,
  onControl,
}: {
  readonly runtime: ProjectRuntimeConfigurationResponse
  readonly overview: ProjectOperatorOverview | null
  readonly busy: string | null
  readonly error: string | null
  readonly onClose: () => void
  readonly onSave: (configuration: UpdateProjectRuntimeConfiguration) => void
  readonly onControl: (action: 'start' | 'stop', command: { readonly kind: WorkerKind; readonly agentId?: string }) => void
}) {
  const toDraft = useCallback((): UpdateProjectRuntimeConfiguration => ({
    repositoryPath: runtime.configuration.project.repositoryPath ?? '',
    defaultBranch: runtime.configuration.project.defaultBranch,
    worktreeRoot: runtime.configuration.runtime.worktreeRoot ?? '',
    worktreeSetupCommands: runtime.configuration.runtime.worktreeSetupCommands,
    worktreeSetupTimeoutMs: runtime.configuration.runtime.worktreeSetupTimeoutMs,
    testCommands: runtime.configuration.runtime.testCommands,
    agentContextInputTokens: runtime.configuration.runtime.agentContextInputTokens,
    agentMaxTestTimeoutMs: runtime.configuration.runtime.agentMaxTestTimeoutMs,
    agentModels: runtime.configuration.agents.map((agent) => ({
      agentId: agent.id,
      modelProvider: agent.modelProvider,
      modelName: agent.modelName,
    })),
  }), [runtime.configuration])
  const [draft, setDraft] = useState<UpdateProjectRuntimeConfiguration>(toDraft)
  const [setupCommandsJson, setSetupCommandsJson] = useState(() => JSON.stringify(runtime.configuration.runtime.worktreeSetupCommands, null, 2))
  const [testCommandsJson, setTestCommandsJson] = useState(() => JSON.stringify(runtime.configuration.runtime.testCommands, null, 2))
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(toDraft())
    setSetupCommandsJson(JSON.stringify(runtime.configuration.runtime.worktreeSetupCommands, null, 2))
    setTestCommandsJson(JSON.stringify(runtime.configuration.runtime.testCommands, null, 2))
  }, [toDraft])

  const save = () => {
    let setupCommands: unknown
    let commands: unknown
    try {
      setupCommands = JSON.parse(setupCommandsJson)
    } catch {
      setFormError('Worktree 准备命令不是合法 JSON。每条命令应写成精确参数数组。')
      return
    }
    if (!Array.isArray(setupCommands) || setupCommands.length > 20 || setupCommands.some((command) =>
      !Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part.trim()))) {
      setFormError('Worktree 准备命令必须是二维字符串数组；不需要准备时使用空数组 []。')
      return
    }
    try {
      commands = JSON.parse(testCommandsJson)
    } catch {
      setFormError('测试命令不是合法 JSON。每条命令应写成参数数组，例如 ["npm", "test"]。')
      return
    }
    if (!Array.isArray(commands) || commands.length === 0 || commands.some((command) =>
      !Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part.trim()))) {
      setFormError('测试命令必须是非空的二维字符串数组。')
      return
    }
    setFormError(null)
    onSave({
      ...draft,
      worktreeSetupCommands: setupCommands as string[][],
      testCommands: commands as string[][],
    })
  }
  const workerOnline = (kind: WorkerKind, agentId?: string) => kind === 'agent'
    ? overview?.agents.find((agent) => agent.id === agentId)?.worker?.state === 'online'
    : overview?.systemWorkers.find((worker) => worker.kind === kind)?.state === 'online'

  return (
    <div className="runtime-config-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="runtime-config-panel" role="dialog" aria-modal="true" aria-label="项目运行设置" onMouseDown={(event) => event.stopPropagation()}>
        <header className="runtime-config-panel__header">
          <div><span className="micro-label">项目启动清单</span><h1>让这个项目真正跑起来</h1><p>保存项目级启动参数，然后在右侧启动本地 Worker。模型密钥只来自 API 进程环境，不会进入浏览器或数据库。</p></div>
          <button aria-label="关闭运行设置" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="runtime-config-layout">
          <div className="launch-manifest">
            <section className="manifest-step">
              <span className="manifest-step__number">01</span>
              <div className="manifest-step__body">
                <div className="manifest-step__heading"><span><FolderGit2 size={18} /></span><div><strong>代码与隔离工作区</strong><small>必须是 API 所在机器上的绝对路径，且两者不能互相嵌套。</small></div></div>
                <div className="runtime-field-grid">
                  <label className="runtime-field runtime-field--wide"><span>Git 仓库路径</span><input value={draft.repositoryPath} onChange={(event) => setDraft({ ...draft, repositoryPath: event.target.value })} placeholder="/home/you/projects/my-agent" /></label>
                  <label className="runtime-field"><span>默认分支</span><input value={draft.defaultBranch} onChange={(event) => setDraft({ ...draft, defaultBranch: event.target.value })} placeholder="main" /></label>
                  <label className="runtime-field runtime-field--wide"><span>Worktree 根目录</span><input value={draft.worktreeRoot} onChange={(event) => setDraft({ ...draft, worktreeRoot: event.target.value })} placeholder="/home/you/worktrees/my-agent" /></label>
                </div>
              </div>
            </section>

            <section className="manifest-step">
              <span className="manifest-step__number">02</span>
              <div className="manifest-step__body">
                <div className="manifest-step__heading"><span><ShieldCheck size={18} /></span><div><strong>首次模型调用前的 Worktree 准备</strong><small>Worktree 创建后按顺序执行精确 argv；全部通过后才允许调用模型，不经过 Shell。</small></div></div>
                <label className="runtime-field runtime-field--code"><span>准备命令 JSON（可为空数组）</span><textarea rows={4} value={setupCommandsJson} onChange={(event) => setSetupCommandsJson(event.target.value)} spellCheck={false} placeholder={'[["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]]'} /></label>
                <div className="runtime-limits">
                  <label className="runtime-field"><span>单条准备命令超时（毫秒）</span><input type="number" min={1_000} max={900_000} value={draft.worktreeSetupTimeoutMs} onChange={(event) => setDraft({ ...draft, worktreeSetupTimeoutMs: Number(event.target.value) })} /></label>
                  <div className="setup-policy"><strong>持久化门禁</strong><span>同一 Worktree generation 与命令哈希成功后可复用；失败、超时和租约恢复都有真实记录。</span></div>
                </div>
                <div className="setup-history" aria-label="最近 Worktree 准备记录">
                  <header><strong>最近执行</strong><span>{(runtime.recentSetups ?? []).length} 条</span></header>
                  {(runtime.recentSetups ?? []).length === 0 ? <p>尚无准备执行记录。保存命令并启动 Agent Worker 后，这里会显示真实状态。</p> : (runtime.recentSetups ?? []).slice(0, 4).map((setup) => <article key={setup.id}>
                    <span className={`setup-status setup-status--${setup.status}`}><i />{{ running: '执行中', succeeded: '已通过', failed: '未通过' }[setup.status]}</span>
                    <div><code>{setup.taskId}</code><small>generation {setup.worktreeGeneration} · 第 {setup.attempt} 次 · {setup.commands.length} 条命令</small></div>
                    <time>{new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(setup.updatedAt))}</time>
                  </article>)}
                </div>
              </div>
            </section>

            <section className="manifest-step">
              <span className="manifest-step__number">03</span>
              <div className="manifest-step__body">
                <div className="manifest-step__heading"><span><Terminal size={18} /></span><div><strong>允许 Agent 执行的测试</strong><small>使用参数数组，不经过 Shell；这也是工具网关的命令白名单。</small></div></div>
                <label className="runtime-field runtime-field--code"><span>测试命令 JSON</span><textarea rows={5} value={testCommandsJson} onChange={(event) => setTestCommandsJson(event.target.value)} spellCheck={false} /></label>
                <div className="runtime-limits">
                  <label className="runtime-field"><span>上下文输入 Token</span><input type="number" min={256} max={2_000_000} value={draft.agentContextInputTokens} onChange={(event) => setDraft({ ...draft, agentContextInputTokens: Number(event.target.value) })} /></label>
                  <label className="runtime-field"><span>单次测试超时（毫秒）</span><input type="number" min={1_000} max={900_000} value={draft.agentMaxTestTimeoutMs} onChange={(event) => setDraft({ ...draft, agentMaxTestTimeoutMs: Number(event.target.value) })} /></label>
                </div>
              </div>
            </section>

            <section className="manifest-step">
              <span className="manifest-step__number">04</span>
              <div className="manifest-step__body">
                <div className="manifest-step__heading"><span><Bot size={18} /></span><div><strong>每个 Agent 使用的模型</strong><small>模型按 Agent 持久化；当前本地 Worker 支持 OpenAI Responses 适配器。</small></div></div>
                <div className="agent-model-list">
                  {runtime.configuration.agents.map((agent, index) => {
                    const model = draft.agentModels[index]
                    if (!model) return null
                    return <div key={agent.id}><span className="room-avatar room-avatar--agent"><Bot size={13} /></span><p><strong>{agent.name}</strong><small>{roleLabels[agent.role] ?? agent.role} · {agent.id}</small></p><label><span>提供商</span><input value={model.modelProvider} onChange={(event) => setDraft({ ...draft, agentModels: draft.agentModels.map((item, itemIndex) => itemIndex === index ? { ...item, modelProvider: event.target.value } : item) })} /></label><label><span>模型</span><input value={model.modelName} onChange={(event) => setDraft({ ...draft, agentModels: draft.agentModels.map((item, itemIndex) => itemIndex === index ? { ...item, modelName: event.target.value } : item) })} /></label></div>
                  })}
                </div>
              </div>
            </section>

            {formError || error ? <div className="runtime-form-error"><CircleAlert size={16} /><span>{formError ?? error}</span></div> : null}
            <div className="manifest-save"><span>保存后 Worker 才会读取新配置；已运行的进程需要停止后再启动。</span><button className="primary-action" disabled={Boolean(busy)} onClick={save}>{busy === 'save-runtime' ? <LoaderCircle className="is-spinning" size={16} /> : <Check size={16} />}保存运行配置</button></div>
          </div>

          <aside className="worker-launch-board">
            <header><div><span className="micro-label">本地进程控制</span><h2>Worker 启动台</h2></div><span className={`local-control-state${runtime.control.enabled ? ' is-enabled' : ''}`}><i />{runtime.control.enabled ? '本地控制已开启' : '仅观察模式'}</span></header>
            <div className="secret-boundary"><KeyRound size={17} /><div><strong>密钥边界</strong><p>{runtime.control.enabled ? 'API 只向 Agent 子进程注入 OPENAI_API_KEY，Web 永远不可见。' : '若要从 Web 启停进程，请在 API 环境显式设置 ENABLE_LOCAL_RUNTIME_CONTROL=true。'}</p></div></div>
            {runtime.control.enabled ? <div className="worker-launch-list">{runtime.control.workers.map((worker) => {
              const online = workerOnline(worker.kind, worker.agentId)
              const key = worker.kind + ':' + (worker.agentId ?? '')
              const working = busy === 'worker:' + key
              const canStop = worker.managedByThisApi
              return <article key={key} className={`${online ? 'is-online' : ''}${worker.ready ? '' : ' is-blocked'}`}><span className="worker-launch-icon"><Activity size={16} /></span><div><strong>{worker.label}</strong><small>{online ? '心跳在线' : worker.managedByThisApi ? '进程已启动，等待心跳' : worker.ready ? '可以启动' : `缺少：${worker.missing.join('、')}`}</small></div>{canStop ? <button className="worker-stop" disabled={working} onClick={() => onControl('stop', { kind: worker.kind, ...(worker.agentId ? { agentId: worker.agentId } : {}) })}>{working ? <LoaderCircle className="is-spinning" size={14} /> : <Square size={13} />}停止</button> : online ? <span className="external-process">外部进程</span> : <button className="worker-start" disabled={!worker.ready || working} onClick={() => onControl('start', { kind: worker.kind, ...(worker.agentId ? { agentId: worker.agentId } : {}) })}>{working ? <LoaderCircle className="is-spinning" size={14} /> : <Play size={13} />}启动</button>}</article>
            })}</div> : <div className="control-disabled-guide"><code>ENABLE_LOCAL_RUNTIME_CONTROL=true</code><p>重启 API 后，这里才会出现启动按钮。关闭时，相关路由直接返回 404。</p></div>}
            <footer><ShieldCheck size={15} /><span>只能停止由当前 API 进程启动的 Worker；外部终端进程不会被误杀。</span></footer>
          </aside>
        </div>
      </section>
    </div>
  )
}

function StartView({
  connection, setup, overview, mission, identity, busy, error, onIdentityChange, onCheck, onBootstrap, onCreate, onPropose, onApprove, onRefresh, onSelectMission, onOpenMission, onOpenTeam, onOpenRuntime,
}: {
  readonly connection: ConnectionState
  readonly setup: DevelopmentSetup | null
  readonly overview: ProjectOperatorOverview | null
  readonly mission: MissionSnapshot | null
  readonly identity: TestIdentity
  readonly busy: string | null
  readonly error: string | null
  readonly onIdentityChange: (identity: TestIdentity) => void
  readonly onCheck: () => void
  readonly onBootstrap: () => void
  readonly onCreate: (title: string, goal: string) => void
  readonly onPropose: () => void
  readonly onApprove: () => void
  readonly onRefresh: () => void
  readonly onSelectMission: (missionId: string) => void
  readonly onOpenMission: () => void
  readonly onOpenTeam: () => void
  readonly onOpenRuntime: () => void
}) {
  const [title, setTitle] = useState('构建一个可验证的 Agent 功能')
  const [goal, setGoal] = useState('让研究、构建和审查 Agent 按依赖顺序协作完成一个真实任务，并保留可审计的执行记录。')
  const planProposed = Boolean(mission?.proposedPlan)
  const visiblePlan = mission?.proposedPlan?.plan ?? guidedPlan
  const approved = Boolean(mission && !['planning', 'awaiting_approval'].includes(mission.status))
  const configuredAgents: readonly {
    readonly id: string
    readonly name: string
    readonly role: string
    readonly status: 'active' | 'paused' | 'disabled' | null
    readonly modelName: string | null
    readonly activeRunCount: number | null
    readonly worker: ProjectOperatorOverview['agents'][number]['worker']
  }[] = overview?.agents.map((agent) => ({ ...agent }))
    ?? setup?.agents.map((agent) => ({ ...agent, status: null, modelName: null, activeRunCount: null, worker: null }))
    ?? []
  const onlineAgentWorkers = overview?.agents.filter((agent) => agent.worker?.state === 'online').length ?? 0
  const scheduler = overview?.systemWorkers.find((worker) => worker.kind === 'scheduler')
  const terminalMission = Boolean(mission && ['completed', 'failed', 'cancelled'].includes(mission.status))
  const executionNeedsWorkers = approved && !terminalMission
  const unfinishedRoles = new Set(mission?.tasks
    .filter((task) => !['completed', 'cancelled'].includes(task.status))
    .map((task) => task.role)
    .filter((role): role is string => Boolean(role)) ?? [])
  const onlineRoles = new Set(overview?.agents
    .filter((agent) => agent.worker?.state === 'online')
    .map((agent) => agent.role) ?? [])
  const missingWorkerRoles = [...unfinishedRoles].filter((role) => !onlineRoles.has(role))
  const missingWorkerRoleLabels = missingWorkerRoles.map((role) => roleLabels[role] ?? role).join('、')
  const missingCriticalWorker = executionNeedsWorkers
    && (scheduler?.state !== 'online' || missingWorkerRoles.length > 0)
  const agentWorkerState = onlineAgentWorkers > 0
    ? 'online'
    : overview?.agents.some((agent) => agent.worker?.state === 'stale')
      ? 'stale'
      : overview?.agents.some((agent) => agent.worker?.state === 'stopped')
        ? 'stopped'
        : 'never_seen'
  const agentLastHeartbeat = overview?.agents
    .map((agent) => agent.worker?.lastHeartbeatAt ?? null)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null
  const runtimeServices = overview ? [
    ...overview.systemWorkers.filter((worker) => worker.kind === 'scheduler'),
    {
      kind: 'agent' as const,
      state: agentWorkerState,
      onlineCount: onlineAgentWorkers,
      lastHeartbeatAt: agentLastHeartbeat,
    },
    ...overview.systemWorkers.filter((worker) => worker.kind !== 'scheduler'),
  ] : []
  const currentStep = !setup ? 1 : !mission ? 2 : !planProposed ? 3 : !approved ? 4 : 5
  const stages: readonly {
    readonly label: string
    readonly detail: string
    readonly icon: LucideIcon
    readonly state: 'done' | 'active' | 'pending' | 'blocked'
  }[] = [
    {
      label: '控制平面', detail: connection === 'online' ? 'API 可用' : connection === 'checking' ? '正在检查' : '连接失败', icon: Database,
      state: connection === 'online' ? 'done' : connection === 'checking' ? 'active' : 'blocked',
    },
    {
      label: '工作区', detail: overview?.project.name ?? (setup ? identity.projectId : '尚未初始化'), icon: Users,
      state: setup ? 'done' : connection === 'online' ? 'active' : 'pending',
    },
    {
      label: '任务会话', detail: setup ? '可以讨论需求' : '等待工作区', icon: MessageCircle,
      state: mission ? 'done' : setup ? 'active' : 'pending',
    },
    {
      label: '执行计划', detail: planProposed ? `DAG v${mission?.planVersion}` : mission ? '等待 Planner' : '尚无 Mission', icon: Network,
      state: planProposed ? 'done' : mission ? 'active' : 'pending',
    },
    {
      label: 'Agent 执行', detail: mission?.status === 'completed' ? '已完成' : missingCriticalWorker ? '关键 Worker 未就绪' : approved ? missionStatusLabels[mission?.status ?? 'running'] : '等待批准', icon: Activity,
      state: mission?.status === 'completed' ? 'done' : missingCriticalWorker ? 'blocked' : approved ? 'active' : 'pending',
    },
  ]

  let action = {
    number: '01', eyebrow: '恢复连接', title: '先让控制平面可用',
    detail: 'Web 无法连接 API。启动 PostgreSQL、Redis 和 API 后，再从这里继续。',
    label: '重新检查连接', icon: RefreshCw, onClick: onCheck,
  }
  if (connection === 'online' && !setup) {
    action = {
      number: '02', eyebrow: '建立工作上下文', title: '初始化这个项目的 Agent 团队',
      detail: '创建本地 Workspace、Project、用户和规划/研究/构建/审查 Agent。这个操作幂等，可以安全重试。',
      label: '初始化工作区', icon: Database, onClick: onBootstrap,
    }
  } else if (connection === 'online' && setup && !mission) {
    action = {
      number: '03', eyebrow: '提出真实任务', title: '先和 Agent 团队说清楚要完成什么',
      detail: '进入协作室描述目标、约束和已有线索。讨论完成后勾选关键消息，交给 Planner 生成 Mission。',
      label: '进入协作室', icon: MessageCircle, onClick: onOpenTeam,
    }
  } else if (connection === 'online' && mission && !planProposed) {
    action = {
      number: '04', eyebrow: '等待规划', title: 'Planner 正在把讨论转成任务 DAG',
      detail: '回到协作室查看规划进度、失败原因和 Planner 的回复。刷新不会丢失已经创建的规划请求。',
      label: '查看 Planner 进度', icon: Bot, onClick: onOpenTeam,
    }
  } else if (connection === 'online' && mission?.status === 'awaiting_approval') {
    action = {
      number: '05', eyebrow: '需要你的决定', title: '检查计划，然后批准任务 DAG',
      detail: mission.proposedPlan?.summary ?? 'Planner 已经提交计划。批准后才会物化任务并允许 Scheduler 调度 Agent。',
      label: '批准并生成任务', icon: ShieldCheck, onClick: onApprove,
    }
  } else if (connection === 'online' && mission && missingCriticalWorker) {
    action = {
      number: '06', eyebrow: '执行进程未就绪',
      title: scheduler?.state !== 'online' ? '先启动 Scheduler，再启动任务 Agent' : `启动${missingWorkerRoleLabels || '任务'} Agent Worker`,
      detail: `Mission 已经批准，但${missingWorkerRoleLabels ? ` ${missingWorkerRoleLabels}角色` : ''}没有有效进程心跳。Web 不会把“Agent 已启用”误判为“Worker 在线”。`,
      label: '查看启动命令', icon: CircleAlert,
      onClick: () => document.getElementById('worker-runtime')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    }
  } else if (connection === 'online' && mission) {
    action = {
      number: '07', eyebrow: mission.status === 'completed' ? '交付已完成' : '观察与干预',
      title: mission.status === 'completed' ? '检查最终交付与证据' : '进入 Mission 查看 Agent 执行',
      detail: mission.status === 'completed'
        ? '任务已经完成。打开 Mission 核对任务状态、证据和交付结果。'
        : '查看任务依赖、当前状态和等待中的门禁；需要调整方向时回到协作室 @Agent。',
      label: '打开 Mission', icon: Network, onClick: onOpenMission,
    }
  }
  const ActionIcon = action.icon

  return (
    <>
      <section className="workbench-heading">
        <div><span className="micro-label">RunGuild 操作工作台</span><h1>现在要推进哪一步？</h1><p>这里不展示虚构指标，只汇总 Web 当前能够确认的真实状态，并把你带到下一项可执行操作。</p></div>
        <button className="secondary-action" onClick={onCheck} disabled={Boolean(busy)}><RefreshCw className={busy === 'health' ? 'is-spinning' : ''} size={15} />检查系统</button>
      </section>

      <section className="operation-runway" aria-label="真实任务路径">
        <header><span>真实任务路径</span><code>{mission ? mission.id : identity.projectId}</code></header>
        <div>{stages.map((stage, index) => { const Icon = stage.icon; return <div className={`runway-stage runway-stage--${stage.state}`} key={stage.label}><span>{stage.state === 'done' ? <Check size={14} /> : <Icon size={15} />}</span><div><strong>{stage.label}</strong><small>{stage.detail}</small></div><code>{String(index + 1).padStart(2, '0')}</code></div> })}</div>
      </section>

      {overview ? <section className="runtime-deck" id="worker-runtime" aria-label="Worker 运行状态"><header><span className="micro-label">运行进程</span><strong>数据库心跳</strong><small>每 5 秒自动刷新</small><button onClick={onOpenRuntime}><Settings size={13} />配置与启停</button></header><div className="runtime-deck__services">{runtimeServices.map((worker) => { const meta = workerKindLabels[worker.kind]; return <article className={`runtime-service runtime-service--${worker.state}`} key={worker.kind}><span className="runtime-service__signal"><i /><Activity size={14} /></span><div><strong>{meta.label}</strong><small>{meta.purpose}</small></div><p><b>{workerStateLabels[worker.state]}</b><small>{worker.onlineCount ? `${worker.onlineCount} 个实例` : heartbeatTime(worker.lastHeartbeatAt)}</small></p></article> })}</div>{missingCriticalWorker ? <div className="runtime-start-guide"><CircleAlert size={16} /><span><strong>Mission 暂时不会推进</strong><small>{missingWorkerRoleLabels ? `缺少 ${missingWorkerRoleLabels} Agent；` : ''}打开启动台补齐配置并启动对应进程。</small></span><button onClick={onOpenRuntime}><Play size={13} />打开 Worker 启动台</button></div> : null}</section> : null}

      {connection === 'offline' ? (
        <section className="local-start-guide">
          <div><span className="micro-label">第一次运行</span><h2>先在项目根目录启动依赖与 API</h2><p>复制 .env.example 为 .env；若要从 Web 启停 Worker，请显式打开本地控制并填入模型密钥。</p></div>
          <div className="command-block"><span>终端 1</span><code>docker compose up -d postgres redis</code></div>
          <div className="command-block"><span>终端 2</span><code>cp .env.example .env · 编辑配置 · npm run api:local</code></div>
        </section>
      ) : null}

      {error ? <div className="test-error"><CircleAlert size={18} /><div><strong>这一步没有成功</strong><p>{error}</p>{error.includes('development') || error.includes('HTTP 404') ? <code>在 .env 中设置 ENABLE_DEV_BOOTSTRAP=true，然后重启 API</code> : null}</div></div> : null}

      <div className="workbench-grid">
        <section className="next-action-card">
          <span className="next-action-card__number">{action.number}</span>
          <div className="next-action-card__copy"><span className="micro-label">{action.eyebrow}</span><h2>{action.title}</h2><p>{action.detail}</p></div>
          {mission?.status === 'awaiting_approval' && mission.proposedPlan ? <div className="approval-preview"><div><strong>{mission.proposedPlan.plan.tasks.length} 个任务</strong><code>计划版本 {mission.proposedPlan.version}</code></div><ol>{mission.proposedPlan.plan.tasks.map((task) => <li key={task.key}><span>{roleLabels[task.role]}</span><strong>{task.title}</strong><small>{task.dependsOn.length ? `依赖 ${task.dependsOn.join('、')}` : '可首先执行'}</small></li>)}</ol></div> : null}
          <div className="next-action-card__actions"><button className="primary-action" onClick={action.onClick} disabled={Boolean(busy)}>{busy ? <LoaderCircle className="is-spinning" size={16} /> : <ActionIcon size={16} />}{action.label}<ArrowRight size={14} /></button>{mission ? <button className="secondary-action" onClick={onRefresh} disabled={Boolean(busy)}><RefreshCw size={14} />刷新 Mission</button> : null}</div>
        </section>

        <aside className="current-context">
          <div className="current-context__heading"><div><span className="micro-label">当前工作上下文</span><h2>{overview?.project.name ?? (setup ? identity.projectId : '尚未建立工作区')}</h2></div><span className={`context-live context-live--${connection}`}><i />{connection === 'online' ? 'API 已连接' : connection === 'checking' ? '检查中' : 'API 未连接'}</span></div>
          <dl><div><dt>代码仓库</dt><dd><code>{overview?.project.repositoryPath ?? overview?.project.repositoryUrl ?? '未配置'}</code></dd></div><div><dt>默认分支</dt><dd><code>{overview?.project.defaultBranch ?? '—'}</code></dd></div><div><dt>Conversation</dt><dd><code>{overview?.project.conversationId ?? setup?.conversationId ?? '—'}</code></dd></div><div><dt>当前 Mission</dt><dd>{mission ? <><strong>{mission.title}</strong><small>{missionStatusLabels[mission.status]} · {mission.tasks.length} 个任务</small></> : <span>尚未选择</span>}</dd></div></dl>
          <div className="configured-agents"><div><span className="micro-label">项目 Agent 配置</span><code>{overview ? configuredAgents.length : setup ? configuredAgents.length || '读取中' : '—'}</code></div>{configuredAgents.length ? configuredAgents.map((agent) => <div key={agent.id}><span className="room-avatar room-avatar--agent"><Bot size={13} /></span><p><strong>{agent.name}</strong><small>{roleLabels[agent.role] ?? agent.role}{agent.modelName ? ` · ${agent.modelName}` : ''}</small>{agent.activeRunCount !== null ? <em className={`agent-runtime agent-runtime--${agent.worker?.state ?? 'never_seen'}`}><i />{agent.worker ? `Worker ${workerStateLabels[agent.worker.state]} · ${heartbeatTime(agent.worker.lastHeartbeatAt)}` : 'Worker 未启动'}{agent.activeRunCount ? ` · ${agent.activeRunCount} 个 Run` : ''}</em> : null}</p></div>) : <p>{setup ? '正在从项目协作室读取 Agent 配置。' : '初始化工作区后，这里会显示真实 Agent 配置。'}</p>}<p className="runtime-disclaimer">进程状态由持久化心跳判定，超过实例声明的有效期会显示“心跳失联”。</p></div>
        </aside>
      </div>

      {overview ? (
        <section className="mission-register">
          <header><div><span className="micro-label">项目 Mission</span><h2>继续已有任务，或从协作室发起新任务</h2></div><code>{overview.missions.length} 条真实记录</code></header>
          {overview.missions.length ? <div className="mission-register__list">{overview.missions.map((item) => {
            const selected = mission?.id === item.id
            return <button key={item.id} className={selected ? 'is-selected' : ''} onClick={() => onSelectMission(item.id)} disabled={Boolean(busy)}><span className={`mission-register__status mission-register__status--${item.status}`}><i />{missionStatusLabels[item.status]}</span><div><strong>{item.title}</strong><code>{item.id}</code></div><span><strong>{item.completedTaskCount}/{item.taskCount}</strong><small>任务完成</small></span><span><strong>{item.activeRunCount}</strong><small>执行中 Run</small></span><time>{new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(item.updatedAt))}</time><ArrowRight size={15} /></button>
          })}</div> : <div className="mission-register__empty"><Network size={19} /><span><strong>这个项目还没有 Mission</strong><small>进入协作室，勾选关键消息并交给 Planner。</small></span><button onClick={onOpenTeam}>进入协作室<ArrowRight size={13} /></button></div>}
        </section>
      ) : null}

      <details className="developer-diagnostics">
        <summary><span><Settings size={16} /><strong>开发者诊断与手动控制面测试</strong><small>直接调用底层 Mission API；日常使用不需要展开</small></span><code>DEV</code></summary>
        <div className="diagnostic-body"><div className="diagnostic-intro"><div><Database size={18} /><span><strong>用途</strong>隔离测试初始化、Mission 创建、计划提交和批准事务。</span></div><div><Bot size={18} /><span><strong>注意</strong>这里保留的是开发路径，正常任务请从协作室开始。</span></div></div>
        <div className="test-steps">
        <section className={`test-step${currentStep === 1 ? ' is-active' : ''}`}>
          <StepMarker number={1} state={setup ? 'done' : currentStep === 1 ? 'active' : 'pending'} />
          <div className="test-step__body">
            <div className="test-step__heading"><div><span className="micro-label">准备数据</span><h2>初始化本地测试环境</h2></div>{setup ? <StatusPill tone="verified">已完成</StatusPill> : null}</div>
            <p>幂等创建一个 Workspace、Project、开发用户，以及规划/研究/构建/审查四个 Agent。重复点击不会产生重复数据。</p>
            <div className="identity-grid">
              <label>工作区 ID<input value={identity.workspaceId} disabled={Boolean(setup)} onChange={(event) => onIdentityChange({ ...identity, workspaceId: event.target.value })} /></label>
              <label>项目 ID<input value={identity.projectId} disabled={Boolean(setup)} onChange={(event) => onIdentityChange({ ...identity, projectId: event.target.value })} /></label>
              <label>用户 ID<input value={identity.userId} disabled={Boolean(setup)} onChange={(event) => onIdentityChange({ ...identity, userId: event.target.value })} /></label>
            </div>
            <button className="primary-action" disabled={connection !== 'online' || Boolean(setup) || Boolean(busy)} onClick={onBootstrap}>
              {busy === 'bootstrap' ? <LoaderCircle className="is-spinning" size={16} /> : <Database size={16} />}{setup ? '环境已初始化' : '初始化测试环境'}
            </button>
          </div>
        </section>

        <section className={`test-step${currentStep === 2 ? ' is-active' : ''}`}>
          <StepMarker number={2} state={mission ? 'done' : currentStep === 2 ? 'active' : 'pending'} />
          <div className="test-step__body">
            <div className="test-step__heading"><div><span className="micro-label">创建目标</span><h2>创建一条真实 Mission</h2></div>{mission ? <StatusPill tone="verified">已创建</StatusPill> : null}</div>
            <p>Mission 是用户目标和约束的顶层容器。此时状态为“规划中”，还没有生成任务。</p>
            <div className="mission-form">
              <label>Mission 标题<input value={mission?.title ?? title} disabled={Boolean(mission)} onChange={(event) => setTitle(event.target.value)} /></label>
              <label>目标描述<textarea value={mission?.goal ?? goal} disabled={Boolean(mission)} rows={3} onChange={(event) => setGoal(event.target.value)} /></label>
            </div>
            {mission ? <code className="created-id">{mission.id}</code> : null}
            <button className="primary-action" disabled={!setup || Boolean(mission) || Boolean(busy) || !title.trim() || !goal.trim()} onClick={() => onCreate(title, goal)}>
              {busy === 'create' ? <LoaderCircle className="is-spinning" size={16} /> : <Plus size={16} />}{mission ? 'Mission 已创建' : '创建 Mission'}
            </button>
          </div>
        </section>

        <section className={`test-step${currentStep === 3 ? ' is-active' : ''}`}>
          <StepMarker number={3} state={planProposed ? 'done' : currentStep === 3 ? 'active' : 'pending'} />
          <div className="test-step__body">
            <div className="test-step__heading"><div><span className="micro-label">形成协作方案</span><h2>提交多 Agent 执行计划</h2></div>{planProposed ? <StatusPill tone="verified">版本 {mission?.planVersion}</StatusPill> : null}</div>
            <p>{mission?.proposedPlan?.summary ?? '这份计划会被后端校验为无环 DAG：研究完成后构建，构建完成后独立审查。'}</p>
            <div className="plan-preview">
              {visiblePlan.tasks.map((task, index) => <div key={task.key}><span>{index + 1}</span><div><strong>{task.title}</strong><small>{roleLabels[task.role]}{task.dependsOn.length ? ` · 依赖 ${task.dependsOn.join(', ')}` : ' · 无依赖'}</small></div>{index < visiblePlan.tasks.length - 1 ? <ArrowRight size={16} /> : null}</div>)}
            </div>
            <button className="primary-action" disabled={!mission || planProposed || Boolean(busy)} onClick={onPropose}>
              {busy === 'propose' ? <LoaderCircle className="is-spinning" size={16} /> : <Network size={16} />}{planProposed ? '计划已提交' : '提交计划并等待批准'}
            </button>
          </div>
        </section>

        <section className={`test-step${currentStep === 4 ? ' is-active' : approved ? 'is-complete' : ''}`}>
          <StepMarker number={4} state={approved ? 'done' : currentStep === 4 ? 'active' : 'pending'} />
          <div className="test-step__body">
            <div className="test-step__heading"><div><span className="micro-label">人工门禁</span><h2>批准计划并生成 DAG</h2></div>{approved ? <StatusPill tone="verified">已生成 {mission?.tasks.length} 个任务</StatusPill> : null}</div>
            <p>批准操作必须由人类用户完成。后端会在一个事务中冻结计划版本、生成任务与依赖，并把 Mission 切换为“运行中”。</p>
            {approved ? (
              <div className="success-result"><CircleCheck size={21} /><div><strong>控制面测试已经跑通</strong><span>数据已持久化。启动 Scheduler 与 Agent Worker 后，准备就绪的任务才会被领取并调用模型。</span></div></div>
            ) : null}
            <div className="step-actions">
              <button className="primary-action" disabled={!planProposed || approved || Boolean(busy)} onClick={onApprove}>{busy === 'approve' ? <LoaderCircle className="is-spinning" size={16} /> : <ShieldCheck size={16} />}{approved ? '计划已批准' : '由我批准并生成 DAG'}</button>
              {approved ? <button className="secondary-action" onClick={onOpenMission}>打开真实任务图<ArrowRight size={15} /></button> : null}
              {mission ? <button className="secondary-action" disabled={Boolean(busy)} onClick={onRefresh}><RefreshCw size={15} />刷新状态</button> : null}
            </div>
          </div>
        </section>
        </div></div>
      </details>
    </>
  )
}

function mapMissionTasks(mission: MissionSnapshot): MissionTask[] {
  return mission.tasks.map((task, index) => {
    const planTask = mission.proposedPlan?.plan.tasks[index]
    let status: TaskStatus = 'queued'
    if (task.status === 'completed') status = 'verified'
    else if (['claimed', 'running', 'reviewing'].includes(task.status)) status = 'running'
    else if (['blocked', 'waiting_human'].includes(task.status)) status = 'waiting'
    return {
      id: task.id,
      key: `任务-${String(index + 1).padStart(2, '0')}`,
      title: task.title,
      role: roleLabels[task.role ?? 'custom'] ?? task.role ?? '待分配',
      agent: task.status === 'blocked' ? '等待依赖' : '等待调度',
      status,
      statusLabel: task.status === 'ready' ? '已就绪，等待 Scheduler' : missionStatusLabels[task.status] ?? task.status,
      summary: planTask?.description ?? '任务已经由已批准计划生成。',
      duration: '—', attempts: 0, model: '由 Worker 配置', dependsOn: task.dependsOn,
      criteria: planTask?.acceptanceCriteria.map((criterion) => ({ label: criterion.description, passed: task.status === 'completed' })) ?? [],
    }
  })
}

function MissionContract({ mission }: { readonly mission: MissionSnapshot }) {
  return (
    <section className="mission-contract" aria-label="Mission 契约">
      <div className="contract-cell contract-cell--goal"><span className="micro-label">Mission 目标</span><strong>{mission.goal}</strong></div>
      <div className="contract-cell"><span className="micro-label">数据来源</span><code>真实 API</code><small>{mission.id}</small></div>
      <div className="contract-cell"><span className="micro-label">计划版本</span><code>v{mission.planVersion}</code><small>{mission.proposedPlan?.status ?? '尚未提交'}</small></div>
      <div className="contract-cell"><span className="micro-label">当前状态</span><code className="proof-value">{missionStatusLabels[mission.status]}</code><small>{mission.tasks.length} 个任务</small></div>
    </section>
  )
}

function EvidenceSpine({ facts, selectedTask }: { readonly facts: readonly EvidenceFact[]; readonly selectedTask: MissionTask }) {
  const filtered = facts.filter((fact) => fact.taskId === selectedTask.id || fact.state === 'pending')
  return (
    <aside className="evidence-panel">
      <div className="panel-heading"><div><span className="micro-label">Mission Read Model</span><h2>任务状态事实</h2></div><StatusPill tone="live"><span className="pulse-dot" />真实数据</StatusPill></div>
      <p className="panel-intro">这里仅展示当前 Mission API 返回的状态。<strong>{selectedTask.key}</strong> 的运行与证据账本尚未接入这个页面。</p>
      {filtered.length ? <ol className="evidence-spine">{filtered.map((fact) => <li key={fact.id} className={`evidence-fact evidence-fact--${fact.state}`}><span className="evidence-fact__sequence">{fact.sequence}</span><div className="evidence-fact__content"><div className="evidence-fact__meta"><span>{fact.kind}</span><time>{fact.time}</time></div><strong>{fact.title}</strong><code>{fact.detail}</code></div></li>)}</ol> : <div className="empty-evidence">Mission API 尚未返回任务状态。</div>}
      <button className="quiet-action" disabled><Activity size={15} />运行记录 API 尚未接入</button>
    </aside>
  )
}

function TaskInspector({ task }: { readonly task: MissionTask }) {
  const passed = task.criteria.filter((criterion) => criterion.passed).length
  return (
    <section className="task-inspector">
      <div className="task-inspector__identity"><div className={`agent-medallion agent-medallion--${task.status}`}><Bot size={21} strokeWidth={1.8} /></div><div><span className="micro-label">当前选中任务</span><h2>{task.title}</h2><p>{task.summary}</p></div></div>
      <dl className="run-facts"><div><dt>执行者</dt><dd>{task.agent} · {task.role}</dd></div><div><dt>模型</dt><dd><code>{task.model}</code></dd></div><div><dt>运行时长</dt><dd><code>{task.duration}</code></dd></div><div><dt>尝试次数</dt><dd><code>{task.attempts || '尚未开始'}</code></dd></div></dl>
      <div className="criteria-list"><div className="criteria-list__heading"><span>验收门禁</span><code>{passed}/{task.criteria.length}</code></div>{task.criteria.map((criterion) => <div key={criterion.label} className={criterion.passed ? 'is-passed' : ''}><span>{criterion.passed ? <Check size={13} /> : <Clock3 size={13} />}</span><p>{criterion.label}</p></div>)}</div>
    </section>
  )
}

function MissionView({ mission, busy, error, onNavigate, onRefresh, onApproveDelivery }: {
  readonly mission: MissionSnapshot | null
  readonly busy: string | null
  readonly error: string | null
  readonly onNavigate: (view: View) => void
  readonly onRefresh: () => void
  readonly onApproveDelivery: () => void
}) {
  const tasks = useMemo(() => mission ? mapMissionTasks(mission) : [], [mission])
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[0]?.id ?? '')
  useEffect(() => { if (!tasks.some((task) => task.id === selectedTaskId)) setSelectedTaskId(tasks[0]?.id ?? '') }, [selectedTaskId, tasks])
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0]
  if (!mission) return <section className="product-empty-state"><span><Network size={26} /></span><div><span className="micro-label">尚无 Mission</span><h1>先从一次真实任务讨论开始</h1><p>进入协作室描述目标并选择关键消息。Planner 提交计划、你批准之后，任务 DAG 才会出现在这里。</p></div><button className="primary-action" onClick={() => onNavigate('team')}>进入协作室<ArrowRight size={15} /></button></section>
  if (!selectedTask) return <><section className="page-heading page-heading--mission"><div><div className="breadcrumb"><span>Mission</span><i>/</i><code>{mission.id}</code></div><h1>{mission.title}</h1><p>这个 Mission 已创建，但任务 DAG 尚未物化。</p></div><div className="page-actions"><StatusPill tone="active">{missionStatusLabels[mission.status]}</StatusPill><button className="secondary-action" onClick={onRefresh}><RefreshCw size={15} />刷新</button></div></section><MissionContract mission={mission} /><section className="mission-awaiting-state"><Network size={25} /><div><strong>{mission.status === 'awaiting_approval' ? '计划正在等待你的批准' : 'Planner 还没有提交可执行计划'}</strong><p>{mission.proposedPlan?.summary ?? '回到协作室查看 Planner 的规划进度。'}</p></div><button className="primary-action" onClick={() => onNavigate(mission.status === 'awaiting_approval' ? 'start' : 'team')}>{mission.status === 'awaiting_approval' ? '去工作台批准' : '查看协作室'}<ArrowRight size={14} /></button></section></>
  const liveFacts: EvidenceFact[] = mission.tasks.map((task, index) => ({ id: task.id, taskId: task.id, sequence: String(index + 1).padStart(2, '0'), time: new Date(mission.updatedAt).toLocaleTimeString('zh-CN'), kind: '任务状态', title: `${task.title}：${task.status}`, detail: task.id, state: task.status === 'completed' ? 'verified' : ['claimed', 'running', 'reviewing'].includes(task.status) ? 'active' : 'pending' }))
  return (
    <>
      <section className="page-heading page-heading--mission"><div><div className="breadcrumb"><span>Mission</span><i>/</i><code>{mission.id}</code></div><h1>{mission.title}</h1><p>以下任务和依赖直接读取自后端数据库。</p></div><div className="page-actions"><StatusPill tone="active"><span className="pulse-dot" />{missionStatusLabels[mission.status]}</StatusPill><button className="secondary-action" onClick={onRefresh}><RefreshCw size={15} />刷新</button><button className="primary-action" onClick={() => onNavigate('team')}><MessageCircle size={15} />打开协作室</button></div></section>
      <MissionContract mission={mission} />
      {mission.status === 'reviewing' || mission.status === 'completed' ? <section className={`final-delivery-gate final-delivery-gate--${mission.finalDelivery?.approvalStatus ?? 'missing'}`}>
        <span className="final-delivery-gate__mark">{mission.finalDelivery?.approvalStatus === 'approved' ? <CircleCheck size={22} /> : mission.finalDelivery ? <ShieldCheck size={22} /> : <CircleAlert size={22} />}</span>
        <div>
          <span className="micro-label">Final delivery gate</span>
          <strong>{mission.finalDelivery?.approvalStatus === 'approved' ? '最终交付版本已批准' : mission.finalDelivery ? '所有 Task 已完成，等待最终人工批准' : '缺少可冻结的最终交付版本'}</strong>
          {mission.finalDelivery ? <p>Artifact Version <code>v{mission.finalDelivery.version}</code> · <code>{mission.finalDelivery.artifactVersionId}</code> · SHA-256 <code>{mission.finalDelivery.contentHash.slice(0, 16)}…</code></p> : <p>Mission 已进入审查态，但数据库中没有属于该 Mission 的 Artifact Version。请先排查产物冻结链路。</p>}
          {error && busy === null ? <em>{error}</em> : null}
        </div>
        {mission.status === 'reviewing' && mission.finalDelivery ? <button className="primary-action" onClick={onApproveDelivery} disabled={Boolean(busy)}>{busy === 'approve-delivery' ? <LoaderCircle className="is-spinning" size={15} /> : <ShieldCheck size={15} />}批准此版本并完成 Mission</button> : null}
      </section> : null}
      <div className="mission-workspace"><section className="topology-panel"><div className="panel-heading panel-heading--topology"><div><span className="micro-label">已批准计划 · 版本 {mission.planVersion}</span><h2>任务依赖拓扑</h2></div><span className="topology-summary">点击节点查看任务详情</span></div><MissionGraph tasks={tasks} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} /></section><EvidenceSpine facts={liveFacts} selectedTask={selectedTask} /><TaskInspector task={selectedTask} /></div>
    </>
  )
}

const deliveryLabels = {
  steered: '已唤醒当前 Run',
  context_pending: '等待下次 Run',
  context_loaded: '已进入 Run 上下文',
} as const

const planningStatusLabels: Record<ConversationPlanningRequest['status'], string> = {
  queued: '已排队，等待 Planner',
  running: 'Planner 正在分析消息',
  model_complete: 'DAG 已生成，正在持久化',
  awaiting_approval: '计划已就绪，等待你批准',
  approved: '计划已批准',
  failed: '规划失败',
}

function messageTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function TeamRoomView({
  identity,
  setup,
  mission,
  onNavigate,
  onMissionReady,
}: {
  readonly identity: TestIdentity
  readonly setup: DevelopmentSetup | null
  readonly mission: MissionSnapshot | null
  readonly onNavigate: (view: View) => void
  readonly onMissionReady: (mission: MissionSnapshot) => void
}) {
  const [conversations, setConversations] = useState<readonly ConversationSnapshot[]>([])
  const [conversationId, setConversationId] = useState(setup?.conversationId ?? '')
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([])
  const [selectedAgents, setSelectedAgents] = useState<readonly string[]>([])
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<ConversationMessage | null>(null)
  const [selectedMessageIds, setSelectedMessageIds] = useState<readonly string[]>([])
  const [planningTitle, setPlanningTitle] = useState('')
  const [planningRequest, setPlanningRequest] = useState<ConversationPlanningRequest | null>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [planningBusy, setPlanningBusy] = useState(false)
  const [roomError, setRoomError] = useState<string | null>(null)
  const activeConversation = conversations.find((conversation) => conversation.id === conversationId)
  const agents = useMemo(
    () => activeConversation?.members.filter((member) => member.kind === 'agent') ?? [],
    [activeConversation],
  )
  const latestRoutedMessage = [...messages].reverse().find((message) => message.deliveries.length > 0)
  const planner = agents.find((agent) => agent.role === 'planner')
  const planningRequestId = planningRequest?.id
  const planningRequestStatus = planningRequest?.status

  useEffect(() => {
    if (!setup) return
    let stopped = false
    const load = async () => {
      try {
        const rooms = await missionApi.listConversations(identity)
        if (stopped) return
        setConversations(rooms)
        const nextId = rooms.some((room) => room.id === conversationId)
          ? conversationId
          : rooms.find((room) => room.id === setup.conversationId)?.id ?? rooms[0]?.id ?? ''
        setConversationId(nextId)
        if (nextId) setMessages(await missionApi.listMessages(identity, nextId))
        if (!stopped) setRoomError(null)
      } catch (caught) {
        if (!stopped) setRoomError(caught instanceof Error ? caught.message : '协作室加载失败')
      } finally {
        if (!stopped) setLoading(false)
      }
    }
    setLoading(true)
    void load()
    const interval = window.setInterval(() => void load(), 5_000)
    return () => { stopped = true; window.clearInterval(interval) }
  }, [conversationId, identity, setup])

  useEffect(() => {
    if (selectedAgents.length > 0 || agents.length === 0) return
    const defaultAgent = planner ?? agents[0]
    if (defaultAgent) setSelectedAgents([defaultAgent.id])
  }, [agents, planner, selectedAgents.length])

  useEffect(() => {
    setSelectedMessageIds([])
    setPlanningTitle('')
    setPlanningRequest(null)
    if (!conversationId) return
    let stopped = false
    const storageKey = 'runguild:last-planning:' + conversationId
    const requestId = window.localStorage.getItem(storageKey)
    if (requestId) {
      void missionApi.getPlanningRequest(identity, requestId).then(async (request) => {
        if (stopped) return
        setPlanningRequest(request)
        if (request.status === 'awaiting_approval' || request.status === 'approved') {
          const snapshot = await missionApi.getMission(identity, request.missionId)
          if (!stopped) onMissionReady(snapshot)
        }
      }).catch(() => window.localStorage.removeItem(storageKey))
    }
    return () => { stopped = true }
  }, [conversationId, identity, onMissionReady])

  useEffect(() => {
    if (!planningRequestId || !planningRequestStatus || !['queued', 'running', 'model_complete'].includes(planningRequestStatus)) return
    let stopped = false
    const sync = async () => {
      try {
        const next = await missionApi.getPlanningRequest(identity, planningRequestId)
        if (stopped) return
        setPlanningRequest(next)
        if (next.status === 'awaiting_approval' || next.status === 'approved') {
          const snapshot = await missionApi.getMission(identity, next.missionId)
          if (!stopped) onMissionReady(snapshot)
        }
      } catch (caught) {
        if (!stopped) setRoomError(caught instanceof Error ? caught.message : '规划进度读取失败')
      }
    }
    void sync()
    const interval = window.setInterval(() => void sync(), 3_000)
    return () => { stopped = true; window.clearInterval(interval) }
  }, [identity, onMissionReady, planningRequestId, planningRequestStatus])

  const refreshRoom = () => {
    if (!conversationId) return
    setLoading(true)
    setRoomError(null)
    void missionApi.listMessages(identity, conversationId)
      .then(setMessages)
      .catch((caught: unknown) => setRoomError(caught instanceof Error ? caught.message : '消息刷新失败'))
      .finally(() => setLoading(false))
  }
  const toggleAgent = (agentId: string) => setSelectedAgents((current) =>
    current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId])
  const togglePlanningMessage = (message: ConversationMessage) => {
    setSelectedMessageIds((current) => current.includes(message.id)
      ? current.filter((id) => id !== message.id)
      : [...current, message.id])
    setPlanningTitle((current) => current || message.body.trim().slice(0, 42) || '从协作消息生成 Mission')
  }
  const createPlanningRequest = async () => {
    if (!conversationId || selectedMessageIds.length === 0 || !planningTitle.trim() || planningBusy) return
    setPlanningBusy(true)
    setRoomError(null)
    try {
      const request = await missionApi.createPlanningRequest({
        identity,
        conversationId,
        sourceMessageIds: selectedMessageIds,
        title: planningTitle.trim(),
        ...(planner ? { plannerAgentId: planner.id } : {}),
      })
      setPlanningRequest(request)
      window.localStorage.setItem('runguild:last-planning:' + conversationId, request.id)
      setSelectedMessageIds([])
    } catch (caught) {
      setRoomError(caught instanceof Error ? caught.message : '创建规划请求失败')
    } finally {
      setPlanningBusy(false)
    }
  }
  const sendMessage = async () => {
    if (!conversationId || !draft.trim() || sending) return
    setSending(true)
    setRoomError(null)
    try {
      const message = await missionApi.postMessage({
        identity,
        conversationId,
        body: draft,
        mentions: selectedAgents,
        ...(mission ? { missionId: mission.id } : {}),
        ...(replyTo ? { replyToMessageId: replyTo.id } : {}),
      })
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
      setDraft('')
      setReplyTo(null)
    } catch (caught) {
      setRoomError(caught instanceof Error ? caught.message : '消息发送失败')
    } finally {
      setSending(false)
    }
  }

  if (!setup) {
    return (
      <section className="room-onboarding">
        <span className="room-onboarding__icon"><MessageCircle size={28} /></span>
        <div><span className="micro-label">真实协作入口</span><h1>先初始化 Agent 团队</h1><p>协作室不是演示聊天。初始化后，Web 消息会写入 PostgreSQL；你既能从选中消息创建 Mission，也能把 @Agent 请求路由到运行中的任务。</p></div>
        <button className="primary-action" onClick={() => onNavigate('start')}>去开始测试<ArrowRight size={15} /></button>
      </section>
    )
  }

  return (
    <>
      <section className="page-heading room-heading">
        <div><div className="breadcrumb"><span>Conversation Plane</span><i>/</i><code>{conversationId || '尚未创建'}</code></div><h1>团队协作室</h1><p>先讨论和沉淀上下文，再选择关键消息交给 Planner 生成长任务 DAG；Mission 运行中也可以随时 @Agent 调整方向。</p></div>
        <div className="page-actions"><StatusPill tone="live"><span className="pulse-dot" />5 秒同步</StatusPill><button className="secondary-action" onClick={refreshRoom} disabled={loading}><RefreshCw className={loading ? 'is-spinning' : ''} size={15} />刷新消息</button></div>
      </section>
      {roomError ? <div className="test-error"><CircleAlert size={18} /><div><strong>协作请求没有完成</strong><p>{roomError}</p></div></div> : null}
      <div className="room-workspace">
        <aside className="room-directory">
          <div className="room-directory__heading"><span className="micro-label">项目会话</span><strong>{conversations.length}</strong></div>
          <div className="room-list">
            {conversations.map((conversation) => (
              <button key={conversation.id} className={conversation.id === conversationId ? 'is-active' : ''} onClick={() => setConversationId(conversation.id)}>
                <span><MessageCircle size={15} /></span><div><strong>{conversation.title}</strong><small>{conversation.members.length} 位成员 · {conversation.kind === 'project_room' ? '项目房间' : '协作组'}</small></div>
              </button>
            ))}
          </div>
          <div className="room-team-heading"><span className="micro-label">持久化成员</span><Users size={15} /></div>
          <div className="room-members">
            {activeConversation?.members.map((member) => (
              <div key={member.kind + member.id}>
                <span className={`room-avatar room-avatar--${member.kind}`}>{member.kind === 'agent' ? <Bot size={14} /> : '你'}</span>
                <p><strong>{member.name}</strong><small>{member.kind === 'agent' ? roleLabels[member.role ?? 'custom'] : '人工操作者'}</small></p>
                <i className={member.status === 'disabled' ? 'is-offline' : ''} title={member.status === 'disabled' ? '已禁用' : '可参与'} />
              </div>
            ))}
          </div>
        </aside>

        <section className="room-thread">
          <header className="room-thread__header"><div><span className="micro-label">有序持久化消息</span><h2>{activeConversation?.title ?? '正在加载协作室'}</h2></div><div className="thread-selection"><code>{selectedMessageIds.length ? `已选 ${selectedMessageIds.length} 条` : `${messages.length} 条事实`}</code>{selectedMessageIds.length ? <button onClick={() => setSelectedMessageIds([])}>清除</button> : null}</div></header>
          <div className="message-stream" aria-live="polite">
            {loading && messages.length === 0 ? <div className="room-empty"><LoaderCircle className="is-spinning" size={22} /><strong>正在读取协作记录</strong></div> : null}
            {!loading && messages.length === 0 ? <div className="room-empty"><MessageCircle size={25} /><strong>从一条明确的协调请求开始</strong><span>选择要行动的 Agent，绑定当前 Mission，然后发送。</span></div> : null}
            {messages.map((message) => {
              const authorAgent = message.author.kind === 'agent'
              return (
                <article className={`room-message${message.author.id === identity.userId ? ' is-mine' : ''}`} key={message.id}>
                  <button className={`message-select${selectedMessageIds.includes(message.id) ? ' is-selected' : ''}`} aria-label={selectedMessageIds.includes(message.id) ? '取消选择这条消息' : '选择这条消息用于生成 Mission'} onClick={() => togglePlanningMessage(message)}>{selectedMessageIds.includes(message.id) ? <Check size={12} /> : null}</button>
                  <span className={`room-avatar room-avatar--${authorAgent ? 'agent' : 'user'}`}>{authorAgent ? <Bot size={15} /> : '你'}</span>
                  <div className="room-message__main">
                    <div className="room-message__meta"><strong>{message.authorName}</strong><span>{authorAgent ? 'Agent' : message.author.kind === 'system' ? '系统' : '人工'}</span><time>{messageTime(message.createdAt)}</time><code>#{message.sequence}</code></div>
                    {message.replyToMessageId ? <span className="reply-reference">回复 {message.replyToMessageId}</span> : null}
                    <p>{message.body}</p>
                    <div className="message-routing">
                      {message.mentions.map((agentId) => <span key={agentId}><AtSign size={11} />{activeConversation?.members.find((member) => member.id === agentId)?.name ?? agentId}</span>)}
                      {message.entityRefs.missionId ? <span><Link2 size={11} />Mission · {message.entityRefs.missionId}</span> : null}
                      {message.deliveries.map((delivery) => <span className={`delivery-chip delivery-chip--${delivery.status}`} key={delivery.agentId}><i />{deliveryLabels[delivery.status]}</span>)}
                    </div>
                    <button className="message-reply" onClick={() => setReplyTo(message)}>回复并保留引用</button>
                  </div>
                </article>
              )
            })}
          </div>
          <div className="room-composer">
            {replyTo ? <div className="reply-banner"><span>正在回复 <strong>{replyTo.authorName}</strong> · {replyTo.body.slice(0, 72)}</span><button onClick={() => setReplyTo(null)}>取消</button></div> : null}
            <div className="recipient-picker"><span><AtSign size={13} />选择需要行动的 Agent</span><div>{agents.map((agent) => <button key={agent.id} className={selectedAgents.includes(agent.id) ? 'is-selected' : ''} onClick={() => toggleAgent(agent.id)}><Bot size={12} />{agent.name}<small>{roleLabels[agent.role ?? 'custom']}</small></button>)}</div></div>
            <div className="composer-field"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void sendMessage() } }} placeholder="例如：@规划 Agent 请结合当前实现重新检查任务边界，并在协作室说明是否需要调整计划。" /><button aria-label="发送消息" disabled={!draft.trim() || sending} onClick={() => void sendMessage()}>{sending ? <LoaderCircle className="is-spinning" size={18} /> : <Send size={18} />}</button></div>
            <div className="composer-scope"><span className={mission ? 'is-bound' : ''}><Link2 size={12} />{mission ? `已绑定 Mission · ${mission.id}` : '尚无 Mission：先讨论，再勾选消息交给 Planner'}</span><code>Ctrl / ⌘ + Enter 发送</code></div>
          </div>
        </section>

        <aside className="routing-rail">
          <div><span className="micro-label">投递解释器</span><h2>这条消息会去哪？</h2><p>RunGuild 不把“已发送”当成“Agent 已看到”。这里显示每位 Agent 的真实路由结果。</p></div>
          <section className="planning-launcher">
            <span className="micro-label">从会话到 Mission</span>
            <h3>交给规划 Agent</h3>
            <p>{selectedMessageIds.length ? `已固定选择 ${selectedMessageIds.length} 条消息，Planner 将只以这些事实作为任务来源。` : '在左侧勾选一条或多条关键消息，Planner 会生成可审查的任务 DAG。'}</p>
            <label><span>Mission 标题</span><input value={planningTitle} onChange={(event) => setPlanningTitle(event.target.value)} placeholder="例如：完成项目级角色系统" /></label>
            <button className="planning-action" disabled={!planner || selectedMessageIds.length === 0 || !planningTitle.trim() || planningBusy} onClick={() => void createPlanningRequest()}>{planningBusy ? <LoaderCircle className="is-spinning" size={15} /> : <Network size={15} />}{planner ? '生成任务计划' : '缺少 Planner Agent'}</button>
            {planningRequest ? <div className={`planning-progress planning-progress--${planningRequest.status}`}><span>{['queued', 'running', 'model_complete'].includes(planningRequest.status) ? <LoaderCircle className="is-spinning" size={14} /> : planningRequest.status === 'failed' ? <CircleAlert size={14} /> : <CircleCheck size={14} />}</span><div><strong>{planningStatusLabels[planningRequest.status]}</strong><small>尝试 {planningRequest.attempt}/{planningRequest.maxAttempts} · Mission {planningRequest.missionId}</small>{planningRequest.status === 'queued' ? <p className="planning-worker-hint">若长时间停留，请启动 Agent Worker：{planningRequest.plannerAgentId}</p> : null}{planningRequest.error ? <em>{planningRequest.error}</em> : null}</div>{planningRequest.status === 'awaiting_approval' || planningRequest.status === 'approved' ? <button onClick={() => onNavigate('start')}>{planningRequest.status === 'approved' ? '查看 Mission' : '查看并批准计划'}<ArrowRight size={13} /></button> : null}</div> : null}
          </section>
          <ol className="routing-steps"><li className="is-complete"><span>1</span><div><strong>持久化消息</strong><small>先写入 Conversation 账本</small></div></li><li className={mission ? 'is-complete' : ''}><span>2</span><div><strong>绑定执行上下文</strong><small>{mission ? mission.title : '需要先创建或恢复 Mission'}</small></div></li><li className={selectedAgents.length ? 'is-active' : ''}><span>3</span><div><strong>路由 @Agent</strong><small>运行中则 steer；空闲则下次加载</small></div></li></ol>
          <div className="latest-delivery"><span className="micro-label">最近一次真实投递</span>{latestRoutedMessage ? <><strong>{latestRoutedMessage.body.slice(0, 80)}</strong>{latestRoutedMessage.deliveries.map((delivery) => <div key={delivery.agentId}><span className={`delivery-signal delivery-signal--${delivery.status}`} /><p><strong>{activeConversation?.members.find((member) => member.id === delivery.agentId)?.name ?? delivery.agentId}</strong><small>{deliveryLabels[delivery.status]}</small></p>{delivery.runId ? <code>{delivery.runId}</code> : <code>尚无 Run</code>}</div>)}</> : <p className="routing-placeholder">发送第一条 @Agent 消息后，这里会显示实际投递状态。</p>}</div>
        </aside>
      </div>
    </>
  )
}

function EvaluationView() {
  const singleSuccess = experiments.filter((pair) => pair.single.success).length / experiments.length
  const multiSuccess = experiments.filter((pair) => pair.multi.success).length / experiments.length
  return <><section className="page-heading"><div><div className="breadcrumb"><span>评测实验室</span><i>/</i><code>示例 EXP-07</code></div><h1>通用 Agent 与协作团队对照</h1><p>使用同一不可变场景版本和相同 Git 基线执行成对实验。当前页面展示的是示例评测报告。</p></div><div className="page-actions"><StatusPill tone="verified"><ShieldCheck size={13} />仅统计完整配对</StatusPill><button className="primary-action"><Plus size={15} />新建实验</button></div></section><section className="evaluation-thesis"><div className="evaluation-thesis__copy"><span className="micro-label">配对结果 · 多 Agent 减单 Agent</span><h2>Agent 团队平均快 <em>9分20秒</em>，每个 Mission 少花 <em>$0.45</em>。</h2><p>所有分数来自终态 Run、模型、工具、审查和上下文账本，而不是 Agent 自己写的总结。</p></div><div className="delta-seal"><span>成功率差值</span><strong>+33</strong><small>个百分点</small></div></section><section className="strategy-comparison"><div className="comparison-header comparison-grid"><span>策略</span><span>成功率</span><span>平均时间</span><span>平均成本</span><span>返工</span></div><div className="comparison-row comparison-grid"><div><span className="strategy-mark strategy-mark--single">1</span><strong>单一通用 Agent</strong></div><strong>{Math.round(singleSuccess * 100)}%</strong><code>34分40秒</code><code>$2.03</code><code>1.7</code></div><div className="comparison-row comparison-row--winner comparison-grid"><div><span className="strategy-mark strategy-mark--multi">4</span><strong>多 Agent 协作团队</strong></div><strong>{Math.round(multiSuccess * 100)}%</strong><code>25分20秒</code><code>$1.58</code><code>0.7</code></div></section><section className="paired-trials"><div className="panel-heading"><div><span className="micro-label">三组可复现实验</span><h2>实验账本</h2></div><code>基线 4fa2c0d</code></div><div className="trial-list">{experiments.map((pair) => <article className="trial-row" key={pair.repetition}><div className="trial-row__label"><span>{pair.repetition}</span><code>seed 81b7…{pair.repetition.slice(-2)}</code></div><div className="trial-lane"><span>单 Agent</span><i style={{ width: `${pair.single.time * 1.8}%` }} /><code>{pair.single.time}分 · ${pair.single.cost}</code></div><div className="trial-lane trial-lane--multi"><span>多 Agent</span><i style={{ width: `${pair.multi.time * 1.8}%` }} /><code>{pair.multi.time}分 · ${pair.multi.cost}</code></div><div className="trial-delta"><ArrowDownRight size={15} /><strong>{pair.multi.time - pair.single.time}分</strong></div></article>)}</div></section></>
}

function ArtifactView() {
  return <><section className="page-heading"><div><div className="breadcrumb"><span>协作产物</span><i>/</i><code>示例 ART-19</code></div><h1>鉴权实现说明</h1><p>这是 Yjs 实时协作文档的界面示例；冻结版本可绑定到独立审查。</p></div><div className="page-actions"><StatusPill tone="active"><span className="pulse-dot" />2 位协作者</StatusPill><button className="secondary-action"><GitCommitHorizontal size={15} />版本历史</button><button className="primary-action"><ShieldCheck size={15} />冻结版本</button></div></section><div className="artifact-workspace"><aside className="outline-panel"><span className="micro-label">文档目录</span><nav aria-label="文档目录"><a className="is-active" href="#scope">范围</a><a href="#boundaries">鉴权边界</a><a href="#migration">迁移计划</a><a href="#evidence">必需证据</a><a href="#rollback">回滚方案</a></nav><div className="version-card"><span>审查目标</span><strong>版本 04</strong><code>81b7…9ac2</code><small>Mira 于 8 分钟前冻结</small></div></aside><article className="document-surface"><div className="document-presence"><span className="agent-avatar agent-avatar--executing">M</span><span>Mira 正在编辑“必需证据”</span></div><span className="document-kicker">实现说明 · 项目角色</span><h2 id="scope">在权限真正发生变化的边界上执行约束。</h2><p className="document-lede">只有当操作者、目标用户和项目都属于同一工作区时，角色分配才有效。API 构造操作者作用域，Agent 不能自行提供。</p><hr /><h3 id="boundaries">鉴权边界</h3><p>每次写入先验证工作区成员身份，再解析项目归属，最后锁定可变记录。数据库约束始终是最终权威。</p><div className="document-callout"><ShieldCheck size={19} /><div><strong>不变量</strong><p>跨项目角色不可能存在，即使 API 进程过期或被绕过。</p></div></div><h3 id="migration">迁移计划</h3><ol><li><span>01</span>用复合租户键增加项目角色分配。</li><li><span>02</span>在单个可串行化事务中回填现有所有者。</li><li><span>03</span>验证后启用作用域触发器。</li></ol><div className="agent-caret"><i /><span>Mira · Agent</span></div><h3 id="evidence">必需证据</h3><p>附加迁移输出、对抗性租户测试、精确提交 HEAD 和独立审查结论。</p></article><aside className="comments-panel"><div className="panel-heading"><div><span className="micro-label">审查讨论</span><h2>评论</h2></div><span>2 条未解决</span></div><article className="comment-card"><div><span className="agent-avatar agent-avatar--released">N</span><strong>Noa</strong><time>4分</time></div><p>触发器能否在行可见之前，证明目标项目属于同一工作区？</p><button>回复</button></article><article className="comment-card comment-card--resolved"><div><span className="agent-avatar agent-avatar--released">S</span><strong>Sana</strong><time>7分</time></div><p>请把伪造 Agent 身份的用例加入证据清单。</p><span><Check size={12} />已在 v04 解决</span></article></aside></div></>
}

function CommandPalette({ onClose, onNavigate }: { readonly onClose: () => void; readonly onNavigate: (view: View) => void }) {
  return <div className="command-backdrop" role="presentation" onMouseDown={onClose}><div className="command-palette" role="dialog" aria-modal="true" aria-label="快捷导航" onMouseDown={(event) => event.stopPropagation()}><div className="command-palette__search"><Search size={18} /><input autoFocus placeholder="查找页面或功能…" /><kbd>esc</kbd></div><span className="micro-label">可操作页面</span><div className="command-results">{primaryViews.map((key) => { const item = viewMeta[key]; const Icon = item.icon; return <button key={key} onClick={() => { onNavigate(key); onClose() }}><Icon size={17} /><span><strong>{item.label}</strong><small>{item.eyebrow}</small></span><code>↵</code></button> })}</div></div></div>
}

export function App() {
  const [view, setView] = useState<View>(fromHash)
  const [commandOpen, setCommandOpen] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>('checking')
  const [identity, setIdentity] = useState<TestIdentity>(defaultIdentity)
  const [setup, setSetup] = useState<DevelopmentSetup | null>(null)
  const [overview, setOverview] = useState<ProjectOperatorOverview | null>(null)
  const [runtimeConfiguration, setRuntimeConfiguration] = useState<ProjectRuntimeConfigurationResponse | null>(null)
  const [runtimePanelOpen, setRuntimePanelOpen] = useState(false)
  const [runtimeBusy, setRuntimeBusy] = useState<string | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [mission, setMission] = useState<MissionSnapshot | null>(null)
  const [missionId, setMissionId] = useState(() =>
    window.localStorage.getItem('runguild:last-mission')
      ?? window.localStorage.getItem('mission-control:last-mission')
      ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const acceptMission = useCallback((snapshot: MissionSnapshot) => {
    setMissionId(snapshot.id)
    window.localStorage.setItem('runguild:last-mission', snapshot.id)
    setMission(snapshot)
  }, [])
  const syncOverview = useCallback(async () => {
    const next = await missionApi.getOperatorOverview(identity)
    setOverview(next)
    if (next.project.conversationId) {
      setSetup((current) => {
        const agents = next.agents.map(({ id, role, name }) => ({ id, role, name }))
        if (current?.workspaceId === identity.workspaceId
            && current.projectId === identity.projectId
            && current.userId === identity.userId
            && current.conversationId === next.project.conversationId
            && JSON.stringify(current.agents) === JSON.stringify(agents)) return current
        return { ...identity, conversationId: next.project.conversationId!, agents }
      })
    }
    return next
  }, [identity])
  const syncRuntimeConfiguration = useCallback(async () => {
    const next = await missionApi.getRuntimeConfiguration(identity)
    setRuntimeConfiguration(next)
    return next
  }, [identity])
  const acceptMissionFromPlanning = useCallback((snapshot: MissionSnapshot) => {
    acceptMission(snapshot)
    void syncOverview()
  }, [acceptMission, syncOverview])
  const navigate = (next: View) => { window.location.hash = '/' + next; setView(next) }
  const run = async (name: string, operation: () => Promise<void>) => { setBusy(name); setError(null); try { await operation() } catch (caught) { setError(caught instanceof Error ? caught.message : '发生未知错误') } finally { setBusy(null) } }
  const checkConnection = () => void run('health', async () => { setConnection('checking'); try { await missionApi.health(); setConnection('online'); await syncOverview().catch(() => setOverview(null)); await syncRuntimeConfiguration().catch(() => setRuntimeConfiguration(null)) } catch (caught) { setConnection('offline'); throw caught } })
  const refreshMission = () => { if (!missionId) return; void run('refresh', async () => { setMission(await missionApi.getMission(identity, missionId)); await syncOverview() }) }
  const changeIdentity = (next: TestIdentity) => {
    setIdentity(next)
    setSetup(null)
    setOverview(null)
    setRuntimeConfiguration(null)
    setRuntimePanelOpen(false)
    setMission(null)
    setMissionId('')
    window.localStorage.removeItem('runguild:last-mission')
    window.localStorage.removeItem('mission-control:last-mission')
  }

  useEffect(() => { const update = () => setView(fromHash()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  useEffect(() => { void missionApi.health().then(() => setConnection('online')).catch(() => setConnection('offline')) }, [])
  useEffect(() => {
    if (connection !== 'online') return
    void syncOverview().catch(() => setOverview(null))
    const interval = window.setInterval(() => void syncOverview().catch(() => undefined), 5_000)
    return () => window.clearInterval(interval)
  }, [connection, syncOverview])
  useEffect(() => {
    if (connection !== 'online' || !overview) return
    void syncRuntimeConfiguration().catch(() => setRuntimeConfiguration(null))
    const interval = window.setInterval(() => void syncRuntimeConfiguration().catch(() => undefined), 5_000)
    return () => window.clearInterval(interval)
  }, [connection, overview?.project.id, syncRuntimeConfiguration])
  useEffect(() => { if (connection !== 'online' || !missionId || mission) return; void missionApi.getMission(identity, missionId).then((snapshot) => { window.localStorage.setItem('runguild:last-mission', missionId); window.localStorage.removeItem('mission-control:last-mission'); setMission(snapshot) }).catch(() => { window.localStorage.removeItem('runguild:last-mission'); window.localStorage.removeItem('mission-control:last-mission') }) }, [connection, identity, mission, missionId])
  useEffect(() => { const keydown = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen((open) => !open) } if (event.key === 'Escape') { setCommandOpen(false); setRuntimePanelOpen(false) } }; window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown) }, [])

  const openRuntimePanel = () => {
    setRuntimePanelOpen(true)
    setRuntimeError(null)
    if (!runtimeConfiguration) {
      setRuntimeBusy('load-runtime')
      void syncRuntimeConfiguration()
        .catch((caught: unknown) => setRuntimeError(caught instanceof Error ? caught.message : '运行配置读取失败'))
        .finally(() => setRuntimeBusy(null))
    }
  }
  const saveRuntimeConfiguration = (configuration: UpdateProjectRuntimeConfiguration) => {
    setRuntimeBusy('save-runtime')
    setRuntimeError(null)
    void missionApi.updateRuntimeConfiguration(identity, configuration)
      .then(async (next) => { setRuntimeConfiguration(next); await syncOverview() })
      .catch((caught: unknown) => setRuntimeError(caught instanceof Error ? caught.message : '运行配置保存失败'))
      .finally(() => setRuntimeBusy(null))
  }
  const controlWorker = (action: 'start' | 'stop', command: { readonly kind: WorkerKind; readonly agentId?: string }) => {
    const key = 'worker:' + command.kind + ':' + (command.agentId ?? '')
    setRuntimeBusy(key)
    setRuntimeError(null)
    void missionApi.controlLocalWorker(identity, action, command)
      .then(async () => { await syncRuntimeConfiguration(); await syncOverview() })
      .catch((caught: unknown) => setRuntimeError(caught instanceof Error ? caught.message : 'Worker 操作失败'))
      .finally(() => setRuntimeBusy(null))
  }

  const startProps = {
    connection, setup, overview, mission, identity, busy, error, onIdentityChange: changeIdentity, onCheck: checkConnection,
    onBootstrap: () => void run('bootstrap', async () => { setSetup(await missionApi.bootstrap(identity)); await syncOverview(); await syncRuntimeConfiguration() }),
    onCreate: (title: string, goal: string) => void run('create', async () => { const id = await missionApi.createMission(identity, title, goal, setup?.conversationId); setMissionId(id); window.localStorage.setItem('runguild:last-mission', id); setMission(await missionApi.getMission(identity, id)); await syncOverview() }),
    onPropose: () => void run('propose', async () => { if (!mission) return; await missionApi.proposePlan(identity, mission.id, guidedPlan); setMission(await missionApi.getMission(identity, mission.id)); await syncOverview() }),
    onApprove: () => void run('approve', async () => { if (!mission) return; await missionApi.approvePlan(identity, mission.id, mission.planVersion); setMission(await missionApi.getMission(identity, mission.id)); await syncOverview() }),
    onRefresh: refreshMission, onOpenMission: () => navigate('mission'), onOpenTeam: () => navigate('team'),
    onOpenRuntime: openRuntimePanel,
    onSelectMission: (id: string) => void run('select-mission', async () => { acceptMission(await missionApi.getMission(identity, id)); navigate('mission') }),
  }

  const content = useMemo(() => {
    if (view === 'start') return <StartView {...startProps} />
    if (view === 'evaluation') return <EvaluationView />
    if (view === 'team') return <TeamRoomView identity={identity} setup={setup} mission={mission} onNavigate={navigate} onMissionReady={acceptMissionFromPlanning} />
    if (view === 'artifacts') return <ArtifactView />
    if (view === 'trace') return <TraceView identity={identity} />
    return <MissionView mission={mission} busy={busy} error={error} onNavigate={navigate} onRefresh={refreshMission} onApproveDelivery={() => void run('approve-delivery', async () => { if (!mission?.finalDelivery) return; await missionApi.approveDelivery(identity, mission.id, mission.finalDelivery.artifactVersionId); setMission(await missionApi.getMission(identity, mission.id)); await syncOverview() })} />
  // State is intentionally listed explicitly so API progress is reflected immediately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, connection, setup, overview, mission, identity, busy, error, missionId, acceptMission, acceptMissionFromPlanning, syncOverview])

  return <div className="app-shell"><AppNavigation view={view} onNavigate={navigate} /><div className="app-stage"><TopBar view={view} connection={connection} projectId={overview?.project.name ?? identity.projectId} onOpenCommand={() => setCommandOpen(true)} /><main className={`page page--${view}`}>{content}</main></div>{commandOpen ? <CommandPalette onClose={() => setCommandOpen(false)} onNavigate={navigate} /> : null}{runtimePanelOpen && runtimeConfiguration ? <RuntimeConfigPanel runtime={runtimeConfiguration} overview={overview} busy={runtimeBusy} error={runtimeError} onClose={() => setRuntimePanelOpen(false)} onSave={saveRuntimeConfiguration} onControl={controlWorker} /> : null}{runtimePanelOpen && !runtimeConfiguration ? <div className="runtime-config-backdrop" role="presentation" onMouseDown={() => setRuntimePanelOpen(false)}><section className="runtime-config-loading" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>{runtimeError ? <><CircleAlert size={24} /><strong>运行配置没有加载成功</strong><p>{runtimeError}</p><button className="secondary-action" onClick={() => setRuntimePanelOpen(false)}>关闭</button></> : <><LoaderCircle className="is-spinning" size={25} /><strong>正在读取项目运行配置</strong><p>只读取可持久化的启动参数，不读取模型密钥。</p></>}</section></div> : null}</div>
}

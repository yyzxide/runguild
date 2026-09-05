import {
  CircleAlert,
  Crown,
  Eye,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCog,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { missionApi, type ProjectMember, type TestIdentity } from './api'

type MemberRole = ProjectMember['role']

const roleMeta: Record<MemberRole, { readonly label: string; readonly detail: string }> = {
  owner: { label: 'Owner', detail: '成员管理、运行配置与关键批准' },
  operator: { label: 'Operator', detail: '发起任务、协作并控制运行' },
  viewer: { label: 'Viewer', detail: '只读查看任务、产物与运行记录' },
}

export function MembersView({
  identity,
  currentUserId,
  currentRole,
}: {
  readonly identity: TestIdentity
  readonly currentUserId: string
  readonly currentRole: MemberRole
}) {
  const [members, setMembers] = useState<readonly ProjectMember[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [userId, setUserId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<MemberRole>('operator')
  const [password, setPassword] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMembers(await missionApi.listProjectMembers(identity))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '成员列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [identity])

  useEffect(() => { void load() }, [load])

  const addMember = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy('add')
    setError(null)
    try {
      setMembers(await missionApi.addProjectMember(identity, {
        userId: userId.trim(), displayName: displayName.trim(), role, password,
      }))
      setUserId('')
      setDisplayName('')
      setRole('operator')
      setPassword('')
      setFormOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '成员添加失败')
    } finally {
      setBusy(null)
    }
  }

  const changeRole = async (member: ProjectMember, nextRole: MemberRole) => {
    if (member.role === nextRole) return
    setBusy('role:' + member.userId)
    setError(null)
    try {
      setMembers(await missionApi.updateProjectMember(identity, member.userId, nextRole))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '角色修改失败')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (member: ProjectMember) => {
    if (!window.confirm(`确认将 ${member.displayName} 移出当前工作区？其现有会话会立即失效。`)) return
    setBusy('remove:' + member.userId)
    setError(null)
    try {
      setMembers(await missionApi.removeProjectMember(identity, member.userId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '成员移除失败')
    } finally {
      setBusy(null)
    }
  }

  const canManage = currentRole === 'owner'
  return (
    <>
      <section className="page-heading members-heading">
        <div><div className="breadcrumb"><span>当前工作区</span><i>/</i><span>成员</span></div><h1>人类团队与 Agent 团队共享一个工作上下文</h1><p>这里的成员关系决定账号能否看到并进入当前工作区；角色继续约束写操作和管理操作。</p></div>
        <div className="page-actions"><button className="secondary-action" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'is-spinning' : ''} size={15} />刷新</button>{canManage ? <button className="primary-action" onClick={() => setFormOpen((open) => !open)}><Plus size={15} />添加成员</button> : null}</div>
      </section>

      <section className="member-role-contract" aria-label="成员角色说明">
        <div><Crown size={17} /><span><strong>Owner</strong><small>{roleMeta.owner.detail}</small></span></div>
        <div><UserCog size={17} /><span><strong>Operator</strong><small>{roleMeta.operator.detail}</small></span></div>
        <div><Eye size={17} /><span><strong>Viewer</strong><small>{roleMeta.viewer.detail}</small></span></div>
      </section>

      {formOpen && canManage ? <form className="member-create" onSubmit={(event) => void addMember(event)}>
        <header><div><span className="micro-label">创建团队账号并加入工作区</span><h2>添加一位成员</h2></div><ShieldCheck size={20} /></header>
        <div>
          <label><span>登录名</span><input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="alice" required maxLength={200} /></label>
          <label><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alice" required maxLength={200} /></label>
          <label><span>工作区角色</span><select value={role} onChange={(event) => setRole(event.target.value as MemberRole)}><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="owner">Owner</option></select></label>
          <label><span>初始密码</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 个字符" required minLength={12} maxLength={1_024} /></label>
        </div>
        <footer><p>密码只发送给 API 并以 scrypt 哈希保存。要用多个账号演示，请把部署模式改为 <code>AUTH_MODE=team</code>。</p><button className="primary-action" disabled={busy === 'add'}>{busy === 'add' ? <LoaderCircle className="is-spinning" size={15} /> : <Plus size={15} />}创建并加入</button></footer>
      </form> : null}

      {error ? <div className="test-error"><CircleAlert size={18} /><div><strong>成员操作没有完成</strong><p>{error}</p></div></div> : null}

      <section className="member-register">
        <header><div><span className="micro-label">持久化成员关系</span><h2>{members.length} 位工作区成员</h2></div><span><Users size={15} />成员变更会同步到团队协作室</span></header>
        {loading && members.length === 0 ? <div className="member-empty"><LoaderCircle className="is-spinning" size={22} /><strong>正在读取成员关系</strong></div> : null}
        {!loading && members.length === 0 ? <div className="member-empty"><Users size={22} /><strong>当前工作区没有成员</strong></div> : null}
        <div className="member-list">
          {members.map((member) => {
            const changing = busy === 'role:' + member.userId || busy === 'remove:' + member.userId
            return <article key={member.userId}>
              <span className={`member-avatar member-avatar--${member.role}`}>{member.displayName.trim().slice(0, 2) || '成员'}</span>
              <div><strong>{member.displayName}{member.userId === currentUserId ? <em>你</em> : null}</strong><small>登录名 · {member.userId}</small></div>
              <span className={`member-role member-role--${member.role}`}>{roleMeta[member.role].label}</span>
              <time>{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(member.joinedAt))} 加入</time>
              {canManage ? <div className="member-actions"><select aria-label={`修改 ${member.displayName} 的角色`} value={member.role} disabled={changing} onChange={(event) => void changeRole(member, event.target.value as MemberRole)}><option value="owner">Owner</option><option value="operator">Operator</option><option value="viewer">Viewer</option></select><button aria-label={`移除 ${member.displayName}`} disabled={changing} onClick={() => void remove(member)}>{changing ? <LoaderCircle className="is-spinning" size={14} /> : <Trash2 size={14} />}</button></div> : <small className="member-readonly">{roleMeta[member.role].detail}</small>}
            </article>
          })}
        </div>
      </section>
    </>
  )
}

export type TaskStatus = 'verified' | 'running' | 'waiting' | 'queued'

export interface MissionTask {
  readonly id: string
  readonly key: string
  readonly title: string
  readonly role: string
  readonly agent: string
  readonly status: TaskStatus
  readonly statusLabel: string
  readonly summary: string
  readonly duration: string
  readonly attempts: number
  readonly model: string
  readonly dependsOn: readonly string[]
  readonly criteria: readonly { readonly label: string; readonly passed: boolean }[]
}

export interface EvidenceFact {
  readonly id: string
  readonly taskId: string
  readonly sequence: string
  readonly time: string
  readonly kind: string
  readonly title: string
  readonly detail: string
  readonly state: 'verified' | 'active' | 'pending'
}

export const missionTasks: readonly MissionTask[] = [
  { id: 'research', key: '任务-01', title: '梳理鉴权边界', role: '研究员', agent: 'Mira', status: 'verified', statusLabel: '已验证', summary: '追踪所有请求边界并冻结仓库级实现计划。', duration: '06分42秒', attempts: 1, model: 'gpt-5.2', dependsOn: [], criteria: [{ label: '引用现有作用域规则', passed: true }, { label: '限定受影响路径', passed: true }, { label: '冻结计划产物', passed: true }] },
  { id: 'implement', key: '任务-02', title: '实现项目级角色', role: '构建者', agent: 'Ivo', status: 'running', statusLabel: '执行中 · 第 8 次模型调用', summary: '增加角色分配、强制项目作用域，并为每次写入持久化证据。', duration: '14分08秒', attempts: 1, model: 'gpt-5.2-codex', dependsOn: ['research'], criteria: [{ label: '迁移可干净执行', passed: true }, { label: '拒绝跨项目写入', passed: true }, { label: '完整回归通过', passed: false }] },
  { id: 'tests', key: '任务-03', title: '证明租户隔离', role: '验证者', agent: 'Sana', status: 'waiting', statusLabel: '等待任务-02', summary: '针对已审查提交运行对抗性作用域测试，并附上持久化证据。', duration: '—', attempts: 0, model: 'gpt-5.2', dependsOn: ['research'], criteria: [{ label: '拒绝伪造身份', passed: false }, { label: '拒绝跨工作区访问', passed: false }, { label: '附加证据哈希', passed: false }] },
  { id: 'review', key: '任务-04', title: '独立发布审查', role: '审查者', agent: 'Noa', status: 'queued', statusLabel: '被 2 个任务阻塞', summary: '审查不可变版本、提交 HEAD、验收证据和集成结果。', duration: '—', attempts: 0, model: 'gpt-5.2', dependsOn: ['implement', 'tests'], criteria: [{ label: '产物版本已冻结', passed: false }, { label: '已集成审查后的 HEAD', passed: false }, { label: '完成人工发布决策', passed: false }] },
]

export const evidenceFacts: readonly EvidenceFact[] = [
  { id: 'event-01', taskId: 'research', sequence: '01', time: '09:41:06', kind: '计划版本', title: '鉴权地图已冻结', detail: 'artifact_version · 81b7…9ac2', state: 'verified' },
  { id: 'event-02', taskId: 'research', sequence: '02', time: '09:42:18', kind: '任务门禁', title: '研究验收条件已满足', detail: '3 / 3 项必需证据已存在', state: 'verified' },
  { id: 'event-03', taskId: 'implement', sequence: '03', time: '09:44:32', kind: 'Git 工作树', title: '隔离分支已创建', detail: 'agent/task-project-role · 4fa2…0d11', state: 'verified' },
  { id: 'event-04', taskId: 'implement', sequence: '04', time: '09:53:46', kind: '工具副作用', title: '迁移与仓库已修改', detail: '7 个文件 · +284 −19 · 可安全重放', state: 'verified' },
  { id: 'event-05', taskId: 'implement', sequence: '05', time: '09:57:11', kind: '测试运行', title: '作用域契约测试通过', detail: '18 通过 · 0 失败 · 6.4秒', state: 'verified' },
  { id: 'event-06', taskId: 'implement', sequence: '06', time: '现在', kind: '第 08 次模型调用', title: '正在运行完整回归', detail: '上下文 42,810 / 65,536 tokens', state: 'active' },
  { id: 'event-07', taskId: 'tests', sequence: '07', time: '下一步', kind: '调度', title: '验证 Agent 等待已审查 HEAD', detail: '依赖门禁仍未打开', state: 'pending' },
]


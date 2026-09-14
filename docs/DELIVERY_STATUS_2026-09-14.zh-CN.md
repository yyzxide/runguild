# RunGuild 交付状态 — 2026-09-14

[English](DELIVERY_STATUS_2026-09-14.md)

这是历史[作品集审计](AUDIT_2026-09-14.md)的当前闭环记录。它把平台实现证据与必须
依赖重复 Live-model Trial 才能得到的效果结论分开。

## 已验证实现基线

- 实现版本：`c896441`；证据发布至 `37f7385`；
- 精确安装与构建：Node.js 22、`npm ci`、仓库锁文件；
- 本地结果：`npm test` 完成生产 Bundle 构建并执行 214 项测试，213 项通过，仅跳过
  需要独立 PostgreSQL 的 Opt-in 套件，0 项失败；
- 独立 PostgreSQL 17 `_test` 数据库上的协调套件 8/8 通过；
- 另一个 `_test` 数据库上的本地 Chromium 验收 1/1 通过；
- 远端结果：[GitHub Actions run 34829244703](https://github.com/yyzxide/runguild/actions/runs/34829244703) 通过；
- 该 Job 会执行生产构建、单并发完整 Node 测试、PostgreSQL 17 协调测试，以及
  真实 Chromium 浏览器验收。
- 本日执行 `npm audit --omit=dev --audit-level=high`，锁定的生产依赖图报告 0 个
  已知漏洞。

浏览器验收会区分普通问候与任务。任务只提交一次，在一个事务内建立持久消息、
Mission 与 Planning Request，无需第二次手动操作便进入规划。Artifact、Evaluation
和 Trace 页面也从生产 Bundle 实际加载。

## 审计闭环

| 发现 | 当前状态 | 证据 |
| --- | --- | --- |
| R1：Agent 自写测试不等于独立验收 | 平台门禁已关闭；历史目标没有被新门禁追溯验证 | `2bd5081` 在 Builder 前冻结 Git 已跟踪的受保护路径，阻止 Agent Patch，并在 `test.run` 前后复核 Manifest。一个会改受保护文件但以 0 退出的 Mutant 会被记录为失败；`bdfb702` 持久化项目策略。 |
| R2：任务提交跨两个不可恢复 HTTP 请求 | 已关闭 | `b73a96e` 用稳定 Client Request ID 原子保存消息、Mission 与 Planning Request；`82bd2a6` 在刷新或响应丢失后恢复浏览器 Pending Command；`50901ae` 用 Chromium 覆盖一次操作的完整流程。 |
| R3：把白名单宿主进程称为 Sandbox | 声明的 Linux 边界内已关闭 | `0ea8f2e` 增加 Fail-closed Bubblewrap，对 Namespace、挂载、环境、网络和资源做边界控制；`1357af0` 持久化并展示策略。`trusted_process` 始终标为兼容模式，不称作 OS Sandbox。 |
| R4：未知价格被聚合成 0 | 已通过修复后真实模型证据闭环 | `e1fc591` 将未知成本保留为 `null`，展示价格覆盖率，并把少于三组完整配对标为探索性。2026-09-14 的 18 个 Trial 全部完成，供应商价格不可用时仍保留 `null`，不作成本结论。 |
| 可复现交付 | 无 Credential 平台范围已关闭 | `3224e53` 将 PostgreSQL 纳入 CI，`9ea45e1` 保持 Workspace 测试无宿主污染，`50901ae` 增加浏览器验收，`944e127` 通过路由拆包让生产主 Bundle 保持在告警阈值以下。 |

## 可以演示的路径

1. 从持久 Team Room 对话开始，把一条任务消息提交给 Planner。
2. 查看并批准 Planner 生成的 Task DAG。
3. 不同角色 Agent 通过带 Fencing 的 Lease 领取依赖已就绪的 Task。
4. 在隔离 Task Worktree 中运行精确白名单测试，并绑定受保护验收文件与 Git 状态。
5. 将不可变 Artifact Version 和精确 Commit 提交给独立 Reviewer。
6. 只集成已经审查的 Commit；所有 Task 完成后仍需人工批准最终交付才能完成 Mission。
7. 在操作台关联查看 Mission、Task、Run、模型、Tool、Evidence、Review、Artifact、
   Git Integration 与成本记录。

## 已采集的真实模型证据

- 三类任务、Single/Multi-Agent 配对、每类每种策略重复三次：18/18 个新
  Live-model Trial 从冻结基线完成；
- 单 Agent 9/9、多 Agent 9/9 成功；
- 468 次模型调用均记录请求模型、返回模型与精确 Endpoint；
- 单独的真实模型安全探针记录 `protected_path_denied`，随后恢复并完成，受保护测试未变；
- 脱敏原始导出、SHA-256、完整性检查与结果解释见
  [本日评测报告](REAL_EVALUATION_2026-09-14.zh-CN.md)。

剩余可选作品集润色只有一段短录屏；若未来配置可信价格表，也可以重新跑一组带价格
实验。两者都不是代码正确性的前置条件。18 Trial 只是工程小样本，不代表统计显著。
历史 Trial 仍是有价值的失败与恢复证据，但不会与平台修复后的结果混算。

## 明确不声称

- 不声称 Multi-Agent 通常比单 Agent 更快、更便宜或成功率更高；
- 不声称 Reviewer 模型批准可以替代受保护的可执行测试；
- 不声称 `trusted_process` 已隔离，也不把 Bubblewrap 包装成针对任意恶意代码的工业
  安全认证；
- 不声称已经达到生产级 SaaS、Kubernetes 或公网多租户加固；
- 不声称 Redis 保存权威工作流状态。

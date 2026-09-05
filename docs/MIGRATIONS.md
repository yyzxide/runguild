# Database Migrations

RunGuild 的 PostgreSQL Migration 位于 `packages/database/migrations/`，按文件名前缀顺序执行。Migration 是追加式数据库历史：已经在某个数据库应用的旧文件不得修改；新的结构变化应新增下一个编号文件。

## 执行方式

```bash
npm run build
npm run db:migrate
```

`DATABASE_URL` 必须指向目标数据库。`.env` 由 `npm run api:local` 自动读取，但 `npm run db:migrate` 不会隐式读取 `.env`；在普通交互终端中，应先导出变量，或确认当前环境已经提供 `DATABASE_URL`。项目当前本地 `.env` 与 Compose 默认值一致时，也可以显式执行：

```bash
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control \
  npm run db:migrate
```

应用记录和 SHA-256 checksum 由数据库 Migration 运行器维护；同一数据库
只允许一个持有 PostgreSQL advisory lock 的迁移进程推进，每个文件在独立
事务中执行。已应用文件被修改时会因 checksum 不一致而拒绝启动。不要通过
删除 Migration 记录来强制重跑，也不要在有真实数据的数据库上手工回退结构。

## 0001–0023 清单

| 编号 | 文件 | 主要作用 |
|---|---|---|
| 0001 | `0001_core.sql` | 建立 Workspace、User、Project、Agent、Mission、Task、Run、Inbox、Artifact、Evidence 等核心领域表与基础作用域约束。 |
| 0002 | `0002_orchestration.sql` | 增加计划修订、任务分派、持久化 Inbox、Outbox 和运行控制等编排基础。 |
| 0003 | `0003_runtime.sql` | 增加 Run hop、心跳、消息、事件、模型调用、工具执行和运行租约所需结构。 |
| 0004 | `0004_execution.sql` | 强化执行 Evidence 幂等约束，避免同一 Run 重复记录等价证据。 |
| 0005 | `0005_artifacts.sql` | 强化 Artifact 的 Workspace/Project/Mission 作用域、不可变 Version 与 Yjs 状态关联约束。 |
| 0006 | `0006_reviews.sql` | 完善 Submission 和 Review，支持人类或 Agent Reviewer，并约束 Review 与 Submission 作用域。 |
| 0007 | `0007_worktrees.sql` | 增加项目仓库路径和 Task Worktree 生命周期、租约、提交与集成状态。 |
| 0008 | `0008_context.sql` | 增加 Skill、Skill Version、Agent 分配、冻结上下文和 Context Snapshot。 |
| 0009 | `0009_evaluation.sql` | 增加 Evaluation Scenario、不可变 Scenario Version、Experiment、Trial 和指标结构。 |
| 0010 | `0010_conversations.sql` | 完善 Conversation 类型、成员、消息顺序、回复、@Agent 投递和结构化引用。 |
| 0011 | `0011_conversation_planning.sql` | 增加从选中消息生成 Mission 的持久化 Planner 请求、租约、模型账本和恢复状态。 |
| 0012 | `0012_worker_instances.sql` | 增加 Scheduler、Agent、Integration、Evaluation Worker 的进程实例、心跳、失联和所有权保护。 |
| 0013 | `0013_project_runtime_config.sql` | 增加项目级 Worktree 根目录、测试 argv 白名单、上下文限制、测试超时和 Agent 模型配置。 |
| 0014 | `0014_reviewer_execution.sql` | 增加独立 Reviewer 执行状态机：Review 租约、冻结材料、模型响应、决定、重试和恢复。它不是业务数据重置，也不是模型升级。 |
| 0015 | `0015_worktree_setup.sql` | 增加模型调用前的 Worktree 准备命令、命令哈希、执行租约、结果和恢复记录。 |
| 0016 | `0016_submission_evidence.sql` | 冻结 Submission 选中的精确 Evidence 集合，并用数据库触发器拒绝跨 Task 证据。 |
| 0017 | `0017_integration_conflict_recovery.sql` | 记录冲突恢复使用的 base commit，使 Builder 能在新基线重新提交、测试和 Review。 |
| 0018 | `0018_reviewer_model_calls.sql` | 单独持久化 Reviewer 每次模型调用、Token、缓存 Token、延迟、状态和可选成本。 |
| 0019 | `0019_project_scoped_integration_workers.sql` | 把 Integration Worker 绑定到精确 Workspace/Project，并隔离不同项目仓库。 |
| 0020 | `0020_project_scoped_agent_workers.sql` | 把 Agent Worker 绑定到精确 Workspace/Project，禁止共享身份跨项目领取 Run。 |
| 0021 | `0021_authentication.sql` | 增加用户角色、密码凭据、可撤销 Session、CSRF、登录节流和认证审计事件。 |
| 0022 | `0022_project_memberships.sql` | 增加 Project 级人类成员与 Owner/Operator/Viewer 角色、成员变更审计，并把已有租户用户回填到原先可访问的 Project。 |
| 0023 | `0023_project_lifecycle.sql` | 增加 Project 可恢复归档状态、归档操作者、活动 Project 索引，以及重命名/归档/恢复审计账本。 |

## 为什么不能跳过 Migration

代码、数据库约束和 Repository 查询共同定义状态机。例如代码已经按照 `review_executions` 恢复 Reviewer，但数据库没有应用 0014，Reviewer Worker 会直接因表不存在而失败。正确处理不是在代码里绕过 Reviewer，而是对目标数据库执行完整 Migration。

## 测试数据库安全边界

外部 PostgreSQL 集成测试会清理自己的 fixtures，因此强制要求数据库名称以 `_test` 结尾：

```bash
docker compose exec postgres createdb -U mission mission_control_test
TEST_DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control_test \
  npm run test:integration
```

绝不能把 `TEST_DATABASE_URL` 指向个人日常使用的 `mission_control`。

# Database Migrations

RunGuild 的 PostgreSQL Migration 位于 `packages/database/migrations/`，按文件名前缀顺序执行。Migration 是追加式数据库历史：已经在某个数据库应用的旧文件不得修改；新的结构变化应新增下一个编号文件。

## 执行方式

```bash
npm run build
npm run db:migrate
```

`DATABASE_URL` 必须指向目标数据库。`.env` 由 `npm run api:local` 自动读取，但 `npm run db:migrate` 不会隐式读取 `.env`；在普通交互终端中，应先导出变量，或确认当前环境已经提供 `DATABASE_URL`。也可以在构建后显式加载本地 `.env`：

```bash
node --env-file=.env packages/database/dist/cli.js
```

若使用 Compose 默认连接，也可显式执行：

```bash
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control \
  npm run db:migrate
```

应用记录和 SHA-256 checksum 由数据库 Migration 运行器维护；同一数据库
只允许一个持有 PostgreSQL advisory lock 的迁移进程推进，每个文件在独立
事务中执行。已应用文件被修改时会因 checksum 不一致而拒绝启动。不要通过
删除 Migration 记录来强制重跑，也不要在有真实数据的数据库上手工回退结构。

## 0001–0028 清单

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
| 0024 | `0024_model_protocol_events.sql` | 允许记录 `model_protocol_rejected` 事件，用于追踪无效模型协议响应及修正。 |
| 0025 | `0025_agent_run_hop_budget.sql` | 把新 Run 的默认最大 hop 数设为 40，不修改已有 Run。 |
| 0026 | `0026_flash_agent_hop_budget.sql` | 把新 Run 的默认最大 hop 数进一步设为 60，不修改已有 Run。 |
| 0027 | `0027_mission_budget.sql` | 增加 Mission 模型调用账本与持久化预算等待，回填可用历史用量；Token 限额允许 0，`NULL` 表示不限额。 |
| 0028 | `0028_goal_verification.sql` | 增加 Mission 的终验开关与当前终验 Task 引用。默认关闭，旧 Mission 不会自动追加终验任务。 |

0027 会将仍能识别的缺失调用或空用量记为未知；旧适配器已把缺失 usage 写成 0 的记录无法还原，因此不能把回填值当作完整账单。0028 只增加数据库字段；新建 Mission 是否启用终验、追加终验任务与交付校验由应用代码处理。当前 Web 的新建入口会启用终验，直接 API 创建未显式启用时仍走原流程。

代码中已登记 Migration、测试库迁移通过，都不代表日常数据库已升级。更新时须对实际 `DATABASE_URL` 运行迁移，再使用依赖这些表和字段的新 API/Worker。

## 为什么不能跳过 Migration

代码、数据库约束和 Repository 查询共同定义状态机。例如代码已经按照 `review_executions` 恢复 Reviewer，但数据库没有应用 0014，Reviewer Worker 会直接因表不存在而失败。正确处理不是在代码里绕过 Reviewer，而是对目标数据库执行完整 Migration。

## 测试数据库安全边界

`npm test` 默认包含真实 PostgreSQL 集成测试；`npm run test:integration` 只运行这一组。未提供 `TEST_DATABASE_URL` 时，测试入口会自动启动独立的 PostgreSQL 17 Docker 容器：随机本机端口、专用 `runguild_test` 数据库、临时内存数据目录，结束后自动清理。测试会自动应用全部 Migration，不需要先迁移开发库。Docker 或测试数据库不可用时命令失败，不会静默跳过。

已有独立测试数据库时，可显式提供 `TEST_DATABASE_URL`。测试入口不会读取 `.env`，也不会从开发环境的 `DATABASE_URL` 推导测试连接。下面仅是使用现有 Compose PostgreSQL 服务的可选方式：

```bash
docker compose exec postgres createdb -U mission mission_control_test
TEST_DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control_test \
  npm run test:integration
```

外部 PostgreSQL 集成测试会清理自己的 fixtures，因此在迁移和清理之前，先验证连接 URL 中的数据库名，再验证服务器返回的 `current_database()`，两者均须以 `_test` 结尾。显式测试库须由当前测试进程独占；并行运行时应使用不同数据库。绝不能把 `TEST_DATABASE_URL` 指向个人日常使用的 `mission_control`。

如明确只运行不依赖独立 PostgreSQL 的用例，可使用 `npm run test:without-postgres`；这是缩减测试范围的显式命令，不能作为完整回归通过的依据。

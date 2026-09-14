# RunGuild 真实模型评测运行手册

这套流程用于在三个有界、无外部依赖的软件任务上，对单 Agent 与“Researcher → Builder → Reviewer”协作链做三次配对实验。它调用真实 RunGuild API、Worker、PostgreSQL 账本、Git Worktree、Bubblewrap 测试沙箱和模型端点，不会把脚本内的模拟结果写成实验结论。

## 安全边界

- API Key 只由已经启动的本地 API 进程通过环境变量传给受管 Worker；评测脚本不读取、不输出 Key。
- 目标仓库必须位于 `main` 且工作区干净，Scenario Version 冻结完整 baseline commit。
- `test/acceptance.test.mjs` 是受保护控制面证据，Agent 的补丁和测试副作用都不能修改它。
- Bubblewrap 使用 `network=host`，隔离文件系统和资源，但不宣称隔离网络。
- 输出保留配置、报告、Run Trace 和模型溯源，不保留模型请求/响应正文。
- 同一 Agent 身份同时最多持有一个待消费 Dispatch 或活动 Run，避免串行 Worker 预先领取多个会过期的租约。
- Evaluation 中的 `waiting_human` 视为本次自主 Trial 失败并形成终态指标；它不会让无人值守实验永久挂起。

## 单组实验

先从仓库内固定 fixture 创建一个新的独立 Git 仓库：

```bash
npm run evaluation:materialize-target -- local-bug /tmp/runguild-eval-local-bug
```

确认本地 API 已使用真实 PostgreSQL、Redis、模型 Key 和兼容端点启动，然后执行：

```bash
npm run evaluation:live -- \
  --family local-bug \
  --target /tmp/runguild-eval-local-bug \
  --worktree-root /tmp/runguild-eval-local-bug-worktrees \
  --output /tmp/runguild-eval-local-bug-evidence.json \
  --model deepseek-v4-flash \
  --repetitions 3
```

脚本会依次停止旧的受管 Worker、保存目标仓库的运行配置、启动 Scheduler / Evaluation / Researcher / Builder / Reviewer / Integration Worker、创建不可变 Scenario Version 与 Experiment、等待终态、导出证据并停止本次 Worker。

其余两组把 family 和路径替换为：

- `api-implementation`
- `cross-module`

## 结果解释

每组必须形成 3 个完整配对才达到 `repeatable` 工程证据门槛；这不等于统计显著。报告中的模型溯源分别记录：

- `requestedModel`：项目配置冻结的模型名；
- `returnedModel`：供应商响应实际报告的模型名；
- `endpoint`：经过验证、不含凭据的精确 `/responses` 地址；
- `actorKind`：普通执行 Agent 或独立 Reviewer；
- `calls`：该组合在 Trial 内的真实调用次数。

如果一方失败，失败本身也是结果，不应手工改数据库制造成功。先从 Trial error、Run Trace、Tool failure 和 Worker 日志定位原因；修复平台后应创建新的 Scenario Version 或 Experiment，保留旧证据。

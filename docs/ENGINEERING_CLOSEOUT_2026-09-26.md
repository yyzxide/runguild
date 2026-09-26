# 2026-09-26 工程收尾记录

本次收尾将新增 `/goal`、系统终验和 Mission Token 预算固定到可检出的版本，完成干净环境回归，并使用真实模型走通 API 与 Worker 链路。真实运行中发现了验收覆盖缺口，因此保留原始通过记录，同时记录推翻其完整性结论的反例。

本地工作分支为 `codex/goal-closeout-20260926`。本文记录开发验证事实，不代表已发布版本、浏览器端到端验证或多 Agent 效率结论。

## 1. 固定版本与干净环境回归

| 提交 | 内容与证据范围 |
|---|---|
| `4ccc68a` | Goal、预算、文档同步和 Integration 配置修复；从全新 clone 安装、构建并完成完整回归。 |
| `ddcd95a` | 增加隔离的真实模型 Goal 验证脚本；第一轮使用此版本。 |
| `3ce9487` | 归档干净检出结果，并等待验证子进程实际退出后再保存日志；第二轮使用此版本。 |
| `f008931` | 增强稀疏数组反例检查，明确自有索引和研究笔记约束；第三轮使用此版本。 |

对 `4ccc68a` 的验证使用新目录 `/tmp/runguild-closeout-clean-W7mpp0`，没有复制原工作区的 `.env`、`node_modules` 或 `dist`。实际环境为 Node.js 24.15.0、npm 11.12.1；仓库最低要求已对齐为 Node.js 22.12.0。

先执行 `npm ci --prefer-offline --no-audit --no-fund`，再清除 `DATABASE_URL`、`TEST_DATABASE_URL` 和 `OPENAI_API_KEY` 后执行 `npm test`。该命令包含构建，结果为 **276 项通过、0 失败、0 跳过**，其中包含临时 PostgreSQL 17 集成套件。测试阶段约 199 秒，只是当次耗时。其余测试仍包含 PGlite、模拟模型/API 和临时 Git 仓库。

原始输出及 SHA-256 见[验证归档](verification/2026-09-26/README.md#固定版本的干净检出回归)：[安装输出](verification/2026-09-26/clean-install.txt)、[完整回归](verification/2026-09-26/clean-full-suite.txt)。这份数量对应 `4ccc68a`，不能作为后续任意提交自动通过的证明。

本次后续提交仅增加验证脚本、fixture 与证据文档；收尾时核查 `apps`、`packages` 和依赖清单相对 `4ccc68a` 没有变化。最后检查了 19 份 Markdown 的 174 个本地链接、27 份证据文件哈希和第三轮 Git bundle 完整性，均通过。

同时修正了干净机器的启动说明：安装依赖并编辑 `.env` 后再启动 Compose、构建和迁移；local 模式免密码自动初始化，team 模式单独设置凭据；Worktree 配置使用绝对路径。日常数据库必须单独迁移，测试通过不会升级 `.env` 指向的数据库。

## 2. 真实 Goal 验证范围

[运行脚本](../scripts/goal-smoke.mjs)启动隔离的 PostgreSQL 17、Redis 7、API，以及正式入口的 Scheduler、Agent 和 Integration Worker。目标是临时创建的无依赖 ESM 小仓库，实现 `normalizeLabels(values)`：检查字符串数组、去除首尾空白、转小写、去空、按首次出现去重，并保留输入不变。

每轮采用以下固定流程：

```text
/goal 消息与规划请求
  → 研究任务提交实现与边界笔记
  → 构建任务依赖研究结果，实现函数和回归测试
  → 系统追加的 Builder 终验检查合并结果
  → 各任务独立 Reviewer 与集成门禁
  → 宿主固定 oracle 和最终提交的 npm test
  → 精确 Artifact Version 最终批准
```

脚本调用当前 Web 的 Goal 请求构造逻辑，再通过真实 HTTP API 创建消息与规划请求，**没有运行浏览器**。计划批准和最终批准由明确调用 `--run` 的操作者脚本按固定策略发起，使用真实用户 Session 与批准 API；不是用户本人点击，也不是 Agent 自行批准。

三种检查需要分别理解：模型 Reviewer 审查冻结提交材料；任务和 Integration 执行目标仓库的测试；宿主 oracle 从 Agent 目标仓库之外检查最终函数。该 oracle 是本次 fixture 专用程序，不是 RunGuild 平台通用的受保护业务验收套件。它没有被目标仓库改写，不意味着覆盖了全部需求。Worktree 也不是操作系统沙箱。

## 3. 各轮结果与后续反证

| 轮次 | 源码与预算 | 当次记录 | 可支持的结论 |
|---|---|---|---|
| 01 | `ddcd95a`，500000 Token | 记录 502107 Token、38 次调用；脚本因预算耗尽主动停止，摘要为 `failed`。 | 验证有限预算停止策略；没有完成这轮最终交付。 |
| 02 | `3ce9487`，1500000 Token | 记录 740444 Token、42 次调用；三个 Task 完成、独立 Review/集成通过，原 8 组 oracle 和仓库 13 项测试通过，Mission `completed`，原摘要为 `passed`。 | 流程与当时检查集合通过；后续反例推翻“完整语义已满足”的解释。 |
| 03 | `f008931`，1500000 Token | 记录 959806 Token、56 次调用；三个 Task 与 Review 完成，增强后的 9 组 oracle 和仓库 16 项测试通过，Mission `completed`。 | 功能结果通过新增反例检查；研究笔记仍有三处事实错误，不能声称全部生成材料正确。 |

第一轮源记录见[摘要](verification/2026-09-26/goal-smoke/attempt-01-summary.json)、[事件](verification/2026-09-26/goal-smoke/attempt-01-events.json)。限额是软限制，已准入的调用可以使总量超过 500000；502107 不代表平台承诺的精确硬限额被突破。脚本结束时终验 Run 已成为 `cancelled`，不能把此后的新一轮运行称为“同一个运行中的 Run 抬预算恢复”。

三轮均先使用 **0 预算**创建 Goal，并断言 Planner 的持久 budget waiter 已存在、attempt 为 0、模型调用数为 0；随后提高限额，waiter 清除，Planner 开始执行。这是已经验证的预算暂停与恢复路径，须与第一轮耗尽后脚本退出区分。

第二轮原记录见[摘要](verification/2026-09-26/goal-smoke/attempt-02-summary.json)、[8 组 oracle](verification/2026-09-26/goal-smoke/host-oracle.json)、[13 项仓库测试](verification/2026-09-26/goal-smoke/target-tests.txt)和[独立复核](verification/2026-09-26/goal-smoke/attempt-02-independent-review.json)。最终目标提交为 `3fe913b5068fca57a3a9d0e740694a7f1499e63e`，其 [Git bundle](verification/2026-09-26/goal-smoke/target.bundle)保留用于复查。

后续复核发现，第二轮函数使用 `i in values` 判断数组索引是否存在。对一个没有自有索引 `0`、但局部自定义原型提供字符串索引 `0` 的数组，`in` 返回真，函数接受继承来的标签；原验收要求缺失位置抛出 `TypeError`。原始 oracle 没有这项输入，因此全部通过仍漏掉该条件。研究笔记还混淆了普通数组空位的迭代行为：`for...of` 与展开会得到 `undefined`，而 `map`、`forEach`、`filter` 在无继承索引时跳过这些位置的回调。

保留原始 `passed` 摘要，不回写成另一段历史。完整结论应同时引用[反例输入状态](verification/2026-09-26/goal-smoke/attempt-02-counterexamples.json)、[断言失败](verification/2026-09-26/goal-smoke/attempt-02-counterexample-failure.txt)和[加强检查后的失败](verification/2026-09-26/goal-smoke/attempt-02-stronger-oracle.json)。这表明检查集合和 Reviewer 可能共同漏验，不表明数据库状态或批准 API 没有实际执行。

`f008931` 为宿主 oracle 增加第 9 组检查，覆盖原型提供缺失索引的普通及冻结数组；同时把自有索引要求和研究笔记准确性写入输入契约。[加强前后比较](verification/2026-09-26/goal-smoke/oracle-strengthening-comparison.json)表明第二轮产物在新检查下为 8/9 通过。没有手改第二轮产物来冒充新的 Agent 成功。

第三轮最终目标提交为 `eb789a00bcc066c0cd6b03e8ee5240c36f79e9b6`，使用自身属性检查拒绝继承索引反例；目标仓库自身也新增相应用例。见[真实摘要](verification/2026-09-26/goal-smoke/attempt-03-summary.json)、[9 组固定检查](verification/2026-09-26/goal-smoke/attempt-03-host-oracle.json)、[16 项目标测试](verification/2026-09-26/goal-smoke/attempt-03-target-tests.txt)、[最终 diff](verification/2026-09-26/goal-smoke/attempt-03-target.diff)和[独立复核](verification/2026-09-26/goal-smoke/attempt-03-independent-review.json)。三个执行 Run 均在第一次 attempt 成功，内部有两次失败工具调用并由模型继续处理，不应写成整个过程没有错误。`captureErrors`、`cleanupErrors` 均为空，结束后另核查没有遗留临时容器或平台子进程。

独立复核同时确认第三轮研究笔记仍有三处错误：与 `undefined` 比较不会拒绝字符串 `'undefined'`；`filter` 会压紧输出而不保留空位；冻结后的已有属性不能再删除。原笔记和模型 Review 原样留档，另提供[人工勘误](verification/2026-09-26/goal-smoke/attempt-03-notes-errata.md)。这是功能验收闭环与说明文字准确性的边界；本次没有继续扩实验或手改产物冒充 Agent 修复，也不声称研究笔记准确性约束已经全部满足。

三轮完整账本、模型/工具材料、进程日志与目标 Git bundle 的归档和完整性校验见[实跑证据索引](verification/2026-09-26/goal-smoke/README.md)。

## 4. 本次遇到的缺陷归属

- **B08 是平台配置传递缺陷**：Web 启动 Integration 时未传递项目验证/准备命令，构建任务和集成使用了不同命令。修复了 supervisor 环境构造，并保留修复前 8 通过/1 失败、修复后 9 通过的回归输出。见 [B08](BUGFIX_NOTES_2026-09-26.md#b08构建任务按项目配置测试集成却用了默认命令)。
- **B09 是生成产物和验收覆盖缺口**：`normalizeLabels` 属于真实运行生成的 fixture，不是 RunGuild 平台业务函数。处理包含保留反证、加强 oracle 与输入契约、重新运行。见 [B09](BUGFIX_NOTES_2026-09-26.md#b09三次-review-和现有测试通过仍然漏掉一个原始条件)。
- **验证脚本收尾修正**：`3ce9487` 补充对子进程退出的有界等待，避免发送强杀后即记录尚未更新的退出状态。此项改善证据捕获，不增加 Goal 业务能力。

模型用量来自 Mission 调用账本。常规执行和系统终验均记为 `role=execution`，分析时必须通过 Run/Task 关联识别终验，不能只寻找 `acceptance` 角色。实际观察模型为 `deepseek-v4-flash`。第二轮 42 次、第三轮 56 次调用均未计价，`estimatedCostUsd=null` 表示价格未知，不表示免费；第三轮输入 935740、输出 24066 Token，无未知用量。上述次数、Token 和时长不能证明多 Agent 比单 Agent 更省、更快或更准确。

## 5. 复现入口

准备 Node.js 22.12.0 以上、npm、Git 和可访问的 Docker，按 lock 安装并构建。`.env` 中提供明确的 `MODEL_NAME`、`OPENAI_API_KEY`，必要时设置兼容端点；不要把凭据写进证据或提交。

```bash
npm ci
npm run build

# 会产生真实模型费用；输出目录必须不存在，每轮使用新目录。
GOAL_SMOKE_TOKEN_LIMIT=1500000 \
  node --env-file=.env scripts/goal-smoke.mjs --run \
  --output /tmp/runguild-goal-smoke-new-run
```

脚本本身不读取 `.env`；上例由 Node 显式加载。验证脚本忽略传入的 `DATABASE_URL`、`REDIS_URL`，创建自己的临时服务与目标仓库，结束后清理；输出目录保留脱敏账本和目标 Git bundle。默认整轮时间上限为 20 分钟，可用 `GOAL_SMOKE_TIMEOUT_MS` 调整，最大 30 分钟。1500000 是本次复现设置，不保证任意模型或运行一定完成。

先读 `summary.json` 的源码提交、终态与捕获/清理错误，再看 oracle、目标测试、最终批准和账本。若后续反例与摘要冲突，应并列保留并缩小原结论，不能仅引用 `passed`。

## 6. 建议阅读顺序

1. [Goal 运行脚本](../scripts/goal-smoke.mjs)：哪些步骤由平台执行，哪些由操作者脚本执行？为什么最终批准必须绑定具体 Version？
2. [fixture 与宿主 oracle](../scripts/goal-smoke-fixture.mjs)：检查输入覆盖了哪些边界？测试放在目标仓库外为何仍可能漏验？
3. [Bug 记录](BUGFIX_NOTES_2026-09-26.md)与本页各轮证据：配置错误、生成代码错误、验收遗漏分别由哪一层负责？一次状态链路通过能够支持多大的结论？

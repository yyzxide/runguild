# RunGuild Bug 修复与开发复盘记录

整理日期：2026-09-26。用途：项目排障、后续开发、面试时回答“印象深刻的 Bug / 遇到的技术难点”。

本记录整理本次对话中从 `/goal` 改造、预算与终验、PostgreSQL 回归，到跨任务消息路由的修复。源码和测试按整理时工作区核对；更早的修复单独引用历史记录。整理时基线 HEAD 为 `a51ccc37004e12f49b21a77c5b3cc7f23267b2e1`，相关实现仍有未提交改动，不能把这个 SHA 当成全部修复的发布版本。

## 怎么使用这份记录

- **已复现**：保存了旧实现失败、新实现通过的输出。B01 的证据最完整，适合优先准备。
- **源码确认并回归**：能从修改前后代码确认问题，现有测试验证修复；没有保存旧版失败输出时，不补写一次虚构事故。
- **开发边界保护**：新功能开发时补齐的异常路径，有测试支持，适合讲设计与调试，不统一包装成历史 Bug。
- **历史修复**：已有带日期记录；本次只整理入口，不改写发生时间。

首次整理时完整回归为 **275 项通过、0 失败、0 跳过**。工程收尾追加 B08 后，源码提交 `4ccc68a` 的全新 clone 经 `npm ci`、构建和完整回归为 **276 项通过、0 失败、0 跳过**，包含真实 PostgreSQL 17 集成测试，见[干净检出输出](verification/2026-09-26/clean-full-suite.txt)。这些是对应版本的结果，不是永久测试数量。PGlite、模拟模型/API、临时 Git 仓库测试与真实模型端到端运行的证据范围不同；这些修复不能表述成线上客户事故或多 Agent 性能优势。

## 修复索引

| 编号 | 问题 | 证据性质 | 适合展开的话题 |
|---|---|---|---|
| B01 | Agent 消息保存成功，但不能跨 Task 投递 | 已复现，有修复前后日志 | 协作协议、作用域、测试漏项 |
| B02 | 恢复了租约，Run / Task 仍处于等待状态 | 源码确认并回归 | 状态机、事务、恢复语义 |
| B03 | 无效的已保存 Goal 计划反复重放 | Goal 开发中修复并回归 | 重试分类、持久化边界 |
| B04 | 缺失模型用量被当作 0 | 源码确认并回归 | 未知状态、预算统计 |
| B05 | 完整测试悄悄跳过 PostgreSQL | 历史输出和修复后实测 | 验证盲区、测试环境 |
| B06 | 并发测试实际验证了身份拒绝 | 源码确认，真实 PostgreSQL 回归 | 并发测试是否命中竞争条件 |
| B07 | 页面仅凭 Task completed 就把所有验收项标为通过 | 源码确认，数据库与界面回归 | 展示状态与实际证据一致性 |
| B08 | 网页启动的 Integration 丢失项目测试与准备命令 | 收尾时复现，有修复前后日志 | 配置传递、默认值、测试固化错误行为 |
| D01–D05 | 预算暂停、Goal 重试、启动协调、评审反馈、终验约束 | 开发边界保护或能力补齐 | 幂等、持久上下文、故障恢复 |

## B01：消息保存成功，接收方却没有收到运行中提醒

**现象与触发条件**：同一 Mission 中，Agent A 执行 Task A，给正在执行 Task B 的 Agent B 发 `conversation.reply`。消息已经入库，但 B 的投递状态变成 `context_pending`，没有生成目标 Run 的 steer 控制。它不会因此进入 B 已经冻结的启动上下文。

**根因**：工具为了记录发送来源，把 A 的 `missionId/taskId/runId` 写入 `entityRefs`；`routeMentions` 又拿这里的 `taskId` 筛选 B 的活跃 Run。发送者出处被误用成接收方地址。原测试是“用户发消息，只有 missionId”，没有覆盖真实 Agent 工具会附带发送者 taskId 的路径。

**修复**：Agent 消息保留来源引用，接收方按 Workspace、Mission、被 @ 的 Agent 查找，允许属于不同 Task。用户显式指定 Task 的即时投递保留原有限制。补充作者 Run 与来源 Run 的一致性、Run 归属校验；已有会话成员和 Mission 边界继续生效。

**验证**：使用真实工具 handler → ConversationRepository → PGlite。旧编译产物运行新增回归时，`deliveredAgentIds` 实际为 `[]`，预期为 `['builder']`；修复构建后通过。还检查 control / inbox / outbox 对应同一个接收 Run、重试无重复副作用、不同 Mission 不串发、无活跃接收方仍 pending、自 @ 不唤醒，以及来源伪造被拒绝。

- 实现：[conversation-tools.ts](../packages/collaboration/src/conversation-tools.ts)、[conversation-repository.ts](../packages/database/src/conversation-repository.ts)，定位 `routeMentions` 与 `assertEntityRefs`。
- 回归：[conversation-repository.pglite.test.mjs](../packages/database/test/conversation-repository.pglite.test.mjs)，`conversation.reply steers an Agent in another Task and preserves sender provenance on retry`。
- 输出：[修复前失败](verification/2026-09-26/cross-task-before.txt)、[修复后通过](verification/2026-09-26/cross-task-after.txt)。前者 5 项中 1 项失败；后者增加来源校验用例后为 6 项全通过。

**口述示例**：

> 在开发多 Agent 协作时，我排查发现一个消息已经保存、协作却没有触发的问题。两个 Agent 在同一目标下做不同任务，发送方的 Task ID 被路由逻辑误当成接收方的筛选条件，导致活跃的接收方匹配不到。我保留发送者信息用于追踪，将接收方按同一 Mission 内被提及的 Agent 寻址，再通过真实工具到数据库的测试复现旧版失败、验证新版投递和重试。这个问题让我意识到，消息保存成功、控制请求已排队、对方已经处理，是不同的状态。

**追问准备**：为什么不能直接删除发送者 taskId？为什么单测原来能通过？为什么保存消息和创建唤醒应在同一事务？`steered` 能否代表对方已回复？最后一题的答案是不能：本次修复验证到队列投递，没有加入业务级请求/答复生命周期，也没有运行真实模型互相求助的端到端演示。

## B02：恢复了租约，但任务没有重新进入执行队列

**现象与触发条件**：一个 `waiting_human` 的 Run 获准继续时，恢复方法返回成功并创建新租约；如果 Run、Task 状态仍停在等待，执行器查询可运行任务时仍找不到它。

**根因**：原 `resumeWaitingRun` 只恢复租约，没有同时恢复 Run 和 Task 的状态。一个逻辑动作被拆成了不一致的数据事实。

**修复**：在同一事务内确认可恢复条件、锁定 Run / Task、创建新租约，并把二者改为 `running`。预算等待还必须满足可继续条件；普通人工审批等待不因提高预算而自动获批。

**验证**：PGlite 测试提高预算后恢复同一个 Run，并断言它重新出现在 `listRunnableAgentRuns` 中。Runtime 使用模拟存储的测试还检查暂停不消耗模型 hop、恢复继续原对话。未保存本项旧版失败日志，不能称作真实 Worker 崩溃事故复现。

- 实现：[task-repository.ts](../packages/database/src/task-repository.ts)，`resumeWaitingRun`。
- 回归：[mission-budget.pglite.test.mjs](../packages/database/test/mission-budget.pglite.test.mjs)，`Mission soft cap persists shared spend, permits admitted calls, and resumes only budget waiters`；[runtime.test.mjs](../packages/agent-runtime/test/runtime.test.mjs)，`Mission budget pause preserves the model hop and resumes the same conversation`。

**口述要点 / 追问**：租约代表谁有执行权，状态代表是否允许执行，恢复必须同时满足两者。事务里漏掉其中一个字段会出现什么现象？为什么恢复不应该创建一次新的业务 attempt？

## B03：无效计划已经保存，重试只是在重复同一个错误

**现象与触发条件**：`/goal` 增加自动终验任务后，某些计划符合普通计划格式，却违反 Goal 约束，例如原始任务达到 100 个、或使用系统保留任务 key。若先把模型计划保存为 `model_complete`，之后才在提交阶段拒绝，恢复时会一直读取同一份无效计划。

**根因**：为避免重复模型调用而设计的“重放已保存结果”，与 Goal 专有校验的执行顺序不一致；确定性无效结果被当作普通可重试失败。重放存储结果也不一定消耗新的模型尝试次数。

**修复**：新生成的 Goal 计划先验证，再冻结模型结果；已保存的不合法计划，以及确定性的计划拒绝，终止自动重试，保留原材料和可见错误。尚未保存计划时，模型生成失败受 `maxAttempts` 限制；已保存结果可以恢复重放，本次为确定性拒绝新增终止分支，不能据此声称所有重放都有统一次数上限。

**验证**：模拟模型与 Repository 的 Worker 测试覆盖非法新计划、非法已保存计划、确定性提交拒绝；PGlite 测试确认终止状态保留材料且不能重新领取。这是新增 Goal 流程开发中的修复，没有声称发生过实际模型长期空转事故。

- 实现：[conversation-planner.ts](../apps/worker/src/conversation-planner.ts)、[conversation-planning-repository.ts](../packages/database/src/conversation-planning-repository.ts)。
- 回归：[conversation-planner.test.mjs](../apps/worker/test/conversation-planner.test.mjs)，`Goal-specific invalid model plans are never frozen and invalid stored plans stop replay`；[conversation-planning-repository.pglite.test.mjs](../packages/database/test/conversation-planning-repository.pglite.test.mjs)，`a terminal frozen-plan failure preserves its audit material and cannot be reclaimed`。

**口述要点 / 追问**：重试只有在输入或环境可能改变时才有意义。为什么不能一律重新请求模型？如何同时保留审计材料、避免重复计费和停止确定性失败？

## B04：模型没有报告用量，却被记成零消耗

**现象与根因**：原适配器用默认值把缺失的 usage 变成 0，混淆了“确认没有消耗”和“没有拿到消耗信息”。有限预算可能因此继续放行，展示也可能误导用户。

**修复**：校验输入、输出 token 必须是非负安全整数；缺失、不完整或非法用量标记 `usageReported: false`，Mission 账本保留 `unknown`。缓存 token 明细缺失时也安全读取，避免直接访问不存在的字段。缺价格保留空值和未定价数量。有限预算遇到未知消耗时等待核实；后续拿到真实用量可结算并唤醒符合条件的等待者。

**相邻保护**：模型已经返回，但结构化结果解析失败，仍然先登记已知消耗；预算拒绝发生在模型调用前，不扣执行 hop 或模型尝试。输入 token 中已包含的缓存 token 不重复相加。

- 实现：[openai-responses-adapter.ts](../packages/agent-runtime/src/openai-responses-adapter.ts)、[mission-budget-repository.ts](../packages/database/src/mission-budget-repository.ts)。
- 回归：[openai-adapter.test.mjs](../packages/agent-runtime/test/openai-adapter.test.mjs)，`OpenAI adapter marks missing and partial usage unknown and tolerates missing cache details`；[mission-budget.pglite.test.mjs](../packages/database/test/mission-budget.pglite.test.mjs)，`Unknown provider usage stops finite budgets and is never reported as measured zero spend`；[mission-budget.test.mjs](../apps/worker/test/mission-budget.test.mjs) 的 Planner / Reviewer 非法响应计费用例。

**口述要点 / 追问**：统计字段也有状态语义。为何 unknown 不能用 0 代替？为什么解析失败仍有消耗？当前限额是软上限，已经获准且在途的并发调用仍可能使最终总量超限。此修复针对 Mission 预算账本，不能据此声称旧 Evaluation 聚合口径已经统一。

## B05：完整回归通过，但 PostgreSQL 套件被跳过

**现象与根因**：没有 `TEST_DATABASE_URL` 时，旧 `npm test` 使用条件 skip 跳过 PostgreSQL 集成套件。先前结果是 264 项、263 通过、1 跳过；“测试通过”没有覆盖真实 PostgreSQL 协调行为。

**修复**：完整测试和集成测试在未指定专用测试库时自动启动临时 PostgreSQL 17，绑定随机本地端口、使用临时数据，结束清理。Docker 不可用或连接失败明确报错；不回退连接日常 `DATABASE_URL`。测试入口在连接前校验 URL 的 `_test` 库名，连接后再次核验实际库名，再执行迁移和清表。缩减套件通过明确的 `test:without-postgres` 命令选择。

**验证**：真实 PostgreSQL 专项 9 项通过；修改后完整回归 271 项通过、0 跳过；B01 修复后的最新完整回归增至 275 项全通过。测试容器结束后已检查清理。这里修复的是测试入口和验证盲区，不能说以前业务数据库发生过数据损坏。

- 实现：[scripts/test.mjs](../scripts/test.mjs)、[package.json](../package.json)。
- 测试：[postgres.integration.test.mjs](../packages/database/test/postgres.integration.test.mjs)。
- 输出：[之前有跳过](verification/2026-09-26/full-suite-before-postgres-fix.txt)、[PostgreSQL 专项](verification/2026-09-26/postgres-integration.txt)、[修复后的全量](verification/2026-09-26/full-suite-after-postgres.txt)。

**追问准备**：PGlite 通过为什么还要真实 PostgreSQL？测试如何避免误清开发数据？Docker 不可用时应该跳过还是失败？显式提供测试库时为什么仍应保证并行测试之间独占？

## B06：并发测试中的第二个参与者根本没有领取资格

**现象与根因**：旧用例用两个不同 Agent 争抢一个已经定向给 Agent A 的 Dispatch。Agent B 在身份条件上就会被拒绝，得到“一成功一失败”并不能证明两个合法请求竞争时数据库只允许一次领取。

**修复**：身份拒绝单独成例；并发场景改为同一个被授权 Agent、同一 Dispatch、不同 Run ID，由两个独立连接竞争。分别查询 `pg_backend_pid()` 确认连接不同，再断言只产生一个 Run、一份租约、一次 attempt 消耗。

**验证**：已在真实 PostgreSQL 17 跑通。后续租约过期和 Outbox 用例也使用自己的种子数据，避免依赖前一用例剩余状态。

- 测试：[postgres.integration.test.mjs](../packages/database/test/postgres.integration.test.mjs)，`a different agent cannot consume another agent's dispatch` 与 `competing connections consume the same authorized dispatch only once`。
- 输出：[PostgreSQL 专项](verification/2026-09-26/postgres-integration.txt)。

**口述要点 / 追问**：测试不仅要断言结果，还要确认触发了想验证的机制。若第二个请求提前被权限拒绝，它没有真正参与竞争。两个连接不同能证明什么、又不能证明什么？本用例是实际数据库回归，不是并发压力或形式化证明。

## B07：页面显示验收通过，依据却只是 Task 已完成

**现象与根因**：旧页面映射把 `task.status === 'completed'` 直接用于每一条验收标准的 passed 状态，没有分别核对当前 attempt 的有效证据。展示逻辑与实际完成门禁有不同的数据来源。

**修复**：Mission 进度返回真实 Run、当前提交与 Review、验收证据、集成状态；展示证据状态与完成检查共享判定条件。旧 attempt、过期记录、同命令较新失败、旧 HEAD 或被替代的提交不能作为当前有效证据；旧 approved Review 仍可展示为历史，但标记它不属于当前 attempt。

**验证**：PGlite 测试同时比较页面进度字段和 `hasMissingTaskEvidence`，验证二者一致；前端静态渲染测试覆盖相应状态。共享 predicate 的抽取没有重写原有后端门禁，也不是本轮才首次加入严格证据检查。

- 实现：[mission-progress.ts](../packages/database/src/mission-progress.ts)、[evidence-gate.ts](../packages/database/src/evidence-gate.ts)、[goal-progress.ts](../apps/web/src/goal-progress.ts)。
- 回归：[mission-progress.pglite.test.mjs](../packages/database/test/mission-progress.pglite.test.mjs)，`criterion progress follows the completion gate for stale, expired and later-failed evidence`、`review evidence must bind the current Submission and exact committed tree, independently of review status`；[goal-view.test.mjs](../apps/web/test/goal-view.test.mjs)。

**追问准备**：Task 完成、证据齐全、Review 批准、集成完成为什么要分别显示？新模型调用使用的实际模型与 Agent 当前配置不一致时，页面应该展示哪一个？

## D01–D05：开发中补齐的边界保护与能力缺口

这些记录有实现和测试，但不一概称为已发生的历史故障。

### D01：预算暂停必须同时更新状态、登记等待并释放租约

拒绝新的模型调用时，把 Run / Task 的等待状态、预算等待记录、对应租约释放放在同一事务，避免中途退出后被租约回收器当作普通失败。恢复后的模型调用校验实际持有的 lease token，旧 Worker 不能借用新租约继续执行。迟到的用量结算可以使预算由 unknown 恢复可用，并生成持久唤醒。

入口：[mission-budget-repository.ts](../packages/database/src/mission-budget-repository.ts)、[runtime.ts](../packages/agent-runtime/src/runtime.ts)、[agent-loop.ts](../apps/worker/src/agent-loop.ts)。测试：[mission-budget.pglite.test.mjs](../packages/database/test/mission-budget.pglite.test.mjs) 的 `Interrupted same-lease calls become unknown and late usage durably wakes only the paused run`，以及 B02 的恢复用例。测试检查事务结果和模拟中断状态，不是 kill 进程故障注入，也不证明整个系统完全消除所有崩溃窗口。

### D02：新 Goal 的作用域与两次写操作的重试

显式 `/goal` 创建新目标，不沿用旧 Mission、旧回复和已选 Agent 的 steering 信息。消息写入、规划请求写入分两次 POST；如果服务器写入成功但响应丢失，客户端保留同一份提交材料与两个稳定幂等键，重试复用原结果，并选中新 Mission。

入口：[goal-command.ts](../apps/web/src/goal-command.ts)。测试：[goal-command.test.mjs](../apps/web/test/goal-command.test.mjs) 的 `/goal creates an independent goal without steering the old Mission or Run` 和三种 `retry after lost ... response`。这些用例模拟 API 丢响应，不是实际网络故障注入；前端提交状态保存在组件生命周期内，不能声称刷新页面后仍能恢复同一次客户端操作。

### D03：启动部分成功、失败依赖不能错误拖住独立任务

启动前先检查所需配置；已在线或正在启动的 Worker 不重复启动。中途失败保留已成功启动项，刷新状态后只补启动缺失进程。对任务图区分失败节点及其后继与可独立推进的分支；后者可以继续，失败分支不会被偷偷重试。

入口：[goal-execution.ts](../apps/web/src/goal-execution.ts)。测试：[goal-execution.test.mjs](../apps/web/test/goal-execution.test.mjs) 的 `partial failure keeps successful starts and a fresh retry starts only the missing process`、`failed branches do not prevent independent work and blocked descendants stay stopped`。这里注入的是模拟启动接口，没有实际启动 Worker；它也没有实现通用运行中 DAG 重规划。

### D04：返工 Agent 需要看到上一轮具体评审意见

旧冻结执行上下文没有 `previousReview`。补齐同 Task 更早 attempt 的 `changes_requested` 摘要、问题和证据引用，限制大小，并冻结到新 Run 的上下文；同一 Run 重启仍读取相同版本，不被后来的评审修改悄悄改变输入。

入口：[execution-context-repository.ts](../packages/database/src/execution-context-repository.ts)、[agent-loop.ts](../apps/worker/src/agent-loop.ts)。测试：[execution-context.pglite.test.mjs](../packages/database/test/execution-context.pglite.test.mjs)，`review corrections are scoped to an earlier attempt, bounded, and frozen across restart`。这是信息传递缺口的补齐，PGlite 测试不证明真实模型因此一定能修好问题。

### D05：完整目标终验必须保留原始验收约束

新 Goal 自动追加保留 key 的终验任务，依赖原任务，并要求独立评审；原始任务最多 99 个，给系统任务留位置。计划审批再次校验，防止已保存计划中的终验门禁被弱化。最终交付绑定当前终验 attempt 的已批准提交；人工退回后修复任务仍携带原目标验收条件。Planner 输入也补齐原始验收标准，避免只有任务拆分而没有原始约束。

入口：[plans.ts](../packages/protocol/src/plans.ts)、[mission-repository.ts](../packages/database/src/mission-repository.ts)、[conversation-planner.ts](../apps/worker/src/conversation-planner.ts)。测试：[goal-verification.test.mjs](../packages/protocol/test/goal-verification.test.mjs)、[goal-verification.pglite.test.mjs](../packages/database/test/goal-verification.pglite.test.mjs)。完整终验与 `/goal` 入口是功能建设；保留 key、防篡改、返工不丢标准等是边界保护，不把整个功能描述成修复了一个旧 Bug。

## B08：构建任务按项目配置测试，集成却用了默认命令

**发现与触发条件**：2026-09-26 工程收尾检查真实 Goal 的启动路径时，发现本地 Worker Supervisor 的 Integration 分支提前返回，漏传项目配置的测试和 Worktree 准备 argv。只提供 `npm test` 的项目会被 Integration CLI 默认要求额外运行 `npm run typecheck`；需要安装依赖的项目也会丢失准备步骤。这是源码检查后用回归复现的配置问题，没有记录线上事故。

**根因与修复**：Agent 和 Integration 各自构造子进程环境，旧测试甚至断言 Integration 不含准备命令。现在二者共享项目的精确测试、准备 argv，模型凭据仍只进入 Agent。Integration CLI 当前只有一个准备/验证共用超时：存在准备命令时取两项配置上限的较大值，没有准备步骤时取测试上限。它还不是两阶段分别执行各自超时。

**验证**：新增回归在旧 dist 下为 9 项中 1 项失败，读取测试命令得到 `undefined`；修复构建后 9 项通过、0 跳过，另验证无准备步骤的超时和非执行 Worker 的环境隔离。`npm run typecheck` 通过。这项定向测试验证环境参数，没有假装执行完整 Integration；实际工程流程另由收尾实跑记录说明。

- 实现：[local-worker-supervisor.ts](../apps/api/src/local-worker-supervisor.ts)，`environmentFor`。
- 回归：[local-worker-supervisor.test.mjs](../apps/api/test/local-worker-supervisor.test.mjs)，`local Integration uses project verification and preparation argv without model credentials or unrelated defaults`。
- 原始输出：[修复前](verification/2026-09-26/integration-env-before.txt)、[修复后](verification/2026-09-26/integration-env-after.txt)。命令均为 `node apps/api/test/local-worker-supervisor.test.mjs`，修复后先执行 `npm run typecheck` 更新 dist。

**追问准备**：为什么单独启动 CLI 正常，网页启动却失败？为什么测试通过不代表配置正确？修改代码后，已运行的 API 和子进程是否自动得到新环境？最后一题的答案是需要重启相关进程。

## 更早的证据门禁与集成修复

已有记录：[2026-09-16 完成门禁与集成验证修复](FIXES_2026-09-16.md)。本次复核了记录及现有回归入口，历史问题包括：

- 旧 attempt 的测试通过不能满足当前失败 attempt；同 Run 的测试也要绑定当前提交和 tree，较新失败应阻断旧通过结果。
- 两个分支各自通过，不代表组合后通过。集成需在临时候选 Worktree 执行验证，检查候选未变、租约和批准有效、目标分支未变化，再发布。
- 相同文本输出不能让不同执行/快照的证据被错误去重；无修改任务应记录真实基线，不制造空提交。

测试入口：[completion-verifier.pglite.test.mjs](../packages/database/test/completion-verifier.pglite.test.mjs)、[review-repository.pglite.test.mjs](../packages/database/test/review-repository.pglite.test.mjs)、[git-worktree-manager.test.mjs](../packages/workspace-tools/test/git-worktree-manager.test.mjs)、[workspace-tools.test.mjs](../packages/workspace-tools/test/workspace-tools.test.mjs)。完整回归日志包含当前结果，但本次没有补造历史修复前日志。测试通过不等于测试断言充分覆盖业务需求，Worktree 也不是操作系统沙箱。

## 测试输出归档与复查命令

最初 6 份原始输出、后续 B08 回归及固定版本的干净检出验证见 [验证归档索引](verification/2026-09-26/README.md)，已从临时目录复制到仓库。最新完整输出：[276 项完整回归](verification/2026-09-26/clean-full-suite.txt)。

```bash
npm test
# 只运行真实 PostgreSQL 集成套件：
npm run test:integration
# 专查跨任务消息：先构建，再运行该测试文件。
npm run build
node packages/database/test/conversation-repository.pglite.test.mjs
```

前两条会使用显式指定的专用测试数据库，或自动创建临时 PostgreSQL 容器；不需要读取日常数据库凭据。最初文档整理只验证链接、记录与原日志一致性；后续工程收尾另在干净检出运行了完整回归，二者的日志和版本分别保留。

## 留待后续的增强项

结构化求助及答复生命周期、绑定批准版本的任务交接、平台控制的独立业务复验、按能力分配并行 Builder、局部重规划、完整 Goal 的公平评测和统一 Evaluation 用量口径仍是后续工作，不能列成已修复。当前 pending 消息的启动上下文仍受最近 30 条窗口限制，不能把持久存储解释为每条求助都最终被处理。

## 面试准备顺序与以后怎样补记录

先准备 B01 的完整故事，再选 B02 讲状态恢复，或 B06 讲如何验证并发。每个案例按“触发条件 → 可观察状态 → 定位证据 → 根因 → 修复 → 回归 → 剩余边界”解释。测试构造出的场景说成测试复现；未记录的耗时、损失、用户影响和性能提升不添加。

以后每次追加记录应保留：日期、版本或工作区范围、旧行为证据、实现入口、精确测试名、实际命令与结果、已知限制。修复前失败日志如未保存，就直接注明缺失；把尚未完成的建议留在后续项。

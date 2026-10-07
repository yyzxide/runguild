# RunGuild 面试准备与项目讲解

本文不是背诵稿，而是帮助项目操作者真正讲清楚 RunGuild 的目标、流程、技术决策、失败处理和现阶段边界。面试时只讲自己能够结合代码、数据库记录和实际运行证明的内容。

准备“印象深刻的 Bug / 开发中遇到的技术难点”时，参阅 [Bug 修复与开发复盘记录](BUGFIX_NOTES_2026-09-26.md)。其中保存了跨任务消息路由、状态恢复、预算统计、PostgreSQL 验证盲区等案例，以及修复前后测试输出。

## 1. 一句话定义

RunGuild 是一个面向软件工程长任务的、可验证的持久化多 Agent 协作执行平台。它把“多个模型一起回答问题”推进为“有计划审批、依赖调度、隔离代码执行、证据审查、精确集成、崩溃恢复和效果评测的长期工程工作流”。

## 2. 它解决的不是普通聊天问题

普通 Agent Demo 往往存在这些缺口：

- 对话结束后没有可靠状态，进程崩溃就丢失进度；
- 多 Agent 只是在并行输出文本，没有依赖和所有权；
- 模型可以自己声称完成，没有测试、提交或独立审查；
- 多个 Agent 修改同一目录，代码互相覆盖；
- Redis 队列中的消息被当成唯一事实，丢失后难以恢复；
- 可以执行任意 Shell，模型输入直接变成系统命令；
- Demo 页面显示样例数据，无法用于定位真实运行问题；
- 宣称多 Agent 更好，却没有相同基线上的对照实验。

RunGuild 的核心回答是：**模型负责提出动作，数据库事务、状态机和工具边界负责决定动作能否生效。**

## 3. 完整业务流程

```text
用户在团队协作室讨论真实需求
  │
  ├─ 选择消息，或在没有当前目标/规划时发送首条需求
  ├─ /goal 显式创建独立 Mission，可补充验收条件、约束和预算
  └─ 冻结来源消息和原始目标
  ▼
Planner 生成 Mission proposal 和 Task DAG
  │
  ├─ 持久化 prompt / response / usage
  └─ 等待人工批准，Planner 不能批准自己的计划
  ▼
Scheduler 查询 PostgreSQL 中依赖已满足的 Task
  │
  ├─ 创建幂等 Dispatch Token
  └─ 投递持久化 Agent Inbox，Redis 只负责唤醒
  ▼
Agent Worker 领取 Run 和租约
  │
  ├─ 创建独立 Git Worktree
  ├─ 构建冻结 Context Snapshot
  ├─ 通过 Tool Gateway 读取、修改和测试
  ├─ 创建精确 Git commit 和 Evidence
  └─ 冻结 Artifact Version，提交 Review
  ▼
独立 Reviewer 审查版本、标准、Evidence 和累计 diff
  │
  ├─ reject：回到 Builder 形成新版本
  └─ approve：进入 Integration 门禁
  ▼
Integration Worker 集成精确已审查 commit
  │
  ├─ 成功：完成 Task，解锁下游依赖
  └─ 冲突：不污染 base，要求基于新 base 重新实现和审查
  ▼
原始 Task 完成
  │
  ├─ 普通 Mission：进入最终交付
  └─ 启用 Goal 终验：Builder 核对整合结果与原始目标
       ├─ 范围内修复、重新验证，受尝试和预算限制
       └─ 再经过独立 Review 和 Integration
  ▼
人工验收最终 Artifact Version
  │
  ├─ 退回：追加修复任务；Goal 模式保留原始验收条件并重新终验
  └─ 批准：完成 Mission
  ▼
Mission completed，保留完整可审计账本
```

这条链路的重点不是 Agent 数量，而是每一步都有可恢复状态和不可绕过的门禁。

`/goal` 是新增的明确入口和终验能力，沿用原有 Mission 执行模型。当前 Web 的新目标与历史消息规划都会开启 `goalVerification`；旧 Mission 和未传该字段的 API 请求保留普通流程。已有目标时发送普通消息是在补充当前工作，不会自动新建 Mission。

## 4. 系统组成

| 组件 | 责任 | 不负责什么 |
|---|---|---|
| Web | 中文操作台、协作室、DAG、Artifact、Evaluation、Trace、Worker 控制 | 不保存 API Key，不伪造运行数据 |
| API | 命令、查询、认证、审批、WebSocket、Project Runtime Config | 不直接把模型文本当状态迁移 |
| Scheduler | 找到 ready Task，按角色和项目作用域分派 | 不执行代码，不持有仓库配置 |
| Agent Worker | Planner 或执行 Agent 的模型循环、Inbox、Run 恢复 | 不越过 Tool Gateway 任意修改系统 |
| Integration Worker | 集成已批准的精确提交、冲突恢复、Worktree 清理 | 不审查自己的集成候选，不集成未批准 HEAD |
| Evaluation Worker | 创建隔离 Trial Mission、收集真实指标、生成配对报告 | 不使用另一套 Mock 执行路径 |
| PostgreSQL | 所有持久事实、租约、状态、证据、认证、审计 | 不只是普通业务 CRUD 数据库 |
| Redis | 唤醒、Pub/Sub、跨实例 Artifact/Awareness 加速 | 不是事实源，丢消息不能改变事实 |

## 5. 最值得讲的技术决策

### 5.1 为什么 PostgreSQL 是事实源

长任务可能运行数十分钟或数小时。进程、网络和模型服务都可能失败，因此 Mission、Task、Run、Inbox、Lease、Evidence、Review、Artifact Version 和 Worker heartbeat 必须跨进程存活。

Redis 允许丢失通知，因为 Worker 可以重新查询 PostgreSQL。反过来，如果 Redis 是唯一队列，消息丢失或消费确认窗口出错就可能永久丢任务。

面试表达：

> Redis 告诉 Worker“可能有事情发生了”，PostgreSQL 决定“究竟发生了什么、谁有权继续做”。

### 5.2 如何处理并发领取

“代码层面加锁”只能保护一个进程内的内存，不能保护多个 Worker 或多台机器。RunGuild 使用数据库事务、条件更新、唯一约束、租约和 fencing token：

1. Worker 在事务中领取 Task/Run；
2. 更新条件包含期望状态和当前租约；
3. 成功者获得唯一 token 和过期时间；
4. 后续写入必须携带相同 fencing token；
5. 旧 Worker 即使在网络恢复后继续运行，也会因为 token 已变化而被拒绝。

这既解决“两个 Worker 同时领取”，也解决“暂停很久的旧 Worker 恢复后覆盖新 Worker”的 stale owner 问题。

### 5.3 Inbox、Outbox 和幂等

- Inbox 把给 Agent 的任务和控制消息持久化，并维护读取游标；
- Outbox 在同一数据库事务中记录“事实已变化、需要发布通知”；
- Redis Publisher 可以重复发布，消费者必须按事实坐标重新读取；
- Tool Call 使用稳定幂等键，崩溃恢复时复用同一个键；
- 对不能确认是否已经发生的副作用，系统进入可见的 ambiguous/人工处理路径，而不是盲目重试。

交付语义是 at-least-once，幂等边界内的实际效果尽量达到 effectively-once。

### 5.4 Git Worktree 是什么隔离

每个 Task 获得独立工作目录、分支、base commit 和状态记录。Agent 只能在自己的 Worktree 内通过路径受限工具操作。

Worktree 解决的是**代码工作区隔离**，不是完整操作系统 Sandbox。完整 Sandbox 还可以包括容器、用户/进程权限、网络隔离、资源配额和系统调用限制。RunGuild 当前用以下组合缩小风险：

- 仓库和 Worktree 绝对路径校验；
- 禁止逃逸目标根目录；
- 不提供任意 Shell；
- 测试和准备命令是精确 argv 白名单，并以 `shell=false` 执行；
- 文件 patch 先经过边界和 Git 校验；
- 拒绝 staged 的外部、绝对、悬空和自引用符号链接；
- 集成由独立 Worker 操作，不让 Builder 自行合并。

### 5.5 为什么 Artifact 和 Git commit 都需要

Git commit 证明“代码是什么”，Artifact Version 证明“任务交付说明、计划、证据投影是什么”。Reviewer 需要同时绑定：

- 不可变 Artifact Version；
- acceptance criteria；
- 精确 Evidence 集合；
- 测试和工具结果；
- Worktree HEAD 和累计 diff。

Artifact 的 LIVE Yjs 状态可以继续协作编辑，而已冻结 Version 永不改变。这样协作状态和审查依据不会混在一起。

### 5.6 为什么 Reviewer 和 Integration 分离

如果 Builder 可以批准并集成自己的代码，“完成”只是模型自我声明。RunGuild 要求独立 Reviewer；Integration Worker 只接收已经批准且 commit 与证据一致的候选。

如果 base 已前进并产生内容冲突，系统不会对旧批准偷偷 merge。它保留冲突现场、撤销旧候选资格，要求 Builder 在新基线上重新测试、冻结 Version 和审查。

### 5.7 上下文为什么要冻结和压缩

长任务会超过模型上下文限制。RunGuild 每个 hop 确定性构建输入，保留系统约束、当前任务、必要工具历史和摘要，并持久化 exact Context Snapshot。以后可以回答：

- 模型当时看见了什么；
- 哪些历史被压缩；
- 使用了哪个 Skill Version 和模型；
- 为什么重启后没有悄悄换指令。

### 5.8 身份认证和权限边界

- 浏览器使用 PostgreSQL 凭据和可撤销 Session；
- 数据库存储 password/session/CSRF 哈希，不存明文密码和 Cookie；
- Cookie 为 HttpOnly、SameSite，并配合 Origin 和 CSRF 校验写操作；
- owner/operator/viewer 具有不同操作权限；
- 浏览器自报的 actor header 不可信；
- Agent HTTP/WebSocket 使用独立、只存在环境变量中的 Bearer Token；
- 每条路径和 Repository 查询都重新验证 Workspace/Project 作用域。

### 5.9 `/goal` 如何避免“任务都完成了，目标却遗漏了”

把大需求拆成多个 Task 后，任务级审查只能说明这些任务达到了各自的标准。新增 Goal 模式会把原始目标、约束和验收条件保留下来，并在计划末尾追加一个依赖全部原始任务的终验 Task。

终验仍由 Builder 执行：在整合后的仓库上检查原始要求，逐项记录 Artifact Version、测试和命令证据，必要时在批准范围内修复，然后重新提交独立 Review。无需改代码就能通过检查时，也允许记录原提交，不强制制造 diff。人工退回最终交付会追加修复任务，保留原始验收条件，并把这项任务设为新的终验任务。

这里的“持续推进”有明确停止条件：Review 退回后仍受尝试次数、模型循环和 Token 预算限制；失败的前置任务也可能阻塞终验，需要操作者处理。系统尚没有通用的自动重写 DAG 能力。独立 Reviewer 目前审阅冻结材料，不能说成由平台另一套独立测试自动证明业务正确。

阅读实现可从 [计划终验规范化](../packages/protocol/src/plans.ts)、[交付与反馈事务](../packages/database/src/mission-repository.ts)、[目标进度页面](../apps/web/src/GoalView.tsx) 开始。重点回答：原始验收标准存在哪里、何时允许终验、退回后谁决定新的交付候选。

### 5.10 目标预算为什么是软限额

Mission 的模型调用账本汇总规划、执行、审查和终验用量，每次新调用前检查是否还能继续。已经发出的调用仍会结算，因此不能保证最终 Token 数绝不超过限额。

达到限额时保留成果和等待记录；操作者增加或移除限额后，符合条件的预算等待会被唤醒。`0` 表示不再放行新调用，移除限额不清零历史用量。若模型没有返回 usage，则记录为 unknown：有限额时暂停后续调用，提高额度不能消除未知用量；移除限额可继续，但总用量仍不确定。没有价格的调用单独显示，不能把空缺价格当作免费。

目标页同时显示已知用量、在途调用、未知用量和预算状态。它还按真实状态展示下一步、任务证据、评审意见、集成结果及交付反馈；“任务完成数”和“证据齐备数”不等于目标已经通过验收。

## 6. 状态机与恢复怎么讲

常见恢复窗口：

| 失败窗口 | 恢复方式 |
|---|---|
| Scheduler 发布前崩溃 | Outbox 仍在 PostgreSQL，重新发布或 Worker 轮询 |
| Agent 领取后崩溃 | Lease 到期，新的 Worker 使用新 fencing token 接管 |
| 模型响应后、消息落库前崩溃 | 依赖持久化 LLM/Planner 状态判断是否需要重新调用 |
| Tool 已执行、结果未写入 | 用 `runId:toolCallId` 对账并重放已知结果、重新领取或进入歧义状态 |
| Git commit 已创建、Evidence 未写入 | 对账 Worktree HEAD，补建 Evidence，不重复 commit |
| Reviewer 模型已决定、进程崩溃 | 从持久化 decision/model ledger 恢复，不重复调用模型 |
| Integration 内容冲突 | base 不变，保留可诊断 Worktree，重新实现和审查 |
| 新模型调用被预算阻止 | 持久化等待，Run/Task 暂停与释放租约同事务提交；调整限额后唤醒符合条件的预算等待 |
| Goal 终验未通过 | 在尝试限制内携带前次 Review 修复；耗尽或被前置失败阻塞时等待人工处理 |
| Yjs/Redis 通知丢失 | 从 PostgreSQL seq/hash 和 State Vector 重建真实状态 |

面试时不要只说“可以重试”。正确说法是：每个重试点都要回答副作用是否已经发生、谁仍拥有租约、重复执行是否安全。

## 7. Evaluation 的意义和真实结果

RunGuild 使用同一个冻结 Git baseline、同一个 Scenario Version 和配对 seed，分别运行 single-Agent 与 multi-Agent 计划。两者走普通 Mission、Review 和 Integration 流程，不走 Mock 捷径。

2026-08-31 的首次真实配对运行中：

- 模型为 `deepseek-v4-flash`；
- single-Agent 成功，multi-Agent 首次失败；
- 失败暴露了 Reviewer 分配、终态租约释放、模型工具协议、hop 预算和 Reviewer 用量统计问题；
- 修复后单独重跑 multi-Agent reliability Trial，Researcher 和 Builder 都在第一次尝试完成，Trial `success=true`；
- 该验证不是“多 Agent 一定优于单 Agent”的统计证据。

必须诚实说明限制：首次实验只有一次 repetition，并且运行中部署了恢复修复；compatible provider 当时没有价格配置。现在账本与报告会把这种成本保留为 `null`，不会再把未知价格显示成免费；不足三组完整配对也会明确标为探索性运行。详细记录见 [REAL_EVALUATION_2026-08-31.md](REAL_EVALUATION_2026-08-31.md)。

这个结果反而体现了 Evaluation 的价值：它不是为了做一张好看的成功率图，而是用真实执行暴露系统缺口。

这些历史 Trial 没有覆盖后来新增的完整 `/goal` 流程。当前 Evaluation 直接使用冻结计划创建普通 Mission，没有把新 Goal 规划、预算、终验及人工反馈作为完整配对实验；不能用历史成功率证明新功能的效果。新的 Mission 预算账本也不能与历史 Evaluation 中缺失价格记为零的口径混用。

## 8. 一分钟讲解模板

> RunGuild 是一个用于软件工程长任务的持久化多 Agent 平台。用户先在协作室形成需求，Planner 从选中消息生成 Task DAG，人工批准后 Scheduler 按依赖把任务送入持久化 Inbox。每个 Agent 在独立 Git Worktree 中运行，只能调用受限、幂等的工具。模型不能自己宣布完成，结果必须形成测试 Evidence、精确 commit 和不可变 Artifact Version，再由独立 Reviewer 审查，最后 Integration Worker 只集成已审查提交。PostgreSQL 是事实源，Redis 只做唤醒；租约和 fencing token 处理并发与崩溃恢复。平台还用相同 Git 基线运行单 Agent/多 Agent 对照实验，真实运行确实暴露并推动修复了多个可靠性问题。

被问到新增功能时可以补充：通过 `/goal` 创建目标后，系统保留原始验收条件，在各任务完成后检查整合结果，允许范围内修复，再经过独立审查和人工交付；Token 预算控制后续模型调用。它扩展的是既有 Mission 流程。

## 9. 三分钟讲解顺序

1. **问题**：普通多 Agent Demo 缺少持久化、隔离、证据和恢复。
2. **流程**：Conversation → Planner DAG → approval → Scheduler → Worktree → Evidence → Review → Integration → final delivery；启用 Goal 的任务在交付前增加完整目标终验。
3. **正确性**：PostgreSQL 事实源、事务、租约、fencing、Inbox/Outbox、幂等 Tool。
4. **安全**：没有任意 Shell、精确 argv、路径边界、独立 Reviewer、精确 commit 集成、认证和项目作用域。
5. **验证**：PGlite/PostgreSQL 测试加真实模型 Evaluation，不靠 Mock 宣称成功。
6. **边界**：目前优先支持个人电脑单机操作；尚未宣称是完整公网多租户 SaaS，也没有足够 repetitions 证明多 Agent 更优。

## 10. 高频面试问题

### 为什么不用消息队列直接保存任务？

消息队列适合投递，不适合承载完整领域事实和跨实体事务。RunGuild 需要在同一事务中更新 Task、Run、Inbox、Outbox 和审计事件，因此 PostgreSQL 更适合作为事实源；Redis 只降低唤醒延迟。

### 数据库锁和代码锁有什么区别？

代码锁通常只保护单进程内存；数据库事务、行锁、条件更新和唯一约束可以协调多个进程。RunGuild 还加入租约和 fencing token，避免超时旧 Worker 恢复后继续写入。

### Sandbox 和 Worktree 一样吗？

不一样。Worktree 是 Git 文件工作区隔离。Sandbox 是更广义的执行隔离，可限制进程、系统调用、网络、文件和资源。RunGuild 当前是 Worktree 加受限工具边界，不应夸大为完整 OS Sandbox。

### 为什么不能让模型执行 Shell？

Shell 字符串同时包含解析、管道、重定向、变量展开和命令替换，授权边界过宽。精确 argv 配合 `shell=false` 可以审查可执行程序和参数，并减少注入面。

### 多 Agent 一定比单 Agent 好吗？

不一定。多 Agent 增加协调、上下文和 Review 成本，只在分工、独立审查或并行收益大于开销时有价值。RunGuild 的 Evaluation 就是为了测量，而不是预设答案。

### `/goal` 是不是让 Agent 一直工作到成功？

它表示明确创建一个新目标，并保留从计划到终验、反馈修复和人工交付的状态。自动推进受批准范围、依赖、尝试次数、模型循环和预算限制；遇到无法自行解决的阻塞会停下来。它不承诺无限重试或必然成功，也没有替代原有 Mission 模型。

### 如何保证 exactly-once？

分布式系统通常无法对任意外部副作用给出绝对 exactly-once。RunGuild 使用 at-least-once 投递、事务状态机、唯一幂等键和副作用对账，在受控边界实现 effectively-once；不确定时进入可见状态让人处理。

### 如果 Agent 修改了危险文件怎么办？

路径必须位于任务 Worktree，patch 要经过 Git 校验，测试只能使用白名单，commit 会检查危险符号链接，Integration 只接收已审查提交。更高风险场景仍应增加容器或系统 Sandbox。

### PostgreSQL 挂了会怎样？

平台不能继续可靠推进，因为事实源不可用；Worker 应失败或等待，而不是改用 Redis 猜测状态。数据库恢复后，Worker 根据持久化租约、Inbox 和状态机继续运行。

## 11. 现场演示建议

不要直接用一个昂贵、开放式的五十分钟任务开场。准备一个可在几分钟内验证的小任务：

1. 展示协作室的真实消息；
2. 从选中消息发起 Planner，或用 `/goal` 创建独立目标并填写验收条件；
3. 展示 DAG 和人工批准；
4. 在工作台展示 Worker 真实心跳；
5. 展示 Task Worktree、模型调用和 Tool Evidence；
6. 展示不可变 Artifact Version 和独立 Review；
7. 展示 Integration 的精确 commit；
8. 若启用 Goal，展示终验任务对整合结果的检查，再批准最终交付或填写具体退回意见；
9. 在 Trace 中回看整条账本；
10. 最后打开 Evaluation，解释为什么单次结果不能代表统计结论。

演示前检查 API Key、模型名称、仓库 clean 状态、测试白名单和 Token 预算。不要为了演示隐藏失败；选择一个可恢复失败反而更能体现平台价值。

## 12. 如何诚实说明 AI 辅助开发

不要声称所有代码都是手写的。如果项目是在 AI 编程工具持续协作下完成，可以直接说明：

> 这是一个 AI-assisted engineering 项目。我通过持续对话定义产品目标、约束、安全边界和验收方式，并使用 Agent 完成大量实现、测试和文档工作。我的重点不是逐字符手写，而是能否理解架构、审查关键不变量、运行真实链路、发现失败并用证据验证修复。

这种表达的前提是你确实能解释并操作项目。面试前至少做到：

- 能在个人电脑从零启动系统；
- 能画出完整 Mission 流程；
- 能解释 PostgreSQL、Redis、Lease、fencing 和 idempotency；
- 能指出 Worktree 与 Sandbox 的差别；
- 能找到一个状态机、一条 Migration 和一项并发测试；
- 能根据真实 Trace 定位一次失败；
- 能诚实说出目前没有完成或没有统计证明的部分。

## 13. 当前边界和下一步

已有实现与历史运行记录的核心链路包括 Conversation、Planner、DAG、Scheduler、持久化 Agent Runtime、隔离 Worktree、Evidence、Artifact Version、独立 Review、Integration、最终批准、Trace 和 Evaluation。截至 2026-09-26，新增的 `/goal` 入口、终验与反馈、预算控制和目标进度页面已有实现与回归测试，但尚没有完整真实模型端到端运行证据，不能把测试覆盖说成实际交付效果。

仍应继续通过使用验证的部分：

- 在个人电脑上重复运行不同类型的真实 Mission；
- 用真实模型验证包含 Goal 终验、退回修复和预算等待恢复的完整流程；
- 增加足够 repetitions 的单 Agent/多 Agent 对照实验；
- 继续改善成本、恢复提示和操作体验；
- 清理不再使用的前端样例常量；
- 若未来转向公网多用户服务，再补部署、密钥轮换、权限运营和更强 Sandbox。

不要把“主流程已经闭环”说成“没有任何剩余风险”。可靠系统的成熟度来自重复运行、故障注入和可审计证据。

# RunGuild 文档索引与维护规则

RunGuild 的文档分为产品与架构事实、个人操作、验证记录和面试讲解四类。代码和 PostgreSQL 约束是最终执行事实；文档负责解释这些事实，不能用计划中的能力冒充已经实现的能力。

## 文档地图

| 文档 | 主要读者 | 负责回答 |
|---|---|---|
| [../README.md](../README.md) | 所有人 | RunGuild 是什么、当前实现了什么、仓库怎样启动 |
| [PRD.md](PRD.md) | 产品、评审者 | 为什么做、必须满足哪些功能和验收条件，以及新增 Goal 终验与预算的范围 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构与后端开发者 | 组件怎样协作、事实源在哪里、关键不变量是什么 |
| [STATE_MACHINES.md](STATE_MACHINES.md) | 后端与排障人员 | Mission、Task、Run、Review、Worktree 等如何迁移和恢复 |
| [PROTOCOL.md](PROTOCOL.md) | Agent Runtime 与工具开发者 | 消息、工具、Evidence、Artifact、Context、Goal 创建/预算字段和 Evaluation 协议 |
| [USER_GUIDE_ZH.md](USER_GUIDE_ZH.md) | 个人操作者 | 如何安装、每天启动、用普通需求或 /goal 跑 Mission、排错、控制预算和备份 |
| [MIGRATIONS.md](MIGRATIONS.md) | 维护数据库的人 | 0001–0028 分别改变了什么、如何安全执行 Migration |
| [ENVIRONMENT.md](ENVIRONMENT.md) | 换电脑或排查环境的人 | 哪些状态不在 Git、公司 VM 问题与代码问题如何区分 |
| [REAL_EVALUATION_2026-08-31.md](REAL_EVALUATION_2026-08-31.md) | 技术评审与实验复盘 | 第一次真实模型 Evaluation 的冻结输入、结果、缺口和修复 |
| [AUDIT_2026-09-14.md](AUDIT_2026-09-14.md) | 项目收尾与作品集评审 | 当时的实测、独立验收缺口、入口恢复、执行边界与发布门槛 |
| [FIXES_2026-09-16.md](FIXES_2026-09-16.md) | 验收与集成维护者 | 已有证据门禁和集成验证修复的历史记录 |
| [INTERVIEW_GUIDE_ZH.md](INTERVIEW_GUIDE_ZH.md) | 项目讲解者 | 如何解释流程、并发、隔离、安全、恢复、Evaluation 和边界 |
| [BUGFIX_NOTES_2026-09-26.md](BUGFIX_NOTES_2026-09-26.md) | 排障与面试准备 | 已修 Bug 的现象、根因、修复、回归输出与追问；区分开发保护和历史事故 |
| [ENGINEERING_CLOSEOUT_2026-09-26.md](ENGINEERING_CLOSEOUT_2026-09-26.md) | 开发与复现人员 | 固定版本、干净检出回归、真实 Goal 验证及被独立反例推翻的检查结果 |
| [verification/2026-09-26/README.md](verification/2026-09-26/README.md) | 回归与复盘人员 | Goal、PostgreSQL、消息路由各阶段原始测试输出和验证范围 |
| [../apps/web/DESIGN.md](../apps/web/DESIGN.md) | 前端维护者 | 中文操作台的视觉、真实数据和安全交互原则 |

## 阅读顺序

第一次使用：

```text
根 README
  → USER_GUIDE_ZH
  → PRD 的 Golden mission
  → ARCHITECTURE 的组件与执行流
  → STATE_MACHINES
```

准备面试：

```text
INTERVIEW_GUIDE_ZH
  → BUGFIX_NOTES_2026-09-26（Bug 案例与测试证据）
  → REAL_EVALUATION_2026-08-31
  → ARCHITECTURE 的可靠性模型
  → 在源码中找到对应 Repository、Migration 和测试
```

定位运行问题：

```text
USER_GUIDE_ZH 的状态表
  → ENVIRONMENT
  → STATE_MACHINES
  → Web 运行记录和 PostgreSQL 持久事实
```

## 权威边界

- 产品目标与 release acceptance 以 PRD 为准；
- 组件责任和事实源边界以 ARCHITECTURE 为准；
- 合法状态迁移以协议常量、数据库约束和 STATE_MACHINES 的共同描述为准；
- HTTP 路由以 `apps/api/src/app.ts` 为执行事实，README 提供人工索引；
- 环境变量默认值以 `.env.example` 和进程入口代码为执行事实；
- Migration 顺序以 `packages/database/src/migrate.ts` 为执行事实；
- 真实实验结论以带日期的 Evaluation 记录和 PostgreSQL ledger 为准；
- 测试数量不写成永久数字，发布时应记录实际命令和结果。

## 修改代码时同步哪些文档

| 变更类型 | 至少同步 |
|---|---|
| 新增或改变产品能力 | README、PRD |
| 改组件责任、事实源或作用域 | ARCHITECTURE，必要时 PRD |
| 改状态、租约、恢复或门禁 | STATE_MACHINES、ARCHITECTURE、对应测试 |
| 改 Tool、消息、Artifact 或 Agent 协议 | PROTOCOL、ARCHITECTURE |
| 新增数据库结构 | 新 Migration、MIGRATIONS、Migration 测试 |
| 改环境变量、端口或启动命令 | `.env.example`、README、USER_GUIDE_ZH、ENVIRONMENT |
| 改主要 Web 页面或数据来源 | `apps/web/DESIGN.md`、README |
| 完成真实模型实验 | 新建或追加带日期的 Evaluation 记录；不要改写历史结果 |
| 发现特定机器限制 | ENVIRONMENT，写明原因、portable default 和移除条件 |

## 当前文档边界

现有 Mission、协作、评审、集成和 Evaluation 的项目定位保持不变；`/goal`
是新增的 Web 创建入口，终验和 Mission Token 预算是在原执行链上的扩展。
当前 Web 的三种新建入口均开启终验，旧 Mission 和省略该选项的 API 请求保持
原流程。具体行为分别以产品需求、协议、状态机和使用手册的相关章节为准。

带日期的审计、实验、Bug 笔记及原始日志保留当时事实，不用新功能改写旧结果。
例如历史 PostgreSQL 跳过项不代表当前 `npm test` 仍跳过，旧 Evaluation
实验也不代表新增 Goal 终验已完成真实模型端到端验证；新增 Goal 的独立实跑及后续反例，以 [2026-09-26 工程收尾记录](ENGINEERING_CLOSEOUT_2026-09-26.md) 为准。

核心 Mission 闭环、个人电脑运行和面试讲解已经有对应文档。仓库目前没有自动生成的 OpenAPI 文档，README 中的路由表仍需要随 API 手工同步。如果将来 API 被外部客户端正式使用，应从路由 Schema 生成机器可校验的 API contract，而不是继续扩大手写列表。

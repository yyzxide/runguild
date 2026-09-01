# RunGuild 文档索引与维护规则

RunGuild 的文档分为产品与架构事实、个人操作、验证记录和面试讲解四类。代码和 PostgreSQL 约束是最终执行事实；文档负责解释这些事实，不能用计划中的能力冒充已经实现的能力。

## 文档地图

| 文档 | 主要读者 | 负责回答 |
|---|---|---|
| [../README.md](../README.md) | 所有人 | RunGuild 是什么、当前实现了什么、仓库怎样启动 |
| [PRD.md](PRD.md) | 产品、评审者 | 为什么做、必须满足哪些功能和验收条件 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构与后端开发者 | 组件怎样协作、事实源在哪里、关键不变量是什么 |
| [STATE_MACHINES.md](STATE_MACHINES.md) | 后端与排障人员 | Mission、Task、Run、Review、Worktree 等如何迁移和恢复 |
| [PROTOCOL.md](PROTOCOL.md) | Agent Runtime 与工具开发者 | 消息、工具、Evidence、Artifact、Context 和 Evaluation 协议 |
| [USER_GUIDE_ZH.md](USER_GUIDE_ZH.md) | 个人操作者 | 如何安装、每天启动、跑 Mission、排错、控制成本和备份 |
| [MIGRATIONS.md](MIGRATIONS.md) | 维护数据库的人 | 0001–0021 分别改变了什么、如何安全执行 Migration |
| [ENVIRONMENT.md](ENVIRONMENT.md) | 换电脑或排查环境的人 | 哪些状态不在 Git、公司 VM 问题与代码问题如何区分 |
| [REAL_EVALUATION_2026-08-31.md](REAL_EVALUATION_2026-08-31.md) | 技术评审与实验复盘 | 第一次真实模型 Evaluation 的冻结输入、结果、缺口和修复 |
| [INTERVIEW_GUIDE_ZH.md](INTERVIEW_GUIDE_ZH.md) | 项目讲解者 | 如何解释流程、并发、隔离、安全、恢复、Evaluation 和边界 |
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

核心 Mission 闭环、个人电脑运行和面试讲解已经有对应文档。仓库目前没有自动生成的 OpenAPI 文档，README 中的路由表仍需要随 API 手工同步。如果将来 API 被外部客户端正式使用，应从路由 Schema 生成机器可校验的 API contract，而不是继续扩大手写列表。


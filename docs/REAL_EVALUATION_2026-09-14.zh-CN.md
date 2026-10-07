# 证据级真实模型评测 — 2026-09-14

[English](REAL_EVALUATION_2026-09-14.md) ·
[机器可读证据](evidence/README.md)

本次评测使用真实模型验证 RunGuild 的完整执行链路。它是一组有界工程样本，不是
宣称某种编排策略普遍更优的 Benchmark。

## 冻结实验设计

三个无外部依赖的 Fixture 仓库都从干净的 `main` 开始。公开 Smoke Test 在基线通过，
受保护 Acceptance Test 则会在需求实现前有意失败：

1. `local-bug`：修复单模块内的归一化与校验；
2. `api-implementation`：实现具有确定性 ID 和稳定校验错误的接口，同时保持旧路由；
3. `cross-module`：让失败预算穿过配置解析与运行报告两个模块。

每类任务从同一个冻结基线进行三组配对重复：

- `single_agent`：一个 Builder 负责分析、实现、验证、Commit、Artifact 提交与显式完成；
- `multi_agent`：一个 Researcher 先冻结基于源码的 Artifact，下游 Builder 再执行相同的
  实现与交付流程。

两种策略都经过独立 Reviewer Agent、每 Trial 隔离 Git Ref、受保护验收路径、
Bubblewrap 测试、精确 argv 白名单、绑定干净 Git HEAD 的 Evidence 与 Integration。
总计运行 18 个 Trial。

请求模型为 `deepseek-v4-flash`。所有账本记录的响应都由
`https://api.deepseek.com/responses` 返回 `deepseek-flash`。证据不会保存模型请求/
响应正文或 API Key。

## 结果

18 个 Trial 全部成功完成。

| 任务 | 单 Agent 成功 | 多 Agent 成功 | 单 Agent 平均耗时 | 多 Agent 平均耗时 | 单 Agent 平均输入 Token | 多 Agent 平均输入 Token |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 局部 Bug | 3/3 | 3/3 | 219.686 s | 219.188 s | 498,535 | 658,548 |
| 接口实现 | 3/3 | 3/3 | 89.306 s | 82.784 s | 107,999 | 213,782 |
| 跨模块修改 | 3/3 | 3/3 | 129.171 s | 138.432 s | 130,096 | 371,149 |
| **三类合计** | **9/9** | **9/9** | **146.054 s** | **146.801 s** | **245,543** | **414,493** |

按每种策略的九次运行汇总：

| 指标 | 单 Agent | 多 Agent |
| --- | ---: | ---: |
| 成功 Trial | 9 | 9 |
| 模型调用 | 174 | 294 |
| 输入 Token | 2,209,888 | 3,730,438 |
| 缓存输入 Token | 1,500,288 | 2,808,832 |
| 输出 Token | 47,614 | 86,880 |
| Tool 调用 | 222 | 397 |
| Tool 失败 | 6 | 20 |
| 发生压缩的 Context | 17 | 23 |

多 Agent 的平均输入 Token 多约 68.8%，模型调用多约 69.0%；总体平均耗时仅慢
0.747 秒。不同任务族的耗时差方向并不一致，所以这些数据不支持“多 Agent 普遍
更快”的结论。本样本中两种策略成功率相同。

供应商没有为该别名提供可用价格。RunGuild 因此保留
`estimatedCostUsd=null`，报告成本覆盖不完整，而不是伪造 0 成本或成本差。
每类三组配对达到仓库定义的“可重复工程证据”门槛，但不代表统计显著。

## 完整性检查

- 每个导出都记录干净且精确的 RunGuild Harness Commit 与目标基线；
- 评测后，三个目标仓库签出的 `main` 仍停留在各自冻结基线；
- 六个 `local-bug` Trial Ref 只修改 `src/tags.mjs`；
- 六个 `api-implementation` Trial Ref 只修改 `src/router.mjs`；
- 六个 `cross-module` Trial Ref 只修改 `src/config.mjs` 和 `src/report.mjs`；
- 18 个 Trial Ref 上的 `test/acceptance.test.mjs` 均逐字节保持不变；
- Trial 指标合并普通执行 Agent 与独立 Reviewer 的使用量，每组都记录 Provider、
  请求模型、精确 Endpoint、返回模型和调用次数；
- 已用本地配置的 API Key 逐份检查导出，证据中不存在该 Key 或 Authorization Header。

## 真实安全拒绝探针

另一个单 Trial 实验明确要求真实模型对受保护的
`test/acceptance.test.mjs` 尝试一次无害 Patch。RunGuild 记录了失败的
`file.patch`、安全目标路径和固定策略分类 `protected_path_denied`，但没有导出
Patch 或错误正文。随后同一 Trial 只修改 `src/tags.mjs`，通过干净 HEAD 测试与
独立 Review 并完成隔离集成；受保护文件和目标 `main` 始终未改变。

这证明模型指令不能绕过 Tool Gateway 的确定性路径策略，并且 Agent 能在被拒绝后
继续完成正确任务。

## 由真实失败驱动的平台修复

较早一次基于 `e18493b` 的真实实验没有被包装成可发表的对照证据，而是暴露了三个
活性问题：

1. 单进程串行 Agent Worker 会收到多个 Pending Dispatch，排队租约可能在执行前过期；
2. 无人值守 Evaluation 会把 `waiting_human` 永久视作活动状态；
3. Scheduler 恢复可能在模型响应期间把 Run 置为终态，而 Runtime 仍准备使用旧上下文
   执行返回的 Tool Call。

`98d24b6` 为每个 Agent 增加“最多一个待处理工作项”背压，让自主 Trial 将
`waiting_human` 收集为终态失败，并在任何 Tool 副作用前重新加载持久 Run 状态。
失败 Experiment 被保留为历史；修复后的 18 个 Trial 均未再出现这些活性故障。

## 复现材料

- [证据索引与 SHA-256](evidence/README.md)
- [真实评测运行手册](LIVE_EVALUATION_RUNBOOK_ZH.md)
- [`local-bug` 原始导出](evidence/2026-09-14-local-bug-deepseek-flash.json)
- [`api-implementation` 原始导出](evidence/2026-09-14-api-implementation-deepseek-flash.json)
- [`cross-module` 原始导出](evidence/2026-09-14-cross-module-deepseek-flash.json)
- [受保护路径探针原始导出](evidence/2026-09-14-protected-path-probe-deepseek-flash.json)

## 明确不声称

- 不声称多 Agent 普遍更快、更便宜或成功率更高；
- 不声称 Reviewer 模型批准可以代替受保护可执行测试；
- Bubblewrap 与资源限制是明确声明的 Linux 边界，不是任意恶意代码安全认证；
- 不声称达到生产规模 SaaS、公网多租户加固或统计显著 Benchmark。

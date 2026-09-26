# 真实 Goal 实跑证据

运行日期：2026-09-26。解释、源码提交及复现命令见[工程收尾记录](../../../ENGINEERING_CLOSEOUT_2026-09-26.md)。以下均来自隔离 PostgreSQL/Redis、正式 API/Worker 与真实模型；没有浏览器操作录像，也不是性能对比实验。

| 轮次 | 摘要 | 结果解释 | 完整记录 |
|---|---|---|---|
| 01 | [summary](attempt-01-summary.json)、[events](attempt-01-events.json) | 50 万 Token 软限额用尽，脚本停止；终验未完成 | [trace.tar.gz](attempt-01-trace.tar.gz) |
| 02 | [summary](attempt-02-summary.json)、[events](attempt-02-events.json) | 原检查通过；后续独立反例发现功能缺陷，原 `passed` 保留且不解释成全部条件满足 | [trace.tar.gz](attempt-02-trace.tar.gz) |
| 03 | [summary](attempt-03-summary.json)、[events](attempt-03-events.json) | 加强后的功能检查通过；研究文字仍有错误，见人工勘误 | [trace.tar.gz](attempt-03-trace.tar.gz) |

压缩包原样保存该轮脚本输出目录：输入契约、源码文件哈希、规划、Mission/Task/Run、模型账本、工具与事件、Evidence、Review、Artifact、批准和进程退出记录，以及目标 Git bundle。它们是脱敏 JSON 快照，不是可直接恢复的 PostgreSQL 数据库备份。`source-files.json` 的哈希可帮助区分实跑所用源码；`source.dirty=false` 是每轮启动时事实。

## 反例与最终复核

- 第二轮：[原 8 组 oracle](host-oracle.json)、[原 13 项测试](target-tests.txt)、[目标 diff](attempt-02-target.diff)、[独立复核](attempt-02-independent-review.json)。没有轮次前缀的 `host-oracle.json`、`target-tests.txt`、`target.bundle`、`contract.json` 都属于第二轮，不是最新结果。
- 推翻第二轮完整性结论的[输入状态](attempt-02-counterexamples.json)、[断言失败](attempt-02-counterexample-failure.txt)和[强化后 oracle 失败](attempt-02-stronger-oracle.json)；[前后对比](oracle-strengthening-comparison.json)还确认第一轮的自身属性实现通过新增检查。
- 第三轮：[9 组 oracle](attempt-03-host-oracle.json)、[16 项测试](attempt-03-target-tests.txt)、[输入契约](attempt-03-contract.json)、[目标 diff](attempt-03-target.diff)、[最终独立复核](attempt-03-independent-review.json)、[研究说明人工勘误](attempt-03-notes-errata.md)。

最终复核不修改模型生成的目标仓库，也不回写之前的摘要。第三轮确认函数在列明输入范围内正确，不支持“所有生成内容正确”的结论。

## 检查完整性与恢复目标代码

[SHA256SUMS](SHA256SUMS)覆盖本目录的证据文件与压缩包，不包含此索引和校验文件自身。校验只证明保存内容未变化：

```bash
cd docs/verification/2026-09-26/goal-smoke
sha256sum -c SHA256SUMS
```

第三轮 [Git bundle](attempt-03-target.bundle)包含基线和实际生成提交；目标工程无依赖，不需要 `npm install`。从 RunGuild 根目录使用一个不存在的新目录：

```bash
git clone docs/verification/2026-09-26/goal-smoke/attempt-03-target.bundle /tmp/runguild-goal-result
git -C /tmp/runguild-goal-result switch --detach eb789a00bcc066c0cd6b03e8ee5240c36f79e9b6
npm --prefix /tmp/runguild-goal-result test
```

这里重跑的是已经生成的代码，不调用模型。若要重新执行完整 Goal，请使用工程收尾记录中的命令；模型输出并不保证逐字一致。

# 2026-09-26 Bug 修复验证输出归档

这些文件是本次对话各阶段测试输出的原样副本，归档前保存在 `/tmp`。使用 `.txt` 后缀使其不会被仓库的 `*.log` 忽略规则排除。测试名称、数量、耗时、构建提示和失败堆栈均保留；耗时不是性能基准。

返回 [Bug 修复与开发复盘记录](../../BUGFIX_NOTES_2026-09-26.md)。

## 运行记录

| 输出 | 阶段 | 实际命令 | 当次结果 |
|---|---|---|---|
| [cross-task-before.txt](cross-task-before.txt) | 跨任务回归，修复前旧 dist | `node packages/database/test/conversation-repository.pglite.test.mjs` | 5 项：4 通过、1 失败、0 跳过 |
| [cross-task-after.txt](cross-task-after.txt) | 跨任务回归，修复后新 dist | `node packages/database/test/conversation-repository.pglite.test.mjs` | 6 项：6 通过、0 失败、0 跳过 |
| [full-suite-before-postgres-fix.txt](full-suite-before-postgres-fix.txt) | Goal 第二阶段完成，PostgreSQL 修复前 | `npm test` | 264 项：263 通过、0 失败、1 跳过 |
| [postgres-integration.txt](postgres-integration.txt) | PostgreSQL 17 专项，测试入口修复后 | `npm run test:integration` | 9 项：9 通过、0 失败、0 跳过 |
| [full-suite-after-postgres.txt](full-suite-after-postgres.txt) | PostgreSQL 测试入口修复后全量 | `npm test` | 271 项：271 通过、0 失败、0 跳过 |
| [full-suite-after-routing.txt](full-suite-after-routing.txt) | 跨任务路由修复后最新全量 | `npm test` | 275 项：275 通过、0 失败、0 跳过 |

`cross-task-before.txt` 使用尚未重新构建的旧编译产物，断言命中“实际 deliveredAgentIds 为空”。重新构建后，增加了来源校验组合用例，因此修复前为 5 项、修复后为 6 项。没有通过修改期望值让失败用例通过。

完整测试输出对应当时的未提交工作区，不是仅凭基线 Git SHA 即可重建的发布版本。归档只保存已有输出；本次整理文档没有再次运行这些命令。旧的 1 项跳过记录保留用于说明验证盲区，最新全量记录已经没有跳过。

PostgreSQL 专项和修复后的完整测试使用自动清理的临时 PostgreSQL 17 容器。其余用例仍包含 PGlite、模拟模型/API 和临时 Git 仓库；这不是全部用例都访问真实 PostgreSQL，更不是实模型多 Agent 端到端成功记录。

## 文件完整性

SHA-256 用于检查后续复制是否改变输出内容，不用于证明业务行为正确。

| 文件 | SHA-256 |
|---|---|
| `cross-task-before.txt` | `03772de446496cc37a3a0cadd065a1d1b29c8187425fe3bcca92638bf6614745` |
| `cross-task-after.txt` | `8ca049ad887503f776b844dc40172faabbaf781fbb7ae2302551def53edb9d0c` |
| `full-suite-before-postgres-fix.txt` | `c8386c9328087624a60205f3c5e03016b5828b236db0f19a877f26a2a7713f8b` |
| `postgres-integration.txt` | `31331b1e58a49c7530979db396d90f584dc8a3b175b1653d3a167a5e4f165b0c` |
| `full-suite-after-postgres.txt` | `6c109e9cda2cbf75c33bdad8825bc7422c7a54fbb996dcfc94cde0bfbfd29545` |
| `full-suite-after-routing.txt` | `f464aa058d4d07c4d692f50baad6298c1a0455f2792887b19938b42c3ce6bcf5` |

## 工程收尾追加：Integration 配置传递

`node apps/api/test/local-worker-supervisor.test.mjs` 对新增配置回归的原始输出：

| 文件 | 结果 | SHA-256 |
|---|---|---|
| [integration-env-before.txt](integration-env-before.txt) | 旧 dist，8 通过、1 失败、0 跳过 | `85f5c95ae728a5f3c1b58363e37d236e86f1970344099a2eef56c1112b1e325e` |
| [integration-env-after.txt](integration-env-after.txt) | 修复后先 `npm run typecheck`，9 通过、0 失败、0 跳过 | `9560a822e02b6e759a38e81d0986bd32897b2d95dfe519378bf2833d7663ec83` |

这是子进程环境传递回归，不是一次完整真实模型运行；详见 [B08](../../BUGFIX_NOTES_2026-09-26.md#b08构建任务按项目配置测试集成却用了默认命令)。前述六份历史输出保持原样。

## 固定版本的干净检出回归

源码提交 `4ccc68a`，分支 `codex/goal-closeout-20260926`。从本地仓库 clone 到新目录 `/tmp/runguild-closeout-clean-W7mpp0`，没有复制 `.env`、`node_modules` 或 `dist`；执行 `npm ci --prefer-offline --no-audit --no-fund`，再清除 `DATABASE_URL`、`TEST_DATABASE_URL` 和 `OPENAI_API_KEY` 环境变量执行 `npm test`。Node 为 24.15.0，npm 为 11.12.1。

| 文件 | 结果 | SHA-256 |
|---|---|---|
| [clean-install.txt](clean-install.txt) | 按 lock 安装 172 个包成功 | `548efe55b9c817e64e6c979257aa970079614aa5a1d52d578e7d5c7c44c2a6a0` |
| [clean-full-suite.txt](clean-full-suite.txt) | 构建成功，276 通过、0 失败、0 跳过；包含临时 PostgreSQL 17 集成套件 | `78f8fb43e25a28eb39c174bc826fa4c0117f59219c1ce242540ba3569f72fcc2` |

测试阶段约 199 秒，不是性能指标。构建保留已有的包体积与无效动态导入提示，未影响退出码。上述提交包含 B08 回归，比前一份 275 项记录多一项。后续提交 `ddcd95a` 仅添加真实模型验证入口 `scripts/goal-smoke.mjs`，没有改变业务源代码或本次测试用例。

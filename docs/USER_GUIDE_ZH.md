# RunGuild 个人电脑使用手册

本文面向在一台个人电脑上长期运行、测试和排查 RunGuild 的操作者。这里的目标不是公网部署，而是保留真实 PostgreSQL 账本、真实 Git Worktree 和真实模型调用的完整本地环境。

## 1. 本地运行结构

```text
浏览器 http://127.0.0.1:4173
  └─ Vite Web（把 /api 和 /health 代理到 4000）
       └─ RunGuild API :4000
            ├─ PostgreSQL :5432：持久化事实源
            ├─ Redis :6379：唤醒和跨实例通知，不是事实源
            └─ API 启动的本地 Worker 子进程
                 ├─ Scheduler
                 ├─ Planner / Researcher / Builder / Reviewer Agent Worker
                 ├─ Integration Worker
                 └─ Evaluation Worker
```

个人电脑模式推荐设置 `ENABLE_LOCAL_RUNTIME_CONTROL=true`，然后在 Web 的“配置与启停”中管理 Worker。不要同时从终端和 Web 启动同一个 Agent。

## 2. 前置软件

- Node.js 22 或更新版本；
- npm；
- 普通 Docker Engine 和 Docker Compose；
- Git；
- 可用的 OpenAI API 或 OpenAI-compatible 模型端点。

检查版本：

```bash
node --version
npm --version
docker --version
docker compose version
git --version
```

## 3. 第一次安装

### 3.1 安装依赖并创建本地配置

```bash
cd ~/runguild
npm ci
cp .env.example .env
```

`.env` 不会进入 Git。个人电脑至少需要检查这些字段：

```env
POSTGRES_PORT=5432
REDIS_PORT=6379
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control
REDIS_URL=redis://localhost:6379
PORT=4000
HOST=127.0.0.1

AUTO_MIGRATE=true
ENABLE_DEV_BOOTSTRAP=true
ENABLE_LOCAL_RUNTIME_CONTROL=true

AUTH_MODE=local
AUTH_DEFAULT_WORKSPACE_ID=demo_workspace
LOCAL_AUTH_USER_ID=demo_user
AUTH_ALLOWED_ORIGINS=http://127.0.0.1:4173,http://localhost:4173
AUTH_COOKIE_SECURE=false

MODEL_PROVIDER=openai
MODEL_NAME=你的默认模型
OPENAI_API_KEY=你的密钥
OPENAI_BASE_URL=兼容端点地址（使用官方 OpenAI 时可留空）
```

`MODEL_NAME` 只负责给首次开发初始化提供默认值。项目已经存在后，应在 Web 的“配置与启停”中保存每个 Agent 的模型；修改 `.env` 不会悄悄重写已有项目配置，也不会改变已经冻结的 Run。

如果本机已经占用 6379，可同时改成：

```env
REDIS_PORT=6380
REDIS_URL=redis://localhost:6380
```

### 3.2 启动 PostgreSQL 和 Redis

```bash
docker compose up -d postgres redis
docker compose ps
```

等待两个服务进入 healthy。进一步检查：

```bash
docker compose exec postgres pg_isready -U mission -d mission_control
docker compose exec redis redis-cli ping
```

Redis 应返回 `PONG`。

### 3.3 构建和迁移数据库

```bash
npm run build
node --env-file=.env packages/database/dist/cli.js
```

迁移可重复执行；已经应用的 Migration 不会重复修改数据库。各 Migration 的用途见 [MIGRATIONS.md](MIGRATIONS.md)。

### 3.4 首次创建本地工作区

启动 API：

```bash
npm run api:local
```

默认 `AUTH_MODE=local` 只允许 API 监听 Loopback。首次打开 Web 时，它会自动建立本地 Session；若默认记录尚不存在且 `ENABLE_DEV_BOOTSTRAP=true`，还会先幂等创建：

- Workspace：`demo_workspace`
- Project：`demo_project`
- User：`demo_user`
- Planner、Researcher、Builder、Reviewer Agent
- 项目团队协作室

本地模式不需要设置密码，也不会把安全边界取消：API 仍签发可撤销的 HttpOnly Cookie Session，并继续执行工作区范围、Origin 和 CSRF 校验。自动会话只接受直接来自 `127.0.0.1` 或 `::1` 且没有转发头的请求。

若要部署给多人使用，改为：

```env
AUTH_MODE=team
AUTH_DEFAULT_WORKSPACE_ID=demo_workspace
HOST=0.0.0.0
```

然后为已有用户设置登录密码：

```bash
npm run auth:set-password -- \
  --workspace demo_workspace \
  --user demo_user \
  --role owner
```

密码输入不会回显。生产环境会拒绝 `AUTH_MODE=local`，且必须设置精确的 Web Origin 和安全 Cookie。完成初始化后可把 `.env` 中的 `ENABLE_DEV_BOOTSTRAP` 改为 `false`，再重启 API；这不会删除已有数据。

### 3.5 启动 Web 并选择工作区

另开终端：

```bash
cd ~/runguild
npm run web:start
```

打开 `http://127.0.0.1:4173`。本地模式会直接显示工作区列表；选择“RunGuild 演示项目”即可进入其团队协作室。界面中的“工作区”对应后端 Project（一个仓库和一支 Agent 团队），后端 Workspace 仅作为租户与权限边界，不向普通用户展示 ID。团队模式只输入用户名和密码，租户范围由服务器配置决定。

### 3.6 演示多用户协作

先保持 `AUTH_MODE=local`，进入工作区左侧的“成员”页面。当前本地账号是
Owner，可以直接创建另一个账号并选择工作区角色：

- **Owner**：管理成员，并执行 Operator 的全部操作；
- **Operator**：发起 Mission、参与协作并控制运行；
- **Viewer**：只读查看协作、产物和运行记录。

成员是明确的 Project 级关系：账号只会在启动页看到自己加入的工作区，不能
通过修改浏览器路径读取其他 Project。添加成员会把该用户同步加入当前项目的
团队协作室；改角色或移除成员会让该用户的现有登录立即失效。系统拒绝降级或
移除最后一位 Owner。

创建第二个账号后，为本地 Owner 设置密码：

```bash
npm run auth:set-password -- \
  --workspace demo_workspace \
  --user demo_user \
  --role owner
```

再把 `.env` 改为 `AUTH_MODE=team` 并重启 API。用普通窗口登录
`demo_user`，用无痕窗口或另一个浏览器登录新账号，即可同时打开同一团队协作
室验证消息、Mission 和 Artifact 的共享状态。若只在同一台电脑演示，`HOST`
可继续使用 `127.0.0.1`；只有从另一台设备访问时才需要单独配置监听地址、Web
可访问地址、精确 Origin 和 HTTPS Cookie。

### 3.7 创建第二个工作区

回到工作区列表，点击“建立新的 Agent 团队”。表单只要求：

1. 工作区名称；
2. API 所在机器上的代码仓库绝对路径，可留空稍后配置；
3. 默认 Git 分支，默认是 `main`。

创建成功后会直接进入新的团队协作室。后端会在同一个 PostgreSQL 事务中创建
Project、创建者 Owner 成员关系、默认运行配置、Planner/Researcher/Builder/
Reviewer 和协作室；任何一步失败都会整体回滚。浏览器不会提交租户 ID、用户
ID、Project ID、Agent ID 或 Conversation ID。

若创建时留空仓库路径，进入工作台后打开“配置与启停”，再补充仓库路径、
Worktree 根目录、准备命令和测试白名单。创建工作区不会自动启动 Worker，也
不会扫描或修改填写的仓库。

## 4. 第一次进入 Web 后的项目配置

打开工作台的“配置与启停”，逐项保存：

1. **代码仓库路径**：RunGuild 要操作的真实 Git 仓库绝对路径；测试 RunGuild 自身时可填写当前 RunGuild 仓库。
2. **Worktree 根目录**：必须与仓库目录不同，例如 `~/runguild-worktrees`。
3. **默认分支**：通常是 `main`。
4. **Worktree 准备命令**：新 Worktree 没有 `node_modules`，Node 项目通常需要一个经过审查的精确 argv，例如 `npm ci --ignore-scripts --no-audit --no-fund`。
5. **测试白名单**：每项都是精确 argv，不是 Shell 文本，例如 `npm run typecheck`、`npm test`。
6. **模型配置**：逐个确认 Planner、Researcher、Builder、Reviewer 的提供商和模型名称。
7. **Token 和超时**：先保留默认值，真实运行暴露问题后再调整。

API Key 只来自 API 进程环境，不进入 PostgreSQL，也不会返回浏览器。

## 5. 每天启动与关闭

### 5.1 每天启动

终端一：

```bash
cd ~/runguild
docker compose up -d postgres redis
npm run api:local
```

终端二：

```bash
cd ~/runguild
npm run web:start
```

登录后从“配置与启停”启动需要的 Worker。普通 Mission 至少需要：

- Scheduler；
- Planner Agent；
- DAG 中所需角色的 Agent Worker；
- Reviewer Agent；
- 有代码提交时需要 Integration Worker。

只有运行 Evaluation 实验时才需要 Evaluation Worker。

### 5.2 正常关闭

先在 Web 停止由当前 API 启动的 Worker，然后在两个终端按 `Ctrl+C` 停止 Web 和 API。最后可执行：

```bash
docker compose stop
```

不要把下面命令当作日常关闭命令：

```bash
docker compose down -v
```

`-v` 会删除 PostgreSQL 和 Redis 命名卷。PostgreSQL 是 Mission、Run、Evidence、Artifact、Review 和认证记录的事实源，删除后无法靠 Git 恢复这些执行历史。

## 6. 一次真实 Mission 的完整操作流程

```text
协作室提出需求
  → 选择真实消息并交给 Planner
  → Planner 生成 Mission 和任务 DAG
  → 人工审查并批准计划
  → Scheduler 按依赖分派 Task
  → Agent 在独立 Worktree 中执行
  → 受限工具读取、修改、测试和提交
  → 形成 Evidence 与不可变 Artifact Version
  → 独立 Reviewer 审查精确版本和提交
  → Integration Worker 集成精确已审查提交
  → 所有 Task 完成后等待最终交付批准
  → 人工批准精确 Artifact Version
  → Mission completed
```

### 6.1 在协作室形成需求

不要只写一句模糊目标。消息至少说明：

- 要修改的真实仓库和业务目标；
- 不允许改变的边界；
- 可验证的验收条件；
- 应运行的测试；
- 成本或时间限制。

选择一到五十条真实消息，发起 Planning Request。Planner 的输出仍然只是“待批准计划”，不会自动开工。

### 6.2 审查并批准 DAG

检查：

- Task 是否能映射到真实角色；
- 依赖方向是否正确；
- Builder 是否在必要研究完成后运行；
- Reviewer 是否与 Builder 独立；
- 每个 Task 是否有具体 acceptance criteria 和 Evidence 要求。

计划获批后，Scheduler 才能调度。

### 6.3 观察 Agent 执行

在工作台检查 Worker 心跳，在 Mission 页面检查依赖和 Task 状态，在运行记录中检查模型调用、工具调用、失败和恢复。

`Agent active` 只表示 Agent 配置启用，不表示 Worker 在线。真正的进程状态来自持久化 Worker 心跳。

### 6.4 Review、Integration 与最终批准

模型不能直接把 Task 宣布为完成。代码 Task 必须满足：

- Worktree 中形成精确 Git commit；
- 必需测试产生 Evidence；
- Artifact Version 已冻结；
- Reviewer 审查的是该精确版本和提交；
- Integration Worker 只集成已审查的 commit。

即使所有 Task 已集成，Mission 仍可能停在 `reviewing`。这通常是在等待 Workspace 人工批准最终 Artifact Version，不是 Integration 失败。

## 7. 状态判断与人工处理

| 现象 | 先检查 | 常见处理 |
|---|---|---|
| API 离线 | API 终端、`/health`、PostgreSQL | 重启 API，确认 `DATABASE_URL` |
| Worker 未启动 | 配置与启停中的缺失项 | 保存仓库、Worktree、模型和命令配置后启动 |
| Worker 心跳失联 | Worker 终端或 API 子进程日志 | 等租约过期后重启；不要并行启动同一 Agent |
| Planner 一直等待 | Planner Worker、Planning Request 状态、模型配置 | 启动 Planner，检查 Key、端点和模型名称 |
| Task 等待依赖 | Mission DAG 上游状态 | 先解决失败或未完成的上游 Task |
| Builder 无法测试 | Worktree setup、测试 argv、超时 | 修正精确 argv；不要开放任意 Shell |
| Review 失败 | Review 材料、Reviewer Worker、运行记录 | 修复证据或使用受审计的 Review retry |
| Integration 冲突 | 已审查 HEAD 与当前 base | 让 Builder 在新 base 上重新修改、测试并审查 |
| Mission 停在 reviewing | 最终交付区域 | 批准显示的精确 Artifact Version |

不要用手工改数据库状态来“修复”运行。优先使用 Web 的控制、重试和批准入口，让干预进入审计记录。

## 8. 成本控制

- 在 Web 中逐个确认 Agent 模型，尤其是 Builder 和 Reviewer；
- 新 Run 会冻结当时的模型配置，修改项目模型不会改变已经开始的 Run；
- 先用边界清楚的小 Mission 验证配置，再运行长任务；
- 避免为了观察 UI 重复创建真实模型 Mission；
- 在 Run Trace 和 Evaluation 中查看真实模型调用数、Token 和失败重试；
- Provider 没有配置价格时，成本字段可以为空，调用数和 Token 账本仍然有效。

## 9. 备份与迁移

源代码和文档由 Git 保存，但 PostgreSQL 数据不在 Git 中。备份执行账本：

```bash
docker compose exec -T postgres \
  pg_dump -U mission -d mission_control -Fc \
  > runguild-mission-control.dump
```

恢复前应先停止 API 和 Worker，并把备份复制到安全位置。个人电脑迁移的完整边界见 [ENVIRONMENT.md](ENVIRONMENT.md)。Redis 不是真实事实源，通常不需要迁移。

## 10. 更新代码后的检查

```bash
cd ~/runguild
npm ci
node --env-file=.env packages/database/dist/cli.js
npm test
```

`npm test` 已包含构建。外部 PostgreSQL 集成测试需要独立、名称以 `_test` 结尾的数据库，不能指向日常使用的 `mission_control`。

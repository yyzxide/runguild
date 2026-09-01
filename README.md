# RunGuild

RunGuild is a verifiable execution platform where humans and
persistent AI agent teams turn conversations into software-engineering
missions, execute dependency-aware task graphs, collaborate on shared
artifacts, and finish through evidence-based review.

This repository is intentionally implemented independently. Cumora is used as
a study reference for durable agent runtime, inbox/wake, typed actions,
coordination, and observability. The product model here is mission-first rather
than conversation-first.

## Golden path

~~~text
Conversation
  -> Mission proposal
  -> approved plan and task DAG
  -> isolated agent runs
  -> collaborative Yjs artifact and code changes
  -> independent review with evidence
  -> human approval
  -> immutable deliverable
~~~

## Core principles

1. PostgreSQL stores facts; Redis and WebSocket only announce facts.
2. Agents are persistent identities, while runs are isolated executions.
3. Prompts guide behavior; transactions enforce coordination correctness.
4. Every side effect goes through a typed, idempotent tool protocol.
5. Model silence is not completion. Completion is explicit and evidence-based.
6. Yjs convergence and immutable artifact versions solve different problems.
7. Every model call, tool call, transition, and cost is traceable.

## Current status

The control-plane foundation is executable:

- Mission creation, plan proposal, human approval, and DAG materialization;
- durable project and group Conversations with explicit human/Agent membership,
  ordered messages, replies, structured Mission/Task/Run/Artifact references,
  mention delivery state, and idempotent REST commands;
- `@Agent` routing that turns a message into a durable Steering request for an
  active Mission Run, or records it for deterministic loading into the Agent's
  next frozen Run context;
- pre-Mission selected-message promotion: a human can freeze one to fifty
  Conversation messages as source facts, atomically create a Mission and
  durable Planner request, and wake the room's active Planner Agent;
- a crash-safe Planner phase with a fenced lease, bounded model retry budget,
  durable prompt/response/usage snapshots, validated structured DAG output,
  idempotent Mission proposal, a room summary, and an explicit human approval
  handoff;
- Agent-native `conversation.reply`, so progress and hand-off requests use the
  same typed Tool Gateway and auditable side-effect protocol as code and
  Artifact changes;
- role-aware scheduling with durable Dispatch Tokens;
- atomic Task claim, Run creation, Lease renewal, and expiry recovery;
- Durable Inbox and optimistic read cursors;
- Transactional Outbox and Redis publisher worker;
- typed events, tools, side effects, Evidence, and Artifact contracts;
- bounded Agent Runtime with explicit completion, hop budgets, Steering, Cancel,
  a durable transcript that survives approval pauses, and a persisted
  repeating discovery-to-implementation gate for Builder Tasks requiring
  `file_diff`, reconstructed from the durable transcript after every patch;
- bounded execution-Agent protocol repair: unknown/temporarily hidden function
  names and structurally invalid argument objects execute no tools, retain their
  provider usage in the LLM ledger, receive at most two durable correction
  prompts, and restart with full transcript replay instead of an unsafe stale
  provider continuation;
- progressive Builder delivery reserves that remove broad search for the last
  eight model hops and freeze file reading/patching for the last six, preserving
  enough bounded calls for verification, commit, Artifact Version, Review
  submission, and explicit completion;
- provider-neutral model adapter and a redacted LLM call, token, latency, and
  cost ledger;
- a production OpenAI Responses adapter with durable response continuation and
  repeated system instructions across continued calls;
- versioned Workspace Skills with human-managed REST APIs, ordered Agent
  assignment, optional version pinning, and exact Skill hashes in prompts;
- Run-scoped freezing of Mission, Task, acceptance criteria, model policy, and
  Skill Versions so a restart cannot silently change execution instructions;
- deterministic per-hop Context Builder with a conservative input-token budget,
  atomic assistant/tool retention, bounded history digests, and explicit
  failure when mandatory instructions cannot fit;
- immutable Context Snapshots containing the exact model-visible view, linked
  by foreign key from the redacted LLM call ledger;
- idempotent Tool Gateway with execution fencing tokens, expiring leases,
  server-owned risk policy, human approval, and ambiguity-safe recovery;
- an Agent Inbox processor that claims Dispatch Tokens, renews Task Leases,
  resumes human/tool waits, and executes durable Runs after a process restart;
- durable Scheduler, Agent, Integration, and Evaluation Worker process sessions
  with periodic heartbeats, graceful-stop records, crash expiry, and database
  fencing that rejects two live processes for the same Agent identity;
- path-isolated `repo.search`, `file.read`, `file.patch`, and exact-allowlist
  `test.run` tools with bounded output and command timeouts;
- durable Tool Evidence, evidence-based completion verification, independent
  review handoff, and transactional dependency unlock;
- Yjs v13 incremental Update persistence with hash deduplication, State Vector
  differential sync, state reconstruction, and transactional Snapshot
  compaction;
- immutable Artifact Versions that bind a canonical ProseMirror JSON projection
  to the exact Yjs binary state and reject later mutation;
- tenant-scoped Artifact command APIs whose user/Agent origins are constructed
  and verified server-side, plus exact-Project list and detail projections that
  reconstruct LIVE Yjs state and immutable Version history;
- a deterministic primary `mission_deliverable` Artifact for every Mission,
  including idempotent repair when an older Mission first freezes a Run
  context; exact Artifact ids and review requirements are frozen into that
  context instead of being guessed by the model;
- persistent Yjs WebSocket rooms with State Vector differential sync,
  persistence-before-broadcast, bounded message queues, heartbeat cleanup, and
  ephemeral Awareness snapshots/removals; every new Update creates a
  transactional Outbox notification, and Redis-connected API instances read
  the exact seq/hash back from PostgreSQL before broadcasting it once to local
  peers; subscriber recovery forces a durable full-state resync; a separate
  ephemeral Redis channel propagates versioned Awareness, probes new rooms,
  republishes heartbeats, and expires stale remote presence;
- Agent-native `artifact.read`, semantic `artifact.edit`, immutable
  `artifact.create_version`, and evidence-bound `artifact.submit_for_review`
  tools;
- exact-version Submission bundles and independent human or authenticated
  Reviewer Agent decisions; code submissions additionally bind the exact
  committed Worktree HEAD into the evidence bundle; every selected Evidence id
  is frozen in `task_submission_evidence`, and an evidence-only retry may reuse
  a prior Task Run's exact-commit Evidence plus a passing `test.run` only when
  that test records the same clean, stable Git HEAD and tree;
- automatic Mission-room Reviewer dispatch through durable Inbox messages and
  a separate `review_executions` lease/model ledger; frozen review input includes
  the exact Artifact Version, acceptance criteria, Evidence, relevant test/tool
  results, and the cumulative base-to-HEAD Git diff. The durable snapshot keeps
  every selected Evidence id, while the bounded model projection emits repeated
  content-addressed payloads once and retains every equivalent id and producer;
- immutable `reviewer_model_calls` rows for every successful or structurally
  invalid Reviewer response, including ordinary/cached Token usage, price when
  available, latency, and attempt identity; Evaluation merges this
  control-plane usage with ordinary Agent `llm_calls` instead of silently
  undercounting Review;
  Planner/Reviewer control-plane calls require one non-parallel structured Tool
  Call and explicitly disable reasoning for compatible endpoints whose Thinking
  mode rejects required tool choice; execution Agents still inherit their
  configured reasoning effort. Invalid Reviewer responses persist text, Tool Calls, usage, and
  provider request id for diagnosis, and a persisted valid decision resumes
  without a second model call after a process crash;
- deterministic per-Task Git Worktree provisioning with database fencing,
  lease-expiry takeover, restart reconciliation, and strict repository/path/
  branch/ancestry validation;
- project-scoped, exact-argv Worktree preparation that runs after provisioning
  and before the first model call, with a generation/config hash, fenced lease,
  bounded retries, hashed command output, and real status in the Web launch
  manifest;
- Agent-native `repo.status`, bounded `repo.diff`, and idempotent `repo.commit`
  tools that persist exact commit/tree/cumulative-diff Evidence and recover the
  commit-before-evidence crash window; a verified clean baseline is finalized
  without inventing an empty commit, so evidence-only Tasks do not deadlock on
  an unnecessary Integration gate;
- a separate integration worker that admits only approved committed Tasks,
  fast-forwards when possible or creates a hooks-disabled, conflict-free merge
  whose parent is the exact reviewed HEAD; content conflicts leave the base
  unchanged, materialize a pending merge in the isolated Task Worktree, remove
  the deterministically conflicting commit from the Integration queue, and
  supersede its approval so Builder tests, Artifact evidence, and independent
  Review must run again against the current base; successful integration
  completes the existing Task gate and safely removes integrated Worktrees and
  branches;
- immutable Evaluation Scenario Versions with a frozen Git baseline, paired
  single-Agent/multi-Agent plans, deterministic repetitions, and human-managed
  REST APIs;
- a crash-safe Evaluation Worker that materializes ordinary Missions under
  fencing leases, recovers partial creation, and derives Trial results from the
  real Run/LLM/Tool/Review/Context ledgers;
- isolated per-Trial Git refs initialized at the frozen baseline, allowing
  tasks inside one Trial to integrate sequentially without contaminating the
  project branch or another Trial;
- aggregate and paired reports for success, wall time, estimated cost, tokens,
  rework, Tool failures, review churn, and context compaction;
- a completed real-model paired system run, documented in
  [`docs/REAL_EVALUATION_2026-08-31.md`](docs/REAL_EVALUATION_2026-08-31.md),
  which preserved isolated Trial refs and exposed concrete retry, Review
  assignment, hop-budget, and pricing-ledger gaps instead of hiding them with
  mocks;
- a responsive React operator workspace whose home page derives one next action
  from real API, Workspace, Conversation, Plan, and Mission state; it restores
  the real Project repository/branch, configured Agent models, project-scoped
  active Runs, and recent Mission register, and supports switching a Mission
  directly from the Web;
- production browser identity boundaries backed by PostgreSQL credentials and
  revocable sessions: scrypt password hashes, hashed session/CSRF tokens,
  absolute and idle expiry, credential-version invalidation, database-backed
  login throttling, owner/operator/viewer roles, exact Workspace scope, and an
  append-only authentication event ledger. The Web uses HttpOnly SameSite
  cookies plus Origin/CSRF checks; browser actor headers are ignored. Internal
  Agent HTTP/WebSocket access requires a separate environment-only Bearer
  token;
- an exact-version final-delivery gate: after every Task is complete, a
  Workspace human approves the selected immutable Artifact Version before the
  Mission can move from `reviewing` to `completed`;
- a real Team Room with message selection and Planner-to-Mission progress,
  explicit Agent recipient selection and delivery routing, plus a live Mission
  dependency cockpit; the Trace surface reads the real project-scoped Run
  ledger with redacted/摘要 data, while the Evaluation Lab lists immutable
  Scenario Versions and project-scoped Experiments, creates paired Trials, and
  rebuilds reports from real persisted metrics; the Artifact surface queries
  the Project's real LIVE Yjs state and Version ledger, switches between exact
  immutable slices, and freezes a new Version only from LIVE state;
- PostgreSQL/PGlite migration and orchestration tests.

The local suite covers protocol, migrations, Conversation routing, Mission
orchestration, runtime recovery, tools, Yjs collaboration, review, worktrees,
authentication, and API contracts. The external PostgreSQL integration test
remains opt-in. Reviewer usage accounting, project-scoped Workers, real
Artifact/Evaluation/Trace projections, cross-instance Artifact fan-out, and
persistent browser authentication are implemented. The next priority is to
repeat bounded real-model Missions and paired experiments on a personal
machine, then improve recovery diagnostics, cost observability, and operator
ergonomics from those traces. Public deployment hardening is optional while
RunGuild remains a personal-machine system.

## Repository layout

~~~text
apps/
  api/                 Commands, queries, approvals, and WebSocket gateway
  worker/              Scheduler publisher and durable Agent runtime process
  web/                 Mission, Artifact, Evaluation, and Run Trace workspace
packages/
  protocol/            States, events, commands, tools, and invariants
  database/            Schema and transactional repositories
  agent-runtime/       Bounded model/tool execution loop
  tool-gateway/        Authorization, idempotency, and side effects
  workspace-tools/     Path-scoped repository, patch, and test handlers
  collaboration/       Conversations, Yjs persistence, semantic tools, versions, and review submission
  evaluation/          Paired Trial materialization, collection, and reports

~~~

## Design documents

- [Documentation index and maintenance rules](docs/README.md)
- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [State machines](docs/STATE_MACHINES.md)
- [Protocol contract](docs/PROTOCOL.md)
- [个人电脑使用手册](docs/USER_GUIDE_ZH.md)
- [面试准备与项目讲解](docs/INTERVIEW_GUIDE_ZH.md)
- [Database Migration 清单](docs/MIGRATIONS.md)
- [Environment and machine migration](docs/ENVIRONMENT.md)
- [Real-model Evaluation run](docs/REAL_EVALUATION_2026-08-31.md)
- [Web design direction](apps/web/DESIGN.md)

## Local checks

~~~bash
npm run typecheck
npm test
npm run web:start
~~~

For the first local Web run, start the control plane with the development-only
idempotent bootstrap enabled, then open the Web workspace:

~~~bash
docker compose up -d postgres redis
npm run build
cp .env.example .env
# Edit .env. Set ENABLE_LOCAL_RUNTIME_CONTROL=true to enable Web process
# controls, and set OPENAI_API_KEY before starting an Agent Worker.
npm run api:local
# On a new database, create the development records once while the API runs:
curl -fsS -X POST http://127.0.0.1:4000/api/v1/development/bootstrap \
  -H 'content-type: application/json' -d '{}'
# Set an existing user's password in a second terminal. Input is hidden:
npm run auth:set-password -- --workspace demo_workspace --user demo_user --role owner
npm run web:start
~~~

The Web listens on `http://127.0.0.1:4173`. For the first installation, daily
startup, end-to-end Mission workflow, backup, recovery, and cost-control
checklists, use the [Chinese personal-machine guide](docs/USER_GUIDE_ZH.md).

`ENABLE_DEV_BOOTSTRAP=true` is a local provisioning aid, not a production
identity provider. Disable it after local initialization. The password command
runs migrations, requires the User to exist, never prints the password/hash,
and revokes that User's older sessions whenever the credential changes. For
non-interactive secret injection, pass `--password-stdin`; do not place a real
password in Git. Production must set `AUTH_ALLOWED_ORIGINS` to the exact Web
origin, use HTTPS with `AUTH_COOKIE_SECURE=true`, and serve Web/API through the
same origin. Generate `INTERNAL_AGENT_TOKEN` with at least 32 unpredictable
characters when an Agent needs HTTP or Artifact WebSocket access.

The published database ports are configurable with `POSTGRES_PORT` and
`REDIS_PORT`. If another local Redis already owns port 6379, for example, set
`REDIS_PORT=6380` and `REDIS_URL=redis://localhost:6380` in `.env` before
running Compose. Container-side ports remain the standard 5432 and 6379.

The Web home page is an operator workflow, not a presentation dashboard: check
the API, initialize the local Project once, enter the Team Room, select durable
messages for the Planner, approve the proposed DAG, and then inspect or switch
Missions from the same page. An Agent's `active` status means its configuration
is enabled; Worker online/stale/stopped state comes from separately persisted
process heartbeats. The home page refreshes those heartbeats every five seconds
and turns a missing Scheduler or Agent Worker into the next corrective action.
The **配置与启停** launch manifest persists the Project repository path,
Worktree root, pre-model Worktree setup argv and timeout, exact argv test
allowlist, context/test limits, and per-Agent model selection. Recent setup
attempts come from PostgreSQL and expose running/passed/failed state without
returning raw package-manager output. It can start and stop Scheduler, Agent,
Integration, and Evaluation processes when `ENABLE_LOCAL_RUNTIME_CONTROL=true`. API credentials
remain only in the API process environment: they are never written to the
runtime configuration table and are never returned to the browser. The API can
stop only child processes it launched itself; an externally managed Worker is
shown as external and left untouched.

Scheduler and Evaluation are global control-plane processes: they only claim
durably scoped PostgreSQL rows and may safely serve several Projects. An
Agent selected by Scheduler must be an active member of a Conversation in the
Task's own Project; a same-role Agent from a sibling Project is not eligible. An
Integration Worker is different because its process is bound to one physical
Git repository and Worktree root. Local control therefore keys Integration by
the exact Workspace/Project, injects that scope into the child process, and
shows only that Project's Integration heartbeat. Its database discovery and
cleanup queries cannot return another Project's Worktree.

Agent processes are repository-bound too. Every Agent child receives and
registers the exact `WORKSPACE_ID`/`PROJECT_ID`; Inbox delivery, task claim,
waiting-Run recovery, runnable-Run polling, execution context, and Web heartbeat
projection all verify that scope before repository tools can run. Because the
current durable Inbox cursor and model configuration are keyed by Agent identity,
one Agent identity may belong to only one Project. Startup rejects a shared
cross-Project identity with an explicit error; create a distinct Agent identity
per Project instead. Migration `0020_project_scoped_agent_workers.sql` fences
legacy running Agent rows that lack this scope.

For Web-managed local Workers, the persisted per-Agent model is the source used
when a new Run freezes its execution context. `MODEL_NAME` in `.env` seeds the
development bootstrap only; editing it after the Project already exists does
not rewrite the database configuration. Save the model in **配置与启停** before
dispatching work, and verify the new Run ledger when cost matters. Existing
Runs deliberately retain their frozen model. A directly launched Agent process
may still use an explicit `MODEL_NAME` environment override.

`LocalWorkerSupervisor` enforces a safe startup boundary for local Workers: it
validates the configured Git `repositoryPath` exists and is a directory before
touching the Worktree root; an existing non-directory Worktree root is
rejected; and a missing Worktree root is created with Node's
`fs.mkdir(worktreeRoot, { recursive: true, mode: 0o700 })` without invoking a
shell.

When `OPENAI_BASE_URL` points at an OpenAI-compatible endpoint, Agent Workers
replay the complete durable transcript on every model hop instead of assuming
that endpoint implements stateful `previous_response_id` continuation. The
official OpenAI endpoint keeps the response-id optimization; Tool Calls and
Tool Results remain persisted locally in both modes. Compatible endpoints also
receive one narrowly scoped arguments compatibility pass: literal ASCII control
characters inside a JSON string are escaped before a second strict parse. This
supports multiline patch bodies without accepting missing delimiters, broken
quotes, non-object arguments, or unknown tools; the official endpoint remains
strict-only.

Run the API and scheduler worker:

~~~bash
cp .env.example .env
docker compose up -d postgres redis
npm run build
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control npm run db:migrate
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control REDIS_URL=redis://localhost:6379 npm run api:start
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control REDIS_URL=redis://localhost:6379 npm run worker:start
~~~

Run one Agent execution process after creating an Agent row. The process
provisions the Task Worktree from the Project default branch. Repository and
Worktree roots must be distinct; test commands are exact argument arrays, not
shell text:

~~~bash
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control \
AGENT_ID=agent_builder \
WORKSPACE_ID=demo_workspace \
PROJECT_ID=demo_project \
REPOSITORY_ROOT=/absolute/path/to/source/repository \
WORKTREE_ROOT=/absolute/path/to/task-worktrees \
OPENAI_API_KEY=... \
MODEL_NAME=your-openai-model \
AGENT_CONTEXT_INPUT_TOKENS=65536 \
AGENT_WORKTREE_SETUP_COMMANDS_JSON='[["npm","ci","--ignore-scripts","--no-audit","--no-fund"]]' \
AGENT_WORKTREE_SETUP_TIMEOUT_MS=300000 \
AGENT_TEST_COMMANDS_JSON='[["npm","test"],["npm","run","typecheck"]]' \
npm run agent:start
~~~

Git does not copy ignored dependency directories such as `node_modules` into a
new Worktree. Dependency-bearing projects must configure the separate
pre-model Worktree setup list, for example with one reviewed, exact install argv
such as `["npm","ci","--ignore-scripts","--no-audit","--no-fund"]`. Commands
run sequentially with `shell=false`; the Agent Runtime is not constructed until
all commands pass. Success can be reused only for the same Task Worktree
generation and exact commands hash. Failed and lease-recovered attempts remain
durable, while stdout/stderr are represented only by SHA-256 hashes. Do not link dependency directories
to an absolute path outside the Worktree: `repo.commit` rejects absolute,
external, dangling, and self-referential staged symlinks and restores the index
without deleting the working file.

Run the repository integration and cleanup worker against the same roots:

~~~bash
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control \
WORKSPACE_ID=demo_workspace \
PROJECT_ID=demo_project \
REPOSITORY_ROOT=/absolute/path/to/source/repository \
WORKTREE_ROOT=/absolute/path/to/task-worktrees \
npm run integration:start
~~~

Run the Evaluation Worker after creating a Scenario Version and Experiment
through the REST API. It materializes benchmark Trials as ordinary Missions
and collects terminal metrics from their durable ledgers:

~~~bash
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control \
npm run evaluation:start
~~~

The current runtime deployment invariant is one live Agent process per
`AGENT_ID`, bound to exactly one Workspace/Project. The same Agent identity
cannot be a member of multiple Projects because its Inbox cursor and model
configuration are identity-scoped. Different Agents can run concurrently; the Task Worktree store
fences provisioning, integration, and cleanup across processes. Worker Instance
registration now fences two live processes for the same Agent; an expired
heartbeat is marked stale before a replacement can take ownership. Agent Inbox,
claim, resume, runnable-Run, context, and heartbeat projections all enforce its
registered Project scope. Integration
heartbeats and candidate queries are bound to one exact Workspace/Project, so
different Project repositories can run independent Integration processes while
each process owns mutation of only its configured Git refs. Evaluation Trials use separate
non-checked-out refs and compare-and-swap updates, so they can share the Git
object database without mutating that branch or one another.

Current HTTP and WebSocket endpoints:

~~~text
GET  /health
POST /api/v1/development/bootstrap                 # only when explicitly enabled
POST /api/v1/auth/login
GET  /api/v1/auth/session
POST /api/v1/auth/logout
POST /api/v1/workspaces/:workspaceId/projects/:projectId/missions
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/operator-overview
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/runtime-config
PUT  /api/v1/workspaces/:workspaceId/projects/:projectId/runtime-config
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/run-traces
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/run-traces/:runId
POST /api/v1/workspaces/:workspaceId/projects/:projectId/local-workers/start
POST /api/v1/workspaces/:workspaceId/projects/:projectId/local-workers/stop
POST /api/v1/workspaces/:workspaceId/projects/:projectId/conversations
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/conversations
GET  /api/v1/workspaces/:workspaceId/conversations/:conversationId/messages
POST /api/v1/workspaces/:workspaceId/conversations/:conversationId/messages
POST /api/v1/workspaces/:workspaceId/conversations/:conversationId/planning-requests
GET  /api/v1/workspaces/:workspaceId/conversation-planning-requests/:requestId
POST /api/v1/workspaces/:workspaceId/missions/:missionId/plan
POST /api/v1/workspaces/:workspaceId/missions/:missionId/plan/approve
POST /api/v1/workspaces/:workspaceId/missions/:missionId/delivery/approve
POST /api/v1/workspaces/:workspaceId/reviews/:reviewId/retry
GET  /api/v1/workspaces/:workspaceId/missions/:missionId
POST /api/v1/workspaces/:workspaceId/missions/:missionId/tasks/:taskId/retry
POST /api/v1/workspaces/:workspaceId/runs/:runId/controls
POST /api/v1/workspaces/:workspaceId/tool-approvals/:approvalId/resolve
POST /api/v1/workspaces/:workspaceId/skills
POST /api/v1/workspaces/:workspaceId/skills/:skillId/versions
PUT  /api/v1/workspaces/:workspaceId/agents/:agentId/skills/:skillId
GET  /api/v1/workspaces/:workspaceId/agents/:agentId/skills
POST /api/v1/workspaces/:workspaceId/projects/:projectId/artifacts
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/artifacts
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/artifacts/:artifactId
POST /api/v1/workspaces/:workspaceId/artifacts/:artifactId/updates
GET  /api/v1/workspaces/:workspaceId/artifacts/:artifactId/sync
POST /api/v1/workspaces/:workspaceId/artifacts/:artifactId/versions
GET  /api/v1/workspaces/:workspaceId/artifact-versions/:versionId
WS   /api/v1/workspaces/:workspaceId/artifacts/:artifactId/collaboration
POST /api/v1/workspaces/:workspaceId/missions/:missionId/tasks/:taskId/submissions
POST /api/v1/workspaces/:workspaceId/submissions/:submissionId/review
GET  /api/v1/workspaces/:workspaceId/submissions/:submissionId
POST /api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-scenarios
POST /api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-scenarios/:scenarioId/versions
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-scenario-versions
POST /api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-experiments
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-experiments
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-experiments/:experimentId/report
~~~

Artifact WebSocket authentication uses the same PostgreSQL browser session and
exact allowed Origin as REST; the server owns the Awareness session identity.
Agent connections must send the environment-only Bearer token plus the complete
Agent/Run/Task/Tool/intent origin headers. Plain actor headers without the
Bearer token are not authentication. The header-only adapter remains available
only through an explicit in-process test option and is not enabled by the
server entrypoint.

PostgreSQL integration tests are opt-in:

~~~bash
docker compose up -d postgres
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control npm run db:migrate
docker compose exec postgres createdb -U mission mission_control_test
TEST_DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control_test npm run test:integration
~~~

The external integration suite truncates its fixtures between cases and
therefore refuses to run unless `current_database()` ends in `_test`. Never
point `TEST_DATABASE_URL` at the development or production RunGuild database.

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
  and a durable transcript that survives approval pauses;
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
- tenant-scoped Artifact APIs whose user/Agent origins are constructed and
  verified server-side;
- a deterministic primary `mission_deliverable` Artifact for every Mission,
  including idempotent repair when an older Mission first freezes a Run
  context; exact Artifact ids and review requirements are frozen into that
  context instead of being guessed by the model;
- persistent Yjs WebSocket rooms with State Vector differential sync,
  persistence-before-broadcast, bounded message queues, heartbeat cleanup, and
  ephemeral Awareness snapshots/removals;
- Agent-native `artifact.read`, semantic `artifact.edit`, immutable
  `artifact.create_version`, and evidence-bound `artifact.submit_for_review`
  tools;
- exact-version Submission bundles and independent human or authenticated
  Reviewer Agent decisions; code submissions additionally bind the exact
  committed Worktree HEAD into the evidence bundle;
- automatic Mission-room Reviewer dispatch through durable Inbox messages and
  a separate `review_executions` lease/model ledger; frozen review input includes
  the exact Artifact Version, acceptance criteria, Evidence, relevant test/tool
  results, and the cumulative base-to-HEAD Git diff, while a persisted model
  decision resumes without a second model call after a process crash;
- deterministic per-Task Git Worktree provisioning with database fencing,
  lease-expiry takeover, restart reconciliation, and strict repository/path/
  branch/ancestry validation;
- Agent-native `repo.status`, bounded `repo.diff`, and idempotent `repo.commit`
  tools that persist exact commit/tree/cumulative-diff Evidence and recover the
  commit-before-evidence crash window; a verified clean baseline is finalized
  without inventing an empty commit, so evidence-only Tasks do not deadlock on
  an unnecessary Integration gate;
- a separate integration worker that admits only approved committed Tasks,
  performs clean fast-forward-only integration, completes the existing Task
  gate, and safely removes integrated Worktrees and branches;
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
- a responsive React operator workspace whose home page derives one next action
  from real API, Workspace, Conversation, Plan, and Mission state; it restores
  the real Project repository/branch, configured Agent models, project-scoped
  active Runs, and recent Mission register, and supports switching a Mission
  directly from the Web;
- an exact-version final-delivery gate: after every Task is complete, a
  Workspace human approves the selected immutable Artifact Version before the
  Mission can move from `reviewing` to `completed`;
- a real Team Room with message selection and Planner-to-Mission progress,
  explicit Agent recipient selection and delivery routing, plus a live Mission
  dependency cockpit; Artifact, Evaluation, and Trace surfaces remain secondary
  prototypes until their query APIs replace the current sample projections;
- PostgreSQL/PGlite migration and orchestration tests.

The local suite covers protocol, migrations, Conversation routing, Mission
orchestration, runtime recovery, tools, Yjs collaboration, review, worktrees,
and API contracts. The external PostgreSQL integration test remains opt-in.
The next implementation slices complete production identity, deployment,
horizontal worker fencing, cross-instance collaboration fan-out, and
real-model benchmark runs.

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

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [State machines](docs/STATE_MACHINES.md)
- [Protocol contract](docs/PROTOCOL.md)

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
# in another terminal
npm run web:start
~~~

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
Worktree root, exact argv test allowlist, context/test limits, and per-Agent
model selection. It can start and stop Scheduler, Agent, Integration, and
Evaluation processes when `ENABLE_LOCAL_RUNTIME_CONTROL=true`. API credentials
remain only in the API process environment: they are never written to the
runtime configuration table and are never returned to the browser. The API can
stop only child processes it launched itself; an externally managed Worker is
shown as external and left untouched.

Run the API and scheduler worker:

~~~bash
cp .env.example .env
docker compose up -d postgres redis
npm run build
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control npm run db:migrate
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control npm run api:start
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control REDIS_URL=redis://localhost:6379 npm run worker:start
~~~

Run one Agent execution process after creating an Agent row. The process
provisions the Task Worktree from the Project default branch. Repository and
Worktree roots must be distinct; test commands are exact argument arrays, not
shell text:

~~~bash
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control \
AGENT_ID=agent_builder \
REPOSITORY_ROOT=/absolute/path/to/source/repository \
WORKTREE_ROOT=/absolute/path/to/task-worktrees \
OPENAI_API_KEY=... \
MODEL_NAME=your-openai-model \
AGENT_CONTEXT_INPUT_TOKENS=65536 \
AGENT_TEST_COMMANDS_JSON='[["npm","test"],["npm","run","typecheck"]]' \
npm run agent:start
~~~

Run the repository integration and cleanup worker against the same roots:

~~~bash
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control \
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
`AGENT_ID`. Different Agents can run concurrently; the Task Worktree store
fences provisioning, integration, and cleanup across processes. Worker Instance
registration now fences two live processes for the same Agent; an expired
heartbeat is marked stale before a replacement can take ownership. One
integration worker owns mutation of the
checked-out project branch at a time. Evaluation Trials use separate
non-checked-out refs and compare-and-swap updates, so they can share the Git
object database without mutating that branch or one another.

Current Mission endpoints:

~~~text
POST /api/v1/workspaces/:workspaceId/projects/:projectId/missions
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/operator-overview
GET  /api/v1/workspaces/:workspaceId/projects/:projectId/runtime-config
PUT  /api/v1/workspaces/:workspaceId/projects/:projectId/runtime-config
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
GET  /api/v1/workspaces/:workspaceId/missions/:missionId
POST /api/v1/workspaces/:workspaceId/runs/:runId/controls
POST /api/v1/workspaces/:workspaceId/tool-approvals/:approvalId/resolve
POST /api/v1/workspaces/:workspaceId/skills
POST /api/v1/workspaces/:workspaceId/skills/:skillId/versions
PUT  /api/v1/workspaces/:workspaceId/agents/:agentId/skills/:skillId
GET  /api/v1/workspaces/:workspaceId/agents/:agentId/skills
POST /api/v1/workspaces/:workspaceId/projects/:projectId/artifacts
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
POST /api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-experiments
GET  /api/v1/workspaces/:workspaceId/evaluation-experiments/:experimentId/report
~~~

The current WebSocket authentication adapter mirrors the REST development
identity headers: `x-actor-id` plus `x-session-id` for a user, or the complete
Agent Run/Task/Tool origin headers for an Agent. A production identity-provider
adapter will replace these development headers without changing room or Yjs
semantics.

PostgreSQL integration tests are opt-in:

~~~bash
docker compose up -d postgres
DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control npm run db:migrate
TEST_DATABASE_URL=postgresql://mission:mission@localhost:5432/mission_control npm run test:integration
~~~

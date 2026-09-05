# Architecture

## 1. System shape

The product is separated into four planes:

~~~text
Conversation plane  -> natural discussion, mentions, progress, steering
Execution plane     -> mission, DAG, scheduler, leases, runs, tools
Artifact plane      -> Yjs collaboration, snapshots, immutable versions
Observation plane   -> events, traces, usage, replay, evaluation
~~~

These planes share identifiers and events, but each has one clear source of
truth.

## 2. Components

~~~text
React Web
  |-- Team Room + Agent routing rail
  |-- Mission dependency cockpit + Evidence Spine
  |-- collaborative Artifact and immutable Version surface
  |-- paired Evaluation Lab
  |-- Run trace waterfall
  +-- command palette and responsive application shell
          |
          v
API and WebSocket Gateway
  |-- Command API
  |-- Query API
  |-- Inbox stream
  +-- Yjs sync
          |
          +-------------------- PostgreSQL
          |                       durable facts
          |
          +-------------------- Redis
                                  wake, fan-out, presence
                                          |
                                          v
                                      Scheduler
                                          |
                                          v
                                    Runtime Worker
                                      |-- Model adapter
                                      |-- Tool loop
                                      |-- Steering
                                      +-- Context builder
                                          |
                                          v
                                      Tool Gateway
                                      |-- task
                                      |-- artifact
                                      |-- conversation
                                      |-- repository
                                      +-- shell/test sandbox
                                          ^
                                          |
                                  Evaluation Worker
                                  |-- paired Trial materializer
                                  |-- Mission driver
                                  +-- ledger metric collector
~~~

## 3. Service ownership

### API

Owns synchronous commands, authorization, plan approval, human approval, and
read models. It never runs a long model turn inside an HTTP request.

### Scheduler

Finds runnable work from durable state. Redis wake events reduce latency, but
periodic scanning guarantees eventual progress. It decides what can run, not
what the model should say. The process may serve multiple Projects, but Agent
selection requires active role eligibility plus Conversation membership in the
Task's exact Project; Workspace-level role matching alone is insufficient.

### Worker

Executes one Run at a time, renews its task lease, drains durable inbox input,
invokes the model, executes tools, and writes structured events.

The executable slice currently deploys one process per Agent identity. Each
process receives an exact `WORKSPACE_ID`/`PROJECT_ID`, a bounded
`REPOSITORY_ROOT`, and a distinct `WORKTREE_ROOT`.
It provisions the claimed Task's isolated Worktree before constructing that
Task's Tool Gateway. If the Project declares setup commands, it executes those
exact argv sequentially inside the canonical Worktree and requires the durable
setup gate to pass before constructing the model-backed Runtime. Path resolution
rejects lexical and symlink escapes, and test execution accepts only exact argv allowlist entries. Multiple Agent
identities may run concurrently. Every Scheduler, Agent, Integration, and
Evaluation process registers a durable Worker Instance and renews its expiry.
Agent registration locks the Agent row and rejects a second non-expired process;
after a crash, a replacement marks the expired owner stale before taking over.
Registration also proves that the Agent belongs to exactly the requested
Project and no sibling Project. This is a deliberate current invariant: Inbox
cursors and model configuration are keyed by Agent identity, so sharing that
identity across Projects would make cursor advancement and repository selection
ambiguous. A separate Agent identity is required per Project.
Scheduler and Evaluation are global database control-plane Workers and never
receive repository paths. Integration is repository-bound and must register an
exact Workspace/Project scope. Its discovery and cleanup queries filter on that
scope before the Git manager sees a candidate; separate Projects may therefore
run separate Integration processes without one process opening another
Project's Worktree. Migration `0019_project_scoped_integration_workers.sql`
marks any live legacy unscoped Integration row stale so the old process loses
heartbeat ownership before the scoped replacement starts.
Migration `0020_project_scoped_agent_workers.sql` applies the same fence to
legacy unscoped Agent rows. Agent Inbox reads expose only the safe prefix before
a foreign-Project message and never acknowledge across it; task claim,
waiting-Run resume, runnable-Run polling, loaded execution context, and Web
heartbeat queries independently require the registered Project scope.

### Evaluation Worker

Owns benchmark orchestration, not a second execution engine. It reserves a
Trial with a fencing token, materializes the frozen single-Agent or multi-Agent
plan through the ordinary Mission repository, and later derives metrics from
the same durable ledgers used by production Runs. A deterministic Mission id
makes a crash between Mission creation and Trial attachment recoverable.

### Collaboration service

Owns in-memory Y.Doc rooms, update persistence, cross-instance fan-out,
awareness, snapshot compaction, and immutable version creation.

The executable service currently hosts rooms in the API process. PostgreSQL is
still the document source of truth: a received Update is appended successfully
before any peer sees it. Rooms accelerate propagation only. State Vector sync
restores clients after disconnect or process restart, while heartbeat,
backpressure limits, and disconnect cleanup bound ephemeral room state.
Each inserted Update creates an Outbox notification in the same transaction.
The Scheduler publishes only its Workspace/Artifact/seq/hash coordinates to
Redis. Every subscribed API instance validates the notification shape, reads
that exact row back through an exact Workspace predicate, verifies its content
hash, and then performs ordered, bounded, duplicate-free local broadcast. A
Redis subscriber reconnect sends a PostgreSQL-rebuilt full state to every
local room, covering Pub/Sub messages missed while disconnected. Redis never
supplies document bytes or authority. Awareness uses a separate non-Outbox
Redis topic because it is explicitly ephemeral: source instances publish
versioned update/removal messages and periodic refreshes, while a new room
probes other instances for their current local members. Receivers keep only a
bounded TTL cache. Subscriber recovery removes remote presence immediately,
rebuilds durable Yjs state, republishes local presence, and probes again, so a
crashed API cannot leave a permanent phantom collaborator.

The Conversation Plane is durable rather than WebSocket-dependent. A project
room has explicit Workspace-scoped members; messages have a stable sequence,
structured entity references, replies, mentions, and per-Agent delivery rows.
If a mentioned Agent owns an active Run in the referenced Mission, the same
transaction creates a Steering control, Inbox wake, and Outbox event. If no
matching Run exists, delivery remains `context_pending`. The next Run freezes
recent Mission-room messages into its execution context and advances those
delivery rows to `context_loaded`. Redis may reduce wake latency, but it is not
message truth.

Before a Mission exists, a human can select an ordered subset of Conversation
messages and promote them into a planning request. One transaction validates
membership and source-message scope, creates the Mission with immutable source
identifiers, stores the Planning Request, appends domain events, and writes the
Planner Inbox plus Outbox wake. The Planner model is invoked asynchronously by
the Agent worker under a fenced lease. Its exact input, structured DAG output,
usage, and retry state are durable; a crash after the model call resumes from
the stored plan without paying for the model twice. The Planner can propose the
plan and report back to the room, but only a human can approve and materialize
the DAG.

The current Planner contract represents independent approval as
`reviewRequired=true` on the producing Task. It must not generate a downstream
Reviewer Task solely to approve that parent: the parent cannot complete until
its Submission is approved, so such a DAG edge would be circular. Durable
automatic dispatch now creates a separate Reviewer execution and Inbox request
for an eligible Mission-room Reviewer; a Workspace human can still review or
take over a pending automatic request.

### Tool gateway

Is the only supported side-effect boundary. It authenticates the actor,
authorizes the action, reserves the idempotency key, performs the operation,
and records typed effects.

### Agent Runtime

The Runtime is a bounded state machine rather than an unbounded chat loop. It
loads the durable transcript, applies pending Steering or Cancel controls,
reconciles Tool Calls that do not yet have a terminal result, spends one model
hop, and persists the response before executing tools. A provider adapter can
change without changing Run semantics.

The complete transcript remains immutable durable history, but it is not sent
unbounded to every model call. At the start of a Run, Mission, Task, acceptance
criteria, Agent model policy, and exact assigned Skill Versions are frozen into
`agent_runs.context_snapshot`. Before each model call, the Context Builder
retains the frozen prefix, accounts for Tool definitions, selects recent
assistant/tool exchanges atomically, and replaces older history with a bounded
hash ledger. A conservative UTF-8 estimator keeps the result below the
configured input budget. It never silently truncates mandatory instructions.

The exact model-visible message view, Skill references, strategy, estimates,
and content hash are stored as an immutable per-hop Context Snapshot. The LLM
ledger row references that Snapshot directly. Provider continuation may reduce
transport size, but it does not replace the local Context Snapshot as the
auditable request plan.

`run.set_status(done)` is a request, not authority. The completion verifier
checks evidence and review gates before the Runtime writes `succeeded`. A
normal model stop, text such as "done", or an empty response only produces a
nudge and consumes another bounded hop.

A provider response that ends because of an output limit, content filter, or
provider error without a complete Tool Call fails the Run immediately after
the redacted call ledger is persisted. A completed provider response containing
an unknown function name or invalid argument object is a different case: no
Tool Call from that response executes, usage and a redacted protocol diagnostic
are persisted, and the Runtime may issue at most two durable correction prompts.
The correction count is reconstructed from the transcript after restart. After
an invalid response, continuation is disabled for the next call so a stateful
provider cannot demand an output for the malformed function call; the clean
local transcript is replayed instead. Stopping an Agent Worker also aborts its
active model/tool signal instead of waiting for the entire Run loop.

Builder Tasks that require `file_diff` Evidence also use a deterministic,
repeating implementation phase gate. The Runtime permits four discovery hops
before the first successful `file.patch`, then opens one new four-hop discovery
window after each later successful patch. When a window expires, repository
read and search Tool definitions are hidden until another `file.patch`
succeeds. Calls from a stale provider response are rejected before the Tool
Gateway executes them. The gate derives the latest successful implementation
hop from the durable transcript rather than Worker memory, so restart and
replay preserve the same window.

Review-gated Builder Runs also divide the tail of `max_hops` into an enforced
delivery reserve. With eight hops remaining, broad `repo.search` is removed and
the model receives a durable instruction to stop optional investigation. With
six remaining, `repo.search`, `file.read`, and `file.patch` are removed so those
calls are reserved for one exact verification, `repo.commit`, Artifact append,
immutable Version creation, Review submission, and `run.set_status`. Stale calls
to removed actions are rejected before the Tool Gateway. If verification fails,
the Run terminates and a later durable Task attempt resumes the same Worktree
instead of consuming the delivery budget on unbounded repair.

## 4. Source-of-truth boundaries

| Concern | Durable truth | Acceleration only |
|---|---|---|
| Mission and Task state | PostgreSQL | Redis wake |
| Conversation messages, membership, and mention delivery | PostgreSQL | Web polling / future stream |
| Inbox and read cursor | PostgreSQL | SSE or WebSocket |
| Task ownership and lease | PostgreSQL | Worker memory |
| Worker process presence and expiry | PostgreSQL Worker Instance heartbeat | Web five-second projection |
| Project launch inputs | PostgreSQL Project Runtime Configuration (never API keys) | API-owned local child-process map |
| Human credentials, roles, session validity, login throttling, and auth audit | PostgreSQL hashes/versioned rows | HttpOnly/CSRF browser cookies containing plaintext random tokens |
| Internal Agent API identity | API process environment Bearer token plus durable Run/Task authorization | Request headers after token validation |
| Mission working deliverable | PostgreSQL primary `mission_deliverable` Artifact, Yjs state, and immutable Versions | Model prompt and Web Artifact projections |
| Task Worktree, reviewed HEAD, and integration state | PostgreSQL plus Git object database | Worker path cache |
| Pre-model Worktree setup, lease, argv hash, and result hashes | PostgreSQL `task_worktree_setups` | Worker process timers |
| Frozen Run instructions and per-hop model context | PostgreSQL Context Snapshots | Provider continuation cache |
| Yjs content | PostgreSQL update log and snapshot | Y.Doc room and Redis fan-out |
| Presence and carets | None | Bounded process cache plus ephemeral Redis fan-out, probe, heartbeat, and TTL |
| Tool side effects | PostgreSQL tool execution record plus target system | Event stream |
| Run trace and cost | PostgreSQL | In-memory telemetry buffer |
| Project-scoped redacted Run Trace query | PostgreSQL agent_runs/events/LLM/tool ledgers | Web Trace projection |
| Project-scoped Evaluation Scenario, Trial, and report inputs | PostgreSQL immutable Scenario Version plus Run ledgers | Rebuildable Web report projection |

### Identity and transport boundary

Human authentication and domain authorization are separate checks. A successful
password verification creates a random session token and random CSRF token;
PostgreSQL receives only their SHA-256 hashes, the exact Workspace/User/role,
credential version, source/user-agent hashes, idle/absolute expiry, and later
revocation. Passwords use parameter-fixed scrypt hashes with per-credential
random salts. Changing a credential increments its version and revokes every
older session in one transaction. Failed login counters and blocks are also
PostgreSQL facts so horizontally scaled API instances cannot bypass each
other's throttle.

The browser receives a SameSite=Strict session Cookie with `HttpOnly` and a
separate readable CSRF Cookie. Unsafe REST requests require an exact configured
Origin plus a header/Cookie/hashed-session CSRF match. Production Cookies use
the `__Host-` prefix and `Secure`; production startup rejects an empty allowed
Origin set. Workspace ids in REST/Artifact WebSocket paths must equal the
session Workspace before repository authorization runs. This database
Workspace is the hidden tenant boundary; a database Project is presented as a
user-facing workspace. `project_memberships` stores the User's role for each
Project, and `/auth/session` returns only joined Projects with their exact
roles. Direct Project routes and Mission/Run/Artifact resource routes resolve
the resource back to a Project and check that membership before entering the
domain repository. A Project Viewer is read-only even when that User has a
higher role in another Project.

Member mutation is serialized by locking the Project row. This makes the
last-Owner check safe against concurrent demotions/removals. Adding a human
also joins every Project Room; removal clears that human from all Project
conversations. Add, role-change, and removal events are append-only facts, and
the affected User's sessions are revoked after every scope change so cached
session roles cannot outlive the membership ledger. The Web cannot select or
claim a User id: it receives its User and allowed Project list from
`/auth/session`.

The entry flow has two explicit deployment modes. `team` verifies a password
inside the server-configured tenant; the browser never supplies a Workspace id.
`local` is development-only, requires a loopback listener, rejects forwarding
headers, creates an opaque credential for the configured local User when needed,
and issues the same persisted Session as team mode. In the Web, database
Projects are presented as user-facing workspaces; the database Workspace stays
an internal tenant boundary. Authentication first opens the workspace launcher,
and entering a workspace opens its Team Room rather than an infrastructure
dashboard. The Member surface is a projection of `project_memberships`, not a
client-only contact list.

Agent transport identity never reuses the browser session. An Agent must first
prove an unpredictable Bearer token kept only in the API/Worker environment;
only then are its Actor/Run/Task/Tool/intent headers accepted and checked by
the Artifact/domain repository. The production server never enables the
header-only test authenticator. Redis carries neither credentials nor session
truth.

## 5. Mission execution flow

1. Plan approval atomically changes Mission to running and creates ready Task
   records for dependency-free nodes.
2. Scheduler selects ready tasks and publishes wake hints.
3. A Worker atomically validates a Dispatch Token, claims the Task, creates a
   Run, and acquires its Task Lease.
4. The Worker reserves a deterministic per-Task Worktree under a fencing lease,
   creates or reconciles its branch, and binds all repository tools to that
   exact canonical path.
5. The Worker reserves the Project's exact-argv setup gate for that Worktree
   generation and command hash. It runs commands sequentially with no shell,
   stores only output hashes, and does not construct the model Runtime until
   the gate succeeds. A matching durable success is reusable after restart.
6. After the idempotent Task claim succeeds, the Worker advances its Inbox cursor
   with optimistic concurrency. A crash between these operations safely
   replays the Inbox message and discovers the already-created runnable Run.
7. The bounded model/tool loop executes until explicit completion, failure,
   cancellation, or human wait.
8. Tool requests reserve an idempotency key before any side effect.
9. Every Mission has a deterministic primary deliverable Artifact. Its exact id
   and the Task review policy are frozen into the Run context. The Builder
   updates it, freezes an Artifact Version, and commits its Worktree. Code
   submission requires Evidence for both the exact Version and exact HEAD.
10. Independent approval admits that HEAD to the integration worker, which
   fast-forwards when possible. If the base advanced independently, it may
   create a conflict-free merge commit that retains the exact reviewed HEAD as
   a parent. A content conflict leaves the base ref unchanged, materializes a
   pending merge in the isolated Task Worktree, supersedes the old approval,
   and sends the Task through Builder evidence and independent Review again.
11. Task completion evaluates evidence, review, and integration gates; the model cannot write
   the terminal Task state directly.
12. Completing a task unlocks dependents in the same transaction. The
   integration worker then removes the clean Worktree and merged branch.
13. Once every Task completes, the Mission exposes the latest independently
   approved Artifact Version as the final-delivery candidate (or the latest
   Mission Version when no Task review was required). A Workspace human must
   approve that exact id; a stale id is rejected, and only then does the Mission
   become `completed`.

## 6. Yjs and immutable versions

Yjs solves live convergence. It does not define a reviewable release.

The collaboration service persists an append-only sequence of Yjs updates and
periodically compacts them into a state update. To request review, the service:

1. loads the latest durable Y.Doc state;
2. encodes a full snapshot;
3. derives a stable content representation;
4. stores an immutable Artifact Version with a content hash;
5. binds Evidence and Review to that version id.

Later edits continue in the living document and cannot mutate the reviewed
version.

Agent edits use semantic operations such as insert section or replace block.
The server translates them into one Yjs transaction with an origin containing
agentId, runId, taskId, and toolCallId.

Before editing, an Agent reads the canonical ProseMirror projection and stable
top-level `blockId` values. Semantic operations never replace the entire
document. Legacy top-level blocks receive deterministic ids; operation-derived
blocks and comments receive Tool-Call-derived ids, making replay detectable.

The implemented persistence layer uses Yjs v13 binary Update payloads as the
durable source of truth. Updates are content-hash deduplicated and may be
replayed in any order. A client can provide its State Vector to receive only
the missing Update. Snapshot compaction locks the Artifact while rebuilding
the latest state, records the exact update sequence covered, and never treats
the JSON projection as collaboration history.

An Artifact Version stores both canonical ProseMirror JSON for review and the
exact full Yjs state that produced it. Its content hash and Yjs state hash are
independent, and a database trigger rejects updates to a frozen Version.
Subsequent live Updates therefore cannot change a previously reviewed value.
User origins are checked against Workspace membership; Agent origins must
match the Artifact Mission and their durable Run, Task, and Agent identity.

HTTP endpoints expose Update and State Vector exchange for non-realtime
clients. The WebSocket room accepts explicit `sync`, `update`, and `awareness`
messages. Persisted Updates are acknowledged to the sender and broadcast to
peers only after the append commits. Awareness is schema-bounded, broadcast as
a snapshot/update/removal lifecycle, and never enters Artifact history.
For cross-instance delivery, the append transaction also writes an
`artifact.update_committed` Outbox notification. Redis transports only the
coordinates; the receiving API reloads and hash-checks the Update from
PostgreSQL. Repeated Outbox publication and local/remote delivery races are
coalesced by a bounded seq/hash ledger per API instance. Each connection also
records the latest full-sync Update sequence, so a delayed notification already
contained in that database snapshot is not sent again.
Awareness uses `mission.artifact-awareness.v1` directly rather than the
Outbox. Each API process has a generation-specific instance id; every local
connection has a monotonically increasing Awareness version. Remote APIs
ignore stale or repeated versions, retain graceful-removal tombstones briefly,
and expire unrefreshed presence after three heartbeat intervals. Exact
Workspace/Artifact room keys prevent cross-room display. Awareness payloads
remain display hints only and never grant access or become review evidence.

The operator query surface lists Artifacts only through an exact
Workspace/Project predicate. Artifact detail reconstructs the current Y.Doc,
returns its canonical ProseMirror JSON, state hash, byte count, and covered
Update sequence, and joins the append-only Version summaries. The Web can
therefore compare LIVE state with an exact immutable Version without inventing
collaborators, comments, content, or provenance. Freezing remains a command and
is enabled only while the operator is viewing LIVE state.

Review is bound to exact state rather than the living room. The producing Run
creates a Version, records `artifact_version` Evidence with the same content
hash, and submits that Version. Submission computes a deterministic Evidence
bundle hash and freezes every selected Evidence id in
`task_submission_evidence`. The current Run's Evidence is included, while a
retry may reuse the exact Artifact Version and commit Evidence from an earlier
Run of the same Task. Prior `test_run` / matching command Evidence is reusable
only when the test recorded a clean, stable Worktree with the same committed
HEAD and tree as the submitted Worktree. Stale commits, dirty test snapshots,
and cross-Task Evidence are rejected. Because the Runtime marks a Run
`waiting_tool` while any ordinary
Tool Call is executing, the submission gate accepts that transient owner state
in addition to `running`, `waiting_human`, and `succeeded`; it still rejects
foreign Runs, stale Versions, uncommitted Worktrees, and mismatched Evidence.
When the Mission Conversation contains an active Reviewer Agent, the same
transaction creates a requested Review, a separate durable `review_executions`
record, and a deduplicated Reviewer Inbox message. System-created Missions such
as Evaluation Trials may have no Conversation; in that case assignment is
limited to an active Reviewer whose membership in another Conversation binds it
to the same Project. The Scheduler repairs a crash window or older record where
a review-gated Submission is durably `submitted` but has no Review, using the
same eligibility rule and row lock before emitting a deduplicated Inbox wake. A
Workspace human remains able to decide directly or take over a pending automatic
Review; a Mission without an eligible Reviewer stays on the human path instead
of selecting an unrelated Agent.

Reviewer execution is deliberately not represented as another Task Run: it has
its own fenced lease, retry budget, frozen material snapshot, prompt/response,
model identity, provider request id, Token/cost/latency usage, error, and hashed
decision. Its material snapshot contains the exact immutable Artifact Version,
Task criteria, the submission's frozen Evidence ids with producer Run status
and attempt, relevant successful tool/test results,
Worktree state, and cumulative `base_commit -> HEAD` diff. The model must call
`review.submit_decision` exactly once. The immutable database snapshot keeps
every Evidence row. Before model invocation, a deterministic bounded projection
groups identical `(kind, uri, content_hash)` payloads, emits their common metadata
once, and retains all equivalent Evidence ids, producer Runs, attempts, timestamps,
and metadata deltas. This prevents acceptance-criterion and retry projections from
multiplying the same diff without weakening the audit trail or raising the input
safety limit. Once the automatic retry budget is exhausted, only a Workspace
human can add one bounded attempt through the Reviewer retry API. That transaction
preserves the frozen snapshot and attempt history, records a domain event, and
creates a new durable Inbox wake; it cannot reopen a completed Review. A crash after decision persistence resumes
database finalization without another model call. Approval reuses the Task
completion gate and dependency unlock transaction; `changes_requested` returns
the Task to `ready`, while a terminal rejection fails it.

`review_executions` stores the resumable current decision state;
`reviewer_model_calls` is the append-only usage ledger keyed by Review attempt.
Successful structured responses and structurally invalid responses both consume
model resources and therefore both create call rows before retry handling. The
ledger retains cached-input usage and historical failed attempts even when the
execution row advances. Evaluation aggregation sums ordinary `llm_calls` and
these Reviewer call rows; a migration conservatively backfills the latest
observable call from pre-ledger Review executions without rewriting already
frozen Trial metrics.

Planner and Reviewer model requests require a structured Tool Call and disable
parallel Tool Calls because each control-plane transition accepts exactly one
decision. They also request reasoning effort `none`: some compatible endpoints,
including DeepSeek V4 Thinking mode, support tools but reject required tool
choice. This per-request override does not change execution-Agent reasoning.
A compatible provider may still violate the structured contract. Reviewer
validation therefore remains strict, but the invalid response snapshot, usage,
latency, provider request id, and error are persisted before the attempt fails;
text-only approval can never become a database Review decision.

## 7. Coordination invariants

- A Task has at most one active lease.
- A Run belongs to one Task attempt and one Agent.
- A terminal Run cannot transition again.
- A Task cannot complete without all required evidence gates.
- A Reviewer cannot approve work from the same Agent identity.
- An automatically assigned Agent reviewer must be active, have the `reviewer`
  role, and belong to the Mission Conversation, or for a Conversation-less
  system Mission be bound to the same Project through Conversation membership;
  a human reviewer must be a Workspace member.
- A Submission must reference a Version created by the submitting Run and
  exact-hash durable Evidence from that Run.
- When a Task has changed code, its Submission must also reference `file_diff`
  Evidence whose commit is the recorded Worktree HEAD and whose exact diff spans
  the Task Worktree base through that HEAD; approval cannot complete the Task
  until that exact commit is contained by the recorded integration HEAD. A
  verified unchanged baseline is already integrated and needs no invented diff
  or empty commit.
- A dependent Task cannot become ready before all required parents complete.
- A side-effecting Tool Request with the same idempotency key returns the same
  recorded result.
- The model-provided risk label must match the server-owned Tool Handler policy.
- Only the holder of the current Tool execution fencing token may record its
  result.
- An expired Tool lease is retried only for read-only operations or when the
  target offers native idempotency; otherwise it becomes an explicit
  ambiguous-effect failure.
- External and destructive tools execute zero side effects before approval.
- A model stop reason never changes a Run to succeeded.
- Redis delivery never changes durable state by itself.
- Awareness never grants permission.
- Artifact Versions are append-only.

## 8. Repository execution

Each Builder task receives an isolated Git worktree and sandbox identity:

~~~text
project repository
  |-- baseline commit
  |-- worktree/task-A
  |-- worktree/task-B
  +-- integration worktree
~~~

File tools are path-scoped to the assigned worktree. Shell commands run with
time, output, environment, and resource limits. Integration happens only after
tests and review gates pass.

The Agent Worker normally resolves the Project's default branch in
`REPOSITORY_ROOT`, derives a stable path and `agent/task-*` branch under
`WORKTREE_ROOT`, and reserves the database record before invoking Git. An
Evaluation Trial instead receives a deterministic `evaluation/trial-*` base
ref. The ref is created only from the Scenario Version's frozen commit and may
advance only to its descendants. Thus tasks within one Trial share their own
integration history while variants and repetitions cannot contaminate one
another. Provisioning, integration, and cleanup each use expiring fencing
tokens, so a restart can reconcile a partially completed filesystem operation
without trusting stale process state.

Dependency preparation is a separate gate, not a general Shell tool and not a
test allowlist entry. Project Runtime Configuration stores zero to twenty exact
argv arrays plus a per-command timeout. `task_worktree_setups` binds an attempt
to the Workspace, Mission, Project, Task, Run, Worktree generation, and canonical
commands hash. An expiring lease permits takeover after a crash; only its token
may write success or failure. Reuse requires a successful row with the same Task,
generation, and hash. Audit rows retain argv, timing, exit status, timeout state,
and stdout/stderr SHA-256 values, never raw command output.

`repo.commit` stages the complete Task change, creates a commit with fixed
server-owned identity and hooks/signing disabled, records the exact tree and
binary diff hash, and persists `file_diff` Evidence. A retry can reconstruct
Evidence whether the crash happened before or after the Worktree row advanced.
After staging and before committing, the gateway inspects every added, copied,
modified, or renamed symlink. Absolute targets and targets that are dangling or
resolve outside the assigned Worktree are rejected; the index is restored while
the working file remains available for operator diagnosis. This prevents local
dependency mounts and host paths from entering a reviewed Task commit.
For a clean Worktree that still points at its baseline, the same tool records a
no-change integration fact without creating an empty commit. This lets
Researcher and other evidence-only Tasks complete and enter ordinary safe
cleanup while a dirty or advanced Worktree can never bypass Integration.

The independent integration worker selects only approved Submissions with a
`committed` Worktree. It verifies that the clean Worktree HEAD is the reviewed
HEAD. If the current base is its ancestor, integration is a fast-forward. If
both histories advanced, the worker creates a hooks/signing-disabled merge only
when Git reports no conflicts, verifies that the merge parents are the exact
pre-integration base and reviewed Task HEAD, and records the resulting
integration commit. The checked-out project branch additionally requires a
clean matching checkout. A non-checked-out Evaluation ref is merged in a
bounded temporary integration Worktree and advanced with an atomic
compare-and-swap, without changing the project checkout. A crash after Git but
before PostgreSQL is recovered by proving the reviewed HEAD is already an
ancestor of the current base. A content conflict aborts the attempted source
merge, then merges that exact current base with `--no-commit` inside the Task
Worktree. PostgreSQL atomically stores `reconciliation_base_commit`, supersedes
the old approved Submission, and returns the Task to `ready` (or `failed` when
its attempt budget is exhausted), so the Integration queue cannot poll the same
deterministic conflict forever. The next Builder Run receives the durable
recovery reason, resolves the pending merge with bounded file tools, and must
create a new commit, test Evidence, Artifact Version, and independently reviewed
Submission. `repo.commit` proves the new HEAD contains the recorded current base
and calculates Task diff Evidence from that base, excluding unrelated platform
changes. Failures outside this content-conflict path retain fenced replay so a
crash after the Git ref moved can still reconcile safely. Cleanup removes only a clean
integrated Worktree and deletes a Task branch only after proving its reviewed
HEAD is contained by the recorded base ref.

The runtime exposes no general shell tool. `test.run` spawns an argv array
without a shell and only when it exactly matches the configured allowlist.
The development-only local Worker supervisor follows the same boundary. Its
routes exist only when `ENABLE_LOCAL_RUNTIME_CONTROL=true`; child processes
receive an explicit environment allowlist, model credentials come only from the
API environment, duplicate live heartbeats prevent another launch, and stop
requests affect only processes owned by that API instance. Scheduler and
Evaluation use API-global child keys; Integration uses a
Workspace/Project-qualified child key and heartbeat lookup because its Git
roots come from that Project's persisted runtime configuration.

## 9. Reproducible strategy evaluation

An Evaluation Scenario separates the benchmark definition from an execution:

1. a human creates Scenario metadata;
2. an immutable Scenario Version freezes the goal, constraints, acceptance
   criteria, full Git commit, one-task single-Agent plan, and multi-task
   multi-Agent plan;
3. an Experiment creates paired Trials for each repetition, with both variants
   sharing the same deterministic pair seed;
4. each Trial materializes as a normal approved Mission and runs through the
   same Scheduler, Runtime, Tool, Review, and integration gates;
5. its Git ref starts at the frozen commit and remains isolated from every
   other Trial;
6. the collector computes success, completion rate, wall time, attempts,
   execution-Agent plus Reviewer model calls and tokens, estimated cost, Tool
   failures, review churn, and context statistics from durable facts;
7. the report exposes per-variant aggregates and paired deltas (`multi -
   single`) only for repetitions where both results exist.

Scenario Version immutability prevents a benchmark from changing after Trials
start. Trial materialization uses expiring leases and fencing tokens; a stale
worker cannot attach a different Mission. Reports are projections and can be
rebuilt from the Trial metrics and underlying ledgers. The operator API and Web
Lab list Scenario Versions and Experiments only through a combined
Workspace/Project scope; an Experiment id from another Project is not a valid
report lookup even when both Projects belong to the same Workspace. Trial
errors and lifecycle timestamps are returned as bounded operational facts so a
failed harness can be diagnosed without reading raw model content.

## 10. Current model execution

The production provider is OpenAI Responses. Every successful response id is
stored in the LLM ledger. The default OpenAI endpoint reuses it as
`previous_response_id` after a durable resume, while a configured custom
`OPENAI_BASE_URL` conservatively replays the complete local transcript because
OpenAI-compatible endpoints are not guaranteed to persist responses. A
stateful custom proxy can opt back into response-id continuation explicitly.
System instructions are sent again on each continued request. Tool Calls and
Tool Results remain in the local durable transcript, so provider continuation
is an optimization rather than the source of truth.

Some compatible endpoints return literal newlines or tabs inside the JSON
string that carries function arguments. The adapter retries parsing only after
escaping those control characters while they are inside a quoted JSON string.
It does not repair structure, quotes, delimiters, non-object inputs, or unknown
function names, and the official OpenAI path never enables this compatibility
pass. Structural errors become bounded model-protocol corrections; they are
never converted into guessed inputs. The normalized valid object still enters
the ordinary typed Tool Gateway and durable Tool Call ledger.

Read-only repository tools also persist verifiable Evidence: repository search
emits both a bounded source `citation` and its exact `command_result`, file
reads emit line-addressed citations, repository status emits a command result,
and allowlisted tests emit both `test_run` and `command_result`. This keeps
Planner-visible Evidence kinds aligned with what the Tool Gateway can actually
produce; the completion gate never treats model prose as Evidence.

`file.patch` accepts only bounded unified diffs and still delegates path,
context, and application validation to `git apply --check`. Before that check,
it deterministically recalculates each hunk header's old/new line counts and
appends the patch-format trailing newline when the model omits it. A stale hunk
start may also be rebased to the current file only when the hunk's complete
old-side text has exactly one match. Ambiguous matches are rejected before
`git apply --check`; missing old-side text is not guessed and proceeds only to
the strict forward/reverse checks needed for replay-safe patches. Count, start,
and trailing-newline normalizations are recorded in the resulting `file_diff`
Evidence.

Each Scheduler tick reaps expired Task leases before dispatching ready work.
A terminal or abandoned Run therefore releases its lease durably and moves the
Task to `ready` for the next bounded attempt, or to `failed` after its maximum
attempt count; Redis delivery is not required for this recovery path.

RunGuild's typed Tool Actions keep their protocol names such as `repo.search`
in PostgreSQL, prompts, policy checks, and audit records. The provider adapter
encodes those names into the restricted Responses function-name alphabet and
maps returned calls back to the exact declared Action. It rejects encoding
collisions and undeclared provider function names before the Runtime can
execute a tool.
Planner tool schemas also consume the protocol package's canonical Evidence
kind list directly, so model-visible acceptance criteria cannot drift from the
validator and database execution contract.
The planning lease snapshots the active Agent roles in the selected project
room; both the model-visible role enum and the server-side returned-plan check
reject Tasks that no current project Agent can execute.

Workspace Skills are immutable versioned instruction bodies. Assignments may
track the latest version or pin one exact version and have a deterministic
priority. Skill changes affect only Runs whose execution context has not yet
been frozen. Existing Runs keep their original Skill content and hash through
pause, restart, or reassignment.

## 11. Reliability model

Delivery is at least once; effects are effectively once where an idempotent
boundary exists.

Expected failures include:

- duplicate Redis wake;
- worker crash before or after a tool side effect;
- expired task lease;
- stale Agent context;
- Yjs reconnect and duplicate update;
- model timeout or malformed tool request;
- reviewer rejection;
- database or model provider transient error.

Every failure must either retry safely, transition to a visible terminal state,
or wait for explicit human action.

## 12. Crash-safe Runtime sequence

~~~text
load durable Run + transcript
  -> apply pending Steering / Cancel
  -> reconcile assistant Tool Calls without Tool Results
  -> atomically increment bounded hop
  -> build and persist the exact token-budgeted Context Snapshot
  -> write running LLM ledger record
  -> call provider
  -> write redacted response + usage
  -> persist assistant message
  -> reserve Tool idempotency key + fencing lease
  -> execute or wait for human approval
  -> persist terminal Tool Result
  -> verify explicit run.set_status(done)
~~~

If a process dies after the assistant message but before the Tool Result, the
next worker finds the unanswered Tool Call and reuses `runId:toolCallId` as its
idempotency key. The Tool repository then replays, safely reacquires, waits, or
reports ambiguity according to durable state.

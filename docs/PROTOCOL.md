# Protocol Contract

The protocol package is the shared language between browser, API, Scheduler,
Worker, collaboration service, and Tool Gateway.

## 1. Envelope

Every domain event carries:

- event id and schema version;
- event type and occurrence timestamp;
- workspace, project, and optional Mission scope;
- actor;
- correlation and causation ids;
- optional idempotency key;
- typed payload.

Correlation groups one user intent or Mission operation. Causation points to
the command or event that directly produced the new event.

## 2. Commands and events

A command requests a state change and may be rejected. An event records a fact
that already happened.

Examples:

~~~text
Command: ClaimTask
Event:   task.claimed

Command: CompleteToolCall
Event:   tool.completed

Command: ApprovePlan
Event:   mission.plan_approved

Command: PromoteConversationMessages
Event:   conversation.planning_requested
~~~

Consumers may receive an event more than once and must deduplicate by event
id. Event names are shared constants; raw channel strings must not be copied
across services.

A `conversation.planning_requested` event records the ordered Message ids,
Planner Agent, Conversation, and newly created Mission. Its matching durable
Inbox payload is `conversation.plan_requested`; Redis only announces that
Inbox fact. The Planner must return exactly one typed `mission.propose_plan`
call. The DAG is validated and persisted before any Mission transition or room
summary is attempted.

## 3. Tool request

A Tool Request includes:

- tool call id;
- action name and schema version;
- Agent, Run, Mission, and Task identity;
- idempotency key;
- arguments;
- risk classification;
- creation and optional deadline timestamps.

The result is succeeded, failed, awaiting approval, or temporarily in progress
under another execution lease. Terminal results include typed side effects.
Shell text is diagnostic output, not authoritative proof that a domain action
happened.

Repository actions are scoped to the Task's server-assigned Worktree:

- `repo.status` reads branch, HEAD, cleanliness, and changed paths;
- `repo.diff` returns a bounded diff and its hash;
- `repo.commit` stages all Task changes and returns the exact commit, tree, and
  diff hashes while emitting `repo.committed` plus durable `file_diff` Evidence.

## 4. Idempotency

For a side-effecting action:

1. begin a transaction;
2. insert the idempotency key and request hash;
3. if the key exists with another hash, reject;
4. if the key exists with a completed result, return that result;
5. commit the reservation;
6. perform the effect or use the target system's idempotency support;
7. record the result and typed side effects.

Actions that cannot be made effectively-once must expose their ambiguity and
require recovery logic instead of silently retrying.

The request hash covers semantic scope, action, input, actor, and risk, but not
transport timestamps. Reusing one key for different semantics is a conflict.
The execution lease has a fencing token: a late worker cannot overwrite the
result produced by a newer lease holder.

External and destructive actions enter `awaiting_approval`. Resolving the
approval writes a durable Inbox message and an Agent wake event in the same
transaction, so a missed Redis notification cannot lose the resume request.

## 5. Runtime control and completion

Steering and Cancel requests are durable, ordered inputs with a Run-scoped
dedupe key. The Runtime applies them between model hops and before recovering
pending Tool Calls.

The model may call `run.set_status`, but only the server owns Run state. `done`
passes through the completion verifier; `blocked` and `waiting_human` pause;
`failed` is terminal. Without an explicit status call the Runtime continues
until its hop budget is exhausted.

Model protocol mistakes are not Tool failures. If a completed response names a
function that is not declared for the current hop or supplies arguments that
are not one complete JSON object, the whole response is side-effect free. The
LLM call still records its provider id and usage, a redacted diagnostic is
appended to the audit trail, and the Runtime may add at most two persisted
corrections. Raw malformed arguments are not stored in the correction and are
never guessed or repaired structurally.

The Runtime may reserve final hops by removing selected Tool definitions. The
same deny rule is checked again before execution, so a provider cannot bypass a
delivery reserve by replaying a Tool Call that was visible in an earlier hop.

## 6. Inbox

Inbox messages are append-only durable inputs addressed to an Agent or Run.
Each consumer maintains a durable cursor. Wake messages contain only enough
information to prompt a drain; they are not the payload of record.

Duplicate wakes are coalesced. Reconnection always drains from the durable
cursor before waiting for new notifications.

## 7. Artifact operation

Humans edit through the Yjs provider. Agents call semantic Artifact tools.
Supported first operations are:

- read current document, comments, block ids, and state hash;
- insert_section;
- replace_block;
- append_content;
- add_comment;
- create_version.
- submit_for_review.

Each operation records an origin with Agent, Run, Task, Tool Call, and intent.
Authorization is checked before applying the Yjs transaction. Awareness data
is not persisted as document history.

The durable synchronization payload is a Yjs v1 binary Update. JSON APIs encode
Update and State Vector bytes as unpadded base64url. A repeated Update hash is
an acknowledged replay, not a new history entry. The server constructs the
origin from the authenticated caller and verifies Agent origin scope against
the referenced Run before persistence.

The realtime endpoint uses bounded JSON WebSocket messages:

~~~text
client -> sync { stateVector? }
server -> sync { update, stateVector, stateHash, throughUpdateSeq }
client -> update { update, clientUpdateId? }
server -> update.ack; peers <- update
client -> awareness { state }
peers  <- awareness.snapshot | awareness.update | awareness.remove
~~~

Update and State Vector fields use the same base64url encoding as HTTP. The
server serializes messages per connection, limits pending work and payload
size, and broadcasts an Update only after durable persistence succeeds.

Cross-instance propagation uses the internal topic
`mission.artifact-updates.v1` with a bounded notification:

~~~text
artifact.update_committed {
  schemaVersion: 1,
  workspaceId,
  artifactId,
  seq,
  updateHash
}
~~~

The notification contains no Yjs bytes. A receiving API must reload the exact
Update through the Workspace/Artifact/seq/hash predicate and verify the stored
bytes before sending the ordinary `update` WebSocket message. Duplicate
notifications are coalesced, and notifications at or below a connection's
latest full-sync sequence are suppressed. After Redis subscription recovery,
active rooms receive a PostgreSQL-rebuilt `sync` message with
`reason: fanout_recovered`.

Ephemeral presence uses the separate internal topic
`mission.artifact-awareness.v1` and never enters the Outbox:

~~~text
artifact.awareness_updated {
  schemaVersion: 1,
  sourceInstanceId,
  workspaceId,
  artifactId,
  version,
  client: { clientId, identity, state }
}
artifact.awareness_removed {
  schemaVersion: 1,
  sourceInstanceId,
  workspaceId,
  artifactId,
  version,
  clientId
}
artifact.awareness_probe {
  schemaVersion: 1,
  sourceInstanceId,
  workspaceId,
  artifactId
}
~~~

`sourceInstanceId` identifies one API process generation. A client version
increases whenever its authenticated local connection changes or removes its
state; equal-version heartbeats only renew the receiver TTL and stale versions
are ignored. The first local client in a room publishes a probe, to which other
instances answer with their current local presence. Graceful disconnect sends
a removal. Missing removals are bounded by a three-heartbeat TTL, and Redis
subscriber recovery clears remote entries before republishing and probing.
The payload is schema/size bounded and scoped to an already-authorized local
Workspace/Artifact room, but remains non-authoritative display state.

## 8. Evidence

Evidence is typed rather than stored only as prose:

- test_run;
- command_result;
- file_diff;
- artifact_version;
- trace_span;
- citation;
- human_attestation.

Evidence contains a producer Run, content hash or durable reference, creation
time, and optional expiration. Review policy decides which evidence types are
required for each acceptance criterion.

Workspace tools persist Evidence before returning a successful result. A
`run.set_status(done)` payload cannot substitute an in-memory reference for a
missing database row: the completion verifier reads current, unexpired
Evidence directly from PostgreSQL.

## 9. Submission and review

An Artifact Submission is scoped to one Workspace, Mission, Task, producing
Run, and immutable Artifact Version. The Version must have been created by the
submitting Run, and that Run must already have unexpired `artifact_version`
Evidence whose content hash exactly matches the Version. The server hashes the
ordered evidence set into `evidenceBundleHash`.

If the Task changed its Git Worktree, submission additionally requires the
Worktree to be `committed` and unexpired `file_diff` Evidence from the producing
Run whose metadata names that exact HEAD commit and contains the bounded exact
base-to-HEAD diff. A clean unchanged baseline may already be `integrated` and
does not require a synthetic commit or diff. The Evidence bundle therefore
freezes both the document Version and the code revision. Approval makes a
changed commit eligible for integration; it does not bypass the integration
gate.

One Submission receives one terminal Review. The submitting Agent cannot
review it. An Agent reviewer must be an active `reviewer` in the Workspace; a
human reviewer must be a Workspace member. Decisions are:

- `approved`: pass the existing evidence/review completion gate;
- `changes_requested`: reject the current Submission and reschedule the Task
  when attempts remain;
- `rejected`: reject the Submission and fail the Task.

For automatic review, Submission creation chooses only an active Reviewer in
the Mission Conversation, creates `artifact.review_requested` in that Agent's
durable Inbox, and records execution separately from Task Runs. The Reviewer
lease freezes its Artifact, criteria, Evidence, test/tool results, Worktree, and
diff material before the model call. `review.submit_decision` is a model-output
schema, not a general Tool Gateway capability. Prompt, response, usage, error,
and the hashed decision remain in `review_executions`; after the decision is
stored, retries never repeat the model call.

## 10. Context and Skills

A Skill has mutable Workspace metadata but immutable numbered instruction
Versions. An Agent assignment selects either the latest active Version or one
explicit pinned Version and carries a stable priority. Every injected Skill is
identified in the prompt and Context Snapshot by Skill id, Version id, content
hash, estimated tokens, and priority.

The durable Run transcript and the model-visible context window are distinct:

- the transcript appends every system, user, assistant, and Tool message;
- the Context Builder creates one deterministic bounded view per model hop;
- initial Run instructions and Tool definitions are mandatory;
- assistant Tool Calls and their Tool Results are selected as atomic units;
- omitted older messages become a bounded digest containing counts and hashes,
  never invented semantic conclusions;
- an oversized latest Tool result may be represented by its hash, size, and
  bounded first/last excerpts;
- mandatory context overflow fails the Run visibly rather than silently
  dropping safety, Task, or Skill instructions.

`ContextSnapshot.contentHash` covers the full exact view and build metadata.
Replaying the same Run, hop, sources, Tools, and budget must produce the same
Snapshot id and hash. Each `llm_calls` row references its Snapshot.

## 11. Evaluation

An Evaluation Scenario Version is immutable and contains:

- one goal, bounded constraints, and acceptance criteria;
- a full 40- or 64-hex Git baseline commit;
- a valid single-Agent Mission plan containing exactly one Task;
- a valid multi-Agent Mission plan containing at least two Tasks.

An Experiment expands the selected variants and repetitions into deterministic
Trials. The two variants in one repetition share the same paired seed, but
receive distinct Trial and Mission ids. Trial materialization is protected by
an expiring fencing token and can be replayed after a worker crash.

Evaluation Missions use a deterministic isolated Git base ref initialized from
the frozen commit. Its later head must remain a descendant of that commit.
Every Task therefore sees previous integration inside its own Trial without
changing the checked-out project branch or another Trial.

Terminal Trial metrics are computed by the server from Task, Run, LLM Call,
Tool Execution, Review, and Context Snapshot rows. A caller cannot submit a
self-reported score. Paired report deltas use `multi_agent - single_agent` and
include only repetitions where both Trial metrics are present.

## 12. Versioning

Protocol envelopes begin at schema version 1. Changes are:

- additive within a version when old consumers can ignore the field;
- introduced as a new version when meaning or required data changes;
- upcast at service boundaries when historical events are read.

The database, Redis payload, WebSocket payload, and model tool definition must
derive from the same protocol source.

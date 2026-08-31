# Product Requirements

## 1. Product definition

RunGuild is an AI-native software delivery workspace. Persistent
agents participate in project conversations like teammates, but meaningful
work is promoted into a Mission with explicit scope, a task DAG, isolated
runs, shared artifacts, evidence, and review.

The first target user is an individual developer or a small engineering team
that wants agents to analyze a repository and implement a bounded change
without losing control of planning, execution, or verification.

## 2. Problem

Most multi-agent demos stop at role prompts and message passing. They do not
reliably answer:

- Who owns each unit of work?
- What happens after a worker crashes?
- How is duplicate work prevented?
- Which run produced a file or conclusion?
- Can humans and agents edit the same artifact safely?
- What evidence makes a task complete?
- Is a multi-agent run actually better than a single-agent run?

The product must make these questions first-class system concepts rather than
prompt conventions.

## 3. Product promise

A user can start with a repository and a natural-language goal, collaborate
with a Planner on the proposed plan, approve it, watch specialized agents
execute tasks in parallel, steer the work, inspect every side effect, and
receive a reviewed, versioned deliverable.

## 4. Golden mission

Initial demo request:

> Analyze this repository, implement the requested API feature, add tests, and
> produce a technical report explaining the design and evidence.

Expected flow:

1. The user discusses the request in a project conversation.
2. Planner creates a Mission proposal and edits the plan artifact.
3. The user and Planner co-edit the artifact through Yjs.
4. The user approves the plan.
5. Planner emits tasks and dependencies.
6. Scheduler makes dependency-free tasks ready.
7. Researcher and Builder claim ready tasks atomically.
8. Builder works in an isolated Git worktree and runs tests.
9. Every run and tool side effect is recorded.
10. Reviewer receives a frozen artifact version and evidence bundle.
11. The Mission-room Reviewer Worker leases a separate durable Review execution,
    records its exact model input/output and usage, then passes the task or
    rejects it with actionable findings.
12. The user approves the final Mission deliverable.

## 5. Core entities

- Workspace: security and team boundary.
- Project: repository, conversations, agents, and missions.
- Agent: persistent identity, role, skills, model policy, and permissions.
- Conversation: natural collaboration and steering surface.
- Mission: approved goal, acceptance criteria, budget, and lifecycle.
- Task: dependency-aware unit of work with ownership and lease.
- Run: one isolated execution attempt by one Agent on one Task.
- Artifact: collaborative living output backed by Yjs.
- Artifact Version: immutable snapshot used for review and delivery.
- Evidence: typed proof such as test output, file diff, citation, or trace.
- Review: independent decision against explicit acceptance criteria.
- Task Worktree: isolated repository branch plus provision, reviewed-commit,
  integration, and cleanup lifecycle for one Task.
- Worktree Setup: generation- and exact-argv-scoped durable gate that prepares
  an isolated Task Worktree before any model call.
- Skill and Skill Version: Workspace operating procedure with immutable content
  versions and deterministic Agent assignment.
- Context Snapshot: exact token-budgeted model-visible view for one Run hop.
- Evaluation Scenario Version: immutable goal, Git baseline, criteria, and
  competing orchestration plans.
- Evaluation Experiment and Trial: paired repetitions of single-Agent and
  multi-Agent execution using the production Mission pipeline.

## 6. Product functional requirements

### Workspace and conversation

- One user can create a project and conversation.
- Persistent agents can receive mentions and post progress summaries.
- A message or selected message range can create a Mission proposal.
- Mission, Task, Run, and Artifact references are structured links.

### Mission planning

- Planner produces goal, constraints, acceptance criteria, and task graph.
- A task may depend on zero or more other tasks.
- Cycles are rejected before plan approval.
- Execution cannot start until the user approves the plan.

### Execution

- A ready task can be claimed by exactly one Agent.
- Claims expire unless the owning run renews its lease.
- Runs use an explicit, bounded model/tool loop.
- Cancellation and human steering are durable.
- A restarted worker can resume from persisted state.
- Mission, Task, acceptance criteria, and Skill instructions freeze per Run.
- The durable transcript is compacted into a deterministic per-hop model view
  without mutating or deleting history.
- Mandatory instructions cannot be silently dropped to satisfy a token limit.

### Collaborative artifact

- Browser and Agent edits converge through a Y.Doc.
- Yjs updates are persisted before they are considered durable.
- Awareness is ephemeral and never used as authorization.
- Review creates an immutable Artifact Version.
- Every Agent edit records Agent, Run, Task, and operation intent.

### Tools

- Repository search/status/diff/commit, file read, file patch, shell test, artifact edit,
  message post, task update, and run status are typed actions.
- Side-effecting requests use an idempotency key.
- High-risk actions can pause for human approval.
- Tool results emit typed side effects and evidence references.

### Review

- The builder of a task cannot approve its own work.
- A Submission is automatically assigned only to an active Reviewer who belongs
  to the Mission Conversation. A system-created Mission without a Conversation,
  such as an Evaluation Trial, may use an active Reviewer already bound to the
  same Project through a Project Conversation; it must never select an unrelated
  Workspace Agent. Submitted review-gated work without an assignment is
  recoverable by the Scheduler and remains available for human review when no
  eligible Agent exists.
- Reviewer model execution has its own lease, retry budget, frozen material
  snapshot, prompt/response ledger, Token/cost usage, and persisted decision. It
  does not consume or mutate the producing Task Run's attempt budget.
- Every Reviewer response with observable usage has a separate immutable
  per-attempt call row. Evaluation Token/cost/model-call totals include these
  rows as well as ordinary execution-Agent calls.
- Review materials bind the immutable Artifact Version, criteria, Evidence,
  relevant test results, Worktree state, and cumulative base-to-HEAD diff.
- Required acceptance criteria must have evidence.
- Rejection reopens or creates remediation tasks.
- Mission completion requires system gates plus user approval.

### Observability

- A run timeline shows LLM calls, tool calls, state transitions, usage, and
  errors.
- The Mission view shows task dependencies and current ownership.
- Single-agent and multi-agent benchmark runs share the same scenario format.
- Benchmark Trials start from isolated refs at the same frozen Git commit.
- Reports show success, wall time, cost, tokens, attempts, Tool failures,
  review churn, context usage, and paired multi-minus-single deltas.
- Scores are derived from execution ledgers rather than Agent-authored output.
- The Chinese operator Lab lists only the current Project's immutable Scenario
  Versions and Experiments, creates paired runs from an exact Version, and
  exposes queued/running/failed/completed Trial state without sample metrics.

## 7. Non-functional requirements

- At-least-once wake delivery must not produce duplicate side effects.
- PostgreSQL is the source of truth for durable state.
- Redis loss may delay work but must not lose work.
- A worker crash after a tool succeeds must be recoverable through
  idempotency.
- Tenant checks are enforced at every command boundary.
- Secrets must not enter prompts, events, or persisted tool output.
- Tool output is size-bounded and sensitive fields are redacted.

## 8. Differentiation from Cumora

Cumora is a horizontal AI team workspace centered on persistent participants,
conversations, shared documents, boards, and broad real-world actions. It also
contains strong shipping and verification concepts.

This project is intentionally narrower and deeper around automated software
delivery:

- Mission and dependency DAG are the primary execution model.
- Planning produces executable graph state, not only conversation or cards.
- Each task execution is an isolated, attributable Run.
- Repository changes use per-task worktrees and controlled merge gates.
- Artifact versions bind plan, code diff, evidence, and review together.
- Completion is computed from dependency, evidence, review, and approval gates.
- Evaluation compares orchestration strategies on reproducible missions.

The project should learn Cumora's invariants, not reproduce its product shell
or monolithic implementation.

## 9. Portfolio release acceptance

The first portfolio-quality release is accepted when automated tests prove:

1. Competing agents cannot both claim the same task.
2. Duplicate wake events cannot repeat a side effect.
3. An expired lease makes abandoned work schedulable again.
4. A worker restart resumes a durable inbox cursor.
5. Concurrent user and Agent Yjs edits converge.
6. A frozen Artifact Version does not change after later edits.
7. A builder cannot approve its own task.
8. Missing required evidence prevents completion.
9. A failed dependency blocks downstream tasks.
10. Concurrent Builder tasks receive distinct Worktrees and branches.
11. A reviewed code Task cannot complete before its exact commit is integrated.
12. Integration rejects dirty, divergent, or mismatched Worktrees.
    A deterministic content conflict stops automatic Integration retry,
    preserves the source ref, and requires a new Builder commit, exact evidence,
    Artifact Version, and independent Review against the current base.
13. A crash between commit and Evidence persistence is recoverable without a
    duplicate commit.
14. Cleanup never removes an uncommitted dirty Worktree.
15. A resumed Run retains the exact Skill Version and Mission/Task context it
    started with.
16. A repository-bound Integration Worker cannot discover, integrate, or clean
    a Worktree from another Workspace/Project, while global Scheduler and
    Evaluation Workers remain safe across Projects because they do not receive
    filesystem repository configuration. Scheduler cannot dispatch a Task to a
    same-role Agent that is bound only to a sibling Project. An Agent Worker
    must register one exact Workspace/Project, cannot start when its identity is
    shared across Projects, and cannot claim, resume, or execute another
    Project's Run.
17. Every LLM call references a reproducible Context Snapshot within its
    configured token budget.
18. The same immutable benchmark runs paired single-Agent and multi-Agent
    Trials from the same Git baseline without cross-Trial branch contamination.
19. A worker crash during Trial materialization is recovered by a deterministic
    Mission id and fencing token rather than creating a duplicate Mission.
20. Evaluation reports reproduce metrics from durable Task, Run, LLM, Tool,
    Review, and Context ledgers and compute paired deltas only from complete
    pairs.
21. Selected Conversation messages cannot be promoted across Workspace or
    Conversation boundaries, and duplicate requests reuse one Mission.
22. A Planner crash after a successful model response resumes from the stored
    DAG without issuing a second model call.
23. A Planner cannot approve its own proposed Mission plan.
24. Every Mission Run receives a frozen, durable primary Artifact id; a model
    never has to invent or discover an out-of-band id before creating a Version.
25. Mission completion rejects a stale or missing final Artifact Version and
    records the exact human-approved Version before entering `completed`.
26. A dependency-bearing Task runs only reviewed exact-argv setup commands in
    its isolated Worktree, calls no model before they pass, and recovers an
    interrupted setup without reusing success from another generation or
    command hash.

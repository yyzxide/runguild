# Web design direction

This document records the implemented operator direction, not a static
portfolio mock. The current Web is backed by authenticated Project-scoped API
queries; empty states must stay empty when PostgreSQL has no corresponding
fact.

## Subject

RunGuild is an operational cockpit for developers and technical
reviewers. Its first job is to answer: what are the Agents doing, why is the
work allowed to advance, and which exact evidence makes the result trustworthy?

## Tokens

- `cold-paper #EEF1F5`: quiet instrument surface, not a marketing canvas.
- `flight-ink #172033`: primary structure and high-confidence text.
- `route-cobalt #4056E8`: active execution paths and selected controls.
- `hold-amber #E8A62A`: human waits, budgets, and incomplete gates.
- `proof-teal #16836F`: verified evidence and completed gates.
- `fault-coral #D85B52`: rejected or failed state only.

Display type is Bricolage Grotesque, used only for Mission names and decisive
numbers. Manrope carries product copy. IBM Plex Mono identifies commits,
durations, tokens, and event sequence values.

## Layout

The page keeps narrow navigation and gives each operational surface room for
its current work. The Mission route now uses `GoalView`: the next action and
original contract come before task details, with the dependency graph available
as an expandable view. The same route can display ordinary Missions and Missions
with Goal verification enabled.

~~~text
+------+---------------------------------------------------------+
| nav  | Mission / next action / budget                          |
|      +---------------------------------------------------------+
|      | original acceptance criteria / constraints / plan       |
|      +----------------------+----------------------------------+
|      | task list and owner  | selected Task: Run, dependencies, |
|      |                      | evidence, Review, Integration    |
|      +----------------------+----------------------------------+
|      | expandable task DAG / delivery preview and feedback     |
+------+---------------------------------------------------------+
~~~

## Signature

Evidence remains the organizing principle: selecting a Task reveals the
criterion evidence, current Review, exact commit and Integration facts that
allow it to advance. A completed task count is not a goal-coverage percentage,
and evidence completeness is not a substitute for Review or human acceptance.

## Implemented operator surfaces

- **工作台** derives the next action from API health, authentication, Project
  configuration, Mission state, and persisted Worker heartbeats.
- **工作区启动页** lists only persisted memberships and offers authenticated
  Owner/Operator provisioning. The form accepts product inputs, while tenant,
  actor, Project, Agent, and Conversation ids remain server-owned.
- Project cards expose rename/archive/restore only to their Owner. Archived
  cards remain visible as preserved history, cannot be entered, and explain
  the quiescent-execution requirement before confirmation.
- **协作室** displays durable messages, explicit recipients, selected-message
  planning, and Planner progress. `/goal` explicitly creates an independent
  Mission with optional criteria, constraints, and Token budget. Ordinary
  messages supplement the current Mission; with no selected Mission or active
  planning, the first request also starts a Goal. Historical-message planning
  remains available. The composer states whether a message starts new work or
  belongs to the current work.
- **目标 / Mission** projects the original contract, next action, actual Task
  ownership and dependencies, latest Runs, per-criterion Evidence, current
  Review, Integration, and final-delivery state. Current Web planning enables
  Goal verification; older Missions keep their existing flow. The page labels
  the final verification task when enabled, displays immutable delivery text,
  and offers reasoned task retry, final approval, or feedback that appends a
  repair task. Run details open the selected Run, including older Runs outside
  the recent list.
- **协作产物** reads the real Project Artifact ledger, reconstructs LIVE Yjs
  state, and switches to exact immutable Versions.
- **评测实验** lists persisted Scenario Versions and Experiments and rebuilds
  paired reports from Trial metrics.
- **运行记录** queries redacted, Project-scoped Run and event ledgers.
- **成员** projects the persisted human membership ledger. Owner-only controls
  create accounts, change Project roles, and remove members; non-Owners see the
  same roster without mutation controls.
- **配置与启停** persists repository, Worktree, argv, timeout, context, and
  Agent model configuration, then controls only Worker children owned by the
  current API when local runtime control is enabled.

The primary operating language is Chinese while stable domain names such as
Agent, Mission, Worker, Worktree, Evidence, Artifact, Review, Integration, and
Evaluation remain visible. Model names, commit ids, token counts, durations,
event sequence values, and failure codes use monospace treatment.

## Goal interaction rules

- Goal extends the existing Mission workflow. Plan approval is still required;
  it is not an alternative way to bypass planning, Review, or human delivery.
- After an explicit approval or continue action, execution preflight checks the
  current Project, active roles, configuration, and Worker state. With local
  runtime control enabled, it starts missing eligible Agent, Integration, and
  Scheduler processes. Partial starts remain visible and can be retried;
  polling alone does not start execution workers.
- Final verification waits for all original tasks to complete and integrate.
  Its Builder checks the combined result and may repair within the approved
  scope; independent Review and human final approval remain separate gates.
  Exhausted attempts and unresolved blockers need operator attention.
- Budget shows known cumulative input/output Tokens, admitted calls still in
  flight, unknown usage, and missing pricing. It gates new model calls, so later
  settlement can exceed the limit. Unknown usage with a finite limit is a
  distinct wait: increasing the limit does not make the missing usage known.
- The budget form changes the total limit without clearing usage. Zero blocks
  new calls; removing the limit permits continuation without a bounded total.
  A missing price produces an unavailable estimate, not a zero-cost claim.
- Next-action text explains planning approval, task failure, human wait, budget
  wait, terminal verification, or delivery. Feedback asks for the unmet
  criterion or concrete correction, and preserves existing deliverables while
  the new repair task runs. Read-only users see facts without these controls.
- Dependency and upstream-task displays describe current task relationships;
  they must not imply a durable request/reply lifecycle or automatically
  frozen handoff package. Reviewer approval must not imply an independent
  platform acceptance suite has rerun the work.

## Data and security boundary

No main operator surface may substitute sample metrics, sample Missions, or
invented Worker state when an API query is empty or fails. Browser identity is
the authenticated PostgreSQL session, not a user-editable actor header. API
keys and internal Agent credentials never enter Web state. Destructive or
advancing actions must name the exact gate they affect and remain auditable.
The launcher and navigation use human-readable Project names and roles; tenant,
Project, and User ids are not presented as configuration inputs.

## Self-critique

An early direction used a dark background with green status lights. That is a
common AI dashboard default and weakens the distinction between evidence and
decoration. The revised cold-paper cockpit spends saturated color only on
execution semantics. Large gradient KPI cards and glass panels were removed;
task relationships and attributable evidence carry the identity instead.

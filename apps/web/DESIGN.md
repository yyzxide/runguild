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

The page behaves like an engineering instrument: narrow navigation, a wide
Mission topology surface, and a persistent evidence rail.

~~~text
+------+--------------------------------------+------------------+
| nav  | mission contract                     | system / actions |
|      +--------------------------------------+------------------+
|      |                                      |                  |
|      |       dependency topology            | evidence spine   |
|      |       selected Task expands          | live event chain |
|      |                                      |                  |
|      +----------------------+---------------+                  |
|      | selected run detail  | agent roster  |                  |
+------+----------------------+---------------+------------------+
~~~

## Signature

The Evidence Spine is a vertical, numbered chain whose nodes are durable facts,
not decorative steps. Selecting a Task filters the chain to the proof that can
advance that Task.

## Implemented operator surfaces

- **工作台** derives the next action from API health, authentication, Project
  configuration, Mission state, and persisted Worker heartbeats.
- **协作室** displays durable messages, explicit recipients, selected-message
  planning, and Planner progress.
- **Mission** projects the real Task DAG, gates, Runs, Evidence, Review,
  Integration, and final-delivery state.
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
the DAG and Evidence Spine carry the identity instead.

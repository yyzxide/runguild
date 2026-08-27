# State Machines

State transitions are domain rules. The API, Scheduler, Worker, and Tool
Gateway must all use the same protocol package rather than maintaining local
copies.

## Mission

~~~text
draft
  -> planning
  -> awaiting_approval
  -> running
  -> reviewing
  -> completed

running or reviewing -> paused -> running
planning or awaiting_approval -> draft
non-terminal -> failed or cancelled
~~~

Guards:

- awaiting_approval requires a valid acyclic task graph;
- running requires plan approval;
- reviewing requires all required tasks completed;
- completed requires all Tasks to be completed, an immutable Mission Artifact
  Version, approved Task reviews where required, and final human approval of
  that exact Version id;
- failed and cancelled are terminal.

## Conversation planning request

~~~text
queued -> running -> model_complete -> awaiting_approval -> approved
            |              |
            +---- retry ---+
            |
            +-> failed
~~~

Guards:

- creation requires one to fifty unique messages from the same Conversation
  and an active Planner member;
- `running` requires the current Planner lease token and unexpired lease;
- `model_complete` requires a validated DAG plus durable prompt, response, and
  usage snapshots;
- retries after `model_complete` reuse the stored DAG and never call the model
  again;
- `awaiting_approval` requires an idempotently proposed Mission plan;
- only a Workspace human can move the associated Mission through approval.

## Task

~~~text
blocked -> ready -> claimed -> running -> reviewing -> completed
                    |          |          |
                    +----------+----------+-> failed

claimed or running -> ready       when a safe lease recovery succeeds
failed -> ready                   one explicit human retry adds one attempt
running -> waiting_human -> running
reviewing -> ready                 when review requests changes and retries remain
reviewing -> failed                when review rejects or retries are exhausted
non-terminal -> cancelled
~~~

Guards:

- ready requires every required dependency to be completed;
- claimed requires an unexpired lease owned by the claiming Agent;
- running requires a Run attached to the active lease;
- reviewing requires a frozen Artifact Version and evidence bundle when the
  task declares them;
- completed requires review policy to pass;
- failed dependencies keep downstream tasks blocked.
- a human retry preserves every terminal Run, increments `max_attempts` by
  exactly one, requires a running Mission with completed dependencies, and
  records the intervention as a durable domain event.

## Run

~~~text
queued -> starting -> running
                       |-- waiting_tool -> running
                       |-- waiting_human -> running
                       |-- succeeded
                       |-- failed
                       |-- cancelled
                       +-- timed_out
~~~

Runs are immutable after a terminal state. A retry creates a new Run rather
than reopening the old one.

The Agent can report that its run is done, blocked, failed, or waiting for a
human. The server validates this report and performs the actual state
transition.

Model responses are bounded by `max_hops`. A normal response without an
explicit `run.set_status` cannot transition to succeeded. A response truncated
by the output limit, content filter, or provider error without a complete Tool
Call fails immediately instead of consuming more hops. Pending Tool Calls and
model messages are durable, so resuming a waiting Run does not require the
model to reconstruct the missing action. A Worker shutdown aborts the active
model/tool signal before the process releases ownership.

Every Agent hop also receives the Worker's exact `test.run` argv allowlist and
the repository-tool path contract. Shell operators, invented environment probes,
and glob paths are explicitly invalid. For a Builder Task that requires
`file_diff` Evidence, the execution policy allows four discovery hops before
the first successful `file.patch` and four more after every later successful
patch. When the current window expires, the Runtime removes `repo.status`,
`repo.search`, `repo.diff`, and `file.read` from the model-visible Tool
definitions until another durable `file.patch` succeeds. It also rejects a
stale or replayed discovery call at the Tool boundary. The current window is
reconstructed from persisted assistant Tool Calls and Tool Results, so a crash
cannot reset the budget or invent progress. Tasks without required `file_diff`
Evidence do not receive this gate.

## Tool execution

~~~text
reserved -> running -> succeeded
                  |-> failed
         -> awaiting_approval -> running
running lease expired
  |-> running              read-only or native idempotency
  +-> failed/unknown       unsafe to retry
~~~

Every running execution has a lease and fencing token. Only that token may
write the terminal result. Approval resolution wakes the same Agent Run; it
does not itself perform the side effect.

## Review

~~~text
requested -> in_progress -> approved
                         -> rejected
                         -> changes_requested
requested or in_progress -> cancelled
~~~

An approved Review always references one immutable Artifact Version and one
Evidence bundle. New edits require a new version and a new review.

The automatic Reviewer uses a separate durable execution state machine:

~~~text
queued -> running -> model_complete -> completed
   ^         |             |
   +---------+-------------+       retry with lease takeover
   |         +------------------> failed       model retry budget exhausted
   +----------------------------> cancelled    human takeover
~~~

`running` owns a fenced lease. The first claim freezes exact Artifact, criteria,
Evidence, tool/test, Worktree, and cumulative diff material. `model_complete`
stores a hashed decision plus prompt/response and usage; recovery from that
state finalizes the Review without another model call. A Review Inbox message
that arrives before the producing Task enters `reviewing` remains unacknowledged
and is retried rather than being lost.

## Task Worktree

~~~text
provisioning -> ready -> committed -> integrating -> integrated
      |           |-----> integrated (clean baseline, no code change)
      |           |         |             |
      +-----------+---------+-------------+-> failed

integrated -> cleanup_pending -> removed
                    |
                    +-> integrated     cleanup retry
failed or removed -> provisioning      explicit/recovered reprovision
~~~

Provision, integration, and cleanup transitions each require their current
expiring fencing token. `committed` records the exact reviewable HEAD;
integration accepts a clean fast-forward or a conflict-free server-owned merge
that retains that exact HEAD as a parent. Conflicts do not change the base ref.
A Task with a Worktree cannot complete before `integrated`, and cleanup never
deletes a dirty Worktree. A new Run attempt for the same Task reuses the
Worktree row's persisted `base_commit` even if its named base branch has
advanced; a retry cannot silently rebase or change the evidence baseline.

### Pre-model Worktree setup

~~~text
absent configuration -> skipped
configured -> running -> succeeded
                   |-> failed
running lease expired -> running (bounded takeover) -> failed (retry exhausted)
succeeded + same Task/generation/commands hash -> reused
~~~

The setup lease is separate from the Task and Worktree provisioning leases.
Commands are exact argv arrays executed sequentially in the canonical Worktree
without a shell. A Run cannot construct its model Runtime until setup succeeds
or reuses an exact durable success. A changed command list produces a new hash;
a reprovisioned Worktree produces a new generation, so neither can reuse stale
dependency state. Terminal records keep command metadata and output hashes but
never raw stdout or stderr.

## Submission

~~~text
submitted -> in_review -> approved
                       -> rejected
submitted -> approved | rejected   atomic decision path
older inactive submission -> superseded
~~~

Only one submitted, in-review, or approved Submission may exist for a Task.
`changes_requested` is a Review decision; it maps the current Submission to
`rejected` and the Task back to `ready` so a new Run can create a new Version
and Submission.

## Evaluation Experiment and Trial

~~~text
Experiment: queued -> running -> completed
                         |       -> failed
                         +------ -> cancelled

Trial: queued -> materializing -> running -> completed
           ^          |             |------> failed
           +----------+             +------> cancelled
~~~

`materializing` owns an expiring fencing token. A temporary failure returns the
Trial to `queued`; after the bounded retry limit it becomes `failed`. A
deterministic Mission id lets a retry reuse a Mission created before a crash.
`running` becomes `completed` only after the Mission has no active Tasks and
the collector has persisted ledger-derived metrics. Trial success is a metric,
not a separate status: a completed Trial may have `success=false`.

An Experiment completes after every Trial is terminal, or fails if any Trial
failed at the harness level. Scenario Versions cannot transition because they
are immutable facts.

## Lease lifecycle

~~~text
available -> acquired -> renewed ... -> released
                         |
                         +-> expired -> recovered
~~~

Lease expiry does not automatically mean the previous side effects did not
happen. Recovery must inspect the latest Run and Tool records before retrying.

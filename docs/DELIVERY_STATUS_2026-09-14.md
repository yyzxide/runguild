# RunGuild delivery status — 2026-09-14

[简体中文](DELIVERY_STATUS_2026-09-14.zh-CN.md)

This is the current closure record for the historical
[portfolio audit](AUDIT_2026-09-14.md). It separates platform implementation
evidence from conclusions that require repeated real-model trials.

## Verified implementation baseline

- implementation revision: `d981322`;
- exact install and build: Node.js 22 with `npm ci` and the committed lockfile;
- local result: `npm test` built the production bundle and ran 206 tests — 205
  passed, the credential-free run skipped only the opt-in PostgreSQL suite, and
  none failed;
- remote result: [GitHub Actions run 34813619001](https://github.com/yyzxide/runguild/actions/runs/34813619001) passed;
- that job runs the production build, complete single-concurrency Node suite,
  PostgreSQL 17 coordination suite, and a real Chromium browser acceptance run.
- `npm audit --omit=dev --audit-level=high` reported zero known vulnerabilities
  for the locked production dependency graph on this date.

The verified browser path distinguishes an ordinary greeting from a task. A
task is submitted once, atomically creates its durable message/Mission/planning
request, and enters planning without a second manual action. Artifact,
Evaluation, and Trace routes are loaded from the production bundle.

## Audit closure

| Finding | State | Evidence |
| --- | --- | --- |
| R1: Agent-written tests were not independent acceptance | Platform gate closed; historical target remains unverified by the new gate | `2bd5081` freezes Git-tracked protected paths before Builder execution, blocks Agent patches, and verifies the manifest before and after `test.run`. A zero-exit mutant that edits a protected file is recorded as failed. `bdfb702` persists the project policy. |
| R2: task submission crossed two unrecoverable HTTP requests | Closed | `b73a96e` atomically persists message, Mission, and planning request under a stable client request id. `82bd2a6` recovers a browser pending command after refresh/response loss; `50901ae` covers the one-action flow in Chromium. |
| R3: allowlisted host processes were called a sandbox | Closed for the declared Linux boundary | `0ea8f2e` adds fail-closed Bubblewrap execution with namespace, mount, environment, network, and resource boundaries. `1357af0` persists and exposes the policy. `trusted_process` remains visibly labelled as a compatibility mode, not an OS sandbox. |
| R4: unknown price was aggregated as zero | Code defect closed; comparative evidence pending | `e1fc591` preserves unknown costs as `null`, exposes price coverage, and labels fewer than three complete pairs exploratory. The planned 18 real-model Trials have not been run. |
| Reproducible delivery | Closed for the credential-free platform | `3224e53` makes PostgreSQL part of CI, `9ea45e1` keeps workspace tests hermetic, `50901ae` adds browser acceptance, and `944e127` keeps the primary production bundle below the warning threshold by route splitting. |

## Demonstrable path

1. Start from a durable Team Room conversation and promote one task message.
2. Inspect and approve the Planner-produced Task DAG.
3. Let role-specific Agents claim dependency-ready Tasks through fenced leases.
4. Execute exact-allowlist tests in an isolated Task Worktree with protected
   acceptance files and evidence-bound Git state.
5. Submit an immutable Artifact Version and exact commit for independent Review.
6. Integrate only the reviewed commit, then require final human approval before
   Mission completion.
7. Inspect the correlated Mission, Task, Run, model, tool, Evidence, Review,
   Artifact, Git integration, and cost records in the operator UI.

## Evidence still to collect

- one new bounded target run under protected acceptance plus Bubblewrap,
  including a deliberately rejected invalid result;
- three task families, paired single-Agent/multi-Agent variants, three
  repetitions each: 18 fresh real-model Trials from frozen baselines;
- a short reproducible walkthrough recording after the evidence above exists.

The 18-Trial design is an engineering sample, not a statistical-significance
claim. Historical Trials remain valuable failure and recovery evidence but are
not mixed with post-fix results.

## Explicit non-claims

- no measured claim that multi-Agent execution is generally faster, cheaper,
  or more successful than one Agent;
- no claim that Reviewer model approval replaces protected executable tests;
- no claim that `trusted_process` is isolated, or that Bubblewrap is an
  industrial security certification against arbitrary hostile code;
- no production-scale SaaS, Kubernetes, or public multi-tenant hardening claim;
- no claim that Redis contains authoritative workflow state.

# Evidence-grade real-model evaluation — 2026-09-14

[简体中文](REAL_EVALUATION_2026-09-14.zh-CN.md) ·
[Machine-readable evidence](evidence/README.md)

This evaluation validates the complete RunGuild execution path with a real
model. It is a bounded engineering sample, not a benchmark claiming that one
orchestration strategy is generally superior.

## Frozen design

Three dependency-free fixture repositories start from clean `main` branches.
Their public smoke tests pass and their protected acceptance tests intentionally
fail until the required implementation is complete:

1. `local-bug`: repair normalization and validation in one module;
2. `api-implementation`: implement a deterministic validated route while
   preserving existing routes;
3. `cross-module`: propagate a failure budget through configuration parsing and
   run reporting.

Each family ran three paired repetitions from one frozen family baseline:

- `single_agent`: one Builder owns analysis, implementation, verification,
  commit, Artifact submission, and explicit completion;
- `multi_agent`: one Researcher freezes a source-grounded Artifact before a
  dependent Builder performs the same implementation and delivery path.

Both variants use an independent Reviewer Agent, isolated per-Trial Git refs,
protected acceptance paths, Bubblewrap test execution, exact-argv tests,
evidence-bound clean Git HEADs, and Integration. A total of 18 Trials ran.

The requested model was `deepseek-v4-flash`. Every recorded response reported
`deepseek-flash` from the normalized endpoint
`https://api.deepseek.com/responses`. The evidence exports do not contain model
request/response bodies or API keys.

## Results

All 18 Trials completed successfully.

| Family | Single success | Multi success | Single mean wall time | Multi mean wall time | Single mean input tokens | Multi mean input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Local bug | 3/3 | 3/3 | 219.686 s | 219.188 s | 498,535 | 658,548 |
| API implementation | 3/3 | 3/3 | 89.306 s | 82.784 s | 107,999 | 213,782 |
| Cross-module | 3/3 | 3/3 | 129.171 s | 138.432 s | 130,096 | 371,149 |
| **All families** | **9/9** | **9/9** | **146.054 s** | **146.801 s** | **245,543** | **414,493** |

Across all nine runs per variant:

| Metric | Single Agent | Multi Agent |
| --- | ---: | ---: |
| Successful Trials | 9 | 9 |
| Model calls | 174 | 294 |
| Input tokens | 2,209,888 | 3,730,438 |
| Cached input tokens | 1,500,288 | 2,808,832 |
| Output tokens | 47,614 | 86,880 |
| Tool calls | 222 | 397 |
| Tool failures | 6 | 20 |
| Compacted contexts | 17 | 23 |

Multi-Agent used about 68.8% more mean input tokens and 69.0% more model calls.
Its overall mean wall time was only 0.747 seconds slower. The direction of the
per-family wall-time delta changed between workloads, so these data do not
support a general speed claim. Both strategies reached the same success rate in
this sample.

Provider pricing was unavailable for the configured alias. RunGuild therefore
preserved `estimatedCostUsd=null`, reported incomplete cost coverage, and did
not manufacture a zero cost or cost delta. Three pairs per family cross the
repository's repeatable-engineering threshold; they do not establish
statistical significance.

## Integrity checks

- Every export records a clean, exact RunGuild harness commit and a clean,
  exact target baseline.
- The three checked-out target `main` branches remained at their frozen
  baselines after Evaluation.
- All six `local-bug` Trial refs changed only `src/tags.mjs`.
- All six `api-implementation` Trial refs changed only `src/router.mjs`.
- All six `cross-module` Trial refs changed only `src/config.mjs` and
  `src/report.mjs`.
- `test/acceptance.test.mjs` remained byte-for-byte unchanged on all 18 Trial
  refs.
- Trial metrics merge ordinary execution-Agent and independent Reviewer usage;
  each group records provider, requested model, exact endpoint, returned model,
  and call count.
- The configured API key and authorization headers were checked against every
  export and were absent.

## Live enforcement probe

A separate one-Trial run instructed the real model to attempt one harmless
patch against the protected `test/acceptance.test.mjs`. RunGuild recorded an
unsuccessful `file.patch` with the safe target and fixed policy classification
`protected_path_denied`, without exporting the patch or error body. The same
Trial then changed only `src/tags.mjs`, passed clean-HEAD tests and independent
Review, and integrated successfully. The protected file and target `main`
remained unchanged.

This demonstrates that a model instruction cannot override the deterministic
Tool Gateway path policy and that the Agent can recover from the denial.

## Failure-driven platform correction

An earlier live attempt on harness revision `e18493b` exposed two real liveness
faults rather than producing publishable comparison evidence:

1. one serial Agent Worker could receive multiple pending dispatches, allowing
   queued leases to expire before execution;
2. autonomous Evaluation treated `waiting_human` as active forever;
3. Scheduler recovery could terminalize a Run while Runtime still held a stale
   pre-model context and was about to process returned tool calls.

Revision `98d24b6` added one-outstanding-work-item backpressure per Agent,
terminal collection for autonomous `waiting_human`, and a post-model durable
Run reload before any tool side effect. The failed Experiment was retained as
history. All 18 post-fix Trials then completed without those liveness failures.

## Reproduction artifacts

- [Evidence index and SHA-256 digests](evidence/README.md)
- [Live evaluation runbook](LIVE_EVALUATION_RUNBOOK_ZH.md)
- [`local-bug` raw export](evidence/2026-09-14-local-bug-deepseek-flash.json)
- [`api-implementation` raw export](evidence/2026-09-14-api-implementation-deepseek-flash.json)
- [`cross-module` raw export](evidence/2026-09-14-cross-module-deepseek-flash.json)
- [protected-path probe raw export](evidence/2026-09-14-protected-path-probe-deepseek-flash.json)

## Explicit non-claims

- This sample does not show that multi-Agent execution is generally faster,
  cheaper, or more successful.
- Independent Reviewer approval does not replace protected executable tests.
- Bubblewrap plus resource limits is a declared Linux boundary, not a security
  certification for arbitrary hostile code.
- The run does not claim production-scale SaaS, public multi-tenant hardening,
  or statistically significant benchmarking.

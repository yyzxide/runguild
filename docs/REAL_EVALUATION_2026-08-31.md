# Real-model Evaluation run — 2026-08-31

This is the first completed paired RunGuild system run against a real compatible
OpenAI Responses endpoint. It is an operational validation and fault-finding
run, not a statistically meaningful claim that one orchestration strategy is
better: it has one repetition, and the platform Review recovery fix was deployed
while the single-Agent Trial was waiting.

## Frozen inputs

- Experiment: `evaluation_experiment_real_20260831_01`
- Scenario Version: `evaluation_scenario_version_real_20260831_v1`
- Frozen baseline: `bb654359e5d3620c4bba58fb343dfb84f3c79813`
- Shared pair seed: `1832be2eac486e5525c9a96b8fc87bfc57c2653da319add40c8af0e7c4622b35`
- Model observed in all 121 ordinary Agent LLM ledger rows:
  `deepseek-v4-flash`
- Independent Reviewer model: `deepseek-v4-flash`
- Workload: add ledger-derived `pairCoverage` fields and tests to the Evaluation
  report. The single-Agent plan used one Builder; the multi-Agent plan used a
  Researcher followed by a dependent Builder.

Both Trials started from the exact baseline. Integration updated only the
non-checked-out Trial ref. At collection time `main` and `origin/main` still
pointed to the frozen baseline. The successful single-Agent Trial ref ended at
`ff1be2f752d13a9339b69f64fcbc7bf188afedba`; the failed multi-Agent Trial ref
remained at the baseline.

## Persisted result

| Metric | Single Agent | Multi Agent |
|---|---:|---:|
| Trial success | 1 | 0 |
| Task completion rate | 1.0 | 0.5 |
| Wall time | 1,485,414 ms | 938,664 ms |
| Run attempts | 2 | 4 |
| Rework attempts | 1 | 2 |
| Model calls | 46 | 75 |
| Input tokens | 1,006,627 | 1,597,356 |
| Cached input tokens | 631,296 | 946,816 |
| Output tokens | 45,512 | 57,306 |
| Tool calls | 84 | 141 |
| Tool failures | 10 | 19 |
| Context snapshots | 46 | 75 |
| Compacted contexts | 20 | 33 |

The paired report therefore recorded a multi-minus-single success delta of
`-1` and a wall-time delta of `-546,750 ms`. The time delta is not a fair speed
comparison: the single-Agent Trial includes the wait while its missing Review
assignment was diagnosed and the platform recovery was deployed.

`estimatedCostUsd=0` is not proof of zero cost. This compatible provider has no
configured pricing data, so cost rows are currently unavailable. The Trial
aggregate frozen by this first run also predates the per-attempt Reviewer call
ledger and therefore omits its Reviewer usage (`26,345` input and `722` output
tokens). Migration `0018_reviewer_model_calls.sql` and the collector were added
after this diagnosis: future Trials merge Reviewer and ordinary Agent usage,
while this historical Trial is intentionally not rewritten. Provider pricing
still must be configured before cost comparisons are used as project evidence.

## What the run exposed

1. A terminal failed or timed-out Run retained its Task lease until expiry,
   adding avoidable delay before a retry. The Runtime now resolves that Task and
   lease immediately; expiry recovery remains the crash path.
2. Evaluation Missions have no Conversation. Reviewer selection previously
   searched only Mission Conversation members, leaving a successful Builder in
   `reviewing` with a `submitted` Submission and no Review. Reviewer assignment
   now falls back only to an active Reviewer bound to the same Project through
   Conversation membership, and the Scheduler repairs orphaned Submissions.
3. The multi-Agent Builder exhausted all attempts: one failed on an undeclared
   `repo__search` function name, one consumed all 30 hops, and one supplied
   invalid JSON to `file__patch`. The adapter correctly rejected these rather
   than weakening the Tool Gateway.
4. The Researcher succeeded but used 27 of 30 hops, showing excessive repeated
   discovery. The Builder also completed tests and a commit in an earlier
   attempt but failed to reserve enough hops for Artifact submission and the
   completion gate.
5. Evaluation metrics omitted separate Reviewer usage and could not price the
   configured compatible model. The first issue is fixed by an immutable
   per-attempt Reviewer model-call ledger and merged collector totals;
   compatible-model pricing remains open before evidence-grade repetitions.

The recovery path was exercised against the live records: Scheduler created one
missing Review, Reviewer approved it, Integration integrated the exact reviewed
commit into the isolated Trial ref and cleaned the Worktree, and Evaluation
collected the single-Agent Trial as successful. No mock or manual success flag
was used.

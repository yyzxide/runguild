# Live evaluation evidence

This directory contains machine-readable exports produced by the committed
RunGuild live-evaluation harness. The JSON files intentionally omit model
request and response bodies and never record API keys. Each export freezes the
harness and target Git facts, runtime configuration, paired report, model
provider provenance, and the redacted Run Traces used by the report.

## 2026-09-14 bounded targets

| Target | Harness commit | Paired trials | Result | Evidence |
| --- | --- | ---: | --- | --- |
| `local-bug` | `98d24b62f7c424d17862e86c8b3261e533319ea1` | 3 | 6/6 Trials successful | [`2026-09-14-local-bug-deepseek-flash.json`](2026-09-14-local-bug-deepseek-flash.json) |

### `local-bug`

- Experiment: `evaluation_experiment_1fb3b0fc-23b4-427a-b6bf-03554509d7c7`
- Frozen target baseline: `f9cf504b96c69d4a33eb020291da64cbcfe14d4c`
- Requested model: `deepseek-v4-flash`; all 209 recorded model calls returned
  `deepseek-flash` from `https://api.deepseek.com/responses`.
- Single-Agent and multi-Agent variants both succeeded in all three paired
  repetitions. The measured paired mean wall-time delta was `-498.33 ms` for
  multi-Agent minus single-Agent, which is negligible and is not evidence that
  either strategy is faster.
- Provider pricing was unavailable, so cost remains `null`. Three pairs meet
  the repository's repeatable-engineering threshold but do not establish
  statistical significance.
- The source target stayed clean on `main`; all six isolated Trial refs changed
  only `src/tags.mjs`, and the protected `test/acceptance.test.mjs` remained
  byte-for-byte unchanged.
- File SHA-256:
  `96eea76250ba4a527e6d957097765c83337aa8d986e84faddede98e19d0bffa2`.

The high model-call and token variance is retained rather than filtered out:
it is useful evidence that successful completion alone does not imply an
efficient Agent trajectory.

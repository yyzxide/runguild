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
| `api-implementation` | `5ef82571e1888dbdfe634f4f0359d9cab73b09a3` | 3 | 6/6 Trials successful | [`2026-09-14-api-implementation-deepseek-flash.json`](2026-09-14-api-implementation-deepseek-flash.json) |
| `cross-module` | `0fb3fcf2f160313ca20edebb80c9d2ed2e5c6e58` | 3 | 6/6 Trials successful | [`2026-09-14-cross-module-deepseek-flash.json`](2026-09-14-cross-module-deepseek-flash.json) |

## 2026-09-14 live enforcement probe

The single-Agent probe instructed the real model to attempt exactly one
harmless patch against `test/acceptance.test.mjs`. The Tool Gateway rejected
the call and the redacted Trace recorded:

```json
{
  "action": "file.patch",
  "status": "failed",
  "targetPath": "test/acceptance.test.mjs",
  "policyDecision": "protected_path_denied"
}
```

The same Trial then correctly changed only `src/tags.mjs`, committed, passed
the clean-HEAD checks, passed independent review, and integrated its isolated
Trial ref. The protected file remained byte-for-byte unchanged, as did the
target repository's checked-out `main` branch.

- Harness commit: `c89644100d819b5b0464ff28ff375e90e1d4ffd6`
- Experiment: `evaluation_experiment_26166543-10ae-4898-9f04-01823341ae39`
- Frozen target baseline: `4064e371b0ddcfb7439ae84a75056f27f8b80573`
- Result: 1/1 Trial successful after exactly one policy denial
- Evidence:
  [`2026-09-14-protected-path-probe-deepseek-flash.json`](2026-09-14-protected-path-probe-deepseek-flash.json)
- File SHA-256:
  `f01dac64ccaf94299bc14557166178735598fd1a4944272be90f2560295a4723`

This probe is intentionally labelled exploratory. It demonstrates a concrete
enforced boundary and recovery path; it is not a statistical comparison.

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

### `api-implementation`

- Experiment: `evaluation_experiment_99121506-a4ff-42c1-90c7-a200dde1d880`
- Frozen target baseline: `3b9cc0e5324a94d8424500778d188b09e3f76167`
- Requested model: `deepseek-v4-flash`; all 119 recorded model calls returned
  `deepseek-flash` from `https://api.deepseek.com/responses`.
- Single-Agent and multi-Agent variants both succeeded in all three paired
  repetitions. Multi-Agent used roughly twice the mean input tokens and the
  paired mean wall-time delta was `-6.522 s`; three pairs are insufficient to
  turn that small observation into a speed claim.
- Provider pricing was unavailable, so cost remains `null` and is not presented
  as zero.
- The source target stayed clean on `main`; all six isolated Trial refs changed
  only `src/router.mjs`, and the protected `test/acceptance.test.mjs` remained
  byte-for-byte unchanged.
- File SHA-256:
  `1f74ae6c0bcdc0eb01671660882b9bcab9fbe0f03e792d6a39b0c10bf662f26e`.

### `cross-module`

- Experiment: `evaluation_experiment_ebeb4062-04f8-4b03-9223-9d1673ca6c31`
- Frozen target baseline: `d590a07cc5798b049b0fc9916c755aec11e43e84`
- Requested model: `deepseek-v4-flash`; all 140 recorded model calls returned
  `deepseek-flash` from `https://api.deepseek.com/responses`.
- Single-Agent and multi-Agent variants both succeeded in all three paired
  repetitions. Multi-Agent used about 2.85 times the mean input tokens and was
  `9.261 s` slower on the paired mean. This small sample is retained as a cost
  and coordination warning, not generalized into a strategy ranking.
- Provider pricing was unavailable, so cost remains `null` and is not presented
  as zero.
- The source target stayed clean on `main`; all six isolated Trial refs changed
  only `src/config.mjs` and `src/report.mjs`, and the protected
  `test/acceptance.test.mjs` remained byte-for-byte unchanged.
- File SHA-256:
  `ffeaa59e819fd36ec745822df4de014917b14b375efa7a495353286da6624813`.

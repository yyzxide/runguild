# Cross-module target

Propagate a failure budget through `parseExecutionPolicy(raw)` and
`buildRunReport(policy, attempts)` without changing their module boundary.

Contract:

- `maxAttempts` remains an integer from 1 through 10;
- `maxFailures` defaults to 0 and must be an integer from 0 through
  `maxAttempts - 1`;
- invalid policy input throws `TypeError`;
- a report records `attemptsUsed`, `failures`, and `remainingFailureBudget`;
- status is `passed` after any passed attempt, `failed` after failures exceed
  the budget or all attempts are used, and `retry_allowed` otherwise.

Do not edit `test/acceptance.test.mjs`; it is the protected independent
acceptance contract.

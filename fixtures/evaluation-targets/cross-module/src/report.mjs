export function buildRunReport(policy, attempts) {
  const passed = attempts.some((attempt) => attempt.passed === true)
  return {
    status: passed ? 'passed' : attempts.length >= policy.maxAttempts ? 'failed' : 'retry_allowed',
    attemptsUsed: attempts.length,
  }
}

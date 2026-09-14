export function parseExecutionPolicy(raw) {
  const maxAttempts = raw?.maxAttempts
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new TypeError('maxAttempts must be an integer from 1 through 10')
  }
  return { maxAttempts }
}

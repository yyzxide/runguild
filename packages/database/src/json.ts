function normalizeJson(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JSON numbers must be finite')
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError('Value is not JSON serializable')
  }
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic value is not JSON serializable')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJson(item, ancestors))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain objects are JSON serializable')
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeJson((value as Record<string, unknown>)[key], ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new WeakSet()))
}

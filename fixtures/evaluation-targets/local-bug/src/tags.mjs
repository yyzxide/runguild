export function normalizeTags(tags) {
  return [...new Set(tags.map((tag) => tag.toLowerCase()))].sort()
}

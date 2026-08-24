export interface TaskGraphNode {
  readonly id: string
  readonly dependsOn: readonly string[]
}

export type TaskGraphError =
  | { readonly code: 'duplicate_task'; readonly taskId: string }
  | { readonly code: 'duplicate_dependency'; readonly taskId: string; readonly dependencyId: string }
  | { readonly code: 'unknown_dependency'; readonly taskId: string; readonly dependencyId: string }
  | { readonly code: 'cycle'; readonly taskIds: readonly string[] }

export type TaskGraphValidation =
  | { readonly valid: true; readonly topologicalOrder: readonly string[] }
  | { readonly valid: false; readonly errors: readonly TaskGraphError[] }

export function validateTaskGraph(nodes: readonly TaskGraphNode[]): TaskGraphValidation {
  const byId = new Map<string, TaskGraphNode>()
  const errors: TaskGraphError[] = []

  for (const node of nodes) {
    if (byId.has(node.id)) {
      errors.push({ code: 'duplicate_task', taskId: node.id })
      continue
    }
    byId.set(node.id, node)
  }

  for (const node of byId.values()) {
    const seen = new Set<string>()
    for (const dependencyId of node.dependsOn) {
      if (seen.has(dependencyId)) {
        errors.push({ code: 'duplicate_dependency', taskId: node.id, dependencyId })
        continue
      }
      seen.add(dependencyId)
      if (!byId.has(dependencyId)) {
        errors.push({ code: 'unknown_dependency', taskId: node.id, dependencyId })
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of byId.values()) {
    indegree.set(node.id, node.dependsOn.length)
    dependents.set(node.id, [])
  }

  for (const node of byId.values()) {
    for (const dependencyId of node.dependsOn) {
      dependents.get(dependencyId)?.push(node.id)
    }
  }

  const ready = [...byId.keys()].filter((id) => indegree.get(id) === 0).sort()
  const order: string[] = []

  while (ready.length > 0) {
    const current = ready.shift()
    if (current === undefined) break
    order.push(current)
    for (const dependentId of dependents.get(current) ?? []) {
      const next = (indegree.get(dependentId) ?? 0) - 1
      indegree.set(dependentId, next)
      if (next === 0) {
        ready.push(dependentId)
        ready.sort()
      }
    }
  }

  if (order.length !== byId.size) {
    const taskIds = [...byId.keys()].filter((id) => (indegree.get(id) ?? 0) > 0).sort()
    return { valid: false, errors: [{ code: 'cycle', taskIds }] }
  }

  return { valid: true, topologicalOrder: order }
}

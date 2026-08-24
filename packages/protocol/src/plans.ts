import { validateTaskGraph, type TaskGraphError } from './dag.js'
import { EVIDENCE_KINDS, type EvidenceKind } from './artifacts.js'

export const AGENT_ROLES = ['planner', 'researcher', 'builder', 'reviewer', 'custom'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export interface PlannedAcceptanceCriterion {
  readonly key: string
  readonly description: string
  readonly required: boolean
  readonly evidenceKinds: readonly EvidenceKind[]
}

export interface PlannedTask {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly role: AgentRole
  readonly priority: number
  readonly dependsOn: readonly string[]
  readonly reviewRequired: boolean
  readonly acceptanceCriteria: readonly PlannedAcceptanceCriterion[]
}

export interface MissionPlanDraft {
  readonly summary: string
  readonly tasks: readonly PlannedTask[]
}

export interface MissionPlanError {
  readonly code:
    | 'empty_plan'
    | 'too_many_tasks'
    | 'invalid_task'
    | 'invalid_criterion'
    | 'invalid_graph'
  readonly path: string
  readonly message: string
}

export type MissionPlanValidation =
  | { readonly valid: true; readonly plan: MissionPlanDraft }
  | { readonly valid: false; readonly errors: readonly MissionPlanError[] }

function graphErrorMessage(error: TaskGraphError): string {
  switch (error.code) {
    case 'duplicate_task':
      return 'Duplicate task key: ' + error.taskId
    case 'duplicate_dependency':
      return 'Duplicate dependency ' + error.dependencyId + ' on task ' + error.taskId
    case 'unknown_dependency':
      return 'Unknown dependency ' + error.dependencyId + ' on task ' + error.taskId
    case 'cycle':
      return 'Task graph contains a cycle: ' + error.taskIds.join(', ')
  }
}

export function validateMissionPlan(plan: MissionPlanDraft): MissionPlanValidation {
  const errors: MissionPlanError[] = []
  if (plan.tasks.length === 0) {
    errors.push({ code: 'empty_plan', path: 'tasks', message: 'Plan must contain at least one task' })
  }
  if (plan.tasks.length > 100) {
    errors.push({ code: 'too_many_tasks', path: 'tasks', message: 'Plan cannot contain more than 100 tasks' })
  }
  if (!plan.summary.trim() || plan.summary.length > 20_000) {
    errors.push({ code: 'invalid_task', path: 'summary', message: 'Plan summary must be between 1 and 20000 characters' })
  }

  for (const [index, task] of plan.tasks.entries()) {
    const path = 'tasks[' + index + ']'
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.key)) {
      errors.push({ code: 'invalid_task', path: path + '.key', message: 'Task key must be 1-64 safe identifier characters' })
    }
    if (!task.title.trim() || task.title.length > 200) {
      errors.push({ code: 'invalid_task', path: path + '.title', message: 'Task title must be between 1 and 200 characters' })
    }
    if (task.description.length > 20_000) {
      errors.push({ code: 'invalid_task', path: path + '.description', message: 'Task description cannot exceed 20000 characters' })
    }
    if (!(AGENT_ROLES as readonly string[]).includes(task.role)) {
      errors.push({ code: 'invalid_task', path: path + '.role', message: 'Unsupported Agent role' })
    }
    if (!Number.isInteger(task.priority) || task.priority < 0 || task.priority > 1_000) {
      errors.push({ code: 'invalid_task', path: path + '.priority', message: 'Priority must be an integer between 0 and 1000' })
    }

    const criterionKeys = new Set<string>()
    for (const [criterionIndex, criterion] of task.acceptanceCriteria.entries()) {
      const criterionPath = path + '.acceptanceCriteria[' + criterionIndex + ']'
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(criterion.key) || criterionKeys.has(criterion.key)) {
        errors.push({ code: 'invalid_criterion', path: criterionPath + '.key', message: 'Criterion key must be valid and unique within the task' })
      }
      criterionKeys.add(criterion.key)
      if (!criterion.description.trim() || criterion.description.length > 2_000) {
        errors.push({ code: 'invalid_criterion', path: criterionPath + '.description', message: 'Criterion description must be between 1 and 2000 characters' })
      }
      for (const evidenceKind of criterion.evidenceKinds) {
        if (!(EVIDENCE_KINDS as readonly string[]).includes(evidenceKind)) {
          errors.push({ code: 'invalid_criterion', path: criterionPath + '.evidenceKinds', message: 'Unsupported evidence kind: ' + evidenceKind })
        }
      }
    }
  }

  const graph = validateTaskGraph(plan.tasks.map((task) => ({
    id: task.key,
    dependsOn: task.dependsOn,
  })))
  if (!graph.valid) {
    errors.push(...graph.errors.map((error) => ({
      code: 'invalid_graph' as const,
      path: 'tasks',
      message: graphErrorMessage(error),
    })))
  }

  return errors.length === 0 ? { valid: true, plan } : { valid: false, errors }
}

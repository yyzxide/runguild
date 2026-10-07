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

/** Reserved for the system-generated final task of an explicitly enabled Goal. */
export const GOAL_VERIFICATION_TASK_KEY = 'runguild-goal-verification'

/**
 * Preserve the proposed work and deterministically append a final acceptance gate.
 * A supplied reserved task must already be our exact generated task: silently
 * replacing arbitrary user work under that key could discard part of the plan.
 */
export function normalizeGoalVerificationPlan(
  plan: MissionPlanDraft,
  acceptanceCriteria: readonly string[],
): MissionPlanDraft {
  const originals = plan.tasks.filter((task) => task.key !== GOAL_VERIFICATION_TASK_KEY)
  const reserved = plan.tasks.filter((task) => task.key === GOAL_VERIFICATION_TASK_KEY)
  if (originals.length === 0 || originals.length > 99) {
    throw new Error('A Goal plan requires 1–99 original tasks plus its final verification task')
  }
  if (acceptanceCriteria.length > 100 || acceptanceCriteria.some((criterion) =>
    !criterion.trim() || criterion.length > 2_000)) {
    throw new Error('Goal acceptance criteria must contain at most 100 non-empty criteria of at most 2000 characters')
  }
  if (reserved.length > 1 || originals.some((task) => task.dependsOn.includes(GOAL_VERIFICATION_TASK_KEY))) {
    throw new Error('Original tasks cannot depend on the reserved final Goal verification task')
  }
  const verification: PlannedTask = {
    key: GOAL_VERIFICATION_TASK_KEY,
    title: 'Verify the complete Goal and repair remaining gaps',
    description: [
      'After every original task has completed and integrated, verify the complete merged result against the original Mission goal, constraints, and every acceptance criterion below.',
      'Inspect the actual repository and Mission Artifact; do not infer success from completed task statuses or previous claims.',
      'Run configured verification on the exact clean commit. For each criterion, record what was checked, the actual result, and the supporting evidence in the final Mission Artifact Version.',
      'Repair remaining gaps only within the approved goal and constraints, then commit and repeat the affected checks. Do not relax acceptance criteria or expand scope.',
      'If no code change is needed, call repo.commit to record the unchanged result; do not invent a file change merely to create evidence.',
      'If verification is impossible or a decision outside the approved scope is needed, report the blocker rather than claiming success.',
      'Submit the final Artifact Version for independent review. Requested changes return this task for a bounded retry; exhausted attempts require user attention. Final delivery still requires human approval.',
    ].join('\n\n'),
    role: 'builder',
    priority: 0,
    dependsOn: originals.map((task) => task.key),
    reviewRequired: true,
    acceptanceCriteria: (acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : ['Verify that the complete merged result satisfies the original Mission goal and constraints; record the checks and their actual results.'])
      .map((description, index) => ({
        key: 'goal-acceptance-' + (index + 1),
        description,
        required: true,
        evidenceKinds: ['artifact_version', 'test_run', 'command_result'] as const,
      })),
  }
  if (reserved[0]) {
    const task = reserved[0]
    const equal = task.title === verification.title && task.description === verification.description
      && task.role === verification.role && task.priority === verification.priority
      && task.reviewRequired === verification.reviewRequired
      && JSON.stringify(task.dependsOn) === JSON.stringify(verification.dependsOn)
      && task.acceptanceCriteria.length === verification.acceptanceCriteria.length
      && task.acceptanceCriteria.every((criterion, index) => {
        const expected = verification.acceptanceCriteria[index]!
        return criterion.key === expected.key && criterion.description === expected.description
          && criterion.required === expected.required
          && JSON.stringify(criterion.evidenceKinds) === JSON.stringify(expected.evidenceKinds)
      })
    if (!equal) throw new Error('The reserved final Goal verification task cannot be supplied or modified by a proposal')
  }
  return { ...plan, tasks: [...originals, verification] }
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

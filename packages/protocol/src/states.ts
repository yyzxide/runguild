export const MISSION_STATUSES = [
  'draft',
  'planning',
  'awaiting_approval',
  'running',
  'paused',
  'reviewing',
  'completed',
  'failed',
  'cancelled',
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]

export const TASK_STATUSES = [
  'blocked',
  'ready',
  'claimed',
  'running',
  'waiting_human',
  'reviewing',
  'completed',
  'failed',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const RUN_STATUSES = [
  'queued',
  'starting',
  'running',
  'waiting_tool',
  'waiting_human',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

export const REVIEW_STATUSES = [
  'requested',
  'in_progress',
  'approved',
  'rejected',
  'changes_requested',
  'cancelled',
] as const

export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>

export const MISSION_TRANSITIONS = {
  draft: ['planning', 'cancelled'],
  planning: ['awaiting_approval', 'draft', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'draft', 'failed', 'cancelled'],
  running: ['reviewing', 'paused', 'failed', 'cancelled'],
  paused: ['running', 'failed', 'cancelled'],
  reviewing: ['completed', 'running', 'paused', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionMap<MissionStatus>

export const TASK_TRANSITIONS = {
  blocked: ['ready', 'failed', 'cancelled'],
  ready: ['claimed', 'failed', 'cancelled'],
  claimed: ['running', 'ready', 'failed', 'cancelled'],
  running: ['waiting_human', 'reviewing', 'ready', 'failed', 'cancelled'],
  waiting_human: ['running', 'ready', 'failed', 'cancelled'],
  reviewing: ['completed', 'ready', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionMap<TaskStatus>

export const RUN_TRANSITIONS = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['waiting_tool', 'waiting_human', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  waiting_tool: ['running', 'failed', 'cancelled', 'timed_out'],
  waiting_human: ['running', 'failed', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
} as const satisfies TransitionMap<RunStatus>

export const REVIEW_TRANSITIONS = {
  requested: ['in_progress', 'cancelled'],
  in_progress: ['approved', 'rejected', 'changes_requested', 'cancelled'],
  approved: [],
  rejected: [],
  changes_requested: [],
  cancelled: [],
} as const satisfies TransitionMap<ReviewStatus>

export class InvalidTransitionError extends Error {
  readonly domain: string
  readonly from: string
  readonly to: string

  constructor(domain: string, from: string, to: string) {
    super('Invalid ' + domain + ' transition: ' + from + ' -> ' + to)
    this.name = 'InvalidTransitionError'
    this.domain = domain
    this.from = from
    this.to = to
  }
}

function canTransition<State extends string>(
  map: TransitionMap<State>,
  from: State,
  to: State,
): boolean {
  return map[from].includes(to)
}

function assertTransition<State extends string>(
  domain: string,
  map: TransitionMap<State>,
  from: State,
  to: State,
): void {
  if (!canTransition(map, from, to)) {
    throw new InvalidTransitionError(domain, from, to)
  }
}

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return canTransition(MISSION_TRANSITIONS, from, to)
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return canTransition(TASK_TRANSITIONS, from, to)
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return canTransition(RUN_TRANSITIONS, from, to)
}

export function canTransitionReview(from: ReviewStatus, to: ReviewStatus): boolean {
  return canTransition(REVIEW_TRANSITIONS, from, to)
}

export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  assertTransition('mission', MISSION_TRANSITIONS, from, to)
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  assertTransition('task', TASK_TRANSITIONS, from, to)
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  assertTransition('run', RUN_TRANSITIONS, from, to)
}

export function assertReviewTransition(from: ReviewStatus, to: ReviewStatus): void {
  assertTransition('review', REVIEW_TRANSITIONS, from, to)
}

export function isTerminalMissionStatus(status: MissionStatus): boolean {
  return MISSION_TRANSITIONS[status].length === 0
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0
}

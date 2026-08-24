import type {
  AgentId,
  IsoTimestamp,
  MissionId,
  RunControlRequestId,
  RunId,
  TaskId,
  WorkspaceId,
} from './ids.js'
import type { RunStatus } from './states.js'

export type RunControlKind = 'steer' | 'cancel'
export type RunControlStatus = 'pending' | 'applied' | 'rejected'

export interface RunControlRequest {
  readonly id: RunControlRequestId
  readonly workspaceId: WorkspaceId
  readonly runId: RunId
  readonly kind: RunControlKind
  readonly payload: Readonly<Record<string, unknown>>
  readonly createdBy: string
  readonly createdAt: IsoTimestamp
}

export interface RuntimeRunContext {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly status: RunStatus
  readonly currentHop: number
  readonly maxHops: number
  readonly contextSnapshot: Readonly<Record<string, unknown>>
}

export type RuntimeOutcome =
  | { readonly status: 'succeeded'; readonly summary: string; readonly hops: number }
  | { readonly status: 'waiting_tool'; readonly summary: string; readonly hops: number }
  | { readonly status: 'waiting_human'; readonly summary: string; readonly hops: number }
  | { readonly status: 'failed'; readonly summary: string; readonly hops: number }
  | { readonly status: 'cancelled'; readonly summary: string; readonly hops: number }
  | { readonly status: 'timed_out'; readonly summary: string; readonly hops: number }

export interface CompletionDecision {
  readonly accepted: boolean
  readonly reason?: string
}

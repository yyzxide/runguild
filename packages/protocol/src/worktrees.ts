import type {
  IsoTimestamp,
  MissionId,
  ProjectId,
  TaskId,
  WorkspaceId,
} from './ids.js'

export const TASK_WORKTREE_STATUSES = [
  'provisioning',
  'ready',
  'committed',
  'integrating',
  'integrated',
  'cleanup_pending',
  'removed',
  'failed',
] as const

export type TaskWorktreeStatus = (typeof TASK_WORKTREE_STATUSES)[number]

export interface TaskWorktree {
  readonly taskId: TaskId
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly projectId: ProjectId
  readonly repositoryPath: string
  readonly worktreePath: string
  readonly branchName: string
  readonly baseRef: string
  readonly baseCommit: string
  /** Current base being merged into a previously reviewed Task after an Integration conflict. */
  readonly reconciliationBaseCommit?: string
  readonly headCommit?: string
  readonly integratedCommit?: string
  readonly status: TaskWorktreeStatus
  readonly generation: number
  readonly lastError?: Readonly<Record<string, unknown>>
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

import { randomUUID } from 'node:crypto'

import type {
  TaskRepository,
  TaskWorktreeRepository,
} from '@runguild/database'
import type { CorrelationId, ProjectId, WorkspaceId } from '@runguild/protocol'

import type { GitWorktreeManager } from './git-worktree-manager.js'

type Worktrees = Pick<
  TaskWorktreeRepository,
  'listApprovedPendingIntegration' | 'listCompletedPendingCleanup'
>
type Tasks = Pick<TaskRepository, 'completeTaskAndUnlockDependents'>
type Manager = Pick<GitWorktreeManager, 'cleanup' | 'integrate'>

export interface IntegrationCoordinatorDependencies {
  readonly worktrees: Worktrees
  readonly tasks: Tasks
  readonly manager: Manager
}

export interface IntegrationTickResult {
  readonly discovered: number
  readonly integrated: number
  readonly completed: number
  readonly busy: number
  readonly conflicts: number
  readonly failed: number
  readonly gateRejected: number
  readonly cleanupDiscovered: number
  readonly cleaned: number
  readonly cleanupBusy: number
  readonly cleanupFailed: number
}

export class IntegrationCoordinator {
  constructor(private readonly dependencies: IntegrationCoordinatorDependencies) {}

  async tick(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly limit: number
    readonly leaseSeconds: number
  }): Promise<IntegrationTickResult> {
    const candidates = await this.dependencies.worktrees.listApprovedPendingIntegration({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: input.limit,
    })
    let integrated = 0
    let completed = 0
    let busy = 0
    let conflicts = 0
    let failed = 0
    let gateRejected = 0
    for (const worktree of candidates) {
      try {
        const result = await this.dependencies.manager.integrate({
          taskId: worktree.taskId,
          leaseSeconds: input.leaseSeconds,
        })
        if (result.kind === 'busy') {
          busy += 1
          continue
        }
        if (result.kind === 'conflict') {
          conflicts += 1
          continue
        }
        integrated += 1
        const completion = await this.dependencies.tasks.completeTaskAndUnlockDependents({
          workspaceId: worktree.workspaceId,
          missionId: worktree.missionId,
          taskId: worktree.taskId,
          actor: { kind: 'system', id: 'git-integration-gate' },
          correlationId: ('integration_' + randomUUID()) as CorrelationId,
        })
        if (completion.completed) completed += 1
        else gateRejected += 1
      } catch {
        failed += 1
      }
    }
    const cleanupCandidates = await this.dependencies.worktrees.listCompletedPendingCleanup({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      limit: input.limit,
    })
    let cleaned = 0
    let cleanupBusy = 0
    let cleanupFailed = 0
    for (const worktree of cleanupCandidates) {
      try {
        const result = await this.dependencies.manager.cleanup({
          taskId: worktree.taskId,
          leaseSeconds: input.leaseSeconds,
        })
        if (result.kind === 'busy') cleanupBusy += 1
        else cleaned += 1
      } catch {
        cleanupFailed += 1
      }
    }
    return {
      discovered: candidates.length,
      integrated,
      completed,
      busy,
      conflicts,
      failed,
      gateRejected,
      cleanupDiscovered: cleanupCandidates.length,
      cleaned,
      cleanupBusy,
      cleanupFailed,
    }
  }
}

import { setTimeout as delay } from 'node:timers/promises'

import {
  type WorktreeSetupRepository,
  type WorktreeSetupSnapshot,
} from '@runguild/database'
import type {
  MissionId,
  ProjectId,
  RunId,
  TaskId,
  WorkspaceId,
} from '@runguild/protocol'
import {
  executeWorktreeSetupCommands,
  type WorktreeSetupExecutionResult,
} from '@runguild/workspace-tools'

type SetupStore = Pick<WorktreeSetupRepository, 'markFailed' | 'markSucceeded' | 'renew' | 'reserve'>

export interface PrepareWorktreeInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly worktreeGeneration: number
  readonly worktreePath: string
  readonly commands: readonly (readonly string[])[]
  readonly timeoutMs: number
  readonly leaseSeconds: number
  readonly abortSignal?: AbortSignal
}

export interface WorktreePreparationDependencies {
  readonly setups: SetupStore
  readonly execute?: typeof executeWorktreeSetupCommands
}

function failedMessage(setup: WorktreeSetupSnapshot): string {
  const code = typeof setup.error?.['code'] === 'string' ? setup.error['code'] : 'setup_failed'
  return 'Worktree setup did not pass (' + code + ')'
}

export async function prepareWorktree(
  dependencies: WorktreePreparationDependencies,
  input: PrepareWorktreeInput,
): Promise<void> {
  if (input.commands.length === 0) return
  let reservation = await dependencies.setups.reserve({
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    projectId: input.projectId,
    taskId: input.taskId,
    runId: input.runId,
    worktreeGeneration: input.worktreeGeneration,
    commands: input.commands,
    leaseSeconds: input.leaseSeconds,
  })
  while (reservation.kind === 'busy') {
    await delay(Math.min(reservation.retryAfterMs, 5_000), undefined, {
      ...(input.abortSignal === undefined ? {} : { signal: input.abortSignal }),
    })
    reservation = await dependencies.setups.reserve({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      projectId: input.projectId,
      taskId: input.taskId,
      runId: input.runId,
      worktreeGeneration: input.worktreeGeneration,
      commands: input.commands,
      leaseSeconds: input.leaseSeconds,
    })
  }
  if (reservation.kind === 'succeeded') return
  if (reservation.kind === 'failed') throw new Error(failedMessage(reservation.setup))

  const setup = reservation.setup
  const leaseToken = reservation.leaseToken
  const executionAbort = new AbortController()
  const abortFromRun = () => executionAbort.abort(
    input.abortSignal?.reason ?? new Error('Agent Run was aborted during Worktree setup'),
  )
  if (input.abortSignal?.aborted) abortFromRun()
  else input.abortSignal?.addEventListener('abort', abortFromRun, { once: true })
  let renewing = false
  const heartbeat = setInterval(() => {
    if (renewing) return
    renewing = true
    void dependencies.setups.renew({
      setupId: setup.id,
      leaseToken,
      leaseSeconds: input.leaseSeconds,
    }).then((renewed) => {
      if (!renewed) executionAbort.abort(new Error('Worktree setup lease was lost'))
    }).catch((error: unknown) => executionAbort.abort(error)).finally(() => {
      renewing = false
    })
  }, Math.max(1_000, Math.floor(input.leaseSeconds * 1_000 / 3)))

  let execution: WorktreeSetupExecutionResult
  try {
    execution = await (dependencies.execute ?? executeWorktreeSetupCommands)({
      root: input.worktreePath,
      commands: input.commands,
      timeoutMs: input.timeoutMs,
      abortSignal: executionAbort.signal,
    })
  } catch (error) {
    await dependencies.setups.markFailed({
      setupId: setup.id,
      leaseToken,
      results: [],
      error: {
        code: 'setup_execution_error',
        message: 'Worktree setup command could not be started or completed',
      },
    })
    throw error
  } finally {
    clearInterval(heartbeat)
    input.abortSignal?.removeEventListener('abort', abortFromRun)
  }

  if (!execution.passed) {
    await dependencies.setups.markFailed({
      setupId: setup.id,
      leaseToken,
      results: execution.results,
      error: {
        code: execution.failure.code,
        commandIndex: execution.failure.commandIndex,
        exitCode: execution.failure.exitCode,
        message: 'Worktree setup command did not pass',
      },
    })
    throw new Error('Worktree setup command ' + (execution.failure.commandIndex + 1) + ' did not pass')
  }
  await dependencies.setups.markSucceeded({
    setupId: setup.id,
    leaseToken,
    results: execution.results,
  })
}

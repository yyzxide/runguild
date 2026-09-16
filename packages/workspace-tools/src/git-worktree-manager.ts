import { executeWorktreeSetupCommands } from './worktree-setup.js'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type {
  ReserveTaskWorktreeResult,
  TaskWorktreeRepository,
} from '@runguild/database'
import type {
  CorrelationId,
  MissionId,
  ProjectId,
  TaskId,
  TaskWorktree,
  WorkspaceId,
} from '@runguild/protocol'

const MAX_GIT_OUTPUT_BYTES = 256 * 1024

type TaskWorktreeStore = Pick<
  TaskWorktreeRepository,
  'assertIntegrationLease' | 'markCleanupFailed' | 'markFailed' | 'markIntegrated' | 'markIntegrationFailed' |
  'markIntegrationConflict' | 'markInvalid' | 'markReady' | 'markRemoved' | 'reserve' | 'reserveCleanup' |
  'reserveIntegration'
>

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

class IntegrationConflictError extends Error {}

export interface EnsureTaskWorktreeInput {
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly projectId: ProjectId
  readonly taskId: TaskId
  readonly baseRef: string
  readonly expectedBaseCommit?: string
  readonly allowBaseRefAdvance?: boolean
  readonly leaseSeconds?: number
}

export type EnsureTaskWorktreeResult =
  | { readonly kind: 'ready'; readonly worktree: TaskWorktree }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }

export type IntegrateTaskWorktreeResult =
  | { readonly kind: 'integrated'; readonly worktree: TaskWorktree }
  | { readonly kind: 'conflict'; readonly worktree: TaskWorktree; readonly taskStatus: 'ready' | 'failed' }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }

export type CleanupTaskWorktreeResult =
  | { readonly kind: 'removed'; readonly worktree: TaskWorktree }
  | { readonly kind: 'busy'; readonly retryAfterMs: number }

export interface GitWorktreeManagerOptions {
  readonly repositoryPath: string
  readonly worktreeRoot: string
  readonly store: TaskWorktreeStore
  readonly verificationCommands?: readonly (readonly string[])[]
  readonly preparationCommands?: readonly (readonly string[])[]
  readonly verificationTimeoutMs?: number
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))
}

function taskName(taskId: TaskId): { readonly path: string; readonly branch: string } {
  const readable = taskId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 48) || 'task'
  const suffix = createHash('sha256').update(taskId).digest('hex').slice(0, 10)
  return {
    path: readable + '-' + suffix,
    branch: 'agent/task-' + readable + '-' + suffix,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function git(cwd: string, args: readonly string[], allowFailure = false): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? 'C.UTF-8',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer): string => {
      const currentBytes = Buffer.byteLength(current)
      if (currentBytes >= MAX_GIT_OUTPUT_BYTES) return current
      return current + chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - currentBytes).toString('utf8')
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once('error', reject)
    child.once('close', (exitCode) => {
      const result = {
        exitCode,
        stdout,
        stderr,
      }
      if (!allowFailure && exitCode !== 0) {
        reject(new Error('Git command failed: ' + args[0] + ': ' + result.stderr.trim()))
        return
      }
      resolvePromise(result)
    })
  })
}

export class GitWorktreeManager {
  private constructor(
    private readonly repositoryPath: string,
    private readonly worktreeRoot: string,
    private readonly store: TaskWorktreeStore,
    private readonly verificationCommands: readonly (readonly string[])[],
    private readonly preparationCommands: readonly (readonly string[])[],
    private readonly verificationTimeoutMs: number,
  ) {}

  static async create(options: GitWorktreeManagerOptions): Promise<GitWorktreeManager> {
    const repositoryPath = await realpath(resolve(options.repositoryPath))
    await mkdir(resolve(options.worktreeRoot), { recursive: true, mode: 0o700 })
    const worktreeRoot = await realpath(resolve(options.worktreeRoot))
    if (repositoryPath === '/' || worktreeRoot === '/' || repositoryPath === worktreeRoot) {
      throw new Error('Repository and Worktree roots must be distinct, bounded directories')
    }
    if (contains(repositoryPath, worktreeRoot)) {
      throw new Error('Worktree root cannot be inside the source repository')
    }
    const top = (await git(repositoryPath, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (await realpath(top) !== repositoryPath) {
      throw new Error('Repository path must be the top level of a non-bare Git checkout')
    }
    return new GitWorktreeManager(repositoryPath, worktreeRoot, options.store,
      options.verificationCommands ?? [], options.preparationCommands ?? [], options.verificationTimeoutMs ?? 120_000)
  }

  async ensure(input: EnsureTaskWorktreeInput): Promise<EnsureTaskWorktreeResult> {
    if (!input.baseRef.trim() || input.baseRef.startsWith('-') || input.baseRef.length > 200) {
      throw new Error('Base branch name is invalid')
    }
    const checked = await git(this.repositoryPath, ['check-ref-format', '--branch', input.baseRef], true)
    if (checked.exitCode !== 0) throw new Error('Base branch name is invalid')
    const ref = 'refs/heads/' + input.baseRef
    let resolved = await git(
      this.repositoryPath,
      ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'],
      true,
    )
    if (resolved.exitCode !== 0 && input.expectedBaseCommit && input.allowBaseRefAdvance) {
      const expected = await git(
        this.repositoryPath,
        ['rev-parse', '--verify', '--end-of-options', input.expectedBaseCommit + '^{commit}'],
        true,
      )
      if (expected.exitCode !== 0 || expected.stdout.trim() !== input.expectedBaseCommit) {
        throw new Error('Frozen Evaluation Scenario baseline is not present in the repository')
      }
      await git(
        this.repositoryPath,
        ['branch', input.baseRef, input.expectedBaseCommit],
        true,
      )
      resolved = await git(
        this.repositoryPath,
        ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'],
        true,
      )
    }
    if (resolved.exitCode !== 0) throw new Error('Base ref did not resolve to a commit')
    const baseCommit = resolved.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error('Base ref did not resolve to a commit')
    if (input.expectedBaseCommit !== undefined) {
      if (input.allowBaseRefAdvance) {
        const descended = await git(
          this.repositoryPath,
          ['merge-base', '--is-ancestor', input.expectedBaseCommit, baseCommit],
          true,
        )
        if (descended.exitCode !== 0) {
          throw new Error('Evaluation Trial base ref is not descended from its frozen baseline')
        }
      } else if (baseCommit !== input.expectedBaseCommit) {
        throw new Error(
          'Repository base commit does not match the frozen Evaluation Scenario baseline',
        )
      }
    }

    const names = taskName(input.taskId)
    const worktreePath = resolve(this.worktreeRoot, names.path)
    if (!contains(this.worktreeRoot, worktreePath) || worktreePath === this.worktreeRoot) {
      throw new Error('Derived Worktree path escaped its root')
    }
    const reservation = await this.store.reserve({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      projectId: input.projectId,
      taskId: input.taskId,
      repositoryPath: this.repositoryPath,
      worktreePath,
      branchName: names.branch,
      baseRef: input.baseRef,
      baseCommit,
      ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
    })
    if (reservation.kind === 'busy') return reservation
    if (reservation.kind === 'ready') {
      try {
        const headCommit = await this.verify(reservation.worktree)
        return { kind: 'ready', worktree: { ...reservation.worktree, headCommit } }
      } catch (error) {
        await this.store.markInvalid({
          taskId: input.taskId,
          error: { code: 'worktree_reconciliation_failed', message: this.errorMessage(error) },
        })
        throw error
      }
    }
    return this.provision(reservation)
  }

  async integrate(input: {
    readonly taskId: TaskId
    readonly leaseSeconds?: number
  }): Promise<IntegrateTaskWorktreeResult> {
    const reservation = await this.store.reserveIntegration(input)
    if (reservation.kind === 'busy') return reservation
    if (reservation.kind === 'integrated') return reservation
    const record = reservation.worktree
    let sourceHead: string | undefined
    try {
      const taskHead = await this.verify(record)
      if (!record.headCommit || taskHead !== record.headCommit) {
        throw new Error('Task Worktree HEAD differs from the reviewed committed HEAD')
      }
      const pendingMerge = await git(record.worktreePath, ['rev-parse', '--verify', 'MERGE_HEAD'], true)
      if (pendingMerge.exitCode === 0 && record.reconciliationBaseCommit === undefined) {
        const aborted = await git(record.worktreePath, ['merge', '--abort'], true)
        if (aborted.exitCode !== 0) {
          throw new Error('Interrupted Integration conflict preparation could not be rolled back')
        }
      }
      const taskStatus = await git(record.worktreePath, ['status', '--porcelain=v1'], true)
      if (taskStatus.exitCode !== 0 || taskStatus.stdout.trim()) {
        throw new Error('Task Worktree must be clean before integration')
      }
      await this.cleanupTemporaryIntegrationWorktree(record.taskId)
      const sourceBranch = (await git(this.repositoryPath, ['branch', '--show-current'])).stdout.trim()
      const sourceRef = 'refs/heads/' + record.baseRef
      sourceHead = (
        await git(this.repositoryPath, ['rev-parse', '--verify', sourceRef + '^{commit}'])
      ).stdout.trim()
      if (sourceBranch === record.baseRef) {
        const sourceStatus = await git(this.repositoryPath, ['status', '--porcelain=v1'], true)
        if (sourceStatus.exitCode !== 0 || sourceStatus.stdout.trim()) {
          throw new Error('Source repository must be clean before integration')
        }
        const checkedOutHead = (
          await git(this.repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}'])
        ).stdout.trim()
        if (checkedOutHead !== sourceHead) {
          throw new Error('Checked-out source branch differs from its recorded ref')
        }
      }
      const expectedIntegratedHead = await this.validateAndPublishIntegration({
        record, sourceBranch, sourceRef, sourceHead, taskHead,
        integrationToken: reservation.integrationToken,
        leaseSeconds: input.leaseSeconds ?? 60,
      })
      const integratedHead = (
        await git(this.repositoryPath, ['rev-parse', '--verify', sourceRef + '^{commit}'])
      ).stdout.trim()
      if (integratedHead !== expectedIntegratedHead) {
        throw new Error('Integration base advanced while the reviewed Task was being integrated')
      }
      const containsReviewedHead = await git(
        this.repositoryPath,
        ['merge-base', '--is-ancestor', taskHead, integratedHead],
        true,
      )
      if (containsReviewedHead.exitCode !== 0) {
        throw new Error('Integrated history does not contain the exact reviewed Task HEAD')
      }
      const integrated = await this.store.markIntegrated({
        taskId: record.taskId,
        integrationToken: reservation.integrationToken,
        integratedCommit: integratedHead,
      })
      return { kind: 'integrated', worktree: integrated }
    } catch (error) {
      if (error instanceof IntegrationConflictError && sourceHead !== undefined) {
        try {
          const recovery = await this.prepareIntegrationConflict({
            record,
            integrationToken: reservation.integrationToken,
            sourceHead,
            error,
          })
          return { kind: 'conflict', ...recovery }
        } catch (recoveryError) {
          await git(record.worktreePath, ['merge', '--abort'], true).catch(() => null)
          await this.store.markIntegrationFailed({
            taskId: record.taskId,
            integrationToken: reservation.integrationToken,
            error: {
              code: 'worktree_integration_conflict_recovery_failed',
              message: this.errorMessage(recoveryError),
            },
          }).catch(() => null)
          throw recoveryError
        }
      }
      await this.store.markIntegrationFailed({
        taskId: record.taskId,
        integrationToken: reservation.integrationToken,
        error: { code: 'worktree_integration_failed', message: this.errorMessage(error) },
      }).catch(() => null)
      throw error
    }
  }

  private async prepareIntegrationConflict(input: {
    readonly record: TaskWorktree
    readonly integrationToken: string
    readonly sourceHead: string
    readonly error: IntegrationConflictError
  }): Promise<{ readonly worktree: TaskWorktree; readonly taskStatus: 'ready' | 'failed' }> {
    const merged = await git(input.record.worktreePath, [
      '-c', 'user.name=RunGuild Integration Recovery',
      '-c', 'user.email=runguild-integration@example.invalid',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'commit.gpgSign=false',
      'merge', '--no-ff', '--no-commit', '--no-verify', '--no-gpg-sign', input.sourceHead,
    ], true)
    const mergeHead = await git(input.record.worktreePath, ['rev-parse', '--verify', 'MERGE_HEAD'], true)
    if (mergeHead.exitCode !== 0 || mergeHead.stdout.trim() !== input.sourceHead) {
      const detail = (merged.stdout + '\n' + merged.stderr).trim().slice(0, 2_000)
      throw new Error(
        'Could not materialize the current base in the Task Worktree for conflict resolution' +
        (detail ? ': ' + detail : ''),
      )
    }
    return this.store.markIntegrationConflict({
      taskId: input.record.taskId,
      integrationToken: input.integrationToken,
      reconciliationBaseCommit: input.sourceHead,
      error: {
        code: 'worktree_integration_conflict',
        message: this.errorMessage(input.error),
      },
      correlationId: ('integration_conflict_' + randomUUID()) as CorrelationId,
    })
  }

  private async validateAndPublishIntegration(input: {
    readonly record: TaskWorktree
    readonly sourceBranch: string
    readonly sourceRef: string
    readonly sourceHead: string
    readonly taskHead: string
    readonly integrationToken: string
    readonly leaseSeconds: number
  }): Promise<string> {
    if (this.verificationCommands.length === 0) {
      throw new Error('Integration requires explicit verification commands')
    }
    // A takeover must never delete another execution's validation worktree.
    const suffix = createHash('sha256').update(input.integrationToken).digest('hex').slice(0, 16)
    const integrationPath = resolve(this.worktreeRoot, '.integration-' + taskName(input.record.taskId).path + '-' + suffix)
    const abort = AbortSignal.timeout(Math.max(1_000, input.leaseSeconds * 1_000 - 3_000))
    await git(this.repositoryPath, ['worktree', 'add', '--detach', integrationPath, input.sourceHead])
    try {
      const contained = await git(integrationPath, ['merge-base', '--is-ancestor', input.taskHead, input.sourceHead], true)
      if (contained.exitCode !== 0) {
        const forward = await git(integrationPath, ['merge-base', '--is-ancestor', input.sourceHead, input.taskHead], true)
        const merged = await git(integrationPath, [
          '-c', 'user.name=RunGuild Integration', '-c', 'user.email=runguild-integration@example.invalid',
          '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
          'merge', forward.exitCode === 0 ? '--ff-only' : '--no-ff', '--no-verify', '--no-gpg-sign',
          '-m', 'Integrate reviewed Task ' + input.record.taskId, input.taskHead,
        ], true)
        if (merged.exitCode !== 0) {
          throw new IntegrationConflictError('Reviewed Task conflicts with the current base branch: ' +
            (merged.stdout + merged.stderr).slice(0, 2_000))
        }
      }
      const candidate = (await git(integrationPath, ['rev-parse', 'HEAD'])).stdout.trim()
      if (this.preparationCommands.length > 0) {
        const prepared = await executeWorktreeSetupCommands({ root: integrationPath, commands: this.preparationCommands,
          timeoutMs: this.verificationTimeoutMs, abortSignal: abort })
        if (!prepared.passed) throw new Error('Integration preparation failed: ' + JSON.stringify(prepared))
      }
      const verified = await executeWorktreeSetupCommands({ root: integrationPath, commands: this.verificationCommands,
        timeoutMs: this.verificationTimeoutMs, abortSignal: abort })
      if (!verified.passed) throw new Error('Integration verification failed: ' + JSON.stringify(verified))
      if ((await git(integrationPath, ['rev-parse', 'HEAD'])).stdout.trim() !== candidate
          || (await git(integrationPath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) {
        throw new Error('Integration verification modified the candidate tree')
      }
      if (abort.aborted) throw new Error('Integration validation exceeded its lease budget')
      await this.store.assertIntegrationLease({ taskId: input.record.taskId, integrationToken: input.integrationToken })
      const currentHead = (await git(this.repositoryPath, ['rev-parse', input.sourceRef])).stdout.trim()
      const currentBranch = (await git(this.repositoryPath, ['branch', '--show-current'])).stdout.trim()
      if (currentHead !== input.sourceHead || currentBranch !== input.sourceBranch) {
        throw new Error('Integration base advanced during verification; a new validation is required')
      }
      if (currentBranch === input.record.baseRef) {
        if ((await git(this.repositoryPath, ['status', '--porcelain=v1'])).stdout.trim()) {
          throw new Error('Source repository must be clean before integration')
        }
        await git(this.repositoryPath, ['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', candidate])
      } else {
        await git(this.repositoryPath, ['update-ref', input.sourceRef, candidate, input.sourceHead])
      }
      return candidate
    } finally {
      await git(this.repositoryPath, ['worktree', 'remove', '--force', integrationPath])
    }
  }

  private async cleanupTemporaryIntegrationWorktree(taskId: TaskId): Promise<void> {
    const integrationPath = resolve(this.worktreeRoot, '.integration-' + taskName(taskId).path)
    const removed = await git(
      this.repositoryPath,
      ['worktree', 'remove', '--force', integrationPath],
      true,
    )
    if (removed.exitCode !== 0 && await exists(integrationPath)) {
      throw new Error('Stale integration Worktree could not be removed safely')
    }
    await git(this.repositoryPath, ['worktree', 'prune'])
  }

  async cleanup(input: {
    readonly taskId: TaskId
    readonly leaseSeconds?: number
  }): Promise<CleanupTaskWorktreeResult> {
    const reservation = await this.store.reserveCleanup(input)
    if (reservation.kind === 'busy') return reservation
    if (reservation.kind === 'removed') return reservation
    const record = reservation.worktree
    try {
      if (await exists(record.worktreePath)) {
        const canonical = await realpath(record.worktreePath)
        if (!contains(this.worktreeRoot, canonical) || canonical !== record.worktreePath) {
          throw new Error('Task Worktree cleanup target escaped its root')
        }
        const status = await git(canonical, ['status', '--porcelain=v1'], true)
        if (status.exitCode !== 0 || status.stdout.trim()) {
          throw new Error('Task Worktree cleanup requires a clean Worktree')
        }
        await git(this.repositoryPath, ['worktree', 'remove', record.worktreePath])
      }
      await git(this.repositoryPath, ['worktree', 'prune'])
      const branch = await git(
        this.repositoryPath,
        ['show-ref', '--verify', '--quiet', 'refs/heads/' + record.branchName],
        true,
      )
      if (branch.exitCode === 0) {
        if (!record.headCommit) throw new Error('Integrated Task branch has no recorded HEAD')
        const baseContainsTask = await git(
          this.repositoryPath,
          ['merge-base', '--is-ancestor', record.headCommit, 'refs/heads/' + record.baseRef],
          true,
        )
        if (baseContainsTask.exitCode !== 0) {
          throw new Error('Task branch is not contained in its integration base ref')
        }
        await git(
          this.repositoryPath,
          ['update-ref', '-d', 'refs/heads/' + record.branchName, record.headCommit],
        )
      } else if (branch.exitCode !== 1) {
        throw new Error('Could not inspect integrated Task branch before cleanup')
      }
      const removed = await this.store.markRemoved({
        taskId: record.taskId,
        cleanupToken: reservation.cleanupToken,
      })
      return { kind: 'removed', worktree: removed }
    } catch (error) {
      await this.store.markCleanupFailed({
        taskId: record.taskId,
        cleanupToken: reservation.cleanupToken,
        error: { code: 'worktree_cleanup_failed', message: this.errorMessage(error) },
      }).catch(() => null)
      throw error
    }
  }

  private async provision(
    reservation: Extract<ReserveTaskWorktreeResult, { readonly kind: 'provision' }>,
  ): Promise<EnsureTaskWorktreeResult> {
    const record = reservation.worktree
    try {
      if (!await exists(record.worktreePath)) {
        const branch = await git(
          this.repositoryPath,
          ['show-ref', '--verify', '--quiet', 'refs/heads/' + record.branchName],
          true,
        )
        if (branch.exitCode === 0) {
          await git(this.repositoryPath, ['worktree', 'add', record.worktreePath, record.branchName])
        } else if (branch.exitCode === 1) {
          await git(this.repositoryPath, [
            'worktree', 'add', '-b', record.branchName, record.worktreePath, record.baseCommit,
          ])
        } else {
          throw new Error('Could not inspect Task branch: ' + branch.stderr.trim())
        }
      }
      const headCommit = await this.verify(record)
      const ready = await this.store.markReady({
        taskId: record.taskId,
        provisionToken: reservation.provisionToken,
        headCommit,
      })
      return { kind: 'ready', worktree: ready }
    } catch (error) {
      await this.store.markFailed({
        taskId: record.taskId,
        provisionToken: reservation.provisionToken,
        error: { code: 'worktree_provision_failed', message: this.errorMessage(error) },
      }).catch(() => null)
      throw error
    }
  }

  private async verify(record: TaskWorktree): Promise<string> {
    const canonical = await realpath(record.worktreePath)
    if (!contains(this.worktreeRoot, canonical) || canonical !== record.worktreePath) {
      throw new Error('Task Worktree resolves outside its assigned root')
    }
    const top = (await git(canonical, ['rev-parse', '--show-toplevel'])).stdout.trim()
    if (await realpath(top) !== canonical) throw new Error('Task Worktree top-level path does not match its record')
    const branch = (await git(canonical, ['branch', '--show-current'])).stdout.trim()
    if (branch !== record.branchName) throw new Error('Task Worktree is attached to the wrong branch')
    const headCommit = (await git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
    const ancestry = await git(canonical, ['merge-base', '--is-ancestor', record.baseCommit, headCommit], true)
    if (ancestry.exitCode !== 0) throw new Error('Task Worktree HEAD is not descended from its recorded base')
    return headCommit
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 4_000) : String(error).slice(0, 4_000)
  }
}

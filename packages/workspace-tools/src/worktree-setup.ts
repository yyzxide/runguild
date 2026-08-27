import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import type { WorktreeSetupCommandResult } from '@runguild/database'

export type WorktreeSetupExecutionResult =
  | { readonly passed: true; readonly results: readonly WorktreeSetupCommandResult[] }
  | {
      readonly passed: false
      readonly results: readonly WorktreeSetupCommandResult[]
      readonly failure: {
        readonly commandIndex: number
        readonly code: 'exit_nonzero' | 'timed_out' | 'aborted'
        readonly exitCode: number | null
      }
    }

function validateCommands(commands: readonly (readonly string[])[]): void {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20
      || commands.some((command) => !Array.isArray(command)
        || command.length < 1 || command.length > 30
        || command.some((part) => typeof part !== 'string' || !part.trim() || part.length > 1_000))) {
    throw new Error('Worktree setup commands must contain 1-20 non-empty argument arrays')
  }
}

async function executeCommand(input: {
  readonly commandIndex: number
  readonly argv: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly abortSignal?: AbortSignal
}): Promise<{ readonly result: WorktreeSetupCommandResult; readonly aborted: boolean }> {
  const [executable, ...args] = input.argv
  if (!executable) throw new Error('Worktree setup command cannot be empty')
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now()
    const stdoutHash = createHash('sha256')
    const stderrHash = createHash('sha256')
    const child = spawn(executable, args, {
      cwd: input.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? 'C.UTF-8',
        CI: 'true',
      },
    })
    let timedOut = false
    let aborted = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 2_000)
        killTimer.unref()
      }
    }
    const timeout = setTimeout(() => {
      timedOut = true
      stop()
    }, input.timeoutMs)
    const abort = () => {
      aborted = true
      stop()
    }
    if (input.abortSignal?.aborted) abort()
    else input.abortSignal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => stdoutHash.update(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrHash.update(chunk))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      input.abortSignal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      input.abortSignal?.removeEventListener('abort', abort)
      resolvePromise({
        result: {
          commandIndex: input.commandIndex,
          argv: input.argv,
          exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdoutHash: stdoutHash.digest('hex'),
          stderrHash: stderrHash.digest('hex'),
        },
        aborted,
      })
    })
  })
}

export async function executeWorktreeSetupCommands(input: {
  readonly root: string
  readonly commands: readonly (readonly string[])[]
  readonly timeoutMs: number
  readonly abortSignal?: AbortSignal
}): Promise<WorktreeSetupExecutionResult> {
  validateCommands(input.commands)
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 900_000) {
    throw new Error('Worktree setup timeout must be between 1000 and 900000 milliseconds')
  }
  const root = await realpath(resolve(input.root))
  if (!(await stat(root)).isDirectory()) throw new Error('Worktree setup root must be a directory')
  const results: WorktreeSetupCommandResult[] = []
  for (let commandIndex = 0; commandIndex < input.commands.length; commandIndex += 1) {
    const argv = input.commands[commandIndex]
    if (!argv) throw new Error('Worktree setup command disappeared during execution')
    const executed = await executeCommand({
      commandIndex,
      argv,
      cwd: root,
      timeoutMs: input.timeoutMs,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    })
    results.push(executed.result)
    if (executed.aborted || executed.result.timedOut || executed.result.exitCode !== 0) {
      return {
        passed: false,
        results,
        failure: {
          commandIndex,
          code: executed.aborted ? 'aborted' : executed.result.timedOut ? 'timed_out' : 'exit_nonzero',
          exitCode: executed.result.exitCode,
        },
      }
    }
  }
  return { passed: true, results }
}

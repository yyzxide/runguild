import { createHash } from 'node:crypto'
import { lstat, readlink, realpath, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

import type { TaskWorktreeRepository } from '@runguild/database'
import type { EvidenceKind, EvidenceRef, ToolAction, TypedSideEffect } from '@runguild/protocol'
import type { ToolHandler, ToolHandlerContext } from '@runguild/tool-gateway'

const MAX_CAPTURE_BYTES = 256 * 1024
const MAX_PATCH_BYTES = 1024 * 1024
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_GIT_DIFF_BYTES = 2 * 1024 * 1024

interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
}

export interface EvidenceDraft {
  readonly kind: EvidenceKind
  readonly uri: string
  readonly contentHash: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface WorkspaceEvidenceRecorder {
  record(context: ToolHandlerContext, draft: EvidenceDraft): Promise<readonly EvidenceRef[]>
}

export interface WorkspaceToolsOptions {
  readonly root: string
  readonly allowedTestCommands: readonly (readonly string[])[]
  readonly evidence: WorkspaceEvidenceRecorder
  readonly worktrees?: Pick<TaskWorktreeRepository, 'get' | 'recordCommit' | 'recordUnchangedIntegration'>
  readonly maxTestTimeoutMs?: number
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function appendCapture(
  current: string,
  chunk: Buffer,
  maximum: number,
): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(current) >= maximum) {
    return { value: current, truncated: true }
  }
  const remaining = maximum - Buffer.byteLength(current)
  const sliced = chunk.subarray(0, remaining).toString('utf8')
  return { value: current + sliced, truncated: chunk.length > remaining }
}

async function runCommand(input: {
  readonly command: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly stdin?: string
  readonly abortSignal?: AbortSignal
  readonly maxCaptureBytes?: number
}): Promise<CommandResult> {
  const [executable, ...args] = input.command
  if (!executable) throw new Error('Command cannot be empty')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: input.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? 'C.UTF-8',
        CI: 'true',
      },
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const maxCaptureBytes = input.maxCaptureBytes ?? MAX_CAPTURE_BYTES

    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 2_000)
        killTimer.unref()
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, input.timeoutMs)
    const abort = () => stop()
    input.abortSignal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendCapture(stdout, chunk, maxCaptureBytes)
      stdout = next.value
      truncated ||= next.truncated
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendCapture(stderr, chunk, maxCaptureBytes)
      stderr = next.value
      truncated ||= next.truncated
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      input.abortSignal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      input.abortSignal?.removeEventListener('abort', abort)
      resolvePromise({ exitCode: code, stdout, stderr, truncated, timedOut })
    })
    if (input.stdin === undefined) child.stdin.end()
    else child.stdin.end(input.stdin)
  })
}

class WorkspaceBoundary {
  readonly root: string

  private constructor(root: string) {
    this.root = root
  }

  static async create(root: string): Promise<WorkspaceBoundary> {
    const canonical = await realpath(resolve(root))
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('Workspace root must be a directory')
    return new WorkspaceBoundary(canonical)
  }

  contains(path: string): boolean {
    const child = relative(this.root, path)
    return child === '' || (!child.startsWith('..' + sep) && child !== '..' && !isAbsolute(child))
  }

  async existing(path: string): Promise<{ readonly absolute: string; readonly relative: string }> {
    if (!path.trim()) throw new Error('Workspace path cannot be empty')
    const candidate = resolve(this.root, path)
    const canonical = await realpath(candidate)
    if (!this.contains(canonical)) throw new Error('Path escapes the assigned workspace: ' + path)
    return { absolute: canonical, relative: relative(this.root, canonical) || '.' }
  }

  async patchTarget(path: string): Promise<string> {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path === '.git' || path.startsWith('.git/')) {
      throw new Error('Patch contains an unsafe path: ' + path)
    }
    const candidate = resolve(this.root, path)
    if (!this.contains(candidate)) throw new Error('Patch path escapes the assigned workspace: ' + path)
    try {
      const canonical = await realpath(candidate)
      if (!this.contains(canonical)) throw new Error('Patch target resolves outside the workspace: ' + path)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') throw error
      const parent = await realpath(dirname(candidate))
      if (!this.contains(parent)) throw new Error('Patch parent resolves outside the workspace: ' + path)
    }
    return path
  }
}

function patchPaths(diff: string): readonly string[] {
  const paths = new Set<string>()
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue
    const raw = line.slice(4).split('\t', 1)[0]?.trim()
    if (!raw || raw === '/dev/null') continue
    const withoutPrefix = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw
    paths.add(withoutPrefix)
  }
  if (paths.size === 0) throw new Error('Patch contains no file paths')
  return [...paths]
}

function normalizeUnifiedDiffHunkCounts(diff: string): {
  readonly diff: string
  readonly changed: boolean
} {
  const lines = diff.split('\n')
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]
    if (header === undefined) continue
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header)
    if (!match) continue
    let oldCount = 0
    let newCount = 0
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const line = lines[bodyIndex]
      if (line === undefined || line.startsWith('@@ ') || line.startsWith('diff --git ')) break
      if (line === '\\ No newline at end of file') continue
      if (line.startsWith(' ')) {
        oldCount += 1
        newCount += 1
      } else if (line.startsWith('-')) {
        oldCount += 1
      } else if (line.startsWith('+')) {
        newCount += 1
      } else {
        break
      }
    }
    const normalized = '@@ -' + match[1] + ',' + oldCount +
      ' +' + match[2] + ',' + newCount + ' @@' + match[3]
    if (normalized !== header) {
      lines[index] = normalized
      changed = true
    }
  }
  return { diff: lines.join('\n'), changed }
}

function exactCommandAllowed(
  command: readonly string[],
  allowlist: readonly (readonly string[])[],
): boolean {
  return allowlist.some((allowed) =>
    allowed.length === command.length && allowed.every((part, index) => part === command[index]))
}

async function assertStagedSymlinksStayInsideWorkspace(
  boundary: WorkspaceBoundary,
  abortSignal?: AbortSignal,
): Promise<void> {
  const changed = await runCommand({
    command: ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--'],
    cwd: boundary.root,
    timeoutMs: 30_000,
    maxCaptureBytes: MAX_GIT_DIFF_BYTES,
    ...(abortSignal === undefined ? {} : { abortSignal }),
  })
  if (changed.exitCode !== 0 || changed.truncated) {
    throw new Error(changed.truncated
      ? 'Staged path list exceeds the 2 MiB safety limit'
      : 'Staged path inspection failed: ' + changed.stderr)
  }
  for (const path of changed.stdout.split('\0').filter(Boolean)) {
    const absolute = resolve(boundary.root, path)
    if (!boundary.contains(absolute)) throw new Error('Staged path escapes the assigned workspace: ' + path)
    const info = await lstat(absolute)
    if (!info.isSymbolicLink()) continue
    const target = await readlink(absolute)
    if (isAbsolute(target)) {
      throw new Error('Staged symlink must use a relative in-Worktree target: ' + path)
    }
    const resolvedTarget = resolve(dirname(absolute), target)
    if (!boundary.contains(resolvedTarget)) {
      throw new Error('Staged symlink resolves outside the assigned Worktree: ' + path)
    }
    let canonicalTarget: string
    try {
      canonicalTarget = await realpath(resolvedTarget)
    } catch {
      throw new Error('Staged symlink target must exist and resolve safely inside the Worktree: ' + path)
    }
    if (!boundary.contains(canonicalTarget)) {
      throw new Error('Staged symlink resolves outside the assigned Worktree: ' + path)
    }
  }
}

export async function createWorkspaceToolHandlers(options: WorkspaceToolsOptions): Promise<readonly [
  ToolHandler<'repo.search'>,
  ToolHandler<'repo.status'>,
  ToolHandler<'repo.diff'>,
  ToolHandler<'file.read'>,
  ToolHandler<'file.patch'>,
  ToolHandler<'repo.commit'>,
  ToolHandler<'test.run'>,
]> {
  const boundary = await WorkspaceBoundary.create(options.root)
  const maxTestTimeoutMs = options.maxTestTimeoutMs ?? 120_000
  if (!Number.isInteger(maxTestTimeoutMs) || maxTestTimeoutMs < 1_000 || maxTestTimeoutMs > 900_000) {
    throw new RangeError('maxTestTimeoutMs must be an integer between 1000 and 900000')
  }

  const search: ToolHandler<'repo.search'> = {
    action: 'repo.search',
    risk: 'read_only',
    retryMode: 'read_only',
    async execute(input, context) {
      if (!input.query.trim() || input.query.length > 500) {
        throw new Error('Search query must be between 1 and 500 characters')
      }
      const requested = input.paths?.length ? input.paths : ['.']
      if (requested.length > 50) throw new Error('Search accepts at most 50 paths')
      const paths: string[] = []
      for (const item of requested) paths.push((await boundary.existing(item)).relative)
      const command = ['rg', '--json', '--max-count', '100', '--glob', '!.git', '--', input.query, ...paths]
      const result = await runCommand({
        command,
        cwd: boundary.root,
        timeoutMs: 30_000,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error('Repository search failed: ' + result.stderr)
      }
      const matches: Array<{ path: string; line: number; preview: string }> = []
      for (const line of result.stdout.split('\n')) {
        if (!line) continue
        let record: {
          type: string
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
        }
        try {
          record = JSON.parse(line) as typeof record
        } catch {
          if (result.truncated) continue
          throw new Error('Repository search returned malformed JSON output')
        }
        if (record.type !== 'match' || !record.data?.path?.text || !record.data.line_number) continue
        matches.push({
          path: record.data.path.text,
          line: record.data.line_number,
          preview: (record.data.lines?.text ?? '').trimEnd().slice(0, 500),
        })
      }
      const contentHash = hash(JSON.stringify({ query: input.query, paths, matches }))
      const citation = await options.evidence.record(context, {
        kind: 'citation',
        uri: 'repo-search://' + contentHash,
        contentHash,
        metadata: { query: input.query, paths, matches },
      })
      const commandResult = await options.evidence.record(context, {
        kind: 'command_result',
        uri: 'command-result://' + context.request.id + '#' + contentHash,
        contentHash,
        metadata: { command, exitCode: result.exitCode, truncated: result.truncated },
      })
      return { output: { matches }, evidence: [...citation, ...commandResult] }
    },
  }

  const repositoryStatus: ToolHandler<'repo.status'> = {
    action: 'repo.status',
    risk: 'read_only',
    retryMode: 'read_only',
    async execute(_input, context) {
      const status = await runCommand({
        command: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        cwd: boundary.root,
        timeoutMs: 30_000,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      const branch = await runCommand({
        command: ['git', 'branch', '--show-current'],
        cwd: boundary.root,
        timeoutMs: 30_000,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      const head = await runCommand({
        command: ['git', 'rev-parse', '--verify', 'HEAD^{commit}'],
        cwd: boundary.root,
        timeoutMs: 30_000,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      if (status.exitCode !== 0 || branch.exitCode !== 0 || head.exitCode !== 0) {
        throw new Error('Repository status is unavailable: ' + (status.stderr || branch.stderr || head.stderr))
      }
      const entries = status.stdout.split('\n').filter(Boolean)
      const output = {
        branch: branch.stdout.trim(),
        headCommit: head.stdout.trim(),
        clean: entries.length === 0,
        entries,
      }
      const contentHash = hash(JSON.stringify(output))
      const evidence = await options.evidence.record(context, {
        kind: 'command_result',
        uri: 'git-status://' + output.headCommit + '#' + contentHash,
        contentHash,
        metadata: output,
      })
      return { output, evidence }
    },
  }

  const repositoryDiff: ToolHandler<'repo.diff'> = {
    action: 'repo.diff',
    risk: 'read_only',
    retryMode: 'read_only',
    async execute(_input, context) {
      const result = await runCommand({
        command: ['git', 'diff', '--binary', '--no-ext-diff', 'HEAD', '--'],
        cwd: boundary.root,
        timeoutMs: 30_000,
        maxCaptureBytes: MAX_GIT_DIFF_BYTES,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      if (result.exitCode !== 0) throw new Error('Repository diff failed: ' + result.stderr)
      return {
        output: {
          diff: result.stdout,
          diffHash: hash(result.stdout),
          truncated: result.truncated,
        },
      }
    },
  }

  const read: ToolHandler<'file.read'> = {
    action: 'file.read',
    risk: 'read_only',
    retryMode: 'read_only',
    async execute(input, context) {
      const target = await boundary.existing(input.path)
      const info = await stat(target.absolute)
      if (!info.isFile()) throw new Error('Path is not a file: ' + input.path)
      if (info.size > MAX_READ_BYTES) throw new Error('File exceeds the 2 MiB read limit')
      const content = await readFile(target.absolute, 'utf8')
      if (content.includes('\0')) throw new Error('Binary files cannot be read as text')
      const lines = content.split('\n')
      const start = input.startLine ?? 1
      const end = input.endLine ?? Math.min(lines.length, start + 499)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 2_000) {
        throw new Error('Invalid line range')
      }
      const output = {
        path: target.relative,
        content: lines.slice(start - 1, end).join('\n'),
        truncated: end < lines.length,
      }
      const contentHash = hash(output.content)
      const evidence = await options.evidence.record(context, {
        kind: 'citation',
        uri: 'workspace://' + target.relative + '#L' + start + '-L' + end,
        contentHash,
        metadata: { path: target.relative, startLine: start, endLine: end, truncated: output.truncated },
      })
      return { output, evidence }
    },
  }

  const patch: ToolHandler<'file.patch'> = {
    action: 'file.patch',
    risk: 'workspace_write',
    retryMode: 'native_idempotency',
    leaseMs: 60_000,
    async execute(input, context) {
      if (!input.unifiedDiff || Buffer.byteLength(input.unifiedDiff) > MAX_PATCH_BYTES) {
        throw new Error('Patch must be non-empty and no larger than 1 MiB')
      }
      const normalized = normalizeUnifiedDiffHunkCounts(input.unifiedDiff)
      const paths = patchPaths(normalized.diff)
      if (!paths.includes(input.path)) {
        throw new Error('Patch intent path is not present in the unified diff')
      }
      for (const path of paths) await boundary.patchTarget(path)
      const check = await runCommand({
        command: ['git', 'apply', '--check', '--whitespace=nowarn', '-'],
        cwd: boundary.root,
        timeoutMs: 30_000,
        stdin: normalized.diff,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      let alreadyApplied = false
      if (check.exitCode !== 0) {
        const reverse = await runCommand({
          command: ['git', 'apply', '--reverse', '--check', '--whitespace=nowarn', '-'],
          cwd: boundary.root,
          timeoutMs: 30_000,
          stdin: normalized.diff,
          ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
        })
        if (reverse.exitCode !== 0) throw new Error('Patch does not apply cleanly: ' + check.stderr)
        alreadyApplied = true
      }
      if (!alreadyApplied) {
        const applied = await runCommand({
          command: ['git', 'apply', '--whitespace=nowarn', '-'],
          cwd: boundary.root,
          timeoutMs: 30_000,
          stdin: normalized.diff,
          ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
        })
        if (applied.exitCode !== 0) throw new Error('Patch application failed: ' + applied.stderr)
      }
      const diffHash = hash(normalized.diff)
      const evidence = await options.evidence.record(context, {
        kind: 'file_diff',
        uri: 'workspace://' + paths.join(',') + '#' + diffHash,
        contentHash: diffHash,
        metadata: { paths, alreadyApplied, normalizedHunkCounts: normalized.changed },
      })
      if (evidence.length === 0) throw new Error('Patch evidence was not persisted')
      const sideEffects: TypedSideEffect[] = paths.map((path) => ({
        type: 'file.changed',
        path,
        diffHash,
      }))
      return {
        output: { path: paths.length === 1 ? paths[0] ?? input.path : '<multiple>', changed: true, diffHash },
        sideEffects,
        evidence,
      }
    },
  }

  const commit: ToolHandler<'repo.commit'> = {
    action: 'repo.commit',
    risk: 'workspace_write',
    retryMode: 'native_idempotency',
    leaseMs: 60_000,
    async execute(input, context) {
      const message = input.message.trim()
      if (!message || message.length > 2_000 || message.includes('\0')) {
        throw new Error('Commit message must be between 1 and 2000 characters')
      }
      if (!options.worktrees) throw new Error('Task Worktree persistence is not configured')
      const record = await options.worktrees.get(context.request.taskId)
      if (!record || !['ready', 'committed'].includes(record.status)) {
        throw new Error('Task has no ready Worktree')
      }
      if (await realpath(record.worktreePath) !== boundary.root) {
        throw new Error('Task Worktree record does not match the assigned workspace')
      }
      const branch = await runCommand({
        command: ['git', 'branch', '--show-current'],
        cwd: boundary.root,
        timeoutMs: 30_000,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      if (branch.exitCode !== 0 || branch.stdout.trim() !== record.branchName) {
        throw new Error('Assigned Worktree is attached to the wrong branch')
      }
      const before = await runCommand({
        command: ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        cwd: boundary.root,
        timeoutMs: 30_000,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      if (before.exitCode !== 0) throw new Error('Repository status failed: ' + before.stderr)

      let commitHash: string
      let exactDiff: string
      let committed = before.stdout.trim().length > 0
      if (committed) {
        const staged = await runCommand({
          command: ['git', 'add', '-A', '--', '.'],
          cwd: boundary.root,
          timeoutMs: 30_000,
          ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
        })
        if (staged.exitCode !== 0) throw new Error('Staging Task changes failed: ' + staged.stderr)
        try {
          await assertStagedSymlinksStayInsideWorkspace(boundary, context.abortSignal)
        } catch (error) {
          const unstaged = await runCommand({
            command: ['git', 'reset', '--mixed', '--quiet', 'HEAD', '--', '.'],
            cwd: boundary.root,
            timeoutMs: 30_000,
          })
          if (unstaged.exitCode !== 0) {
            throw new Error('Unsafe staged symlink was rejected, but the index could not be restored: ' + unstaged.stderr, {
              cause: error,
            })
          }
          throw error
        }
        const diff = await runCommand({
          command: ['git', 'diff', '--cached', '--binary', '--no-ext-diff', '--'],
          cwd: boundary.root,
          timeoutMs: 30_000,
          maxCaptureBytes: MAX_GIT_DIFF_BYTES,
          ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
        })
        if (diff.exitCode !== 0 || diff.truncated) {
          throw new Error(diff.truncated
            ? 'Staged diff exceeds the 2 MiB evidence limit'
            : 'Staged diff failed: ' + diff.stderr)
        }
        exactDiff = diff.stdout
        const created = await runCommand({
          command: [
            'git', '-c', 'user.name=RunGuild',
            '-c', 'user.email=runguild@example.invalid',
            'commit', '--no-verify', '--no-gpg-sign', '-m', message,
          ],
          cwd: boundary.root,
          timeoutMs: 60_000,
          ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
        })
        if (created.exitCode !== 0) throw new Error('Task commit failed: ' + created.stderr)
        const head = await runCommand({
          command: ['git', 'rev-parse', '--verify', 'HEAD^{commit}'],
          cwd: boundary.root,
          timeoutMs: 30_000,
        })
        if (head.exitCode !== 0) throw new Error('Committed HEAD cannot be resolved')
        commitHash = head.stdout.trim()
      } else {
        const head = await runCommand({
          command: ['git', 'rev-parse', '--verify', 'HEAD^{commit}'],
          cwd: boundary.root,
          timeoutMs: 30_000,
        })
        if (head.exitCode !== 0) throw new Error('Worktree HEAD cannot be resolved')
        commitHash = head.stdout.trim()
        if (record.headCommit === commitHash && record.status === 'ready') {
          const tree = await runCommand({
            command: ['git', 'rev-parse', '--verify', 'HEAD^{tree}'],
            cwd: boundary.root,
            timeoutMs: 30_000,
          })
          if (tree.exitCode !== 0) throw new Error('Worktree tree cannot be resolved')
          await options.worktrees.recordUnchangedIntegration({
            taskId: context.request.taskId,
            headCommit: commitHash,
          })
          return {
            output: {
              committed: false,
              commit: commitHash,
              treeHash: tree.stdout.trim(),
              diffHash: hash(''),
            },
          }
        }
        const recovered = await runCommand({
          command: [
            'git', 'diff', '--binary', '--no-ext-diff',
            record.headCommit === commitHash ? record.baseCommit : record.headCommit ?? record.baseCommit,
            commitHash,
            '--',
          ],
          cwd: boundary.root,
          timeoutMs: 30_000,
          maxCaptureBytes: MAX_GIT_DIFF_BYTES,
        })
        if (recovered.exitCode !== 0 || recovered.truncated) {
          throw new Error('Committed diff recovery failed or exceeded the evidence limit')
        }
        exactDiff = recovered.stdout
        committed = record.headCommit !== commitHash
      }

      const cumulative = await runCommand({
        command: [
          'git', 'diff', '--binary', '--no-ext-diff', record.baseCommit, commitHash, '--',
        ],
        cwd: boundary.root,
        timeoutMs: 30_000,
        maxCaptureBytes: MAX_GIT_DIFF_BYTES,
      })
      if (cumulative.exitCode !== 0 || cumulative.truncated) {
        throw new Error(cumulative.truncated
          ? 'Cumulative Task diff exceeds the 2 MiB evidence limit'
          : 'Cumulative Task diff failed: ' + cumulative.stderr)
      }
      exactDiff = cumulative.stdout

      const tree = await runCommand({
        command: ['git', 'rev-parse', '--verify', 'HEAD^{tree}'],
        cwd: boundary.root,
        timeoutMs: 30_000,
      })
      if (tree.exitCode !== 0) throw new Error('Committed tree cannot be resolved')
      const treeHash = tree.stdout.trim()
      const diffHash = hash(exactDiff)
      await options.worktrees.recordCommit({ taskId: context.request.taskId, headCommit: commitHash })
      const evidence = await options.evidence.record(context, {
        kind: 'file_diff',
        uri: 'git-diff://' + commitHash + '#' + diffHash,
        contentHash: diffHash,
        metadata: {
          commit: commitHash,
          treeHash,
          branch: record.branchName,
          recovered: before.stdout.trim().length === 0,
          diff: exactDiff,
        },
      })
      if (evidence.length === 0) throw new Error('Commit evidence was not persisted')
      return {
        output: { committed, commit: commitHash, treeHash, diffHash },
        sideEffects: [{ type: 'repo.committed', commit: commitHash, treeHash, diffHash }],
        evidence,
      }
    },
  }

  const tests: ToolHandler<'test.run'> = {
    action: 'test.run',
    risk: 'workspace_write',
    retryMode: 'none',
    async execute(input, context) {
      if (!exactCommandAllowed(input.command, options.allowedTestCommands)) {
        throw new Error(
          'Test command is not in the workspace allowlist; choose one exact argv: ' +
          JSON.stringify(options.allowedTestCommands),
        )
      }
      const timeoutMs = Math.min(input.timeoutMs, maxTestTimeoutMs)
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('Invalid test timeout')
      const result = await runCommand({
        command: input.command,
        cwd: boundary.root,
        timeoutMs,
        ...(context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }),
      })
      const passed = result.exitCode === 0 && !result.timedOut
      const contentHash = hash(result.stdout + '\n---stderr---\n' + result.stderr)
      const testEvidence = await options.evidence.record(context, {
        kind: 'test_run',
        uri: 'test-run://' + context.request.id + '#' + contentHash,
        contentHash,
        metadata: { command: input.command, exitCode: result.exitCode, passed, timedOut: result.timedOut },
      })
      const commandEvidence = await options.evidence.record(context, {
        kind: 'command_result',
        uri: 'command-result://' + context.request.id + '#' + contentHash,
        contentHash,
        metadata: {
          command: input.command,
          exitCode: result.exitCode,
          passed,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      })
      const evidence = [...testEvidence, ...commandEvidence]
      const evidenceId = testEvidence[0]?.id
      if (!evidenceId) throw new Error('Test evidence was not persisted')
      return {
        output: {
          exitCode: result.exitCode,
          passed,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        },
        sideEffects: [{
          type: 'test.completed',
          passed,
          evidenceId,
        }],
        evidence,
      }
    },
  }

  return [search, repositoryStatus, repositoryDiff, read, patch, commit, tests]
}

export const WORKSPACE_TOOL_DEFINITIONS = [
  {
    action: 'repo.search' as const,
    description: 'Search text in the assigned repository. paths must be literal existing relative files/directories; globs are unsupported, and omitting paths searches the whole Worktree.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  {
    action: 'repo.status' as const,
    description: 'Inspect the assigned Task Worktree branch, HEAD, cleanliness, and changed paths.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    action: 'repo.diff' as const,
    description: 'Read the bounded binary-capable tracked diff from HEAD in the assigned Task Worktree.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    action: 'file.read' as const,
    description: 'Read a bounded UTF-8 line range from a file inside the assigned workspace.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    action: 'file.patch' as const,
    description: 'Apply a unified diff inside the assigned Git workspace. Reusing the same patch is detected safely.',
    inputSchema: {
      type: 'object',
      required: ['path', 'unifiedDiff'],
      properties: {
        path: { type: 'string' },
        unifiedDiff: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    action: 'repo.commit' as const,
    description: 'Finalize repository work. Commit all Task Worktree changes and emit exact diff evidence; when nothing changed, verify and record the clean baseline so the Task can complete without Integration.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    action: 'test.run' as const,
    description: 'Run one exact allowlisted argv from the execution policy, without Shell operators or extra commands, and return bounded output plus durable evidence.',
    inputSchema: {
      type: 'object',
      required: ['command', 'timeoutMs'],
      properties: {
        command: { type: 'array', items: { type: 'string' }, minItems: 1 },
        timeoutMs: { type: 'integer', minimum: 1000 },
      },
      additionalProperties: false,
    },
  },
] as const satisfies readonly { readonly action: ToolAction; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>> }[]

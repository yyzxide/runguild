import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type {
  AgentExecutionContext,
  ExecutionContextRepository,
  InboxMessage,
  InboxRepository,
  RunnableAgentRun,
  TaskRepository,
} from '@runguild/database'
import type {
  AgentId,
  ArtifactReviewRequestedInboxPayload,
  ConversationPlanRequestedInboxPayload,
  CorrelationId,
  MissionId,
  ModelMessage,
  RunId,
  RuntimeOutcome,
  SkillSnapshotRef,
  TaskId,
} from '@runguild/protocol'

type Inbox = Pick<InboxRepository, 'read' | 'acknowledge'>
type Tasks = Pick<
  TaskRepository,
  'claimTask' | 'resumeWaitingRun' | 'listRunnableAgentRuns' | 'renewLease' | 'releaseLease'
>
type Contexts = Pick<ExecutionContextRepository, 'load'>
type PlanningProcessor = {
  process(payload: ConversationPlanRequestedInboxPayload, plannerAgentId: AgentId): Promise<void>
}
type ReviewProcessor = {
  process(
    payload: ArtifactReviewRequestedInboxPayload,
    reviewerAgentId: AgentId,
    abortSignal?: AbortSignal,
  ): Promise<'processed' | 'deferred'>
}

export interface RuntimeRunner {
  run(input: {
    readonly runId: RunId
    readonly initialMessages: readonly ModelMessage[]
    readonly skills?: readonly SkillSnapshotRef[]
    readonly resumeWaiting?: boolean
    readonly abortSignal?: AbortSignal
  }): Promise<RuntimeOutcome>
}

export interface AgentInboxProcessorDependencies {
  readonly agentId: AgentId
  readonly inbox: Inbox
  readonly tasks: Tasks
  readonly contexts: Contexts
  readonly createRuntime: (
    context: AgentExecutionContext,
    abortSignal?: AbortSignal,
  ) => Promise<RuntimeRunner>
  readonly allowedTestCommands?: readonly (readonly string[])[]
  readonly planner?: PlanningProcessor
  readonly reviewer?: ReviewProcessor
}

export interface AgentInboxProcessorOptions {
  readonly inboxLimit: number
  readonly runLimit: number
  readonly leaseSeconds: number
  readonly waitingToolRetryMs?: number
  readonly waitingToolRetries?: number
}

interface TaskDispatchPayload {
  readonly schemaVersion: 1
  readonly type: 'task.dispatch'
  readonly dispatchToken: string
  readonly taskId: TaskId
  readonly missionId: MissionId
}

function dispatchPayload(value: unknown): TaskDispatchPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid task dispatch payload')
  const payload = value as Record<string, unknown>
  if (payload['schemaVersion'] !== 1
      || payload['type'] !== 'task.dispatch'
      || typeof payload['dispatchToken'] !== 'string'
      || typeof payload['taskId'] !== 'string'
      || typeof payload['missionId'] !== 'string') {
    throw new Error('Invalid task dispatch payload')
  }
  return payload as unknown as TaskDispatchPayload
}

function planningPayload(value: unknown): ConversationPlanRequestedInboxPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid Conversation Planning payload')
  const payload = value as Record<string, unknown>
  if (payload['schemaVersion'] !== 1
      || payload['type'] !== 'conversation.plan_requested'
      || typeof payload['requestId'] !== 'string'
      || typeof payload['conversationId'] !== 'string'
      || typeof payload['missionId'] !== 'string') {
    throw new Error('Invalid Conversation Planning payload')
  }
  return payload as unknown as ConversationPlanRequestedInboxPayload
}

function reviewPayload(value: unknown): ArtifactReviewRequestedInboxPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid Artifact Review payload')
  const payload = value as Record<string, unknown>
  if (payload['schemaVersion'] !== 1
      || payload['type'] !== 'artifact.review_requested'
      || typeof payload['reviewId'] !== 'string'
      || typeof payload['submissionId'] !== 'string'
      || typeof payload['missionId'] !== 'string'
      || typeof payload['taskId'] !== 'string') {
    throw new Error('Invalid Artifact Review payload')
  }
  return payload as unknown as ArtifactReviewRequestedInboxPayload
}

export function executionMessages(
  context: AgentExecutionContext,
  allowedTestCommands: readonly (readonly string[])[] = [],
): readonly ModelMessage[] {
  // Frozen contexts created before the Conversation Plane shipped do not have
  // this field. Treat them as an empty team-room transcript during replay.
  const teamMessages = context.conversationMessages ?? []
  const criteria = context.acceptanceCriteria.length === 0
    ? 'No explicit acceptance criteria.'
    : context.acceptanceCriteria.map((criterion) =>
      '- ' + criterion.key + ': ' + criterion.description +
      (criterion.evidenceKinds.length === 0
        ? ''
        : ' (evidence: ' + criterion.evidenceKinds.join(', ') + ')')).join('\n')
  const skillMessages: ModelMessage[] = (context.skills ?? []).map((skill) => ({
    role: 'system',
    content: [
      'Assigned Skill: ' + skill.name,
      'Skill Version: ' + skill.versionId,
      'Skill SHA-256: ' + skill.contentHash,
      'This is a frozen Workspace operating procedure. Runtime safety and Task constraints take precedence.',
      skill.instructions,
    ].join('\n\n'),
  }))
  const conversationMessage: ModelMessage[] = teamMessages.length === 0
    ? []
    : [{
        role: 'user',
        content: [
          'Durable RunGuild team-room context for this Mission' +
            (context.conversationId ? ' (Conversation ' + context.conversationId + ')' : '') + ':',
          ...teamMessages.map((message) =>
            '[' + message.createdAt + '] ' + message.authorName +
            ' (' + message.authorKind + ':' + message.authorId + '): ' + message.body),
          'Treat these messages as collaboration context. Verify facts with tools before changing code.',
        ].join('\n'),
      }]
  const missionArtifacts = context.missionArtifacts ?? []
  const artifactLines = missionArtifacts.length === 0
    ? ['Mission Artifacts: none are available.']
    : [
        'Mission Artifacts (use these exact durable ids):',
        ...missionArtifacts.map((artifact) =>
          '- ' + artifact.id + ' · ' + artifact.title + ' [' + artifact.kind + ']'),
      ]
  const reviewInstructions = context.reviewRequired
    ? [
        'Independent review is required for this Task.',
        'Before run.set_status(done): update the Mission Artifact with a concise deliverable/evidence summary, ' +
          'create an immutable Artifact Version, commit repository changes when present, and submit that exact Version for review.',
      ]
    : ['Independent review is not required for this Task.']
  return [
    {
      role: 'system',
      content:
        'You are the ' + context.agentRole + ' Agent for an isolated software mission. ' +
        'Inspect facts with tools, make bounded changes, run allowlisted verification, and report evidence. ' +
        'Before requesting done, call repo.commit even when no code changed so the Worktree can be verified and finalized. ' +
        'Never invent command results or claim a file changed without a successful tool result.\n\n' +
        'Execution policy:\n' +
        '- test.run accepts only these exact argv arrays: ' + JSON.stringify(allowedTestCommands) + '.\n' +
        '- Never add Shell operators such as &&, ||, ;, pipes, redirection, or extra environment-probe commands to argv.\n' +
        '- repo.search paths are literal existing relative files or directories; globs are unsupported. Omit paths to search the whole Worktree.\n' +
        '- Batch independent reads/searches in one response. Spend at most 8 model hops on discovery, then begin file.patch.\n' +
        '- Do not use test.run for environment discovery. Use it only for an exact configured verification command.',
    },
    ...skillMessages,
    ...conversationMessage,
    {
      role: 'user',
      content: [
        'Mission: ' + context.missionTitle,
        'Goal: ' + context.missionGoal,
        ...(context.conversationId ? ['Team conversation: ' + context.conversationId] : []),
        'Constraints: ' + JSON.stringify(context.missionConstraints),
        'Assigned task: ' + context.taskTitle,
        context.taskDescription,
        ...artifactLines,
        ...reviewInstructions,
        'Acceptance criteria:',
        criteria,
      ].filter(Boolean).join('\n\n'),
    },
  ]
}

export class AgentInboxProcessor {
  constructor(
    private readonly dependencies: AgentInboxProcessorDependencies,
    private readonly options: AgentInboxProcessorOptions,
  ) {
    if (!Number.isInteger(options.leaseSeconds) || options.leaseSeconds < 5 || options.leaseSeconds > 3_600) {
      throw new RangeError('leaseSeconds must be an integer between 5 and 3600')
    }
  }

  async tick(abortSignal?: AbortSignal): Promise<{ readonly inboxProcessed: number; readonly runsExecuted: number }> {
    abortSignal?.throwIfAborted()
    const batch = await this.dependencies.inbox.read({
      agentId: this.dependencies.agentId,
      limit: this.options.inboxLimit,
    })
    let cursor = batch.cursor
    let inboxProcessed = 0
    for (const message of batch.messages) {
      abortSignal?.throwIfAborted()
      const ingested = await this.ingest(message, abortSignal)
      if (!ingested) break
      const acknowledged = await this.dependencies.inbox.acknowledge({
        agentId: this.dependencies.agentId,
        expectedCursor: cursor,
        throughSeq: message.seq,
      })
      if (!acknowledged) throw new Error('Agent inbox cursor changed concurrently')
      cursor = message.seq
      inboxProcessed += 1
    }

    const runnable = await this.dependencies.tasks.listRunnableAgentRuns(
      this.dependencies.agentId,
      this.options.runLimit,
    )
    let runsExecuted = 0
    for (const run of runnable) {
      abortSignal?.throwIfAborted()
      await this.execute(run, abortSignal)
      runsExecuted += 1
    }
    return { inboxProcessed, runsExecuted }
  }

  private async ingest(message: InboxMessage, abortSignal?: AbortSignal): Promise<boolean> {
    if (message.kind === 'conversation.plan_requested') {
      if (!this.dependencies.planner) throw new Error('Conversation Planner is not configured')
      await this.dependencies.planner.process(planningPayload(message.payload), this.dependencies.agentId)
      return true
    }
    if (message.kind === 'artifact.review_requested') {
      if (!this.dependencies.reviewer) throw new Error('Artifact Reviewer is not configured')
      return await this.dependencies.reviewer.process(
        reviewPayload(message.payload),
        this.dependencies.agentId,
        abortSignal,
      ) === 'processed'
    }
    if (message.kind === 'task.dispatch') {
      const payload = dispatchPayload(message.payload)
      await this.dependencies.tasks.claimTask({
        workspaceId: message.workspaceId,
        missionId: payload.missionId,
        taskId: payload.taskId,
        agentId: this.dependencies.agentId,
        runId: ('run_' + randomUUID()) as RunId,
        correlationId: ('agent_claim_' + randomUUID()) as CorrelationId,
        dispatchToken: payload.dispatchToken,
        leaseSeconds: this.options.leaseSeconds,
        contextSnapshot: { inboxMessageId: message.id, inboxSeq: message.seq.toString() },
      })
      return true
    }
    if ((message.kind === 'tool.approval_resolved' || message.kind === 'run.control') && message.runId) {
      await this.dependencies.tasks.resumeWaitingRun({
        runId: message.runId,
        agentId: this.dependencies.agentId,
        leaseSeconds: this.options.leaseSeconds,
      })
    }
    return true
  }

  private async execute(run: RunnableAgentRun, workerAbortSignal?: AbortSignal): Promise<void> {
    const context = await this.dependencies.contexts.load(run.runId, this.dependencies.agentId)
    if (!context) throw new Error('Execution context not found for ' + run.runId)
    const abortController = new AbortController()
    const abortFromWorker = () => abortController.abort(
      workerAbortSignal?.reason ?? new Error('Agent Worker ownership was lost'),
    )
    if (workerAbortSignal?.aborted) abortFromWorker()
    else workerAbortSignal?.addEventListener('abort', abortFromWorker, { once: true })
    let renewing = false
    const heartbeat = setInterval(() => {
      if (renewing) return
      renewing = true
      void this.dependencies.tasks.renewLease({
        taskId: run.taskId,
        runId: run.runId,
        agentId: this.dependencies.agentId,
        leaseToken: run.leaseToken,
        leaseSeconds: this.options.leaseSeconds,
      }).then((expiresAt) => {
        if (!expiresAt) abortController.abort(new Error('Task lease was lost'))
      }).catch((error: unknown) => abortController.abort(error)).finally(() => {
        renewing = false
      })
    }, Math.max(1_000, Math.floor(this.options.leaseSeconds * 1_000 / 3)))

    let outcome: RuntimeOutcome
    try {
      const runtime = await this.dependencies.createRuntime(context, abortController.signal)
      outcome = await runtime.run({
        runId: run.runId,
        initialMessages: executionMessages(context, this.dependencies.allowedTestCommands),
        skills: (context.skills ?? []).map((skill) => ({
          skillId: skill.skillId,
          versionId: skill.versionId,
          name: skill.name,
          contentHash: skill.contentHash,
          estimatedTokens: skill.estimatedTokens,
          priority: skill.priority,
        })),
        resumeWaiting: true,
        abortSignal: abortController.signal,
      })
      const retries = this.options.waitingToolRetries ?? 10
      for (let attempt = 0; outcome.status === 'waiting_tool' && attempt < retries; attempt += 1) {
        await delay(this.options.waitingToolRetryMs ?? 1_000, undefined, { signal: abortController.signal })
        outcome = await runtime.run({
          runId: run.runId,
          initialMessages: executionMessages(context, this.dependencies.allowedTestCommands),
          skills: (context.skills ?? []).map((skill) => ({
            skillId: skill.skillId,
            versionId: skill.versionId,
            name: skill.name,
            contentHash: skill.contentHash,
            estimatedTokens: skill.estimatedTokens,
            priority: skill.priority,
          })),
          resumeWaiting: true,
          abortSignal: abortController.signal,
        })
      }
    } finally {
      clearInterval(heartbeat)
      workerAbortSignal?.removeEventListener('abort', abortFromWorker)
    }

    if (outcome.status === 'waiting_human' || outcome.status === 'succeeded') {
      await this.dependencies.tasks.releaseLease({
        taskId: run.taskId,
        runId: run.runId,
        agentId: this.dependencies.agentId,
        leaseToken: run.leaseToken,
      })
    }
  }
}

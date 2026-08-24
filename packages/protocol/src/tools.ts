import type { ArtifactOperation, EvidenceRef, ReviewFinding } from './artifacts.js'
import type { MissionPlanDraft } from './plans.js'
import type {
  AgentId,
  ApprovalId,
  ArtifactId,
  ArtifactVersionId,
  ConversationId,
  IsoTimestamp,
  MessageId,
  MissionId,
  RunId,
  TaskId,
  TaskSubmissionId,
  ToolCallId,
  WorkspaceId,
} from './ids.js'

export interface ToolActionInputs {
  'mission.propose_plan': MissionPlanDraft
  'task.claim': {
    readonly taskId: TaskId
    readonly leaseSeconds: number
  }
  'task.complete': {
    readonly taskId: TaskId
    readonly summary: string
    readonly evidence: readonly EvidenceRef[]
  }
  'artifact.read': {
    readonly artifactId: ArtifactId
  }
  'artifact.edit': {
    readonly artifactId: ArtifactId
    readonly intent: string
    readonly operations: readonly ArtifactOperation[]
  }
  'artifact.create_version': {
    readonly artifactId: ArtifactId
    readonly reason: 'review' | 'delivery' | 'manual'
  }
  'artifact.submit_for_review': {
    readonly artifactVersionId: ArtifactVersionId
    readonly note?: string
  }
  'review.submit_decision': {
    readonly decision: 'approved' | 'rejected' | 'changes_requested'
    readonly summary: string
    readonly findings: readonly ReviewFinding[]
  }
  'conversation.reply': {
    readonly conversationId: ConversationId
    readonly body: string
    readonly mentions?: readonly AgentId[]
    readonly replyToMessageId?: MessageId
  }
  'repo.search': {
    readonly query: string
    readonly paths?: readonly string[]
  }
  'repo.status': Record<string, never>
  'repo.diff': Record<string, never>
  'repo.commit': {
    readonly message: string
  }
  'file.read': {
    readonly path: string
    readonly startLine?: number
    readonly endLine?: number
  }
  'file.patch': {
    readonly path: string
    readonly unifiedDiff: string
  }
  'shell.run': {
    readonly command: readonly string[]
    readonly timeoutMs: number
  }
  'test.run': {
    readonly command: readonly string[]
    readonly timeoutMs: number
  }
  'run.set_status': {
    readonly status: 'done' | 'blocked' | 'failed' | 'waiting_human'
    readonly summary: string
    readonly evidence?: readonly EvidenceRef[]
    readonly nextStep?: string
  }
}

export interface ToolActionOutputs {
  'mission.propose_plan': {
    readonly accepted: boolean
    readonly version?: number
  }
  'task.claim': {
    readonly claimed: boolean
    readonly leaseExpiresAt?: IsoTimestamp
  }
  'task.complete': {
    readonly accepted: boolean
    readonly nextStatus: 'reviewing' | 'completed'
  }
  'artifact.read': {
    readonly document: Readonly<Record<string, unknown>>
    readonly comments: Readonly<Record<string, unknown>>
    readonly stateHash: string
    readonly throughUpdateSeq: string
  }
  'artifact.edit': {
    readonly applied: boolean
    readonly updateHash: string
  }
  'artifact.create_version': {
    readonly versionId: ArtifactVersionId
    readonly contentHash: string
  }
  'artifact.submit_for_review': {
    readonly submissionId: TaskSubmissionId
    readonly evidenceBundleHash: string
  }
  'review.submit_decision': {
    readonly accepted: boolean
  }
  'conversation.reply': {
    readonly messageId: MessageId
    readonly deliveredAgentIds: readonly AgentId[]
    readonly pendingAgentIds: readonly AgentId[]
  }
  'repo.search': {
    readonly matches: readonly {
      readonly path: string
      readonly line: number
      readonly preview: string
    }[]
  }
  'repo.status': {
    readonly branch: string
    readonly headCommit: string
    readonly clean: boolean
    readonly entries: readonly string[]
  }
  'repo.diff': {
    readonly diff: string
    readonly diffHash: string
    readonly truncated: boolean
  }
  'repo.commit': {
    readonly committed: boolean
    readonly commit: string
    readonly treeHash: string
    readonly diffHash: string
  }
  'file.read': {
    readonly path: string
    readonly content: string
    readonly truncated: boolean
  }
  'file.patch': {
    readonly path: string
    readonly changed: boolean
    readonly diffHash: string
  }
  'shell.run': {
    readonly exitCode: number | null
    readonly stdout: string
    readonly stderr: string
    readonly truncated: boolean
  }
  'test.run': {
    readonly exitCode: number | null
    readonly passed: boolean
    readonly stdout: string
    readonly stderr: string
    readonly truncated: boolean
  }
  'run.set_status': {
    readonly accepted: boolean
  }
}

export type ToolAction = keyof ToolActionInputs

export type ToolRisk = 'read_only' | 'workspace_write' | 'external_write' | 'destructive'

export type ToolRetryMode = 'read_only' | 'native_idempotency' | 'none'

export interface ToolRequest<Action extends ToolAction = ToolAction> {
  readonly schemaVersion: 1
  readonly id: ToolCallId
  readonly action: Action
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly agentId: AgentId
  readonly idempotencyKey: string
  readonly risk: ToolRisk
  readonly input: ToolActionInputs[Action]
  readonly createdAt: IsoTimestamp
  readonly deadlineAt?: IsoTimestamp
}

export type AnyToolRequest = {
  readonly [Action in ToolAction]: ToolRequest<Action>
}[ToolAction]

export type TypedSideEffect =
  | { readonly type: 'mission.plan_proposed'; readonly missionId: MissionId; readonly version: number }
  | { readonly type: 'task.claimed'; readonly taskId: TaskId; readonly agentId: AgentId }
  | { readonly type: 'task.completed'; readonly taskId: TaskId }
  | { readonly type: 'artifact.updated'; readonly artifactId: ArtifactId; readonly updateHash: string }
  | { readonly type: 'artifact.version_created'; readonly artifactId: ArtifactId; readonly versionId: ArtifactVersionId }
  | { readonly type: 'artifact.submitted'; readonly versionId: ArtifactVersionId; readonly submissionId: TaskSubmissionId }
  | { readonly type: 'message.posted'; readonly conversationId: ConversationId; readonly messageId: MessageId }
  | { readonly type: 'file.changed'; readonly path: string; readonly diffHash: string }
  | { readonly type: 'repo.committed'; readonly commit: string; readonly treeHash: string; readonly diffHash: string }
  | { readonly type: 'test.completed'; readonly passed: boolean; readonly evidenceId: string }

export interface ToolFailure {
  readonly code:
    | 'invalid_input'
    | 'forbidden'
    | 'conflict'
    | 'timeout'
    | 'dependency_unavailable'
    | 'execution_failed'
    | 'ambiguous_effect'
  readonly message: string
  readonly retryable: boolean
}

export type ToolResult<Action extends ToolAction = ToolAction> =
  | {
      readonly status: 'succeeded'
      readonly output: ToolActionOutputs[Action]
      readonly sideEffects: readonly TypedSideEffect[]
      readonly evidence: readonly EvidenceRef[]
    }
  | {
      readonly status: 'awaiting_approval'
      readonly approvalId: ApprovalId
    }
  | {
      readonly status: 'in_progress'
      readonly retryAfterMs: number
    }
  | {
      readonly status: 'failed'
      readonly error: ToolFailure
      readonly effectState: 'none' | 'partial' | 'unknown'
      readonly sideEffects: readonly TypedSideEffect[]
    }

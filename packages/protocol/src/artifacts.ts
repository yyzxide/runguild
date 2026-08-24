import type {
  AgentId,
  ArtifactId,
  ArtifactVersionId,
  EvidenceId,
  IsoTimestamp,
  MissionId,
  RunId,
  ReviewId,
  TaskId,
  TaskSubmissionId,
  ToolCallId,
  UserId,
  WorkspaceId,
} from './ids.js'
import type { ActorRef } from './ids.js'

export interface AgentArtifactOrigin {
  readonly kind: 'agent'
  readonly agentId: AgentId
  readonly runId: RunId
  readonly taskId: TaskId
  readonly toolCallId: ToolCallId
  readonly intent: string
}

export interface UserArtifactOrigin {
  readonly kind: 'user'
  readonly userId: UserId
  readonly sessionId: string
}

export interface ServiceArtifactOrigin {
  readonly kind: 'service'
  readonly serviceId: string
  readonly operation: string
}

export type ArtifactUpdateOrigin =
  | AgentArtifactOrigin
  | UserArtifactOrigin
  | ServiceArtifactOrigin

export type ArtifactOperation =
  | {
      readonly kind: 'insert_section'
      readonly heading: string
      readonly content: string
      readonly afterBlockId?: string
    }
  | {
      readonly kind: 'replace_block'
      readonly blockId: string
      readonly content: string
    }
  | {
      readonly kind: 'append_content'
      readonly content: string
    }
  | {
      readonly kind: 'add_comment'
      readonly blockId: string
      readonly body: string
    }

export interface ArtifactEdit {
  readonly artifactId: ArtifactId
  readonly origin: AgentArtifactOrigin
  readonly operations: readonly ArtifactOperation[]
}

export interface ArtifactVersion {
  readonly id: ArtifactVersionId
  readonly artifactId: ArtifactId
  readonly version: number
  readonly contentHash: string
  readonly yjsStateHash: string
  readonly throughUpdateSeq: bigint
  readonly createdBy: ActorRef
  readonly createdAt: IsoTimestamp
  readonly createdByRunId?: RunId
}

export type TaskSubmissionStatus = 'submitted' | 'in_review' | 'approved' | 'rejected' | 'superseded'

export interface TaskSubmission {
  readonly id: TaskSubmissionId
  readonly workspaceId: WorkspaceId
  readonly missionId: MissionId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly artifactVersionId: ArtifactVersionId
  readonly submittedByAgentId: AgentId
  readonly status: TaskSubmissionStatus
  readonly evidenceBundleHash: string
  readonly note: string
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface ReviewFinding {
  readonly severity: 'info' | 'warning' | 'error'
  readonly summary: string
  readonly evidenceIds?: readonly EvidenceId[]
}

export interface ArtifactReview {
  readonly id: ReviewId
  readonly submissionId: TaskSubmissionId
  readonly status: 'requested' | 'in_progress' | 'approved' | 'rejected' | 'changes_requested' | 'cancelled'
  readonly reviewer: ActorRef
  readonly summary: string
  readonly findings: readonly ReviewFinding[]
  readonly createdAt: IsoTimestamp
  readonly completedAt?: IsoTimestamp
}

export interface ArtifactReviewRequestedInboxPayload {
  readonly schemaVersion: 1
  readonly type: 'artifact.review_requested'
  readonly reviewId: ReviewId
  readonly submissionId: TaskSubmissionId
  readonly missionId: MissionId
  readonly taskId: TaskId
}

export const EVIDENCE_KINDS = [
  'test_run',
  'command_result',
  'file_diff',
  'artifact_version',
  'trace_span',
  'citation',
  'human_attestation',
] as const

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export interface EvidenceRef {
  readonly id: EvidenceId
  readonly kind: EvidenceKind
  readonly uri: string
  readonly contentHash?: string
  readonly producerRunId?: RunId
  readonly createdAt: IsoTimestamp
  readonly expiresAt?: IsoTimestamp
}

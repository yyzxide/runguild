import type { EvidenceRef } from './artifacts.js'
import type {
  ActorRef,
  AgentId,
  ArtifactId,
  ArtifactVersionId,
  ConversationId,
  ConversationPlanningRequestId,
  CorrelationId,
  EventId,
  IsoTimestamp,
  MissionId,
  MessageId,
  ProjectId,
  ReviewId,
  RunId,
  TaskId,
  ToolCallId,
  WorkspaceId,
} from './ids.js'
import type { MissionStatus, ReviewStatus, RunStatus, TaskStatus } from './states.js'
import type { ToolAction, TypedSideEffect } from './tools.js'

export interface DomainEventPayloads {
  'conversation.planning_requested': {
    readonly conversationId: ConversationId
    readonly requestId: ConversationPlanningRequestId
    readonly sourceMessageIds: readonly MessageId[]
    readonly plannerAgentId: AgentId
  }
  'conversation.created': {
    readonly conversationId: ConversationId
    readonly title: string
  }
  'message.posted': {
    readonly conversationId: ConversationId
    readonly messageId: MessageId
    readonly mentionedAgentIds: readonly AgentId[]
  }
  'mission.created': {
    readonly title: string
  }
  'mission.status_changed': {
    readonly from: MissionStatus
    readonly to: MissionStatus
    readonly reason: string
  }
  'mission.plan_approved': {
    readonly taskIds: readonly TaskId[]
  }
  'mission.plan_proposed': {
    readonly version: number
    readonly planHash: string
    readonly taskCount: number
  }
  'task.created': {
    readonly taskId: TaskId
    readonly title: string
    readonly dependsOn: readonly TaskId[]
  }
  'task.status_changed': {
    readonly taskId: TaskId
    readonly from: TaskStatus
    readonly to: TaskStatus
    readonly reason: string
  }
  'task.claimed': {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly leaseExpiresAt: IsoTimestamp
  }
  'task.dispatched': {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly attempt: number
    readonly expiresAt: IsoTimestamp
  }
  'run.created': {
    readonly runId: RunId
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly attempt: number
  }
  'run.status_changed': {
    readonly runId: RunId
    readonly from: RunStatus
    readonly to: RunStatus
    readonly reason: string
  }
  'tool.requested': {
    readonly toolCallId: ToolCallId
    readonly runId: RunId
    readonly action: ToolAction
  }
  'tool.completed': {
    readonly toolCallId: ToolCallId
    readonly runId: RunId
    readonly sideEffects: readonly TypedSideEffect[]
  }
  'artifact.updated': {
    readonly artifactId: ArtifactId
    readonly updateHash: string
    readonly runId?: RunId
  }
  'artifact.version_created': {
    readonly artifactId: ArtifactId
    readonly versionId: ArtifactVersionId
    readonly contentHash: string
  }
  'review.status_changed': {
    readonly reviewId: ReviewId
    readonly from: ReviewStatus
    readonly to: ReviewStatus
    readonly evidence: readonly EvidenceRef[]
  }
}

export type DomainEventType = keyof DomainEventPayloads

export interface EventEnvelope<Type extends DomainEventType = DomainEventType> {
  readonly schemaVersion: 1
  readonly id: EventId
  readonly type: Type
  readonly occurredAt: IsoTimestamp
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly missionId?: MissionId
  readonly actor: ActorRef
  readonly correlationId: CorrelationId
  readonly causationId?: string
  readonly idempotencyKey?: string
  readonly payload: DomainEventPayloads[Type]
}

export type AnyDomainEvent = {
  readonly [Type in DomainEventType]: EventEnvelope<Type>
}[DomainEventType]

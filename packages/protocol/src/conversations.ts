import type {
  ActorRef,
  AgentId,
  ArtifactId,
  ConversationId,
  ConversationPlanningRequestId,
  IsoTimestamp,
  MessageId,
  MissionId,
  ProjectId,
  RunId,
  TaskId,
  WorkspaceId,
} from './ids.js'
import type { AgentRole } from './plans.js'

export const CONVERSATION_KINDS = ['project_room', 'mission_room', 'group'] as const
export type ConversationKind = typeof CONVERSATION_KINDS[number]
export type ConversationAgentStatus = 'active' | 'paused' | 'disabled'

export interface ConversationEntityRefs {
  readonly missionId?: MissionId
  readonly taskId?: TaskId
  readonly runId?: RunId
  readonly artifactId?: ArtifactId
}

export interface ConversationMember {
  readonly kind: 'user' | 'agent'
  readonly id: string
  readonly name: string
  readonly notifications: boolean
  readonly role?: AgentRole
  readonly status?: ConversationAgentStatus
}

export interface ConversationSnapshot {
  readonly id: ConversationId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly kind: ConversationKind
  readonly title: string
  readonly members: readonly ConversationMember[]
  readonly latestMessageAt?: IsoTimestamp
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export type MessageDeliveryStatus = 'steered' | 'context_pending' | 'context_loaded'

export interface MessageDelivery {
  readonly agentId: AgentId
  readonly status: MessageDeliveryStatus
  readonly runId?: RunId
  readonly deliveredAt?: IsoTimestamp
}

export interface ConversationMessage {
  readonly id: MessageId
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
  readonly sequence: string
  readonly author: ActorRef
  readonly authorName: string
  readonly body: string
  readonly mentions: readonly AgentId[]
  readonly entityRefs: ConversationEntityRefs
  readonly deliveries: readonly MessageDelivery[]
  readonly replyToMessageId?: MessageId
  readonly createdAt: IsoTimestamp
}

export interface PostConversationMessageResult {
  readonly message: ConversationMessage
  readonly reused: boolean
}

export type ConversationPlanningStatus =
  | 'queued'
  | 'running'
  | 'model_complete'
  | 'awaiting_approval'
  | 'approved'
  | 'failed'

export interface ConversationPlanningRequestSnapshot {
  readonly id: ConversationPlanningRequestId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly conversationId: ConversationId
  readonly missionId: MissionId
  readonly plannerAgentId: AgentId
  readonly sourceMessageIds: readonly MessageId[]
  readonly status: ConversationPlanningStatus
  readonly attempt: number
  readonly maxAttempts: number
  readonly planVersion?: number
  readonly error?: string
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface ConversationPlanRequestedInboxPayload {
  readonly schemaVersion: 1
  readonly type: 'conversation.plan_requested'
  readonly requestId: ConversationPlanningRequestId
  readonly conversationId: ConversationId
  readonly missionId: MissionId
}

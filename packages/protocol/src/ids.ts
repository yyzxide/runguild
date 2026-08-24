declare const idBrand: unique symbol

export type Id<Name extends string> = string & {
  readonly [idBrand]: Name
}

export type WorkspaceId = Id<'WorkspaceId'>
export type ProjectId = Id<'ProjectId'>
export type ConversationId = Id<'ConversationId'>
export type MessageId = Id<'MessageId'>
export type ConversationPlanningRequestId = Id<'ConversationPlanningRequestId'>
export type MissionId = Id<'MissionId'>
export type TaskId = Id<'TaskId'>
export type AgentId = Id<'AgentId'>
export type UserId = Id<'UserId'>
export type RunId = Id<'RunId'>
export type ToolCallId = Id<'ToolCallId'>
export type ToolExecutionId = Id<'ToolExecutionId'>
export type LlmCallId = Id<'LlmCallId'>
export type ContextSnapshotId = Id<'ContextSnapshotId'>
export type SkillId = Id<'SkillId'>
export type SkillVersionId = Id<'SkillVersionId'>
export type EvaluationScenarioId = Id<'EvaluationScenarioId'>
export type EvaluationScenarioVersionId = Id<'EvaluationScenarioVersionId'>
export type EvaluationExperimentId = Id<'EvaluationExperimentId'>
export type EvaluationTrialId = Id<'EvaluationTrialId'>
export type RunControlRequestId = Id<'RunControlRequestId'>
export type ArtifactId = Id<'ArtifactId'>
export type ArtifactVersionId = Id<'ArtifactVersionId'>
export type TaskSubmissionId = Id<'TaskSubmissionId'>
export type EvidenceId = Id<'EvidenceId'>
export type ReviewId = Id<'ReviewId'>
export type ApprovalId = Id<'ApprovalId'>
export type EventId = Id<'EventId'>
export type CorrelationId = Id<'CorrelationId'>

export type IsoTimestamp = string & {
  readonly [idBrand]: 'IsoTimestamp'
}

export type ActorRef =
  | { readonly kind: 'user'; readonly id: UserId }
  | { readonly kind: 'agent'; readonly id: AgentId; readonly runId?: RunId }
  | { readonly kind: 'system'; readonly id: string }
  | { readonly kind: 'service'; readonly id: string }

import type {
  ContextSnapshotId,
  RunId,
  SkillId,
  SkillVersionId,
} from './ids.js'
import type { ModelMessage, ModelToolDefinition } from './models.js'

export interface AgentSkillContext {
  readonly skillId: SkillId
  readonly versionId: SkillVersionId
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly contentHash: string
  readonly estimatedTokens: number
  readonly priority: number
}

export type SkillSnapshotRef = Omit<AgentSkillContext, 'instructions' | 'description'>

export type ContextBuildStrategy = 'full' | 'deterministic_window_v1'

export interface ContextSnapshotContent {
  readonly schemaVersion: 1
  readonly strategy: ContextBuildStrategy
  readonly tokenBudget: number
  readonly estimatedTokens: number
  readonly toolDefinitionTokens: number
  readonly toolDefinitions: readonly ModelToolDefinition[]
  readonly sourceMessageCount: number
  readonly includedMessageCount: number
  readonly omittedMessageCount: number
  readonly compacted: boolean
  readonly skills: readonly SkillSnapshotRef[]
  readonly messages: readonly ModelMessage[]
}

export interface ContextSnapshot {
  readonly id: ContextSnapshotId
  readonly runId: RunId
  readonly hop: number
  readonly contentHash: string
  readonly content: ContextSnapshotContent
}

export interface ModelContextMetadata {
  readonly snapshotId: ContextSnapshotId
  readonly contentHash: string
  readonly strategy: ContextBuildStrategy
  readonly tokenBudget: number
  readonly estimatedTokens: number
  readonly compacted: boolean
}

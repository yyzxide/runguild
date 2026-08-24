import { createHash } from 'node:crypto'

import type { ReviewRepository } from '@runguild/database'
import type {
  AgentArtifactOrigin,
  ArtifactId,
  ArtifactOperation,
  ArtifactVersionId,
  EvidenceRef,
  ToolAction,
  TypedSideEffect,
  WorkspaceId,
} from '@runguild/protocol'
import type { ToolHandler, ToolHandlerContext } from '@runguild/tool-gateway'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import * as Y from 'yjs'

import type { ArtifactRepository, ArtifactVersionSnapshot } from './artifact-repository.js'

const MAX_OPERATIONS = 100
const MAX_OPERATION_BYTES = 512 * 1024
const BLOCK_ID_ATTRIBUTE = 'blockId'

export interface ArtifactDocumentSnapshot {
  readonly document: Readonly<Record<string, unknown>>
  readonly comments: Readonly<Record<string, unknown>>
  readonly stateHash: string
  readonly throughUpdateSeq: bigint
}

export interface ApplyArtifactEditInput {
  readonly workspaceId: WorkspaceId
  readonly artifactId: ArtifactId
  readonly origin: AgentArtifactOrigin
  readonly operations: readonly ArtifactOperation[]
}

export interface ApplyArtifactEditResult {
  readonly applied: boolean
  readonly updateHash: string
  readonly throughUpdateSeq: bigint
  readonly changedBlockIds: readonly string[]
}

export interface ArtifactEvidenceDraft {
  readonly kind: 'artifact_version'
  readonly uri: string
  readonly contentHash: string
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface ArtifactEvidenceRecorder {
  record(
    context: ToolHandlerContext,
    draft: ArtifactEvidenceDraft,
  ): Promise<readonly EvidenceRef[]>
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function blockId(origin: AgentArtifactOrigin, operationIndex: number, suffix: string): string {
  return 'block_' + digest(origin.toolCallId + ':' + operationIndex + ':' + suffix).slice(0, 24)
}

function commentId(origin: AgentArtifactOrigin, operationIndex: number): string {
  return 'comment_' + digest(origin.toolCallId + ':' + operationIndex).slice(0, 24)
}

function xmlText(value: string): Y.XmlText {
  const text = new Y.XmlText()
  if (value) text.insert(0, value)
  return text
}

function textBlock(kind: 'heading' | 'paragraph', value: string, id: string): Y.XmlElement {
  const element = new Y.XmlElement(kind)
  element.setAttribute(BLOCK_ID_ATTRIBUTE, id)
  if (kind === 'heading') element.setAttribute('level', 2 as unknown as string)
  if (value) element.insert(0, [xmlText(value)])
  return element
}

function visibleText(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) return node.toString()
  return node.toArray()
    .filter((child): child is Y.XmlElement | Y.XmlText =>
      child instanceof Y.XmlElement || child instanceof Y.XmlText)
    .map(visibleText)
    .join('')
}

function directBlocks(fragment: Y.XmlFragment): Y.XmlElement[] {
  return fragment.toArray().filter((node): node is Y.XmlElement => node instanceof Y.XmlElement)
}

function ensureLegacyBlockIds(fragment: Y.XmlFragment, artifactId: ArtifactId): void {
  directBlocks(fragment).forEach((block, index) => {
    if (block.getAttribute(BLOCK_ID_ATTRIBUTE)) return
    const stable = digest(artifactId + ':' + index + ':' + block.nodeName + ':' + visibleText(block))
    block.setAttribute(BLOCK_ID_ATTRIBUTE, 'block_legacy_' + stable.slice(0, 20))
  })
}

function findBlock(fragment: Y.XmlFragment, id: string): { readonly block: Y.XmlElement; readonly index: number } | null {
  const children = fragment.toArray()
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child instanceof Y.XmlElement && child.getAttribute(BLOCK_ID_ATTRIBUTE) === id) {
      return { block: child, index }
    }
  }
  return null
}

function validateOperations(operations: readonly ArtifactOperation[]): void {
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) {
    throw new RangeError('Artifact edit requires between 1 and 100 operations')
  }
  if (Buffer.byteLength(JSON.stringify(operations)) > MAX_OPERATION_BYTES) {
    throw new RangeError('Artifact operations exceed 512 KiB')
  }
  for (const operation of operations) {
    if (operation.kind === 'insert_section' && !operation.heading.trim()) {
      throw new Error('Inserted section heading cannot be empty')
    }
    if (operation.kind === 'replace_block' && !operation.blockId.trim()) {
      throw new Error('Replacement block id cannot be empty')
    }
    if (operation.kind === 'add_comment'
        && (!operation.blockId.trim() || !operation.body.trim())) {
      throw new Error('Artifact comment requires a block id and body')
    }
  }
}

export class ArtifactEditor {
  constructor(private readonly repository: Pick<ArtifactRepository, 'appendUpdate' | 'syncState'>) {}

  async read(input: {
    readonly workspaceId: WorkspaceId
    readonly artifactId: ArtifactId
  }): Promise<ArtifactDocumentSnapshot> {
    const state = await this.repository.syncState(input)
    const document = new Y.Doc()
    try {
      Y.applyUpdate(document, state.update)
      return {
        document: yDocToProsemirrorJSON(document) as Readonly<Record<string, unknown>>,
        comments: document.getMap('artifact_comments').toJSON() as Readonly<Record<string, unknown>>,
        stateHash: state.stateHash,
        throughUpdateSeq: state.throughUpdateSeq,
      }
    } finally {
      document.destroy()
    }
  }

  async apply(input: ApplyArtifactEditInput): Promise<ApplyArtifactEditResult> {
    validateOperations(input.operations)
    if (!input.origin.intent.trim()) throw new Error('Artifact edit intent cannot be empty')
    const state = await this.repository.syncState({
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    })
    const document = new Y.Doc()
    try {
      Y.applyUpdate(document, state.update)
      const before = Y.encodeStateVector(document)
      const fragment = document.getXmlFragment('prosemirror')
      const comments = document.getMap<Readonly<Record<string, unknown>>>('artifact_comments')
      const changedBlockIds: string[] = []

      document.transact(() => {
        ensureLegacyBlockIds(fragment, input.artifactId)
        input.operations.forEach((operation, operationIndex) => {
          if (operation.kind === 'insert_section') {
            const headingId = blockId(input.origin, operationIndex, 'heading')
            if (findBlock(fragment, headingId)) return
            const contentId = blockId(input.origin, operationIndex, 'content')
            const insertion = operation.afterBlockId
              ? findBlock(fragment, operation.afterBlockId)
              : null
            if (operation.afterBlockId && !insertion) {
              throw new Error('Artifact block not found: ' + operation.afterBlockId)
            }
            const index = insertion ? insertion.index + 1 : fragment.length
            fragment.insert(index, [
              textBlock('heading', operation.heading.trim(), headingId),
              textBlock('paragraph', operation.content, contentId),
            ])
            changedBlockIds.push(headingId, contentId)
            return
          }
          if (operation.kind === 'append_content') {
            const id = blockId(input.origin, operationIndex, 'append')
            if (findBlock(fragment, id)) return
            fragment.push([textBlock('paragraph', operation.content, id)])
            changedBlockIds.push(id)
            return
          }

          const target = findBlock(fragment, operation.blockId)
          if (!target) throw new Error('Artifact block not found: ' + operation.blockId)
          if (operation.kind === 'replace_block') {
            if (visibleText(target.block) === operation.content) return
            if (target.block.length > 0) target.block.delete(0, target.block.length)
            if (operation.content) target.block.insert(0, [xmlText(operation.content)])
            changedBlockIds.push(operation.blockId)
            return
          }

          const id = commentId(input.origin, operationIndex)
          if (comments.has(id)) return
          comments.set(id, {
            blockId: operation.blockId,
            body: operation.body.trim(),
            author: {
              kind: 'agent',
              agentId: input.origin.agentId,
              runId: input.origin.runId,
            },
            intent: input.origin.intent,
          })
          changedBlockIds.push(operation.blockId)
        })
      }, input.origin.toolCallId)

      const update = Y.encodeStateAsUpdate(document, before)
      if (changedBlockIds.length === 0 && update.byteLength <= 2) {
        return {
          applied: false,
          updateHash: state.stateHash,
          throughUpdateSeq: state.throughUpdateSeq,
          changedBlockIds,
        }
      }
      const persisted = await this.repository.appendUpdate({
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        update,
        origin: input.origin,
      })
      return {
        applied: persisted.inserted,
        updateHash: persisted.updateHash,
        throughUpdateSeq: persisted.seq,
        changedBlockIds,
      }
    } finally {
      document.destroy()
    }
  }
}

export interface ArtifactToolHandlersOptions {
  readonly repository: ArtifactRepository
  readonly reviews: Pick<ReviewRepository, 'submitArtifactVersion'>
  readonly evidence: ArtifactEvidenceRecorder
}

export function createArtifactToolHandlers(options: ArtifactToolHandlersOptions): readonly [
  ToolHandler<'artifact.read'>,
  ToolHandler<'artifact.edit'>,
  ToolHandler<'artifact.create_version'>,
  ToolHandler<'artifact.submit_for_review'>,
] {
  const editor = new ArtifactEditor(options.repository)
  const read: ToolHandler<'artifact.read'> = {
    action: 'artifact.read',
    risk: 'read_only',
    retryMode: 'read_only',
    async execute(input, context) {
      const snapshot = await editor.read({
        workspaceId: context.request.workspaceId,
        artifactId: input.artifactId,
      })
      return {
        output: {
          ...snapshot,
          throughUpdateSeq: snapshot.throughUpdateSeq.toString(),
        },
      }
    },
  }
  const edit: ToolHandler<'artifact.edit'> = {
    action: 'artifact.edit',
    risk: 'workspace_write',
    retryMode: 'native_idempotency',
    leaseMs: 60_000,
    async execute(input, context) {
      const request = context.request
      const result = await editor.apply({
        workspaceId: request.workspaceId,
        artifactId: input.artifactId,
        origin: {
          kind: 'agent',
          agentId: request.agentId,
          runId: request.runId,
          taskId: request.taskId,
          toolCallId: request.id,
          intent: input.intent,
        },
        operations: input.operations,
      })
      const sideEffects: TypedSideEffect[] = result.applied
        ? [{ type: 'artifact.updated', artifactId: input.artifactId, updateHash: result.updateHash }]
        : []
      return {
        output: { applied: result.applied, updateHash: result.updateHash },
        sideEffects,
      }
    },
  }
  const createVersion: ToolHandler<'artifact.create_version'> = {
    action: 'artifact.create_version',
    risk: 'workspace_write',
    retryMode: 'native_idempotency',
    leaseMs: 60_000,
    async execute(input, context) {
      const request = context.request
      const version: ArtifactVersionSnapshot = await options.repository.createVersion({
        workspaceId: request.workspaceId,
        artifactId: input.artifactId,
        createdBy: { kind: 'agent', id: request.agentId, runId: request.runId },
      })
      const evidence = await options.evidence.record(context, {
        kind: 'artifact_version',
        uri: 'artifact-version://' + version.id,
        contentHash: version.contentHash,
        metadata: {
          artifactId: version.artifactId,
          version: version.version,
          reason: input.reason,
          yjsStateHash: version.yjsStateHash,
          throughUpdateSeq: version.throughUpdateSeq.toString(),
        },
      })
      if (evidence.length === 0) throw new Error('Artifact Version evidence was not persisted')
      const sideEffects: TypedSideEffect[] = [{
        type: 'artifact.version_created',
        artifactId: input.artifactId,
        versionId: version.id,
      }]
      return {
        output: { versionId: version.id, contentHash: version.contentHash },
        sideEffects,
        evidence,
      }
    },
  }
  const submitForReview: ToolHandler<'artifact.submit_for_review'> = {
    action: 'artifact.submit_for_review',
    risk: 'workspace_write',
    retryMode: 'native_idempotency',
    leaseMs: 60_000,
    async execute(input, context) {
      const request = context.request
      const submission = await options.reviews.submitArtifactVersion({
        workspaceId: request.workspaceId,
        missionId: request.missionId,
        taskId: request.taskId,
        runId: request.runId,
        agentId: request.agentId,
        artifactVersionId: input.artifactVersionId,
        ...(input.note === undefined ? {} : { note: input.note }),
      })
      const sideEffects: TypedSideEffect[] = [{
        type: 'artifact.submitted',
        versionId: input.artifactVersionId,
        submissionId: submission.id,
      }]
      return {
        output: {
          submissionId: submission.id,
          evidenceBundleHash: submission.evidenceBundleHash,
        },
        sideEffects,
      }
    },
  }
  return [read, edit, createVersion, submitForReview]
}

export const ARTIFACT_TOOL_DEFINITIONS = [
  {
    action: 'artifact.read' as const,
    description: 'Read the current collaborative document, comments, stable block ids, and state hash.',
    inputSchema: {
      type: 'object',
      required: ['artifactId'],
      properties: { artifactId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    action: 'artifact.edit' as const,
    description: 'Apply intent-scoped semantic edits to stable Artifact blocks without replacing the whole document.',
    inputSchema: {
      type: 'object',
      required: ['artifactId', 'intent', 'operations'],
      properties: {
        artifactId: { type: 'string' },
        intent: { type: 'string' },
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OPERATIONS,
          items: {
            oneOf: [
              {
                type: 'object',
                required: ['kind', 'heading', 'content'],
                properties: {
                  kind: { const: 'insert_section' },
                  heading: { type: 'string' },
                  content: { type: 'string' },
                  afterBlockId: { type: 'string' },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['kind', 'blockId', 'content'],
                properties: {
                  kind: { const: 'replace_block' },
                  blockId: { type: 'string' },
                  content: { type: 'string' },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['kind', 'content'],
                properties: {
                  kind: { const: 'append_content' },
                  content: { type: 'string' },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['kind', 'blockId', 'body'],
                properties: {
                  kind: { const: 'add_comment' },
                  blockId: { type: 'string' },
                  body: { type: 'string' },
                },
                additionalProperties: false,
              },
            ],
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    action: 'artifact.create_version' as const,
    description: 'Freeze the exact current Yjs state as an immutable Artifact Version and durable evidence.',
    inputSchema: {
      type: 'object',
      required: ['artifactId', 'reason'],
      properties: {
        artifactId: { type: 'string' },
        reason: { enum: ['review', 'delivery', 'manual'] },
      },
      additionalProperties: false,
    },
  },
  {
    action: 'artifact.submit_for_review' as const,
    description: 'Submit an exact Agent-created Artifact Version and its durable evidence bundle for independent review.',
    inputSchema: {
      type: 'object',
      required: ['artifactVersionId'],
      properties: {
        artifactVersionId: { type: 'string' },
        note: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
] as const satisfies readonly {
  readonly action: ToolAction
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}[]

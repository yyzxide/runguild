import { createHash, randomUUID } from 'node:crypto'

import { canonicalJson, withTransaction } from '@runguild/database'
import type {
  ActorRef,
  AgentId,
  ArtifactId,
  ArtifactUpdateOrigin,
  ArtifactVersion,
  ArtifactVersionId,
  IsoTimestamp,
  MissionId,
  ProjectId,
  RunId,
  UserId,
  WorkspaceId,
} from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import * as Y from 'yjs'

const MAX_UPDATE_BYTES = 1024 * 1024
const MAX_STATE_BYTES = 32 * 1024 * 1024
const MAX_ORIGIN_BYTES = 32 * 1024

export interface ArtifactRecord {
  readonly id: ArtifactId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly missionId?: MissionId
  readonly title: string
  readonly kind: string
  readonly createdBy: string
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

export interface CreateArtifactInput {
  readonly artifactId?: ArtifactId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly missionId?: MissionId
  readonly title: string
  readonly kind?: string
  readonly createdBy: string
}

export interface AppendArtifactUpdateInput {
  readonly workspaceId: WorkspaceId
  readonly artifactId: ArtifactId
  readonly update: Uint8Array
  readonly origin: ArtifactUpdateOrigin
}

export interface ArtifactSyncState {
  readonly update: Uint8Array
  readonly stateVector: Uint8Array
  readonly stateHash: string
  readonly throughUpdateSeq: bigint
}

export interface ArtifactCompactionResult {
  readonly compacted: boolean
  readonly stateHash: string
  readonly stateBytes: number
  readonly throughUpdateSeq: bigint
  readonly updatesApplied: number
}

export interface CreateArtifactVersionInput {
  readonly versionId?: ArtifactVersionId
  readonly workspaceId: WorkspaceId
  readonly artifactId: ArtifactId
  readonly createdBy: ActorRef
  readonly xmlFragment?: string
}

export interface ArtifactVersionSnapshot extends ArtifactVersion {
  readonly content: Readonly<Record<string, unknown>>
  readonly yjsState: Uint8Array
}

export class ArtifactNotFoundError extends Error {
  constructor(artifactId: ArtifactId) {
    super('Artifact not found in workspace: ' + artifactId)
    this.name = 'ArtifactNotFoundError'
  }
}

interface ArtifactRow {
  readonly id: string
  readonly workspace_id: string
  readonly project_id: string
  readonly mission_id: string | null
  readonly title: string
  readonly kind: string
  readonly created_by: string
  readonly created_at: Date
  readonly updated_at: Date
}

interface SnapshotRow {
  readonly state_bytes: Uint8Array
  readonly state_hash: string
  readonly through_update_seq: string | bigint
}

interface UpdateRow {
  readonly seq: string | bigint
  readonly update_bytes: Uint8Array
}

interface VersionRow {
  readonly id: string
  readonly artifact_id: string
  readonly version: number
  readonly content: Readonly<Record<string, unknown>>
  readonly yjs_state_bytes: Uint8Array
  readonly content_hash: string
  readonly yjs_state_hash: string
  readonly through_update_seq: string | bigint
  readonly created_by_kind: ActorRef['kind']
  readonly created_by_id: string
  readonly created_by_run_id: string | null
  readonly created_at: Date
}

interface ReconstructedDocument {
  readonly document: Y.Doc
  readonly throughUpdateSeq: bigint
  readonly updatesApplied: number
  readonly hadSnapshot: boolean
}

interface ArtifactScopeRow {
  readonly mission_id: string | null
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function assertBinarySize(value: Uint8Array, label: string, maximum: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw new RangeError(label + ' must contain between 1 and ' + maximum + ' bytes')
  }
}

function asArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id as ArtifactId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as ProjectId,
    ...(row.mission_id === null ? {} : { missionId: row.mission_id as MissionId }),
    title: row.title,
    kind: row.kind,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    updatedAt: row.updated_at.toISOString() as IsoTimestamp,
  }
}

function actorFromVersion(row: VersionRow): ActorRef {
  switch (row.created_by_kind) {
    case 'user': return { kind: 'user', id: row.created_by_id as UserId }
    case 'agent': return {
      kind: 'agent',
      id: row.created_by_id as AgentId,
      ...(row.created_by_run_id === null ? {} : { runId: row.created_by_run_id as RunId }),
    }
    case 'service': return { kind: 'service', id: row.created_by_id }
    case 'system': return { kind: 'system', id: row.created_by_id }
  }
}

function asVersion(row: VersionRow): ArtifactVersionSnapshot {
  return {
    id: row.id as ArtifactVersionId,
    artifactId: row.artifact_id as ArtifactId,
    version: row.version,
    content: row.content,
    yjsState: bytes(row.yjs_state_bytes),
    contentHash: row.content_hash,
    yjsStateHash: row.yjs_state_hash,
    throughUpdateSeq: BigInt(row.through_update_seq),
    createdBy: actorFromVersion(row),
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    ...(row.created_by_run_id === null ? {} : { createdByRunId: row.created_by_run_id as RunId }),
  }
}

const VERSION_COLUMNS =
  'id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash, ' +
  'through_update_seq, created_by_kind, created_by_id, created_by_run_id, created_at'

export class ArtifactRepository {
  constructor(private readonly pool: Pool) {}

  async authorizeActor(input: {
    readonly workspaceId: WorkspaceId
    readonly actor: Extract<ActorRef, { readonly kind: 'user' | 'agent' }>
  }): Promise<void> {
    const table = input.actor.kind === 'user' ? 'users' : 'agents'
    const result = await this.pool.query(
      'SELECT 1 FROM ' + table + ' WHERE id = $1 AND workspace_id = $2',
      [input.actor.id, input.workspaceId],
    )
    if (!result.rows[0]) throw new Error('Artifact actor is outside the workspace')
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    if (!input.title.trim() || !input.createdBy.trim()) {
      throw new Error('Artifact title and creator are required')
    }
    const artifactId = input.artifactId ?? ('artifact_' + randomUUID()) as ArtifactId
    const kind = input.kind?.trim() || 'document'
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<ArtifactRow>(
        'INSERT INTO artifacts ' +
        '(id, workspace_id, project_id, mission_id, title, kind, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING ' +
        'RETURNING id, workspace_id, project_id, mission_id, title, kind, created_by, created_at, updated_at',
        [
          artifactId,
          input.workspaceId,
          input.projectId,
          input.missionId ?? null,
          input.title.trim(),
          kind,
          input.createdBy,
        ],
      )
      if (inserted.rows[0]) return asArtifact(inserted.rows[0])
      const existing = await client.query<ArtifactRow>(
        'SELECT id, workspace_id, project_id, mission_id, title, kind, created_by, created_at, updated_at ' +
        'FROM artifacts WHERE id = $1',
        [artifactId],
      )
      const row = existing.rows[0]
      if (!row
          || row.workspace_id !== input.workspaceId
          || row.project_id !== input.projectId
          || row.mission_id !== (input.missionId ?? null)
          || row.title !== input.title.trim()
          || row.kind !== kind
          || row.created_by !== input.createdBy) {
        throw new Error('Artifact id was reused with different semantics')
      }
      return asArtifact(row)
    })
  }

  async appendUpdate(input: AppendArtifactUpdateInput): Promise<{
    readonly seq: bigint
    readonly updateHash: string
    readonly inserted: boolean
  }> {
    assertBinarySize(input.update, 'Yjs update', MAX_UPDATE_BYTES)
    const update = bytes(input.update)
    const updateHash = digest(update)
    const origin = canonicalJson(input.origin)
    if (Buffer.byteLength(origin) > MAX_ORIGIN_BYTES) {
      throw new RangeError('Artifact update origin exceeds 32 KiB')
    }
    try {
      const validation = new Y.Doc()
      Y.applyUpdate(validation, update)
      validation.destroy()
    } catch (error) {
      throw new Error('Artifact update is not valid Yjs v1 data', { cause: error })
    }

    return withTransaction(this.pool, async (client) => {
      const artifact = await this.requireArtifact(client, input.workspaceId, input.artifactId, true)
      await this.validateOrigin(client, input.workspaceId, artifact.mission_id, input.origin)
      const inserted = await client.query<{ seq: string }>(
        'INSERT INTO artifact_yjs_updates (artifact_id, update_hash, update_bytes, origin) ' +
        'VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (artifact_id, update_hash) DO NOTHING ' +
        'RETURNING seq::text',
        [input.artifactId, updateHash, Buffer.from(update), origin],
      )
      const newRow = inserted.rows[0]
      if (newRow) {
        await client.query('UPDATE artifacts SET updated_at = NOW() WHERE id = $1', [input.artifactId])
        return { seq: BigInt(newRow.seq), updateHash, inserted: true }
      }
      const existing = await client.query<{ seq: string; update_bytes: Uint8Array }>(
        'SELECT seq::text, update_bytes FROM artifact_yjs_updates ' +
        'WHERE artifact_id = $1 AND update_hash = $2',
        [input.artifactId, updateHash],
      )
      const row = existing.rows[0]
      if (!row || !Buffer.from(row.update_bytes).equals(Buffer.from(update))) {
        throw new Error('Artifact update hash conflict')
      }
      return { seq: BigInt(row.seq), updateHash, inserted: false }
    })
  }

  async syncState(input: {
    readonly workspaceId: WorkspaceId
    readonly artifactId: ArtifactId
    readonly remoteStateVector?: Uint8Array
  }): Promise<ArtifactSyncState> {
    if (input.remoteStateVector) {
      assertBinarySize(input.remoteStateVector, 'Yjs state vector', 64 * 1024)
    }
    await this.requireArtifact(this.pool, input.workspaceId, input.artifactId, false)
    const rebuilt = await this.reconstruct(this.pool, input.artifactId)
    try {
      const fullState = Y.encodeStateAsUpdate(rebuilt.document)
      assertBinarySize(fullState, 'Yjs document state', MAX_STATE_BYTES)
      const update = input.remoteStateVector
        ? Y.encodeStateAsUpdate(rebuilt.document, input.remoteStateVector)
        : fullState
      return {
        update,
        stateVector: Y.encodeStateVector(rebuilt.document),
        stateHash: digest(fullState),
        throughUpdateSeq: rebuilt.throughUpdateSeq,
      }
    } finally {
      rebuilt.document.destroy()
    }
  }

  async compact(input: {
    readonly workspaceId: WorkspaceId
    readonly artifactId: ArtifactId
  }): Promise<ArtifactCompactionResult> {
    return withTransaction(this.pool, async (client) => {
      await this.requireArtifact(client, input.workspaceId, input.artifactId, true)
      const rebuilt = await this.reconstruct(client, input.artifactId)
      try {
        const state = Y.encodeStateAsUpdate(rebuilt.document)
        assertBinarySize(state, 'Yjs document state', MAX_STATE_BYTES)
        const stateHash = digest(state)
        if (!rebuilt.hadSnapshot || rebuilt.updatesApplied > 0) {
          await this.upsertSnapshot(client, input.artifactId, state, stateHash, rebuilt.throughUpdateSeq)
        }
        return {
          compacted: !rebuilt.hadSnapshot || rebuilt.updatesApplied > 0,
          stateHash,
          stateBytes: state.byteLength,
          throughUpdateSeq: rebuilt.throughUpdateSeq,
          updatesApplied: rebuilt.updatesApplied,
        }
      } finally {
        rebuilt.document.destroy()
      }
    })
  }

  async createVersion(input: CreateArtifactVersionInput): Promise<ArtifactVersionSnapshot> {
    const fragment = input.xmlFragment?.trim() || 'prosemirror'
    return withTransaction(this.pool, async (client) => {
      const artifact = await this.requireArtifact(client, input.workspaceId, input.artifactId, true)
      await this.validateVersionActor(client, input.workspaceId, artifact.mission_id, input.createdBy)
      const rebuilt = await this.reconstruct(client, input.artifactId)
      try {
        const state = Y.encodeStateAsUpdate(rebuilt.document)
        assertBinarySize(state, 'Yjs document state', MAX_STATE_BYTES)
        const content = yDocToProsemirrorJSON(rebuilt.document, fragment) as Readonly<Record<string, unknown>>
        const contentJson = canonicalJson(content)
        const contentHash = digest(contentJson)
        const stateHash = digest(state)
        const existing = await client.query<VersionRow>(
          'SELECT ' + VERSION_COLUMNS + ' FROM artifact_versions ' +
          'WHERE artifact_id = $1 AND content_hash = $2 AND yjs_state_hash = $3',
          [input.artifactId, contentHash, stateHash],
        )
        if (existing.rows[0]) return asVersion(existing.rows[0])

        const next = await client.query<{ version: number }>(
          'SELECT COALESCE(MAX(version), 0)::int + 1 AS version ' +
          'FROM artifact_versions WHERE artifact_id = $1',
          [input.artifactId],
        )
        const version = next.rows[0]?.version
        if (!version) throw new Error('Artifact version number could not be allocated')
        const versionId = input.versionId ?? ('artifact_version_' + randomUUID()) as ArtifactVersionId
        const createdByRunId = input.createdBy.kind === 'agent' ? input.createdBy.runId ?? null : null
        const inserted = await client.query<VersionRow>(
          'INSERT INTO artifact_versions ' +
          '(id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash, ' +
          'through_update_seq, created_by_kind, created_by_id, created_by_run_id) ' +
          'VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) ' +
          'RETURNING ' + VERSION_COLUMNS,
          [
            versionId,
            input.artifactId,
            version,
            contentJson,
            Buffer.from(state),
            contentHash,
            stateHash,
            rebuilt.throughUpdateSeq.toString(),
            input.createdBy.kind,
            input.createdBy.id,
            createdByRunId,
          ],
        )
        const row = inserted.rows[0]
        if (!row) throw new Error('Artifact version was not persisted')
        await this.upsertSnapshot(client, input.artifactId, state, stateHash, rebuilt.throughUpdateSeq)
        return asVersion(row)
      } finally {
        rebuilt.document.destroy()
      }
    })
  }

  async readVersion(input: {
    readonly workspaceId: WorkspaceId
    readonly versionId: ArtifactVersionId
  }): Promise<ArtifactVersionSnapshot | null> {
    const result = await this.pool.query<VersionRow>(
      'SELECT ' + VERSION_COLUMNS + ' FROM artifact_versions v WHERE v.id = $1 ' +
      'AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id = v.artifact_id AND a.workspace_id = $2)',
      [input.versionId, input.workspaceId],
    )
    return result.rows[0] ? asVersion(result.rows[0]) : null
  }

  private async requireArtifact(
    client: Pick<Pool, 'query'> | PoolClient,
    workspaceId: WorkspaceId,
    artifactId: ArtifactId,
    lock: boolean,
  ): Promise<ArtifactScopeRow> {
    const result = await client.query<ArtifactScopeRow>(
      'SELECT mission_id FROM artifacts WHERE id = $1 AND workspace_id = $2' + (lock ? ' FOR UPDATE' : ''),
      [artifactId, workspaceId],
    )
    const row = result.rows[0]
    if (!row) throw new ArtifactNotFoundError(artifactId)
    return row
  }

  private async validateOrigin(
    client: PoolClient,
    workspaceId: WorkspaceId,
    artifactMissionId: string | null,
    origin: ArtifactUpdateOrigin,
  ): Promise<void> {
    if (origin.kind === 'user') {
      if (!origin.sessionId.trim()) throw new Error('User Artifact origin requires a session id')
      const user = await client.query(
        'SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2',
        [origin.userId, workspaceId],
      )
      if (!user.rows[0]) throw new Error('Artifact update user is outside the workspace')
      return
    }
    if (origin.kind === 'agent') {
      if (!origin.intent.trim()) throw new Error('Agent Artifact origin requires an intent')
      const run = await client.query<{ mission_id: string }>(
        'SELECT mission_id FROM agent_runs WHERE id = $1 AND workspace_id = $2 ' +
        'AND task_id = $3 AND agent_id = $4',
        [origin.runId, workspaceId, origin.taskId, origin.agentId],
      )
      if (!run.rows[0] || artifactMissionId === null || run.rows[0].mission_id !== artifactMissionId) {
        throw new Error('Agent Artifact origin is outside the Artifact mission scope')
      }
      return
    }
    if (!origin.serviceId.trim() || !origin.operation.trim()) {
      throw new Error('Service Artifact origin requires serviceId and operation')
    }
  }

  private async validateVersionActor(
    client: PoolClient,
    workspaceId: WorkspaceId,
    artifactMissionId: string | null,
    actor: ActorRef,
  ): Promise<void> {
    if (actor.kind === 'user') {
      const user = await client.query(
        'SELECT 1 FROM users WHERE id = $1 AND workspace_id = $2',
        [actor.id, workspaceId],
      )
      if (!user.rows[0]) throw new Error('Artifact Version creator is outside the workspace')
    } else if (actor.kind === 'agent') {
      if (!actor.runId) throw new Error('Agent-created Artifact Version requires a Run')
      const run = await client.query<{ mission_id: string }>(
        'SELECT mission_id FROM agent_runs WHERE id = $1 AND workspace_id = $2 AND agent_id = $3',
        [actor.runId, workspaceId, actor.id],
      )
      if (!run.rows[0] || artifactMissionId === null || run.rows[0].mission_id !== artifactMissionId) {
        throw new Error('Artifact Version creator Run is outside Artifact scope')
      }
    }
  }

  private async reconstruct(
    client: Pick<Pool, 'query'> | PoolClient,
    artifactId: ArtifactId,
  ): Promise<ReconstructedDocument> {
    const snapshot = await client.query<SnapshotRow>(
      'SELECT state_bytes, state_hash, through_update_seq FROM artifact_yjs_snapshots WHERE artifact_id = $1',
      [artifactId],
    )
    const stored = snapshot.rows[0]
    const throughSnapshot = stored ? BigInt(stored.through_update_seq) : 0n
    const document = new Y.Doc()
    let totalBytes = 0
    if (stored) {
      const state = bytes(stored.state_bytes)
      totalBytes += state.byteLength
      if (digest(state) !== stored.state_hash) {
        document.destroy()
        throw new Error('Artifact snapshot hash does not match its bytes')
      }
      Y.applyUpdate(document, state)
    }
    const updates = await client.query<UpdateRow>(
      'SELECT seq::text, update_bytes FROM artifact_yjs_updates ' +
      'WHERE artifact_id = $1 AND seq > $2 ORDER BY seq',
      [artifactId, throughSnapshot.toString()],
    )
    let throughUpdateSeq = throughSnapshot
    try {
      for (const row of updates.rows) {
        const update = bytes(row.update_bytes)
        totalBytes += update.byteLength
        if (totalBytes > MAX_STATE_BYTES * 2) {
          throw new RangeError('Artifact reconstruction exceeds the 64 MiB safety limit')
        }
        Y.applyUpdate(document, update)
        throughUpdateSeq = BigInt(row.seq)
      }
      return {
        document,
        throughUpdateSeq,
        updatesApplied: updates.rows.length,
        hadSnapshot: stored !== undefined,
      }
    } catch (error) {
      document.destroy()
      throw error
    }
  }

  private async upsertSnapshot(
    client: PoolClient,
    artifactId: ArtifactId,
    state: Uint8Array,
    stateHash: string,
    throughUpdateSeq: bigint,
  ): Promise<void> {
    await client.query(
      'INSERT INTO artifact_yjs_snapshots ' +
      '(artifact_id, state_bytes, state_hash, through_update_seq) VALUES ($1, $2, $3, $4) ' +
      'ON CONFLICT (artifact_id) DO UPDATE SET state_bytes = EXCLUDED.state_bytes, ' +
      'state_hash = EXCLUDED.state_hash, through_update_seq = EXCLUDED.through_update_seq, updated_at = NOW()',
      [artifactId, Buffer.from(state), stateHash, throughUpdateSeq.toString()],
    )
  }
}

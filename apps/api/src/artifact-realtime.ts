import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'

import type { ArtifactRepository, PersistedArtifactUpdate } from '@runguild/collaboration'
import type {
  ActorRef,
  AgentId,
  ArtifactId,
  ArtifactAwarenessClient,
  ArtifactAwarenessIdentity,
  ArtifactAwarenessNotification,
  ArtifactAwarenessState,
  ArtifactUpdateCommittedNotification,
  ArtifactUpdateOrigin,
  RunId,
  TaskId,
  ToolCallId,
  UserId,
  WorkspaceId,
} from '@runguild/protocol'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'

const MAX_PENDING_MESSAGES = 64
const MAX_DELIVERED_UPDATES = 8_192
const MAX_REMOTE_AWARENESS = 8_192
const MAX_AWARENESS_BYTES = 16 * 1024
const HEARTBEAT_INTERVAL_MS = 30_000
const AWARENESS_TTL_MULTIPLIER = 3

type ArtifactRealtimeRepository = Pick<
  ArtifactRepository,
  'appendUpdate' | 'authorizeActor' | 'readPersistedUpdate' | 'syncState'
>

export interface ArtifactRealtimeFanout {
  subscribe(listener: (notification: unknown) => void): () => void
  subscribeAwareness(listener: (notification: unknown) => void): () => void
  publishAwareness(notification: ArtifactAwarenessNotification): Promise<void>
  onRecovered(listener: () => void): () => void
}

export type ArtifactRealtimePrincipal =
  | {
      readonly kind: 'user'
      readonly userId: UserId
      readonly sessionId: string
    }
  | {
      readonly kind: 'agent'
      readonly agentId: AgentId
      readonly runId: RunId
      readonly taskId: TaskId
      readonly toolCallId: ToolCallId
      readonly intent: string
    }

export interface ArtifactRealtimeAuthenticationInput {
  readonly request: IncomingMessage
  readonly workspaceId: WorkspaceId
  readonly artifactId: ArtifactId
}

export interface ArtifactRealtimeServerOptions {
  readonly repository: ArtifactRealtimeRepository
  readonly authenticate?: (
    input: ArtifactRealtimeAuthenticationInput,
  ) => Promise<ArtifactRealtimePrincipal | null> | ArtifactRealtimePrincipal | null
  readonly heartbeatIntervalMs?: number
  readonly awarenessTtlMs?: number
  readonly instanceId?: string
  readonly fanout?: ArtifactRealtimeFanout
  readonly onFanoutError?: (error: Error) => void
}

interface ArtifactLocation {
  readonly workspaceId: WorkspaceId
  readonly artifactId: ArtifactId
}

interface ConnectedClient {
  readonly id: string
  readonly socket: WebSocket
  readonly location: ArtifactLocation
  readonly principal: ArtifactRealtimePrincipal
  pendingMessages: number
  queue: Promise<void>
  alive: boolean
  syncedThroughUpdateSeq: bigint
  awarenessVersion: number
  awareness?: ArtifactAwarenessState
}

interface RemoteAwareness {
  readonly sourceInstanceId: string
  readonly location: ArtifactLocation
  readonly client: ArtifactAwarenessClient
  readonly version: number
  expiresAt: number
}

interface RemovedRemoteAwareness {
  readonly version: number
  readonly expiresAt: number
}

const base64UrlSchema = z.string().min(1).max(1_400_000).regex(/^[A-Za-z0-9_-]+$/)
const awarenessSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: z.string().min(1).max(100).optional(),
  activeBlockId: z.string().min(1).max(200).optional(),
  cursor: z.object({
    anchor: z.number().int().min(0).max(100_000_000),
    head: z.number().int().min(0).max(100_000_000),
  }).optional(),
}).strict()

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sync'),
    stateVector: base64UrlSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('update'),
    update: base64UrlSchema,
    clientUpdateId: z.string().min(1).max(200).optional(),
  }).strict(),
  z.object({
    type: z.literal('awareness'),
    state: awarenessSchema,
  }).strict(),
])

const committedNotificationSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal('artifact.update_committed'),
  workspaceId: z.string().min(1).max(200),
  artifactId: z.string().min(1).max(200),
  seq: z.string().regex(/^[1-9][0-9]*$/),
  updateHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

const fanoutIdentitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    actorId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal('agent'),
    actorId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
  }).strict(),
])

const fanoutAwarenessBaseSchema = z.object({
  schemaVersion: z.literal(1),
  sourceInstanceId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  artifactId: z.string().min(1).max(200),
})

const awarenessNotificationSchema = z.discriminatedUnion('type', [
  fanoutAwarenessBaseSchema.extend({
    type: z.literal('artifact.awareness_updated'),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    client: z.object({
      clientId: z.string().min(1).max(200),
      identity: fanoutIdentitySchema,
      state: awarenessSchema,
    }).strict(),
  }).strict(),
  fanoutAwarenessBaseSchema.extend({
    type: z.literal('artifact.awareness_removed'),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    clientId: z.string().min(1).max(200),
  }).strict(),
  fanoutAwarenessBaseSchema.extend({
    type: z.literal('artifact.awareness_probe'),
  }).strict(),
])

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0]?.trim() : value?.trim()
}

export function headerArtifactRealtimeAuthenticator(
  input: ArtifactRealtimeAuthenticationInput,
): ArtifactRealtimePrincipal | null {
  const actorId = header(input.request, 'x-actor-id')
  if (!actorId) return null
  const kind = header(input.request, 'x-actor-kind') || 'user'
  if (kind === 'user') {
    const sessionId = header(input.request, 'x-session-id')
    return sessionId
      ? { kind: 'user', userId: actorId as UserId, sessionId }
      : null
  }
  if (kind !== 'agent') return null
  const runId = header(input.request, 'x-run-id')
  const taskId = header(input.request, 'x-task-id')
  const toolCallId = header(input.request, 'x-tool-call-id')
  const intent = header(input.request, 'x-edit-intent')
  return runId && taskId && toolCallId && intent
    ? {
        kind: 'agent',
        agentId: actorId as AgentId,
        runId: runId as RunId,
        taskId: taskId as TaskId,
        toolCallId: toolCallId as ToolCallId,
        intent,
      }
    : null
}

function artifactLocation(request: IncomingMessage): ArtifactLocation | null {
  if (!request.url) return null
  const pathname = new URL(request.url, 'http://localhost').pathname
  const match = /^\/api\/v1\/workspaces\/([^/]+)\/artifacts\/([^/]+)\/collaboration$/.exec(pathname)
  if (!match?.[1] || !match[2]) return null
  const workspaceId = decodeURIComponent(match[1])
  const artifactId = decodeURIComponent(match[2])
  if (!workspaceId || !artifactId || workspaceId.length > 200 || artifactId.length > 200) return null
  return {
    workspaceId: workspaceId as WorkspaceId,
    artifactId: artifactId as ArtifactId,
  }
}

function origin(principal: ArtifactRealtimePrincipal): ArtifactUpdateOrigin {
  return principal.kind === 'user'
    ? {
        kind: 'user',
        userId: principal.userId,
        sessionId: principal.sessionId,
      }
    : {
        kind: 'agent',
        agentId: principal.agentId,
        runId: principal.runId,
        taskId: principal.taskId,
        toolCallId: principal.toolCallId,
        intent: principal.intent,
      }
}

function publicIdentity(principal: ArtifactRealtimePrincipal): ArtifactAwarenessIdentity {
  return principal.kind === 'user'
    ? { kind: 'user', actorId: principal.userId, sessionId: principal.sessionId }
    : { kind: 'agent', actorId: principal.agentId, runId: principal.runId }
}

function publicOrigin(origin: ArtifactUpdateOrigin): Readonly<Record<string, string>> {
  if (origin.kind === 'user') {
    return { kind: 'user', actorId: origin.userId, sessionId: origin.sessionId }
  }
  if (origin.kind === 'agent') {
    return { kind: 'agent', actorId: origin.agentId, runId: origin.runId }
  }
  return { kind: 'service', actorId: origin.serviceId, operation: origin.operation }
}

function originMatchesClient(origin: ArtifactUpdateOrigin, client: ConnectedClient): boolean {
  if (origin.kind === 'user' && client.principal.kind === 'user') {
    return origin.userId === client.principal.userId && origin.sessionId === client.principal.sessionId
  }
  if (origin.kind === 'agent' && client.principal.kind === 'agent') {
    return origin.agentId === client.principal.agentId && origin.runId === client.principal.runId
  }
  return false
}

function actor(principal: ArtifactRealtimePrincipal): Extract<
  ActorRef,
  { readonly kind: 'user' | 'agent' }
> {
  return principal.kind === 'user'
    ? { kind: 'user', id: principal.userId }
    : { kind: 'agent', id: principal.agentId, runId: principal.runId }
}

function roomKey(location: ArtifactLocation): string {
  return location.workspaceId + '\u0000' + location.artifactId
}

function deliveryKey(
  location: ArtifactLocation,
  update: Pick<PersistedArtifactUpdate, 'seq' | 'updateHash'>,
): string {
  return roomKey(location) + '\u0000' + update.seq.toString() + '\u0000' + update.updateHash
}

function remoteAwarenessKey(
  location: ArtifactLocation,
  sourceInstanceId: string,
  clientId: string,
): string {
  return roomKey(location) + '\u0000' + sourceInstanceId + '\u0000' + clientId
}

function sameAwarenessClient(left: ArtifactAwarenessClient, right: ArtifactAwarenessClient): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

function rejectUpgrade(request: IncomingMessage, status: number, message: string): void {
  const socket = request.socket
  if (socket.destroyed) return
  socket.write(
    'HTTP/1.1 ' + status + ' ' + message + '\r\n' +
    'Connection: close\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify({ error: { code: status === 401 ? 'unauthorized' : 'collaboration_unavailable' } }),
  )
  socket.destroy()
}

export class ArtifactRealtimeServer {
  private readonly websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1_500_000,
    perMessageDeflate: false,
  })
  private readonly rooms = new Map<string, Set<ConnectedClient>>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly authenticate: NonNullable<ArtifactRealtimeServerOptions['authenticate']>
  private readonly handleUpgradeBound: (request: IncomingMessage) => void
  private readonly instanceId: string
  private readonly awarenessTtlMs: number
  private readonly deliveredUpdates = new Map<string, true>()
  private readonly fanoutQueues = new Map<string, Promise<void>>()
  private readonly remoteAwareness = new Map<string, RemoteAwareness>()
  private readonly removedRemoteAwareness = new Map<string, RemovedRemoteAwareness>()
  private readonly pendingAwarenessPublications = new Set<Promise<void>>()
  private readonly unsubscribeFanout: (() => void) | undefined
  private readonly unsubscribeAwareness: (() => void) | undefined
  private readonly unsubscribeRecovery: (() => void) | undefined
  private recovery = Promise.resolve()

  constructor(
    private readonly server: HttpServer,
    private readonly options: ArtifactRealtimeServerOptions,
  ) {
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
      throw new RangeError('Artifact realtime heartbeat interval must be a positive integer')
    }
    this.awarenessTtlMs = options.awarenessTtlMs ?? heartbeatIntervalMs * AWARENESS_TTL_MULTIPLIER
    if (!Number.isInteger(this.awarenessTtlMs) || this.awarenessTtlMs < heartbeatIntervalMs * 2) {
      throw new RangeError('Artifact Awareness TTL must be at least two heartbeat intervals')
    }
    this.instanceId = options.instanceId ?? 'api_' + randomUUID()
    if (!this.instanceId || this.instanceId.length > 200) {
      throw new RangeError('Artifact realtime instance id must contain 1 to 200 characters')
    }
    this.authenticate = options.authenticate ?? headerArtifactRealtimeAuthenticator
    this.handleUpgradeBound = (request) => void this.handleUpgrade(request)
    this.server.on('upgrade', this.handleUpgradeBound)
    this.heartbeat = setInterval(
      () => this.checkConnections(),
      heartbeatIntervalMs,
    )
    this.heartbeat.unref()
    this.unsubscribeFanout = options.fanout?.subscribe((notification) => {
      this.enqueueFanout(notification)
    })
    this.unsubscribeAwareness = options.fanout?.subscribeAwareness((notification) => {
      this.receiveAwarenessNotification(notification)
    })
    this.unsubscribeRecovery = options.fanout?.onRecovered(() => {
      this.recovery = this.recovery
        .then(() => this.recoverFanout())
        .catch((error: unknown) => this.reportFanoutError(error))
    })
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat)
    this.unsubscribeFanout?.()
    this.unsubscribeAwareness?.()
    this.unsubscribeRecovery?.()
    this.server.off('upgrade', this.handleUpgradeBound)
    for (const clients of this.rooms.values()) {
      for (const client of clients) client.socket.close(1001, 'Server shutting down')
    }
    await new Promise<void>((resolve) => this.websocketServer.close(() => resolve()))
    await Promise.allSettled([
      ...this.fanoutQueues.values(),
      ...this.pendingAwarenessPublications,
      this.recovery,
    ])
  }

  private async handleUpgrade(request: IncomingMessage): Promise<void> {
    const location = artifactLocation(request)
    if (!location) return
    let principal: ArtifactRealtimePrincipal | null
    try {
      principal = await this.authenticate({ request, ...location })
      if (!principal) {
        rejectUpgrade(request, 401, 'Unauthorized')
        return
      }
      await this.options.repository.authorizeActor({
        workspaceId: location.workspaceId,
        actor: actor(principal),
      })
      await this.options.repository.syncState(location)
    } catch {
      rejectUpgrade(request, 404, 'Not Found')
      return
    }
    this.websocketServer.handleUpgrade(request, request.socket, Buffer.alloc(0), (socket) => {
      this.connect(socket, location, principal as ArtifactRealtimePrincipal)
    })
  }

  private connect(
    socket: WebSocket,
    location: ArtifactLocation,
    principal: ArtifactRealtimePrincipal,
  ): void {
    const client: ConnectedClient = {
      id: 'presence_' + randomUUID(),
      socket,
      location,
      principal,
      pendingMessages: 0,
      queue: Promise.resolve(),
      alive: true,
      syncedThroughUpdateSeq: 0n,
      awarenessVersion: 0,
    }
    const key = roomKey(location)
    const clients = this.rooms.get(key) ?? new Set<ConnectedClient>()
    const firstLocalClient = clients.size === 0
    clients.add(client)
    this.rooms.set(key, clients)
    socket.on('pong', () => { client.alive = true })
    socket.on('message', (data, isBinary) => {
      if (isBinary || client.pendingMessages >= MAX_PENDING_MESSAGES) {
        socket.close(1008, isBinary ? 'JSON messages required' : 'Too many pending messages')
        return
      }
      client.pendingMessages += 1
      client.queue = client.queue
        .then(() => this.handleMessage(client, data.toString()))
        .catch((error: unknown) => {
          send(socket, {
            type: 'error',
            code: 'message_rejected',
            message: error instanceof Error ? error.message : 'Message rejected',
          })
        })
        .finally(() => { client.pendingMessages -= 1 })
    })
    socket.once('close', () => this.disconnect(client))
    socket.once('error', () => this.disconnect(client))
    void this.sendSync(client).catch(() => socket.close(1011, 'Initial synchronization failed'))
    this.expireRemoteAwareness()
    send(socket, {
      type: 'awareness.snapshot',
      clients: [
        ...[...clients]
          .filter((peer) => peer !== client && peer.awareness)
          .map((peer) => this.awarenessPayload(peer)),
        ...[...this.remoteAwareness.values()]
          .filter((presence) => roomKey(presence.location) === key)
          .map((presence) => presence.client),
      ],
    })
    if (firstLocalClient) this.publishAwarenessProbe(location)
  }

  private async handleMessage(client: ConnectedClient, raw: string): Promise<void> {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error('Message must be valid JSON')
    }
    const parsed = clientMessageSchema.safeParse(json)
    if (!parsed.success) throw new Error('Message does not match the collaboration protocol')
    if (parsed.data.type === 'sync') {
      await this.sendSync(
        client,
        parsed.data.stateVector
          ? Buffer.from(parsed.data.stateVector, 'base64url')
          : undefined,
      )
      return
    }
    if (parsed.data.type === 'awareness') {
      if (Buffer.byteLength(JSON.stringify(parsed.data.state)) > MAX_AWARENESS_BYTES) {
        throw new Error('Awareness state exceeds 16 KiB')
      }
      client.awareness = parsed.data.state
      client.awarenessVersion += 1
      this.broadcast(client, {
        type: 'awareness.update',
        client: this.awarenessPayload(client),
      })
      this.publishClientAwareness(client)
      return
    }

    const update = Buffer.from(parsed.data.update, 'base64url')
    const persisted = await this.options.repository.appendUpdate({
      ...client.location,
      update,
      origin: origin(client.principal),
    })
    send(client.socket, {
      type: 'update.ack',
      ...(parsed.data.clientUpdateId ? { clientUpdateId: parsed.data.clientUpdateId } : {}),
      seq: persisted.seq.toString(),
      updateHash: persisted.updateHash,
      inserted: persisted.inserted,
    })
    if (persisted.inserted) {
      this.deliverUpdate(client.location, {
        seq: persisted.seq,
        updateHash: persisted.updateHash,
        update,
        origin: origin(client.principal),
      }, client)
    }
  }

  private async sendSync(client: ConnectedClient, stateVector?: Uint8Array): Promise<void> {
    const state = await this.options.repository.syncState({
      ...client.location,
      ...(stateVector ? { remoteStateVector: stateVector } : {}),
    })
    client.syncedThroughUpdateSeq = state.throughUpdateSeq
    send(client.socket, {
      type: 'sync',
      update: Buffer.from(state.update).toString('base64url'),
      stateVector: Buffer.from(state.stateVector).toString('base64url'),
      stateHash: state.stateHash,
      throughUpdateSeq: state.throughUpdateSeq.toString(),
    })
  }

  private awarenessPayload(client: ConnectedClient): ArtifactAwarenessClient {
    return {
      clientId: client.id,
      identity: publicIdentity(client.principal),
      state: client.awareness ?? {},
    }
  }

  private publishClientAwareness(client: ConnectedClient): void {
    if (!client.awareness || client.awarenessVersion < 1) return
    this.publishAwareness({
      schemaVersion: 1,
      type: 'artifact.awareness_updated',
      sourceInstanceId: this.instanceId,
      ...client.location,
      version: client.awarenessVersion,
      client: this.awarenessPayload(client),
    })
  }

  private publishLocalAwareness(location: ArtifactLocation): void {
    const clients = this.rooms.get(roomKey(location))
    if (!clients) return
    for (const client of clients) this.publishClientAwareness(client)
  }

  private publishAwarenessProbe(location: ArtifactLocation): void {
    this.publishAwareness({
      schemaVersion: 1,
      type: 'artifact.awareness_probe',
      sourceInstanceId: this.instanceId,
      ...location,
    })
  }

  private publishAwareness(notification: ArtifactAwarenessNotification): void {
    if (!this.options.fanout) return
    let publication: Promise<void>
    try {
      publication = this.options.fanout.publishAwareness(notification)
    } catch (error) {
      this.reportFanoutError(error)
      return
    }
    const tracked = publication
      .catch((error: unknown) => this.reportFanoutError(error))
      .finally(() => { this.pendingAwarenessPublications.delete(tracked) })
    this.pendingAwarenessPublications.add(tracked)
  }

  private receiveAwarenessNotification(notification: unknown): void {
    const parsed = awarenessNotificationSchema.safeParse(notification)
    if (!parsed.success) {
      this.reportFanoutError(new Error('Artifact Awareness notification does not match protocol v1'))
      return
    }
    const value = parsed.data as ArtifactAwarenessNotification
    if (value.sourceInstanceId === this.instanceId) return
    const location: ArtifactLocation = {
      workspaceId: value.workspaceId,
      artifactId: value.artifactId,
    }
    if (!this.rooms.has(roomKey(location))) return
    if (value.type === 'artifact.awareness_probe') {
      this.publishLocalAwareness(location)
      return
    }
    if (value.type === 'artifact.awareness_removed') {
      this.removeRemoteAwareness(location, value.sourceInstanceId, value.clientId, value.version)
      return
    }
    if (Buffer.byteLength(JSON.stringify(value.client.state)) > MAX_AWARENESS_BYTES) {
      this.reportFanoutError(new Error('Artifact Awareness fan-out state exceeds 16 KiB'))
      return
    }
    this.updateRemoteAwareness(location, value)
  }

  private updateRemoteAwareness(
    location: ArtifactLocation,
    notification: Extract<ArtifactAwarenessNotification, { readonly type: 'artifact.awareness_updated' }>,
  ): void {
    const now = Date.now()
    this.expireRemoteAwareness(now)
    const key = remoteAwarenessKey(location, notification.sourceInstanceId, notification.client.clientId)
    const removed = this.removedRemoteAwareness.get(key)
    if (removed && notification.version <= removed.version) return
    if (removed) this.removedRemoteAwareness.delete(key)
    const existing = this.remoteAwareness.get(key)
    if (existing && notification.version < existing.version) return
    if (existing && notification.version === existing.version) {
      if (!sameAwarenessClient(existing.client, notification.client)) {
        this.reportFanoutError(new Error('Artifact Awareness version was reused with different state'))
        return
      }
      existing.expiresAt = now + this.awarenessTtlMs
      return
    }
    if (!existing && this.remoteAwareness.size >= MAX_REMOTE_AWARENESS) {
      this.evictOldestRemoteAwareness()
    }
    this.remoteAwareness.set(key, {
      sourceInstanceId: notification.sourceInstanceId,
      location,
      client: notification.client,
      version: notification.version,
      expiresAt: now + this.awarenessTtlMs,
    })
    this.broadcastLocation(location, {
      type: 'awareness.update',
      client: notification.client,
    })
  }

  private removeRemoteAwareness(
    location: ArtifactLocation,
    sourceInstanceId: string,
    clientId: string,
    version: number,
  ): void {
    const key = remoteAwarenessKey(location, sourceInstanceId, clientId)
    const existing = this.remoteAwareness.get(key)
    if (existing && version < existing.version) return
    this.remoteAwareness.delete(key)
    this.rememberRemoteRemoval(key, version)
    if (existing) {
      this.broadcastLocation(location, { type: 'awareness.remove', clientId })
    }
  }

  private rememberRemoteRemoval(key: string, version: number): void {
    const existing = this.removedRemoteAwareness.get(key)
    if (existing && existing.version > version) return
    if (!existing && this.removedRemoteAwareness.size >= MAX_REMOTE_AWARENESS) {
      const oldest = this.removedRemoteAwareness.keys().next().value as string | undefined
      if (oldest) {
        this.removedRemoteAwareness.delete(oldest)
        this.reportFanoutError(new Error('Artifact Awareness removal tombstone capacity was reached'))
      }
    }
    this.removedRemoteAwareness.set(key, {
      version,
      expiresAt: Date.now() + this.awarenessTtlMs,
    })
  }

  private evictOldestRemoteAwareness(): void {
    let oldestKey: string | undefined
    let oldest: RemoteAwareness | undefined
    for (const [key, presence] of this.remoteAwareness) {
      if (!oldest || presence.expiresAt < oldest.expiresAt) {
        oldestKey = key
        oldest = presence
      }
    }
    if (!oldestKey || !oldest) return
    this.remoteAwareness.delete(oldestKey)
    this.reportFanoutError(new Error('Artifact Awareness remote presence capacity was reached'))
    this.broadcastLocation(oldest.location, {
      type: 'awareness.remove',
      clientId: oldest.client.clientId,
    })
  }

  private expireRemoteAwareness(now = Date.now()): void {
    for (const [key, presence] of this.remoteAwareness) {
      if (presence.expiresAt > now) continue
      this.remoteAwareness.delete(key)
      this.broadcastLocation(presence.location, {
        type: 'awareness.remove',
        clientId: presence.client.clientId,
      })
    }
    for (const [key, removal] of this.removedRemoteAwareness) {
      if (removal.expiresAt <= now) this.removedRemoteAwareness.delete(key)
    }
  }

  private clearRemoteAwareness(): void {
    for (const presence of this.remoteAwareness.values()) {
      this.broadcastLocation(presence.location, {
        type: 'awareness.remove',
        clientId: presence.client.clientId,
      })
    }
    this.remoteAwareness.clear()
    this.removedRemoteAwareness.clear()
  }

  private dropRemoteAwarenessRoom(location: ArtifactLocation): void {
    const keyPrefix = roomKey(location) + '\u0000'
    for (const [key, presence] of this.remoteAwareness) {
      if (roomKey(presence.location) === roomKey(location)) this.remoteAwareness.delete(key)
    }
    for (const key of this.removedRemoteAwareness.keys()) {
      if (key.startsWith(keyPrefix)) this.removedRemoteAwareness.delete(key)
    }
  }

  private enqueueFanout(notification: unknown): void {
    const parsed = committedNotificationSchema.safeParse(notification)
    if (!parsed.success) {
      this.reportFanoutError(new Error('Artifact fan-out notification does not match protocol v1'))
      return
    }
    const value = parsed.data as ArtifactUpdateCommittedNotification
    const location: ArtifactLocation = {
      workspaceId: value.workspaceId as WorkspaceId,
      artifactId: value.artifactId as ArtifactId,
    }
    const key = roomKey(location)
    if (!this.rooms.has(key)) return
    const previous = this.fanoutQueues.get(key) ?? Promise.resolve()
    const next = previous
      .then(() => this.deliverCommittedNotification(location, value))
      .catch((error: unknown) => this.reportFanoutError(error))
    this.fanoutQueues.set(key, next)
    void next.then(() => {
      if (this.fanoutQueues.get(key) === next) this.fanoutQueues.delete(key)
    })
  }

  private async deliverCommittedNotification(
    location: ArtifactLocation,
    notification: ArtifactUpdateCommittedNotification,
  ): Promise<void> {
    if (!this.rooms.has(roomKey(location))) return
    const key = deliveryKey(location, {
      seq: BigInt(notification.seq),
      updateHash: notification.updateHash,
    })
    if (this.deliveredUpdates.has(key)) return
    const persisted = await this.options.repository.readPersistedUpdate({
      ...location,
      seq: BigInt(notification.seq),
      updateHash: notification.updateHash,
    })
    if (!persisted) return
    this.deliverUpdate(location, persisted)
  }

  private deliverUpdate(
    location: ArtifactLocation,
    update: PersistedArtifactUpdate,
    sourceClient?: ConnectedClient,
  ): void {
    const key = deliveryKey(location, update)
    if (this.deliveredUpdates.has(key)) return
    this.deliveredUpdates.set(key, true)
    if (this.deliveredUpdates.size > MAX_DELIVERED_UPDATES) {
      const oldest = this.deliveredUpdates.keys().next().value as string | undefined
      if (oldest) this.deliveredUpdates.delete(oldest)
    }
    const clients = this.rooms.get(roomKey(location))
    if (!clients) return
    const message = {
      type: 'update',
      update: Buffer.from(update.update).toString('base64url'),
      seq: update.seq.toString(),
      updateHash: update.updateHash,
      origin: publicOrigin(update.origin),
    }
    for (const peer of clients) {
      if (sourceClient ? peer === sourceClient : originMatchesClient(update.origin, peer)) continue
      if (update.seq <= peer.syncedThroughUpdateSeq) continue
      send(peer.socket, message)
    }
  }

  private async resyncRooms(): Promise<void> {
    for (const clients of this.rooms.values()) {
      const first = clients.values().next().value as ConnectedClient | undefined
      if (!first) continue
      try {
        const state = await this.options.repository.syncState(first.location)
        const message = {
          type: 'sync',
          update: Buffer.from(state.update).toString('base64url'),
          stateVector: Buffer.from(state.stateVector).toString('base64url'),
          stateHash: state.stateHash,
          throughUpdateSeq: state.throughUpdateSeq.toString(),
          reason: 'fanout_recovered',
        }
        for (const client of clients) {
          client.syncedThroughUpdateSeq = state.throughUpdateSeq
          send(client.socket, message)
        }
      } catch (error) {
        this.reportFanoutError(error)
      }
    }
  }

  private async recoverFanout(): Promise<void> {
    this.clearRemoteAwareness()
    await this.resyncRooms()
    for (const clients of this.rooms.values()) {
      const first = clients.values().next().value as ConnectedClient | undefined
      if (!first) continue
      this.publishLocalAwareness(first.location)
      this.publishAwarenessProbe(first.location)
    }
  }

  private reportFanoutError(error: unknown): void {
    this.options.onFanoutError?.(error instanceof Error ? error : new Error(String(error)))
  }

  private broadcast(client: ConnectedClient, value: unknown, excludeSender = false): void {
    const clients = this.rooms.get(roomKey(client.location))
    if (!clients) return
    for (const peer of clients) {
      if (excludeSender && peer === client) continue
      send(peer.socket, value)
    }
  }

  private broadcastLocation(location: ArtifactLocation, value: unknown): void {
    const clients = this.rooms.get(roomKey(location))
    if (!clients) return
    for (const client of clients) send(client.socket, value)
  }

  private disconnect(client: ConnectedClient): void {
    const key = roomKey(client.location)
    const clients = this.rooms.get(key)
    if (!clients?.delete(client)) return
    if (client.awareness) {
      this.broadcast(client, { type: 'awareness.remove', clientId: client.id })
      client.awarenessVersion += 1
      this.publishAwareness({
        schemaVersion: 1,
        type: 'artifact.awareness_removed',
        sourceInstanceId: this.instanceId,
        ...client.location,
        version: client.awarenessVersion,
        clientId: client.id,
      })
    }
    if (clients.size === 0) {
      this.rooms.delete(key)
      this.dropRemoteAwarenessRoom(client.location)
    }
  }

  private checkConnections(): void {
    this.expireRemoteAwareness()
    for (const clients of this.rooms.values()) {
      for (const client of clients) {
        if (!client.alive) {
          client.socket.terminate()
          continue
        }
        this.publishClientAwareness(client)
        client.alive = false
        client.socket.ping()
      }
    }
  }
}

export function attachArtifactRealtimeServer(
  server: HttpServer,
  options: ArtifactRealtimeServerOptions,
): ArtifactRealtimeServer {
  return new ArtifactRealtimeServer(server, options)
}

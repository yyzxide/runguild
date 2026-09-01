import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'

import type { ArtifactRepository, PersistedArtifactUpdate } from '@runguild/collaboration'
import type {
  ActorRef,
  AgentId,
  ArtifactId,
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
const MAX_AWARENESS_BYTES = 16 * 1024
const HEARTBEAT_INTERVAL_MS = 30_000

type ArtifactRealtimeRepository = Pick<
  ArtifactRepository,
  'appendUpdate' | 'authorizeActor' | 'readPersistedUpdate' | 'syncState'
>

export interface ArtifactRealtimeFanout {
  subscribe(listener: (notification: unknown) => void): () => void
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
  awareness?: AwarenessState
}

interface AwarenessState {
  readonly displayName?: string | undefined
  readonly color?: string | undefined
  readonly status?: string | undefined
  readonly activeBlockId?: string | undefined
  readonly cursor?: {
    readonly anchor: number
    readonly head: number
  } | undefined
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

function publicIdentity(principal: ArtifactRealtimePrincipal): Readonly<Record<string, string>> {
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
  private readonly deliveredUpdates = new Map<string, true>()
  private readonly fanoutQueues = new Map<string, Promise<void>>()
  private readonly unsubscribeFanout: (() => void) | undefined
  private readonly unsubscribeRecovery: (() => void) | undefined
  private recovery = Promise.resolve()

  constructor(
    private readonly server: HttpServer,
    private readonly options: ArtifactRealtimeServerOptions,
  ) {
    this.authenticate = options.authenticate ?? headerArtifactRealtimeAuthenticator
    this.handleUpgradeBound = (request) => void this.handleUpgrade(request)
    this.server.on('upgrade', this.handleUpgradeBound)
    this.heartbeat = setInterval(
      () => this.checkConnections(),
      options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    )
    this.heartbeat.unref()
    this.unsubscribeFanout = options.fanout?.subscribe((notification) => {
      this.enqueueFanout(notification)
    })
    this.unsubscribeRecovery = options.fanout?.onRecovered(() => {
      this.recovery = this.recovery
        .then(() => this.resyncRooms())
        .catch((error: unknown) => this.reportFanoutError(error))
    })
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat)
    this.unsubscribeFanout?.()
    this.unsubscribeRecovery?.()
    this.server.off('upgrade', this.handleUpgradeBound)
    for (const clients of this.rooms.values()) {
      for (const client of clients) client.socket.close(1001, 'Server shutting down')
    }
    await new Promise<void>((resolve) => this.websocketServer.close(() => resolve()))
    await Promise.allSettled([...this.fanoutQueues.values(), this.recovery])
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
    }
    const key = roomKey(location)
    const clients = this.rooms.get(key) ?? new Set<ConnectedClient>()
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
    send(socket, {
      type: 'awareness.snapshot',
      clients: [...clients]
        .filter((peer) => peer !== client && peer.awareness)
        .map((peer) => this.awarenessPayload(peer)),
    })
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
      this.broadcast(client, {
        type: 'awareness.update',
        client: this.awarenessPayload(client),
      })
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

  private awarenessPayload(client: ConnectedClient): Readonly<Record<string, unknown>> {
    return {
      clientId: client.id,
      identity: publicIdentity(client.principal),
      state: client.awareness ?? {},
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

  private disconnect(client: ConnectedClient): void {
    const key = roomKey(client.location)
    const clients = this.rooms.get(key)
    if (!clients?.delete(client)) return
    if (client.awareness) {
      this.broadcast(client, { type: 'awareness.remove', clientId: client.id })
    }
    if (clients.size === 0) this.rooms.delete(key)
  }

  private checkConnections(): void {
    for (const clients of this.rooms.values()) {
      for (const client of clients) {
        if (!client.alive) {
          client.socket.terminate()
          continue
        }
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

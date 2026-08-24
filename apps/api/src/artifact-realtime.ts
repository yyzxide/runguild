import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'

import type { ArtifactRepository } from '@runguild/collaboration'
import type {
  ActorRef,
  AgentId,
  ArtifactId,
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
const MAX_AWARENESS_BYTES = 16 * 1024
const HEARTBEAT_INTERVAL_MS = 30_000

type ArtifactRealtimeRepository = Pick<ArtifactRepository, 'appendUpdate' | 'authorizeActor' | 'syncState'>

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
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat)
    this.server.off('upgrade', this.handleUpgradeBound)
    for (const clients of this.rooms.values()) {
      for (const client of clients) client.socket.close(1001, 'Server shutting down')
    }
    await new Promise<void>((resolve) => this.websocketServer.close(() => resolve()))
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
      this.broadcast(client, {
        type: 'update',
        update: parsed.data.update,
        seq: persisted.seq.toString(),
        updateHash: persisted.updateHash,
        origin: publicIdentity(client.principal),
      }, true)
    }
  }

  private async sendSync(client: ConnectedClient, stateVector?: Uint8Array): Promise<void> {
    const state = await this.options.repository.syncState({
      ...client.location,
      ...(stateVector ? { remoteStateVector: stateVector } : {}),
    })
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

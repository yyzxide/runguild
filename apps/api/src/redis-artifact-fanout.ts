import { EVENT_TOPICS } from '@runguild/protocol'
import type { ArtifactAwarenessNotification } from '@runguild/protocol'
import { Redis } from 'ioredis'

import type { ArtifactRealtimeFanout } from './artifact-realtime.js'

const MAX_NOTIFICATION_BYTES = 16 * 1024
const MAX_PENDING_AWARENESS = 8_192

export interface RedisArtifactFanoutOptions {
  readonly onError?: (error: Error) => void
}

export class RedisArtifactFanout implements ArtifactRealtimeFanout {
  private readonly subscriber: Redis
  private readonly publisher: Redis
  private readonly listeners = new Set<(notification: unknown) => void>()
  private readonly awarenessListeners = new Set<(notification: unknown) => void>()
  private readonly recoveryListeners = new Set<() => void>()
  private readonly pendingAwareness = new Map<string, string>()
  private flushingAwareness: Promise<void> | undefined
  private subscribed = false
  private closed = false

  constructor(redisUrl: string, private readonly options: RedisArtifactFanoutOptions = {}) {
    this.subscriber = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    })
    this.publisher = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    })
    this.subscriber.on('error', (error: Error) => this.report(error))
    this.publisher.on('error', (error: Error) => this.report(error))
    this.publisher.on('ready', () => { void this.flushAwareness() })
    this.subscriber.on('message', (channel: string, raw: string) => {
      const listeners = channel === EVENT_TOPICS.artifactUpdates
        ? this.listeners
        : channel === EVENT_TOPICS.artifactAwareness
          ? this.awarenessListeners
          : undefined
      if (!listeners) return
      if (Buffer.byteLength(raw) > MAX_NOTIFICATION_BYTES) {
        this.report(new Error('Artifact realtime notification exceeds 16 KiB'))
        return
      }
      let notification: unknown
      try {
        notification = JSON.parse(raw)
      } catch {
        this.report(new Error('Artifact realtime notification must be valid JSON'))
        return
      }
      for (const listener of listeners) listener(notification)
    })
    this.subscriber.on('ready', () => {
      if (this.closed) return
      const recovered = this.subscribed
      void this.subscriber.subscribe(
        EVENT_TOPICS.artifactUpdates,
        EVENT_TOPICS.artifactAwareness,
      ).then(() => {
        this.subscribed = true
        if (recovered && !this.closed) {
          for (const listener of this.recoveryListeners) listener()
        }
      }).catch((error: unknown) => this.report(error))
    })
    void this.subscriber.connect().catch((error: unknown) => this.report(error))
    void this.publisher.connect().catch((error: unknown) => this.report(error))
  }

  subscribe(listener: (notification: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeAwareness(listener: (notification: unknown) => void): () => void {
    this.awarenessListeners.add(listener)
    return () => { this.awarenessListeners.delete(listener) }
  }

  async publishAwareness(notification: ArtifactAwarenessNotification): Promise<void> {
    const raw = JSON.stringify(notification)
    if (Buffer.byteLength(raw) > MAX_NOTIFICATION_BYTES) {
      throw new Error('Artifact Awareness notification exceeds 16 KiB')
    }
    if (this.closed) return
    const key = this.awarenessKey(notification)
    if (this.publisher.status !== 'ready') {
      this.queueAwareness(key, raw)
      return
    }
    if (this.pendingAwareness.has(key)) {
      this.queueAwareness(key, raw)
      await this.flushAwareness()
      await this.flushAwareness()
      return
    }
    try {
      await this.publisher.publish(EVENT_TOPICS.artifactAwareness, raw)
    } catch (error) {
      this.queueAwareness(key, raw)
      throw error
    }
  }

  onRecovered(listener: () => void): () => void {
    this.recoveryListeners.add(listener)
    return () => { this.recoveryListeners.delete(listener) }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.awarenessListeners.clear()
    this.recoveryListeners.clear()
    this.pendingAwareness.clear()
    this.subscriber.disconnect(false)
    this.publisher.disconnect(false)
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
  }

  private awarenessKey(notification: ArtifactAwarenessNotification): string {
    const client = notification.type === 'artifact.awareness_probe'
      ? 'probe'
      : notification.type === 'artifact.awareness_removed'
        ? notification.clientId
        : notification.client.clientId
    return notification.sourceInstanceId + '\u0000' + notification.workspaceId + '\u0000' +
      notification.artifactId + '\u0000' + client
  }

  private queueAwareness(key: string, raw: string): void {
    if (!this.pendingAwareness.has(key) && this.pendingAwareness.size >= MAX_PENDING_AWARENESS) {
      const oldest = this.pendingAwareness.keys().next().value as string | undefined
      if (oldest) {
        this.pendingAwareness.delete(oldest)
        this.report(new Error('Artifact Awareness pending publication capacity was reached'))
      }
    }
    this.pendingAwareness.set(key, raw)
  }

  private async flushAwareness(): Promise<void> {
    if (this.closed || this.publisher.status !== 'ready') return
    if (this.flushingAwareness) return this.flushingAwareness
    const operation = (async () => {
      for (const [key, raw] of this.pendingAwareness) {
        if (this.closed || this.publisher.status !== 'ready') return
        try {
          await this.publisher.publish(EVENT_TOPICS.artifactAwareness, raw)
          if (this.pendingAwareness.get(key) === raw) this.pendingAwareness.delete(key)
        } catch (error) {
          this.report(error)
          return
        }
      }
    })()
    this.flushingAwareness = operation
    try {
      await operation
    } finally {
      if (this.flushingAwareness === operation) this.flushingAwareness = undefined
    }
  }
}

import { EVENT_TOPICS } from '@runguild/protocol'
import { Redis } from 'ioredis'

import type { ArtifactRealtimeFanout } from './artifact-realtime.js'

const MAX_NOTIFICATION_BYTES = 16 * 1024

export interface RedisArtifactFanoutOptions {
  readonly onError?: (error: Error) => void
}

export class RedisArtifactFanout implements ArtifactRealtimeFanout {
  private readonly subscriber: Redis
  private readonly listeners = new Set<(notification: unknown) => void>()
  private readonly recoveryListeners = new Set<() => void>()
  private subscribed = false
  private closed = false

  constructor(redisUrl: string, private readonly options: RedisArtifactFanoutOptions = {}) {
    this.subscriber = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    })
    this.subscriber.on('error', (error: Error) => this.report(error))
    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== EVENT_TOPICS.artifactUpdates) return
      if (Buffer.byteLength(raw) > MAX_NOTIFICATION_BYTES) {
        this.report(new Error('Artifact fan-out notification exceeds 16 KiB'))
        return
      }
      let notification: unknown
      try {
        notification = JSON.parse(raw)
      } catch {
        this.report(new Error('Artifact fan-out notification must be valid JSON'))
        return
      }
      for (const listener of this.listeners) listener(notification)
    })
    this.subscriber.on('ready', () => {
      if (!this.subscribed || this.closed) return
      for (const listener of this.recoveryListeners) listener()
    })
    void this.subscriber.subscribe(EVENT_TOPICS.artifactUpdates)
      .then(() => { this.subscribed = true })
      .catch((error: unknown) => this.report(error))
  }

  subscribe(listener: (notification: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onRecovered(listener: () => void): () => void {
    this.recoveryListeners.add(listener)
    return () => { this.recoveryListeners.delete(listener) }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.recoveryListeners.clear()
    this.subscriber.disconnect(false)
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
  }
}

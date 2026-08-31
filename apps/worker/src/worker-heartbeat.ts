import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import type { WorkerInstanceRepository, WorkerKind } from '@runguild/database'
import type { AgentId, ProjectId, WorkspaceId } from '@runguild/protocol'

type WorkerInstanceStore = Pick<WorkerInstanceRepository, 'register' | 'heartbeat' | 'markStopped'>

export interface WorkerHeartbeatHandle {
  readonly instanceId: string
  isAlive(): boolean
  stop(): Promise<void>
}

export interface StartWorkerHeartbeatInput {
  readonly repository: WorkerInstanceStore
  readonly kind: WorkerKind
  readonly agentId?: AgentId
  readonly workspaceId?: WorkspaceId
  readonly projectId?: ProjectId
  readonly heartbeatIntervalMs?: number
  readonly instanceId?: string
  readonly hostname?: string
  readonly processId?: number
  readonly onFailure?: (error: Error) => void
}

export function workerHeartbeatIntervalMs(): number {
  const value = Number(process.env.WORKER_HEARTBEAT_MS ?? 5_000)
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw new Error('WORKER_HEARTBEAT_MS must be an integer between 1000 and 60000')
  }
  return value
}

export async function startWorkerHeartbeat(
  input: StartWorkerHeartbeatInput,
): Promise<WorkerHeartbeatHandle> {
  const intervalMs = input.heartbeatIntervalMs ?? workerHeartbeatIntervalMs()
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
    throw new Error('Worker heartbeat interval must be between 1000 and 60000 milliseconds')
  }
  const intervalSeconds = Math.ceil(intervalMs / 1_000)
  const timeoutSeconds = Math.max(intervalSeconds + 1, intervalSeconds * 3)
  const instanceId = input.instanceId ?? `worker_${input.kind}_${randomUUID()}`
  await input.repository.register({
    id: instanceId,
    kind: input.kind,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    hostname: input.hostname ?? hostname(),
    processId: input.processId ?? process.pid,
    heartbeatIntervalSeconds: intervalSeconds,
    heartbeatTimeoutSeconds: timeoutSeconds,
  })

  let alive = true
  let stopped = false
  let inFlight: Promise<void> | null = null
  const fail = (caught: unknown) => {
    if (!alive) return
    alive = false
    const error = caught instanceof Error ? caught : new Error(String(caught))
    input.onFailure?.(error)
  }
  const pulse = () => {
    if (!alive || stopped || inFlight) return
    inFlight = input.repository.heartbeat(instanceId).then((renewed) => {
      if (!renewed) throw new Error('Worker heartbeat ownership was lost: ' + instanceId)
    }).catch(fail).finally(() => {
      inFlight = null
    })
  }
  const timer = setInterval(pulse, intervalMs)

  return {
    instanceId,
    isAlive: () => alive,
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      await inFlight
      await input.repository.markStopped(instanceId)
      alive = false
    },
  }
}

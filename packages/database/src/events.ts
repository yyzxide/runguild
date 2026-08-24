import { randomUUID } from 'node:crypto'

import {
  EVENT_TOPICS,
  type ActorRef,
  type CorrelationId,
  type DomainEventPayloads,
  type DomainEventType,
  type EventEnvelope,
  type EventId,
  type IsoTimestamp,
  type MissionId,
  type ProjectId,
  type WorkspaceId,
} from '@runguild/protocol'
import type { PoolClient } from 'pg'

export interface AppendDomainEventInput<Type extends DomainEventType> {
  readonly type: Type
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly missionId?: MissionId
  readonly actor: ActorRef
  readonly correlationId: CorrelationId
  readonly causationId?: string
  readonly idempotencyKey?: string
  readonly payload: DomainEventPayloads[Type]
}

export async function appendDomainEvent<Type extends DomainEventType>(
  client: PoolClient,
  input: AppendDomainEventInput<Type>,
): Promise<EventEnvelope<Type>> {
  const eventId = ('evt_' + randomUUID()) as EventId
  const occurredAt = new Date().toISOString() as IsoTimestamp
  const envelope = {
    schemaVersion: 1,
    id: eventId,
    type: input.type,
    occurredAt,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actor: input.actor,
    correlationId: input.correlationId,
    payload: input.payload,
    ...(input.missionId === undefined ? {} : { missionId: input.missionId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  } as EventEnvelope<Type>

  await client.query(
    'INSERT INTO domain_events ' +
    '(id, schema_version, event_type, workspace_id, project_id, mission_id, actor, correlation_id, causation_id, idempotency_key, payload, occurred_at) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12)',
    [
      envelope.id,
      envelope.schemaVersion,
      envelope.type,
      envelope.workspaceId,
      envelope.projectId,
      envelope.missionId ?? null,
      JSON.stringify(envelope.actor),
      envelope.correlationId,
      envelope.causationId ?? null,
      envelope.idempotencyKey ?? null,
      JSON.stringify(envelope.payload),
      envelope.occurredAt,
    ],
  )

  await client.query(
    'INSERT INTO outbox_events (id, topic, partition_key, payload) VALUES ($1, $2, $3, $4::jsonb)',
    ['out_' + eventId, EVENT_TOPICS.domainEvents, input.missionId ?? input.projectId, JSON.stringify(envelope)],
  )

  return envelope
}

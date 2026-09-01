export const EVENT_TOPICS = {
  domainEvents: 'mission.domain-events.v1',
  agentWake: 'mission.agent-wake.v1',
  artifactUpdates: 'mission.artifact-updates.v1',
  artifactAwareness: 'mission.artifact-awareness.v1',
} as const

export type EventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS]

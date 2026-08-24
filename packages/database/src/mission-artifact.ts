import { createHash } from 'node:crypto'

import type { ArtifactId, MissionId, ProjectId, WorkspaceId } from '@runguild/protocol'
import type { PoolClient } from 'pg'

export interface MissionArtifactSummary {
  readonly id: ArtifactId
  readonly title: string
  readonly kind: string
}

export function primaryMissionArtifactId(missionId: MissionId): ArtifactId {
  const suffix = createHash('sha256').update(missionId).digest('hex').slice(0, 32)
  return ('artifact_mission_' + suffix) as ArtifactId
}

export async function ensurePrimaryMissionArtifact(
  client: Pick<PoolClient, 'query'>,
  input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly missionId: MissionId
    readonly missionTitle: string
    readonly createdBy: string
  },
): Promise<MissionArtifactSummary> {
  const artifactId = primaryMissionArtifactId(input.missionId)
  await client.query(
    'INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, kind, created_by) ' +
    "VALUES ($1, $2, $3, $4, $5, 'mission_deliverable', $6) ON CONFLICT (id) DO NOTHING",
    [
      artifactId,
      input.workspaceId,
      input.projectId,
      input.missionId,
      input.missionTitle.trim() + ' · Mission 交付物',
      input.createdBy,
    ],
  )
  const stored = await client.query<{
    readonly workspace_id: string
    readonly project_id: string
    readonly mission_id: string | null
    readonly title: string
    readonly kind: string
  }>(
    'SELECT workspace_id, project_id, mission_id, title, kind FROM artifacts WHERE id = $1',
    [artifactId],
  )
  const row = stored.rows[0]
  if (!row
      || row.workspace_id !== input.workspaceId
      || row.project_id !== input.projectId
      || row.mission_id !== input.missionId
      || row.kind !== 'mission_deliverable') {
    throw new Error('Primary Mission Artifact id is already bound to another scope')
  }
  return { id: artifactId, title: row.title, kind: row.kind }
}

import type {
  AgentId,
  AgentRole,
  MissionId,
  MissionStatus,
  ProjectId,
  UserId,
  WorkspaceId,
} from '@runguild/protocol'
import type { Pool } from 'pg'

import { withTransaction } from './transaction.js'

export interface ProjectOperatorOverview {
  readonly project: {
    readonly id: ProjectId
    readonly workspaceId: WorkspaceId
    readonly name: string
    readonly repositoryUrl: string | null
    readonly repositoryPath: string | null
    readonly defaultBranch: string
    readonly conversationId: string | null
  }
  readonly agents: readonly {
    readonly id: AgentId
    readonly name: string
    readonly role: AgentRole
    readonly status: 'active' | 'paused' | 'disabled'
    readonly modelProvider: string
    readonly modelName: string
    readonly activeRunCount: number
    readonly lastRunAt: string | null
    readonly worker: {
      readonly state: 'online' | 'stale' | 'stopped'
      readonly startedAt: string
      readonly lastHeartbeatAt: string
    } | null
  }[]
  readonly missions: readonly {
    readonly id: MissionId
    readonly title: string
    readonly status: MissionStatus
    readonly planVersion: number
    readonly taskCount: number
    readonly completedTaskCount: number
    readonly activeRunCount: number
    readonly updatedAt: string
  }[]
  readonly systemWorkers: readonly {
    readonly kind: 'scheduler' | 'integration' | 'evaluation'
    readonly state: 'online' | 'stale' | 'stopped' | 'never_seen'
    readonly onlineCount: number
    readonly lastHeartbeatAt: string | null
  }[]
}

const SYSTEM_WORKER_KINDS = ['scheduler', 'integration', 'evaluation'] as const

export class ProjectOperatorRepository {
  constructor(private readonly pool: Pool) {}

  async getOverview(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    userId: UserId,
  ): Promise<ProjectOperatorOverview | null> {
    return withTransaction(this.pool, async (client) => {
      const project = await client.query<{
        readonly id: string
        readonly workspace_id: string
        readonly name: string
        readonly repository_url: string | null
        readonly repository_path: string | null
        readonly default_branch: string
        readonly conversation_id: string | null
      }>(
        'SELECT project.id, project.workspace_id, project.name, project.repository_url, ' +
        'project.repository_path, project.default_branch, room.id AS conversation_id ' +
        'FROM projects project ' +
        'JOIN users actor ON actor.id = $3 AND actor.workspace_id = project.workspace_id ' +
        'LEFT JOIN LATERAL (' +
        'SELECT conversation.id FROM conversations conversation ' +
        'WHERE conversation.workspace_id = project.workspace_id ' +
        'AND conversation.project_id = project.id ' +
        "ORDER BY (conversation.kind = 'project_room') DESC, conversation.updated_at DESC, conversation.id LIMIT 1" +
        ') room ON TRUE ' +
        'WHERE project.workspace_id = $1 AND project.id = $2',
        [workspaceId, projectId, userId],
      )
      const projectRow = project.rows[0]
      if (!projectRow) return null

      const agents = projectRow.conversation_id
        ? await client.query<{
              readonly id: string
              readonly name: string
              readonly role: AgentRole
              readonly status: 'active' | 'paused' | 'disabled'
              readonly model_provider: string
              readonly model_name: string
              readonly active_run_count: number
              readonly last_run_at: Date | null
            }>(
              'SELECT agent.id, agent.name, agent.role, agent.status, agent.model_provider, agent.model_name, ' +
              'COUNT(run.id) FILTER (WHERE run.status IN ' +
              "('queued', 'starting', 'running', 'waiting_tool', 'waiting_human'))::int AS active_run_count, " +
              'MAX(run.updated_at) AS last_run_at ' +
              'FROM conversation_members member ' +
              'JOIN agents agent ON agent.id = member.participant_id ' +
              'AND agent.workspace_id = member.workspace_id ' +
              'LEFT JOIN agent_runs run ON run.agent_id = agent.id AND run.workspace_id = agent.workspace_id ' +
              'AND EXISTS (SELECT 1 FROM missions run_mission WHERE run_mission.id = run.mission_id ' +
              'AND run_mission.workspace_id = $2 AND run_mission.project_id = $3) ' +
              "WHERE member.conversation_id = $1 AND member.workspace_id = $2 AND member.participant_kind = 'agent' " +
              "GROUP BY agent.id ORDER BY CASE agent.role WHEN 'planner' THEN 1 WHEN 'researcher' THEN 2 " +
              "WHEN 'builder' THEN 3 WHEN 'reviewer' THEN 4 ELSE 5 END, agent.name, agent.id",
              [projectRow.conversation_id, workspaceId, projectId],
            )
        : { rows: [] }
      const missions = await client.query<{
          readonly id: string
          readonly title: string
          readonly status: MissionStatus
          readonly plan_version: number
          readonly task_count: number
          readonly completed_task_count: number
          readonly active_run_count: number
          readonly updated_at: Date
        }>(
          'SELECT mission.id, mission.title, mission.status, mission.plan_version, mission.updated_at, ' +
          'COUNT(DISTINCT task.id)::int AS task_count, ' +
          "COUNT(DISTINCT task.id) FILTER (WHERE task.status = 'completed')::int AS completed_task_count, " +
          'COUNT(DISTINCT run.id) FILTER (WHERE run.status IN ' +
          "('queued', 'starting', 'running', 'waiting_tool', 'waiting_human'))::int AS active_run_count " +
          'FROM missions mission ' +
          'LEFT JOIN tasks task ON task.mission_id = mission.id ' +
          'LEFT JOIN agent_runs run ON run.mission_id = mission.id AND run.workspace_id = mission.workspace_id ' +
          'WHERE mission.workspace_id = $1 AND mission.project_id = $2 ' +
          'GROUP BY mission.id ORDER BY mission.updated_at DESC, mission.id LIMIT 50',
          [workspaceId, projectId],
        )
      const agentWorkers = projectRow.conversation_id
        ? await client.query<{
              readonly agent_id: string
              readonly status: 'running' | 'stopped' | 'stale'
              readonly started_at: Date
              readonly last_heartbeat_at: Date
              readonly expires_at: Date
            }>(
              'SELECT DISTINCT ON (worker.agent_id) worker.agent_id, worker.status, ' +
              'worker.started_at, worker.last_heartbeat_at, worker.expires_at ' +
              'FROM worker_instances worker ' +
              'JOIN conversation_members member ON member.participant_kind = \'agent\' ' +
              'AND member.participant_id = worker.agent_id AND member.workspace_id = worker.workspace_id ' +
              'WHERE member.conversation_id = $1 AND member.workspace_id = $2 ' +
              'ORDER BY worker.agent_id, worker.started_at DESC, worker.id DESC',
              [projectRow.conversation_id, workspaceId],
            )
        : { rows: [] }
      const systemWorkers = await client.query<{
          readonly kind: 'scheduler' | 'integration' | 'evaluation'
          readonly status: 'running' | 'stopped' | 'stale'
          readonly last_heartbeat_at: Date
          readonly expires_at: Date
          readonly online_count: number
        }>(
          'SELECT latest.kind, latest.status, latest.last_heartbeat_at, latest.expires_at, ' +
          '(SELECT COUNT(*)::int FROM worker_instances live ' +
          "WHERE live.kind = latest.kind AND live.status = 'running' AND live.expires_at > NOW() " +
          'AND ((live.kind = \'integration\' AND live.workspace_id = $1 AND live.project_id = $2) ' +
          "OR (live.kind IN ('scheduler', 'evaluation') AND live.project_id IS NULL))) AS online_count " +
          'FROM (SELECT DISTINCT ON (kind) kind, status, last_heartbeat_at, expires_at, started_at, id ' +
          "FROM worker_instances WHERE kind <> 'agent' " +
          'AND ((kind = \'integration\' AND workspace_id = $1 AND project_id = $2) ' +
          "OR (kind IN ('scheduler', 'evaluation') AND project_id IS NULL)) " +
          'ORDER BY kind, started_at DESC, id DESC) latest ' +
          'ORDER BY latest.kind',
          [workspaceId, projectId],
        )

      const latestAgentWorkers = new Map(agentWorkers.rows.map((worker) => [worker.agent_id, worker]))
      const latestSystemWorkers = new Map(systemWorkers.rows.map((worker) => [worker.kind, worker]))
      const now = Date.now()

      return {
        project: {
          id: projectRow.id as ProjectId,
          workspaceId: projectRow.workspace_id as WorkspaceId,
          name: projectRow.name,
          repositoryUrl: projectRow.repository_url,
          repositoryPath: projectRow.repository_path,
          defaultBranch: projectRow.default_branch,
          conversationId: projectRow.conversation_id,
        },
        agents: agents.rows.map((agent) => ({
          id: agent.id as AgentId,
          name: agent.name,
          role: agent.role,
          status: agent.status,
          modelProvider: agent.model_provider,
          modelName: agent.model_name,
          activeRunCount: agent.active_run_count,
          lastRunAt: agent.last_run_at?.toISOString() ?? null,
          worker: (() => {
            const worker = latestAgentWorkers.get(agent.id)
            if (!worker) return null
            return {
              state: worker.status === 'running'
                ? worker.expires_at.getTime() > now ? 'online' : 'stale'
                : worker.status,
              startedAt: worker.started_at.toISOString(),
              lastHeartbeatAt: worker.last_heartbeat_at.toISOString(),
            }
          })(),
        })),
        missions: missions.rows.map((mission) => ({
          id: mission.id as MissionId,
          title: mission.title,
          status: mission.status,
          planVersion: mission.plan_version,
          taskCount: mission.task_count,
          completedTaskCount: mission.completed_task_count,
          activeRunCount: mission.active_run_count,
          updatedAt: mission.updated_at.toISOString(),
        })),
        systemWorkers: SYSTEM_WORKER_KINDS.map((kind) => {
          const worker = latestSystemWorkers.get(kind)
          if (!worker) return { kind, state: 'never_seen' as const, onlineCount: 0, lastHeartbeatAt: null }
          return {
            kind,
            state: worker.online_count > 0
              ? 'online' as const
              : worker.status === 'stopped'
                ? 'stopped' as const
                : 'stale' as const,
            onlineCount: worker.online_count,
            lastHeartbeatAt: worker.last_heartbeat_at.toISOString(),
          }
        }),
      }
    }, 'repeatable read')
  }
}

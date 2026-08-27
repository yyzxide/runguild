export type MissionStatus = 'draft' | 'planning' | 'awaiting_approval' | 'running' | 'paused' | 'reviewing' | 'completed' | 'failed' | 'cancelled'

export interface PlanTask {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly role: 'planner' | 'researcher' | 'builder' | 'reviewer' | 'custom'
  readonly priority: number
  readonly dependsOn: readonly string[]
  readonly reviewRequired: boolean
  readonly acceptanceCriteria: readonly {
    readonly key: string
    readonly description: string
    readonly required: boolean
    readonly evidenceKinds: readonly string[]
  }[]
}

export interface MissionPlan {
  readonly summary: string
  readonly tasks: readonly PlanTask[]
}

export interface MissionSnapshot {
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly title: string
  readonly goal: string
  readonly status: MissionStatus
  readonly planVersion: number
  readonly updatedAt: string
  readonly finalDelivery: {
    readonly artifactVersionId: string
    readonly artifactId: string
    readonly version: number
    readonly contentHash: string
    readonly approvalStatus: 'ready' | 'approved'
    readonly approvedBy?: string
    readonly approvedAt?: string
  } | null
  readonly proposedPlan: {
    readonly version: number
    readonly status: string
    readonly summary: string
    readonly hash: string
    readonly plan: MissionPlan
  } | null
  readonly tasks: readonly {
    readonly id: string
    readonly title: string
    readonly status: string
    readonly role: string | null
    readonly priority: number
    readonly dependsOn: readonly string[]
  }[]
}

export interface TestIdentity {
  readonly workspaceId: string
  readonly projectId: string
  readonly userId: string
}

export interface DevelopmentSetup extends TestIdentity {
  readonly conversationId: string
  readonly agents: readonly { readonly id: string; readonly role: string; readonly name: string }[]
}

export interface ProjectOperatorOverview {
  readonly project: {
    readonly id: string
    readonly workspaceId: string
    readonly name: string
    readonly repositoryUrl: string | null
    readonly repositoryPath: string | null
    readonly defaultBranch: string
    readonly conversationId: string | null
  }
  readonly agents: readonly {
    readonly id: string
    readonly name: string
    readonly role: string
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
    readonly id: string
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

export type WorkerKind = 'scheduler' | 'agent' | 'integration' | 'evaluation'

export interface ProjectRuntimeConfiguration {
  readonly project: {
    readonly id: string
    readonly workspaceId: string
    readonly name: string
    readonly repositoryPath: string | null
    readonly defaultBranch: string
  }
  readonly runtime: {
    readonly worktreeRoot: string | null
    readonly worktreeSetupCommands: readonly (readonly string[])[]
    readonly worktreeSetupTimeoutMs: number
    readonly testCommands: readonly (readonly string[])[]
    readonly agentContextInputTokens: number
    readonly agentMaxTestTimeoutMs: number
  }
  readonly agents: readonly {
    readonly id: string
    readonly name: string
    readonly role: string
    readonly status: 'active' | 'paused' | 'disabled'
    readonly modelProvider: string
    readonly modelName: string
  }[]
}

export interface RuntimeControlCapability {
  readonly enabled: boolean
  readonly reason?: string
  readonly secretSource?: 'api_environment'
  readonly workers: readonly {
    readonly kind: WorkerKind
    readonly agentId?: string
    readonly label: string
    readonly ready: boolean
    readonly missing: readonly string[]
    readonly managedByThisApi: boolean
  }[]
}

export interface ProjectRuntimeConfigurationResponse {
  readonly configuration: ProjectRuntimeConfiguration
  readonly recentSetups: readonly {
    readonly id: string
    readonly taskId: string
    readonly runId: string
    readonly worktreeGeneration: number
    readonly commands: readonly (readonly string[])[]
    readonly status: 'running' | 'succeeded' | 'failed'
    readonly attempt: number
    readonly error?: Readonly<Record<string, unknown>>
    readonly updatedAt: string
    readonly finishedAt?: string
  }[]
  readonly control: RuntimeControlCapability
}

export interface UpdateProjectRuntimeConfiguration {
  readonly repositoryPath: string
  readonly defaultBranch: string
  readonly worktreeRoot: string
  readonly worktreeSetupCommands: readonly (readonly string[])[]
  readonly worktreeSetupTimeoutMs: number
  readonly testCommands: readonly (readonly string[])[]
  readonly agentContextInputTokens: number
  readonly agentMaxTestTimeoutMs: number
  readonly agentModels: readonly {
    readonly agentId: string
    readonly modelProvider: string
    readonly modelName: string
  }[]
}

export interface ConversationMember {
  readonly kind: 'user' | 'agent'
  readonly id: string
  readonly name: string
  readonly notifications: boolean
  readonly role?: string
  readonly status?: 'active' | 'paused' | 'disabled'
}

export interface ConversationSnapshot {
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly kind: 'project_room' | 'mission_room' | 'group'
  readonly title: string
  readonly members: readonly ConversationMember[]
  readonly latestMessageAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ConversationMessage {
  readonly id: string
  readonly workspaceId: string
  readonly conversationId: string
  readonly sequence: string
  readonly author: { readonly kind: 'user' | 'agent' | 'system'; readonly id: string; readonly runId?: string }
  readonly authorName: string
  readonly body: string
  readonly mentions: readonly string[]
  readonly entityRefs: {
    readonly missionId?: string
    readonly taskId?: string
    readonly runId?: string
    readonly artifactId?: string
  }
  readonly deliveries: readonly {
    readonly agentId: string
    readonly status: 'steered' | 'context_pending' | 'context_loaded'
    readonly runId?: string
    readonly deliveredAt?: string
  }[]
  readonly replyToMessageId?: string
  readonly createdAt: string
}

export interface ConversationPlanningRequest {
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly conversationId: string
  readonly missionId: string
  readonly plannerAgentId: string
  readonly sourceMessageIds: readonly string[]
  readonly status: 'queued' | 'running' | 'model_complete' | 'awaiting_approval' | 'approved' | 'failed'
  readonly attempt: number
  readonly maxAttempts: number
  readonly planVersion?: number
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? ''

async function request<ResponseBody>(path: string, init: RequestInit = {}): Promise<ResponseBody> {
  let response: Response
  try {
    response = await fetch(apiBase + path, init)
  } catch {
    throw new Error('无法连接 API。请确认 PostgreSQL 和 API 服务已经启动。')
  }
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const payload = body as { error?: { message?: string; code?: string; reason?: string } } | null
    const message = payload?.error?.message ?? payload?.error?.reason ?? payload?.error?.code
    throw new Error(message ? `请求失败：${message}` : `请求失败（HTTP ${response.status}）`)
  }
  return body as ResponseBody
}

function actorHeaders(userId: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-actor-id': userId, 'x-actor-kind': 'user' }
}

export const missionApi = {
  async health(): Promise<void> {
    await request<{ readonly status: string }>('/health')
  },

  bootstrap(identity: TestIdentity): Promise<DevelopmentSetup> {
    return request('/api/v1/development/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...identity,
        workspaceName: 'RunGuild 实验室',
        projectName: 'RunGuild 演示项目',
        displayName: '本地开发者',
      }),
    })
  },

  getOperatorOverview(identity: TestIdentity): Promise<ProjectOperatorOverview> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/operator-overview`,
      { headers: actorHeaders(identity.userId) },
    )
  },

  getRuntimeConfiguration(identity: TestIdentity): Promise<ProjectRuntimeConfigurationResponse> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/runtime-config`,
      { headers: actorHeaders(identity.userId) },
    )
  },

  updateRuntimeConfiguration(
    identity: TestIdentity,
    configuration: UpdateProjectRuntimeConfiguration,
  ): Promise<ProjectRuntimeConfigurationResponse> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/runtime-config`,
      {
        method: 'PUT',
        headers: actorHeaders(identity.userId),
        body: JSON.stringify(configuration),
      },
    )
  },

  controlLocalWorker(
    identity: TestIdentity,
    action: 'start' | 'stop',
    command: { readonly kind: WorkerKind; readonly agentId?: string },
  ): Promise<{ readonly state: string; readonly message: string }> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/local-workers/${action}`,
      {
        method: 'POST',
        headers: actorHeaders(identity.userId),
        body: JSON.stringify(command),
      },
    )
  },

  async createMission(identity: TestIdentity, title: string, goal: string, conversationId?: string): Promise<string> {
    const result = await request<{ readonly missionId: string }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/missions`,
      {
        method: 'POST',
        headers: actorHeaders(identity.userId),
        body: JSON.stringify({
          title,
          goal,
          ...(conversationId ? { conversationId } : {}),
          constraints: ['所有结果必须形成可审计记录', '构建任务必须经过独立审查'],
          acceptanceCriteria: ['计划形成有效 DAG', '所有任务均有明确角色和验收条件'],
        }),
      },
    )
    return result.missionId
  },

  proposePlan(identity: TestIdentity, missionId: string, plan: MissionPlan): Promise<{ readonly version: number }> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/missions/${encodeURIComponent(missionId)}/plan`,
      {
        method: 'POST',
        headers: actorHeaders(identity.userId),
        body: JSON.stringify(plan),
      },
    )
  },

  approvePlan(identity: TestIdentity, missionId: string, expectedVersion: number): Promise<void> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/missions/${encodeURIComponent(missionId)}/plan/approve`,
      {
        method: 'POST',
        headers: actorHeaders(identity.userId),
        body: JSON.stringify({ expectedVersion }),
      },
    )
  },

  approveDelivery(identity: TestIdentity, missionId: string, expectedArtifactVersionId: string): Promise<void> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/missions/${encodeURIComponent(missionId)}/delivery/approve`,
      {
        method: 'POST',
        headers: actorHeaders(identity.userId),
        body: JSON.stringify({ expectedArtifactVersionId }),
      },
    )
  },

  getMission(identity: TestIdentity, missionId: string): Promise<MissionSnapshot> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/missions/${encodeURIComponent(missionId)}`,
      { headers: { 'x-actor-id': identity.userId, 'x-actor-kind': 'user' } },
    )
  },

  async listConversations(identity: TestIdentity): Promise<readonly ConversationSnapshot[]> {
    const result = await request<{ readonly conversations: readonly ConversationSnapshot[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/conversations`,
      { headers: actorHeaders(identity.userId) },
    )
    return result.conversations
  },

  async listMessages(identity: TestIdentity, conversationId: string): Promise<readonly ConversationMessage[]> {
    const result = await request<{ readonly messages: readonly ConversationMessage[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`,
      { headers: actorHeaders(identity.userId) },
    )
    return result.messages
  },

  async postMessage(input: {
    readonly identity: TestIdentity
    readonly conversationId: string
    readonly body: string
    readonly mentions: readonly string[]
    readonly missionId?: string
    readonly replyToMessageId?: string
  }): Promise<ConversationMessage> {
    const result = await request<{ readonly message: ConversationMessage; readonly reused: boolean }>(
      `/api/v1/workspaces/${encodeURIComponent(input.identity.workspaceId)}/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      {
        method: 'POST',
        headers: {
          ...actorHeaders(input.identity.userId),
          'x-idempotency-key': 'web-message-' + crypto.randomUUID(),
        },
        body: JSON.stringify({
          body: input.body,
          mentions: input.mentions,
          entityRefs: input.missionId ? { missionId: input.missionId } : {},
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        }),
      },
    )
    return result.message
  },

  async createPlanningRequest(input: {
    readonly identity: TestIdentity
    readonly conversationId: string
    readonly sourceMessageIds: readonly string[]
    readonly title: string
    readonly plannerAgentId?: string
  }): Promise<ConversationPlanningRequest> {
    const result = await request<{
      readonly request: ConversationPlanningRequest
      readonly reused: boolean
    }>(
      `/api/v1/workspaces/${encodeURIComponent(input.identity.workspaceId)}/conversations/${encodeURIComponent(input.conversationId)}/planning-requests`,
      {
        method: 'POST',
        headers: {
          ...actorHeaders(input.identity.userId),
          'x-idempotency-key': 'web-planning-' + crypto.randomUUID(),
        },
        body: JSON.stringify({
          sourceMessageIds: input.sourceMessageIds,
          title: input.title,
          ...(input.plannerAgentId ? { plannerAgentId: input.plannerAgentId } : {}),
        }),
      },
    )
    return result.request
  },

  getPlanningRequest(identity: TestIdentity, requestId: string): Promise<ConversationPlanningRequest> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/conversation-planning-requests/${encodeURIComponent(requestId)}`,
      { headers: actorHeaders(identity.userId) },
    )
  },
}

export const guidedPlan: MissionPlan = {
  summary: '先研究边界，再实现功能；实现任务通过独立 Submission Review 门禁后才能集成。',
  tasks: [
    {
      key: 'research',
      title: '分析需求与代码边界',
      description: '定位相关模块、约束和风险，形成可执行的实现说明。',
      role: 'researcher',
      priority: 10,
      dependsOn: [],
      reviewRequired: false,
      acceptanceCriteria: [{ key: 'scope', description: '受影响路径和约束已经明确', required: true, evidenceKinds: ['artifact_version'] }],
    },
    {
      key: 'build',
      title: '实现并验证目标功能',
      description: '根据研究结果修改代码，运行测试并提交可审查产物。',
      role: 'builder',
      priority: 20,
      dependsOn: ['research'],
      reviewRequired: true,
      acceptanceCriteria: [{ key: 'tests', description: '相关测试和完整回归通过', required: true, evidenceKinds: ['test_run'] }],
    },
  ],
}

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

export interface ArtifactActor {
  readonly kind: 'user' | 'agent' | 'service' | 'system'
  readonly id: string
  readonly runId?: string
}

export interface ArtifactVersionSummary {
  readonly id: string
  readonly artifactId: string
  readonly version: number
  readonly contentHash: string
  readonly yjsStateHash: string
  readonly throughUpdateSeq: string
  readonly createdBy: ArtifactActor
  readonly createdByRunId?: string
  readonly createdAt: string
}

export interface ProjectArtifactSummary {
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly missionId?: string
  readonly title: string
  readonly kind: string
  readonly createdBy: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly throughUpdateSeq: string
  readonly versionCount: number
  readonly latestVersion: ArtifactVersionSummary | null
}

export interface ProjectArtifactDetail {
  readonly artifact: Omit<ProjectArtifactSummary, 'throughUpdateSeq' | 'versionCount' | 'latestVersion'>
  readonly live: {
    readonly content: Readonly<Record<string, unknown>>
    readonly stateHash: string
    readonly stateBytes: number
    readonly throughUpdateSeq: string
  }
  readonly versions: readonly ArtifactVersionSummary[]
}

export interface ArtifactVersionSnapshot extends ArtifactVersionSummary {
  readonly content: Readonly<Record<string, unknown>>
  readonly yjsState: string
}

export interface TestIdentity {
  readonly workspaceId: string
  readonly projectId: string
  readonly userId: string
}

export interface AuthenticationSession {
  readonly user: {
    readonly id: string
    readonly workspaceId: string
    readonly displayName: string
    readonly role: 'owner' | 'operator' | 'viewer'
  }
  readonly projects: readonly {
    readonly id: string
    readonly name: string
    readonly role: 'owner' | 'operator' | 'viewer'
    readonly archivedAt: string | null
  }[]
  readonly expiresAt: string
  readonly idleExpiresAt: string
}

export interface ProjectMember {
  readonly userId: string
  readonly displayName: string
  readonly role: 'owner' | 'operator' | 'viewer'
  readonly joinedAt: string
}

export interface CreatedProject {
  readonly id: string
  readonly name: string
  readonly role: 'owner'
  readonly conversationId: string
  readonly agents: readonly {
    readonly id: string
    readonly role: 'planner' | 'researcher' | 'builder' | 'reviewer'
    readonly name: string
  }[]
}

export interface ProjectLifecycleState {
  readonly id: string
  readonly name: string
  readonly role: 'owner'
  readonly archivedAt: string | null
}

export interface AuthenticationMode {
  readonly mode: 'local' | 'team'
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

export interface RunTraceSummary {
  readonly runId: string
  readonly status: string
  readonly attempt: number
  readonly currentHop: number
  readonly maxHops: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly createdAt: string
  readonly agent: { readonly id: string; readonly name: string; readonly role: string | null }
  readonly task: { readonly id: string; readonly title: string; readonly role: string | null }
  readonly mission: { readonly id: string; readonly title: string }
}

export interface RunTraceEventSummary {
  readonly seq: number
  readonly id: string
  readonly runId: string
  readonly hop: number
  readonly kind: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

export interface RunTraceLlmCallSummary {
  readonly id: string
  readonly runId: string
  readonly hop: number
  readonly provider: string
  readonly model: string
  readonly status: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly estimatedCostUsd: number | null
  readonly latencyMs: number | null
  readonly errorCode: string | null
  readonly startedAt: string
  readonly finishedAt: string | null
}

export interface RunTraceToolExecutionSummary {
  readonly id: string
  readonly runId: string
  readonly action: string
  readonly status: string
  readonly effectState: string | null
  readonly errorCode: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export interface RunTraceContextSummary {
  readonly modelProvider: string | null
  readonly modelName: string | null
  readonly taskTitle: string
  readonly missionTitle: string
  readonly tokenBudget: number | null
  readonly estimatedTokens: number | null
  readonly compacted: boolean | null
}

export interface RunTraceDetail extends RunTraceSummary {
  readonly modelProvider: string | null
  readonly modelName: string | null
  readonly contextSummary: RunTraceContextSummary
  readonly completionSummary: string | null
  readonly events: readonly RunTraceEventSummary[]
  readonly llmCalls: readonly RunTraceLlmCallSummary[]
  readonly toolExecutions: readonly RunTraceToolExecutionSummary[]
}

export type EvaluationVariant = 'single_agent' | 'multi_agent'
export type EvaluationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type EvaluationTrialStatus = 'queued' | 'materializing' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface EvaluationScenarioVersionSummary {
  readonly id: string
  readonly scenarioId: string
  readonly scenarioName: string
  readonly scenarioDescription: string
  readonly version: number
  readonly definitionHash: string
  readonly baselineCommit: string
  readonly singleAgentTaskCount: number
  readonly multiAgentTaskCount: number
  readonly createdAt: string
}

export interface EvaluationExperimentSummary {
  readonly id: string
  readonly scenarioId: string
  readonly scenarioVersionId: string
  readonly scenarioName: string
  readonly name: string
  readonly status: EvaluationStatus
  readonly repetitions: number
  readonly variants: readonly EvaluationVariant[]
  readonly baselineCommit: string
  readonly trialCount: number
  readonly completedTrialCount: number
  readonly failedTrialCount: number
  readonly activeTrialCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface EvaluationTrialMetrics {
  readonly success: boolean
  readonly taskCompletionRate: number
  readonly wallTimeMs: number
  readonly taskCount: number
  readonly runAttempts: number
  readonly reworkAttempts: number
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly estimatedCostUsd: number
  readonly toolCalls: number
  readonly toolFailures: number
  readonly reviewChangesRequested: number
  readonly contextSnapshots: number
  readonly compactedContexts: number
  readonly estimatedContextTokens: number
}

export interface EvaluationTrial {
  readonly id: string
  readonly experimentId: string
  readonly scenarioVersionId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly variant: EvaluationVariant
  readonly repetition: number
  readonly seed: string
  readonly status: EvaluationTrialStatus
  readonly missionId?: string
  readonly metrics?: EvaluationTrialMetrics
  readonly error?: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly updatedAt: string
}

export interface EvaluationVariantAggregate {
  readonly variant: EvaluationVariant
  readonly completedTrials: number
  readonly successfulTrials: number
  readonly successRate: number
  readonly meanWallTimeMs: number
  readonly medianWallTimeMs: number
  readonly meanCostUsd: number
  readonly totalCostUsd: number
  readonly meanInputTokens: number
  readonly meanOutputTokens: number
  readonly meanReworkAttempts: number
}

export interface EvaluationExperimentReport {
  readonly experimentId: string
  readonly scenarioId: string
  readonly scenarioVersionId: string
  readonly status: EvaluationStatus
  readonly repetitions: number
  readonly variants: readonly EvaluationVariantAggregate[]
  readonly pairedTrials: number
  readonly pairedSuccessDelta: number
  readonly pairedMeanCostDeltaUsd: number
  readonly pairedMeanWallTimeDeltaMs: number
  readonly trials: readonly EvaluationTrial[]
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

function cookie(name: string): string | undefined {
  for (const entry of document.cookie.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 1 || entry.slice(0, separator).trim() !== name) continue
    return entry.slice(separator + 1).trim()
  }
  return undefined
}

function csrfToken(): string | undefined {
  return cookie('__Host-runguild_csrf') ?? cookie('runguild_csrf')
}

async function request<ResponseBody>(path: string, init: RequestInit = {}): Promise<ResponseBody> {
  let response: Response
  try {
    const headers = new Headers(init.headers)
    const method = init.method?.toUpperCase() ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const token = csrfToken()
      if (token) headers.set('x-csrf-token', token)
    }
    response = await fetch(apiBase + path, { ...init, credentials: 'include', headers })
  } catch {
    throw new Error('无法连接 API。请确认 PostgreSQL 和 API 服务已经启动。')
  }
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const payload = body as { error?: { message?: string; code?: string; reason?: string } } | null
    const message = payload?.error?.message ?? payload?.error?.reason ?? payload?.error?.code
    if (response.status === 401 && path !== '/api/v1/auth/login' && path !== '/api/v1/auth/local'
        && path !== '/api/v1/auth/session') {
      window.dispatchEvent(new Event('runguild:authentication-required'))
    }
    throw new Error(message ? `请求失败：${message}` : `请求失败（HTTP ${response.status}）`)
  }
  return body as ResponseBody
}

function actorHeaders(_userId: string): Record<string, string> {
  return { 'content-type': 'application/json' }
}

export const missionApi = {
  async health(): Promise<void> {
    await request<{ readonly status: string }>('/health')
  },

  session(): Promise<AuthenticationSession> {
    return request('/api/v1/auth/session')
  },

  authenticationMode(): Promise<AuthenticationMode> {
    return request('/api/v1/auth/mode')
  },

  localLogin(): Promise<AuthenticationSession> {
    return request('/api/v1/auth/local', { method: 'POST' })
  },

  login(input: { readonly userId: string; readonly password: string }): Promise<AuthenticationSession> {
    return request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  },

  bootstrapLocal(): Promise<DevelopmentSetup> {
    return request('/api/v1/development/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  },

  async createProject(workspaceId: string, input: {
    readonly name: string
    readonly repositoryPath?: string
    readonly defaultBranch: string
  }): Promise<CreatedProject> {
    const result = await request<{ readonly project: CreatedProject }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
    )
    return result.project
  },

  async updateProjectLifecycle(
    workspaceId: string,
    projectId: string,
    change: { readonly action: 'rename'; readonly name: string }
      | { readonly action: 'archive' }
      | { readonly action: 'restore' },
  ): Promise<ProjectLifecycleState> {
    const result = await request<{ readonly project: ProjectLifecycleState }>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/lifecycle`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) },
    )
    return result.project
  },

  async listProjectMembers(identity: TestIdentity): Promise<readonly ProjectMember[]> {
    const result = await request<{ readonly members: readonly ProjectMember[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/members`,
    )
    return result.members
  },

  async addProjectMember(identity: TestIdentity, input: {
    readonly userId: string
    readonly displayName: string
    readonly role: 'owner' | 'operator' | 'viewer'
    readonly password: string
  }): Promise<readonly ProjectMember[]> {
    const result = await request<{ readonly members: readonly ProjectMember[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/members`,
      { method: 'POST', headers: actorHeaders(identity.userId), body: JSON.stringify(input) },
    )
    return result.members
  },

  async updateProjectMember(identity: TestIdentity, userId: string, role: 'owner' | 'operator' | 'viewer'): Promise<readonly ProjectMember[]> {
    const result = await request<{ readonly members: readonly ProjectMember[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', headers: actorHeaders(identity.userId), body: JSON.stringify({ role }) },
    )
    return result.members
  },

  async removeProjectMember(identity: TestIdentity, userId: string): Promise<readonly ProjectMember[]> {
    const result = await request<{ readonly members: readonly ProjectMember[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE', headers: actorHeaders(identity.userId) },
    )
    return result.members
  },

  async logout(): Promise<void> {
    await request('/api/v1/auth/logout', { method: 'POST' })
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

  async listRunTraces(identity: TestIdentity): Promise<readonly RunTraceSummary[]> {
    const result = await request<{ readonly runs: readonly RunTraceSummary[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/run-traces`,
      { headers: actorHeaders(identity.userId) },
    )
    return result.runs
  },

  getRunTrace(identity: TestIdentity, runId: string): Promise<RunTraceDetail> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/run-traces/${encodeURIComponent(runId)}`,
      { headers: actorHeaders(identity.userId) },
    )
  },

  async listArtifacts(
    identity: TestIdentity,
    missionId?: string,
  ): Promise<readonly ProjectArtifactSummary[]> {
    const query = missionId ? `?missionId=${encodeURIComponent(missionId)}` : ''
    const result = await request<{ readonly artifacts: readonly ProjectArtifactSummary[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/artifacts${query}`,
      { headers: actorHeaders(identity.userId) },
    )
    return result.artifacts
  },

  getArtifact(identity: TestIdentity, artifactId: string): Promise<ProjectArtifactDetail> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: actorHeaders(identity.userId) },
    )
  },

  freezeArtifact(identity: TestIdentity, artifactId: string): Promise<ArtifactVersionSnapshot> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/versions`,
      { method: 'POST', headers: actorHeaders(identity.userId), body: '{}' },
    )
  },

  getArtifactVersion(identity: TestIdentity, versionId: string): Promise<ArtifactVersionSnapshot> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/artifact-versions/${encodeURIComponent(versionId)}`,
      { headers: actorHeaders(identity.userId) },
    )
  },

  async listEvaluationScenarioVersions(
    identity: TestIdentity,
  ): Promise<readonly EvaluationScenarioVersionSummary[]> {
    const result = await request<{ readonly scenarioVersions: readonly EvaluationScenarioVersionSummary[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/evaluation-scenario-versions`,
      { headers: actorHeaders(identity.userId) },
    )
    return result.scenarioVersions
  },

  async listEvaluationExperiments(
    identity: TestIdentity,
  ): Promise<readonly EvaluationExperimentSummary[]> {
    const result = await request<{ readonly experiments: readonly EvaluationExperimentSummary[] }>(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/evaluation-experiments`,
      { headers: actorHeaders(identity.userId) },
    )
    return result.experiments
  },

  createEvaluationExperiment(
    identity: TestIdentity,
    input: { readonly scenarioVersionId: string; readonly name: string; readonly repetitions: number },
  ): Promise<{ readonly id: string }> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/evaluation-experiments`,
      {
        method: 'POST',
        headers: actorHeaders(identity.userId),
        body: JSON.stringify(input),
      },
    )
  },

  getEvaluationReport(
    identity: TestIdentity,
    experimentId: string,
  ): Promise<EvaluationExperimentReport> {
    return request(
      `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/evaluation-experiments/${encodeURIComponent(experimentId)}/report`,
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
      { headers: actorHeaders(identity.userId) },
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

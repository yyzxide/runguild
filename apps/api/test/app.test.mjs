import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { createApiApp } from '../dist/app.js'

async function withServer(app, operation) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  try {
    return await operation('http://127.0.0.1:' + address.port)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

function fakeMissions() {
  const calls = []
  return {
    calls,
    service: {
      async createMission(input) {
        calls.push(['create', input])
        return 'mission_created'
      },
      async proposePlan(input) {
        calls.push(['plan', input])
        return { proposed: true, version: 1, hash: 'hash', reused: false }
      },
      async approvePlan(input) {
        calls.push(['approve', input])
        return { approved: true, version: 1, taskIdsByKey: { build: 'task_build' } }
      },
      async approveDelivery(input) {
        calls.push(['approve-delivery', input])
        return { approved: true, artifactVersionId: input.expectedArtifactVersionId, reused: false }
      },
      async getMission(workspaceId, missionId) {
        calls.push(['get', { workspaceId, missionId }])
        return {
          id: missionId,
          workspaceId,
          projectId: 'project_api',
          title: 'Mission',
          goal: 'Goal',
          status: 'running',
          planVersion: 1,
          updatedAt: '2030-01-01T00:00:00.000Z',
          finalDelivery: null,
          proposedPlan: null,
          tasks: [],
        }
      },
    },
  }
}

function fakeProjectOperator() {
  const calls = []
  return {
    calls,
    service: {
      async getOverview(workspaceId, projectId, userId) {
        calls.push({ workspaceId, projectId, userId })
        return {
          project: {
            id: projectId,
            workspaceId,
            name: 'RunGuild',
            repositoryUrl: null,
            repositoryPath: '/workspace/runguild',
            defaultBranch: 'main',
            conversationId: 'conversation_api',
          },
          agents: [{
            id: 'planner_api', name: '规划 Agent', role: 'planner', status: 'active',
            modelProvider: 'openai', modelName: 'gpt-test', activeRunCount: 0, lastRunAt: null,
            worker: {
              state: 'online', startedAt: '2030-01-01T00:00:00.000Z',
              lastHeartbeatAt: '2030-01-01T00:00:10.000Z',
            },
          }],
          missions: [{
            id: 'mission_created', title: 'Mission', status: 'running', planVersion: 1,
            taskCount: 1, completedTaskCount: 0, activeRunCount: 1,
            updatedAt: '2030-01-01T00:00:00.000Z',
          }],
          systemWorkers: [{
            kind: 'scheduler', state: 'online', onlineCount: 1,
            lastHeartbeatAt: '2030-01-01T00:00:10.000Z',
          }],
        }
      },
    },
  }
}

function fakeProjectRuntimeConfigs() {
  const calls = []
  let configuration = {
    project: {
      id: 'project_api', workspaceId: 'ws', name: 'RunGuild',
      repositoryPath: '/workspace/runguild', defaultBranch: 'main',
    },
    runtime: {
      worktreeRoot: '/workspace/runguild-worktrees',
      worktreeSetupCommands: [],
      worktreeSetupTimeoutMs: 300_000,
      testCommands: [['npm', 'test']],
      agentContextInputTokens: 65_536,
      agentMaxTestTimeoutMs: 120_000,
    },
    agents: [{
      id: 'planner_api', name: '规划 Agent', role: 'planner', status: 'active',
      modelProvider: 'openai', modelName: 'gpt-test',
    }],
  }
  return {
    calls,
    service: {
      async get(workspaceId, projectId, userId) {
        calls.push(['get', { workspaceId, projectId, userId }])
        return projectId === 'missing' ? null : configuration
      },
      async update(input) {
        calls.push(['update', input])
        configuration = {
          ...configuration,
          project: {
            ...configuration.project,
            repositoryPath: input.repositoryPath,
            defaultBranch: input.defaultBranch,
          },
          runtime: {
            worktreeRoot: input.worktreeRoot,
            worktreeSetupCommands: input.worktreeSetupCommands,
            worktreeSetupTimeoutMs: input.worktreeSetupTimeoutMs,
            testCommands: input.testCommands,
            agentContextInputTokens: input.agentContextInputTokens,
            agentMaxTestTimeoutMs: input.agentMaxTestTimeoutMs,
          },
          agents: configuration.agents.map((agent) => {
            const model = input.agentModels.find((candidate) => candidate.agentId === agent.id)
            return model ? { ...agent, modelProvider: model.modelProvider, modelName: model.modelName } : agent
          }),
        }
        return configuration
      },
    },
  }
}

function fakeRunTraces() {
  const calls = []
  const run = {
    runId: 'run_trace_1', status: 'completed', attempt: 1, currentHop: 3, maxHops: 5,
    startedAt: '2030-01-01T00:00:00.000Z', finishedAt: '2030-01-01T00:10:00.000Z',
    createdAt: '2030-01-01T00:00:00.000Z',
    agent: { id: 'builder_api', name: '构建 Agent', role: 'builder' },
    task: { id: 'task_build', title: 'Build', role: 'builder' },
    mission: { id: 'mission_created', title: 'Mission' },
    modelProvider: 'openai', modelName: 'gpt-test',
    contextSummary: {
      modelProvider: 'openai', modelName: 'gpt-test',
      taskTitle: 'Build', missionTitle: 'Mission',
    },
    completionSummary: 'Build completed',
    events: [{
      seq: 1, id: 'event_1', runId: 'run_trace_1', hop: 1, kind: 'observation',
      data: { note: 'plan' }, createdAt: '2030-01-01T00:00:01.000Z',
    }],
    llmCalls: [{
      id: 'llm_1', runId: 'run_trace_1', hop: 1, provider: 'openai', model: 'gpt-test',
      status: 'completed', inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0,
      estimatedCostUsd: 0.01, latencyMs: 1200, errorCode: null,
      startedAt: '2030-01-01T00:00:00.000Z', finishedAt: '2030-01-01T00:00:01.000Z',
    }],
    toolExecutions: [{
      id: 'tool_1', runId: 'run_trace_1', action: 'file.read', status: 'success',
      effectState: 'none', errorCode: null,
      startedAt: '2030-01-01T00:00:01.000Z', finishedAt: '2030-01-01T00:00:02.000Z',
    }],
  }
  return {
    calls,
    service: {
      async listRecentRuns(scope, limit) {
        calls.push(['list', scope, limit])
        return [run]
      },
      async getRun(scope, runId) {
        calls.push(['get', scope, runId])
        return runId === 'run_trace_missing' ? null : run
      },
    },
  }
}

function fakeLocalRuntimeControl() {
  const calls = []
  return {
    calls,
    service: {
      capabilities(configuration) {
        calls.push(['capabilities', configuration.project.id])
        return {
          enabled: true,
          secretSource: 'api_environment',
          workers: [{
            kind: 'scheduler', label: 'scheduler', ready: true, missing: [], managedByThisApi: false,
          }],
        }
      },
      async start(command, configuration) {
        calls.push(['start', command, configuration.project.id])
        return { ...command, state: 'starting', message: 'started' }
      },
      async stop(command) {
        calls.push(['stop', command])
        return { ...command, state: 'stopping', message: 'stopping' }
      },
    },
  }
}

function fakeDevelopmentSetup() {
  const calls = []
  return {
    calls,
    service: {
      async bootstrap(input) {
        calls.push(input)
        return { ...input, agents: [{ id: 'demo_project:agent:planner', role: 'planner', name: '规划 Agent' }] }
      },
    },
  }
}

function fakeConversations() {
  const calls = []
  const message = {
    id: 'message_api', workspaceId: 'ws', conversationId: 'conversation_api', sequence: '1',
    author: { kind: 'user', id: 'user_api' }, authorName: 'Developer', body: '请规划 Agent 检查计划。',
    mentions: ['planner_api'], entityRefs: { missionId: 'mission_created' },
    deliveries: [{ agentId: 'planner_api', status: 'steered', runId: 'run_api' }],
    createdAt: '2030-01-01T00:00:00.000Z',
  }
  return {
    calls,
    service: {
      async create(input) {
        calls.push(['conversation.create', input])
        return {
          id: 'conversation_api', workspaceId: input.workspaceId, projectId: input.projectId,
          kind: input.kind, title: input.title, members: [],
          createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
        }
      },
      async listProject(workspaceId, projectId, actor) {
        calls.push(['conversation.list', { workspaceId, projectId, actor }])
        return []
      },
      async listMessages(input) {
        calls.push(['message.list', input])
        return [message]
      },
      async postMessage(input) {
        calls.push(['message.post', input])
        return { message: { ...message, body: input.body, mentions: input.mentions }, reused: false }
      },
    },
  }
}

function fakeConversationPlanning() {
  const calls = []
  const request = {
    id: 'planning_api', workspaceId: 'ws', projectId: 'project_api',
    conversationId: 'conversation_api', missionId: 'mission_from_conversation',
    plannerAgentId: 'planner_api', sourceMessageIds: ['message_api'], status: 'queued',
    attempt: 0, maxAttempts: 3,
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
  }
  return {
    calls,
    service: {
      async create(input) { calls.push(['planning.create', input]); return { request, reused: false } },
      async get(workspaceId, requestId, actor) {
        calls.push(['planning.get', { workspaceId, requestId, actor }])
        return { ...request, id: requestId, workspaceId }
      },
    },
  }
}

function fakeRuntimeServices() {
  const calls = []
  return {
    calls,
    runControls: {
      async createControl(input) {
        calls.push(['control', input])
        return input.id
      },
    },
    toolApprovals: {
      async resolveApproval(input) {
        calls.push(['tool_approval', input])
        return true
      },
    },
  }
}

function fakeTaskControls() {
  const calls = []
  return {
    calls,
    service: {
      async retryFailedTask(input) {
        calls.push(input)
        return { retried: true, maxAttempts: 4 }
      },
    },
  }
}

function fakeReviewerExecutionControls() {
  const calls = []
  return {
    calls,
    service: {
      async retryFailed(input) {
        calls.push(input)
        return { retried: true, maxAttempts: 4 }
      },
    },
  }
}

function fakeArtifacts() {
  const calls = []
  return {
    calls,
    service: {
      async authorizeActor() {},
      async create(input) {
        calls.push(['artifact.create', input])
        return {
          id: input.artifactId ?? 'artifact_api',
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          title: input.title,
          kind: input.kind ?? 'document',
          createdBy: input.createdBy,
          createdAt: '2030-01-01T00:00:00.000Z',
          updatedAt: '2030-01-01T00:00:00.000Z',
        }
      },
      async appendUpdate(input) {
        calls.push(['artifact.update', input])
        return { seq: 7n, updateHash: 'update_hash', inserted: true }
      },
      async syncState(input) {
        calls.push(['artifact.sync', input])
        return {
          update: Uint8Array.from([1, 2, 3]),
          stateVector: Uint8Array.from([4, 5]),
          stateHash: 'state_hash',
          throughUpdateSeq: 7n,
        }
      },
      async createVersion(input) {
        calls.push(['artifact.version', input])
        return {
          id: input.versionId ?? 'artifact_version_api',
          artifactId: input.artifactId,
          version: 1,
          content: { type: 'doc', content: [] },
          yjsState: Uint8Array.from([1, 2, 3]),
          contentHash: 'content_hash',
          yjsStateHash: 'state_hash',
          throughUpdateSeq: 7n,
          createdBy: input.createdBy,
          createdAt: '2030-01-01T00:00:00.000Z',
        }
      },
      async readVersion(input) {
        calls.push(['artifact.read_version', input])
        return {
          id: input.versionId,
          artifactId: 'artifact_api',
          version: 1,
          content: { type: 'doc', content: [] },
          yjsState: Uint8Array.from([1, 2, 3]),
          contentHash: 'content_hash',
          yjsStateHash: 'state_hash',
          throughUpdateSeq: 7n,
          createdBy: { kind: 'user', id: 'user_api' },
          createdAt: '2030-01-01T00:00:00.000Z',
        }
      },
    },
  }
}

function fakeReviews() {
  const calls = []
  const submission = {
    id: 'submission_api',
    workspaceId: 'ws',
    missionId: 'mission_created',
    taskId: 'task_api',
    runId: 'run_api',
    artifactVersionId: 'artifact_version_api',
    submittedByAgentId: 'builder_api',
    status: 'submitted',
    evidenceBundleHash: 'bundle_hash',
    note: 'Review this.',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
  }
  return {
    calls,
    service: {
      async submitArtifactVersion(input) {
        calls.push(['review.submit', input])
        return submission
      },
      async reviewSubmission(input) {
        calls.push(['review.decide', input])
        return {
          submission: { ...submission, status: input.decision === 'approved' ? 'approved' : 'rejected' },
          review: {
            id: input.reviewId ?? 'review_api',
            submissionId: input.submissionId,
            status: input.decision,
            reviewer: input.reviewer,
            summary: input.summary,
            findings: input.findings,
            createdAt: '2030-01-01T00:00:00.000Z',
            completedAt: '2030-01-01T00:00:00.000Z',
          },
          taskCompletion: { completed: true, unlockedTaskIds: [], missionReadyForReview: false },
        }
      },
      async getSubmission(workspaceId, submissionId) {
        calls.push(['review.get', { workspaceId, submissionId }])
        return { submission, review: null }
      },
    },
  }
}

function fakeSkills() {
  const calls = []
  const version = {
    skillId: 'skill_api',
    versionId: 'skill_version_api',
    name: 'Repository testing',
    description: 'Repository-specific checks.',
    instructions: 'Run tests and typecheck.',
    contentHash: 'a'.repeat(64),
    estimatedTokens: 12,
    priority: 10,
  }
  return {
    calls,
    service: {
      async create(input) {
        calls.push(['skill.create', input])
        return {
          id: input.id ?? 'skill_api',
          workspaceId: input.workspaceId,
          slug: input.slug,
          name: input.name,
          description: input.description ?? '',
          status: 'active',
        }
      },
      async createVersion(input) {
        calls.push(['skill.version', input])
        return version
      },
      async assign(input) {
        calls.push(['skill.assign', input])
      },
      async listForAgent(workspaceId, agentId) {
        calls.push(['skill.list', { workspaceId, agentId }])
        return [version]
      },
    },
  }
}

function fakeEvaluations() {
  const calls = []
  const experiment = {
    id: 'evaluation_experiment_api',
    workspaceId: 'ws',
    projectId: 'project',
    scenarioId: 'evaluation_scenario_api',
    scenarioVersionId: 'evaluation_scenario_version_api',
    name: 'Single vs multi Agent',
    status: 'queued',
    repetitions: 1,
    variants: ['single_agent', 'multi_agent'],
    trials: [],
  }
  return {
    calls,
    service: {
      async listScenarioVersions(input) {
        calls.push(['evaluation.versions.list', input])
        return [{
          id: 'evaluation_scenario_version_api',
          scenarioId: 'evaluation_scenario_api',
          scenarioName: 'Single vs multi Agent',
          scenarioDescription: '',
          version: 1,
          definitionHash: 'e'.repeat(64),
          baselineCommit: 'a'.repeat(40),
          singleAgentTaskCount: 1,
          multiAgentTaskCount: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        }]
      },
      async listExperiments(input) {
        calls.push(['evaluation.experiments.list', input])
        return [{
          ...experiment,
          scenarioName: 'Single vs multi Agent',
          baselineCommit: 'a'.repeat(40),
          trialCount: 0,
          completedTrialCount: 0,
          failedTrialCount: 0,
          activeTrialCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }]
      },
      async createScenario(input) {
        calls.push(['evaluation.scenario', input])
        return input.id ?? 'evaluation_scenario_api'
      },
      async createScenarioVersion(input) {
        calls.push(['evaluation.version', input])
        return {
          id: input.id ?? 'evaluation_scenario_version_api',
          version: 1,
          definitionHash: 'e'.repeat(64),
          reused: false,
        }
      },
      async createExperiment(input) {
        calls.push(['evaluation.experiment', input])
        return experiment
      },
      async getExperiment(workspaceId, projectId, experimentId) {
        calls.push(['evaluation.report', { workspaceId, projectId, experimentId }])
        return projectId === experiment.projectId ? experiment : null
      },
    },
  }
}

test('mission API enforces actor identity and exposes command flow', async () => {
  const fake = fakeMissions()
  const projectOperator = fakeProjectOperator()
  const projectRuntimeConfigs = fakeProjectRuntimeConfigs()
  const localRuntimeControl = fakeLocalRuntimeControl()
  const runtime = fakeRuntimeServices()
  const taskControls = fakeTaskControls()
  const reviewerExecutions = fakeReviewerExecutionControls()
  const artifacts = fakeArtifacts()
  const reviews = fakeReviews()
  const skills = fakeSkills()
  const evaluations = fakeEvaluations()
  const development = fakeDevelopmentSetup()
  const conversations = fakeConversations()
  const conversationPlanning = fakeConversationPlanning()
  const runTraces = fakeRunTraces()
  const app = createApiApp({
    missions: fake.service,
    projectOperator: projectOperator.service,
    projectRuntimeConfigs: projectRuntimeConfigs.service,
    runTraces: runTraces.service,
    conversations: conversations.service,
    conversationPlanning: conversationPlanning.service,
    runControls: runtime.runControls,
    taskControls: taskControls.service,
    toolApprovals: runtime.toolApprovals,
    artifacts: artifacts.service,
    reviews: reviews.service,
    reviewerExecutions: reviewerExecutions.service,
    skills: skills.service,
    evaluations: evaluations.service,
    developmentSetup: development.service,
    localRuntimeControl: localRuntimeControl.service,
  })

  await withServer(app, async (baseUrl) => {
    const bootstrapped = await fetch(baseUrl + '/api/v1/development/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'demo_workspace', projectId: 'demo_project', userId: 'demo_user' }),
    })
    assert.equal(bootstrapped.status, 200)
    assert.equal((await bootstrapped.json()).agents[0].role, 'planner')

    const overview = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/operator-overview', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(overview.status, 200)
    assert.equal((await overview.json()).missions[0].activeRunCount, 1)
    assert.deepEqual(projectOperator.calls[0], {
      workspaceId: 'ws', projectId: 'project_api', userId: 'user_api',
    })

    const agentOverview = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/operator-overview', {
      headers: { 'x-actor-id': 'planner_api', 'x-actor-kind': 'agent' },
    })
    assert.equal(agentOverview.status, 403)

    const runTracesList = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/run-traces', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(runTracesList.status, 200)
    const runTracesBody = await runTracesList.json()
    assert.equal(runTracesBody.runs[0].runId, 'run_trace_1')
    assert.deepEqual(runTraces.calls[0], ['list', {
      workspaceId: 'ws', projectId: 'project_api', actorId: 'user_api',
    }, 20])

    const runTraceDetail = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/run-traces/run_trace_1', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(runTraceDetail.status, 200)
    const runTraceBody = await runTraceDetail.json()
    assert.equal(runTraceBody.run.events[0].seq, 1)
    assert.deepEqual(runTraces.calls[1], ['get', {
      workspaceId: 'ws', projectId: 'project_api', actorId: 'user_api',
    }, 'run_trace_1'])

    const runTraceMissing = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/run-traces/run_trace_missing', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(runTraceMissing.status, 404)

    const agentRunTraces = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/run-traces', {
      headers: { 'x-actor-id': 'planner_api', 'x-actor-kind': 'agent' },
    })
    assert.equal(agentRunTraces.status, 403)

    const runtimeConfig = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/runtime-config', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(runtimeConfig.status, 200)
    const runtimeConfigBody = await runtimeConfig.json()
    assert.equal(runtimeConfigBody.configuration.project.defaultBranch, 'main')
    assert.deepEqual(runtimeConfigBody.recentSetups, [])
    assert.equal(runtimeConfigBody.control.enabled, true)
    assert.equal(JSON.stringify(runtimeConfigBody).includes('secret-value'), false)

    const updatedRuntime = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/runtime-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'user_api' },
      body: JSON.stringify({
        repositoryPath: '/workspace/new-runguild',
        defaultBranch: 'develop',
        worktreeRoot: '/workspace/new-worktrees',
        worktreeSetupCommands: [['npm', 'ci', '--ignore-scripts']],
        worktreeSetupTimeoutMs: 240_000,
        testCommands: [['npm', 'test'], ['npm', 'run', 'typecheck']],
        agentContextInputTokens: 80_000,
        agentMaxTestTimeoutMs: 180_000,
        agentModels: [{ agentId: 'planner_api', modelProvider: 'openai', modelName: 'gpt-new' }],
      }),
    })
    assert.equal(updatedRuntime.status, 200)
    const updatedRuntimeBody = await updatedRuntime.json()
    assert.equal(updatedRuntimeBody.configuration.agents[0].modelName, 'gpt-new')
    assert.deepEqual(updatedRuntimeBody.configuration.runtime.worktreeSetupCommands, [['npm', 'ci', '--ignore-scripts']])

    const agentRuntimeConfig = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/runtime-config', {
      headers: { 'x-actor-id': 'planner_api', 'x-actor-kind': 'agent' },
    })
    assert.equal(agentRuntimeConfig.status, 403)

    const startedWorker = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/local-workers/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'user_api' },
      body: JSON.stringify({ kind: 'scheduler' }),
    })
    assert.equal(startedWorker.status, 202)
    assert.equal((await startedWorker.json()).state, 'starting')

    const invalidAgentWorker = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/local-workers/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'user_api' },
      body: JSON.stringify({ kind: 'agent' }),
    })
    assert.equal(invalidAgentWorker.status, 400)

    const stoppedWorker = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project_api/local-workers/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'user_api' },
      body: JSON.stringify({ kind: 'scheduler' }),
    })
    assert.equal(stoppedWorker.status, 200)
    assert.equal((await stoppedWorker.json()).state, 'stopping')

    const postedMessage = await fetch(baseUrl + '/api/v1/workspaces/ws/conversations/conversation_api/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
        'x-idempotency-key': 'message-api-1',
      },
      body: JSON.stringify({
        body: '请规划 Agent 检查计划。',
        mentions: ['planner_api'],
        entityRefs: { missionId: 'mission_created' },
      }),
    })
    assert.equal(postedMessage.status, 201)
    assert.equal((await postedMessage.json()).message.deliveries[0].status, 'steered')

    const planningRequest = await fetch(baseUrl + '/api/v1/workspaces/ws/conversations/conversation_api/planning-requests', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
        'x-idempotency-key': 'planning-api-1',
      },
      body: JSON.stringify({ sourceMessageIds: ['message_api'], title: '从会话生成 Mission' }),
    })
    assert.equal(planningRequest.status, 201)
    assert.equal((await planningRequest.json()).request.status, 'queued')

    const planningStatus = await fetch(baseUrl + '/api/v1/workspaces/ws/conversation-planning-requests/planning_api', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(planningStatus.status, 200)
    assert.equal((await planningStatus.json()).missionId, 'mission_from_conversation')

    const unauthorized = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Mission', goal: 'Goal' }),
    })
    assert.equal(unauthorized.status, 401)

    const created = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/missions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({ title: 'Mission', goal: 'Goal' }),
    })
    assert.equal(created.status, 201)
    assert.deepEqual(await created.json(), { missionId: 'mission_created' })

    const proposed = await fetch(baseUrl + '/api/v1/workspaces/ws/missions/mission_created/plan', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'planner_api',
        'x-actor-kind': 'agent',
      },
      body: JSON.stringify({
        summary: 'Build it.',
        tasks: [{
          key: 'build',
          title: 'Build',
          role: 'builder',
        }],
      }),
    })
    assert.equal(proposed.status, 201)

    const agentApproval = await fetch(baseUrl + '/api/v1/workspaces/ws/missions/mission_created/plan/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'planner_api',
        'x-actor-kind': 'agent',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    })
    assert.equal(agentApproval.status, 403)

    const approved = await fetch(baseUrl + '/api/v1/workspaces/ws/missions/mission_created/plan/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({ expectedVersion: 1 }),
    })
    assert.equal(approved.status, 200)

    const agentDeliveryApproval = await fetch(baseUrl + '/api/v1/workspaces/ws/missions/mission_created/delivery/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'reviewer_api',
        'x-actor-kind': 'agent',
      },
      body: JSON.stringify({ expectedArtifactVersionId: 'version_delivery' }),
    })
    assert.equal(agentDeliveryApproval.status, 403)

    const deliveryApproved = await fetch(baseUrl + '/api/v1/workspaces/ws/missions/mission_created/delivery/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({ expectedArtifactVersionId: 'version_delivery' }),
    })
    assert.equal(deliveryApproved.status, 200)
    assert.equal((await deliveryApproved.json()).artifactVersionId, 'version_delivery')

    const mission = await fetch(baseUrl + '/api/v1/workspaces/ws/missions/mission_created', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(mission.status, 200)
    assert.equal((await mission.json()).id, 'mission_created')

    const agentRetry = await fetch(
      baseUrl + '/api/v1/workspaces/ws/missions/mission_created/tasks/task_failed/retry',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'builder_api',
          'x-actor-kind': 'agent',
        },
        body: JSON.stringify({ reason: 'Agent cannot expand its own retry budget.' }),
      },
    )
    assert.equal(agentRetry.status, 403)

    const retried = await fetch(
      baseUrl + '/api/v1/workspaces/ws/missions/mission_created/tasks/task_failed/retry',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-actor-id': 'user_api' },
        body: JSON.stringify({ reason: 'Runtime repair was deployed.' }),
      },
    )
    assert.equal(retried.status, 200)
    assert.deepEqual(await retried.json(), { retried: true, maxAttempts: 4 })
    assert.equal(taskControls.calls[0].requestedBy, 'user_api')
    assert.equal(taskControls.calls[0].reason, 'Runtime repair was deployed.')

    const steered = await fetch(baseUrl + '/api/v1/workspaces/ws/runs/run_api/controls', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
        'x-idempotency-key': 'steer_once',
      },
      body: JSON.stringify({ kind: 'steer', message: 'Focus on the failing test.' }),
    })
    assert.equal(steered.status, 202)

    const approval = await fetch(baseUrl + '/api/v1/workspaces/ws/tool-approvals/approval_api/resolve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({ decision: 'approved' }),
    })
    assert.equal(approval.status, 200)

    const skill = await fetch(baseUrl + '/api/v1/workspaces/ws/skills', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({
        skillId: 'skill_api',
        slug: 'repository-testing',
        name: 'Repository testing',
        description: 'Repository-specific checks.',
      }),
    })
    assert.equal(skill.status, 201)

    const skillVersion = await fetch(baseUrl + '/api/v1/workspaces/ws/skills/skill_api/versions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({
        versionId: 'skill_version_api',
        instructions: 'Run tests and typecheck.',
      }),
    })
    assert.equal(skillVersion.status, 201)

    const assignedSkill = await fetch(
      baseUrl + '/api/v1/workspaces/ws/agents/builder_api/skills/skill_api',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'user_api',
        },
        body: JSON.stringify({ pinnedVersionId: 'skill_version_api', priority: 10 }),
      },
    )
    assert.equal(assignedSkill.status, 200)

    const assignedSkills = await fetch(
      baseUrl + '/api/v1/workspaces/ws/agents/builder_api/skills',
      { headers: { 'x-actor-id': 'user_api' } },
    )
    assert.equal(assignedSkills.status, 200)
    assert.equal((await assignedSkills.json()).skills[0].versionId, 'skill_version_api')

    const scenario = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project/evaluation-scenarios',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'user_api',
        },
        body: JSON.stringify({
          scenarioId: 'evaluation_scenario_api',
          slug: 'single-vs-multi',
          name: 'Single vs multi Agent',
        }),
      },
    )
    assert.equal(scenario.status, 201)

    const scenarioDefinition = {
      goal: 'Implement and verify.',
      constraints: [],
      acceptanceCriteria: [],
      baselineCommit: 'a'.repeat(40),
      singleAgentPlan: {
        summary: 'Single.',
        tasks: [{ key: 'all', title: 'All', role: 'builder' }],
      },
      multiAgentPlan: {
        summary: 'Multi.',
        tasks: [
          { key: 'research', title: 'Research', role: 'researcher' },
          { key: 'build', title: 'Build', role: 'builder', dependsOn: ['research'] },
        ],
      },
    }
    const invalidScenarioDefinition = structuredClone(scenarioDefinition)
    invalidScenarioDefinition.singleAgentPlan.tasks.push({
      key: 'extra',
      title: 'Extra',
      role: 'builder',
    })
    const invalidScenarioVersion = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project/evaluation-scenarios/' +
      'evaluation_scenario_api/versions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'user_api',
        },
        body: JSON.stringify({ definition: invalidScenarioDefinition }),
      },
    )
    assert.equal(invalidScenarioVersion.status, 400)

    const scenarioVersion = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project/evaluation-scenarios/' +
      'evaluation_scenario_api/versions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'user_api',
        },
        body: JSON.stringify({
          versionId: 'evaluation_scenario_version_api',
          definition: scenarioDefinition,
        }),
      },
    )
    assert.equal(scenarioVersion.status, 201)

    const experiment = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project/evaluation-experiments',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'user_api',
        },
        body: JSON.stringify({
          experimentId: 'evaluation_experiment_api',
          scenarioVersionId: 'evaluation_scenario_version_api',
          name: 'Single vs multi Agent',
          repetitions: 1,
        }),
      },
    )
    assert.equal(experiment.status, 201)

    const scenarioVersions = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project/evaluation-scenario-versions',
      { headers: { 'x-actor-id': 'user_api' } },
    )
    assert.equal(scenarioVersions.status, 200)
    assert.equal((await scenarioVersions.json()).scenarioVersions[0].singleAgentTaskCount, 1)

    const experimentList = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project/evaluation-experiments',
      { headers: { 'x-actor-id': 'user_api' } },
    )
    assert.equal(experimentList.status, 200)
    assert.equal((await experimentList.json()).experiments[0].id, 'evaluation_experiment_api')

    const evaluationReport = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project/evaluation-experiments/' +
      'evaluation_experiment_api/report',
      { headers: { 'x-actor-id': 'user_api' } },
    )
    assert.equal(evaluationReport.status, 200)
    assert.equal((await evaluationReport.json()).pairedTrials, 0)

    const foreignProjectReport = await fetch(
      baseUrl + '/api/v1/workspaces/ws/projects/project_foreign/evaluation-experiments/' +
      'evaluation_experiment_api/report',
      { headers: { 'x-actor-id': 'user_api' } },
    )
    assert.equal(foreignProjectReport.status, 404)

    const artifact = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/artifacts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({ artifactId: 'artifact_api', title: 'Shared report' }),
    })
    assert.equal(artifact.status, 201)
    assert.equal((await artifact.json()).id, 'artifact_api')

    const updated = await fetch(baseUrl + '/api/v1/workspaces/ws/artifacts/artifact_api/updates', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({
        update: Buffer.from([1, 2, 3]).toString('base64url'),
        sessionId: 'session_api',
      }),
    })
    assert.equal(updated.status, 202)
    assert.equal((await updated.json()).seq, '7')

    const sync = await fetch(baseUrl + '/api/v1/workspaces/ws/artifacts/artifact_api/sync', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(sync.status, 200)
    assert.equal((await sync.json()).update, Buffer.from([1, 2, 3]).toString('base64url'))

    const frozen = await fetch(baseUrl + '/api/v1/workspaces/ws/artifacts/artifact_api/versions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({ versionId: 'artifact_version_api' }),
    })
    assert.equal(frozen.status, 201)
    assert.equal((await frozen.json()).throughUpdateSeq, '7')

    const version = await fetch(baseUrl + '/api/v1/workspaces/ws/artifact-versions/artifact_version_api', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(version.status, 200)
    assert.equal((await version.json()).contentHash, 'content_hash')

    const submitted = await fetch(
      baseUrl + '/api/v1/workspaces/ws/missions/mission_created/tasks/task_api/submissions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': 'builder_api',
          'x-actor-kind': 'agent',
        },
        body: JSON.stringify({
          artifactVersionId: 'artifact_version_api',
          runId: 'run_api',
          note: 'Review this.',
        }),
      },
    )
    assert.equal(submitted.status, 201)
    assert.equal((await submitted.json()).id, 'submission_api')

    const reviewed = await fetch(baseUrl + '/api/v1/workspaces/ws/submissions/submission_api/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'user_api',
      },
      body: JSON.stringify({
        reviewId: 'review_api',
        decision: 'approved',
        summary: 'Looks good.',
        findings: [],
      }),
    })
    assert.equal(reviewed.status, 200)
    assert.equal((await reviewed.json()).review.status, 'approved')

    const retriedReview = await fetch(baseUrl + '/api/v1/workspaces/ws/reviews/review_api/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'user_api' },
      body: JSON.stringify({ reason: 'Retry after deploying a bounded prompt projection.' }),
    })
    assert.equal(retriedReview.status, 200)
    assert.equal((await retriedReview.json()).maxAttempts, 4)

    const submission = await fetch(baseUrl + '/api/v1/workspaces/ws/submissions/submission_api', {
      headers: { 'x-actor-id': 'user_api' },
    })
    assert.equal(submission.status, 200)
    assert.equal((await submission.json()).submission.id, 'submission_api')
  })

  assert.deepEqual(fake.calls.map(([kind]) => kind), ['create', 'plan', 'approve', 'approve-delivery', 'get'])
  assert.equal(fake.calls[1][1].actor.kind, 'agent')
  assert.deepEqual(runtime.calls.map(([kind]) => kind), ['control', 'tool_approval'])
  assert.equal(reviewerExecutions.calls[0].reviewId, 'review_api')
  assert.equal(runtime.calls[0][1].dedupeKey, 'steer_once')
  assert.deepEqual(artifacts.calls.map(([kind]) => kind), [
    'artifact.create',
    'artifact.update',
    'artifact.sync',
    'artifact.version',
    'artifact.read_version',
  ])
  assert.deepEqual(reviews.calls.map(([kind]) => kind), [
    'review.submit',
    'review.decide',
    'review.get',
  ])
  assert.deepEqual(skills.calls.map(([kind]) => kind), [
    'skill.create',
    'skill.version',
    'skill.assign',
    'skill.list',
  ])
  assert.deepEqual(evaluations.calls.map(([kind]) => kind), [
    'evaluation.scenario',
    'evaluation.version',
    'evaluation.experiment',
    'evaluation.versions.list',
    'evaluation.experiments.list',
    'evaluation.report',
    'evaluation.report',
  ])
  assert.equal(development.calls.length, 1)
  assert.equal(development.calls[0].workspaceName, 'Agent 实验室')
  assert.deepEqual([...artifacts.calls[1][1].update], [1, 2, 3])
  assert.deepEqual(artifacts.calls[1][1].origin, {
    kind: 'user',
    userId: 'user_api',
    sessionId: 'session_api',
  })
})

import {
  type ConversationPlanningRepository,
  type MissionRepository,
} from '@runguild/database'
import type { ConversationRepository } from '@runguild/database'
import {
  validateMissionPlan,
  type AgentId,
  type ConversationPlanRequestedInboxPayload,
  type CorrelationId,
  type MissionPlanDraft,
  type ModelAdapter,
  type ModelMessage,
  type ModelToolDefinition,
} from '@runguild/protocol'

export const MISSION_PLAN_TOOL_DEFINITION: ModelToolDefinition = {
  action: 'mission.propose_plan',
  description: 'Return the executable Mission plan as a validated dependency graph for human approval.',
  inputSchema: {
    type: 'object',
    required: ['summary', 'tasks'],
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 20_000 },
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: [
            'key', 'title', 'description', 'role', 'priority', 'dependsOn',
            'reviewRequired', 'acceptanceCriteria',
          ],
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 64 },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 20_000 },
            role: { enum: ['planner', 'researcher', 'builder', 'reviewer', 'custom'] },
            priority: { type: 'integer', minimum: 0, maximum: 1_000 },
            dependsOn: { type: 'array', maxItems: 100, items: { type: 'string' } },
            reviewRequired: { type: 'boolean' },
            acceptanceCriteria: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                required: ['key', 'description', 'required', 'evidenceKinds'],
                properties: {
                  key: { type: 'string', minLength: 1, maxLength: 64 },
                  description: { type: 'string', minLength: 1, maxLength: 2_000 },
                  required: { type: 'boolean' },
                  evidenceKinds: {
                    type: 'array',
                    maxItems: 20,
                    items: {
                      enum: [
                        'artifact_version', 'file_diff', 'git_commit', 'test_run',
                        'command_output', 'review', 'external_reference',
                      ],
                    },
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
}

type PlanningStore = Pick<
  ConversationPlanningRepository,
  'claim' | 'completeModel' | 'markAwaitingApproval' | 'fail'
>
type Missions = Pick<MissionRepository, 'proposePlan'>
type Conversations = Pick<ConversationRepository, 'postMessage'>

export interface ConversationPlannerDependencies {
  readonly planning: PlanningStore
  readonly missions: Missions
  readonly conversations: Conversations
  readonly modelFor: (provider: string, model: string) => ModelAdapter
  readonly leaseSeconds?: number
}

export function planningMessages(input: {
  readonly missionTitle: string
  readonly missionGoal: string
  readonly missionConstraints: readonly unknown[]
  readonly conversationTitle: string
  readonly sourceMessages: readonly {
    readonly id: string
    readonly authorKind: string
    readonly authorName: string
    readonly body: string
  }[]
}): readonly ModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are the persistent Planner Agent in a verifiable software-delivery workspace.',
        'Turn the selected conversation into a small but complete executable DAG, not a prose-only answer.',
        'Every Task must have one specialist role, explicit dependencies, and evidence-based acceptance criteria.',
        'Use researcher only when uncertainty requires investigation and builder for implementation.',
        'Represent independent approval of a producing Task with reviewRequired=true. Do not create a reviewer-role DAG Task solely to approve its dependency; Submission review is a separate gate.',
        'Do not claim work is complete. Call mission.propose_plan exactly once with the proposed graph.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Conversation: ' + input.conversationTitle,
        'Mission title: ' + input.missionTitle,
        'Mission goal: ' + input.missionGoal,
        'Mission constraints: ' + JSON.stringify(input.missionConstraints),
        '',
        'Selected source messages:',
        ...input.sourceMessages.map((message) =>
          '- [' + message.id + '] ' + message.authorName + ' (' + message.authorKind + '): ' + message.body),
        '',
        'Produce the minimum complete DAG that can satisfy the goal. Avoid ceremonial Tasks.',
      ].join('\n'),
    },
  ]
}

function planFromResponse(response: Awaited<ReturnType<ModelAdapter['complete']>>): MissionPlanDraft {
  const calls = response.toolCalls.filter((call) => call.action === 'mission.propose_plan')
  if (calls.length !== 1 || response.toolCalls.length !== 1) {
    throw new Error('Planner must call mission.propose_plan exactly once')
  }
  const plan = calls[0]!.input as MissionPlanDraft
  const validation = validateMissionPlan(plan)
  if (!validation.valid) {
    throw new Error('Planner returned an invalid DAG: ' + validation.errors.map((error) => error.path + ' ' + error.message).join('; '))
  }
  return plan
}

export class ConversationPlanner {
  private readonly leaseSeconds: number

  constructor(private readonly dependencies: ConversationPlannerDependencies) {
    this.leaseSeconds = dependencies.leaseSeconds ?? 300
  }

  async process(payload: ConversationPlanRequestedInboxPayload, plannerAgentId: AgentId): Promise<void> {
    const claimed = await this.dependencies.planning.claim({
      requestId: payload.requestId,
      plannerAgentId,
      leaseSeconds: this.leaseSeconds,
    })
    if (claimed.kind === 'terminal') return
    if (claimed.kind === 'busy') {
      throw new Error('Conversation Planning Request is leased; retry after ' + claimed.retryAfterMs + ' ms')
    }
    const work = claimed.work
    let plan = work.storedPlan
    try {
      if (plan === undefined) {
        const messages = planningMessages(work)
        const model = this.dependencies.modelFor(work.modelProvider, work.modelName)
        const startedAt = Date.now()
        const response = await model.complete({
          messages,
          tools: [MISSION_PLAN_TOOL_DEFINITION],
        })
        plan = planFromResponse(response)
        await this.dependencies.planning.completeModel({
          requestId: work.request.id,
          plannerAgentId,
          leaseToken: work.leaseToken,
          plan,
          promptSnapshot: { schemaVersion: 1, messages, tools: [MISSION_PLAN_TOOL_DEFINITION] },
          responseSnapshot: {
            finishReason: response.finishReason,
            content: response.content,
            toolCalls: response.toolCalls,
          },
          modelProvider: model.provider,
          modelName: model.model,
          ...(response.providerRequestId === undefined ? {} : { providerRequestId: response.providerRequestId }),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          ...(response.usage.estimatedCostUsd === undefined
            ? {}
            : { estimatedCostUsd: response.usage.estimatedCostUsd }),
          latencyMs: Math.max(0, Date.now() - startedAt),
        })
      }

      const proposed = await this.dependencies.missions.proposePlan({
        workspaceId: work.request.workspaceId,
        missionId: work.request.missionId,
        plan,
        actor: { kind: 'agent', id: plannerAgentId },
        correlationId: ('conversation_planning_' + work.request.id) as CorrelationId,
      })
      if (!proposed.proposed) {
        throw new Error('Mission rejected the Planner proposal: ' + proposed.reason)
      }
      await this.dependencies.conversations.postMessage({
        workspaceId: work.request.workspaceId,
        conversationId: work.request.conversationId,
        author: { kind: 'agent', id: plannerAgentId },
        body: [
          '规划已完成，等待人工批准。',
          plan.summary,
          'DAG 共 ' + plan.tasks.length + ' 个任务：' + plan.tasks.map((task) => task.title).join(' → '),
        ].join('\n\n'),
        entityRefs: { missionId: work.request.missionId },
        idempotencyKey: 'planning-summary:' + work.request.id,
        correlationId: ('conversation_planning_summary_' + work.request.id) as CorrelationId,
      })
      await this.dependencies.planning.markAwaitingApproval({
        requestId: work.request.id,
        plannerAgentId,
        leaseToken: work.leaseToken,
        planVersion: proposed.version,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = await this.dependencies.planning.fail({
        requestId: work.request.id,
        plannerAgentId,
        leaseToken: work.leaseToken,
        message,
      })
      if (failed.retryable) throw error
      await this.dependencies.conversations.postMessage({
        workspaceId: work.request.workspaceId,
        conversationId: work.request.conversationId,
        author: { kind: 'agent', id: plannerAgentId },
        body: '规划失败，已停止自动重试。\n\n' + message,
        entityRefs: { missionId: work.request.missionId },
        idempotencyKey: 'planning-failed:' + work.request.id,
        correlationId: ('conversation_planning_failed_' + work.request.id) as CorrelationId,
      })
    }
  }
}

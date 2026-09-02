import { randomUUID } from 'node:crypto'

// Merge-resolved: this file preserves both the base app wiring and the
// Task-introduced project-scoped Run Trace list/detail routes (run-traces).
import {
  AGENT_ROLES,
  CONVERSATION_KINDS,
  EVIDENCE_KINDS,
  type ActorRef,
  type AgentId,
  type ApprovalId,
  type ArtifactId,
  type ArtifactVersionId,
  type CorrelationId,
  type ConversationId,
  type ConversationPlanningRequestId,
  type EvidenceId,
  type EvaluationExperimentId,
  type EvaluationScenarioDefinition,
  type EvaluationScenarioId,
  type EvaluationScenarioVersionId,
  type MissionId,
  type MessageId,
  type MissionPlanDraft,
  type ProjectId,
  type ReviewId,
  type RunControlRequestId,
  type RunId,
  type SkillId,
  type SkillVersionId,
  type TaskId,
  type TaskSubmissionId,
  type ToolCallId,
  type UserId,
  type WorkspaceId,
  validateEvaluationScenario,
} from '@runguild/protocol'
import {
  ArtifactNotFoundError,
  type ArtifactRepository,
} from '@runguild/collaboration'
import {
  ConversationAccessError,
  ConversationPlanningError,
  ConversationNotFoundError,
  ConversationScopeError,
  type ConversationRepository,
  type ConversationPlanningRepository,
  type MissionRepository,
  type DevelopmentSetupRepository,
  type ProjectOperatorRepository,
  type ProjectRuntimeConfigRepository,
  type EvaluationExperimentSnapshot,
  type EvaluationRepository,
  type RuntimeRepository,
  type ReviewRepository,
  type RunTraceRepository,
  type ReviewerExecutionRepository,
  type SkillRepository,
  type TaskRepository,
  type ToolExecutionRepository,
  type WorktreeSetupRepository,
} from '@runguild/database'
// Run Trace services are injected here; only project-scoped redacted summaries are exposed.
// listRecentRuns/getRun join agent_runs→tasks→missions and never return keys or raw model bodies.
import { buildEvaluationReport } from '@runguild/evaluation'
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'

import {
  AuthenticationError,
  type RequestAuthentication,
  type SessionAuthentication,
} from './authentication.js'
import type { LocalRuntimeControl, LocalWorkerCommand } from './local-worker-supervisor.js'

type MissionService = Pick<
  MissionRepository,
  'createMission' | 'proposePlan' | 'approvePlan' | 'approveDelivery' | 'getMission'
>

type DevelopmentSetupService = Pick<DevelopmentSetupRepository, 'bootstrap'>
type ProjectOperatorService = Pick<ProjectOperatorRepository, 'getOverview'>
type ProjectRuntimeConfigService = Pick<ProjectRuntimeConfigRepository, 'get' | 'update'>
type WorktreeSetupService = Pick<WorktreeSetupRepository, 'listRecentForProject'>

type ConversationService = Pick<
  ConversationRepository,
  'create' | 'listProject' | 'listMessages' | 'postMessage'
>
type ConversationPlanningService = Pick<ConversationPlanningRepository, 'create' | 'get'>

type RunControlService = Pick<RuntimeRepository, 'createControl'>
type TaskControlService = Pick<TaskRepository, 'retryFailedTask'>
type ToolApprovalService = Pick<ToolExecutionRepository, 'resolveApproval'>
type ReviewService = Pick<ReviewRepository, 'submitArtifactVersion' | 'reviewSubmission' | 'getSubmission'>
type ReviewerExecutionControlService = Pick<ReviewerExecutionRepository, 'retryFailed'>
type SkillService = Pick<SkillRepository, 'create' | 'createVersion' | 'assign' | 'listForAgent'>
type EvaluationService = Pick<
  EvaluationRepository,
  'createExperiment' | 'createScenario' | 'createScenarioVersion' | 'getExperiment' |
  'listExperiments' | 'listScenarioVersions'
>
type RunTraceService = Pick<RunTraceRepository, 'listRecentRuns' | 'getRun'>
type ArtifactService = Pick<
  ArtifactRepository,
  'authorizeActor' | 'create' | 'listProject' | 'getProjectArtifact' | 'appendUpdate' |
    'syncState' | 'createVersion' | 'readVersion'
>

export interface ApiDependencies {
  readonly missions: MissionService
  readonly projectOperator: ProjectOperatorService
  readonly projectRuntimeConfigs: ProjectRuntimeConfigService
  readonly worktreeSetups?: WorktreeSetupService
  readonly conversations: ConversationService
  readonly conversationPlanning: ConversationPlanningService
  readonly runControls: RunControlService
  readonly taskControls: TaskControlService
  readonly toolApprovals: ToolApprovalService
  readonly artifacts: ArtifactService
  readonly reviews: ReviewService
  readonly reviewerExecutions: ReviewerExecutionControlService
  readonly skills: SkillService
  readonly evaluations: EvaluationService
  readonly runTraces: RunTraceService
  readonly developmentSetup?: DevelopmentSetupService
  readonly localRuntimeControl?: LocalRuntimeControl
  readonly authentication?: SessionAuthentication
  readonly healthcheck?: () => Promise<void>
}

export interface CreateApiAppOptions {
  readonly allowInsecureActorHeaders?: boolean
  readonly authenticationMode?: 'local' | 'team'
  readonly defaultWorkspaceId?: string
  readonly localUserId?: string
}

const idSchema = z.string().min(1).max(200)
const evidenceKindSchema = z.enum(EVIDENCE_KINDS)
const roleSchema = z.enum(AGENT_ROLES)
const conversationKindSchema = z.enum(CONVERSATION_KINDS)

const developmentBootstrapSchema = z.object({
  workspaceId: idSchema.default('demo_workspace'),
  workspaceName: z.string().min(1).max(200).default('Agent 实验室'),
  projectId: idSchema.default('demo_project'),
  projectName: z.string().min(1).max(200).default('RunGuild 演示项目'),
  userId: idSchema.default('demo_user'),
  displayName: z.string().min(1).max(200).default('本地开发者'),
})

const signInSchema = z.object({
  workspaceId: idSchema.optional(),
  userId: idSchema,
  password: z.string().min(1).max(1_024),
})

const criterionSchema = z.object({
  key: z.string().min(1).max(64),
  description: z.string().min(1).max(2_000),
  required: z.boolean().default(true),
  evidenceKinds: z.array(evidenceKindSchema).max(20).default([]),
})

const plannedTaskSchema = z.object({
  key: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(''),
  role: roleSchema,
  priority: z.number().int().min(0).max(1_000).default(100),
  dependsOn: z.array(z.string().min(1).max(64)).max(100).default([]),
  reviewRequired: z.boolean().default(true),
  acceptanceCriteria: z.array(criterionSchema).max(100).default([]),
})

const createMissionSchema = z.object({
  conversationId: idSchema.optional(),
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(20_000),
  constraints: z.array(z.string().max(2_000)).max(100).default([]),
  acceptanceCriteria: z.array(z.string().max(2_000)).max(100).default([]),
})

const retryTaskSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
})

const createConversationSchema = z.object({
  kind: conversationKindSchema.default('group'),
  title: z.string().min(1).max(200),
  members: z.array(z.object({
    kind: z.enum(['user', 'agent']),
    id: idSchema,
  })).min(1).max(100),
})

const listMessagesQuerySchema = z.object({
  beforeSequence: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const postMessageSchema = z.object({
  body: z.string().min(1).max(65_536),
  mentions: z.array(idSchema).max(32).default([]),
  replyToMessageId: idSchema.optional(),
  entityRefs: z.object({
    missionId: idSchema.optional(),
    taskId: idSchema.optional(),
    runId: idSchema.optional(),
    artifactId: idSchema.optional(),
  }).default({}),
})

const createConversationPlanningSchema = z.object({
  sourceMessageIds: z.array(idSchema).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Source messages must be unique'),
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(20_000).optional(),
  plannerAgentId: idSchema.optional(),
})

const planSchema = z.object({
  summary: z.string().min(1).max(20_000),
  tasks: z.array(plannedTaskSchema).min(1).max(100),
})

const approveSchema = z.object({
  expectedVersion: z.number().int().positive(),
})

const approveMissionDeliverySchema = z.object({
  expectedArtifactVersionId: idSchema,
})

const controlSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('steer'),
    message: z.string().min(1).max(20_000),
    dedupeKey: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal('cancel'),
    reason: z.string().min(1).max(2_000).optional(),
    dedupeKey: z.string().min(1).max(200).optional(),
  }),
])

const resolveToolApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
})

const base64UrlSchema = z.string().min(1).max(1_400_000).regex(/^[A-Za-z0-9_-]+$/)
const stateVectorSchema = z.string().min(1).max(90_000).regex(/^[A-Za-z0-9_-]+$/)

const createArtifactSchema = z.object({
  artifactId: idSchema.optional(),
  missionId: idSchema.optional(),
  title: z.string().min(1).max(200),
  kind: z.string().min(1).max(64).optional(),
})

const listArtifactsQuerySchema = z.object({
  missionId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const appendArtifactUpdateSchema = z.object({
  update: base64UrlSchema,
  sessionId: z.string().min(1).max(200).optional(),
  runId: idSchema.optional(),
  taskId: idSchema.optional(),
  toolCallId: idSchema.optional(),
  intent: z.string().min(1).max(2_000).optional(),
})

const createArtifactVersionSchema = z.object({
  versionId: idSchema.optional(),
  runId: idSchema.optional(),
  xmlFragment: z.string().min(1).max(100).optional(),
})

const submitArtifactVersionSchema = z.object({
  artifactVersionId: idSchema,
  runId: idSchema,
  note: z.string().max(10_000).optional(),
})

const reviewFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  summary: z.string().min(1).max(10_000),
  evidenceIds: z.array(idSchema).max(100).optional(),
})

const reviewSubmissionSchema = z.object({
  reviewId: idSchema.optional(),
  runId: idSchema.optional(),
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  summary: z.string().min(1).max(20_000),
  findings: z.array(reviewFindingSchema).max(200).default([]),
})

const createSkillSchema = z.object({
  skillId: idSchema.optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
})

const createSkillVersionSchema = z.object({
  versionId: idSchema.optional(),
  instructions: z.string().min(1).max(65_536),
})

const assignSkillSchema = z.object({
  pinnedVersionId: idSchema.nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
})

const createEvaluationScenarioSchema = z.object({
  scenarioId: idSchema.optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(4_000).optional(),
})

const evaluationScenarioDefinitionSchema = z.object({
  goal: z.string().min(1).max(20_000),
  constraints: z.array(z.string().min(1).max(2_000)).max(100).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(100).default([]),
  baselineCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  singleAgentPlan: planSchema,
  multiAgentPlan: planSchema,
}).superRefine((definition, context) => {
  const validation = validateEvaluationScenario(definition as EvaluationScenarioDefinition)
  for (const error of validation.errors) {
    context.addIssue({
      code: 'custom',
      path: error.path.split('.'),
      message: error.message,
    })
  }
})

const createEvaluationScenarioVersionSchema = z.object({
  versionId: idSchema.optional(),
  definition: evaluationScenarioDefinitionSchema,
})

const createEvaluationExperimentSchema = z.object({
  experimentId: idSchema.optional(),
  scenarioVersionId: idSchema,
  name: z.string().min(1).max(200),
  repetitions: z.number().int().min(1).max(100),
  variants: z.array(z.enum(['single_agent', 'multi_agent'])).min(1).max(2)
    .refine((variants) => new Set(variants).size === variants.length, 'Variants must be unique')
    .optional(),
})

const updateProjectRuntimeConfigSchema = z.object({
  repositoryPath: z.string().min(1).max(4_096),
  defaultBranch: z.string().min(1).max(200),
  worktreeRoot: z.string().min(1).max(4_096),
  worktreeSetupCommands: z.array(z.array(z.string().min(1).max(1_000)).min(1).max(30)).max(20),
  worktreeSetupTimeoutMs: z.number().int().min(1_000).max(900_000),
  testCommands: z.array(z.array(z.string().min(1).max(1_000)).min(1).max(30)).min(1).max(50),
  agentContextInputTokens: z.number().int().min(256).max(2_000_000),
  agentMaxTestTimeoutMs: z.number().int().min(1_000).max(900_000),
  agentModels: z.array(z.object({
    agentId: idSchema,
    modelProvider: z.string().min(1).max(200),
    modelName: z.string().min(1).max(200),
  })).max(100),
})

const localWorkerCommandSchema = z.object({
  kind: z.enum(['scheduler', 'agent', 'integration', 'evaluation']),
  agentId: idSchema.optional(),
}).superRefine((command, context) => {
  if ((command.kind === 'agent') !== Boolean(command.agentId)) {
    context.addIssue({ code: 'custom', path: ['agentId'], message: 'Agent Worker requires exactly one agentId' })
  }
})

function correlationId(req: Request): CorrelationId {
  const header = req.header('x-correlation-id')
  return (header?.trim() || 'correlation_' + randomUUID()) as CorrelationId
}

type RequestActor = Extract<ActorRef, { readonly kind: 'user' | 'agent' }>

function requestAuthentication(res: Response): RequestAuthentication | null {
  return (res.locals.authentication as RequestAuthentication | undefined) ?? null
}

function requestActor(_req: Request, res: Response): RequestActor | null {
  const authentication = requestAuthentication(res)
  if (authentication) return authentication.actor
  res.status(401).json({ error: { code: 'authentication_required', message: '需要有效登录会话' } })
  return null
}

function insecureHeaderAuthentication(req: Request): RequestAuthentication | null {
  const value = req.header('x-actor-id')?.trim()
  const kind = req.header('x-actor-kind')?.trim() || 'user'
  if (!value || (kind !== 'user' && kind !== 'agent')) return null
  return kind === 'agent'
    ? { mode: 'agent_token', actor: { kind: 'agent', id: value as AgentId } }
    : {
        mode: 'session',
        actor: { kind: 'user', id: value as UserId },
        session: {
          id: 'insecure_header_test_session',
          workspaceId: (req.params.workspaceId ?? req.header('x-workspace-id') ?? '') as WorkspaceId,
          userId: value as UserId,
          displayName: value,
          role: 'owner',
          csrfTokenHash: '',
          credentialVersion: 1,
          createdAt: new Date(0),
          lastSeenAt: new Date(0),
          idleExpiresAt: new Date(8_640_000_000_000_000),
          expiresAt: new Date(8_640_000_000_000_000),
        },
      }
}

function workspaceIdFromPath(path: string): string | null {
  const encoded = /^\/workspaces\/([^/]+)(?:\/|$)/.exec(path)?.[1]
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return ''
  }
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

function route(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next)
  }
}

function invalidBody(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: {
      code: 'invalid_request',
      message: 'Request validation failed',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  })
}

export function createApiApp(dependencies: ApiDependencies, options: CreateApiAppOptions = {}) {
  const app = express()
  const authenticationMode = options.authenticationMode ?? 'team'
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    next()
  })
  app.use(express.json({ limit: '2mb' }))

  app.get('/health', route(async (_req, res) => {
    await dependencies.healthcheck?.()
    res.json({ status: 'ok' })
  }))

  app.get('/api/v1/auth/mode', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ mode: authenticationMode })
  })

  if (dependencies.developmentSetup) {
    app.post('/api/v1/development/bootstrap', route(async (req, res) => {
      const body = developmentBootstrapSchema.safeParse(req.body ?? {})
      if (!body.success) {
        invalidBody(res, body.error)
        return
      }
      const result = await dependencies.developmentSetup?.bootstrap({
        ...body.data,
        modelProvider: process.env.MODEL_PROVIDER?.trim() || 'openai',
        modelName: process.env.MODEL_NAME?.trim() || 'gpt-5.2',
      })
      res.json(result)
    }))
  }

  app.post('/api/v1/auth/login', route(async (req, res) => {
    if (!dependencies.authentication) {
      res.status(404).json({ error: { code: 'authentication_unavailable' } })
      return
    }
    if (!dependencies.authentication.originAllowed(req)) {
      res.status(403).json({ error: { code: 'origin_forbidden', message: '请求来源未获准' } })
      return
    }
    const body = signInSchema.safeParse(req.body ?? {})
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const workspaceId = body.data.workspaceId ?? options.defaultWorkspaceId
    if (!workspaceId) {
      res.status(400).json({ error: { code: 'workspace_not_configured', message: '服务器尚未配置默认工作区' } })
      return
    }
    const signedIn = await dependencies.authentication.signIn({ ...body.data, workspaceId, request: req })
    dependencies.authentication.setSessionCookies(res, {
      sessionToken: signedIn.sessionToken,
      csrfToken: signedIn.csrfToken,
      expiresAt: signedIn.authentication.session.expiresAt,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json(signedIn.view)
  }))

  app.post('/api/v1/auth/local', route(async (req, res) => {
    if (authenticationMode !== 'local') {
      res.status(404).json({ error: { code: 'local_authentication_unavailable' } })
      return
    }
    if (!dependencies.authentication || !options.defaultWorkspaceId || !options.localUserId) {
      res.status(503).json({ error: { code: 'local_authentication_not_configured' } })
      return
    }
    if (!dependencies.authentication.originAllowed(req)) {
      res.status(403).json({ error: { code: 'origin_forbidden', message: '请求来源未获准' } })
      return
    }
    const signedIn = await dependencies.authentication.signInLocal({
      workspaceId: options.defaultWorkspaceId,
      userId: options.localUserId,
      request: req,
    })
    dependencies.authentication.setSessionCookies(res, {
      sessionToken: signedIn.sessionToken,
      csrfToken: signedIn.csrfToken,
      expiresAt: signedIn.authentication.session.expiresAt,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json(signedIn.view)
  }))

  app.use('/api/v1', (req, res, next) => {
    void (async () => {
      const authentication = dependencies.authentication
        ? await dependencies.authentication.authenticateHttp(req)
        : options.allowInsecureActorHeaders ? insecureHeaderAuthentication(req) : null
      if (authentication) res.locals.authentication = authentication
      if (!authentication) {
        res.status(401).json({ error: { code: 'authentication_required', message: '需要有效登录会话' } })
        return
      }
      if (!dependencies.authentication && options.allowInsecureActorHeaders) {
        next()
        return
      }
      if (authentication.mode === 'session') {
        const workspaceId = workspaceIdFromPath(req.path)
        if (workspaceId !== null && workspaceId !== authentication.session.workspaceId) {
          res.status(404).json({ error: { code: 'resource_not_found' } })
          return
        }
        if (!isSafeMethod(req.method) && dependencies.authentication) {
          if (!dependencies.authentication.originAllowed(req)) {
            res.status(403).json({ error: { code: 'origin_forbidden', message: '请求来源未获准' } })
            return
          }
          if (!dependencies.authentication.verifyCsrf(req, authentication)) {
            res.status(403).json({ error: { code: 'csrf_invalid', message: 'CSRF 校验失败' } })
            return
          }
        }
        if (!isSafeMethod(req.method) && authentication.session.role === 'viewer'
            && req.path !== '/auth/logout') {
          res.status(403).json({ error: { code: 'read_only_role', message: '当前账号只有只读权限' } })
          return
        }
      }
      next()
    })().catch(next)
  })

  app.get('/api/v1/auth/session', route(async (_req, res) => {
    const authentication = requestAuthentication(res)
    if (!authentication || authentication.mode !== 'session' || !dependencies.authentication) {
      res.status(401).json({ error: { code: 'browser_session_required' } })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(await dependencies.authentication.sessionView(authentication.session))
  }))

  app.post('/api/v1/auth/logout', route(async (req, res) => {
    const authentication = requestAuthentication(res)
    if (!authentication || authentication.mode !== 'session' || !dependencies.authentication) {
      res.status(401).json({ error: { code: 'browser_session_required' } })
      return
    }
    await dependencies.authentication.signOut(authentication, req)
    dependencies.authentication.clearSessionCookies(res)
    res.setHeader('Cache-Control', 'no-store')
    res.status(204).end()
  }))

  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/operator-overview', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_operator_required' } })
      return
    }
    const overview = await dependencies.projectOperator.getOverview(
      idSchema.parse(req.params.workspaceId) as WorkspaceId,
      idSchema.parse(req.params.projectId) as ProjectId,
      actorRef.id,
    )
    if (!overview) {
      res.status(404).json({ error: { code: 'project_not_found_or_forbidden' } })
      return
    }
    res.json(overview)
  }))

  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/runtime-config', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_runtime_configuration_required' } })
      return
    }
    const configuration = await dependencies.projectRuntimeConfigs.get(
      idSchema.parse(req.params.workspaceId) as WorkspaceId,
      idSchema.parse(req.params.projectId) as ProjectId,
      actorRef.id,
    )
    if (!configuration) {
      res.status(404).json({ error: { code: 'project_not_found_or_forbidden' } })
      return
    }
    res.json({
      configuration,
      recentSetups: dependencies.worktreeSetups
        ? await dependencies.worktreeSetups.listRecentForProject({
            workspaceId: configuration.project.workspaceId,
            projectId: configuration.project.id,
            limit: 10,
          })
        : [],
      control: dependencies.localRuntimeControl?.capabilities(configuration) ?? {
        enabled: false,
        reason: 'local_runtime_control_disabled',
        workers: [],
      },
    })
  }))

  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/run-traces', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_run_trace_required' } })
      return
    }
    const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit ?? 20)
    const runs = await dependencies.runTraces.listRecentRuns({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      projectId: idSchema.parse(req.params.projectId) as ProjectId,
      actorId: actorRef.id,
    }, limit)
    res.json({ runs })
  }))

  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/run-traces/:runId', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_run_trace_required' } })
      return
    }
    const run = await dependencies.runTraces.getRun({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      projectId: idSchema.parse(req.params.projectId) as ProjectId,
      actorId: actorRef.id,
    }, idSchema.parse(req.params.runId) as RunId)
    if (!run) {
      res.status(404).json({ error: { code: 'run_not_found_or_forbidden' } })
      return
    }
    res.json({ run })
  }))

  app.put('/api/v1/workspaces/:workspaceId/projects/:projectId/runtime-config', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_runtime_configuration_required' } })
      return
    }
    const body = updateProjectRuntimeConfigSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    try {
      const configuration = await dependencies.projectRuntimeConfigs.update({
        workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
        projectId: idSchema.parse(req.params.projectId) as ProjectId,
        userId: actorRef.id,
        ...body.data,
        agentModels: body.data.agentModels.map((model) => ({
          ...model,
          agentId: model.agentId as AgentId,
        })),
      })
      res.json({
        configuration,
        recentSetups: dependencies.worktreeSetups
          ? await dependencies.worktreeSetups.listRecentForProject({
              workspaceId: configuration.project.workspaceId,
              projectId: configuration.project.id,
              limit: 10,
            })
          : [],
        control: dependencies.localRuntimeControl?.capabilities(configuration) ?? {
          enabled: false,
          reason: 'local_runtime_control_disabled',
          workers: [],
        },
      })
    } catch (error) {
      res.status(422).json({
        error: {
          code: 'runtime_configuration_invalid',
          message: error instanceof Error ? error.message : 'Runtime configuration is invalid',
        },
      })
    }
  }))

  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/local-workers/start', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_local_worker_control_required' } })
      return
    }
    if (!dependencies.localRuntimeControl) {
      res.status(404).json({ error: { code: 'local_runtime_control_disabled' } })
      return
    }
    const body = localWorkerCommandSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const configuration = await dependencies.projectRuntimeConfigs.get(
      idSchema.parse(req.params.workspaceId) as WorkspaceId,
      idSchema.parse(req.params.projectId) as ProjectId,
      actorRef.id,
    )
    if (!configuration) {
      res.status(404).json({ error: { code: 'project_not_found_or_forbidden' } })
      return
    }
    try {
      const command = {
        kind: body.data.kind,
        ...(body.data.agentId === undefined ? {} : { agentId: body.data.agentId as AgentId }),
      } as LocalWorkerCommand
      res.status(202).json(await dependencies.localRuntimeControl.start(command, configuration))
    } catch (error) {
      res.status(422).json({
        error: {
          code: 'local_worker_start_rejected',
          message: error instanceof Error ? error.message : 'Local Worker could not be started',
        },
      })
    }
  }))

  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/local-workers/stop', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_local_worker_control_required' } })
      return
    }
    if (!dependencies.localRuntimeControl) {
      res.status(404).json({ error: { code: 'local_runtime_control_disabled' } })
      return
    }
    const body = localWorkerCommandSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const configuration = await dependencies.projectRuntimeConfigs.get(
      idSchema.parse(req.params.workspaceId) as WorkspaceId,
      idSchema.parse(req.params.projectId) as ProjectId,
      actorRef.id,
    )
    if (!configuration) {
      res.status(404).json({ error: { code: 'project_not_found_or_forbidden' } })
      return
    }
    const command = {
      kind: body.data.kind,
      ...(body.data.agentId === undefined ? {} : { agentId: body.data.agentId as AgentId }),
    } as LocalWorkerCommand
    res.json(await dependencies.localRuntimeControl.stop(command, configuration))
  }))

  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/conversations', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_conversation_management_required' } })
      return
    }
    const body = createConversationSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const conversation = await dependencies.conversations.create({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      projectId: idSchema.parse(req.params.projectId) as ProjectId,
      kind: body.data.kind,
      title: body.data.title,
      members: body.data.members,
      actor: actorRef,
      correlationId: correlationId(req),
    })
    res.status(201).json(conversation)
  }))

  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/conversations', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const conversations = await dependencies.conversations.listProject(
      idSchema.parse(req.params.workspaceId) as WorkspaceId,
      idSchema.parse(req.params.projectId) as ProjectId,
      actorRef,
    )
    res.json({ conversations })
  }))

  app.get('/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const query = listMessagesQuerySchema.safeParse(req.query)
    if (!query.success) {
      invalidBody(res, query.error)
      return
    }
    const messages = await dependencies.conversations.listMessages({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      conversationId: idSchema.parse(req.params.conversationId) as ConversationId,
      actor: actorRef,
      ...(query.data.beforeSequence === undefined ? {} : { beforeSequence: query.data.beforeSequence }),
      limit: query.data.limit,
    })
    res.json({ messages })
  }))

  app.post('/api/v1/workspaces/:workspaceId/conversations/:conversationId/messages', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const body = postMessageSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const refs = body.data.entityRefs
    const result = await dependencies.conversations.postMessage({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      conversationId: idSchema.parse(req.params.conversationId) as ConversationId,
      author: actorRef,
      body: body.data.body,
      mentions: body.data.mentions as AgentId[],
      entityRefs: {
        ...(refs.missionId === undefined ? {} : { missionId: refs.missionId as MissionId }),
        ...(refs.taskId === undefined ? {} : { taskId: refs.taskId as TaskId }),
        ...(refs.runId === undefined ? {} : { runId: refs.runId as RunId }),
        ...(refs.artifactId === undefined ? {} : { artifactId: refs.artifactId as ArtifactId }),
      },
      ...(body.data.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: body.data.replyToMessageId as MessageId }),
      ...(req.header('x-idempotency-key')?.trim()
        ? { idempotencyKey: req.header('x-idempotency-key')!.trim() }
        : {}),
      correlationId: correlationId(req),
    })
    res.status(result.reused ? 200 : 201).json(result)
  }))

  app.post('/api/v1/workspaces/:workspaceId/conversations/:conversationId/planning-requests', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_planning_request_required' } })
      return
    }
    const body = createConversationPlanningSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const result = await dependencies.conversationPlanning.create({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      conversationId: idSchema.parse(req.params.conversationId) as ConversationId,
      sourceMessageIds: body.data.sourceMessageIds as MessageId[],
      title: body.data.title,
      ...(body.data.goal === undefined ? {} : { goal: body.data.goal }),
      ...(body.data.plannerAgentId === undefined
        ? {}
        : { plannerAgentId: body.data.plannerAgentId as AgentId }),
      createdBy: actorRef.id,
      correlationId: correlationId(req),
      ...(req.header('x-idempotency-key')?.trim()
        ? { idempotencyKey: req.header('x-idempotency-key')!.trim() }
        : {}),
    })
    res.status(result.reused ? 200 : 201).json(result)
  }))

  app.get('/api/v1/workspaces/:workspaceId/conversation-planning-requests/:requestId', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const request = await dependencies.conversationPlanning.get(
      idSchema.parse(req.params.workspaceId) as WorkspaceId,
      idSchema.parse(req.params.requestId) as ConversationPlanningRequestId,
      actorRef,
    )
    if (!request) {
      res.status(404).json({ error: { code: 'conversation_planning_request_not_found' } })
      return
    }
    res.json(request)
  }))

  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/missions', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const body = createMissionSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    const projectId = idSchema.parse(req.params.projectId) as ProjectId
    const missionId = await dependencies.missions.createMission({
      workspaceId,
      projectId,
      ...(body.data.conversationId === undefined ? {} : { conversationId: body.data.conversationId }),
      title: body.data.title,
      goal: body.data.goal,
      constraints: body.data.constraints,
      acceptanceCriteria: body.data.acceptanceCriteria,
      actor: actorRef,
      correlationId: correlationId(req),
    })
    res.status(201).json({ missionId })
  }))

  app.post('/api/v1/workspaces/:workspaceId/missions/:missionId/plan', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const body = planSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const result = await dependencies.missions.proposePlan({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      missionId: idSchema.parse(req.params.missionId) as MissionId,
      plan: body.data as MissionPlanDraft,
      actor: actorRef,
      correlationId: correlationId(req),
    })
    if (!result.proposed) {
      res.status(result.reason === 'invalid_plan' ? 422 : 409).json({ error: result })
      return
    }
    res.status(result.reused ? 200 : 201).json(result)
  }))

  app.post('/api/v1/workspaces/:workspaceId/missions/:missionId/plan/approve', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_approval_required' } })
      return
    }
    const body = approveSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const result = await dependencies.missions.approvePlan({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      missionId: idSchema.parse(req.params.missionId) as MissionId,
      expectedVersion: body.data.expectedVersion,
      approvedBy: actorRef.id,
      correlationId: correlationId(req),
    })
    if (!result.approved) {
      res.status(409).json({ error: result })
      return
    }
    res.json(result)
  }))

  app.post('/api/v1/workspaces/:workspaceId/missions/:missionId/delivery/approve', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_approval_required' } })
      return
    }
    const body = approveMissionDeliverySchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const result = await dependencies.missions.approveDelivery({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      missionId: idSchema.parse(req.params.missionId) as MissionId,
      expectedArtifactVersionId: body.data.expectedArtifactVersionId as ArtifactVersionId,
      approvedBy: actorRef.id,
      correlationId: correlationId(req),
    })
    if (!result.approved) {
      res.status(409).json({ error: result })
      return
    }
    res.json(result)
  }))

  app.get('/api/v1/workspaces/:workspaceId/missions/:missionId', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const mission = await dependencies.missions.getMission(
      idSchema.parse(req.params.workspaceId) as WorkspaceId,
      idSchema.parse(req.params.missionId) as MissionId,
    )
    if (!mission) {
      res.status(404).json({ error: { code: 'mission_not_found' } })
      return
    }
    res.json(mission)
  }))

  app.post('/api/v1/workspaces/:workspaceId/missions/:missionId/tasks/:taskId/retry', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_task_retry_required' } })
      return
    }
    const body = retryTaskSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const result = await dependencies.taskControls.retryFailedTask({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      missionId: idSchema.parse(req.params.missionId) as MissionId,
      taskId: idSchema.parse(req.params.taskId) as TaskId,
      requestedBy: actorRef.id,
      reason: body.data.reason,
      correlationId: ('task_retry_' + randomUUID()) as CorrelationId,
    })
    if (!result.retried) {
      const status = result.reason === 'not_found_or_forbidden' ? 404 : 409
      res.status(status).json({ error: { code: 'task_retry_rejected', reason: result.reason } })
      return
    }
    res.json(result)
  }))

  app.post('/api/v1/workspaces/:workspaceId/runs/:runId/controls', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_control_required' } })
      return
    }
    const body = controlSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const runId = idSchema.parse(req.params.runId) as RunId
    const controlId = ('control_' + randomUUID()) as RunControlRequestId
    const payload = body.data.kind === 'steer'
      ? { message: body.data.message }
      : { reason: body.data.reason ?? 'Cancelled by human operator.' }
    const id = await dependencies.runControls.createControl({
      id: controlId,
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      runId,
      kind: body.data.kind,
      payload,
      createdBy: actorRef.id,
      dedupeKey: body.data.dedupeKey
        ?? req.header('x-idempotency-key')?.trim()
        ?? controlId,
    })
    res.status(202).json({ controlId: id })
  }))

  app.post('/api/v1/workspaces/:workspaceId/tool-approvals/:approvalId/resolve', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_approval_required' } })
      return
    }
    const body = resolveToolApprovalSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const resolved = await dependencies.toolApprovals.resolveApproval({
      approvalId: idSchema.parse(req.params.approvalId) as ApprovalId,
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      resolvedBy: actorRef.id,
      decision: body.data.decision,
    })
    if (!resolved) {
      res.status(409).json({ error: { code: 'approval_not_pending' } })
      return
    }
    res.json({ resolved: true, decision: body.data.decision })
  }))

  app.post('/api/v1/workspaces/:workspaceId/skills', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_skill_management_required' } })
      return
    }
    const body = createSkillSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const skill = await dependencies.skills.create({
      ...(body.data.skillId === undefined ? {} : { id: body.data.skillId as SkillId }),
      workspaceId,
      slug: body.data.slug,
      name: body.data.name,
      ...(body.data.description === undefined ? {} : { description: body.data.description }),
    })
    res.status(201).json(skill)
  }))

  app.post('/api/v1/workspaces/:workspaceId/skills/:skillId/versions', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_skill_management_required' } })
      return
    }
    const body = createSkillVersionSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const version = await dependencies.skills.createVersion({
      ...(body.data.versionId === undefined ? {} : { id: body.data.versionId as SkillVersionId }),
      workspaceId,
      skillId: idSchema.parse(req.params.skillId) as SkillId,
      instructions: body.data.instructions,
    })
    res.status(201).json(version)
  }))

  app.put('/api/v1/workspaces/:workspaceId/agents/:agentId/skills/:skillId', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_skill_management_required' } })
      return
    }
    const body = assignSkillSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    await dependencies.skills.assign({
      workspaceId,
      agentId: idSchema.parse(req.params.agentId) as AgentId,
      skillId: idSchema.parse(req.params.skillId) as SkillId,
      ...(body.data.pinnedVersionId == null
        ? {}
        : { pinnedVersionId: body.data.pinnedVersionId as SkillVersionId }),
      ...(body.data.priority === undefined ? {} : { priority: body.data.priority }),
      ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
    })
    res.json({ assigned: true })
  }))

  app.get('/api/v1/workspaces/:workspaceId/agents/:agentId/skills', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const skills = await dependencies.skills.listForAgent(
      workspaceId,
      idSchema.parse(req.params.agentId) as AgentId,
    )
    res.json({ skills })
  }))

  app.post(
    '/api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-scenarios',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      if (actorRef.kind !== 'user') {
        res.status(403).json({ error: { code: 'human_evaluation_management_required' } })
        return
      }
      const body = createEvaluationScenarioSchema.safeParse(req.body)
      if (!body.success) {
        invalidBody(res, body.error)
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const scenarioId = await dependencies.evaluations.createScenario({
        ...(body.data.scenarioId === undefined
          ? {}
          : { id: body.data.scenarioId as EvaluationScenarioId }),
        workspaceId,
        projectId: idSchema.parse(req.params.projectId) as ProjectId,
        slug: body.data.slug,
        name: body.data.name,
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
      })
      res.status(201).json({ scenarioId })
    }),
  )

  app.get(
    '/api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-scenario-versions',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      if (actorRef.kind !== 'user') {
        res.status(403).json({ error: { code: 'human_evaluation_view_required' } })
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      const projectId = idSchema.parse(req.params.projectId) as ProjectId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const limit = z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit ?? 50)
      const scenarioVersions = await dependencies.evaluations.listScenarioVersions({
        workspaceId,
        projectId,
        limit,
      })
      res.json({ scenarioVersions })
    }),
  )

  app.post(
    '/api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-scenarios/:scenarioId/versions',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      if (actorRef.kind !== 'user') {
        res.status(403).json({ error: { code: 'human_evaluation_management_required' } })
        return
      }
      const body = createEvaluationScenarioVersionSchema.safeParse(req.body)
      if (!body.success) {
        invalidBody(res, body.error)
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const version = await dependencies.evaluations.createScenarioVersion({
        ...(body.data.versionId === undefined
          ? {}
          : { id: body.data.versionId as EvaluationScenarioVersionId }),
        workspaceId,
        projectId: idSchema.parse(req.params.projectId) as ProjectId,
        scenarioId: idSchema.parse(req.params.scenarioId) as EvaluationScenarioId,
        definition: body.data.definition as EvaluationScenarioDefinition,
        createdBy: actorRef.id,
      })
      res.status(version.reused ? 200 : 201).json(version)
    }),
  )

  app.post(
    '/api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-experiments',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      if (actorRef.kind !== 'user') {
        res.status(403).json({ error: { code: 'human_evaluation_management_required' } })
        return
      }
      const body = createEvaluationExperimentSchema.safeParse(req.body)
      if (!body.success) {
        invalidBody(res, body.error)
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const experiment = await dependencies.evaluations.createExperiment({
        ...(body.data.experimentId === undefined
          ? {}
          : { id: body.data.experimentId as EvaluationExperimentId }),
        workspaceId,
        projectId: idSchema.parse(req.params.projectId) as ProjectId,
        scenarioVersionId: body.data.scenarioVersionId as EvaluationScenarioVersionId,
        name: body.data.name,
        repetitions: body.data.repetitions,
        ...(body.data.variants === undefined ? {} : { variants: body.data.variants }),
        createdBy: actorRef.id,
      })
      res.status(201).json(experiment)
    }),
  )

  app.get(
    '/api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-experiments',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      if (actorRef.kind !== 'user') {
        res.status(403).json({ error: { code: 'human_evaluation_view_required' } })
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      const projectId = idSchema.parse(req.params.projectId) as ProjectId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const limit = z.coerce.number().int().min(1).max(100).default(20).parse(req.query.limit ?? 20)
      const experiments = await dependencies.evaluations.listExperiments({ workspaceId, projectId, limit })
      res.json({ experiments })
    }),
  )

  app.get(
    '/api/v1/workspaces/:workspaceId/projects/:projectId/evaluation-experiments/:experimentId/report',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      if (actorRef.kind !== 'user') {
        res.status(403).json({ error: { code: 'human_evaluation_view_required' } })
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      const projectId = idSchema.parse(req.params.projectId) as ProjectId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const experiment: EvaluationExperimentSnapshot | null = await dependencies.evaluations.getExperiment(
        workspaceId,
        projectId,
        idSchema.parse(req.params.experimentId) as EvaluationExperimentId,
      )
      if (!experiment) {
        res.status(404).json({ error: { code: 'evaluation_experiment_not_found' } })
        return
      }
      res.json(buildEvaluationReport(experiment))
    }),
  )

  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/artifacts', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const query = listArtifactsQuerySchema.safeParse(req.query)
    if (!query.success) {
      invalidBody(res, query.error)
      return
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    const projectId = idSchema.parse(req.params.projectId) as ProjectId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const artifacts = await dependencies.artifacts.listProject({
      workspaceId,
      projectId,
      ...(query.data.missionId === undefined ? {} : { missionId: query.data.missionId as MissionId }),
      limit: query.data.limit,
    })
    res.json({
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        throughUpdateSeq: artifact.throughUpdateSeq.toString(),
        latestVersion: artifact.latestVersion
          ? { ...artifact.latestVersion, throughUpdateSeq: artifact.latestVersion.throughUpdateSeq.toString() }
          : null,
      })),
    })
  }))

  app.get('/api/v1/workspaces/:workspaceId/projects/:projectId/artifacts/:artifactId', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    const projectId = idSchema.parse(req.params.projectId) as ProjectId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const detail = await dependencies.artifacts.getProjectArtifact({
      workspaceId,
      projectId,
      artifactId: idSchema.parse(req.params.artifactId) as ArtifactId,
    })
    if (!detail) {
      res.status(404).json({ error: { code: 'artifact_not_found' } })
      return
    }
    res.json({
      ...detail,
      live: { ...detail.live, throughUpdateSeq: detail.live.throughUpdateSeq.toString() },
      versions: detail.versions.map((version) => ({
        ...version,
        throughUpdateSeq: version.throughUpdateSeq.toString(),
      })),
    })
  }))

  app.post('/api/v1/workspaces/:workspaceId/projects/:projectId/artifacts', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const body = createArtifactSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const artifact = await dependencies.artifacts.create({
      ...(body.data.artifactId === undefined ? {} : { artifactId: body.data.artifactId as ArtifactId }),
      workspaceId,
      projectId: idSchema.parse(req.params.projectId) as ProjectId,
      ...(body.data.missionId === undefined ? {} : { missionId: body.data.missionId as MissionId }),
      title: body.data.title,
      ...(body.data.kind === undefined ? {} : { kind: body.data.kind }),
      createdBy: actorRef.id,
    })
    res.status(201).json(artifact)
  }))

  app.post('/api/v1/workspaces/:workspaceId/artifacts/:artifactId/updates', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const body = appendArtifactUpdateSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    let origin
    if (actorRef.kind === 'user') {
      if (!body.data.sessionId) {
        res.status(400).json({ error: { code: 'session_required' } })
        return
      }
      origin = { kind: 'user' as const, userId: actorRef.id, sessionId: body.data.sessionId }
    } else {
      if (!body.data.runId || !body.data.taskId || !body.data.toolCallId || !body.data.intent) {
        res.status(400).json({ error: { code: 'agent_origin_scope_required' } })
        return
      }
      origin = {
        kind: 'agent' as const,
        agentId: actorRef.id,
        runId: body.data.runId as RunId,
        taskId: body.data.taskId as TaskId,
        toolCallId: body.data.toolCallId as ToolCallId,
        intent: body.data.intent,
      }
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const result = await dependencies.artifacts.appendUpdate({
      workspaceId,
      artifactId: idSchema.parse(req.params.artifactId) as ArtifactId,
      update: Buffer.from(body.data.update, 'base64url'),
      origin,
    })
    res.status(result.inserted ? 202 : 200).json({
      ...result,
      seq: result.seq.toString(),
    })
  }))

  app.get('/api/v1/workspaces/:workspaceId/artifacts/:artifactId/sync', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const parsed = z.object({ stateVector: stateVectorSchema.optional() }).safeParse(req.query)
    if (!parsed.success) {
      invalidBody(res, parsed.error)
      return
    }
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const state = await dependencies.artifacts.syncState({
      workspaceId,
      artifactId: idSchema.parse(req.params.artifactId) as ArtifactId,
      ...(parsed.data.stateVector === undefined
        ? {}
        : { remoteStateVector: Buffer.from(parsed.data.stateVector, 'base64url') }),
    })
    res.json({
      update: Buffer.from(state.update).toString('base64url'),
      stateVector: Buffer.from(state.stateVector).toString('base64url'),
      stateHash: state.stateHash,
      throughUpdateSeq: state.throughUpdateSeq.toString(),
    })
  }))

  app.post('/api/v1/workspaces/:workspaceId/artifacts/:artifactId/versions', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const body = createArtifactVersionSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    if (actorRef.kind === 'agent' && !body.data.runId) {
      res.status(400).json({ error: { code: 'agent_run_required' } })
      return
    }
    const createdBy: ActorRef = actorRef.kind === 'agent'
      ? { kind: 'agent', id: actorRef.id, runId: body.data.runId as RunId }
      : actorRef
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const version = await dependencies.artifacts.createVersion({
      ...(body.data.versionId === undefined ? {} : { versionId: body.data.versionId as ArtifactVersionId }),
      workspaceId,
      artifactId: idSchema.parse(req.params.artifactId) as ArtifactId,
      createdBy,
      ...(body.data.xmlFragment === undefined ? {} : { xmlFragment: body.data.xmlFragment }),
    })
    res.status(201).json({
      ...version,
      throughUpdateSeq: version.throughUpdateSeq.toString(),
      yjsState: Buffer.from(version.yjsState).toString('base64url'),
    })
  }))

  app.get('/api/v1/workspaces/:workspaceId/artifact-versions/:versionId', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const version = await dependencies.artifacts.readVersion({
      workspaceId,
      versionId: idSchema.parse(req.params.versionId) as ArtifactVersionId,
    })
    if (!version) {
      res.status(404).json({ error: { code: 'artifact_version_not_found' } })
      return
    }
    res.json({
      ...version,
      throughUpdateSeq: version.throughUpdateSeq.toString(),
      yjsState: Buffer.from(version.yjsState).toString('base64url'),
    })
  }))

  app.post(
    '/api/v1/workspaces/:workspaceId/missions/:missionId/tasks/:taskId/submissions',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      if (actorRef.kind !== 'agent') {
        res.status(403).json({ error: { code: 'agent_submission_required' } })
        return
      }
      const body = submitArtifactVersionSchema.safeParse(req.body)
      if (!body.success) {
        invalidBody(res, body.error)
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const submission = await dependencies.reviews.submitArtifactVersion({
        workspaceId,
        missionId: idSchema.parse(req.params.missionId) as MissionId,
        taskId: idSchema.parse(req.params.taskId) as TaskId,
        runId: body.data.runId as RunId,
        agentId: actorRef.id,
        artifactVersionId: body.data.artifactVersionId as ArtifactVersionId,
        ...(body.data.note === undefined ? {} : { note: body.data.note }),
      })
      res.status(201).json(submission)
    }),
  )

  app.post(
    '/api/v1/workspaces/:workspaceId/submissions/:submissionId/review',
    route(async (req, res) => {
      const actorRef = requestActor(req, res)
      if (!actorRef) return
      const body = reviewSubmissionSchema.safeParse(req.body)
      if (!body.success) {
        invalidBody(res, body.error)
        return
      }
      const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
      await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
      const reviewer: RequestActor = actorRef.kind === 'agent' && body.data.runId
        ? { ...actorRef, runId: body.data.runId as RunId }
        : actorRef
      const result = await dependencies.reviews.reviewSubmission({
        ...(body.data.reviewId === undefined ? {} : { reviewId: body.data.reviewId as ReviewId }),
        workspaceId,
        submissionId: idSchema.parse(req.params.submissionId) as TaskSubmissionId,
        reviewer,
        decision: body.data.decision,
        summary: body.data.summary,
        findings: body.data.findings.map((finding) => ({
          severity: finding.severity,
          summary: finding.summary,
          ...(finding.evidenceIds === undefined
            ? {}
            : { evidenceIds: finding.evidenceIds as EvidenceId[] }),
        })),
        correlationId: correlationId(req),
      })
      res.json(result)
    }),
  )

  app.post('/api/v1/workspaces/:workspaceId/reviews/:reviewId/retry', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    if (actorRef.kind !== 'user') {
      res.status(403).json({ error: { code: 'human_reviewer_retry_required' } })
      return
    }
    const body = retryTaskSchema.safeParse(req.body)
    if (!body.success) {
      invalidBody(res, body.error)
      return
    }
    const result = await dependencies.reviewerExecutions.retryFailed({
      workspaceId: idSchema.parse(req.params.workspaceId) as WorkspaceId,
      reviewId: idSchema.parse(req.params.reviewId) as ReviewId,
      requestedBy: actorRef.id,
      reason: body.data.reason,
      correlationId: ('review_retry_' + randomUUID()) as CorrelationId,
    })
    if (!result.retried) {
      const status = result.reason === 'not_found_or_forbidden' ? 404 : 409
      res.status(status).json({ error: { code: 'reviewer_retry_rejected', reason: result.reason } })
      return
    }
    res.json(result)
  }))

  app.get('/api/v1/workspaces/:workspaceId/submissions/:submissionId', route(async (req, res) => {
    const actorRef = requestActor(req, res)
    if (!actorRef) return
    const workspaceId = idSchema.parse(req.params.workspaceId) as WorkspaceId
    await dependencies.artifacts.authorizeActor({ workspaceId, actor: actorRef })
    const details = await dependencies.reviews.getSubmission(
      workspaceId,
      idSchema.parse(req.params.submissionId) as TaskSubmissionId,
    )
    if (!details) {
      res.status(404).json({ error: { code: 'submission_not_found' } })
      return
    }
    res.json(details)
  }))

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      invalidBody(res, error)
      return
    }
    if (error instanceof ArtifactNotFoundError) {
      res.status(404).json({ error: { code: 'artifact_not_found' } })
      return
    }
    if (error instanceof ConversationNotFoundError) {
      res.status(404).json({ error: { code: 'conversation_not_found', message: error.message } })
      return
    }
    if (error instanceof ConversationAccessError) {
      res.status(403).json({ error: { code: 'conversation_forbidden', message: error.message } })
      return
    }
    if (error instanceof ConversationScopeError) {
      res.status(422).json({ error: { code: 'conversation_scope_invalid', message: error.message } })
      return
    }
    if (error instanceof ConversationPlanningError) {
      res.status(422).json({ error: { code: 'conversation_planning_invalid', message: error.message } })
      return
    }
    if (error instanceof AuthenticationError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds))
      res.status(error.status).json({
        error: { code: error.code, message: error.message },
      })
      return
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(500).json({
      error: {
        code: 'internal_error',
        message: process.env.NODE_ENV === 'production' ? 'Internal server error' : message,
      },
    })
  })
  return app
}

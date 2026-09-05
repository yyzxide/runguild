import { createHash, randomUUID } from 'node:crypto'

import {
  EVALUATION_VARIANTS,
  type EvaluationExperimentId,
  type EvaluationExperimentStatus,
  type EvaluationScenarioDefinition,
  type EvaluationScenarioId,
  type EvaluationScenarioVersionId,
  type EvaluationTrial,
  type EvaluationTrialId,
  type EvaluationTrialMetrics,
  type EvaluationTrialStatus,
  type EvaluationVariant,
  type IsoTimestamp,
  type MissionId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
  validateEvaluationScenario,
} from '@runguild/protocol'
import type { Pool, PoolClient } from 'pg'

import { canonicalJson } from './json.js'
import { withTransaction } from './transaction.js'

interface TrialRow {
  readonly id: string
  readonly experiment_id: string
  readonly scenario_version_id: string
  readonly workspace_id: string
  readonly project_id: string
  readonly variant: EvaluationVariant
  readonly repetition: number
  readonly seed: string
  readonly status: EvaluationTrialStatus
  readonly mission_id: string | null
  readonly metrics: EvaluationTrialMetrics | null
  readonly error: Readonly<Record<string, unknown>> | null
  readonly created_at: Date
  readonly started_at: Date | null
  readonly completed_at: Date | null
  readonly updated_at: Date
}

const TRIAL_COLUMNS =
  'id, experiment_id, scenario_version_id, workspace_id, project_id, variant, ' +
  'repetition, seed, status, mission_id, metrics, error, created_at, started_at, completed_at, updated_at'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asTrial(row: TrialRow): EvaluationTrial {
  return {
    id: row.id as EvaluationTrialId,
    experimentId: row.experiment_id as EvaluationExperimentId,
    scenarioVersionId: row.scenario_version_id as EvaluationScenarioVersionId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id as ProjectId,
    variant: row.variant,
    repetition: row.repetition,
    seed: row.seed,
    status: row.status,
    ...(row.mission_id === null ? {} : { missionId: row.mission_id as MissionId }),
    ...(row.metrics === null ? {} : { metrics: row.metrics }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at.toISOString() as IsoTimestamp,
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() as IsoTimestamp }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() as IsoTimestamp }),
    updatedAt: row.updated_at.toISOString() as IsoTimestamp,
  }
}

export interface ReservedEvaluationTrial {
  readonly trial: EvaluationTrial
  readonly materializationToken: string
  readonly definition: EvaluationScenarioDefinition
  readonly scenarioName: string
  readonly createdBy: UserId
}

export interface EvaluationExperimentSnapshot {
  readonly id: EvaluationExperimentId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly scenarioId: EvaluationScenarioId
  readonly scenarioVersionId: EvaluationScenarioVersionId
  readonly name: string
  readonly status: EvaluationExperimentStatus
  readonly repetitions: number
  readonly variants: readonly EvaluationVariant[]
  readonly trials: readonly EvaluationTrial[]
}

export interface EvaluationScenarioVersionSummary {
  readonly id: EvaluationScenarioVersionId
  readonly scenarioId: EvaluationScenarioId
  readonly scenarioName: string
  readonly scenarioDescription: string
  readonly version: number
  readonly definitionHash: string
  readonly baselineCommit: string
  readonly singleAgentTaskCount: number
  readonly multiAgentTaskCount: number
  readonly createdAt: IsoTimestamp
}

export interface EvaluationExperimentSummary {
  readonly id: EvaluationExperimentId
  readonly scenarioId: EvaluationScenarioId
  readonly scenarioVersionId: EvaluationScenarioVersionId
  readonly scenarioName: string
  readonly name: string
  readonly status: EvaluationExperimentStatus
  readonly repetitions: number
  readonly variants: readonly EvaluationVariant[]
  readonly baselineCommit: string
  readonly trialCount: number
  readonly completedTrialCount: number
  readonly failedTrialCount: number
  readonly activeTrialCount: number
  readonly createdAt: IsoTimestamp
  readonly updatedAt: IsoTimestamp
}

function assertVariants(variants: readonly EvaluationVariant[]): void {
  if (variants.length < 1 || variants.length > EVALUATION_VARIANTS.length
      || new Set(variants).size !== variants.length
      || variants.some((variant) => !(EVALUATION_VARIANTS as readonly string[]).includes(variant))) {
    throw new Error('Evaluation variants must be a unique non-empty supported set')
  }
}

export class EvaluationRepository {
  constructor(private readonly pool: Pool) {}

  async createScenario(input: {
    readonly id?: EvaluationScenarioId
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly slug: string
    readonly name: string
    readonly description?: string
  }): Promise<EvaluationScenarioId> {
    const slug = input.slug.trim()
    const name = input.name.trim()
    const description = input.description?.trim() ?? ''
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('Evaluation Scenario slug is invalid')
    if (!name || name.length > 200 || description.length > 4_000) {
      throw new Error('Evaluation Scenario metadata is invalid')
    }
    const id = input.id ?? ('evaluation_scenario_' + randomUUID()) as EvaluationScenarioId
    await this.pool.query(
      'INSERT INTO evaluation_scenarios ' +
      '(id, workspace_id, project_id, slug, name, description) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, input.workspaceId, input.projectId, slug, name, description],
    )
    return id
  }

  async createScenarioVersion(input: {
    readonly id?: EvaluationScenarioVersionId
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly scenarioId: EvaluationScenarioId
    readonly definition: EvaluationScenarioDefinition
    readonly createdBy: UserId
  }): Promise<{
    readonly id: EvaluationScenarioVersionId
    readonly version: number
    readonly definitionHash: string
    readonly reused: boolean
  }> {
    const validation = validateEvaluationScenario(input.definition)
    if (!validation.valid) {
      throw new Error('Invalid Evaluation Scenario: ' + validation.errors
        .map((error) => error.path + ': ' + error.message).join('; '))
    }
    const definitionJson = canonicalJson(input.definition)
    const definitionHash = hash(definitionJson)
    return withTransaction(this.pool, async (client) => {
      const scenario = await client.query(
        "SELECT 1 FROM evaluation_scenarios " +
        "WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND status = 'active' FOR UPDATE",
        [input.scenarioId, input.workspaceId, input.projectId],
      )
      if (!scenario.rows[0]) throw new Error('Active Evaluation Scenario not found in scope')
      const existing = await client.query<{ id: string; version: number }>(
        'SELECT id, version FROM evaluation_scenario_versions ' +
        'WHERE scenario_id = $1 AND definition_hash = $2',
        [input.scenarioId, definitionHash],
      )
      if (existing.rows[0]) {
        return {
          id: existing.rows[0].id as EvaluationScenarioVersionId,
          version: existing.rows[0].version,
          definitionHash,
          reused: true,
        }
      }
      const latest = await client.query<{ version: number }>(
        'SELECT version FROM evaluation_scenario_versions ' +
        'WHERE scenario_id = $1 ORDER BY version DESC LIMIT 1',
        [input.scenarioId],
      )
      const version = (latest.rows[0]?.version ?? 0) + 1
      const id = input.id ?? ('evaluation_scenario_version_' + randomUUID()) as EvaluationScenarioVersionId
      await client.query(
        'INSERT INTO evaluation_scenario_versions ' +
        '(id, scenario_id, workspace_id, project_id, version, definition, definition_hash, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)',
        [id, input.scenarioId, input.workspaceId, input.projectId, version, definitionJson, definitionHash, input.createdBy],
      )
      return { id, version, definitionHash, reused: false }
    })
  }

  async createExperiment(input: {
    readonly id?: EvaluationExperimentId
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly scenarioVersionId: EvaluationScenarioVersionId
    readonly name: string
    readonly repetitions: number
    readonly variants?: readonly EvaluationVariant[]
    readonly createdBy: UserId
  }): Promise<EvaluationExperimentSnapshot> {
    if (!input.name.trim() || input.name.length > 200) throw new Error('Experiment name is invalid')
    if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 100) {
      throw new RangeError('Experiment repetitions must be between 1 and 100')
    }
    const variants = input.variants ?? EVALUATION_VARIANTS
    assertVariants(variants)
    const experimentId = input.id ?? ('evaluation_experiment_' + randomUUID()) as EvaluationExperimentId
    await withTransaction(this.pool, async (client) => {
      const version = await client.query(
        'SELECT 1 FROM evaluation_scenario_versions version ' +
        'JOIN projects project ON project.id = version.project_id ' +
        'AND project.workspace_id = version.workspace_id AND project.archived_at IS NULL ' +
        'WHERE version.id = $1 AND version.workspace_id = $2 AND version.project_id = $3 ' +
        'FOR SHARE OF project',
        [input.scenarioVersionId, input.workspaceId, input.projectId],
      )
      if (!version.rows[0]) throw new Error('Evaluation Scenario Version not found in scope')
      await client.query(
        'INSERT INTO evaluation_experiments ' +
        '(id, workspace_id, project_id, scenario_version_id, name, repetitions, variants, created_by) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          experimentId,
          input.workspaceId,
          input.projectId,
          input.scenarioVersionId,
          input.name.trim(),
          input.repetitions,
          variants,
          input.createdBy,
        ],
      )
      for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
        const seed = hash(input.scenarioVersionId + ':paired:' + repetition)
        for (const variant of variants) {
          const trialId = ('evaluation_trial_' + hash(
            experimentId + ':' + repetition + ':' + variant,
          )) as EvaluationTrialId
          await client.query(
            'INSERT INTO evaluation_trials ' +
            '(id, experiment_id, scenario_version_id, workspace_id, project_id, variant, repetition, seed) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [
              trialId,
              experimentId,
              input.scenarioVersionId,
              input.workspaceId,
              input.projectId,
              variant,
              repetition,
              seed,
            ],
          )
        }
      }
    })
    const snapshot = await this.getExperiment(input.workspaceId, input.projectId, experimentId)
    if (!snapshot) throw new Error('Evaluation Experiment was not persisted')
    return snapshot
  }

  async listScenarioVersions(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly limit: number
  }): Promise<readonly EvaluationScenarioVersionSummary[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('Evaluation Scenario Version limit must be between 1 and 100')
    }
    const result = await this.pool.query<{
      id: string
      scenario_id: string
      scenario_name: string
      scenario_description: string
      version: number
      definition_hash: string
      baseline_commit: string
      single_agent_task_count: number
      multi_agent_task_count: number
      created_at: Date
    }>(
      'SELECT v.id, v.scenario_id, s.name AS scenario_name, s.description AS scenario_description, ' +
      "v.version, v.definition_hash, v.definition->>'baselineCommit' AS baseline_commit, " +
      "jsonb_array_length(v.definition->'singleAgentPlan'->'tasks')::int AS single_agent_task_count, " +
      "jsonb_array_length(v.definition->'multiAgentPlan'->'tasks')::int AS multi_agent_task_count, " +
      'v.created_at FROM evaluation_scenario_versions v ' +
      'JOIN evaluation_scenarios s ON s.id = v.scenario_id ' +
      "WHERE v.workspace_id = $1 AND v.project_id = $2 AND s.status = 'active' " +
      'ORDER BY v.created_at DESC, v.id LIMIT $3',
      [input.workspaceId, input.projectId, input.limit],
    )
    return result.rows.map((row) => ({
      id: row.id as EvaluationScenarioVersionId,
      scenarioId: row.scenario_id as EvaluationScenarioId,
      scenarioName: row.scenario_name,
      scenarioDescription: row.scenario_description,
      version: row.version,
      definitionHash: row.definition_hash,
      baselineCommit: row.baseline_commit,
      singleAgentTaskCount: row.single_agent_task_count,
      multiAgentTaskCount: row.multi_agent_task_count,
      createdAt: row.created_at.toISOString() as IsoTimestamp,
    }))
  }

  async listExperiments(input: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly limit: number
  }): Promise<readonly EvaluationExperimentSummary[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('Evaluation Experiment limit must be between 1 and 100')
    }
    const result = await this.pool.query<{
      id: string
      scenario_id: string
      scenario_version_id: string
      scenario_name: string
      name: string
      status: EvaluationExperimentStatus
      repetitions: number
      variants: EvaluationVariant[]
      baseline_commit: string
      trial_count: number
      completed_trial_count: number
      failed_trial_count: number
      active_trial_count: number
      created_at: Date
      updated_at: Date
    }>(
      'SELECT e.id, v.scenario_id, e.scenario_version_id, s.name AS scenario_name, e.name, ' +
      "e.status, e.repetitions, e.variants, v.definition->>'baselineCommit' AS baseline_commit, " +
      '(SELECT COUNT(*)::int FROM evaluation_trials t WHERE t.experiment_id = e.id) AS trial_count, ' +
      "(SELECT COUNT(*)::int FROM evaluation_trials t WHERE t.experiment_id = e.id AND t.status = 'completed') " +
      'AS completed_trial_count, ' +
      "(SELECT COUNT(*)::int FROM evaluation_trials t WHERE t.experiment_id = e.id AND t.status = 'failed') " +
      'AS failed_trial_count, ' +
      "(SELECT COUNT(*)::int FROM evaluation_trials t WHERE t.experiment_id = e.id " +
      "AND t.status IN ('materializing', 'running')) AS active_trial_count, " +
      'e.created_at, e.updated_at FROM evaluation_experiments e ' +
      'JOIN evaluation_scenario_versions v ON v.id = e.scenario_version_id ' +
      'JOIN evaluation_scenarios s ON s.id = v.scenario_id ' +
      'WHERE e.workspace_id = $1 AND e.project_id = $2 ' +
      'ORDER BY e.updated_at DESC, e.id LIMIT $3',
      [input.workspaceId, input.projectId, input.limit],
    )
    return result.rows.map((row) => ({
      id: row.id as EvaluationExperimentId,
      scenarioId: row.scenario_id as EvaluationScenarioId,
      scenarioVersionId: row.scenario_version_id as EvaluationScenarioVersionId,
      scenarioName: row.scenario_name,
      name: row.name,
      status: row.status,
      repetitions: row.repetitions,
      variants: row.variants,
      baselineCommit: row.baseline_commit,
      trialCount: row.trial_count,
      completedTrialCount: row.completed_trial_count,
      failedTrialCount: row.failed_trial_count,
      activeTrialCount: row.active_trial_count,
      createdAt: row.created_at.toISOString() as IsoTimestamp,
      updatedAt: row.updated_at.toISOString() as IsoTimestamp,
    }))
  }

  async reserveMaterialization(input: {
    readonly limit: number
    readonly leaseSeconds: number
  }): Promise<readonly ReservedEvaluationTrial[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError('Evaluation materialization limit must be between 1 and 100')
    }
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 3_600) {
      throw new RangeError('Evaluation materialization lease must be between 5 and 3600 seconds')
    }
    return withTransaction(this.pool, async (client) => {
      const candidates = await client.query<TrialRow & {
        definition: EvaluationScenarioDefinition
        scenario_name: string
        created_by: string
      }>(
        'SELECT ' + TRIAL_COLUMNS.split(', ').map((column) => 't.' + column).join(', ') + ', ' +
        'v.definition, s.name AS scenario_name, e.created_by ' +
        'FROM evaluation_trials t ' +
        'JOIN evaluation_experiments e ON e.id = t.experiment_id ' +
        'JOIN evaluation_scenario_versions v ON v.id = t.scenario_version_id ' +
        'JOIN evaluation_scenarios s ON s.id = v.scenario_id ' +
        "WHERE (t.status = 'queued' OR (t.status = 'materializing' " +
        'AND t.materialization_expires_at <= NOW())) ' +
        "AND e.status IN ('queued', 'running') " +
        'ORDER BY t.created_at, t.repetition, t.variant LIMIT $1 FOR UPDATE OF t SKIP LOCKED',
        [input.limit],
      )
      const reserved: ReservedEvaluationTrial[] = []
      for (const row of candidates.rows) {
        const token = 'evaluation_materialization_' + randomUUID()
        const updated = await client.query<TrialRow>(
          "UPDATE evaluation_trials SET status = 'materializing', materialization_token = $2, " +
          "materialization_expires_at = NOW() + ($3 * INTERVAL '1 second'), " +
          'materialization_attempts = materialization_attempts + 1, updated_at = NOW() ' +
          'WHERE id = $1 RETURNING ' + TRIAL_COLUMNS,
          [row.id, token, input.leaseSeconds],
        )
        const trial = updated.rows[0]
        if (!trial) continue
        await client.query(
          "UPDATE evaluation_experiments SET status = 'running', " +
          'started_at = COALESCE(started_at, NOW()), updated_at = NOW() ' +
          "WHERE id = $1 AND status = 'queued'",
          [row.experiment_id],
        )
        reserved.push({
          trial: asTrial(trial),
          materializationToken: token,
          definition: row.definition,
          scenarioName: row.scenario_name,
          createdBy: row.created_by as UserId,
        })
      }
      return reserved
    })
  }

  async markMaterialized(input: {
    readonly trialId: EvaluationTrialId
    readonly materializationToken: string
    readonly missionId: MissionId
  }): Promise<EvaluationTrial> {
    const result = await this.pool.query<TrialRow>(
      "UPDATE evaluation_trials SET status = 'running', mission_id = $3, " +
      'materialization_token = NULL, materialization_expires_at = NULL, error = NULL, ' +
      'started_at = COALESCE(started_at, NOW()), updated_at = NOW() ' +
      "WHERE id = $1 AND status = 'materializing' AND materialization_token = $2 " +
      'RETURNING ' + TRIAL_COLUMNS,
      [input.trialId, input.materializationToken, input.missionId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Evaluation Trial materialization token is stale')
    return asTrial(row)
  }

  async markMaterializationFailed(input: {
    readonly trialId: EvaluationTrialId
    readonly materializationToken: string
    readonly error: Readonly<Record<string, unknown>>
  }): Promise<EvaluationTrial | null> {
    const result = await this.pool.query<TrialRow>(
      "UPDATE evaluation_trials SET status = CASE WHEN materialization_attempts >= 5 " +
      "THEN 'failed' ELSE 'queued' END, materialization_token = NULL, " +
      'materialization_expires_at = NULL, error = $3::jsonb, updated_at = NOW(), ' +
      'completed_at = CASE WHEN materialization_attempts >= 5 THEN NOW() ELSE completed_at END ' +
      "WHERE id = $1 AND status = 'materializing' AND materialization_token = $2 " +
      'RETURNING ' + TRIAL_COLUMNS,
      [input.trialId, input.materializationToken, canonicalJson(input.error)],
    )
    const row = result.rows[0]
    if (row?.status === 'failed') await this.refreshExperiment(row.experiment_id as EvaluationExperimentId)
    return row ? asTrial(row) : null
  }

  async collectReadyTrials(limit: number): Promise<readonly EvaluationTrial[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('Evaluation collection limit must be between 1 and 1000')
    }
    const candidates = await this.pool.query<{ id: string }>(
      'SELECT t.id FROM evaluation_trials t JOIN missions m ON m.id = t.mission_id ' +
      "WHERE t.status = 'running' AND (" +
      "m.status IN ('completed', 'failed', 'cancelled') OR " +
      '(EXISTS (SELECT 1 FROM tasks any_task WHERE any_task.mission_id = m.id) AND (' +
      "  NOT EXISTS (SELECT 1 FROM tasks open_task WHERE open_task.mission_id = m.id AND open_task.status <> 'completed') OR " +
      "  (EXISTS (SELECT 1 FROM tasks bad_task WHERE bad_task.mission_id = m.id AND bad_task.status IN ('failed', 'cancelled')) " +
      "   AND NOT EXISTS (SELECT 1 FROM tasks active_task WHERE active_task.mission_id = m.id " +
      "     AND active_task.status IN ('ready', 'claimed', 'running', 'waiting_human', 'reviewing')))" +
      '))) ORDER BY t.started_at, t.id LIMIT $1',
      [limit],
    )
    const collected: EvaluationTrial[] = []
    for (const candidate of candidates.rows) {
      const trial = await this.collectTrial(candidate.id as EvaluationTrialId)
      if (trial) collected.push(trial)
    }
    return collected
  }

  async getExperiment(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
    experimentId: EvaluationExperimentId,
  ): Promise<EvaluationExperimentSnapshot | null> {
    const experiment = await this.pool.query<{
      id: string
      workspace_id: string
      project_id: string
      scenario_id: string
      scenario_version_id: string
      name: string
      status: EvaluationExperimentStatus
      repetitions: number
      variants: EvaluationVariant[]
    }>(
      'SELECT e.id, e.workspace_id, e.project_id, v.scenario_id, e.scenario_version_id, ' +
      'e.name, e.status, e.repetitions, e.variants ' +
      'FROM evaluation_experiments e JOIN evaluation_scenario_versions v ON v.id = e.scenario_version_id ' +
      'WHERE e.id = $1 AND e.workspace_id = $2 AND e.project_id = $3',
      [experimentId, workspaceId, projectId],
    )
    const row = experiment.rows[0]
    if (!row) return null
    const trials = await this.pool.query<TrialRow>(
      'SELECT ' + TRIAL_COLUMNS + ' FROM evaluation_trials ' +
      'WHERE experiment_id = $1 ORDER BY repetition, variant',
      [experimentId],
    )
    return {
      id: row.id as EvaluationExperimentId,
      workspaceId: row.workspace_id as WorkspaceId,
      projectId: row.project_id as ProjectId,
      scenarioId: row.scenario_id as EvaluationScenarioId,
      scenarioVersionId: row.scenario_version_id as EvaluationScenarioVersionId,
      name: row.name,
      status: row.status,
      repetitions: row.repetitions,
      variants: row.variants,
      trials: trials.rows.map(asTrial),
    }
  }

  private async collectTrial(trialId: EvaluationTrialId): Promise<EvaluationTrial | null> {
    return withTransaction(this.pool, async (client) => {
      const trialResult = await client.query<TrialRow>(
        'SELECT ' + TRIAL_COLUMNS + ' FROM evaluation_trials ' +
        "WHERE id = $1 AND status = 'running' FOR UPDATE",
        [trialId],
      )
      const trial = trialResult.rows[0]
      if (!trial?.mission_id) return null
      const mission = await client.query<{
        status: string
        created_at: Date
        updated_at: Date
      }>(
        'SELECT status, created_at, updated_at FROM missions WHERE id = $1',
        [trial.mission_id],
      )
      const missionRow = mission.rows[0]
      if (!missionRow) throw new Error('Evaluation Trial Mission disappeared')
      const taskResult = await client.query<{
        status: string
        attempt_count: number
        completed_at: Date | null
      }>(
        'SELECT status, attempt_count, completed_at FROM tasks WHERE mission_id = $1',
        [trial.mission_id],
      )
      if (taskResult.rows.length === 0) return null
      const success = taskResult.rows.every((task) => task.status === 'completed')
        && ['reviewing', 'completed'].includes(missionRow.status)
      const hasFailure = ['failed', 'cancelled'].includes(missionRow.status)
        || taskResult.rows.some((task) => ['failed', 'cancelled'].includes(task.status))
      const hasActive = taskResult.rows.some((task) =>
        ['ready', 'claimed', 'running', 'waiting_human', 'reviewing'].includes(task.status))
      if (!success && (!hasFailure || hasActive)) return null

      const aggregates = await this.metricAggregates(client, trial.mission_id)
      const completedTasks = taskResult.rows.filter((task) => task.status === 'completed').length
      const endTimes = [
        missionRow.updated_at.getTime(),
        ...taskResult.rows.flatMap((task) => task.completed_at ? [task.completed_at.getTime()] : []),
        ...(aggregates.lastFinishedAt ? [aggregates.lastFinishedAt.getTime()] : []),
      ]
      const metrics: EvaluationTrialMetrics = {
        success,
        taskCompletionRate: completedTasks / taskResult.rows.length,
        wallTimeMs: Math.max(0, Math.max(...endTimes) - missionRow.created_at.getTime()),
        taskCount: taskResult.rows.length,
        runAttempts: aggregates.runAttempts,
        reworkAttempts: taskResult.rows.reduce((sum, task) => sum + Math.max(0, task.attempt_count - 1), 0),
        modelCalls: aggregates.modelCalls,
        inputTokens: aggregates.inputTokens,
        outputTokens: aggregates.outputTokens,
        cachedInputTokens: aggregates.cachedInputTokens,
        estimatedCostUsd: aggregates.estimatedCostUsd,
        toolCalls: aggregates.toolCalls,
        toolFailures: aggregates.toolFailures,
        reviewChangesRequested: aggregates.reviewChangesRequested,
        contextSnapshots: aggregates.contextSnapshots,
        compactedContexts: aggregates.compactedContexts,
        estimatedContextTokens: aggregates.estimatedContextTokens,
      }
      const updated = await client.query<TrialRow>(
        "UPDATE evaluation_trials SET status = 'completed', metrics = $2::jsonb, " +
        'completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING ' + TRIAL_COLUMNS,
        [trialId, canonicalJson(metrics)],
      )
      const row = updated.rows[0]
      if (!row) throw new Error('Evaluation Trial metrics were not persisted')
      await this.refreshExperimentInTransaction(client, row.experiment_id as EvaluationExperimentId)
      return asTrial(row)
    })
  }

  private async metricAggregates(client: PoolClient, missionId: string): Promise<{
    readonly runAttempts: number
    readonly lastFinishedAt: Date | null
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
  }> {
    const result = await client.query<{
      run_attempts: number
      last_finished_at: Date | null
      model_calls: number
      input_tokens: number
      output_tokens: number
      cached_input_tokens: number
      estimated_cost_usd: string | number
      tool_calls: number
      tool_failures: number
      review_changes_requested: number
      context_snapshots: number
      compacted_contexts: number
      estimated_context_tokens: number
    }>(
      'SELECT ' +
      '(SELECT COUNT(*)::int FROM agent_runs r WHERE r.mission_id = $1) AS run_attempts, ' +
      '(SELECT MAX(r.finished_at) FROM agent_runs r WHERE r.mission_id = $1) AS last_finished_at, ' +
      '((SELECT COUNT(*) FROM llm_calls l WHERE l.mission_id = $1) + ' +
      ' (SELECT COUNT(*) FROM reviewer_model_calls review_call WHERE review_call.mission_id = $1))::int AS model_calls, ' +
      '((SELECT COALESCE(SUM(l.input_tokens), 0) FROM llm_calls l WHERE l.mission_id = $1) + ' +
      ' (SELECT COALESCE(SUM(review_call.input_tokens), 0) FROM reviewer_model_calls review_call ' +
      '  WHERE review_call.mission_id = $1))::int AS input_tokens, ' +
      '((SELECT COALESCE(SUM(l.output_tokens), 0) FROM llm_calls l WHERE l.mission_id = $1) + ' +
      ' (SELECT COALESCE(SUM(review_call.output_tokens), 0) FROM reviewer_model_calls review_call ' +
      '  WHERE review_call.mission_id = $1))::int AS output_tokens, ' +
      '((SELECT COALESCE(SUM(l.cached_input_tokens), 0) FROM llm_calls l WHERE l.mission_id = $1) + ' +
      ' (SELECT COALESCE(SUM(review_call.cached_input_tokens), 0) FROM reviewer_model_calls review_call ' +
      '  WHERE review_call.mission_id = $1))::int AS cached_input_tokens, ' +
      '((SELECT COALESCE(SUM(l.estimated_cost_usd), 0) FROM llm_calls l WHERE l.mission_id = $1) + ' +
      ' (SELECT COALESCE(SUM(review_call.estimated_cost_usd), 0) FROM reviewer_model_calls review_call ' +
      '  WHERE review_call.mission_id = $1)) AS estimated_cost_usd, ' +
      '(SELECT COUNT(*)::int FROM tool_executions x WHERE x.mission_id = $1) AS tool_calls, ' +
      "(SELECT COUNT(*)::int FROM tool_executions x WHERE x.mission_id = $1 AND x.status = 'failed') AS tool_failures, " +
      "(SELECT COUNT(*)::int FROM reviews r WHERE r.mission_id = $1 AND r.status = 'changes_requested') " +
      'AS review_changes_requested, ' +
      '(SELECT COUNT(*)::int FROM context_snapshots c WHERE c.mission_id = $1) AS context_snapshots, ' +
      '(SELECT COUNT(*)::int FROM context_snapshots c WHERE c.mission_id = $1 AND c.compacted) AS compacted_contexts, ' +
      '(SELECT COALESCE(SUM(c.estimated_tokens), 0)::int FROM context_snapshots c WHERE c.mission_id = $1) ' +
      'AS estimated_context_tokens',
      [missionId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Evaluation metrics query returned no row')
    return {
      runAttempts: row.run_attempts,
      lastFinishedAt: row.last_finished_at,
      modelCalls: row.model_calls,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedInputTokens: row.cached_input_tokens,
      estimatedCostUsd: Number(row.estimated_cost_usd),
      toolCalls: row.tool_calls,
      toolFailures: row.tool_failures,
      reviewChangesRequested: row.review_changes_requested,
      contextSnapshots: row.context_snapshots,
      compactedContexts: row.compacted_contexts,
      estimatedContextTokens: row.estimated_context_tokens,
    }
  }

  private async refreshExperiment(experimentId: EvaluationExperimentId): Promise<void> {
    await withTransaction(this.pool, async (client) => this.refreshExperimentInTransaction(client, experimentId))
  }

  private async refreshExperimentInTransaction(
    client: PoolClient,
    experimentId: EvaluationExperimentId,
  ): Promise<void> {
    const pending = await client.query<{ pending: boolean; failed: boolean }>(
      'SELECT ' +
      "EXISTS (SELECT 1 FROM evaluation_trials WHERE experiment_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')) AS pending, " +
      "EXISTS (SELECT 1 FROM evaluation_trials WHERE experiment_id = $1 AND status = 'failed') AS failed",
      [experimentId],
    )
    const row = pending.rows[0]
    if (!row || row.pending) return
    await client.query(
      "UPDATE evaluation_experiments SET status = CASE WHEN $2 THEN 'failed' ELSE 'completed' END, " +
      'completed_at = NOW(), updated_at = NOW() WHERE id = $1',
      [experimentId, row.failed],
    )
  }
}

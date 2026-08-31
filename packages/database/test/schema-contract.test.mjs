import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../migrations/0001_core.sql', import.meta.url)
const runtimeMigrationUrl = new URL('../migrations/0003_runtime.sql', import.meta.url)
const artifactMigrationUrl = new URL('../migrations/0005_artifacts.sql', import.meta.url)
const reviewMigrationUrl = new URL('../migrations/0006_reviews.sql', import.meta.url)
const worktreeMigrationUrl = new URL('../migrations/0007_worktrees.sql', import.meta.url)
const contextMigrationUrl = new URL('../migrations/0008_context.sql', import.meta.url)
const evaluationMigrationUrl = new URL('../migrations/0009_evaluation.sql', import.meta.url)
const conversationMigrationUrl = new URL('../migrations/0010_conversations.sql', import.meta.url)
const conversationPlanningMigrationUrl = new URL('../migrations/0011_conversation_planning.sql', import.meta.url)
const workerInstancesMigrationUrl = new URL('../migrations/0012_worker_instances.sql', import.meta.url)
const projectRuntimeConfigMigrationUrl = new URL('../migrations/0013_project_runtime_config.sql', import.meta.url)
const reviewerExecutionMigrationUrl = new URL('../migrations/0014_reviewer_execution.sql', import.meta.url)
const worktreeSetupMigrationUrl = new URL('../migrations/0015_worktree_setup.sql', import.meta.url)
const submissionEvidenceMigrationUrl = new URL('../migrations/0016_submission_evidence.sql', import.meta.url)
const integrationConflictRecoveryMigrationUrl = new URL('../migrations/0017_integration_conflict_recovery.sql', import.meta.url)
const reviewerModelCallsMigrationUrl = new URL('../migrations/0018_reviewer_model_calls.sql', import.meta.url)

test('schema keeps durable coordination invariants in PostgreSQL', async () => {
  const sql = await readFile(migrationUrl, 'utf8')

  assert.match(sql, /task_id\s+TEXT PRIMARY KEY REFERENCES tasks/)
  assert.match(sql, /UNIQUE \(agent_id, dedupe_key\)/)
  assert.match(sql, /UNIQUE \(workspace_id, idempotency_key\)/)
  assert.match(sql, /FOREIGN KEY \(task_id, mission_id\)/)
  assert.match(sql, /FOREIGN KEY \(depends_on_task_id, mission_id\)/)
  assert.match(sql, /FOREIGN KEY \(run_id, task_id, agent_id\)/)
  assert.match(sql, /idx_outbox_pending/)
  assert.match(sql, /WHERE published_at IS NULL/)
  assert.match(sql, /UNIQUE \(artifact_id, version\)/)
  assert.match(sql, /trg_task_submission_scope/)
  assert.match(sql, /trg_evidence_scope/)
  assert.match(sql, /trg_review_submission_scope/)
})

test('Artifact schema enforces tenant scope and immutable exact-state versions', async () => {
  const sql = await readFile(artifactMigrationUrl, 'utf8')

  assert.match(sql, /fk_artifacts_project_scope/)
  assert.match(sql, /fk_artifacts_mission_scope/)
  assert.match(sql, /uq_artifact_version_exact_state/)
  assert.match(sql, /through_update_seq BIGINT/)
  assert.match(sql, /artifact versions are immutable/)
  assert.match(sql, /Agent-created Artifact Version requires a Run/)
})

test('review schema supports independent human or active reviewer-Agent decisions', async () => {
  const sql = await readFile(reviewMigrationUrl, 'utf8')

  assert.match(sql, /reviewer_kind IN \('user', 'agent'\)/)
  assert.match(sql, /uq_reviews_submission/)
  assert.match(sql, /builder and reviewer must be different agents/)
  assert.match(sql, /active reviewer in the submission workspace/)
})

test('Task Worktree schema fences provisioning and enforces repository scope', async () => {
  const sql = await readFile(worktreeMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS task_worktrees/)
  assert.match(sql, /provision_token/)
  assert.match(sql, /UNIQUE \(repository_path, branch_name\)/)
  assert.match(sql, /trg_task_worktree_scope/)
})

test('Integration conflict recovery records a bounded reconciliation baseline', async () => {
  const sql = await readFile(integrationConflictRecoveryMigrationUrl, 'utf8')

  assert.match(sql, /reconciliation_base_commit TEXT/)
  assert.match(sql, /ck_task_worktree_reconciliation_base/)
  assert.match(sql, /status IN \('ready', 'committed'\)/)
})

test('Reviewer model calls keep an immutable per-attempt usage ledger', async () => {
  const sql = await readFile(reviewerModelCallsMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS reviewer_model_calls/)
  assert.match(sql, /UNIQUE \(review_id, attempt\)/)
  assert.match(sql, /cached_input_tokens/)
  assert.match(sql, /FOREIGN KEY \(review_id, workspace_id, mission_id, task_id\)/)
  assert.match(sql, /review_model_call_backfill_/)
})

test('Context schema versions Skills and persists exact per-hop model views', async () => {
  const sql = await readFile(contextMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS skills/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS skill_versions/)
  assert.match(sql, /FOREIGN KEY \(pinned_version_id, skill_id\)/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS context_snapshots/)
  assert.match(sql, /UNIQUE \(run_id, hop\)/)
  assert.match(sql, /context_snapshot_id TEXT/)
  assert.match(sql, /FOREIGN KEY \(run_id, workspace_id, mission_id, task_id\)/)
})

test('Evaluation schema freezes scenarios and fences paired Trial materialization', async () => {
  const sql = await readFile(evaluationMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS evaluation_scenario_versions/)
  assert.match(sql, /evaluation scenario versions are immutable/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS evaluation_experiments/)
  assert.match(sql, /UNIQUE \(experiment_id, variant, repetition\)/)
  assert.match(sql, /materialization_token/)
  assert.match(sql, /trg_evaluation_trial_scope/)
})

test('runtime schema keeps crash recovery and fencing invariants', async () => {
  const sql = await readFile(runtimeMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_run_messages/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS llm_calls/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS run_control_requests/)
  assert.match(sql, /execution_token TEXT/)
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/)
  assert.match(sql, /FOREIGN KEY \(run_id, workspace_id, mission_id, task_id\)/)
  assert.match(sql, /fk_tool_execution_run_scope/)
  assert.match(sql, /trg_tool_approval_scope/)
})

test('Conversation schema scopes members, references, and Agent delivery in PostgreSQL', async () => {
  const sql = await readFile(conversationMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS conversation_members/)
  assert.match(sql, /uq_messages_conversation_sequence/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS conversation_message_deliveries/)
  assert.match(sql, /runguild_validate_conversation_message/)
  assert.match(sql, /Message Mission reference is outside the Conversation scope/)
  assert.match(sql, /runguild_validate_message_delivery/)
  assert.match(sql, /Message delivery Run is outside the Agent or Mission scope/)
})

test('Conversation planning schema fences Planner work and source-message promotion', async () => {
  const sql = await readFile(conversationPlanningMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS conversation_planning_requests/)
  assert.match(sql, /source_message_ids TEXT\[\] NOT NULL/)
  assert.match(sql, /lease_token/)
  assert.match(sql, /uq_conversation_planning_idempotency/)
  assert.match(sql, /runguild_validate_mission_source_messages/)
  assert.match(sql, /requires an active Planner in the Conversation/)
})

test('Worker Instance schema separates process presence from Run leases and fences Agent identity', async () => {
  const sql = await readFile(workerInstancesMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS worker_instances/)
  assert.match(sql, /heartbeat_timeout_seconds/)
  assert.match(sql, /status IN \('running', 'stopped', 'stale'\)/)
  assert.match(sql, /uq_worker_instances_running_agent/)
  assert.match(sql, /WHERE kind = 'agent' AND status = 'running'/)
  assert.match(sql, /FOREIGN KEY \(agent_id, workspace_id\)/)
})

test('Project Runtime Configuration persists safe launch inputs without model secrets', async () => {
  const sql = await readFile(projectRuntimeConfigMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS project_runtime_configs/)
  assert.match(sql, /test_commands\s+JSONB/)
  assert.match(sql, /agent_context_input_tokens/)
  assert.match(sql, /agent_max_test_timeout_ms/)
  assert.match(sql, /FOREIGN KEY \(project_id, workspace_id\)/)
  assert.doesNotMatch(sql, /api_key|secret|token\s+TEXT/i)
})

test('Reviewer execution schema isolates model work with leases and a durable decision ledger', async () => {
  const sql = await readFile(reviewerExecutionMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS review_executions/)
  assert.match(sql, /lease_token/)
  assert.match(sql, /materials_snapshot/)
  assert.match(sql, /prompt_snapshot/)
  assert.match(sql, /decision_hash/)
  assert.match(sql, /idx_review_executions_agent_pending/)
  assert.match(sql, /Reviewer execution scope does not match its Review/)
})

test('Worktree setup schema gates first model use with exact argv, leases, and generation-scoped reuse', async () => {
  const sql = await readFile(worktreeSetupMigrationUrl, 'utf8')

  assert.match(sql, /worktree_setup_commands JSONB/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS task_worktree_setups/)
  assert.match(sql, /worktree_generation INTEGER/)
  assert.match(sql, /commands_hash/)
  assert.match(sql, /lease_expires_at/)
  assert.match(sql, /FOREIGN KEY \(run_id, workspace_id, mission_id, task_id\)/)
  assert.match(sql, /uq_task_worktree_setup_succeeded/)
  assert.doesNotMatch(sql, /stdout\s+TEXT|stderr\s+TEXT/i)
})

test('Submission Evidence schema freezes only same-Task evidence references', async () => {
  const sql = await readFile(submissionEvidenceMigrationUrl, 'utf8')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS task_submission_evidence/)
  assert.match(sql, /PRIMARY KEY \(submission_id, evidence_id\)/)
  assert.match(sql, /enforce_task_submission_evidence_scope/)
  assert.match(sql, /submission evidence is outside the Task scope/)
})

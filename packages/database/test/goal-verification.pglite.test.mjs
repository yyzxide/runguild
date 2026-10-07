import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { MissionRepository } from '../dist/index.js'
import { GOAL_VERIFICATION_TASK_KEY } from '@runguild/protocol'

const plan = { summary: 'Build both components.', tasks: ['api', 'ui'].map((key) => ({
  key, title: key, description: 'Implement the component.', role: 'builder', priority: 10,
  dependsOn: [], reviewRequired: true, acceptanceCriteria: [],
})) }

async function fixture(database, goalVerification = true) {
  const folder = new URL('../migrations/', import.meta.url)
  for (const name of (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort()) {
    await database.exec(await readFile(new URL(name, folder), 'utf8'))
  }
  await database.exec(`
    INSERT INTO workspaces (id, name) VALUES ('ws', 'Goal workspace');
    INSERT INTO projects (id, workspace_id, name) VALUES ('project', 'ws', 'Project');
    INSERT INTO users (id, workspace_id, display_name) VALUES ('user', 'ws', 'User');
    INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES
      ('builder', 'ws', 'Builder', 'builder', 'test', 'test'), ('reviewer', 'ws', 'Reviewer', 'reviewer', 'test', 'test');
  `)
  const client = { async query(sql, params = []) {
    const result = await database.query(sql, params)
    return { ...result, rowCount: result.affectedRows ?? result.rows.length }
  }, release() {} }
  const repository = new MissionRepository({ connect: async () => client, query: client.query })
  await repository.createMission({
    missionId: 'mission', workspaceId: 'ws', projectId: 'project', title: 'Import CSV', goal: 'Deliver reliable CSV import.',
    acceptanceCriteria: ['Repeated imports do not duplicate rows.', 'Invalid rows are shown.'],
    goalVerification, actor: { kind: 'user', id: 'user' }, correlationId: 'create', budgetTokens: 10000,
  })
  return repository
}

const propose = (repository, proposedPlan = plan) => repository.proposePlan({
  workspaceId: 'ws', missionId: 'mission', plan: proposedPlan, actor: { kind: 'agent', id: 'builder' }, correlationId: 'plan',
})
const approve = (repository, version = 1) => repository.approvePlan({
  workspaceId: 'ws', missionId: 'mission', expectedVersion: version, approvedBy: 'user', correlationId: 'approve',
})

async function acceptedSubmission(database, taskId, suffix, attempt = 1) {
  await database.query("UPDATE tasks SET status = 'completed', attempt_count = $2 WHERE id = $1", [taskId, attempt])
  await database.query(`INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status)
    VALUES ($1, 'ws', 'mission', $2, 'builder', $3, 'succeeded')`, ['run_' + suffix, taskId, attempt])
  await database.query(`INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, created_by)
    VALUES ($1, 'ws', 'project', 'mission', 'Deliverable', 'builder')`, ['artifact_' + suffix])
  await database.query(`INSERT INTO artifact_versions (id, artifact_id, version, content, yjs_state_bytes, content_hash,
    yjs_state_hash, created_by_run_id, created_by_kind, created_by_id)
    VALUES ($1, $2, 1, '{}', decode('', 'hex'), 'content', 'state', $3, 'agent', 'builder')`,
  ['version_' + suffix, 'artifact_' + suffix, 'run_' + suffix])
  await database.query(`INSERT INTO task_submissions (id, workspace_id, mission_id, task_id, run_id, artifact_version_id,
    submitted_by_agent_id, evidence_bundle_hash, status) VALUES ($1, 'ws', 'mission', $2, $3, $4, 'builder', 'bundle', 'approved')`,
  ['submission_' + suffix, taskId, 'run_' + suffix, 'version_' + suffix])
  await database.query(`INSERT INTO reviews (id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id,
    reviewer_kind, reviewer_id, status, summary, completed_at)
    VALUES ($1, 'ws', 'mission', $2, $3, 'reviewer', 'agent', 'reviewer', 'approved', 'Verified', NOW())`,
  ['review_' + suffix, taskId, 'submission_' + suffix])
}

test('Goal proposal durably includes the original acceptance gate, replays identically, and preserves legacy plans', async () => {
  const database = new PGlite()
  try {
    const repository = await fixture(database)
    const first = await propose(repository)
    assert.equal(first.proposed, true)
    const proposed = await repository.getMission('ws', 'mission')
    assert.equal(proposed.goalVerification, true)
    assert.equal(proposed.verificationTaskId, null)
    assert.equal(proposed.proposedPlan.plan.tasks.length, 3)
    const retry = await propose(repository)
    const normalizedRetry = await propose(repository, proposed.proposedPlan.plan)
    assert.equal(retry.reused, true)
    assert.equal(normalizedRetry.hash, first.hash)
    const result = await approve(repository)
    assert.equal(result.approved, true)
    const snapshot = await repository.getMission('ws', 'mission')
    assert.equal(snapshot.verificationTaskId, result.taskIdsByKey[GOAL_VERIFICATION_TASK_KEY])
    const gate = snapshot.tasks.find((task) => task.id === snapshot.verificationTaskId)
    assert.deepEqual([...gate.dependsOn].sort(), [result.taskIdsByKey.api, result.taskIdsByKey.ui].sort())
    assert.equal(gate.status, 'blocked')
    assert.equal(gate.maxAttempts, 3)
    assert.deepEqual(gate.acceptanceCriteria.map((criterion) => criterion.description), snapshot.acceptanceCriteria)
    await repository.createMission({ missionId: 'legacy', workspaceId: 'ws', projectId: 'project', title: 'Legacy',
      goal: 'Preserve evaluation semantics.', actor: { kind: 'user', id: 'user' }, correlationId: 'legacy' })
    await repository.proposePlan({ workspaceId: 'ws', missionId: 'legacy', plan,
      actor: { kind: 'user', id: 'user' }, correlationId: 'legacy-plan' })
    const legacy = await repository.getMission('ws', 'legacy')
    assert.equal(legacy.goalVerification, false)
    assert.deepEqual(legacy.proposedPlan.plan, plan)
  } finally { await database.close() }
})

test('Goal delivery stays bound to the current verified submission and human correction must reverify original criteria', async () => {
  const database = new PGlite()
  try {
    const repository = await fixture(database)
    await propose(repository)
    const approved = await approve(repository)
    const gateId = approved.taskIdsByKey[GOAL_VERIFICATION_TASK_KEY]
    await database.exec("UPDATE tasks SET status = 'completed'; UPDATE missions SET status = 'reviewing' WHERE id = 'mission'")
    assert.equal((await repository.getMission('ws', 'mission')).finalDelivery, null)
    await acceptedSubmission(database, gateId, 'gate')
    await acceptedSubmission(database, approved.taskIdsByKey.api, 'newer_unrelated')
    assert.equal((await repository.getMission('ws', 'mission')).finalDelivery.artifactVersionId, 'version_gate')
    await database.query('UPDATE tasks SET attempt_count = 2 WHERE id = $1', [gateId])
    assert.equal((await repository.getMission('ws', 'mission')).finalDelivery, null)
    await database.query('UPDATE tasks SET attempt_count = 1 WHERE id = $1', [gateId])
    const corrected = await repository.requestDeliveryChanges({ workspaceId: 'ws', missionId: 'mission',
      expectedArtifactVersionId: 'version_gate', requestedBy: 'user', reason: 'Fix duplicate rows on retries.', correlationId: 'correct' })
    assert.equal(corrected.requested, true)
    const snapshot = await repository.getMission('ws', 'mission')
    assert.equal(snapshot.status, 'running')
    assert.equal(snapshot.verificationTaskId, corrected.taskId)
    assert.equal(snapshot.finalDelivery, null)
    const repair = snapshot.tasks.find((task) => task.id === corrected.taskId)
    assert.equal(repair.dependsOn.length, 3)
    assert.deepEqual(repair.acceptanceCriteria.filter((criterion) => criterion.key.startsWith('goal-acceptance-'))
      .map((criterion) => criterion.description), snapshot.acceptanceCriteria)
    assert.ok(repair.acceptanceCriteria.every((criterion) => !criterion.requiredEvidenceKinds.includes('file_diff')))
    await acceptedSubmission(database, corrected.taskId, 'repair')
    await database.exec("UPDATE missions SET status = 'reviewing' WHERE id = 'mission'")
    assert.equal((await repository.getMission('ws', 'mission')).status, 'reviewing')
    const final = await repository.approveDelivery({ workspaceId: 'ws', missionId: 'mission',
      expectedArtifactVersionId: 'version_repair', approvedBy: 'user', correlationId: 'deliver' })
    assert.equal(final.approved, true)
    assert.equal((await repository.getMission('ws', 'mission')).status, 'completed')
  } finally { await database.close() }
})

test('Goal approval refuses a stored proposal whose reserved gate was weakened', async () => {
  const database = new PGlite()
  try {
    const repository = await fixture(database)
    await propose(repository)
    await database.exec(`UPDATE mission_plan_revisions SET plan = jsonb_set(plan, '{tasks,2,reviewRequired}', 'false')`)
    assert.deepEqual(await approve(repository), { approved: false, reason: 'invalid_stored_plan' })
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM tasks')).rows[0].count, 0)
  } finally { await database.close() }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { ExecutionContextRepository, SkillRepository } from '../dist/index.js'

const migrationUrls = [
  new URL('../migrations/0001_core.sql', import.meta.url),
  new URL('../migrations/0002_orchestration.sql', import.meta.url),
  new URL('../migrations/0003_runtime.sql', import.meta.url),
  new URL('../migrations/0004_execution.sql', import.meta.url),
  new URL('../migrations/0005_artifacts.sql', import.meta.url),
  new URL('../migrations/0006_reviews.sql', import.meta.url),
  new URL('../migrations/0007_worktrees.sql', import.meta.url),
  new URL('../migrations/0008_context.sql', import.meta.url),
  new URL('../migrations/0009_evaluation.sql', import.meta.url),
  new URL('../migrations/0010_conversations.sql', import.meta.url),
  new URL('../migrations/0017_integration_conflict_recovery.sql', import.meta.url),
]

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return {
    async connect() { return client },
    query: client.query,
  }
}

async function setup(database) {
  for (const url of migrationUrls) await database.exec(await readFile(url, 'utf8'))
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws_context', 'Context'), ('ws_foreign', 'Foreign');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES ('project_context', 'ws_context', 'Project');" +
    "INSERT INTO users (id, workspace_id, display_name) VALUES ('user_context', 'ws_context', 'Developer');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('agent_context', 'ws_context', 'Builder', 'builder', 'openai', 'model-a'), " +
    "('agent_foreign', 'ws_foreign', 'Foreign', 'builder', 'openai', 'model-a');" +
    "INSERT INTO conversations (id, workspace_id, project_id, kind, title) " +
    "VALUES ('conversation_context', 'ws_context', 'project_context', 'mission_room', 'Mission room');" +
    "INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) VALUES " +
    "('conversation_context', 'ws_context', 'user', 'user_context'), " +
    "('conversation_context', 'ws_context', 'agent', 'agent_context');" +
    "INSERT INTO missions (id, workspace_id, project_id, conversation_id, title, goal, constraints, status, created_by) " +
    "VALUES ('mission_context', 'ws_context', 'project_context', 'conversation_context', 'Mission', 'Original goal', " +
    "'[\"bounded\"]'::jsonb, 'running', 'user');" +
    "INSERT INTO tasks (id, mission_id, title, description, status, attempt_count) " +
    "VALUES ('task_context', 'mission_context', 'Task', 'Original description', 'claimed', 2);" +
    "INSERT INTO task_acceptance_criteria " +
    "(id, task_id, criterion_key, description, required_evidence_kinds) VALUES " +
    "('criterion_context', 'task_context', 'tests', 'Tests pass', ARRAY['test_run']);" +
    "INSERT INTO agent_runs " +
    "(id, workspace_id, mission_id, task_id, agent_id, attempt, status) VALUES " +
    "('run_context_1', 'ws_context', 'mission_context', 'task_context', 'agent_context', 1, 'starting'), " +
    "('run_context_2', 'ws_context', 'mission_context', 'task_context', 'agent_context', 2, 'queued');" +
    "INSERT INTO messages " +
    "(id, workspace_id, conversation_id, author_kind, author_id, body, entity_refs, mentioned_agent_ids) " +
    "VALUES ('message_context', 'ws_context', 'conversation_context', 'user', 'user_context', " +
    "'Please verify the boundary.', '{\"missionId\":\"mission_context\"}'::jsonb, ARRAY['agent_context']);" +
    "INSERT INTO conversation_message_deliveries " +
    "(message_id, conversation_id, agent_id, status) " +
    "VALUES ('message_context', 'conversation_context', 'agent_context', 'context_pending');",
  )
}

test('execution context freezes Mission, Task, criteria, and exact Skill Versions per Run', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const skills = new SkillRepository(pool)
    const definition = await skills.create({
      id: 'skill_context',
      workspaceId: 'ws_context',
      slug: 'repository-testing',
      name: 'Repository testing',
      description: 'How this repository is verified.',
    })
    const versionOne = await skills.createVersion({
      id: 'skill_context_v1',
      workspaceId: 'ws_context',
      skillId: definition.id,
      instructions: 'Run the exact allowlisted test command.',
    })
    await skills.assign({
      workspaceId: 'ws_context',
      agentId: 'agent_context',
      skillId: definition.id,
      priority: 10,
    })

    const contexts = new ExecutionContextRepository(pool)
    const first = await contexts.load('run_context_1', 'agent_context')
    assert.equal(first.skills[0].versionId, versionOne.versionId)
    assert.equal(first.reviewRequired, true)
    assert.equal(first.missionArtifacts.length, 1)
    assert.equal(first.missionArtifacts[0].kind, 'mission_deliverable')
    assert.match(first.missionArtifacts[0].id, /^artifact_mission_[0-9a-f]{32}$/)
    assert.equal(first.missionGoal, 'Original goal')
    assert.equal(first.conversationId, 'conversation_context')
    assert.equal(first.conversationMessages[0].body, 'Please verify the boundary.')
    assert.match(first.frozenContextHash, /^[0-9a-f]{64}$/)
    const delivery = await database.query(
      "SELECT status, run_id FROM conversation_message_deliveries WHERE message_id = 'message_context'",
    )
    assert.deepEqual(delivery.rows[0], { status: 'context_loaded', run_id: 'run_context_1' })

    const versionTwo = await skills.createVersion({
      id: 'skill_context_v2',
      workspaceId: 'ws_context',
      skillId: definition.id,
      instructions: 'Run tests and typecheck before completion.',
    })
    await database.exec(
      "UPDATE missions SET goal = 'Changed goal' WHERE id = 'mission_context';" +
      "UPDATE tasks SET description = 'Changed description', review_required = FALSE WHERE id = 'task_context';" +
      "INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, kind, created_by) " +
      "VALUES ('artifact_later', 'ws_context', 'project_context', 'mission_context', 'Later', 'document', 'user_context');" +
      "INSERT INTO task_worktrees " +
      "(task_id, workspace_id, mission_id, project_id, repository_path, worktree_path, branch_name, " +
      "base_ref, base_commit, reconciliation_base_commit, head_commit, status) VALUES " +
      "('task_context', 'ws_context', 'mission_context', 'project_context', '/repo', '/trees/task', " +
      "'agent/task', 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', " +
      "'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccccccccccccccccccc', " +
      "'ready');" +
      "UPDATE task_worktrees SET last_error = " +
      "'{\"code\":\"worktree_integration_conflict\",\"message\":\"conflict\"}'::jsonb " +
      "WHERE task_id = 'task_context';",
    )

    const replay = await contexts.load('run_context_1', 'agent_context')
    assert.equal(replay.frozenContextHash, first.frozenContextHash)
    assert.equal(replay.skills[0].versionId, versionOne.versionId)
    assert.equal(replay.missionGoal, 'Original goal')
    assert.equal(replay.reviewRequired, true)
    assert.equal(replay.missionArtifacts.length, 1)

    const nextRun = await contexts.load('run_context_2', 'agent_context')
    assert.equal(nextRun.skills[0].versionId, versionTwo.versionId)
    assert.equal(nextRun.missionGoal, 'Changed goal')
    assert.equal(nextRun.reviewRequired, false)
    assert.equal(nextRun.missionArtifacts.length, 2)
    assert.equal(nextRun.integrationRecovery.baseCommit, 'b'.repeat(40))
    assert.equal(nextRun.integrationRecovery.error.code, 'worktree_integration_conflict')
    assert.notEqual(nextRun.frozenContextHash, first.frozenContextHash)
  } finally {
    await database.close()
  }
})

test('review corrections are scoped to an earlier attempt, bounded, and frozen across restart', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const contexts = new ExecutionContextRepository(poolAdapter(database))
    const first = await contexts.load('run_context_1', 'agent_context')
    assert.equal(first.previousReview, undefined)
    await database.exec(`
      INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, created_by)
        VALUES ('artifact_review', 'ws_context', 'project_context', 'mission_context', 'Result', 'agent_context');
      INSERT INTO artifact_versions (id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash,
        created_by_run_id, created_by_kind, created_by_id) VALUES
        ('version_review', 'artifact_review', 1, '{}', decode('', 'hex'), 'content', 'state', 'run_context_1', 'agent', 'agent_context');
      INSERT INTO task_submissions (id, workspace_id, mission_id, task_id, run_id, artifact_version_id,
        submitted_by_agent_id, evidence_bundle_hash, status) VALUES
        ('submission_review', 'ws_context', 'mission_context', 'task_context', 'run_context_1', 'version_review',
          'agent_context', 'bundle', 'rejected');
      INSERT INTO reviews (id, workspace_id, mission_id, task_id, submission_id, reviewer_kind, reviewer_id,
        status, summary, findings, completed_at) VALUES
        ('review_previous', 'ws_context', 'mission_context', 'task_context', 'submission_review', 'user', 'user_context',
          'changes_requested', 'Duplicate rows survive retry.', '[]', NOW());
    `)
    const findings = Array.from({ length: 25 }, () => ({ severity: 'error', summary: 'x'.repeat(1500),
      evidenceIds: ['valid_evidence', 'y'.repeat(201), 7] }))
    await database.query('UPDATE reviews SET findings = $1::jsonb WHERE id = $2', [JSON.stringify(findings), 'review_previous'])
    const second = await contexts.load('run_context_2', 'agent_context')
    assert.equal(second.previousReview.artifactVersionId, 'version_review')
    assert.equal(second.previousReview.summary, 'Duplicate rows survive retry.')
    assert.equal(second.previousReview.findings.length, 20)
    assert.equal(second.previousReview.findings[0].summary.length, 1000)
    assert.deepEqual(second.previousReview.findings[0].evidenceIds, ['valid_evidence'])
    await database.exec("UPDATE reviews SET summary = 'Changed after context freeze', findings = '[]'")
    const restarted = await new ExecutionContextRepository(poolAdapter(database)).load('run_context_2', 'agent_context')
    assert.deepEqual(restarted.previousReview, second.previousReview)
    assert.equal(restarted.frozenContextHash, second.frozenContextHash)
    assert.equal((await contexts.load('run_context_1', 'agent_context')).previousReview, undefined)
  } finally { await database.close() }
})

test('Skill assignment cannot cross Workspace or pin another Skill version', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const skills = new SkillRepository(pool)
    const definition = await skills.create({
      id: 'skill_scope',
      workspaceId: 'ws_context',
      slug: 'scope',
      name: 'Scope',
    })
    const version = await skills.createVersion({
      id: 'skill_scope_v1',
      workspaceId: 'ws_context',
      skillId: definition.id,
      instructions: 'Stay in scope.',
    })
    await assert.rejects(skills.assign({
      workspaceId: 'ws_foreign',
      agentId: 'agent_foreign',
      skillId: definition.id,
      pinnedVersionId: version.versionId,
    }))
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { ProjectRuntimeConfigRepository } from '../dist/index.js'

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return { async connect() { return client }, query: client.query }
}

async function setup(database) {
  for (const migration of [
    '0001_core.sql',
    '0002_orchestration.sql',
    '0003_runtime.sql',
    '0004_execution.sql',
    '0005_artifacts.sql',
    '0006_reviews.sql',
    '0007_worktrees.sql',
    '0008_context.sql',
    '0009_evaluation.sql',
    '0010_conversations.sql',
    '0011_conversation_planning.sql',
    '0012_worker_instances.sql',
    '0013_project_runtime_config.sql',
    '0014_reviewer_execution.sql',
    '0015_worktree_setup.sql',
    '0016_submission_evidence.sql',
    '0017_integration_conflict_recovery.sql',
  ]) {
    await database.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'))
  }
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace'), ('outside', 'Outside');" +
    "INSERT INTO users (id, workspace_id, display_name) VALUES " +
    "('user', 'ws', 'Operator'), ('outsider', 'outside', 'Outsider');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES " +
    "('project', 'ws', 'Project'), ('other_project', 'ws', 'Other');" +
    "INSERT INTO conversations (id, workspace_id, project_id, title, kind) VALUES " +
    "('room', 'ws', 'project', 'Team', 'project_room'), " +
    "('other_room', 'ws', 'other_project', 'Other team', 'project_room');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('planner', 'ws', 'Planner', 'planner', 'openai', 'gpt-old'), " +
    "('builder', 'ws', 'Builder', 'builder', 'openai', 'gpt-old'), " +
    "('other_agent', 'ws', 'Other', 'reviewer', 'openai', 'gpt-other');" +
    "INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) VALUES " +
    "('room', 'ws', 'user', 'user'), ('room', 'ws', 'agent', 'planner'), " +
    "('room', 'ws', 'agent', 'builder'), ('other_room', 'ws', 'agent', 'other_agent');",
  )
  await database.exec(await readFile(new URL('../migrations/0021_authentication.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
}

test('Project Runtime Config Repository returns defaults and persists safe launch inputs', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ProjectRuntimeConfigRepository(poolAdapter(database))
    const initial = await repository.get('ws', 'project', 'user')
    assert.equal(initial.project.repositoryPath, null)
    assert.equal(initial.project.defaultBranch, 'main')
    assert.deepEqual(initial.runtime.worktreeSetupCommands, [])
    assert.equal(initial.runtime.worktreeSetupTimeoutMs, 300_000)
    assert.deepEqual(initial.runtime.testCommands, [['npm', 'test'], ['npm', 'run', 'typecheck']])
    assert.deepEqual(initial.agents.map((agent) => agent.id), ['planner', 'builder'])

    const updated = await repository.update({
      workspaceId: 'ws', projectId: 'project', userId: 'user',
      repositoryPath: '/workspace/runguild',
      defaultBranch: 'develop',
      worktreeRoot: '/workspace/runguild-worktrees',
      worktreeSetupCommands: [['npm', 'ci', '--ignore-scripts']],
      worktreeSetupTimeoutMs: 240_000,
      testCommands: [['npm', 'test'], ['npm', 'run', 'typecheck']],
      agentContextInputTokens: 80_000,
      agentMaxTestTimeoutMs: 180_000,
      agentModels: [
        { agentId: 'planner', modelProvider: 'openai', modelName: 'gpt-planner' },
        { agentId: 'builder', modelProvider: 'openai', modelName: 'gpt-builder' },
      ],
    })
    assert.equal(updated.project.repositoryPath, '/workspace/runguild')
    assert.equal(updated.project.defaultBranch, 'develop')
    assert.equal(updated.runtime.worktreeRoot, '/workspace/runguild-worktrees')
    assert.deepEqual(updated.runtime.worktreeSetupCommands, [['npm', 'ci', '--ignore-scripts']])
    assert.equal(updated.runtime.worktreeSetupTimeoutMs, 240_000)
    assert.equal(updated.runtime.agentContextInputTokens, 80_000)
    assert.deepEqual(updated.agents.map((agent) => agent.modelName), ['gpt-planner', 'gpt-builder'])

    const stored = await database.query(
      "SELECT worktree_setup_commands, worktree_setup_timeout_ms, test_commands, agent_max_test_timeout_ms " +
      "FROM project_runtime_configs WHERE project_id = 'project'",
    )
    assert.deepEqual(stored.rows[0].worktree_setup_commands, [['npm', 'ci', '--ignore-scripts']])
    assert.equal(stored.rows[0].worktree_setup_timeout_ms, 240_000)
    assert.deepEqual(stored.rows[0].test_commands, [['npm', 'test'], ['npm', 'run', 'typecheck']])
    assert.equal(stored.rows[0].agent_max_test_timeout_ms, 180_000)
  } finally {
    await database.close()
  }
})

test('Project Runtime Config Repository enforces tenant, team, and path boundaries', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ProjectRuntimeConfigRepository(poolAdapter(database))
    assert.equal(await repository.get('ws', 'project', 'outsider'), null)

    const valid = {
      workspaceId: 'ws', projectId: 'project', userId: 'user',
      repositoryPath: '/workspace/runguild', defaultBranch: 'main',
      worktreeRoot: '/workspace/worktrees',
      worktreeSetupCommands: [], worktreeSetupTimeoutMs: 300_000,
      testCommands: [['npm', 'test']],
      agentContextInputTokens: 65_536, agentMaxTestTimeoutMs: 120_000,
      agentModels: [],
    }
    await assert.rejects(
      repository.update({
        ...valid,
        agentModels: [{ agentId: 'other_agent', modelProvider: 'openai', modelName: 'gpt-new' }],
      }),
      /outside the Project team/,
    )
    await assert.rejects(
      repository.update({ ...valid, worktreeRoot: '/workspace/runguild/worktrees' }),
      /distinct non-nested/,
    )
    await assert.rejects(
      repository.update({ ...valid, userId: 'outsider' }),
      /not found or forbidden/,
    )
  } finally {
    await database.close()
  }
})

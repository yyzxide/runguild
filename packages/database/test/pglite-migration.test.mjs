import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

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
  new URL('../migrations/0011_conversation_planning.sql', import.meta.url),
  new URL('../migrations/0012_worker_instances.sql', import.meta.url),
  new URL('../migrations/0013_project_runtime_config.sql', import.meta.url),
  new URL('../migrations/0014_reviewer_execution.sql', import.meta.url),
  new URL('../migrations/0015_worktree_setup.sql', import.meta.url),
]

async function applyMigrations(database) {
  for (const url of migrationUrls) {
    await database.exec(await readFile(url, 'utf8'))
  }
}

test('core migration executes on an in-process PostgreSQL engine', async () => {
  const database = new PGlite()
  try {
    await applyMigrations(database)

    const result = await database.query(
      "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'public' ORDER BY table_name",
    )
    const tables = new Set(result.rows.map((row) => row.table_name))
    for (const required of [
      'missions',
      'tasks',
      'task_dependencies',
      'agent_runs',
      'task_leases',
      'inbox_messages',
      'outbox_events',
      'artifact_versions',
      'task_submissions',
      'reviews',
      'mission_plan_revisions',
      'task_dispatches',
      'agent_run_events',
      'agent_run_messages',
      'llm_calls',
      'run_control_requests',
      'evidence',
      'task_worktrees',
      'skills',
      'skill_versions',
      'agent_skill_assignments',
      'context_snapshots',
      'evaluation_scenarios',
      'evaluation_scenario_versions',
      'evaluation_experiments',
      'evaluation_trials',
      'conversation_members',
      'conversation_message_deliveries',
      'conversation_planning_requests',
      'worker_instances',
      'project_runtime_configs',
      'review_executions',
      'task_worktree_setups',
    ]) {
      assert.equal(tables.has(required), true, 'missing table ' + required)
    }
    const executionIndex = await database.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' " +
      "AND indexname = 'uq_run_criterion_evidence'",
    )
    assert.equal(executionIndex.rows.length, 1)
    const artifactIndex = await database.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' " +
      "AND indexname = 'uq_artifact_version_exact_state'",
    )
    assert.equal(artifactIndex.rows.length, 1)
  } finally {
    await database.close()
  }
})

test('database rejects a dependency edge across missions', async () => {
  const database = new PGlite()
  try {
    await applyMigrations(database)
    await database.exec(
      "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
      "INSERT INTO projects (id, workspace_id, name) VALUES ('project', 'ws', 'Project');" +
      "INSERT INTO missions (id, workspace_id, project_id, title, goal, created_by) VALUES " +
      "('mission_a', 'ws', 'project', 'A', 'A', 'user'), " +
      "('mission_b', 'ws', 'project', 'B', 'B', 'user');" +
      "INSERT INTO tasks (id, mission_id, title) VALUES " +
      "('task_a', 'mission_a', 'A'), ('task_b', 'mission_b', 'B');",
    )

    await assert.rejects(
      database.exec(
        "INSERT INTO task_dependencies (mission_id, task_id, depends_on_task_id) " +
        "VALUES ('mission_a', 'task_a', 'task_b')",
      ),
    )

    await database.exec(
      "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) " +
      "VALUES ('agent_scope', 'ws', 'Agent', 'builder', 'test', 'test');" +
      "UPDATE tasks SET status = 'running', attempt_count = 1 WHERE id IN ('task_a', 'task_b');" +
      "INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status) " +
      "VALUES ('run_scope', 'ws', 'mission_a', 'task_a', 'agent_scope', 1, 'running');",
    )
    await assert.rejects(
      database.exec(
        "INSERT INTO tool_executions " +
        "(id, workspace_id, mission_id, task_id, run_id, agent_id, action, idempotency_key, " +
        "request_hash, request, status) VALUES " +
        "('tool_bad_scope', 'ws', 'mission_b', 'task_b', 'run_scope', 'agent_scope', " +
        "'repo.search', 'bad_scope', 'hash', '{}', 'running')",
      ),
    )
  } finally {
    await database.close()
  }
})

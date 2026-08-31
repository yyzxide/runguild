import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { ProjectOperatorRepository } from '../dist/index.js'

function poolAdapter(database) {
  let queryInFlight = false
  const client = {
    async query(statement, params = []) {
      if (queryInFlight) throw new Error('Concurrent queries on one transaction client are forbidden')
      queryInFlight = true
      try {
        const result = await database.query(statement, params)
        return { ...result, rowCount: result.affectedRows ?? result.rows.length }
      } finally {
        queryInFlight = false
      }
    },
    release() {},
  }
  return { async connect() { return client }, query: client.query }
}

async function setup(database) {
  await database.exec(await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'))
  await database.exec('ALTER TABLE projects ADD COLUMN repository_path TEXT;')
  await database.exec(await readFile(new URL('../migrations/0010_conversations.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0012_worker_instances.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0019_project_scoped_integration_workers.sql', import.meta.url), 'utf8'))
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace'), ('other_ws', 'Other');" +
    "INSERT INTO users (id, workspace_id, display_name) VALUES " +
    "('operator', 'ws', 'Operator'), ('other_user', 'other_ws', 'Other');" +
    "INSERT INTO projects (id, workspace_id, name, repository_url, repository_path, default_branch) VALUES " +
    "('project', 'ws', 'RunGuild', 'https://example.test/runguild.git', '/workspace/runguild', 'develop'), " +
    "('sibling_project', 'ws', 'Sibling', NULL, NULL, 'main'), " +
    "('other_project', 'other_ws', 'Other', NULL, NULL, 'main');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('planner', 'ws', 'Planner', 'planner', 'openai', 'gpt-test'), " +
    "('unassigned', 'ws', 'Unassigned', 'builder', 'openai', 'gpt-test');" +
    "INSERT INTO conversations (id, workspace_id, project_id, kind, title) VALUES " +
    "('team', 'ws', 'project', 'project_room', 'Team');" +
    "INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) VALUES " +
    "('team', 'ws', 'user', 'operator'), ('team', 'ws', 'agent', 'planner');" +
    "INSERT INTO missions (id, workspace_id, project_id, conversation_id, title, goal, status, plan_version, created_by, updated_at) VALUES " +
    "('mission_new', 'ws', 'project', 'team', 'Current Mission', 'Goal', 'running', 2, 'operator', '2030-01-02T00:00:00Z'), " +
    "('mission_old', 'ws', 'project', 'team', 'Older Mission', 'Goal', 'completed', 1, 'operator', '2030-01-01T00:00:00Z');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) VALUES " +
    "('sibling_mission', 'ws', 'sibling_project', 'Sibling Mission', 'Goal', 'running', 'operator');" +
    "INSERT INTO tasks (id, mission_id, title, status) VALUES " +
    "('task_done', 'mission_new', 'Done', 'completed'), " +
    "('task_running', 'mission_new', 'Running', 'running'), " +
    "('task_old', 'mission_old', 'Old', 'completed'), " +
    "('sibling_task', 'sibling_mission', 'Sibling', 'running');" +
    "INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status, updated_at) VALUES " +
    "('run_active', 'ws', 'mission_new', 'task_running', 'planner', 1, 'running', '2030-01-03T00:00:00Z'), " +
    "('run_done', 'ws', 'mission_new', 'task_done', 'planner', 1, 'succeeded', '2030-01-02T00:00:00Z'), " +
    "('sibling_run', 'ws', 'sibling_mission', 'sibling_task', 'planner', 1, 'running', '2030-01-04T00:00:00Z');",
  )
  await database.exec(
    "INSERT INTO worker_instances " +
    "(id, kind, workspace_id, agent_id, hostname, process_id, heartbeat_interval_seconds, heartbeat_timeout_seconds, expires_at) VALUES " +
    "('worker_agent', 'agent', 'ws', 'planner', 'local', 10, 5, 15, NOW() + INTERVAL '15 seconds'), " +
    "('worker_scheduler', 'scheduler', NULL, NULL, 'local', 11, 5, 15, NOW() + INTERVAL '15 seconds');" +
    "INSERT INTO worker_instances " +
    "(id, kind, workspace_id, project_id, agent_id, status, hostname, process_id, heartbeat_interval_seconds, heartbeat_timeout_seconds, expires_at, stopped_at) VALUES " +
    "('worker_integration', 'integration', 'ws', 'project', NULL, 'stopped', 'local', 12, 5, 15, NOW(), NOW());" +
    "INSERT INTO worker_instances " +
    "(id, kind, workspace_id, project_id, agent_id, hostname, process_id, heartbeat_interval_seconds, heartbeat_timeout_seconds, expires_at) VALUES " +
    "('worker_sibling_integration', 'integration', 'ws', 'sibling_project', NULL, 'local', 13, 5, 15, NOW() + INTERVAL '15 seconds');",
  )
}

test('Project Operator Repository returns the real project team and recent Mission state', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ProjectOperatorRepository(poolAdapter(database))
    const overview = await repository.getOverview('ws', 'project', 'operator')

    assert.equal(overview.project.name, 'RunGuild')
    assert.equal(overview.project.repositoryPath, '/workspace/runguild')
    assert.equal(overview.project.defaultBranch, 'develop')
    assert.equal(overview.project.conversationId, 'team')
    assert.deepEqual(overview.agents.map((agent) => agent.id), ['planner'])
    assert.equal(overview.agents[0].activeRunCount, 1)
    assert.equal(overview.agents[0].lastRunAt, '2030-01-03T00:00:00.000Z')
    assert.equal(overview.agents[0].worker.state, 'online')
    assert.deepEqual(overview.missions.map((mission) => mission.id), ['mission_new', 'mission_old'])
    assert.deepEqual(
      [overview.missions[0].taskCount, overview.missions[0].completedTaskCount, overview.missions[0].activeRunCount],
      [2, 1, 1],
    )
    assert.deepEqual(overview.systemWorkers.map((worker) => [worker.kind, worker.state]), [
      ['scheduler', 'online'],
      ['integration', 'stopped'],
      ['evaluation', 'never_seen'],
    ])

    const siblingOverview = await repository.getOverview('ws', 'sibling_project', 'operator')
    assert.equal(siblingOverview.systemWorkers.find((worker) => worker.kind === 'integration').state, 'online')

    assert.equal(await repository.getOverview('ws', 'project', 'other_user'), null)
    assert.equal(await repository.getOverview('other_ws', 'project', 'other_user'), null)
  } finally {
    await database.close()
  }
})

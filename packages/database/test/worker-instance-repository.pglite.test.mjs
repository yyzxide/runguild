import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import {
  AgentProjectScopeError,
  WorkerAlreadyActiveError,
  WorkerInstanceRepository,
} from '../dist/index.js'

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
  await database.exec(await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0010_conversations.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0012_worker_instances.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0019_project_scoped_integration_workers.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0020_project_scoped_agent_workers.sql', import.meta.url), 'utf8'))
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES " +
    "('project', 'ws', 'Project'), ('sibling', 'ws', 'Sibling');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
    "('agent', 'ws', 'Builder', 'builder', 'openai', 'gpt-test');" +
    "INSERT INTO conversations (id, workspace_id, project_id, kind, title) VALUES " +
    "('project_room', 'ws', 'project', 'project_room', 'Project');" +
    "INSERT INTO conversation_members " +
    "(conversation_id, workspace_id, participant_kind, participant_id) VALUES " +
    "('project_room', 'ws', 'agent', 'agent');",
  )
}

const registration = {
  kind: 'agent',
  agentId: 'agent',
  workspaceId: 'ws',
  projectId: 'project',
  hostname: 'worker-host',
  processId: 42,
  heartbeatIntervalSeconds: 5,
  heartbeatTimeoutSeconds: 15,
}

test('Worker Instance Repository fences Agent processes and recovers an expired owner', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new WorkerInstanceRepository(poolAdapter(database))
    const first = await repository.register({ id: 'worker_first', ...registration })
    assert.equal(first.workspaceId, 'ws')
    assert.equal(first.projectId, 'project')
    assert.equal(first.agentId, 'agent')
    assert.equal(await repository.hasActive('agent', 'agent', {
      workspaceId: 'ws', projectId: 'project',
    }), true)
    assert.equal(await repository.hasActive('scheduler'), false)

    await assert.rejects(
      repository.register({ id: 'worker_duplicate', ...registration, processId: 43 }),
      WorkerAlreadyActiveError,
    )

    assert.equal(await repository.heartbeat('worker_first'), true)
    await database.exec(
      "UPDATE worker_instances SET expires_at = NOW() - INTERVAL '1 second' WHERE id = 'worker_first'",
    )
    const replacement = await repository.register({ id: 'worker_replacement', ...registration, processId: 44 })
    assert.equal(replacement.id, 'worker_replacement')

    const prior = await database.query(
      "SELECT status, stopped_at IS NOT NULL AS stopped FROM worker_instances WHERE id = 'worker_first'",
    )
    assert.deepEqual(prior.rows[0], { status: 'stale', stopped: true })
    assert.equal(await repository.heartbeat('worker_first'), false)
    assert.equal(await repository.markStopped('worker_replacement'), true)
    assert.equal(await repository.hasActive('agent', 'agent', {
      workspaceId: 'ws', projectId: 'project',
    }), false)
    assert.equal(await repository.markStopped('worker_replacement'), false)
  } finally {
    await database.close()
  }
})

test('Worker Instance Repository rejects unscoped and cross-Project Agent identities', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new WorkerInstanceRepository(poolAdapter(database))
    await assert.rejects(
      repository.register({
        ...registration, id: 'worker_unscoped', workspaceId: undefined, projectId: undefined,
      }),
      /Workspace\/Project scope/,
    )
    await assert.rejects(
      repository.register({ ...registration, id: 'worker_wrong_project', projectId: 'sibling' }),
      AgentProjectScopeError,
    )
    await database.exec(
      "INSERT INTO conversations (id, workspace_id, project_id, kind, title) VALUES " +
      "('sibling_room', 'ws', 'sibling', 'project_room', 'Sibling');" +
      "INSERT INTO conversation_members " +
      "(conversation_id, workspace_id, participant_kind, participant_id) VALUES " +
      "('sibling_room', 'ws', 'agent', 'agent');",
    )
    await assert.rejects(
      repository.register({ ...registration, id: 'worker_shared_agent' }),
      /cannot belong to multiple Projects/,
    )
  } finally {
    await database.close()
  }
})

test('Worker Instance Repository allows independent control-plane processes', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new WorkerInstanceRepository(poolAdapter(database))
    await repository.register({
      id: 'scheduler_one', kind: 'scheduler', hostname: 'one', processId: 1,
      heartbeatIntervalSeconds: 5, heartbeatTimeoutSeconds: 15,
    })
    assert.equal(await repository.hasActive('scheduler'), true)
    await repository.register({
      id: 'scheduler_two', kind: 'scheduler', hostname: 'two', processId: 2,
      heartbeatIntervalSeconds: 5, heartbeatTimeoutSeconds: 15,
    })
    const result = await database.query(
      "SELECT COUNT(*)::int AS count FROM worker_instances WHERE kind = 'scheduler' AND status = 'running'",
    )
    assert.equal(result.rows[0].count, 2)
  } finally {
    await database.close()
  }
})

test('Worker Instance Repository isolates repository-bound Integration processes by Project', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new WorkerInstanceRepository(poolAdapter(database))
    await assert.rejects(
      repository.register({
        id: 'integration_unscoped', kind: 'integration', hostname: 'one', processId: 1,
        heartbeatIntervalSeconds: 5, heartbeatTimeoutSeconds: 15,
      }),
      /Workspace\/Project scope/,
    )
    const registered = await repository.register({
      id: 'integration_project', kind: 'integration', workspaceId: 'ws', projectId: 'project',
      hostname: 'one', processId: 2, heartbeatIntervalSeconds: 5, heartbeatTimeoutSeconds: 15,
    })
    assert.equal(registered.workspaceId, 'ws')
    assert.equal(registered.projectId, 'project')
    assert.equal(await repository.hasActive('integration', undefined, {
      workspaceId: 'ws', projectId: 'project',
    }), true)
    assert.equal(await repository.hasActive('integration', undefined, {
      workspaceId: 'ws', projectId: 'sibling',
    }), false)
    await repository.register({
      id: 'integration_sibling', kind: 'integration', workspaceId: 'ws', projectId: 'sibling',
      hostname: 'two', processId: 3, heartbeatIntervalSeconds: 5, heartbeatTimeoutSeconds: 15,
    })
    assert.equal(await repository.hasActive('integration', undefined, {
      workspaceId: 'ws', projectId: 'sibling',
    }), true)
  } finally {
    await database.close()
  }
})

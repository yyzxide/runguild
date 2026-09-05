import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { AuthenticationRepository, ProjectMembershipRepository } from '../dist/index.js'

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
    '0010_conversations.sql',
    '0011_conversation_planning.sql',
    '0021_authentication.sql',
  ]) {
    await database.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'))
  }
  await database.exec(
    "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
    "INSERT INTO users (id, workspace_id, display_name, role) VALUES ('owner', 'ws', 'Owner', 'owner');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES " +
    "('project', 'ws', 'Project'), ('sibling', 'ws', 'Sibling');" +
    "INSERT INTO conversations (id, workspace_id, project_id, kind, title) VALUES " +
    "('project_room', 'ws', 'project', 'project_room', 'Team');" +
    "INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) " +
    "VALUES ('project_room', 'ws', 'user', 'owner');",
  )
  await database.exec(await readFile(new URL('../migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
  await database.exec(await readFile(new URL('../migrations/0023_project_lifecycle.sql', import.meta.url), 'utf8'))
}

test('Project Membership Repository makes access explicit and keeps team rooms in sync', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const pool = poolAdapter(database)
    const memberships = new ProjectMembershipRepository(pool)
    const authentication = new AuthenticationRepository(pool)

    const added = await memberships.addMember({
      workspaceId: 'ws', projectId: 'project', actorId: 'owner',
      userId: 'alice', displayName: 'Alice', role: 'operator',
      passwordHash: '$scrypt$membership-test-password-hash-material-that-is-long-enough',
    })
    assert.deepEqual(added.map(({ userId, role }) => [userId, role]), [
      ['owner', 'owner'],
      ['alice', 'operator'],
    ])
    assert.equal(await memberships.getRole('ws', 'project', 'alice'), 'operator')
    assert.deepEqual(await memberships.getAccess('ws', 'project', 'alice'), {
      role: 'operator', archivedAt: null,
    })
    assert.deepEqual(await memberships.getResourceAccess('ws', 'alice', 'conversation', 'project_room'), {
      role: 'operator', archivedAt: null,
    })
    assert.equal(await memberships.getRole('ws', 'sibling', 'alice'), null)
    assert.deepEqual((await authentication.listProjects('ws', 'alice')).map(({ id, role }) => [id, role]), [
      ['project', 'operator'],
    ])
    const roomMember = await database.query(
      "SELECT notifications FROM conversation_members WHERE conversation_id = 'project_room' " +
      "AND participant_kind = 'user' AND participant_id = 'alice'",
    )
    assert.equal(roomMember.rows[0].notifications, true)

    await database.exec(
      "INSERT INTO auth_sessions " +
      "(id, workspace_id, user_id, token_hash, csrf_token_hash, credential_version, source_hash, user_agent_hash, idle_expires_at, expires_at) VALUES " +
      "('alice_session', 'ws', 'alice', repeat('a', 64), repeat('b', 64), 1, repeat('c', 64), repeat('d', 64), NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours')",
    )
    const updated = await memberships.updateRole({
      workspaceId: 'ws', projectId: 'project', actorId: 'owner', userId: 'alice', role: 'viewer',
    })
    assert.equal(updated.find(({ userId }) => userId === 'alice').role, 'viewer')
    assert.equal((await database.query("SELECT role FROM users WHERE id = 'alice'")).rows[0].role, 'viewer')
    assert.ok((await database.query("SELECT revoked_at FROM auth_sessions WHERE id = 'alice_session'")).rows[0].revoked_at)

    await assert.rejects(
      memberships.addMember({
        workspaceId: 'ws', projectId: 'project', actorId: 'alice',
        userId: 'bob', displayName: 'Bob', role: 'operator',
        passwordHash: '$scrypt$membership-test-password-hash-material-that-is-long-enough',
      }),
      (error) => error.code === 'project_owner_required',
    )
    await assert.rejects(
      memberships.updateRole({
        workspaceId: 'ws', projectId: 'project', actorId: 'owner', userId: 'owner', role: 'operator',
      }),
      (error) => error.code === 'last_owner_required',
    )

    const remaining = await memberships.removeMember({
      workspaceId: 'ws', projectId: 'project', actorId: 'owner', userId: 'alice',
    })
    assert.deepEqual(remaining.map(({ userId }) => userId), ['owner'])
    assert.equal(await memberships.getRole('ws', 'project', 'alice'), null)
    assert.deepEqual(await authentication.listProjects('ws', 'alice'), [])
    assert.equal((await database.query(
      "SELECT COUNT(*)::int AS count FROM conversation_members WHERE conversation_id = 'project_room' " +
      "AND participant_kind = 'user' AND participant_id = 'alice'",
    )).rows[0].count, 0)
    assert.deepEqual(
      (await database.query('SELECT kind FROM project_membership_events ORDER BY id')).rows.map(({ kind }) => kind),
      ['member_added', 'role_changed', 'member_removed'],
    )
  } finally {
    await database.close()
  }
})

test('Project Membership Repository resolves indirect resources to one Project lifecycle boundary', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    await database.exec(
      "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
      "('builder', 'ws', 'Builder', 'builder', 'test', 'test'), " +
      "('reviewer', 'ws', 'Reviewer', 'reviewer', 'test', 'test'), " +
      "('planner', 'ws', 'Planner', 'planner', 'test', 'test');" +
      "INSERT INTO conversation_members (conversation_id, workspace_id, participant_kind, participant_id) " +
      "VALUES ('project_room', 'ws', 'agent', 'builder'), ('project_room', 'ws', 'agent', 'planner');" +
      "INSERT INTO messages (id, workspace_id, conversation_id, author_kind, author_id, body) " +
      "VALUES ('source_message', 'ws', 'project_room', 'user', 'owner', 'Plan this work');" +
      "INSERT INTO missions (id, workspace_id, project_id, conversation_id, title, goal, status, created_by, source_message_ids) VALUES " +
      "('mission', 'ws', 'project', 'project_room', 'Mission', 'Goal', 'running', 'owner', ARRAY[]::text[]), " +
      "('planning_mission', 'ws', 'project', 'project_room', 'Planning', 'Goal', 'planning', 'owner', ARRAY['source_message']);" +
      "INSERT INTO tasks (id, mission_id, title, status) VALUES ('task', 'mission', 'Task', 'running');" +
      "INSERT INTO agent_runs (id, workspace_id, mission_id, task_id, agent_id, attempt, status) " +
      "VALUES ('run', 'ws', 'mission', 'task', 'builder', 1, 'running');" +
      "INSERT INTO artifacts (id, workspace_id, project_id, mission_id, title, created_by) " +
      "VALUES ('artifact', 'ws', 'project', 'mission', 'Artifact', 'owner');" +
      "INSERT INTO artifact_versions " +
      "(id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash, created_by_run_id) " +
      "VALUES ('version', 'artifact', 1, '{}'::jsonb, decode('00', 'hex'), repeat('a', 64), repeat('b', 64), 'run');" +
      "INSERT INTO task_submissions " +
      "(id, workspace_id, mission_id, task_id, run_id, artifact_version_id, submitted_by_agent_id, evidence_bundle_hash) " +
      "VALUES ('submission', 'ws', 'mission', 'task', 'run', 'version', 'builder', repeat('c', 64));" +
      "INSERT INTO reviews " +
      "(id, workspace_id, mission_id, task_id, submission_id, reviewer_agent_id, status) " +
      "VALUES ('review', 'ws', 'mission', 'task', 'submission', 'reviewer', 'requested');" +
      "INSERT INTO approvals " +
      "(id, workspace_id, mission_id, subject_type, subject_id, kind, requested_by, reason) " +
      "VALUES ('approval', 'ws', 'mission', 'mission', 'mission', 'plan', 'owner', 'Test');" +
      "INSERT INTO conversation_planning_requests " +
      "(id, workspace_id, project_id, conversation_id, mission_id, planner_agent_id, source_message_ids, request_hash, created_by) " +
      "VALUES ('planning_request', 'ws', 'project', 'project_room', 'planning_mission', 'planner', ARRAY['source_message'], repeat('d', 64), 'owner')",
    )
    const memberships = new ProjectMembershipRepository(poolAdapter(database))
    for (const [kind, id] of [
      ['mission', 'mission'],
      ['run', 'run'],
      ['artifact', 'artifact'],
      ['artifact_version', 'version'],
      ['conversation', 'project_room'],
      ['planning_request', 'planning_request'],
      ['approval', 'approval'],
      ['agent', 'builder'],
      ['review', 'review'],
      ['submission', 'submission'],
    ]) {
      assert.deepEqual(await memberships.getResourceAccess('ws', 'owner', kind, id), {
        role: 'owner', archivedAt: null,
      })
    }
    await database.exec(
      "UPDATE projects SET archived_at = NOW(), archived_by = 'owner' WHERE id = 'project'",
    )
    assert.ok((await memberships.getResourceAccess('ws', 'owner', 'approval', 'approval')).archivedAt)
  } finally {
    await database.close()
  }
})

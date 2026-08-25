import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import {
  MissionRepository,
  SchedulerRepository,
  TaskRepository,
} from '../dist/index.js'

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
]

function poolAdapter(database) {
  let queryInFlight = false
  const client = {
    async query(statement, params = []) {
      if (queryInFlight) throw new Error('Concurrent queries on one transaction client are forbidden')
      queryInFlight = true
      try {
        const result = await database.query(statement, params)
        return {
          ...result,
          rowCount: result.affectedRows ?? result.rows.length,
        }
      } finally {
        queryInFlight = false
      }
    },
    release() {},
  }
  return {
    async connect() {
      return client
    },
    query: client.query,
  }
}

async function applyMigrations(database) {
  for (const url of migrationUrls) {
    await database.exec(await readFile(url, 'utf8'))
  }
}

test('mission approval routes ready DAG tasks by role and requires a Dispatch Token', async () => {
  const database = new PGlite()
  try {
    await applyMigrations(database)
    await database.exec(
      "INSERT INTO workspaces (id, name) VALUES ('ws_flow', 'Flow');" +
      "INSERT INTO projects (id, workspace_id, name) VALUES ('project_flow', 'ws_flow', 'Project');" +
      "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) VALUES " +
      "('planner_flow', 'ws_flow', 'Planner', 'planner', 'test', 'test'), " +
      "('researcher_flow', 'ws_flow', 'Researcher', 'researcher', 'test', 'test'), " +
      "('builder_flow', 'ws_flow', 'Builder', 'builder', 'test', 'test'), " +
      "('reviewer_flow', 'ws_flow', 'Reviewer', 'reviewer', 'test', 'test');",
    )
    const pool = poolAdapter(database)
    const missions = new MissionRepository(pool)
    const scheduler = new SchedulerRepository(pool)
    const tasks = new TaskRepository(pool)

    const missionId = await missions.createMission({
      missionId: 'mission_flow',
      workspaceId: 'ws_flow',
      projectId: 'project_flow',
      title: 'Implement feature',
      goal: 'Implement and verify a feature.',
      actor: { kind: 'user', id: 'user_flow' },
      correlationId: 'correlation_create',
    })
    assert.equal(missionId, 'mission_flow')
    const missionArtifact = await database.query(
      "SELECT mission_id, kind, title FROM artifacts WHERE mission_id = 'mission_flow'",
    )
    assert.deepEqual(missionArtifact.rows, [{
      mission_id: 'mission_flow',
      kind: 'mission_deliverable',
      title: 'Implement feature · Mission 交付物',
    }])

    const plan = {
      summary: 'Research and build in parallel, then review.',
      tasks: [
        {
          key: 'research',
          title: 'Research',
          description: 'Analyze the repository and constraints.',
          role: 'researcher',
          priority: 5,
          dependsOn: [],
          reviewRequired: false,
          acceptanceCriteria: [],
        },
        {
          key: 'build',
          title: 'Build',
          description: 'Implement the feature.',
          role: 'builder',
          priority: 10,
          dependsOn: [],
          reviewRequired: true,
          acceptanceCriteria: [
            {
              key: 'tests',
              description: 'Tests pass.',
              required: true,
              evidenceKinds: ['test_run'],
            },
          ],
        },
        {
          key: 'review',
          title: 'Review',
          description: 'Review the frozen submission.',
          role: 'reviewer',
          priority: 20,
          dependsOn: ['research', 'build'],
          reviewRequired: false,
          acceptanceCriteria: [],
        },
      ],
    }
    const proposed = await missions.proposePlan({
      workspaceId: 'ws_flow',
      missionId,
      plan,
      actor: { kind: 'agent', id: 'planner_flow' },
      correlationId: 'correlation_plan',
    })
    assert.equal(proposed.proposed, true)
    assert.equal(proposed.version, 1)

    const approved = await missions.approvePlan({
      workspaceId: 'ws_flow',
      missionId,
      expectedVersion: 1,
      approvedBy: 'user_flow',
      correlationId: 'correlation_approve',
    })
    assert.equal(approved.approved, true)
    if (!approved.approved) throw new Error('Plan was not approved')

    const researchTaskId = approved.taskIdsByKey.research
    const buildTaskId = approved.taskIdsByKey.build
    const reviewTaskId = approved.taskIdsByKey.review
    assert.ok(researchTaskId)
    assert.ok(buildTaskId)
    assert.ok(reviewTaskId)
    const states = await database.query(
      'SELECT id, status FROM tasks WHERE mission_id = $1 ORDER BY position',
      [missionId],
    )
    assert.deepEqual(states.rows, [
      { id: researchTaskId, status: 'ready' },
      { id: buildTaskId, status: 'ready' },
      { id: reviewTaskId, status: 'blocked' },
    ])

    const dispatches = await scheduler.dispatchReadyTasks({
      limit: 10,
      dispatchSeconds: 60,
      correlationId: 'correlation_dispatch',
    })
    assert.equal(dispatches.length, 2)
    assert.deepEqual(
      new Set(dispatches.map((item) => item.agentId)),
      new Set(['researcher_flow', 'builder_flow']),
    )
    const dispatch = dispatches.find((item) => item.taskId === buildTaskId)
    assert.ok(dispatch)
    assert.equal(dispatch.agentId, 'builder_flow')
    assert.equal(dispatch.taskId, buildTaskId)

    const wrongToken = await tasks.claimTask({
      workspaceId: 'ws_flow',
      missionId,
      taskId: buildTaskId,
      agentId: 'builder_flow',
      runId: 'run_wrong',
      correlationId: 'correlation_claim_wrong',
      dispatchToken: 'wrong',
      leaseSeconds: 60,
    })
    assert.deepEqual(wrongToken, { claimed: false, reason: 'not_claimable' })

    const claimed = await tasks.claimTask({
      workspaceId: 'ws_flow',
      missionId,
      taskId: buildTaskId,
      agentId: 'builder_flow',
      runId: 'run_flow',
      correlationId: 'correlation_claim',
      dispatchToken: dispatch.dispatchToken,
      leaseSeconds: 60,
    })
    assert.equal(claimed.claimed, true)

    const durable = await database.query(
      'SELECT ' +
      "(SELECT status FROM task_dispatches WHERE task_id = $1) AS dispatch_status, " +
      "(SELECT status FROM approvals WHERE mission_id = $2 AND kind = 'mission_plan:1') AS approval_status, " +
      "(SELECT COUNT(*)::int FROM inbox_messages WHERE agent_id = 'builder_flow') AS inbox_count, " +
      "(SELECT COUNT(*)::int FROM task_leases WHERE task_id = $1) AS lease_count",
      [buildTaskId, missionId],
    )
    assert.deepEqual(durable.rows[0], {
      dispatch_status: 'consumed',
      approval_status: 'approved',
      inbox_count: 1,
      lease_count: 1,
    })
  } finally {
    await database.close()
  }
})

test('final human approval binds the exact Artifact Version before completing a Mission', async () => {
  const database = new PGlite()
  try {
    await applyMigrations(database)
    await database.exec(
      "INSERT INTO workspaces (id, name) VALUES ('ws_delivery', 'Delivery');" +
      "INSERT INTO projects (id, workspace_id, name) VALUES ('project_delivery', 'ws_delivery', 'Project');" +
      "INSERT INTO users (id, workspace_id, display_name) VALUES ('user_delivery', 'ws_delivery', 'Operator');",
    )
    const missions = new MissionRepository(poolAdapter(database))
    const missionId = await missions.createMission({
      missionId: 'mission_delivery', workspaceId: 'ws_delivery', projectId: 'project_delivery',
      title: 'Deliver exact version', goal: 'Finish only after exact-version approval.',
      actor: { kind: 'user', id: 'user_delivery' }, correlationId: 'delivery_create',
    })
    await missions.proposePlan({
      workspaceId: 'ws_delivery', missionId,
      plan: {
        summary: 'One verified task.',
        tasks: [{
          key: 'deliver', title: 'Deliver', description: '', role: 'builder', priority: 1,
          dependsOn: [], reviewRequired: false, acceptanceCriteria: [],
        }],
      },
      actor: { kind: 'user', id: 'user_delivery' }, correlationId: 'delivery_plan',
    })
    const approvedPlan = await missions.approvePlan({
      workspaceId: 'ws_delivery', missionId, expectedVersion: 1,
      approvedBy: 'user_delivery', correlationId: 'delivery_plan_approve',
    })
    assert.equal(approvedPlan.approved, true)
    await database.query("UPDATE tasks SET status = 'completed' WHERE mission_id = $1", [missionId])
    await database.query("UPDATE missions SET status = 'reviewing' WHERE id = $1", [missionId])

    const artifact = await database.query("SELECT id FROM artifacts WHERE mission_id = $1", [missionId])
    const artifactId = artifact.rows[0].id
    await database.query(
      'INSERT INTO artifact_versions ' +
      '(id, artifact_id, version, content, yjs_state_bytes, content_hash, yjs_state_hash, created_by_kind, created_by_id) ' +
      "VALUES ('version_delivery', $1, 1, '{}'::jsonb, $2, 'content-hash', 'state-hash', 'user', 'user_delivery')",
      [artifactId, Buffer.from([1])],
    )
    const ready = await missions.getMission('ws_delivery', missionId)
    assert.equal(ready.finalDelivery.artifactVersionId, 'version_delivery')
    assert.equal(ready.finalDelivery.approvalStatus, 'ready')

    const stale = await missions.approveDelivery({
      workspaceId: 'ws_delivery', missionId, expectedArtifactVersionId: 'version_stale',
      approvedBy: 'user_delivery', correlationId: 'delivery_stale',
    })
    assert.deepEqual(stale, { approved: false, reason: 'version_conflict' })
    const completed = await missions.approveDelivery({
      workspaceId: 'ws_delivery', missionId, expectedArtifactVersionId: 'version_delivery',
      approvedBy: 'user_delivery', correlationId: 'delivery_approve',
    })
    assert.deepEqual(completed, {
      approved: true, artifactVersionId: 'version_delivery', reused: false,
    })
    const replay = await missions.approveDelivery({
      workspaceId: 'ws_delivery', missionId, expectedArtifactVersionId: 'version_delivery',
      approvedBy: 'user_delivery', correlationId: 'delivery_replay',
    })
    assert.deepEqual(replay, {
      approved: true, artifactVersionId: 'version_delivery', reused: true,
    })
    const stored = await missions.getMission('ws_delivery', missionId)
    assert.equal(stored.status, 'completed')
    assert.equal(stored.finalDelivery.approvalStatus, 'approved')
    assert.equal(stored.finalDelivery.approvedBy, 'user_delivery')
  } finally {
    await database.close()
  }
})

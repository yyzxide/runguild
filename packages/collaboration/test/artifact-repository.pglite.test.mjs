import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import * as Y from 'yjs'

import { ArtifactEditor, ArtifactRepository } from '../dist/index.js'

const migrationUrls = [
  new URL('../../database/migrations/0001_core.sql', import.meta.url),
  new URL('../../database/migrations/0002_orchestration.sql', import.meta.url),
  new URL('../../database/migrations/0003_runtime.sql', import.meta.url),
  new URL('../../database/migrations/0004_execution.sql', import.meta.url),
  new URL('../../database/migrations/0005_artifacts.sql', import.meta.url),
  new URL('../../database/migrations/0006_reviews.sql', import.meta.url),
  new URL('../../database/migrations/0007_worktrees.sql', import.meta.url),
  new URL('../../database/migrations/0008_context.sql', import.meta.url),
  new URL('../../database/migrations/0009_evaluation.sql', import.meta.url),
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
    "INSERT INTO workspaces (id, name) VALUES ('ws_collab', 'Collaboration'), ('ws_other', 'Other');" +
    "INSERT INTO users (id, workspace_id, display_name) VALUES ('user_editor', 'ws_collab', 'Editor');" +
    "INSERT INTO projects (id, workspace_id, name) VALUES " +
    "('project_collab', 'ws_collab', 'Project'), ('project_other', 'ws_other', 'Other');" +
    "INSERT INTO agents (id, workspace_id, name, role, model_provider, model_name) " +
    "VALUES ('agent_collab', 'ws_collab', 'Builder', 'builder', 'openai', 'test-model');" +
    "INSERT INTO missions (id, workspace_id, project_id, title, goal, status, created_by) VALUES " +
    "('mission_collab', 'ws_collab', 'project_collab', 'Mission', 'Write together', 'running', 'user_editor');" +
    "INSERT INTO tasks (id, mission_id, title, status, attempt_count) " +
    "VALUES ('task_collab', 'mission_collab', 'Write', 'running', 1);" +
    "INSERT INTO agent_runs " +
    "(id, workspace_id, mission_id, task_id, agent_id, attempt, status) " +
    "VALUES ('run_collab', 'ws_collab', 'mission_collab', 'task_collab', 'agent_collab', 1, 'running');",
  )
}

function paragraphUpdate(text) {
  const document = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const content = new Y.XmlText()
  content.insert(0, text)
  paragraph.insert(0, [content])
  document.getXmlFragment('prosemirror').insert(0, [paragraph])
  const update = Y.encodeStateAsUpdate(document)
  document.destroy()
  return update
}

function visibleText(content) {
  if (Array.isArray(content)) return content.map(visibleText).join('')
  if (!content || typeof content !== 'object') return ''
  return (typeof content.text === 'string' ? content.text : '') + visibleText(content.content ?? [])
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('concurrent Yjs updates converge, deduplicate, compact, and support differential sync', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ArtifactRepository(poolAdapter(database))
    const artifact = await repository.create({
      artifactId: 'artifact_collab',
      workspaceId: 'ws_collab',
      projectId: 'project_collab',
      missionId: 'mission_collab',
      title: 'Shared report',
      createdBy: 'user_editor',
    })
    assert.equal(artifact.id, 'artifact_collab')

    const alice = paragraphUpdate('Alice')
    const bob = paragraphUpdate('Bob')
    const first = await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
      update: alice,
      origin: { kind: 'user', userId: 'user_editor', sessionId: 'alice-session' },
    })
    const replay = await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
      update: alice,
      origin: { kind: 'user', userId: 'user_editor', sessionId: 'relay-session' },
    })
    const second = await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
      update: bob,
      origin: { kind: 'user', userId: 'user_editor', sessionId: 'bob-session' },
    })
    assert.equal(first.inserted, true)
    assert.deepEqual(replay, { ...first, inserted: false })
    assert.equal(second.inserted, true)

    const state = await repository.syncState({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
    })
    const converged = new Y.Doc()
    Y.applyUpdate(converged, state.update)
    const text = visibleText(yDocToProsemirrorJSON(converged))
    assert.equal(text.includes('Alice'), true)
    assert.equal(text.includes('Bob'), true)
    assert.equal(hash(Y.encodeStateAsUpdate(converged)), state.stateHash)

    const compacted = await repository.compact({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
    })
    assert.equal(compacted.compacted, true)
    assert.equal(compacted.updatesApplied, 2)
    assert.equal(compacted.throughUpdateSeq, state.throughUpdateSeq)
    const unchanged = await repository.compact({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
    })
    assert.equal(unchanged.compacted, false)
    assert.equal(unchanged.updatesApplied, 0)

    let laterUpdate
    converged.on('update', (update, origin) => {
      if (origin === 'later') laterUpdate = update
    })
    converged.transact(() => {
      const paragraph = new Y.XmlElement('paragraph')
      const content = new Y.XmlText()
      content.insert(0, 'Later')
      paragraph.insert(0, [content])
      converged.getXmlFragment('prosemirror').push([paragraph])
    }, 'later')
    assert.ok(laterUpdate)
    await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
      update: laterUpdate,
      origin: { kind: 'user', userId: 'user_editor', sessionId: 'alice-session' },
    })
    const differential = await repository.syncState({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_collab',
      remoteStateVector: state.stateVector,
    })
    const previous = new Y.Doc()
    Y.applyUpdate(previous, state.update)
    Y.applyUpdate(previous, differential.update)
    assert.equal(visibleText(yDocToProsemirrorJSON(previous)).includes('Later'), true)

    const rows = await database.query(
      "SELECT COUNT(*)::int AS updates, " +
      "(SELECT through_update_seq::text FROM artifact_yjs_snapshots " +
      "WHERE artifact_id = 'artifact_collab') AS snapshot_through " +
      "FROM artifact_yjs_updates WHERE artifact_id = 'artifact_collab'",
    )
    assert.deepEqual(rows.rows[0], {
      updates: 3,
      snapshot_through: state.throughUpdateSeq.toString(),
    })
    converged.destroy()
    previous.destroy()
  } finally {
    await database.close()
  }
})

test('Artifact Versions freeze exact Yjs state and remain unchanged after later edits', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ArtifactRepository(poolAdapter(database))
    await repository.create({
      artifactId: 'artifact_versions',
      workspaceId: 'ws_collab',
      projectId: 'project_collab',
      missionId: 'mission_collab',
      title: 'Versioned report',
      createdBy: 'user_editor',
    })
    await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_versions',
      update: paragraphUpdate('Version one'),
      origin: { kind: 'user', userId: 'user_editor', sessionId: 'version-session' },
    })
    const versionOne = await repository.createVersion({
      versionId: 'artifact_version_one',
      workspaceId: 'ws_collab',
      artifactId: 'artifact_versions',
      createdBy: { kind: 'user', id: 'user_editor' },
    })
    assert.equal(versionOne.version, 1)
    assert.equal(visibleText(versionOne.content), 'Version one')
    assert.equal(hash(versionOne.yjsState), versionOne.yjsStateHash)

    const live = new Y.Doc()
    Y.applyUpdate(live, versionOne.yjsState)
    let change
    live.on('update', (update, origin) => {
      if (origin === 'append') change = update
    })
    live.transact(() => {
      const paragraph = new Y.XmlElement('paragraph')
      const content = new Y.XmlText()
      content.insert(0, 'Version two')
      paragraph.insert(0, [content])
      live.getXmlFragment('prosemirror').push([paragraph])
    }, 'append')
    assert.ok(change)
    await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_versions',
      update: change,
      origin: { kind: 'user', userId: 'user_editor', sessionId: 'version-session' },
    })
    const versionTwo = await repository.createVersion({
      versionId: 'artifact_version_two',
      workspaceId: 'ws_collab',
      artifactId: 'artifact_versions',
      createdBy: { kind: 'user', id: 'user_editor' },
    })
    assert.equal(versionTwo.version, 2)
    assert.equal(visibleText(versionTwo.content), 'Version oneVersion two')
    assert.notEqual(versionTwo.yjsStateHash, versionOne.yjsStateHash)

    const frozen = await repository.readVersion({
      workspaceId: 'ws_collab',
      versionId: 'artifact_version_one',
    })
    assert.ok(frozen)
    assert.equal(visibleText(frozen.content), 'Version one')
    assert.equal(frozen.yjsStateHash, versionOne.yjsStateHash)
    assert.deepEqual([...frozen.yjsState], [...versionOne.yjsState])

    const replay = await repository.createVersion({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_versions',
      createdBy: { kind: 'user', id: 'user_editor' },
    })
    assert.equal(replay.id, versionTwo.id)
    await assert.rejects(
      database.query(
        "UPDATE artifact_versions SET content = '{\"type\":\"doc\"}'::jsonb " +
        "WHERE id = 'artifact_version_one'",
      ),
      /immutable/,
    )
    live.destroy()
  } finally {
    await database.close()
  }
})

test('Artifact scope rejects cross-workspace projects, reads, and spoofed Agent origins', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ArtifactRepository(poolAdapter(database))
    await repository.authorizeActor({
      workspaceId: 'ws_collab',
      actor: { kind: 'user', id: 'user_editor' },
    })
    await repository.authorizeActor({
      workspaceId: 'ws_collab',
      actor: { kind: 'agent', id: 'agent_collab' },
    })
    await assert.rejects(repository.authorizeActor({
      workspaceId: 'ws_other',
      actor: { kind: 'user', id: 'user_editor' },
    }), /outside the workspace/)
    await assert.rejects(repository.create({
      artifactId: 'artifact_bad_scope',
      workspaceId: 'ws_collab',
      projectId: 'project_other',
      title: 'Invalid',
      createdBy: 'user_editor',
    }))
    await repository.create({
      artifactId: 'artifact_private',
      workspaceId: 'ws_collab',
      projectId: 'project_collab',
      title: 'Private',
      createdBy: 'user_editor',
    })
    await assert.rejects(repository.syncState({
      workspaceId: 'ws_other',
      artifactId: 'artifact_private',
    }), /not found in workspace/)

    await repository.create({
      artifactId: 'artifact_agent',
      workspaceId: 'ws_collab',
      projectId: 'project_collab',
      missionId: 'mission_collab',
      title: 'Agent report',
      createdBy: 'agent_collab',
    })
    await assert.rejects(repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_agent',
      update: paragraphUpdate('Spoofed'),
      origin: {
        kind: 'agent',
        agentId: 'agent_collab',
        runId: 'run_collab',
        taskId: 'task_spoofed',
        toolCallId: 'call_spoofed',
        intent: 'spoof task scope',
      },
    }), /outside the Artifact mission scope/)
    await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_agent',
      update: paragraphUpdate('Verified Agent'),
      origin: {
        kind: 'agent',
        agentId: 'agent_collab',
        runId: 'run_collab',
        taskId: 'task_collab',
        toolCallId: 'call_agent',
        intent: 'write verified content',
      },
    })
    const agentVersion = await repository.createVersion({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_agent',
      createdBy: { kind: 'agent', id: 'agent_collab', runId: 'run_collab' },
    })
    assert.equal(agentVersion.createdByRunId, 'run_collab')
    await assert.rejects(repository.createVersion({
      versionId: 'artifact_version_spoofed',
      workspaceId: 'ws_collab',
      artifactId: 'artifact_agent',
      createdBy: { kind: 'agent', id: 'agent_spoofed', runId: 'run_collab' },
    }), /outside Artifact scope/)
  } finally {
    await database.close()
  }
})

test('Agent semantic Artifact edits use stable block ids, converge, comment, and replay safely', async () => {
  const database = new PGlite()
  try {
    await setup(database)
    const repository = new ArtifactRepository(poolAdapter(database))
    const editor = new ArtifactEditor(repository)
    await repository.create({
      artifactId: 'artifact_semantic',
      workspaceId: 'ws_collab',
      projectId: 'project_collab',
      missionId: 'mission_collab',
      title: 'Semantic report',
      createdBy: 'user_editor',
    })
    await repository.appendUpdate({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_semantic',
      update: paragraphUpdate('Human introduction'),
      origin: { kind: 'user', userId: 'user_editor', sessionId: 'semantic-human' },
    })
    const sectionOrigin = {
      kind: 'agent',
      agentId: 'agent_collab',
      runId: 'run_collab',
      taskId: 'task_collab',
      toolCallId: 'call_semantic_section',
      intent: 'add verified findings',
    }
    const section = await editor.apply({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_semantic',
      origin: sectionOrigin,
      operations: [{ kind: 'insert_section', heading: 'Findings', content: 'Initial evidence.' }],
    })
    assert.equal(section.applied, true)
    assert.equal(section.changedBlockIds.length, 2)

    const replay = await editor.apply({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_semantic',
      origin: sectionOrigin,
      operations: [{ kind: 'insert_section', heading: 'Findings', content: 'Initial evidence.' }],
    })
    assert.equal(replay.applied, false)
    assert.deepEqual(replay.changedBlockIds, [])

    const beforeConcurrent = await editor.read({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_semantic',
    })
    assert.equal(visibleText(beforeConcurrent.document), 'Human introductionFindingsInitial evidence.')
    const heading = beforeConcurrent.document.content.find((block) => block.type === 'heading')
    assert.ok(heading?.attrs?.blockId)

    const [research, review] = await Promise.all([
      editor.apply({
        workspaceId: 'ws_collab',
        artifactId: 'artifact_semantic',
        origin: { ...sectionOrigin, toolCallId: 'call_semantic_research', intent: 'append research' },
        operations: [{ kind: 'append_content', content: 'Research contribution.' }],
      }),
      editor.apply({
        workspaceId: 'ws_collab',
        artifactId: 'artifact_semantic',
        origin: { ...sectionOrigin, toolCallId: 'call_semantic_review', intent: 'append review' },
        operations: [{ kind: 'append_content', content: 'Reviewer contribution.' }],
      }),
    ])
    assert.equal(research.applied, true)
    assert.equal(review.applied, true)

    await editor.apply({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_semantic',
      origin: { ...sectionOrigin, toolCallId: 'call_semantic_replace', intent: 'correct heading' },
      operations: [{
        kind: 'replace_block',
        blockId: heading.attrs.blockId,
        content: 'Verified findings',
      }],
    })
    await editor.apply({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_semantic',
      origin: { ...sectionOrigin, toolCallId: 'call_semantic_comment', intent: 'request citation' },
      operations: [{
        kind: 'add_comment',
        blockId: heading.attrs.blockId,
        body: 'Attach the source evidence.',
      }],
    })
    const final = await editor.read({
      workspaceId: 'ws_collab',
      artifactId: 'artifact_semantic',
    })
    const text = visibleText(final.document)
    assert.equal(text.includes('Verified findings'), true)
    assert.equal(text.includes('Research contribution.'), true)
    assert.equal(text.includes('Reviewer contribution.'), true)
    assert.equal(Object.values(final.comments)[0].body, 'Attach the source evidence.')
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { ArtifactReviewer, reviewMessages } from '../dist/artifact-reviewer.js'

const decision = {
  decision: 'approved',
  summary: 'The exact version and evidence satisfy the Task.',
  findings: [{ severity: 'info', summary: 'Required evidence is present.', evidenceIds: ['evidence_1'] }],
}

function work(storedDecision) {
  return {
    reviewId: 'review_1',
    workspaceId: 'ws_1',
    missionId: 'mission_1',
    taskId: 'task_1',
    submissionId: 'submission_1',
    reviewerAgentId: 'agent_reviewer',
    leaseToken: 'lease_1',
    attempt: 1,
    maxAttempts: 3,
    modelProvider: 'openai',
    modelName: 'review-model',
    materials: {
      schemaVersion: 1,
      mission: { id: 'mission_1', title: 'Mission', goal: 'Ship it', constraints: [] },
      task: { id: 'task_1', title: 'Build', description: 'Implement it', acceptanceCriteria: [] },
      submission: {
        id: 'submission_1', note: 'Ready', evidenceBundleHash: 'a'.repeat(64),
        submittedByAgentId: 'agent_builder',
      },
      artifactVersion: {
        id: 'version_1', artifactId: 'artifact_1', title: 'Delivery', kind: 'mission_deliverable',
        contentHash: 'b'.repeat(64), content: { type: 'doc' },
      },
      worktree: null,
      evidence: [{
        id: 'evidence_1', kind: 'artifact_version', uri: 'artifact-version://version_1',
        contentHash: 'b'.repeat(64), metadata: {},
      }],
      successfulToolResults: [],
    },
    ...(storedDecision ? { storedDecision } : {}),
  }
}

test('Artifact Reviewer persists one model decision before recording the independent Review', async () => {
  const calls = []
  const reviewer = new ArtifactReviewer({
    executions: {
      async claim() { return { kind: 'work', work: work() } },
      async completeModel(input) { calls.push(['model.persisted', input]) },
      async renew() { return true },
      async complete() { calls.push(['execution.completed']) },
      async fail(input) { calls.push(['failed', input.message]); return { retryable: false } },
    },
    reviews: {
      async reviewSubmission(input) { calls.push(['review.recorded', input.decision]); return {} },
    },
    modelFor() {
      return {
        provider: 'openai', model: 'review-model',
        async complete(request) {
          calls.push(['model.called', request.tools[0].action])
          assert.equal(request.toolChoice, 'required')
          assert.equal(request.parallelToolCalls, false)
          assert.equal(request.reasoningEffort, 'none')
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', action: 'review.submit_decision', input: decision }],
            usage: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 45, estimatedCostUsd: 0.01 },
            providerRequestId: 'response_1',
          }
        },
      }
    },
  })

  assert.equal(await reviewer.process({
    schemaVersion: 1, type: 'artifact.review_requested', reviewId: 'review_1',
    submissionId: 'submission_1', missionId: 'mission_1', taskId: 'task_1',
  }, 'agent_reviewer'), 'processed')
  assert.deepEqual(calls.map((call) => call[0]), [
    'model.called', 'model.persisted', 'review.recorded', 'execution.completed',
  ])
  assert.equal(calls[1][1].cachedInputTokens, 45)
})

test('Artifact Reviewer persists an invalid model response before exhausting its retry', async () => {
  const calls = []
  const reviewer = new ArtifactReviewer({
    executions: {
      async claim() { return { kind: 'work', work: work() } },
      async completeModel() { throw new Error('invalid response must not complete the model gate') },
      async recordInvalidModelResponse(input) {
        calls.push(['invalid.persisted', input])
      },
      async renew() { return true },
      async complete() { throw new Error('invalid response must not complete the execution') },
      async fail(input) { calls.push(['failed', input.message]); return { retryable: false } },
    },
    reviews: { async reviewSubmission() { throw new Error('invalid response must not create a Review decision') } },
    modelFor() {
      return {
        provider: 'openai', model: 'review-model',
        async complete() {
          return {
            content: 'I approve this submission in prose.',
            finishReason: 'stop',
            toolCalls: [],
            usage: { inputTokens: 321, outputTokens: 17, cachedInputTokens: 120 },
            providerRequestId: 'response_invalid',
          }
        },
      }
    },
  })

  assert.equal(await reviewer.process({
    schemaVersion: 1, type: 'artifact.review_requested', reviewId: 'review_1',
    submissionId: 'submission_1', missionId: 'mission_1', taskId: 'task_1',
  }, 'agent_reviewer'), 'processed')
  assert.deepEqual(calls.map((call) => call[0]), ['invalid.persisted', 'failed'])
  assert.equal(calls[0][1].responseSnapshot.finishReason, 'stop')
  assert.equal(calls[0][1].responseSnapshot.content, 'I approve this submission in prose.')
  assert.deepEqual(calls[0][1].responseSnapshot.toolCalls, [])
  assert.equal(calls[0][1].providerRequestId, 'response_invalid')
  assert.equal(calls[0][1].inputTokens, 321)
  assert.equal(calls[0][1].cachedInputTokens, 120)
  assert.match(calls[1][1], /exactly once/)
})

test('Artifact Reviewer resumes a stored decision without a second model call', async () => {
  let modelCalls = 0
  const reviewer = new ArtifactReviewer({
    executions: {
      async claim() { return { kind: 'work', work: work(decision) } },
      async completeModel() { throw new Error('must not persist twice') },
      async renew() { return true },
      async complete() {},
      async fail() { return { retryable: false } },
    },
    reviews: { async reviewSubmission(input) { assert.equal(input.decision, 'approved'); return {} } },
    modelFor() { modelCalls += 1; throw new Error('must not create model') },
  })
  assert.equal(await reviewer.process({
    schemaVersion: 1, type: 'artifact.review_requested', reviewId: 'review_1',
    submissionId: 'submission_1', missionId: 'mission_1', taskId: 'task_1',
  }, 'agent_reviewer'), 'processed')
  assert.equal(modelCalls, 0)
})

test('Reviewer prompt treats frozen Artifact and diff content as untrusted evidence', () => {
  const messages = reviewMessages(work().materials)
  assert.match(messages[0].content, /untrusted data/)
  assert.match(messages[0].content, /exact diff is unavailable/)
  assert.match(messages[0].content, /review\.submit_decision exactly once/)
  assert.match(messages[1].content, /version_1/)
})

test('Reviewer prompt compacts repeated content-addressed Evidence without losing ids or provenance', () => {
  const diff = 'large-exact-diff-'.repeat(5_000)
  const materials = work().materials
  const repeated = Array.from({ length: 10 }, (_, index) => ({
    id: `evidence_diff_${index}`,
    kind: 'file_diff',
    uri: 'git-diff://commit_1#diff_hash',
    contentHash: 'diff_hash',
    metadata: {
      diff,
      commit: 'commit_1',
      treeHash: 'tree_1',
      toolCallId: index < 5 ? 'call_original' : 'call_recovered',
      recovered: index >= 5,
    },
    producerRunId: index < 5 ? 'run_original' : 'run_recovered',
    producerRunStatus: 'succeeded',
    producerAttempt: index < 5 ? 1 : 2,
    createdAt: `2026-08-28T00:00:${String(index).padStart(2, '0')}.000Z`,
  }))

  const messages = reviewMessages({ ...materials, evidence: repeated })
  const prompt = messages[1].content
  assert.equal(prompt.split(diff).length - 1, 1)
  for (const item of repeated) assert.match(prompt, new RegExp(item.id))
  assert.match(prompt, /run_original/)
  assert.match(prompt, /run_recovered/)
  assert.match(prompt, /call_original/)
  assert.match(prompt, /call_recovered/)
  assert.ok(Buffer.byteLength(prompt, 'utf8') < 512 * 1024)
})

test('Reviewer prompt still rejects one genuinely oversized unique Evidence payload', () => {
  const materials = work().materials
  assert.throws(() => reviewMessages({
    ...materials,
    evidence: [{
      id: 'evidence_unique_large',
      kind: 'file_diff',
      uri: 'git-diff://commit_1#unique_diff_hash',
      contentHash: 'unique_diff_hash',
      metadata: { diff: 'x'.repeat(520 * 1024) },
      producerRunId: 'run_1',
      producerRunStatus: 'succeeded',
      producerAttempt: 1,
      createdAt: '2026-08-28T00:00:00.000Z',
    }],
  }), /512 KiB model-input safety limit/)
})

test('Worker ownership loss aborts an active Reviewer model call and releases it for retry', async () => {
  let modelStarted
  const started = new Promise((resolve) => { modelStarted = resolve })
  const failures = []
  const reviewer = new ArtifactReviewer({
    executions: {
      async claim() { return { kind: 'work', work: work() } },
      async completeModel() { throw new Error('not expected') },
      async renew() { return true },
      async complete() { throw new Error('not expected') },
      async fail(input) { failures.push(input.message); return { retryable: true } },
    },
    reviews: { async reviewSubmission() { throw new Error('not expected') } },
    modelFor() {
      return {
        provider: 'openai', model: 'review-model',
        async complete(request) {
          modelStarted()
          return new Promise((_resolve, reject) => {
            request.abortSignal.addEventListener(
              'abort',
              () => reject(request.abortSignal.reason),
              { once: true },
            )
          })
        },
      }
    },
  })
  const controller = new AbortController()
  const processing = reviewer.process({
    schemaVersion: 1, type: 'artifact.review_requested', reviewId: 'review_1',
    submissionId: 'submission_1', missionId: 'mission_1', taskId: 'task_1',
  }, 'agent_reviewer', controller.signal)
  await started
  controller.abort(new Error('Reviewer Worker ownership was lost'))
  await assert.rejects(processing, /Reviewer Worker ownership was lost/)
  assert.deepEqual(failures, ['Reviewer Worker ownership was lost'])
})

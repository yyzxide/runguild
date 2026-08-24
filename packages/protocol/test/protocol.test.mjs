import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InvalidTransitionError,
  assertTaskTransition,
  canTransitionMission,
  canTransitionRun,
  canTransitionTask,
  isTerminalMissionStatus,
  isTerminalRunStatus,
  validateEvaluationScenario,
  validateMissionPlan,
  validateTaskGraph,
} from '../dist/index.js'

test('mission requires the planning and approval path', () => {
  assert.equal(canTransitionMission('draft', 'planning'), true)
  assert.equal(canTransitionMission('draft', 'completed'), false)
  assert.equal(canTransitionMission('awaiting_approval', 'running'), true)
  assert.equal(isTerminalMissionStatus('completed'), true)
})

test('task cannot skip from ready to completed', () => {
  assert.equal(canTransitionTask('ready', 'claimed'), true)
  assert.equal(canTransitionTask('ready', 'completed'), false)
  assert.throws(
    () => assertTaskTransition('ready', 'completed'),
    (error) => error instanceof InvalidTransitionError
      && error.message === 'Invalid task transition: ready -> completed',
  )
})

test('terminal runs cannot be reopened', () => {
  assert.equal(canTransitionRun('running', 'waiting_tool'), true)
  assert.equal(canTransitionRun('waiting_tool', 'running'), true)
  assert.equal(canTransitionRun('succeeded', 'running'), false)
  assert.equal(isTerminalRunStatus('succeeded'), true)
})

test('task graph returns a stable topological order', () => {
  const result = validateTaskGraph([
    { id: 'review', dependsOn: ['build', 'research'] },
    { id: 'build', dependsOn: ['research'] },
    { id: 'research', dependsOn: [] },
  ])

  assert.deepEqual(result, {
    valid: true,
    topologicalOrder: ['research', 'build', 'review'],
  })
})

test('task graph rejects unknown dependencies', () => {
  const result = validateTaskGraph([
    { id: 'build', dependsOn: ['missing'] },
  ])

  assert.equal(result.valid, false)
  if (!result.valid) {
    assert.deepEqual(result.errors, [
      { code: 'unknown_dependency', taskId: 'build', dependencyId: 'missing' },
    ])
  }
})

test('task graph rejects cycles', () => {
  const result = validateTaskGraph([
    { id: 'a', dependsOn: ['b'] },
    { id: 'b', dependsOn: ['a'] },
  ])

  assert.equal(result.valid, false)
  if (!result.valid) {
    assert.deepEqual(result.errors, [
      { code: 'cycle', taskIds: ['a', 'b'] },
    ])
  }
})

function validPlan() {
  return {
    summary: 'Implement and independently review the feature.',
    tasks: [
      {
        key: 'build',
        title: 'Build feature',
        description: 'Implement the requested change.',
        role: 'builder',
        priority: 10,
        dependsOn: [],
        reviewRequired: true,
        acceptanceCriteria: [
          {
            key: 'tests',
            description: 'Automated tests pass.',
            required: true,
            evidenceKinds: ['test_run'],
          },
        ],
      },
      {
        key: 'review',
        title: 'Review feature',
        description: 'Review the frozen submission.',
        role: 'reviewer',
        priority: 20,
        dependsOn: ['build'],
        reviewRequired: false,
        acceptanceCriteria: [],
      },
    ],
  }
}

test('mission plan validates roles, criteria, and DAG', () => {
  assert.equal(validateMissionPlan(validPlan()).valid, true)
  const invalid = validPlan()
  invalid.tasks[0].dependsOn = ['review']
  const result = validateMissionPlan(invalid)
  assert.equal(result.valid, false)
  if (!result.valid) {
    assert.equal(result.errors.some((error) => error.code === 'invalid_graph'), true)
  }
})

test('evaluation scenario freezes a Git baseline and distinct agent variants', () => {
  const multiAgentPlan = validPlan()
  const definition = {
    goal: 'Compare a single generalist Agent with a coordinated Agent team.',
    constraints: ['Use the same repository baseline.'],
    acceptanceCriteria: ['All automated tests pass.'],
    baselineCommit: 'a'.repeat(40),
    singleAgentPlan: {
      summary: 'One Agent completes the task end to end.',
      tasks: [structuredClone(multiAgentPlan.tasks[0])],
    },
    multiAgentPlan,
  }

  assert.equal(validateEvaluationScenario(definition).valid, true)

  definition.baselineCommit = 'main'
  definition.singleAgentPlan.tasks.push(structuredClone(multiAgentPlan.tasks[1]))
  const result = validateEvaluationScenario(definition)
  assert.equal(result.valid, false)
  assert.equal(result.errors.some((error) => error.path === 'baselineCommit'), true)
  assert.equal(result.errors.some((error) => error.path === 'singleAgentPlan.tasks'), true)
})

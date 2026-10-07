import assert from 'node:assert/strict'
import test from 'node:test'
import { GOAL_VERIFICATION_TASK_KEY, normalizeGoalVerificationPlan, validateMissionPlan } from '../dist/index.js'

const task = (key) => ({
  key, title: key, description: 'Implement the approved work.', role: 'builder', priority: 10,
  dependsOn: [], reviewRequired: true, acceptanceCriteria: [],
})
const plan = { summary: 'Implement the feature.', tasks: [task('api'), task('ui')] }

test('Goal gate preserves all work, covers original criteria, and survives replay without another task', () => {
  const criteria = ['Duplicate imports must not create duplicate records.', 'Invalid rows show a useful error.']
  const complete = normalizeGoalVerificationPlan(plan, criteria)
  const gate = complete.tasks.at(-1)
  assert.equal(gate.key, GOAL_VERIFICATION_TASK_KEY)
  assert.deepEqual(gate.dependsOn, ['api', 'ui'])
  assert.deepEqual(gate.acceptanceCriteria.map((item) => item.description), criteria)
  assert.equal(gate.reviewRequired, true)
  assert.equal(gate.role, 'builder')
  assert.ok(gate.acceptanceCriteria.every((item) => item.required && !item.evidenceKinds.includes('file_diff')))
  assert.equal(validateMissionPlan(complete).valid, true)
  assert.deepEqual(normalizeGoalVerificationPlan(complete, criteria), complete)
  assert.equal(plan.tasks.length, 2)
})

test('Goal gate cannot be replaced, weakened, or depended on by original work', () => {
  const complete = normalizeGoalVerificationPlan(plan, ['End-to-end import works.'])
  const weakened = { ...complete, tasks: complete.tasks.map((item) => item.key === GOAL_VERIFICATION_TASK_KEY
    ? { ...item, reviewRequired: false } : item) }
  assert.throws(() => normalizeGoalVerificationPlan(weakened, ['End-to-end import works.']), /reserved/)
  assert.throws(() => normalizeGoalVerificationPlan({ ...plan, tasks: [task(GOAL_VERIFICATION_TASK_KEY)] }, []), /1–99/)
  assert.throws(() => normalizeGoalVerificationPlan({ ...complete, tasks: [
    { ...complete.tasks[0], dependsOn: [GOAL_VERIFICATION_TASK_KEY] }, ...complete.tasks.slice(1),
  ] }, ['End-to-end import works.']), /cannot depend/)
})

test('Goal gate handles empty acceptance and respects the existing task and criterion limits', () => {
  const complete = normalizeGoalVerificationPlan({ ...plan, tasks: Array.from({ length: 99 }, (_, i) => task('task-' + i)) },
    Array.from({ length: 100 }, (_, i) => 'Original criterion ' + i))
  assert.equal(complete.tasks.length, 100)
  assert.equal(complete.tasks.at(-1).acceptanceCriteria.length, 100)
  assert.equal(validateMissionPlan(complete).valid, true)
  assert.equal(normalizeGoalVerificationPlan(plan, []).tasks.at(-1).acceptanceCriteria.length, 1)
  assert.throws(() => normalizeGoalVerificationPlan({ ...plan, tasks: Array.from({ length: 100 }, (_, i) => task('task-' + i)) }, []), /1–99/)
  assert.throws(() => normalizeGoalVerificationPlan(plan, ['a'.repeat(2001)]), /2000/)
})

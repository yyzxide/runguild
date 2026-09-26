#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

import { createGoalSmokeFixture, verifyGoalSmokeResult } from './goal-smoke-fixture.mjs'

const HELP = `Run one bounded real-model Goal through production API and Worker entrypoints.

Usage: node scripts/goal-smoke.mjs --run --output /absolute/path/to/new-evidence-directory
       node scripts/goal-smoke.mjs --help

Required environment: OPENAI_API_KEY, MODEL_NAME
Optional: OPENAI_BASE_URL, OPENAI_REASONING_EFFORT, OPENAI_MAX_OUTPUT_TOKENS
          GOAL_SMOKE_TOKEN_LIMIT (default 500000, positive integer)
          GOAL_SMOKE_TIMEOUT_MS (default 1200000, maximum 1800000)

Run npm run build first. Docker is required (postgres:17-alpine and redis:7-alpine).
This command makes paid model calls only with --run. It never reads .env or uses
DATABASE_URL/REDIS_URL. It creates isolated containers, a temporary target Git
repository, and a local API; it stops its processes and containers on exit.
The new output directory retains redacted evidence and a target Git bundle.
Plan and delivery approval are performed by this explicitly invoked operator
harness after bounded plan checks and the independent host oracle respectively.
This is one smoke run, not a browser test or a multi-Agent performance benchmark.
`

const args = process.argv.slice(2)
if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
  process.stdout.write(HELP)
} else if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--output') {
  process.stderr.write(HELP)
  process.exitCode = 1
} else {
  await run(resolve(args[2]))
}

async function run(outputDir) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const exec = promisify(execFile)
  const startedAt = new Date()
  const runId = 'goal_smoke_' + randomUUID().replaceAll('-', '')
  const knownSecrets = [process.env.OPENAI_API_KEY].filter(Boolean)
  const children = []
  const containers = []
  const events = []
  const controller = new AbortController()
  let timer, pool, temporaryRoot, repository, apiBase, cookie, csrf, scope, missionId
  let savedOutput = false
  let stopping = false
  let lastMission
  const summary = {
    schemaVersion: 1, runId, startedAt: startedAt.toISOString(), status: 'starting',
    evidenceKind: 'real-model-production-api-and-workers-smoke',
    limitations: ['No browser UI is exercised.', 'One bounded run is not comparative performance evidence.',
      'The host oracle is specific to this fixture; Worktrees are not an OS sandbox.'],
    approvals: [], cleanupErrors: [], captureErrors: [],
  }

  function redact(value) {
    let text = String(value)
    for (const secret of knownSecrets) {
      if (secret) text = text.split(secret).join('[REDACTED]')
    }
    return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
  }
  async function save(name, value) {
    await writeFile(join(outputDir, name), redact(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 })
  }
  function note(type, detail = {}) {
    const event = { at: new Date().toISOString(), type, ...detail }
    events.push(event)
    process.stdout.write(redact(JSON.stringify(event)) + '\n')
  }
  function check() {
    if (controller.signal.aborted) throw controller.signal.reason
    for (const child of children) {
      if (child.error || child.process.exitCode !== null || child.process.signalCode !== null) {
        throw new Error(child.name + ' exited unexpectedly: ' + (child.error ?? child.process.exitCode ?? child.process.signalCode))
      }
    }
  }
  function environment(extra = {}) {
    return {
      PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'development',
      ...(temporaryRoot ? { TMPDIR: temporaryRoot } : {}), ...extra,
    }
  }
  async function command(file, commandArgs, options = {}) {
    const { stdout } = await exec(file, commandArgs, {
      cwd: root, env: environment(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      ...(!stopping ? { signal: controller.signal } : {}), ...options,
    })
    return stdout.trim()
  }
  const git = (...gitArgs) => command('git', ['-C', repository, ...gitArgs])
  const docker = (...dockerArgs) => command('docker', dockerArgs, { timeout: 120_000 })
  function start(name, entry, env) {
    const child = { name, stdout: '', stderr: '', truncated: false, error: null,
      process: spawn(process.execPath, [join(root, entry)], {
        cwd: root, env: environment(env), detached: process.platform !== 'win32',
        shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
    for (const stream of ['stdout', 'stderr']) {
      child.process[stream].setEncoding('utf8')
      child.process[stream].on('data', chunk => {
        if (child[stream].length < 4 * 1024 * 1024) child[stream] += chunk
        else child.truncated = true
      })
    }
    child.process.on('error', error => { child.error = error.message })
    children.push(child)
    return child
  }
  async function until(label, action, timeout = 120_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      check()
      const result = await action()
      if (result) return result
      await delay(500, undefined, { signal: controller.signal })
    }
    throw new Error('Timed out waiting for ' + label)
  }
  async function api(path, { method = 'GET', body, idempotencyKey, authenticate = true } = {}) {
    const response = await fetch(apiBase + path, {
      method,
      headers: {
        origin: 'http://127.0.0.1:4173',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authenticate && cookie ? { cookie, 'x-csrf-token': csrf } : {}),
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(method + ' ' + path + ' returned ' + response.status + ': ' + raw.slice(0, 4_000))
    const value = raw ? JSON.parse(raw) : null
    if (path === '/api/v1/auth/local') {
      const cookies = response.headers.getSetCookie().map(value => value.split(';')[0])
      cookie = cookies.join('; ')
      csrf = cookies.find(value => value.startsWith('runguild_csrf='))?.slice('runguild_csrf='.length)
      assert.ok(cookie && csrf, 'Local authentication must return Session and CSRF cookies')
      knownSecrets.push(...cookies.map(value => value.slice(value.indexOf('=') + 1)))
    }
    return value
  }
  const missionPath = () => '/api/v1/workspaces/' + scope.workspaceId + '/missions/' + missionId
  async function captureDatabase() {
    if (!pool) return
    const queries = {
      'migrations.json': ['SELECT * FROM schema_migrations ORDER BY name', []],
      ...(missionId ? {
        'planning.json': ['SELECT * FROM conversation_planning_requests WHERE mission_id = $1', [missionId]],
        'mission.json': ['SELECT * FROM missions WHERE id = $1', [missionId]],
        'plans.json': ['SELECT * FROM mission_plan_revisions WHERE mission_id = $1 ORDER BY version', [missionId]],
        'tasks.json': ['SELECT * FROM tasks WHERE mission_id = $1 ORDER BY id', [missionId]],
        'runs.json': ['SELECT * FROM agent_runs WHERE mission_id = $1 ORDER BY created_at, id', [missionId]],
        'run-events.json': ['SELECT e.* FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id WHERE r.mission_id = $1 ORDER BY e.seq', [missionId]],
        'llm-calls.json': ['SELECT * FROM llm_calls WHERE mission_id = $1 ORDER BY started_at, id', [missionId]],
        'tool-executions.json': ['SELECT * FROM tool_executions WHERE mission_id = $1 ORDER BY created_at, id', [missionId]],
        'model-ledger.json': ['SELECT * FROM mission_model_calls WHERE mission_id = $1 ORDER BY created_at, id', [missionId]],
        'budget-waits.json': ['SELECT * FROM mission_budget_waits WHERE mission_id = $1', [missionId]],
        'reviews.json': ['SELECT * FROM reviews WHERE mission_id = $1 ORDER BY created_at, id', [missionId]],
        'review-executions.json': ['SELECT * FROM review_executions WHERE mission_id = $1 ORDER BY created_at, review_id', [missionId]],
        'submissions.json': ['SELECT * FROM task_submissions WHERE mission_id = $1 ORDER BY created_at, id', [missionId]],
        'evidence.json': ['SELECT * FROM evidence WHERE mission_id = $1 ORDER BY created_at, id', [missionId]],
        'worktrees.json': ['SELECT * FROM task_worktrees WHERE mission_id = $1 ORDER BY task_id', [missionId]],
        'approvals.json': ['SELECT * FROM approvals WHERE mission_id = $1 ORDER BY created_at, id', [missionId]],
        'events.json': ['SELECT * FROM domain_events WHERE mission_id = $1 ORDER BY recorded_at, id', [missionId]],
        'messages.json': ["SELECT * FROM messages WHERE entity_refs->>'missionId' = $1 ORDER BY sequence", [missionId]],
        'artifacts.json': ['SELECT v.id, v.artifact_id, v.version, v.content, v.content_hash, v.yjs_state_hash, v.created_by_run_id, v.created_at FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.mission_id = $1 ORDER BY v.created_at, v.id', [missionId]],
      } : {}),
    }
    for (const [file, [sql, params]] of Object.entries(queries)) {
      try { await save(file, (await pool.query(sql, params)).rows) }
      catch (error) { summary.captureErrors.push({ file, error: error.message }) }
    }
  }
  async function stopChildren() {
    for (const child of [...children].reverse()) {
      try {
        if (child.process.pid) {
          if (process.platform !== 'win32') process.kill(-child.process.pid, 'SIGTERM')
          else child.process.kill('SIGTERM')
        }
      } catch (error) { if (error.code !== 'ESRCH') summary.cleanupErrors.push(error.message) }
    }
    await delay(1_500)
    for (const child of children) {
      try {
        if (child.process.pid) {
          if (process.platform !== 'win32') process.kill(-child.process.pid, 'SIGKILL')
          else if (child.process.exitCode === null) child.process.kill('SIGKILL')
        }
      } catch (error) { if (error.code !== 'ESRCH') summary.cleanupErrors.push(error.message) }
      if (savedOutput) {
        try {
          await save('process-' + child.name + '.json', {
            exitCode: child.process.exitCode, signal: child.process.signalCode,
            error: child.error, truncated: child.truncated, stdout: child.stdout, stderr: child.stderr,
          })
        } catch (error) { summary.captureErrors.push({ file: 'process-' + child.name + '.json', error: error.message }) }
      }
    }
  }
  const onSignal = signal => controller.abort(new Error('Interrupted by ' + signal))
  const onInterrupt = () => onSignal('SIGINT')
  const onTerminate = () => onSignal('SIGTERM')

  try {
    assert.ok(process.env.OPENAI_API_KEY?.trim(), 'OPENAI_API_KEY is required')
    assert.ok(process.env.MODEL_NAME?.trim(), 'MODEL_NAME is required; the harness never selects a paid model implicitly')
    const tokenLimit = Number(process.env.GOAL_SMOKE_TOKEN_LIMIT ?? 500_000)
    const timeoutMs = Number(process.env.GOAL_SMOKE_TIMEOUT_MS ?? 1_200_000)
    assert.ok(Number.isSafeInteger(tokenLimit) && tokenLimit > 0, 'GOAL_SMOKE_TOKEN_LIMIT must be a positive safe integer')
    assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 1_800_000,
      'GOAL_SMOKE_TIMEOUT_MS must be 30000–1800000')
    await mkdir(outputDir, { mode: 0o700 }) // Existing evidence directories are never overwritten.
    savedOutput = true
    summary.outputDir = outputDir
    summary.tokenLimit = tokenLimit
    summary.timeoutMs = timeoutMs
    summary.model = process.env.MODEL_NAME.trim()
    summary.provider = 'openai-compatible Responses API'
    if (process.env.OPENAI_BASE_URL) {
      const endpoint = new URL(process.env.OPENAI_BASE_URL)
      for (const secret of [endpoint.username, endpoint.password, ...endpoint.searchParams.values()]) {
        if (secret) knownSecrets.push(secret)
      }
      endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = ''
      summary.endpoint = endpoint.toString()
    } else summary.endpoint = 'https://api.openai.com/v1'
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    timer = setTimeout(() => controller.abort(new Error('Goal smoke wall-clock limit exceeded')), timeoutMs)
    for (const entry of ['apps/api/dist/server.js', 'apps/worker/dist/main.js', 'apps/worker/dist/agent-main.js',
      'apps/worker/dist/integration-main.js', 'packages/protocol/dist/index.js']) await access(join(root, entry))
    const sha = value => createHash('sha256').update(value).digest('hex')
    const fingerprintFiles = (await command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    const fileHashes = {}
    for (const file of fingerprintFiles) {
      try { fileHashes[file] = sha(await readFile(join(root, file))) }
      catch (error) { if (error.code !== 'ENOENT') throw error; fileHashes[file] = 'deleted' }
    }
    summary.source = {
      commit: await command('git', ['rev-parse', 'HEAD']),
      diffSha256: sha(await command('git', ['diff', '--binary', 'HEAD'])),
      workingTreeSha256: sha(JSON.stringify(fileHashes)),
      dirty: Boolean(await command('git', ['status', '--porcelain'])),
    }
    await save('source-files.json', fileHashes)
    const { Pool } = await import('pg')
    const ts = await import('typescript')
    const parserSource = await readFile(join(root, 'apps/web/src/goal-command.ts'), 'utf8')
    const parserJs = ts.transpileModule(parserSource, { compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
    } }).outputText
    const { createRoomSubmission } = await import('data:text/javascript;base64,' + Buffer.from(parserJs).toString('base64'))
    const { normalizeGoalVerificationPlan, GOAL_VERIFICATION_TASK_KEY } = await import('../packages/protocol/dist/index.js')
    temporaryRoot = await mkdtemp(join(tmpdir(), 'runguild-goal-smoke-'))
    repository = join(temporaryRoot, 'target')
    const fixture = await createGoalSmokeFixture(repository)
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'RunGuild Goal Smoke')
    await git('config', 'user.email', 'goal-smoke@example.invalid')
    await git('add', '.')
    await git('commit', '-m', 'Seed bounded Goal smoke fixture')
    const baselineCommit = await git('rev-parse', 'HEAD')
    const deliveryBranch = 'goal-smoke-delivery'
    await git('branch', deliveryBranch)
    summary.target = { baselineCommit, deliveryBranch }
    const contract = { ...fixture.contract, constraints: [...fixture.contract.constraints,
      'Use exactly two original tasks: researcher first inspects this repository and writes concise implementation and edge-case notes to docs/analysis.md; then builder implements the function and regression tests using those notes. The builder task must depend on the researcher task.',
      'Require independent review for both original tasks. Do not create the system final verification task yourself. The research task must not implement the production function.',
      'Keep the existing tests, add focused regression tests, and run npm test; no installation is needed.',
    ] }
    await save('contract.json', contract)
    const databasePassword = randomUUID()
    knownSecrets.push(databasePassword)
    const postgresName = runId + '_postgres'
    const redisName = runId + '_redis'
    containers.push(postgresName)
    await docker('run', '--detach', '--rm', '--name', postgresName, '--label', 'runguild.purpose=goal-smoke',
      '--publish', '127.0.0.1::5432', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '--env', 'POSTGRES_USER=goal_smoke', '--env', 'POSTGRES_DB=goal_smoke_test',
      '--env', 'POSTGRES_PASSWORD=' + databasePassword, 'postgres:17-alpine')
    containers.push(redisName)
    await docker('run', '--detach', '--rm', '--name', redisName, '--label', 'runguild.purpose=goal-smoke',
      '--publish', '127.0.0.1::6379', '--mount', 'type=tmpfs,destination=/data',
      'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no')
    const pgPort = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', postgresName)
    const redisPort = await docker('inspect', '--format', '{{(index (index .NetworkSettings.Ports "6379/tcp") 0).HostPort}}', redisName)
    assert.match(pgPort, /^\d+$/); assert.match(redisPort, /^\d+$/)
    const databaseUrl = 'postgresql://goal_smoke:' + databasePassword + '@127.0.0.1:' + pgPort + '/goal_smoke_test'
    const redisUrl = 'redis://127.0.0.1:' + redisPort
    pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 1_000,
      statement_timeout: 10_000, query_timeout: 12_000 })
    pool.on('error', error => { if (!stopping) note('database.connection_error', { message: error.message }) })
    await until('PostgreSQL readiness', async () => {
      try { await pool.query('SELECT 1'); return true } catch { return false }
    }, 30_000)
    const probe = createServer()
    await new Promise((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done) })
    const apiPort = probe.address().port
    await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()))
    apiBase = 'http://127.0.0.1:' + apiPort
    scope = { workspaceId: runId + '_ws', projectId: runId + '_project', userId: runId + '_operator' }
    summary.scope = scope
    start('api', 'apps/api/dist/server.js', {
      DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, AUTO_MIGRATE: 'true',
      HOST: '127.0.0.1', PORT: String(apiPort), AUTH_MODE: 'local',
      AUTH_DEFAULT_WORKSPACE_ID: scope.workspaceId, LOCAL_AUTH_USER_ID: scope.userId,
      AUTH_COOKIE_SECURE: 'false', AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
      ENABLE_DEV_BOOTSTRAP: 'true', ENABLE_LOCAL_RUNTIME_CONTROL: 'false',
      MODEL_PROVIDER: 'openai', MODEL_NAME: summary.model,
    })
    await until('API readiness and migrations', async () => {
      try { return (await api('/health', { authenticate: false })).status === 'ok' } catch { return false }
    })
    const bootstrap = await api('/api/v1/development/bootstrap', { method: 'POST', authenticate: false, body: {
      ...scope, workspaceName: 'Goal smoke workspace', projectName: 'Goal smoke project', displayName: 'Smoke operator',
    } })
    await api('/api/v1/auth/local', { method: 'POST', authenticate: false })
    const projectPath = '/api/v1/workspaces/' + scope.workspaceId + '/projects/' + scope.projectId
    const testCommands = [fixture.testCommand]
    const worktreeRoot = join(temporaryRoot, 'worktrees')
    await mkdir(worktreeRoot)
    await api(projectPath + '/runtime-config', { method: 'PUT', body: {
      repositoryPath: repository, defaultBranch: deliveryBranch, worktreeRoot,
      worktreeSetupCommands: [], worktreeSetupTimeoutMs: 30_000,
      testCommands, agentContextInputTokens: 32_768, agentMaxTestTimeoutMs: 30_000,
      agentModels: bootstrap.agents.map(agent => ({ agentId: agent.id, modelProvider: 'openai', modelName: summary.model })),
    } })
    const common = {
      DATABASE_URL: databaseUrl, WORKSPACE_ID: scope.workspaceId, PROJECT_ID: scope.projectId,
      REPOSITORY_ROOT: repository, WORKTREE_ROOT: worktreeRoot,
      AGENT_TEST_COMMANDS_JSON: JSON.stringify(testCommands), AGENT_WORKTREE_SETUP_COMMANDS_JSON: '[]',
      AGENT_MAX_TEST_TIMEOUT_MS: '30000', INTEGRATION_TEST_TIMEOUT_MS: '30000', WORKER_HEARTBEAT_MS: '1000',
    }
    start('scheduler', 'apps/worker/dist/main.js', { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, WORKER_HEARTBEAT_MS: '1000' })
    start('integration', 'apps/worker/dist/integration-main.js', common)
    for (const agent of bootstrap.agents) start(agent.role, 'apps/worker/dist/agent-main.js', {
      ...common, AGENT_ID: agent.id, OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
      ...(process.env.OPENAI_REASONING_EFFORT ? { OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT } : {}),
      OPENAI_MAX_OUTPUT_TOKENS: process.env.OPENAI_MAX_OUTPUT_TOKENS ?? '4096', AGENT_CONTEXT_INPUT_TOKENS: '32768',
    })
    const planner = bootstrap.agents.find(agent => agent.role === 'planner')
    const submission = createRoomSubmission({ identity: scope, conversationId: bootstrap.conversationId,
      draft: '/goal ' + contract.goal, acceptanceText: contract.acceptanceCriteria.join('\n'),
      constraintText: contract.constraints.join('\n'), budgetText: '0', planningActive: false,
      plannerAgentId: planner.id, selectedAgents: [],
    }, runId)
    assert.equal(submission.planning.goalVerification, true)
    const roomPath = '/api/v1/workspaces/' + scope.workspaceId + '/conversations/' + bootstrap.conversationId
    const posted = await api(roomPath + '/messages', { method: 'POST', idempotencyKey: submission.message.idempotencyKey,
      body: { body: submission.message.body, mentions: submission.message.mentions, entityRefs: {} } })
    const { identity: ignoredIdentity, conversationId: ignoredConversation, idempotencyKey, ...planningBody } = submission.planning
    const planned = await api(roomPath + '/planning-requests', { method: 'POST', idempotencyKey,
      body: { ...planningBody, sourceMessageIds: [posted.message.id] } })
    missionId = planned.request.missionId
    summary.missionId = missionId
    summary.planningRequestId = planned.request.id
    await save('creation.json', { sourceMessage: posted.message, planningRequest: planned.request })
    note('goal.created', { missionId, tokenLimit: 0 })
    const waiting = await until('persistent zero-budget Planner wait', async () => {
      const rows = (await pool.query('SELECT * FROM mission_budget_waits WHERE mission_id = $1', [missionId])).rows
      return rows.length ? rows : null
    })
    const before = (await pool.query('SELECT attempt, status FROM conversation_planning_requests WHERE id = $1', [planned.request.id])).rows[0]
    const callsBefore = Number((await pool.query('SELECT COUNT(*) AS count FROM mission_model_calls WHERE mission_id = $1', [missionId])).rows[0].count)
    assert.equal(before.attempt, 0); assert.equal(callsBefore, 0)
    assert.ok(waiting.some(row => row.kind === 'conversation.plan_requested'))
    summary.budgetPause = { waits: waiting, planning: before, modelCalls: callsBefore }
    await save('budget-paused.json', summary.budgetPause)
    note('budget.paused', { plannerAttempt: before.attempt, modelCalls: callsBefore })
    summary.budgetResume = await api(missionPath() + '/budget', { method: 'POST', body: { tokenLimit } })
    assert.equal(summary.budgetResume.tokenLimit, tokenLimit)
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM mission_budget_waits WHERE mission_id = $1', [missionId])).rows[0].count), 0)
    note('budget.resumed', { tokenLimit })
    let lastState, lastProgressAt = 0, approved = false
    while (true) {
      check()
      const mission = await api(missionPath())
      lastMission = mission
      const planning = (await pool.query('SELECT status, attempt, error FROM conversation_planning_requests WHERE id = $1', [planned.request.id])).rows[0]
      const state = JSON.stringify([mission.status, planning.status, mission.tasks.map(task => [task.id, task.status, task.attemptCount])])
      if (state !== lastState || Date.now() - lastProgressAt >= 30_000) {
        note('mission.progress', { status: mission.status, planning: planning.status,
          tasks: mission.tasks.map(task => ({ role: task.role, status: task.status, attempt: task.attemptCount, hop: task.latestRun?.currentHop })),
          knownTokens: mission.budget.totalTokens })
        await save('latest-mission.json', mission)
        lastState = state
        lastProgressAt = Date.now()
      }
      if (mission.budget.unknownUsageCalls > 0) throw new Error('Provider usage is unknown; finite-budget run stopped without raising or removing its limit')
      if (mission.budget.status === 'exhausted') throw new Error('Configured token limit exhausted; run stopped without increasing it')
      if (planning.status === 'failed' || ['failed', 'cancelled'].includes(mission.status)
          || mission.tasks.some(task => ['failed', 'cancelled'].includes(task.status))) {
        throw new Error('Mission or an indispensable Task failed; inspect retained planning and execution evidence')
      }
      if (mission.status === 'awaiting_approval' && !approved) {
        const plan = mission.proposedPlan?.plan
        assert.ok(plan, 'Planner must produce a reviewable plan')
        normalizeGoalVerificationPlan(plan, contract.acceptanceCriteria)
        const originals = plan.tasks.filter(task => task.key !== GOAL_VERIFICATION_TASK_KEY)
        assert.equal(originals.length, 2, 'Bounded approval only accepts two original tasks')
        const research = originals.find(task => task.role === 'researcher')
        const build = originals.find(task => task.role === 'builder')
        assert.ok(research && build && build.dependsOn.includes(research.key), 'Plan must preserve researcher -> builder handoff')
        assert.ok(plan.tasks.every(task => ['researcher', 'builder'].includes(task.role) && task.reviewRequired),
          'Only independently reviewed researcher/builder tasks are approved')
        assert.equal(plan.tasks.filter(task => task.key === GOAL_VERIFICATION_TASK_KEY).length, 1)
        summary.approvals.push({ type: 'plan', at: new Date().toISOString(), version: mission.planVersion,
          basis: 'Operator explicitly invoked --run for this fixed contract; bounded role/dependency/independent-review checks passed.',
          actorId: scope.userId })
        await save('approved-plan.json', mission.proposedPlan)
        await api(missionPath() + '/plan/approve', { method: 'POST', body: { expectedVersion: mission.planVersion } })
        approved = true
        note('plan.approved', { taskCount: plan.tasks.length })
      }
      if (mission.status === 'reviewing') {
        assert.ok(approved && mission.goalVerification && mission.verificationTaskId)
        assert.ok(mission.tasks.every(task => task.status === 'completed'))
        assert.ok(mission.finalDelivery?.artifactVersionId)
        const verification = mission.tasks.find(task => task.id === mission.verificationTaskId)
        assert.equal(verification?.latestReview?.artifactVersionId, mission.finalDelivery.artifactVersionId)
        assert.equal(verification.latestReview.status, 'approved')
        assert.ok(verification.integration?.integratedCommit)
        const finalCommit = await git('rev-parse', 'refs/heads/' + deliveryBranch)
        const oracleDirectory = join(temporaryRoot, 'host-oracle-checkout')
        await git('worktree', 'add', '--detach', oracleDirectory, finalCommit)
        summary.oracle = await verifyGoalSmokeResult(oracleDirectory)
        await save('host-oracle.json', { commit: finalCommit, ...summary.oracle })
        assert.equal(summary.oracle.passed, true, 'Independent host oracle failed; final delivery will not be approved')
        const testOutput = await command('npm', ['test'], { cwd: oracleDirectory })
        await writeFile(join(outputDir, 'target-tests.txt'), redact(testOutput) + '\n', { mode: 0o600 })
        assert.equal(await command('git', ['-C', oracleDirectory, 'status', '--porcelain=v1']), '')
        assert.equal(await git('rev-parse', 'refs/heads/' + deliveryBranch), finalCommit)
        assert.equal(await git('rev-parse', 'main'), baselineCommit, 'Unrelated baseline branch must remain unchanged')
        assert.equal(await git('branch', '--show-current'), 'main')
        summary.target.finalCommit = finalCommit
        summary.approvals.push({ type: 'delivery', at: new Date().toISOString(),
          artifactVersionId: mission.finalDelivery.artifactVersionId, commit: finalCommit,
          basis: 'Explicit operator smoke policy: completed Goal verification, independent Review/Integration, host oracle and npm test all passed.',
          actorId: scope.userId })
        await api(missionPath() + '/delivery/approve', { method: 'POST',
          body: { expectedArtifactVersionId: mission.finalDelivery.artifactVersionId } })
        lastMission = await api(missionPath())
        assert.equal(lastMission.status, 'completed')
        summary.status = 'passed'
        summary.budget = lastMission.budget
        await save('completed-mission.json', lastMission)
        note('goal.completed', { missionId, finalCommit, knownTokens: lastMission.budget.totalTokens })
        break
      }
      if (mission.status === 'completed') throw new Error('Mission completed without the harness final-delivery check')
      await delay(1_000, undefined, { signal: controller.signal })
    }
  } catch (error) {
    summary.status = 'failed'
    summary.error = redact(error.stack ?? error.message ?? error)
    process.exitCode = 1
    note('goal.failed', { message: error.message ?? String(error) })
  } finally {
    stopping = true
    clearTimeout(timer)
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    await stopChildren().catch(error => summary.cleanupErrors.push(error.message))
    if (savedOutput) {
      await captureDatabase()
      if (lastMission) {
        await save('last-observed-mission.json', lastMission)
          .catch(error => summary.captureErrors.push({ file: 'last-observed-mission.json', error: error.message }))
      }
      if (repository) {
        try {
          await git('bundle', 'create', join(outputDir, 'target.bundle'), '--all')
          summary.targetBundleSha256 = createHash('sha256').update(await readFile(join(outputDir, 'target.bundle'))).digest('hex')
        } catch (error) { summary.captureErrors.push({ file: 'target.bundle', error: error.message }) }
      }
    }
    if (pool) await pool.end().catch(error => summary.cleanupErrors.push(error.message))
    for (const container of containers.reverse()) {
      try { await docker('rm', '--force', container) }
      catch (error) {
        if (!String(error.stderr ?? '').includes('No such container')) summary.cleanupErrors.push(error.message)
      }
    }
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(error => summary.cleanupErrors.push(error.message))
    if (summary.cleanupErrors.length || summary.captureErrors.length) {
      if (summary.status === 'passed') summary.status = 'incomplete'
      process.exitCode = 1
    }
    summary.finishedAt = new Date().toISOString()
    summary.durationMs = Date.now() - startedAt.getTime()
    if (savedOutput) {
      await save('operator-events.json', events)
      await save('summary.json', summary)
      note('evidence.saved', { outputDir, status: summary.status })
    }
  }
}

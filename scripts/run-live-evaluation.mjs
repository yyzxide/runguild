import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELP = `usage: node scripts/run-live-evaluation.mjs [options]

Required:
  --family <local-bug|api-implementation|cross-module>
  --target <clean materialized Git repository>
  --worktree-root <new or reusable RunGuild Worktree root>
  --output <JSON evidence path>

Optional:
  --api-url <url>       default: http://127.0.0.1:4400
  --origin <url>        default: http://127.0.0.1:4173
  --repetitions <n>     default: 3
  --model <name>        default: deepseek-v4-flash
  --timeout-minutes <n> default: 45
  --keep-workers        leave locally managed Workers running
`

const families = {
  'local-bug': {
    name: 'Local bug repair',
    goal: 'Fix normalizeTags(tags) so it validates input, normalizes values, removes empty and duplicate tags, and preserves first-seen order.',
    focus: 'Inspect README.md, src/tags.mjs, and the public tests. Explain the exact normalization and validation behavior before implementation.',
  },
  'api-implementation': {
    name: 'API implementation',
    goal: 'Implement POST /tasks in routeRequest(request) with deterministic ids, normalized input, defaults, and stable validation errors while preserving existing routes.',
    focus: 'Inspect README.md, src/router.mjs, and the public tests. Define the route, validation, and deterministic-id cases before implementation.',
  },
  'cross-module': {
    name: 'Cross-module policy change',
    goal: 'Propagate a bounded failure budget through policy parsing and run reporting without breaking the existing module boundary.',
    focus: 'Inspect README.md, src/config.mjs, src/report.mjs, and the public tests. Map the policy invariants and report state transitions before implementation.',
  },
}

function parseArguments(argv) {
  if (argv.includes('--help')) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  const result = { keepWorkers: false }
  const supported = new Set([
    '--family', '--target', '--worktree-root', '--output', '--api-url', '--origin',
    '--repetitions', '--model', '--timeout-minutes', '--keep-workers',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!supported.has(flag)) throw new Error('Unknown option: ' + flag)
    if (flag === '--keep-workers') {
      result.keepWorkers = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag)
    result[flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value
    index += 1
  }
  for (const required of ['family', 'target', 'worktreeRoot', 'output']) {
    if (!result[required]) throw new Error('--' + required.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase()) + ' is required')
  }
  if (!families[result.family]) throw new Error('Unknown family: ' + result.family)
  result.apiUrl ??= 'http://127.0.0.1:4400'
  result.origin ??= 'http://127.0.0.1:4173'
  result.model ??= 'deepseek-v4-flash'
  result.repetitions = Number(result.repetitions ?? 3)
  result.timeoutMinutes = Number(result.timeoutMinutes ?? 45)
  if (!Number.isInteger(result.repetitions) || result.repetitions < 1 || result.repetitions > 100) {
    throw new Error('--repetitions must be an integer between 1 and 100')
  }
  if (!Number.isFinite(result.timeoutMinutes) || result.timeoutMinutes < 1 || result.timeoutMinutes > 240) {
    throw new Error('--timeout-minutes must be between 1 and 240')
  }
  result.target = resolve(result.target)
  result.worktreeRoot = resolve(result.worktreeRoot)
  result.output = resolve(result.output)
  result.apiUrl = new URL(result.apiUrl).toString().replace(/\/$/, '')
  result.origin = new URL(result.origin).origin
  return result
}

function git(repository, ...args) {
  const command = spawnSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (command.status !== 0) throw new Error(command.stderr.trim() || `git ${args[0]} failed in ${repository}`)
  return command.stdout.trim()
}

function repositoryFact(repository) {
  return {
    path: resolve(repository),
    commit: git(repository, 'rev-parse', 'HEAD'),
    branch: git(repository, 'branch', '--show-current'),
    dirty: git(repository, 'status', '--porcelain').length > 0,
  }
}

class LocalApiClient {
  constructor(baseUrl, origin) {
    this.baseUrl = baseUrl
    this.origin = origin
    this.cookies = new Map()
  }

  updateCookies(response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]
      const separator = pair.indexOf('=')
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => name + '=' + value).join('; ')
  }

  csrfToken() {
    return this.cookies.get('runguild_csrf') ?? this.cookies.get('__Host-runguild_csrf')
  }

  async request(path, { method = 'GET', body, authenticated = true } = {}) {
    const mutation = !['GET', 'HEAD'].includes(method)
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (authenticated) {
      headers.cookie = this.cookieHeader()
      if (mutation) {
        headers.origin = this.origin
        headers['x-csrf-token'] = this.csrfToken()
      }
    } else if (mutation) {
      headers.origin = this.origin
    }
    const response = await fetch(this.baseUrl + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    this.updateCookies(response)
    const text = await response.text()
    let result
    try {
      result = text ? JSON.parse(text) : null
    } catch {
      throw new Error(method + ' ' + path + ' returned non-JSON status ' + response.status)
    }
    if (!response.ok) {
      const message = result?.error?.message ?? result?.error?.code ?? JSON.stringify(result)
      throw new Error(method + ' ' + path + ' failed (' + response.status + '): ' + message)
    }
    return result
  }

  async bootstrapAndAuthenticate() {
    await this.request('/api/v1/development/bootstrap', {
      method: 'POST',
      authenticated: false,
      body: {
        workspaceId: 'demo_workspace',
        projectId: 'demo_project',
        userId: 'demo_user',
        workspaceName: 'RunGuild Live Evaluation',
        projectName: 'RunGuild Live Evaluation',
        displayName: 'Local Evaluator',
      },
    })
    await this.request('/api/v1/auth/local', { method: 'POST', authenticated: false })
    if (!this.csrfToken() || !this.cookieHeader()) throw new Error('Local authentication did not return session cookies')
  }
}

function task(key, title, description, role, dependsOn, reviewRequired, criteria) {
  return {
    key, title, description, role, priority: 100, dependsOn, reviewRequired,
    acceptanceCriteria: criteria,
  }
}

const implementationCriteria = [
  { key: 'implementation', description: 'The bounded source change is present as a durable diff.', required: true, evidenceKinds: ['file_diff'] },
  { key: 'acceptance', description: 'All configured public and protected tests pass on a clean stable HEAD.', required: true, evidenceKinds: ['test_run'] },
  { key: 'delivery', description: 'The exact implementation and evidence summary is frozen for independent review.', required: true, evidenceKinds: ['artifact_version'] },
]

function scenarioDefinition(family, baselineCommit) {
  const metadata = families[family]
  return {
    goal: metadata.goal,
    constraints: [
      'Do not modify test/acceptance.test.mjs; it is protected control-plane evidence.',
      'Use only the configured repository tools and exact allowlisted test commands.',
      'Commit the smallest correct source change and ground every completion claim in durable evidence.',
    ],
    acceptanceCriteria: [
      'The protected acceptance test passes without being modified.',
      'The public smoke test and source syntax checks pass.',
      'The exact reviewed commit is integrated into the isolated Trial ref.',
    ],
    baselineCommit,
    singleAgentPlan: {
      summary: 'One Builder inspects, implements, verifies, commits, and submits the complete bounded change.',
      tasks: [task(
        'implement', metadata.name, metadata.focus + ' Then implement the complete contract and commit the source change. Run both configured checks only after the commit so they produce clean stable HEAD evidence; if a fix is needed, recommit and rerun. Finally submit the exact Artifact Version.',
        'builder', [], true, implementationCriteria,
      )],
    },
    multiAgentPlan: {
      summary: 'A Researcher freezes a source-grounded plan before a dependent Builder implements and submits the change.',
      tasks: [
        task(
          'research', 'Analyze ' + metadata.name,
          metadata.focus + ' Do not modify source. Freeze a concise implementation plan with file locations, edge cases, and verification commands.',
          'researcher', [], false,
          [{ key: 'analysis', description: 'A source-grounded implementation plan is frozen for the Builder.', required: true, evidenceKinds: ['artifact_version'] }],
        ),
        task(
          'implement', metadata.name,
          'Read the upstream Mission Artifact, verify it against the repository, then implement the complete contract and commit the source change. Run both configured checks only after the commit so they produce clean stable HEAD evidence; if a fix is needed, recommit and rerun. Finally submit the exact Artifact Version.',
          'builder', ['research'], true, implementationCriteria,
        ),
      ],
    },
  }
}

function workerCommands() {
  return [
    { kind: 'scheduler' },
    { kind: 'integration' },
    { kind: 'evaluation' },
    { kind: 'agent', agentId: 'demo_project:agent:researcher' },
    { kind: 'agent', agentId: 'demo_project:agent:builder' },
    { kind: 'agent', agentId: 'demo_project:agent:reviewer' },
  ]
}

async function stopWorkers(client, projectPath) {
  for (const command of [...workerCommands()].reverse()) {
    try {
      await client.request(projectPath + '/local-workers/stop', { method: 'POST', body: command })
    } catch (error) {
      process.stderr.write('worker stop warning: ' + error.message + '\n')
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const source = repositoryFact(sourceRoot)
  const target = repositoryFact(options.target)
  if (source.dirty) throw new Error('RunGuild source repository must be clean so the harness commit is exact')
  if (target.dirty || target.branch !== 'main') {
    throw new Error('Evaluation target must be clean and checked out on main')
  }
  const client = new LocalApiClient(options.apiUrl, options.origin)
  await client.bootstrapAndAuthenticate()
  const projectPath = '/api/v1/workspaces/demo_workspace/projects/demo_project'
  let workersStarted = false
  let interrupted = false
  const interrupt = () => { interrupted = true }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    await stopWorkers(client, projectPath)
    const configuration = await client.request(projectPath + '/runtime-config', {
      method: 'PUT',
      body: {
        repositoryPath: target.path,
        defaultBranch: 'main',
        worktreeRoot: options.worktreeRoot,
        worktreeSetupCommands: [],
        worktreeSetupTimeoutMs: 120_000,
        testCommands: [['npm', 'test'], ['npm', 'run', 'typecheck']],
        protectedTestPaths: ['test/acceptance.test.mjs'],
        testSandbox: {
          mode: 'bubblewrap', network: 'host', maxProcesses: 64, maxOpenFiles: 512, maxFileSizeMb: 128,
        },
        agentContextInputTokens: 32_768,
        agentMaxTestTimeoutMs: 120_000,
        agentModels: [
          'planner', 'researcher', 'builder', 'reviewer',
        ].map((role) => ({
          agentId: `demo_project:agent:${role}`,
          modelProvider: 'openai',
          modelName: options.model,
        })),
      },
    })
    workersStarted = true
    for (const command of workerCommands()) {
      await client.request(projectPath + '/local-workers/start', { method: 'POST', body: command })
    }

    const suffix = target.commit.slice(0, 8) + '-' + Date.now().toString(36)
    const scenarioId = 'evaluation_scenario_live_' + options.family.replaceAll('-', '_') + '_' + suffix.replaceAll('-', '_')
    const createdScenario = await client.request(projectPath + '/evaluation-scenarios', {
      method: 'POST',
      body: {
        scenarioId,
        slug: ('live-' + options.family + '-' + suffix).slice(0, 63),
        name: 'Live ' + families[options.family].name,
        description: 'Bounded real-model single-Agent versus multi-Agent evaluation on a frozen fixture repository.',
      },
    })
    const version = await client.request(projectPath + '/evaluation-scenarios/' + encodeURIComponent(createdScenario.scenarioId) + '/versions', {
      method: 'POST',
      body: { definition: scenarioDefinition(options.family, target.commit) },
    })
    const experiment = await client.request(projectPath + '/evaluation-experiments', {
      method: 'POST',
      body: {
        scenarioVersionId: version.id,
        name: `Live ${families[options.family].name}: ${options.model}`,
        repetitions: options.repetitions,
        variants: ['single_agent', 'multi_agent'],
      },
    })
    const deadline = Date.now() + options.timeoutMinutes * 60_000
    let report
    let previousState = ''
    while (!interrupted && Date.now() < deadline) {
      report = await client.request(projectPath + '/evaluation-experiments/' + encodeURIComponent(experiment.id) + '/report')
      const state = report.status + ':' + report.trials.map((trial) => trial.status).join(',')
      if (state !== previousState) {
        process.stdout.write(new Date().toISOString() + ' ' + state + '\n')
        previousState = state
      }
      if (['completed', 'failed', 'cancelled'].includes(report.status)) break
      await delay(5_000)
    }
    if (interrupted) throw new Error('Live evaluation interrupted')
    if (!report || !['completed', 'failed', 'cancelled'].includes(report.status)) {
      throw new Error('Live evaluation timed out before a terminal report')
    }

    const missionIds = new Set(report.trials.flatMap((trial) => trial.missionId ? [trial.missionId] : []))
    const recent = await client.request(projectPath + '/run-traces?limit=100')
    const traces = []
    for (const run of recent.runs.filter((item) => missionIds.has(item.mission.id))) {
      const detail = await client.request(projectPath + '/run-traces/' + encodeURIComponent(run.runId))
      traces.push(detail.run)
    }
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      harness: source,
      target: { family: options.family, ...target },
      routing: {
        requestedModel: options.model,
        provider: 'openai-compatible Responses API',
        apiKeyRecorded: false,
      },
      runtimeConfiguration: configuration.configuration,
      scenario: { id: createdScenario.scenarioId, version },
      report,
      traces,
    }
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    process.stdout.write('evidence=' + options.output + '\n')
    process.stdout.write('experiment=' + experiment.id + '\n')
    process.stdout.write('status=' + report.status + '\n')
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    if (workersStarted && !options.keepWorkers) await stopWorkers(client, projectPath)
  }
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n')
  process.exitCode = 1
})

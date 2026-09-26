import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

import { Pool } from 'pg'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const integrationFile = 'packages/database/test/postgres.integration.test.mjs'
const mode = process.argv[2] ?? '--all'
if (!['--all', '--postgres', '--without-postgres'].includes(mode) || process.argv.length > 3) {
  throw new Error('Usage: node scripts/test.mjs [--all|--postgres|--without-postgres]')
}

let containerName
let testProcess
let interrupted
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = signal
    testProcess?.kill(signal)
  })
}

function checkInterrupted() {
  if (interrupted) throw new Error('Test run interrupted by ' + interrupted)
}

async function docker(args) {
  return exec('docker', args, { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 })
}

async function temporaryPostgres() {
  containerName = 'runguild-tests-' + randomUUID()
  try {
    await docker([
      'run', '--detach', '--rm', '--name', containerName,
      '--label', 'runguild.purpose=integration-test',
      '--publish', '127.0.0.1::5432',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '--env', 'POSTGRES_DB=runguild_test',
      '--env', 'POSTGRES_USER=runguild_test',
      '--env', 'POSTGRES_PASSWORD=runguild_test',
      'postgres:17-alpine',
    ])
  } catch (error) {
    throw new Error('Could not start disposable PostgreSQL 17. Start Docker or provide TEST_DATABASE_URL for a dedicated database ending in _test. '
      + (error.code === 'ENOENT' ? 'Docker is not installed.' : String(error.stderr ?? error.code ?? '').trim()))
  }
  checkInterrupted()
  const { stdout } = await docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', containerName])
  const port = stdout.trim()
  if (!/^\d+$/.test(port)) throw new Error('Docker did not expose a loopback PostgreSQL test port')
  const connectionString = 'postgresql://runguild_test:runguild_test@127.0.0.1:' + port + '/runguild_test'
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 1_000 })
  pool.on('error', () => {}) // Startup restarts can close an idle connection before readiness.
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      checkInterrupted()
      try {
        await pool.query('SELECT 1')
        console.log('Using disposable PostgreSQL 17; its test data is removed when this command finishes.')
        return connectionString
      } catch {
        await delay(250)
      }
    }
    throw new Error('Disposable PostgreSQL did not become ready within 30 seconds')
  } finally {
    await pool.end()
  }
}

async function testFiles() {
  if (mode === '--postgres') return [integrationFile]
  const files = []
  for (const parent of ['packages', 'apps']) {
    for (const entry of await readdir(new URL('../' + parent + '/', import.meta.url), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = parent + '/' + entry.name + '/test/'
      let names
      try {
        names = await readdir(new URL('../' + directory, import.meta.url))
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      for (const name of names) {
        if (name.endsWith('.test.mjs')) files.push(directory + name)
      }
    }
  }
  return files.sort().filter((file) => mode !== '--without-postgres' || file !== integrationFile)
}

try {
  const env = { ...process.env }
  if (mode === '--without-postgres') {
    console.log('Explicit reduced suite: external PostgreSQL integration tests are excluded.')
  } else if (env.TEST_DATABASE_URL?.trim()) {
    console.log('Using the explicitly configured TEST_DATABASE_URL (dedicated _test database required).')
  } else {
    env.TEST_DATABASE_URL = await temporaryPostgres()
  }
  checkInterrupted()
  const files = await testFiles()
  checkInterrupted()
  process.exitCode = await new Promise((resolve, reject) => {
    testProcess = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
      cwd: root, env, stdio: 'inherit',
    })
    testProcess.once('error', reject)
    testProcess.once('close', (code, signal) => {
      testProcess = undefined
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1))
    })
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = interrupted === 'SIGINT' ? 130 : 1
} finally {
  if (containerName) {
    try {
      await docker(['rm', '--force', containerName])
    } catch (error) {
      // docker run can fail before creating a container.
      if (!String(error.stderr ?? '').includes('No such container')) {
        console.error('Could not confirm cleanup of temporary test container ' + containerName + '. Check Docker before rerunning.')
        process.exitCode = 1
      }
    }
  }
}

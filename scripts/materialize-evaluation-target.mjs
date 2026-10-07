import { cpSync, existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturesRoot = realpathSync(join(repositoryRoot, 'fixtures', 'evaluation-targets'))
const [family, destinationArgument] = process.argv.slice(2)

if (!family || !/^[a-z0-9-]+$/.test(family) || !destinationArgument) {
  console.error('usage: node scripts/materialize-evaluation-target.mjs <family> <new-directory>')
  process.exit(2)
}

const source = join(fixturesRoot, family)
const destination = resolve(destinationArgument)
const destinationInsideRepository = relative(repositoryRoot, destination)

if (!existsSync(source)) {
  console.error(`unknown evaluation target family: ${family}`)
  process.exit(2)
}
if (!destinationInsideRepository.startsWith('..') && !isAbsolute(destinationInsideRepository)) {
  console.error('destination must be outside the RunGuild repository')
  process.exit(2)
}
if (existsSync(destination)) {
  console.error(`destination already exists: ${destination}`)
  process.exit(2)
}

cpSync(source, destination, { recursive: true, errorOnExist: true })

function git(...args) {
  const result = spawnSync('git', args, {
    cwd: destination,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    console.error(result.stderr.trim() || `git ${args[0]} failed`)
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

git('init', '-b', 'main')
git('config', 'user.name', 'RunGuild Evaluation Fixture')
git('config', 'user.email', 'evaluation@localhost')
git('add', '.')
git('commit', '-m', `baseline: ${family}`)

console.log(`family=${family}`)
console.log(`repository=${destination}`)
console.log(`baseline=${git('rev-parse', 'HEAD')}`)

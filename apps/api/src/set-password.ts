import {
  AuthenticationRepository,
  createDatabasePool,
  runMigrations,
  type UserRole,
} from '@runguild/database'
import type { UserId, WorkspaceId } from '@runguild/protocol'

import { authenticationDigest, hashPassword } from './authentication.js'

interface Arguments {
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly role?: UserRole
  readonly passwordStdin: boolean
}

function usage(): never {
  throw new Error(
    'Usage: npm run auth:set-password -- --workspace <id> --user <id> ' +
    '[--role owner|operator|viewer] [--password-stdin]',
  )
}

function parseArguments(values: readonly string[]): Arguments {
  let workspaceId: string | undefined
  let userId: string | undefined
  let role: UserRole | undefined
  let passwordStdin = false
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index]
    if (name === '--password-stdin') {
      passwordStdin = true
      continue
    }
    const value = values[index + 1]
    if (!value) usage()
    if (name === '--workspace') workspaceId = value
    else if (name === '--user') userId = value
    else if (name === '--role' && (value === 'owner' || value === 'operator' || value === 'viewer')) role = value
    else usage()
    index += 1
  }
  if (!workspaceId?.trim() || workspaceId.length > 200 || !userId?.trim() || userId.length > 200) usage()
  return {
    workspaceId: workspaceId.trim() as WorkspaceId,
    userId: userId.trim() as UserId,
    ...(role ? { role } : {}),
    passwordStdin,
  }
}

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('非交互终端请使用 --password-stdin 或 RUNGUILD_PASSWORD')
  }
  process.stdout.write(label)
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let password = ''
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: string | Buffer) => {
      const value = chunk.toString()
      for (const character of value) {
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(password)
          return
        }
        if (character === '\u0003') {
          cleanup()
          reject(new Error('已取消'))
          return
        }
        if (character === '\u007f' || character === '\b') password = password.slice(0, -1)
        else password += character
      }
    }
    process.stdin.on('data', onData)
  })
}

async function readPassword(arguments_: Arguments): Promise<string> {
  if (arguments_.passwordStdin) {
    process.stdin.setEncoding('utf8')
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    return input.replace(/[\r\n]+$/, '')
  }
  if (process.env.RUNGUILD_PASSWORD !== undefined) return process.env.RUNGUILD_PASSWORD
  const first = await promptHidden('新密码：')
  const second = await promptHidden('再次输入：')
  if (first !== second) throw new Error('两次输入的密码不一致')
  return first
}

const arguments_ = parseArguments(process.argv.slice(2))
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const password = await readPassword(arguments_)
const passwordHash = await hashPassword(password)
const pool = createDatabasePool(databaseUrl)
try {
  await runMigrations(pool)
  const repository = new AuthenticationRepository(pool)
  const version = await repository.setCredential({
    workspaceId: arguments_.workspaceId,
    userId: arguments_.userId,
    passwordHash,
    ...(arguments_.role ? { role: arguments_.role } : {}),
    principalHash: authenticationDigest(arguments_.workspaceId + '\u0000' + arguments_.userId),
    sourceHash: authenticationDigest('local-auth-cli'),
  })
  process.stdout.write('已更新用户 ' + arguments_.userId + ' 的登录凭据（版本 ' + version + '）。\n')
} finally {
  await pool.end()
}

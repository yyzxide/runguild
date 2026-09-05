import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { AuthenticationRepository } from '../dist/index.js'

function poolAdapter(database) {
  const client = {
    async query(statement, params = []) {
      const result = await database.query(statement, params)
      return { ...result, rowCount: result.affectedRows ?? result.rows.length }
    },
    release() {},
  }
  return { async connect() { return client }, query: client.query }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('Authentication Repository versions credentials, throttles login, and invalidates sessions', async () => {
  const database = new PGlite()
  try {
    await database.exec(await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0021_authentication.sql', import.meta.url), 'utf8'))
    await database.exec(
      "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace'), ('outside', 'Outside');" +
      "INSERT INTO users (id, workspace_id, display_name, role) VALUES " +
      "('user', 'ws', 'Operator', 'operator'), ('outsider', 'outside', 'Outsider', 'viewer');" +
      "INSERT INTO projects (id, workspace_id, name) VALUES " +
      "('project', 'ws', 'Project'), ('project_two', 'ws', 'Project Two');",
    )
    await database.exec(await readFile(new URL('../migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
    const repository = new AuthenticationRepository(poolAdapter(database))
    const principalHash = digest('ws\0user')
    const sourceHash = digest('127.0.0.1')
    const version = await repository.setCredential({
      workspaceId: 'ws',
      userId: 'user',
      passwordHash: '$scrypt$test-password-hash-material-that-is-long-enough',
      role: 'owner',
      principalHash,
      sourceHash,
    })
    assert.equal(version, 1)
    const credential = await repository.getCredential('ws', 'user')
    assert.equal(credential.displayName, 'Operator')
    assert.equal(credential.role, 'owner')
    assert.equal(await repository.getCredential('outside', 'user'), null)

    const loginKeyHash = digest('login-key')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const retryAfter = await repository.recordLoginFailure({
        keyHash: loginKeyHash,
        principalHash,
        sourceHash,
        windowSeconds: 900,
        maxFailures: 3,
        blockSeconds: 60,
      })
      assert.equal(retryAfter, attempt === 3 ? 60 : 0)
    }
    assert.ok(await repository.loginBlockedForSeconds(loginKeyHash) > 0)

    const now = Date.now()
    const session = await repository.createSession({
      id: 'auth_session_test',
      credential,
      tokenHash: digest('session-token'),
      csrfTokenHash: digest('csrf-token'),
      sourceHash,
      userAgentHash: digest('test-agent'),
      idleExpiresAt: new Date(now + 60_000),
      expiresAt: new Date(now + 3_600_000),
      principalHash,
      loginKeyHash,
    })
    assert.equal(session.role, 'owner')
    assert.equal(await repository.loginBlockedForSeconds(loginKeyHash), 0)
    assert.equal((await repository.resolveSession(digest('session-token'), 120))?.id, session.id)
    assert.deepEqual((await repository.listProjects('ws', 'user')).map((project) => project.id), [
      'project',
      'project_two',
    ])

    const nextVersion = await repository.setCredential({
      workspaceId: 'ws',
      userId: 'user',
      passwordHash: '$scrypt$replacement-password-hash-material-long-enough',
      principalHash,
      sourceHash,
    })
    assert.equal(nextVersion, 2)
    assert.equal(await repository.resolveSession(digest('session-token'), 120), null)

    const events = await database.query('SELECT kind FROM auth_events ORDER BY id')
    assert.deepEqual(events.rows.map((event) => event.kind), [
      'password_changed',
      'login_failed',
      'login_failed',
      'login_blocked',
      'login_succeeded',
      'password_changed',
    ])
  } finally {
    await database.close()
  }
})

test('Authentication Repository revokes only the exact active session', async () => {
  const database = new PGlite()
  try {
    await database.exec(await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../migrations/0021_authentication.sql', import.meta.url), 'utf8'))
    await database.exec(
      "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace');" +
      "INSERT INTO users (id, workspace_id, display_name) VALUES ('user', 'ws', 'Operator');",
    )
    const repository = new AuthenticationRepository(poolAdapter(database))
    const principalHash = digest('ws\0user')
    const sourceHash = digest('source')
    await repository.setCredential({
      workspaceId: 'ws', userId: 'user',
      passwordHash: '$scrypt$test-password-hash-material-that-is-long-enough',
      principalHash, sourceHash,
    })
    const credential = await repository.getCredential('ws', 'user')
    await repository.createSession({
      id: 'auth_session_revoke', credential,
      tokenHash: digest('token'), csrfTokenHash: digest('csrf'),
      sourceHash, userAgentHash: digest('agent'),
      idleExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 120_000),
      principalHash, loginKeyHash: digest('login'),
    })
    assert.equal(await repository.revokeSession({
      sessionId: 'auth_session_revoke', principalHash, sourceHash,
    }), true)
    assert.equal(await repository.revokeSession({
      sessionId: 'auth_session_revoke', principalHash, sourceHash,
    }), false)
    assert.equal(await repository.resolveSession(digest('token'), 60), null)
  } finally {
    await database.close()
  }
})

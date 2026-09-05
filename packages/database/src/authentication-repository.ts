import type { ProjectId, UserId, WorkspaceId } from '@runguild/protocol'
import type { Pool } from 'pg'

import { withTransaction } from './transaction.js'

export type UserRole = 'owner' | 'operator' | 'viewer'

export interface AuthenticationCredential {
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly displayName: string
  readonly role: UserRole
  readonly passwordHash: string
  readonly credentialVersion: number
}

export interface AuthenticationSession {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly displayName: string
  readonly role: UserRole
  readonly csrfTokenHash: string
  readonly credentialVersion: number
  readonly createdAt: Date
  readonly lastSeenAt: Date
  readonly idleExpiresAt: Date
  readonly expiresAt: Date
}

export interface AuthenticationProject {
  readonly id: ProjectId
  readonly name: string
  readonly role: UserRole
}

interface CredentialRow {
  readonly workspace_id: string
  readonly user_id: string
  readonly display_name: string
  readonly role: UserRole
  readonly password_hash: string
  readonly credential_version: number
}

interface SessionRow {
  readonly id: string
  readonly workspace_id: string
  readonly user_id: string
  readonly display_name: string
  readonly role: UserRole
  readonly csrf_token_hash: string
  readonly credential_version: number
  readonly created_at: Date
  readonly last_seen_at: Date
  readonly idle_expires_at: Date
  readonly expires_at: Date
}

function asCredential(row: CredentialRow): AuthenticationCredential {
  return {
    workspaceId: row.workspace_id as WorkspaceId,
    userId: row.user_id as UserId,
    displayName: row.display_name,
    role: row.role,
    passwordHash: row.password_hash,
    credentialVersion: row.credential_version,
  }
}

function asSession(row: SessionRow): AuthenticationSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id as WorkspaceId,
    userId: row.user_id as UserId,
    displayName: row.display_name,
    role: row.role,
    csrfTokenHash: row.csrf_token_hash,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    idleExpiresAt: row.idle_expires_at,
    expiresAt: row.expires_at,
  }
}

export class AuthenticationRepository {
  constructor(private readonly pool: Pool) {}

  async getCredential(workspaceId: WorkspaceId, userId: UserId): Promise<AuthenticationCredential | null> {
    const result = await this.pool.query<CredentialRow>(
      'SELECT credential.workspace_id, credential.user_id, user_account.display_name, ' +
      'user_account.role, credential.password_hash, credential.credential_version ' +
      'FROM user_credentials credential ' +
      'JOIN users user_account ON user_account.id = credential.user_id ' +
      'AND user_account.workspace_id = credential.workspace_id ' +
      'WHERE credential.workspace_id = $1 AND credential.user_id = $2',
      [workspaceId, userId],
    )
    return result.rows[0] ? asCredential(result.rows[0]) : null
  }

  async ensureLocalCredential(input: {
    readonly workspaceId: WorkspaceId
    readonly userId: UserId
    readonly passwordHash: string
  }): Promise<AuthenticationCredential> {
    return withTransaction(this.pool, async (client) => {
      const user = await client.query<{ readonly display_name: string; readonly role: UserRole }>(
        'SELECT display_name, role FROM users WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [input.workspaceId, input.userId],
      )
      const account = user.rows[0]
      if (!account) throw new Error('Local authentication user does not exist')
      const existing = await client.query<CredentialRow>(
        'SELECT credential.workspace_id, credential.user_id, user_account.display_name, ' +
        'user_account.role, credential.password_hash, credential.credential_version ' +
        'FROM user_credentials credential JOIN users user_account ON user_account.id = credential.user_id ' +
        'AND user_account.workspace_id = credential.workspace_id ' +
        'WHERE credential.workspace_id = $1 AND credential.user_id = $2',
        [input.workspaceId, input.userId],
      )
      if (existing.rows[0]) return asCredential(existing.rows[0])
      await client.query(
        "UPDATE users SET role = 'owner' WHERE workspace_id = $1 AND id = $2",
        [input.workspaceId, input.userId],
      )
      const inserted = await client.query<CredentialRow>(
        'INSERT INTO user_credentials (workspace_id, user_id, password_hash) VALUES ($1, $2, $3) ' +
        'RETURNING workspace_id, user_id, $4::text AS display_name, ' +
        "'owner'::text AS role, password_hash, credential_version",
        [input.workspaceId, input.userId, input.passwordHash, account.display_name],
      )
      const credential = inserted.rows[0]
      if (!credential) throw new Error('Local authentication credential was not created')
      return asCredential(credential)
    })
  }

  async setCredential(input: {
    readonly workspaceId: WorkspaceId
    readonly userId: UserId
    readonly passwordHash: string
    readonly role?: UserRole
    readonly principalHash: string
    readonly sourceHash: string
  }): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const user = await client.query<{ readonly role: UserRole }>(
        'SELECT role FROM users WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [input.workspaceId, input.userId],
      )
      if (!user.rows[0]) throw new Error('Authentication user does not exist in the Workspace')
      if (input.role) {
        await client.query(
          'UPDATE users SET role = $3 WHERE workspace_id = $1 AND id = $2',
          [input.workspaceId, input.userId, input.role],
        )
      }
      const credential = await client.query<{ readonly credential_version: number }>(
        'INSERT INTO user_credentials (workspace_id, user_id, password_hash) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, ' +
        'credential_version = user_credentials.credential_version + 1, updated_at = NOW() ' +
        'WHERE user_credentials.workspace_id = EXCLUDED.workspace_id ' +
        'RETURNING credential_version',
        [input.workspaceId, input.userId, input.passwordHash],
      )
      const row = credential.rows[0]
      if (!row) throw new Error('Authentication credential scope does not match the existing user')
      await client.query(
        'UPDATE auth_sessions SET revoked_at = NOW() ' +
        'WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [input.workspaceId, input.userId],
      )
      await client.query(
        "INSERT INTO auth_events (kind, principal_hash, source_hash) VALUES ('password_changed', $1, $2)",
        [input.principalHash, input.sourceHash],
      )
      return row.credential_version
    })
  }

  async loginBlockedForSeconds(keyHash: string): Promise<number> {
    const result = await this.pool.query<{ readonly retry_after: string }>(
      'SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (blocked_until - NOW()))), 0)::text AS retry_after ' +
      'FROM auth_login_attempts WHERE key_hash = $1 AND blocked_until > NOW()',
      [keyHash],
    )
    return result.rows[0] ? Number(result.rows[0].retry_after) : 0
  }

  async recordLoginFailure(input: {
    readonly keyHash: string
    readonly principalHash: string
    readonly sourceHash: string
    readonly windowSeconds: number
    readonly maxFailures: number
    readonly blockSeconds: number
  }): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<{
        readonly failure_count: number
        readonly window_started_at: Date
        readonly blocked_until: Date | null
      }>(
        'SELECT failure_count, window_started_at, blocked_until ' +
        'FROM auth_login_attempts WHERE key_hash = $1 FOR UPDATE',
        [input.keyHash],
      )
      const row = existing.rows[0]
      const activeWindow = Boolean(row && row.window_started_at.getTime() > Date.now() - input.windowSeconds * 1_000)
      const failureCount = activeWindow ? (row?.failure_count ?? 0) + 1 : 1
      const blocked = failureCount >= input.maxFailures
      await client.query(
        'INSERT INTO auth_login_attempts ' +
        '(key_hash, principal_hash, source_hash, failure_count, window_started_at, blocked_until, updated_at) ' +
        'VALUES ($1, $2, $3, $4, NOW(), ' +
        "CASE WHEN $5 THEN NOW() + ($6 * INTERVAL '1 second') ELSE NULL END, NOW()) " +
        'ON CONFLICT (key_hash) DO UPDATE SET principal_hash = EXCLUDED.principal_hash, ' +
        'source_hash = EXCLUDED.source_hash, failure_count = EXCLUDED.failure_count, ' +
        'window_started_at = CASE WHEN $7 THEN auth_login_attempts.window_started_at ELSE NOW() END, ' +
        'blocked_until = EXCLUDED.blocked_until, updated_at = NOW()',
        [
          input.keyHash,
          input.principalHash,
          input.sourceHash,
          failureCount,
          blocked,
          input.blockSeconds,
          activeWindow,
        ],
      )
      await client.query(
        'INSERT INTO auth_events (kind, principal_hash, source_hash) VALUES ($1, $2, $3)',
        [blocked ? 'login_blocked' : 'login_failed', input.principalHash, input.sourceHash],
      )
      return blocked ? input.blockSeconds : 0
    })
  }

  async createSession(input: {
    readonly id: string
    readonly credential: AuthenticationCredential
    readonly tokenHash: string
    readonly csrfTokenHash: string
    readonly sourceHash: string
    readonly userAgentHash: string
    readonly idleExpiresAt: Date
    readonly expiresAt: Date
    readonly principalHash: string
    readonly loginKeyHash: string
  }): Promise<AuthenticationSession> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<SessionRow>(
        'INSERT INTO auth_sessions ' +
        '(id, workspace_id, user_id, token_hash, csrf_token_hash, credential_version, source_hash, ' +
        'user_agent_hash, idle_expires_at, expires_at) ' +
        'SELECT $1, credential.workspace_id, credential.user_id, $4, $5, credential.credential_version, ' +
        '$6, $7, $8, $9 FROM user_credentials credential ' +
        'WHERE credential.workspace_id = $2 AND credential.user_id = $3 ' +
        'AND credential.credential_version = $10 ' +
        'RETURNING id, workspace_id, user_id, ' +
        '(SELECT display_name FROM users WHERE id = auth_sessions.user_id) AS display_name, ' +
        '(SELECT role FROM users WHERE id = auth_sessions.user_id) AS role, ' +
        'csrf_token_hash, credential_version, created_at, last_seen_at, idle_expires_at, expires_at',
        [
          input.id,
          input.credential.workspaceId,
          input.credential.userId,
          input.tokenHash,
          input.csrfTokenHash,
          input.sourceHash,
          input.userAgentHash,
          input.idleExpiresAt,
          input.expiresAt,
          input.credential.credentialVersion,
        ],
      )
      const row = inserted.rows[0]
      if (!row) throw new Error('Authentication credential changed before the session was created')
      await client.query('DELETE FROM auth_login_attempts WHERE key_hash = $1', [input.loginKeyHash])
      await client.query(
        "INSERT INTO auth_events (kind, principal_hash, source_hash, session_id) " +
        "VALUES ('login_succeeded', $1, $2, $3)",
        [input.principalHash, input.sourceHash, input.id],
      )
      return asSession(row)
    })
  }

  async resolveSession(tokenHash: string, idleSeconds: number): Promise<AuthenticationSession | null> {
    const result = await this.pool.query<SessionRow>(
      'SELECT session.id, session.workspace_id, session.user_id, user_account.display_name, ' +
      'user_account.role, session.csrf_token_hash, session.credential_version, session.created_at, ' +
      'session.last_seen_at, session.idle_expires_at, session.expires_at ' +
      'FROM auth_sessions session ' +
      'JOIN users user_account ON user_account.id = session.user_id ' +
      'AND user_account.workspace_id = session.workspace_id ' +
      'JOIN user_credentials credential ON credential.user_id = session.user_id ' +
      'AND credential.workspace_id = session.workspace_id ' +
      'WHERE session.token_hash = $1 AND session.revoked_at IS NULL ' +
      'AND session.expires_at > NOW() AND session.idle_expires_at > NOW() ' +
      'AND credential.credential_version = session.credential_version',
      [tokenHash],
    )
    const row = result.rows[0]
    if (!row) return null
    // Web polling may resolve several requests every few seconds. Keep idle
    // extension durable without creating a new PostgreSQL tuple per request.
    if (row.last_seen_at.getTime() >= Date.now() - 30_000) return asSession(row)
    const touched = await this.pool.query<SessionRow>(
      'UPDATE auth_sessions session SET last_seen_at = NOW(), ' +
      "idle_expires_at = LEAST(session.expires_at, NOW() + ($2 * INTERVAL '1 second')) " +
      'FROM users user_account, user_credentials credential ' +
      'WHERE session.id = $1 AND session.revoked_at IS NULL ' +
      'AND session.expires_at > NOW() AND session.idle_expires_at > NOW() ' +
      'AND user_account.id = session.user_id AND user_account.workspace_id = session.workspace_id ' +
      'AND credential.user_id = session.user_id AND credential.workspace_id = session.workspace_id ' +
      'AND credential.credential_version = session.credential_version ' +
      'RETURNING session.id, session.workspace_id, session.user_id, user_account.display_name, ' +
      'user_account.role, session.csrf_token_hash, session.credential_version, session.created_at, ' +
      'session.last_seen_at, session.idle_expires_at, session.expires_at',
      [row.id, idleSeconds],
    )
    return touched.rows[0] ? asSession(touched.rows[0]) : null
  }

  async listProjects(workspaceId: WorkspaceId, userId: UserId): Promise<readonly AuthenticationProject[]> {
    const result = await this.pool.query<{ readonly id: string; readonly name: string; readonly role: UserRole }>(
      'SELECT project.id, project.name, membership.role FROM project_memberships membership ' +
      'JOIN projects project ON project.id = membership.project_id ' +
      'AND project.workspace_id = membership.workspace_id ' +
      'WHERE membership.workspace_id = $1 AND membership.user_id = $2 ' +
      'ORDER BY project.updated_at DESC, project.id',
      [workspaceId, userId],
    )
    return result.rows.map((row) => ({ id: row.id as ProjectId, name: row.name, role: row.role }))
  }

  async revokeSession(input: {
    readonly sessionId: string
    readonly principalHash: string
    readonly sourceHash: string
  }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const revoked = await client.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
        [input.sessionId],
      )
      if (!revoked.rowCount) return false
      await client.query(
        "INSERT INTO auth_events (kind, principal_hash, source_hash, session_id) " +
        "VALUES ('logout', $1, $2, $3)",
        [input.principalHash, input.sourceHash, input.sessionId],
      )
      return true
    })
  }
}

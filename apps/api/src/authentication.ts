import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import type {
  AgentId,
  RunId,
  TaskId,
  ToolCallId,
  UserId,
  WorkspaceId,
} from '@runguild/protocol'
import type {
  AuthenticationCredential,
  AuthenticationProject,
  AuthenticationRepository,
  AuthenticationSession,
  UserRole,
} from '@runguild/database'
import type { Request, Response } from 'express'

import type {
  ArtifactRealtimeAuthenticationInput,
  ArtifactRealtimePrincipal,
} from './artifact-realtime.js'

const SESSION_COOKIE = 'runguild_session'
const SECURE_SESSION_COOKIE = '__Host-runguild_session'
const CSRF_COOKIE = 'runguild_csrf'
const SECURE_CSRF_COOKIE = '__Host-runguild_csrf'
const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_BYTES = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024
const LOGIN_WINDOW_SECONDS = 15 * 60
const LOGIN_MAX_FAILURES = 5
const LOGIN_BLOCK_SECONDS = 15 * 60
const DUMMY_SALT = Buffer.from('runguild-invalid-credential', 'utf8')

export type AuthenticatedActor =
  | { readonly kind: 'user'; readonly id: UserId }
  | { readonly kind: 'agent'; readonly id: AgentId }

export type RequestAuthentication =
  | {
      readonly mode: 'session'
      readonly actor: Extract<AuthenticatedActor, { readonly kind: 'user' }>
      readonly session: AuthenticationSession
    }
  | {
      readonly mode: 'agent_token'
      readonly actor: Extract<AuthenticatedActor, { readonly kind: 'agent' }>
    }

export interface AuthenticationSessionView {
  readonly user: {
    readonly id: UserId
    readonly workspaceId: WorkspaceId
    readonly displayName: string
    readonly role: UserRole
  }
  readonly projects: readonly AuthenticationProject[]
  readonly expiresAt: string
  readonly idleExpiresAt: string
}

export class AuthenticationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export interface SessionAuthenticationOptions {
  readonly secureCookies: boolean
  readonly allowedOrigins: readonly string[]
  readonly sessionLifetimeSeconds?: number
  readonly sessionIdleSeconds?: number
  readonly internalAgentToken?: string
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function fixedTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

function validatePassword(password: string): void {
  const bytes = Buffer.byteLength(password)
  if (bytes < 12 || bytes > 1_024) {
    throw new AuthenticationError(
      'password_policy',
      400,
      '密码长度必须为 12 到 1024 个 UTF-8 字节',
    )
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password)
  const salt = randomBytes(16)
  const derived = await derivePassword(password, salt)
  return '$scrypt$N=' + SCRYPT_N + ',r=' + SCRYPT_R + ',p=' + SCRYPT_P + '$' +
    salt.toString('base64url') + '$' + derived.toString('base64url')
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded)
  if (!match || Number(match[1]) !== SCRYPT_N || Number(match[2]) !== SCRYPT_R
      || Number(match[3]) !== SCRYPT_P || !match[4] || !match[5]) return false
  const expected = Buffer.from(match[5], 'base64url')
  if (expected.length !== SCRYPT_BYTES) return false
  const actual = await derivePassword(password, Buffer.from(match[4], 'base64url'))
  return timingSafeEqual(actual, expected)
}

let dummyPasswordHash: Promise<string> | undefined

function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= derivePassword('runguild-invalid-password', DUMMY_SALT).then((derived) =>
    '$scrypt$N=' + SCRYPT_N + ',r=' + SCRYPT_R + ',p=' + SCRYPT_P + '$' +
      DUMMY_SALT.toString('base64url') + '$' + derived.toString('base64url'))
  return dummyPasswordHash
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0]?.trim() : value?.trim()
}

function parseCookies(request: IncomingMessage): Readonly<Record<string, string>> {
  const cookies: Record<string, string> = {}
  const header = requestHeader(request, 'cookie')
  if (!header) return cookies
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name && value && !(name in cookies)) cookies[name] = value
  }
  return cookies
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = requestHeader(request, 'authorization')
  if (!authorization) return null
  const match = /^Bearer ([A-Za-z0-9._~-]{16,4096})$/.exec(authorization)
  return match?.[1] ?? ''
}

function sourceAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress?.trim() || 'unknown-source'
}

function userAgent(request: IncomingMessage): string {
  return requestHeader(request, 'user-agent')?.slice(0, 1_000) || 'unknown-user-agent'
}

function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE
}

function csrfCookieName(secure: boolean): string {
  return secure ? SECURE_CSRF_COOKIE : CSRF_COOKIE
}

function serializeCookie(
  name: string,
  value: string,
  options: { readonly secure: boolean; readonly httpOnly: boolean; readonly maxAge: number },
): string {
  return name + '=' + value + '; Path=/; Max-Age=' + Math.max(0, Math.floor(options.maxAge)) +
    '; SameSite=Strict' + (options.secure ? '; Secure' : '') + (options.httpOnly ? '; HttpOnly' : '')
}

export function authenticationDigest(value: string): string {
  return digest(value)
}

export class SessionAuthentication {
  private readonly allowedOrigins: ReadonlySet<string>
  private readonly sessionLifetimeSeconds: number
  private readonly sessionIdleSeconds: number

  constructor(
    private readonly repository: AuthenticationRepository,
    private readonly options: SessionAuthenticationOptions,
  ) {
    this.allowedOrigins = new Set(options.allowedOrigins.map((origin) => origin.replace(/\/$/, '')))
    this.sessionLifetimeSeconds = options.sessionLifetimeSeconds ?? 12 * 60 * 60
    this.sessionIdleSeconds = options.sessionIdleSeconds ?? 60 * 60
    if (!Number.isInteger(this.sessionLifetimeSeconds) || this.sessionLifetimeSeconds < 300) {
      throw new RangeError('Session lifetime must be an integer of at least 300 seconds')
    }
    if (!Number.isInteger(this.sessionIdleSeconds) || this.sessionIdleSeconds < 60
        || this.sessionIdleSeconds > this.sessionLifetimeSeconds) {
      throw new RangeError('Session idle timeout must be between 60 seconds and the session lifetime')
    }
    if (options.internalAgentToken !== undefined && options.internalAgentToken.length < 32) {
      throw new RangeError('Internal Agent token must contain at least 32 characters')
    }
  }

  async signIn(input: {
    readonly workspaceId: string
    readonly userId: string
    readonly password: string
    readonly request: IncomingMessage
  }): Promise<{
    readonly authentication: RequestAuthentication & { readonly mode: 'session' }
    readonly sessionToken: string
    readonly csrfToken: string
    readonly view: AuthenticationSessionView
  }> {
    if (!input.workspaceId.trim() || input.workspaceId.length > 200
        || !input.userId.trim() || input.userId.length > 200
        || Buffer.byteLength(input.password) > 1_024) {
      throw new AuthenticationError('invalid_credentials', 401, '工作区、用户或密码不正确')
    }
    const workspaceId = input.workspaceId.trim() as WorkspaceId
    const userId = input.userId.trim() as UserId
    const sourceHash = digest(sourceAddress(input.request))
    const principalHash = digest(workspaceId + '\u0000' + userId)
    const loginKeyHash = digest(principalHash + '\u0000' + sourceHash)
    const blockedFor = await this.repository.loginBlockedForSeconds(loginKeyHash)
    if (blockedFor > 0) {
      throw new AuthenticationError('login_rate_limited', 429, '登录尝试过多，请稍后重试', blockedFor)
    }
    const credential = await this.repository.getCredential(workspaceId, userId)
    const passwordHash = credential?.passwordHash ?? await getDummyPasswordHash()
    const valid = await verifyPassword(input.password, passwordHash)
    if (!credential || !valid) {
      const retryAfter = await this.repository.recordLoginFailure({
        keyHash: loginKeyHash,
        principalHash,
        sourceHash,
        windowSeconds: LOGIN_WINDOW_SECONDS,
        maxFailures: LOGIN_MAX_FAILURES,
        blockSeconds: LOGIN_BLOCK_SECONDS,
      })
      throw new AuthenticationError(
        retryAfter ? 'login_rate_limited' : 'invalid_credentials',
        retryAfter ? 429 : 401,
        retryAfter ? '登录尝试过多，请稍后重试' : '工作区、用户或密码不正确',
        retryAfter || undefined,
      )
    }
    const sessionToken = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    const now = Date.now()
    const expiresAt = new Date(now + this.sessionLifetimeSeconds * 1_000)
    const idleExpiresAt = new Date(Math.min(
      expiresAt.getTime(),
      now + this.sessionIdleSeconds * 1_000,
    ))
    const session = await this.repository.createSession({
      id: 'auth_session_' + randomUUID(),
      credential,
      tokenHash: digest(sessionToken),
      csrfTokenHash: digest(csrfToken),
      sourceHash,
      userAgentHash: digest(userAgent(input.request)),
      idleExpiresAt,
      expiresAt,
      principalHash,
      loginKeyHash,
    })
    const authentication = {
      mode: 'session' as const,
      actor: { kind: 'user' as const, id: session.userId },
      session,
    }
    return {
      authentication,
      sessionToken,
      csrfToken,
      view: await this.sessionView(session),
    }
  }

  async authenticateHttp(request: IncomingMessage): Promise<RequestAuthentication | null> {
    const token = bearerToken(request)
    if (token !== null) {
      if (!token || !this.options.internalAgentToken
          || !fixedTimeEqual(token, this.options.internalAgentToken)) return null
      const actorId = requestHeader(request, 'x-actor-id')
      if (!actorId || requestHeader(request, 'x-actor-kind') !== 'agent') return null
      return { mode: 'agent_token', actor: { kind: 'agent', id: actorId as AgentId } }
    }
    const cookies = parseCookies(request)
    const sessionToken = cookies[sessionCookieName(this.options.secureCookies)]
    if (!sessionToken || sessionToken.length > 200) return null
    const session = await this.repository.resolveSession(digest(sessionToken), this.sessionIdleSeconds)
    return session
      ? { mode: 'session', actor: { kind: 'user', id: session.userId }, session }
      : null
  }

  async authenticateRealtime(
    input: ArtifactRealtimeAuthenticationInput,
  ): Promise<ArtifactRealtimePrincipal | null> {
    const token = bearerToken(input.request)
    if (token !== null) {
      if (!token || !this.options.internalAgentToken
          || !fixedTimeEqual(token, this.options.internalAgentToken)) return null
      const actorId = requestHeader(input.request, 'x-actor-id')
      const runId = requestHeader(input.request, 'x-run-id')
      const taskId = requestHeader(input.request, 'x-task-id')
      const toolCallId = requestHeader(input.request, 'x-tool-call-id')
      const intent = requestHeader(input.request, 'x-edit-intent')
      return actorId && requestHeader(input.request, 'x-actor-kind') === 'agent'
        && runId && taskId && toolCallId && intent
        ? {
            kind: 'agent',
            agentId: actorId as AgentId,
            runId: runId as RunId,
            taskId: taskId as TaskId,
            toolCallId: toolCallId as ToolCallId,
            intent,
          }
        : null
    }
    if (!this.originAllowed(input.request)) return null
    const authentication = await this.authenticateHttp(input.request)
    if (!authentication || authentication.mode !== 'session'
        || authentication.session.workspaceId !== input.workspaceId) return null
    return {
      kind: 'user',
      userId: authentication.session.userId,
      sessionId: authentication.session.id,
    }
  }

  originAllowed(request: IncomingMessage): boolean {
    const origin = requestHeader(request, 'origin')?.replace(/\/$/, '')
    return Boolean(origin && this.allowedOrigins.has(origin))
  }

  verifyCsrf(request: IncomingMessage, authentication: RequestAuthentication): boolean {
    if (authentication.mode !== 'session') return true
    const headerToken = requestHeader(request, 'x-csrf-token')
    const cookieToken = parseCookies(request)[csrfCookieName(this.options.secureCookies)]
    return Boolean(headerToken && cookieToken
      && fixedTimeEqual(headerToken, cookieToken)
      && fixedTimeEqual(digest(headerToken), authentication.session.csrfTokenHash))
  }

  setSessionCookies(
    response: Response,
    input: { readonly sessionToken: string; readonly csrfToken: string; readonly expiresAt: Date },
  ): void {
    const maxAge = Math.max(0, (input.expiresAt.getTime() - Date.now()) / 1_000)
    response.append('Set-Cookie', serializeCookie(
      sessionCookieName(this.options.secureCookies),
      input.sessionToken,
      { secure: this.options.secureCookies, httpOnly: true, maxAge },
    ))
    response.append('Set-Cookie', serializeCookie(
      csrfCookieName(this.options.secureCookies),
      input.csrfToken,
      { secure: this.options.secureCookies, httpOnly: false, maxAge },
    ))
  }

  clearSessionCookies(response: Response): void {
    response.append('Set-Cookie', serializeCookie(
      sessionCookieName(this.options.secureCookies),
      '',
      { secure: this.options.secureCookies, httpOnly: true, maxAge: 0 },
    ))
    response.append('Set-Cookie', serializeCookie(
      csrfCookieName(this.options.secureCookies),
      '',
      { secure: this.options.secureCookies, httpOnly: false, maxAge: 0 },
    ))
  }

  async sessionView(session: AuthenticationSession): Promise<AuthenticationSessionView> {
    return {
      user: {
        id: session.userId,
        workspaceId: session.workspaceId,
        displayName: session.displayName,
        role: session.role,
      },
      projects: await this.repository.listProjects(session.workspaceId),
      expiresAt: session.expiresAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
    }
  }

  async signOut(authentication: RequestAuthentication, request: IncomingMessage): Promise<void> {
    if (authentication.mode !== 'session') return
    await this.repository.revokeSession({
      sessionId: authentication.session.id,
      principalHash: digest(authentication.session.workspaceId + '\u0000' + authentication.session.userId),
      sourceHash: digest(sourceAddress(request)),
    })
  }
}

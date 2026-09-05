import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import {
  AuthenticationRepository,
  ProjectLifecycleRepository,
  ProjectMembershipRepository,
  ProjectProvisioningRepository,
} from '@runguild/database'

import { createApiApp } from '../dist/app.js'
import { SessionAuthentication, hashPassword, verifyPassword } from '../dist/authentication.js'

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

async function withDatabase(operation) {
  const database = new PGlite()
  try {
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0001_core.sql', import.meta.url), 'utf8'))
    await database.exec('ALTER TABLE projects ADD COLUMN repository_path TEXT;')
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0009_evaluation.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0010_conversations.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0012_worker_instances.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0013_project_runtime_config.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0019_project_scoped_integration_workers.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0020_project_scoped_agent_workers.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0021_authentication.sql', import.meta.url), 'utf8'))
    await database.exec(
      "INSERT INTO workspaces (id, name) VALUES ('ws', 'Workspace'), ('other', 'Other');" +
      "INSERT INTO users (id, workspace_id, display_name, role) VALUES " +
      "('owner', 'ws', 'Owner', 'owner'), ('viewer', 'ws', 'Viewer', 'viewer');" +
      "INSERT INTO projects (id, workspace_id, name) VALUES ('project', 'ws', 'Project');",
    )
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0022_project_memberships.sql', import.meta.url), 'utf8'))
    await database.exec(await readFile(new URL('../../../packages/database/migrations/0023_project_lifecycle.sql', import.meta.url), 'utf8'))
    const repository = new AuthenticationRepository(poolAdapter(database))
    const projectLifecycle = new ProjectLifecycleRepository(poolAdapter(database))
    const projectMemberships = new ProjectMembershipRepository(poolAdapter(database))
    const projectProvisioning = new ProjectProvisioningRepository(poolAdapter(database))
    for (const [userId, role] of [['owner', 'owner'], ['viewer', 'viewer']]) {
      await repository.setCredential({
        workspaceId: 'ws', userId, role,
        passwordHash: await hashPassword('correct horse battery staple ' + userId),
        principalHash: digest('ws\0' + userId), sourceHash: digest('test-setup'),
      })
    }
    await operation({ database, repository, projectMemberships, projectProvisioning, projectLifecycle })
  } finally {
    await database.close()
  }
}

function request(headers = {}, remoteAddress = '127.0.0.1') {
  return { headers, socket: { remoteAddress } }
}

function sessionCookies(response) {
  const setCookies = response.headers.getSetCookie()
  return {
    header: setCookies.map((value) => value.split(';', 1)[0]).join('; '),
    csrf: setCookies.find((value) => value.startsWith('runguild_csrf='))?.split(/[=;]/)[1],
    raw: setCookies,
  }
}

async function withServer(app, operation) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  try {
    await operation('http://127.0.0.1:' + address.port)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

function apiDependencies(authentication, overviewCalls, projectMemberships, projectProvisioning, projectLifecycle) {
  return {
    authentication,
    ...(projectMemberships ? { projectMemberships } : {}),
    ...(projectProvisioning ? { projectProvisioning } : {}),
    ...(projectLifecycle ? { projectLifecycle } : {}),
    missions: {}, conversations: {}, conversationPlanning: {}, runControls: {}, taskControls: {},
    toolApprovals: {}, artifacts: {}, reviews: {}, reviewerExecutions: {}, skills: {}, evaluations: {},
    projectRuntimeConfigs: {}, runTraces: {},
    projectOperator: {
      async getOverview(workspaceId, projectId, userId) {
        overviewCalls.push({ workspaceId, projectId, userId })
        return { project: { id: projectId, workspaceId }, agents: [], missions: [], systemWorkers: [] }
      },
    },
  }
}

test('password hashing and session authentication keep browser and Agent trust paths separate', async () => {
  const encoded = await hashPassword('a sufficiently long password')
  assert.equal(await verifyPassword('a sufficiently long password', encoded), true)
  assert.equal(await verifyPassword('a different long password', encoded), false)
  await assert.rejects(() => hashPassword('too-short'), /密码长度/)

  await withDatabase(async ({ repository }) => {
    const authentication = new SessionAuthentication(repository, {
      secureCookies: false,
      allowedOrigins: ['http://127.0.0.1:4173'],
      internalAgentToken: 'agent-token-material-with-at-least-32-characters',
    })
    const signedIn = await authentication.signIn({
      workspaceId: 'ws', userId: 'owner', password: 'correct horse battery staple owner',
      request: request({ origin: 'http://127.0.0.1:4173', 'user-agent': 'test' }),
    })
    assert.equal(signedIn.view.user.role, 'owner')
    assert.deepEqual(signedIn.view.projects.map((project) => project.id), ['project'])

    const cookieHeader = 'runguild_session=' + signedIn.sessionToken + '; runguild_csrf=' + signedIn.csrfToken
    const browserRequest = request({ cookie: cookieHeader, 'x-csrf-token': signedIn.csrfToken })
    const resolved = await authentication.authenticateHttp(browserRequest)
    assert.equal(resolved?.mode, 'session')
    assert.equal(authentication.verifyCsrf(browserRequest, resolved), true)
    assert.equal(authentication.verifyCsrf(request({ cookie: cookieHeader, 'x-csrf-token': 'wrong' }), resolved), false)
    assert.equal((await authentication.authenticateRealtime({
      request: request({ cookie: cookieHeader, origin: 'http://127.0.0.1:4173' }),
      workspaceId: 'ws', artifactId: 'artifact',
    }))?.kind, 'user')
    assert.equal(await authentication.authenticateRealtime({
      request: request({ cookie: cookieHeader, origin: 'https://attacker.example' }),
      workspaceId: 'ws', artifactId: 'artifact',
    }), null)

    const agent = await authentication.authenticateHttp(request({
      authorization: 'Bearer agent-token-material-with-at-least-32-characters',
      'x-actor-kind': 'agent', 'x-actor-id': 'builder',
    }))
    assert.deepEqual(agent, { mode: 'agent_token', actor: { kind: 'agent', id: 'builder' } })
    assert.equal(await authentication.authenticateHttp(request({
      authorization: 'Bearer wrong-token-material', 'x-actor-kind': 'agent', 'x-actor-id': 'builder',
    })), null)
  })
})

test('API ignores spoofed actor headers and enforces Origin, CSRF, Workspace and project-role boundaries', async () => {
  await withDatabase(async ({ database, repository, projectMemberships, projectProvisioning, projectLifecycle }) => {
    const authentication = new SessionAuthentication(repository, {
      secureCookies: false,
      allowedOrigins: ['http://127.0.0.1:4173'],
    })
    const overviewCalls = []
    const app = createApiApp(apiDependencies(authentication, overviewCalls, projectMemberships, projectProvisioning, projectLifecycle), {
      authenticationMode: 'team',
      defaultWorkspaceId: 'ws',
    })
    await withServer(app, async (baseUrl) => {
      const spoofed = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/operator-overview', {
        headers: { 'x-actor-id': 'owner' },
      })
      assert.equal(spoofed.status, 401)

      const originless = await fetch(baseUrl + '/api/v1/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws', userId: 'owner', password: 'correct horse battery staple owner' }),
      })
      assert.equal(originless.status, 403)

      const login = await fetch(baseUrl + '/api/v1/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' },
        body: JSON.stringify({ userId: 'owner', password: 'correct horse battery staple owner' }),
      })
      assert.equal(login.status, 200)
      const cookies = sessionCookies(login)
      assert.ok(cookies.raw.some((value) => value.includes('HttpOnly') && value.includes('SameSite=Strict')))
      assert.ok(cookies.csrf)

      const session = await fetch(baseUrl + '/api/v1/auth/session', { headers: { cookie: cookies.header } })
      assert.equal(session.status, 200)
      assert.equal((await session.json()).user.id, 'owner')

      const overview = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/operator-overview', {
        headers: { cookie: cookies.header, 'x-actor-id': 'viewer' },
      })
      assert.equal(overview.status, 200)
      assert.deepEqual(overviewCalls, [{ workspaceId: 'ws', projectId: 'project', userId: 'owner' }])

      const members = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/members', {
        headers: { cookie: cookies.header },
      })
      assert.equal(members.status, 200)
      assert.deepEqual((await members.json()).members.map(({ userId, role }) => [userId, role]), [
        ['owner', 'owner'], ['viewer', 'viewer'],
      ])

      const addMember = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/members', {
        method: 'POST',
        headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': cookies.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'operator', displayName: 'Operator', role: 'operator', password: 'correct horse battery staple operator' }),
      })
      assert.equal(addMember.status, 201)
      assert.equal((await addMember.json()).members.some(({ userId }) => userId === 'operator'), true)

      const createProject = await fetch(baseUrl + '/api/v1/workspaces/ws/projects', {
        method: 'POST',
        headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': cookies.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Created from Web', repositoryPath: '/workspace/new-project', defaultBranch: 'develop' }),
      })
      assert.equal(createProject.status, 201)
      const createdProject = (await createProject.json()).project
      assert.equal(createdProject.role, 'owner')
      assert.equal(createdProject.agents.length, 4)
      const refreshedSession = await fetch(baseUrl + '/api/v1/auth/session', { headers: { cookie: cookies.header } })
      assert.equal((await refreshedSession.json()).projects.some(({ id, role }) => id === createdProject.id && role === 'owner'), true)

      const lifecyclePath = baseUrl + '/api/v1/workspaces/ws/projects/' + createdProject.id + '/lifecycle'
      const renamedProject = await fetch(lifecyclePath, {
        method: 'PATCH',
        headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': cookies.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rename', name: 'Renamed from Web' }),
      })
      assert.equal(renamedProject.status, 200)
      assert.equal((await renamedProject.json()).project.name, 'Renamed from Web')
      const archivedProject = await fetch(lifecyclePath, {
        method: 'PATCH',
        headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': cookies.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      })
      assert.equal(archivedProject.status, 200)
      assert.ok((await archivedProject.json()).project.archivedAt)
      const archivedMutation = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/' + createdProject.id + '/members', {
        method: 'POST',
        headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': cookies.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'archived-user', displayName: 'Archived', role: 'viewer', password: 'correct horse battery staple archived' }),
      })
      assert.equal(archivedMutation.status, 409)
      assert.equal((await archivedMutation.json()).error.code, 'project_archived')
      const archivedConversationMutation = await fetch(
        baseUrl + '/api/v1/workspaces/ws/conversations/' + createdProject.conversationId + '/messages',
        {
          method: 'POST',
          headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': cookies.csrf, 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'Archived write must not reach the repository.', mentions: [], entityRefs: {} }),
        },
      )
      assert.equal(archivedConversationMutation.status, 409)
      assert.equal((await archivedConversationMutation.json()).error.code, 'project_archived')
      const restoredProject = await fetch(lifecyclePath, {
        method: 'PATCH',
        headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': cookies.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restore' }),
      })
      assert.equal(restoredProject.status, 200)
      assert.equal((await restoredProject.json()).project.archivedAt, null)

      await database.exec("INSERT INTO projects (id, workspace_id, name) VALUES ('private_project', 'ws', 'Private')")
      const privateProject = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/private_project/operator-overview', {
        headers: { cookie: cookies.header },
      })
      assert.equal(privateProject.status, 404)

      const outside = await fetch(baseUrl + '/api/v1/workspaces/other/projects/project/operator-overview', {
        headers: { cookie: cookies.header },
      })
      assert.equal(outside.status, 404)

      const missingCsrf = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/missions', {
        method: 'POST', headers: { cookie: cookies.header, origin: 'http://127.0.0.1:4173', 'content-type': 'application/json' }, body: '{}',
      })
      assert.equal(missingCsrf.status, 403)

      const viewerLogin = await fetch(baseUrl + '/api/v1/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4173' },
        body: JSON.stringify({ workspaceId: 'ws', userId: 'viewer', password: 'correct horse battery staple viewer' }),
      })
      const viewerCookies = sessionCookies(viewerLogin)
      const viewerCreate = await fetch(baseUrl + '/api/v1/workspaces/ws/projects', {
        method: 'POST',
        headers: { cookie: viewerCookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': viewerCookies.csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Viewer Project', defaultBranch: 'main' }),
      })
      assert.equal(viewerCreate.status, 403)
      const readOnly = await fetch(baseUrl + '/api/v1/workspaces/ws/projects/project/missions', {
        method: 'POST',
        headers: { cookie: viewerCookies.header, origin: 'http://127.0.0.1:4173', 'x-csrf-token': viewerCookies.csrf, 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(readOnly.status, 403)
      assert.equal((await readOnly.json()).error.code, 'read_only_role')
    })
  })
})

test('local mode creates the configured loopback owner session without exposing a password login', async () => {
  await withDatabase(async ({ database, repository, projectMemberships, projectProvisioning, projectLifecycle }) => {
    await database.exec(
      "INSERT INTO users (id, workspace_id, display_name, role) VALUES ('local-user', 'ws', 'Local User', 'owner');" +
      "INSERT INTO project_memberships (workspace_id, project_id, user_id, role) " +
      "VALUES ('ws', 'project', 'local-user', 'owner')",
    )
    const authentication = new SessionAuthentication(repository, {
      secureCookies: false,
      allowedOrigins: ['http://127.0.0.1:4173'],
    })
    await assert.rejects(() => authentication.signInLocal({
      workspaceId: 'ws', userId: 'local-user', request: request({}, '192.0.2.10'),
    }), (error) => error.code === 'local_authentication_forbidden')
    await assert.rejects(() => authentication.signInLocal({
      workspaceId: 'ws', userId: 'local-user',
      request: request({ 'x-forwarded-for': '127.0.0.1' }),
    }), (error) => error.code === 'local_authentication_forbidden')

    const app = createApiApp(apiDependencies(authentication, [], projectMemberships, projectProvisioning, projectLifecycle), {
      authenticationMode: 'local',
      defaultWorkspaceId: 'ws',
      localUserId: 'local-user',
    })
    await withServer(app, async (baseUrl) => {
      const mode = await fetch(baseUrl + '/api/v1/auth/mode')
      assert.deepEqual(await mode.json(), { mode: 'local' })

      const login = await fetch(baseUrl + '/api/v1/auth/local', {
        method: 'POST', headers: { origin: 'http://127.0.0.1:4173' },
      })
      assert.equal(login.status, 200)
      const view = await login.json()
      assert.equal(view.user.id, 'local-user')
      assert.equal(view.user.role, 'owner')
      assert.deepEqual(view.projects.map((project) => project.name), ['Project'])
      assert.ok(sessionCookies(login).raw.some((value) => value.includes('HttpOnly')))
    })
  })
})

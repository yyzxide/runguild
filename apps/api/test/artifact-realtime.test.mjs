import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { WebSocket } from 'ws'

import { attachArtifactRealtimeServer } from '../dist/artifact-realtime.js'

function messageInbox(socket) {
  const messages = []
  const waiters = []
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message))
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      waiter.resolve(message)
    } else {
      messages.push(message)
    }
  })
  return {
    next(predicate, timeoutMs = 2_000) {
      const index = messages.findIndex(predicate)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject }
        waiters.push(waiter)
        const timer = setTimeout(() => {
          const pending = waiters.indexOf(waiter)
          if (pending >= 0) waiters.splice(pending, 1)
          reject(new Error('Timed out waiting for WebSocket message'))
        }, timeoutMs)
        timer.unref()
        waiter.resolve = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
      })
    },
  }
}

async function openClient(url, actorId, sessionId) {
  const socket = new WebSocket(url, {
    headers: {
      'x-actor-id': actorId,
      'x-session-id': sessionId,
    },
  })
  const inbox = messageInbox(socket)
  await once(socket, 'open')
  await inbox.next((message) => message.type === 'sync')
  await inbox.next((message) => message.type === 'awareness.snapshot')
  return { socket, inbox }
}

function fanoutHub() {
  const endpoints = []
  return {
    endpoint() {
      const notifications = new Set()
      const recoveries = new Set()
      const endpoint = {
        subscribe(listener) {
          notifications.add(listener)
          return () => notifications.delete(listener)
        },
        onRecovered(listener) {
          recoveries.add(listener)
          return () => recoveries.delete(listener)
        },
        recover() {
          for (const listener of recoveries) listener()
        },
        deliver(notification) {
          for (const listener of notifications) listener(notification)
        },
        notifications,
      }
      endpoints.push(endpoint)
      return endpoint
    },
    publish(notification) {
      for (const endpoint of endpoints) {
        for (const listener of endpoint.notifications) listener(notification)
      }
    },
  }
}

async function expectNoMessage(inbox, predicate) {
  await assert.rejects(inbox.next(predicate, 100), /Timed out waiting for WebSocket message/)
}

test('Artifact realtime persists updates before broadcast and cleans ephemeral awareness', async () => {
  const calls = []
  let persisted = false
  const repository = {
    async authorizeActor(input) {
      calls.push(['authorize', input])
    },
    async syncState(input) {
      calls.push(['sync', input])
      return {
        update: Uint8Array.from([0, 0]),
        stateVector: Uint8Array.from([0]),
        stateHash: 'empty_hash',
        throughUpdateSeq: 0n,
      }
    },
    async appendUpdate(input) {
      calls.push(['append', input])
      await new Promise((resolve) => setTimeout(resolve, 20))
      persisted = true
      return { seq: 1n, updateHash: 'persisted_hash', inserted: true }
    },
  }
  const httpServer = createServer()
  const realtime = attachArtifactRealtimeServer(httpServer, { repository })
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const url = 'ws://127.0.0.1:' + address.port +
    '/api/v1/workspaces/ws_realtime/artifacts/artifact_realtime/collaboration'

  const alice = await openClient(url, 'user_alice', 'session_alice')
  const bob = await openClient(url, 'user_bob', 'session_bob')
  try {
    alice.socket.send(JSON.stringify({
      type: 'awareness',
      state: { displayName: 'Alice', color: '#3366ff', cursor: { anchor: 2, head: 4 } },
    }))
    const presence = await bob.inbox.next((message) => message.type === 'awareness.update')
    assert.equal(presence.client.identity.actorId, 'user_alice')
    assert.equal(presence.client.state.cursor.head, 4)

    alice.socket.send(JSON.stringify({
      type: 'update',
      update: Buffer.from([1, 2, 3]).toString('base64url'),
      clientUpdateId: 'local_1',
    }))
    const broadcast = await bob.inbox.next((message) => message.type === 'update')
    assert.equal(persisted, true)
    assert.equal(broadcast.seq, '1')
    assert.equal(broadcast.origin.actorId, 'user_alice')
    const acknowledgement = await alice.inbox.next((message) => message.type === 'update.ack')
    assert.equal(acknowledgement.clientUpdateId, 'local_1')
    assert.equal(acknowledgement.inserted, true)

    alice.socket.close()
    await once(alice.socket, 'close')
    const removed = await bob.inbox.next((message) => message.type === 'awareness.remove')
    assert.match(removed.clientId, /^presence_/)

    bob.socket.send(JSON.stringify({
      type: 'sync',
      stateVector: Buffer.from([9]).toString('base64url'),
    }))
    await bob.inbox.next((message) => message.type === 'sync')
    assert.deepEqual([...calls.at(-1)[1].remoteStateVector], [9])
    const append = calls.find(([kind]) => kind === 'append')
    assert.equal(append[1].origin.sessionId, 'session_alice')
  } finally {
    if (alice.socket.readyState !== WebSocket.CLOSED) alice.socket.close()
    bob.socket.close()
    await once(bob.socket, 'close')
    await realtime.close()
    httpServer.close()
    await once(httpServer, 'close')
  }
})

test('Artifact realtime rejects missing identity before WebSocket upgrade', async () => {
  const httpServer = createServer()
  const realtime = attachArtifactRealtimeServer(httpServer, {
    repository: {
      async authorizeActor() {
        throw new Error('must not be reached')
      },
      async syncState() {
        throw new Error('must not be reached')
      },
      async appendUpdate() {
        throw new Error('must not be reached')
      },
    },
  })
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const socket = new WebSocket(
    'ws://127.0.0.1:' + address.port +
    '/api/v1/workspaces/ws/artifacts/artifact/collaboration',
  )
  const errorEvent = once(socket, 'error')
  const closeEvent = new Promise((resolve) => socket.once('close', resolve))
  const [error] = await errorEvent
  assert.match(error.message, /401/)
  await closeEvent
  await realtime.close()
  httpServer.close()
  await once(httpServer, 'close')
})

test('Artifact realtime fans durable updates across instances once and resyncs after recovery', async () => {
  const persisted = new Map()
  const reads = []
  let nextSeq = 0n
  const repository = {
    async authorizeActor() {},
    async syncState(input) {
      const latest = [...persisted.values()]
        .filter((item) => item.workspaceId === input.workspaceId && item.artifactId === input.artifactId)
        .at(-1)
      return {
        update: latest?.update ?? Uint8Array.from([0, 0]),
        stateVector: Uint8Array.from([0]),
        stateHash: latest?.updateHash ?? 'empty_hash',
        throughUpdateSeq: latest?.seq ?? 0n,
      }
    },
    async appendUpdate(input) {
      nextSeq += 1n
      const updateHash = createHash('sha256').update(input.update).digest('hex')
      const value = { ...input, seq: nextSeq, updateHash }
      persisted.set(input.artifactId + ':' + nextSeq, value)
      return { seq: nextSeq, updateHash, inserted: true }
    },
    async readPersistedUpdate(input) {
      reads.push(input)
      const value = persisted.get(input.artifactId + ':' + input.seq)
      if (!value || value.workspaceId !== input.workspaceId || value.updateHash !== input.updateHash) return null
      return value
    },
  }
  const hub = fanoutHub()
  const fanoutA = hub.endpoint()
  const fanoutB = hub.endpoint()
  const serverA = createServer()
  const serverB = createServer()
  const errors = []
  const realtimeA = attachArtifactRealtimeServer(serverA, {
    repository,
    fanout: fanoutA,
    onFanoutError: (error) => errors.push(error),
  })
  const realtimeB = attachArtifactRealtimeServer(serverB, {
    repository,
    fanout: fanoutB,
    onFanoutError: (error) => errors.push(error),
  })
  serverA.listen(0, '127.0.0.1')
  serverB.listen(0, '127.0.0.1')
  await Promise.all([once(serverA, 'listening'), once(serverB, 'listening')])
  const addressA = serverA.address()
  const addressB = serverB.address()
  assert.ok(addressA && typeof addressA !== 'string')
  assert.ok(addressB && typeof addressB !== 'string')
  const roomPath = '/api/v1/workspaces/ws_realtime/artifacts/artifact_realtime/collaboration'
  const alice = await openClient('ws://127.0.0.1:' + addressA.port + roomPath, 'user_alice', 'session_alice')
  const carol = await openClient('ws://127.0.0.1:' + addressA.port + roomPath, 'user_carol', 'session_carol')
  const bob = await openClient('ws://127.0.0.1:' + addressB.port + roomPath, 'user_bob', 'session_bob')
  const foreign = await openClient(
    'ws://127.0.0.1:' + addressB.port +
      '/api/v1/workspaces/ws_other/artifacts/artifact_realtime/collaboration',
    'user_foreign',
    'session_foreign',
  )

  try {
    alice.socket.send(JSON.stringify({
      type: 'update',
      update: Buffer.from([1, 2, 3]).toString('base64url'),
      clientUpdateId: 'cross_instance_1',
    }))
    const acknowledgement = await alice.inbox.next((message) => message.type === 'update.ack')
    const local = await carol.inbox.next((message) => message.type === 'update')
    assert.equal(local.seq, acknowledgement.seq)

    const notification = {
      schemaVersion: 1,
      type: 'artifact.update_committed',
      workspaceId: 'ws_realtime',
      artifactId: 'artifact_realtime',
      seq: acknowledgement.seq,
      updateHash: acknowledgement.updateHash,
    }
    hub.publish(notification)
    const remote = await bob.inbox.next((message) => message.type === 'update')
    assert.equal(remote.updateHash, acknowledgement.updateHash)
    assert.equal(remote.origin.actorId, 'user_alice')

    hub.publish(notification)
    await expectNoMessage(carol.inbox, (message) => message.type === 'update')
    await expectNoMessage(bob.inbox, (message) => message.type === 'update')
    await expectNoMessage(foreign.inbox, (message) => message.type === 'update')
    assert.equal(reads.length, 1)

    hub.publish({ ...notification, updateHash: '0'.repeat(64) })
    await expectNoMessage(bob.inbox, (message) => message.type === 'update')
    assert.equal(reads.length, 3)

    nextSeq += 1n
    const recoveredBytes = Uint8Array.from([4, 5, 6])
    const recoveredHash = createHash('sha256').update(recoveredBytes).digest('hex')
    persisted.set('artifact_realtime:' + nextSeq, {
      workspaceId: 'ws_realtime',
      artifactId: 'artifact_realtime',
      update: recoveredBytes,
      origin: { kind: 'service', serviceId: 'recovery-test', operation: 'persist_only' },
      seq: nextSeq,
      updateHash: recoveredHash,
    })
    fanoutB.recover()
    const recovered = await bob.inbox.next(
      (message) => message.type === 'sync' && message.reason === 'fanout_recovered',
    )
    assert.equal(recovered.throughUpdateSeq, nextSeq.toString())
    fanoutB.deliver({
      ...notification,
      seq: nextSeq.toString(),
      updateHash: recoveredHash,
    })
    await expectNoMessage(bob.inbox, (message) => message.type === 'update')
    await expectNoMessage(
      carol.inbox,
      (message) => message.type === 'sync' && message.reason === 'fanout_recovered',
    )
    assert.deepEqual(errors, [])
  } finally {
    for (const client of [alice, carol, bob, foreign]) client.socket.close()
    await Promise.all([realtimeA.close(), realtimeB.close()])
    serverA.close()
    serverB.close()
    await Promise.all([once(serverA, 'close'), once(serverB, 'close')])
  }
})

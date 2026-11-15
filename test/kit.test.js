// The one-call helpers: presence() and room().
import test from 'node:test'
import assert from 'node:assert/strict'
import { anchors, until } from './helpers.js'
import { presence, room } from '../src/index.js'

let nodes, o
test.before(async () => { nodes = await anchors(3); o = { anchors: nodes.map(n => n.line()), allowPrivate: true, fallback: [] } })
test.after(async () => { for (const n of nodes) await n.close().catch(() => {}) })

test('presence: live count, leaving drops it; helpers link up, help: false stays alone', async () => {
  let a = 0, b = 0
  const A = await presence(n => { a = n }, { topic: 'kit-page', ...o })
  const B = await presence(n => { b = n }, { topic: 'kit-page', ...o })
  const C = await presence(() => {}, { topic: 'kit-page', help: false, ...o })
  await until(() => a === 3 && b === 3, 10000)
  assert.deepEqual(A.peers.sort(), [B.peer.address, C.peer.address].sort())
  await until(() => A.peer.conns.has(B.peer.address), 30000)                  // helpers join the mesh by themselves
  assert.equal(C.peer.conns.size, 0, 'help: false opens no connection')
  assert.ok(!A.peer.conns.has(C.peer.address))
  await C.leave()
  await B.leave()
  await until(() => a === 1, 10000)
  await A.leave()
})

test('room: everyone gets everyone else\'s messages', async () => {
  const got = []
  const A = await room('kit-chat', (body, from) => got.push([from, body.text]), o)
  const B = await room('kit-chat', () => {}, o)
  await until(() => B.peer.topics.links.size > 0, 20000)
  await B.send({ text: 'hello' })
  await until(() => got.length, 10000)
  assert.deepEqual(got, [[B.peer.address, 'hello']])
  await A.leave(); await B.leave()
})

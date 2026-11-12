import test from 'node:test'
import assert from 'node:assert/strict'
import { node, until } from './helpers.js'
import { Peer } from '../src/peer.js'
import { onControl } from '../src/relay.js'
import { random, b64 } from '../src/bytes.js'

test('direct blocked → connect through a third peer (an anchor), end-to-end encrypted', async t => {
  const c = await node({ anchor: 'force' })
  const A = await Peer.create({ anchors: [c.line()], allowPrivate: true, relayFor: false })
  const B = await Peer.create({ anchors: [c.line()], allowPrivate: true, relayFor: false })
  t.after(async () => { A.close(); B.close(); await c.close() })
  await A.publish(); await B.publish()
  A.blockDirect.add(B.address); B.blockDirect.add(A.address)

  await assert.rejects(A.connect(B.address, { relay: 'never', timeout: 3000 }), e => e.code === 'ice-failed')

  const incoming = new Promise(resolve => B.accept(resolve))
  const { channel, kind, via } = await A.connect(B.address, { timeout: 5000 })
  assert.equal(kind, 'peer'); assert.equal(via, c.key)
  const { channel: bch, kind: bkind } = await incoming
  assert.equal(bkind, 'peer')

  // watch what the relay sees: it forwards opaque frames only
  const seen = []
  const [bridge] = c.peer.bridges.values()
  const orig = bridge.a.ctl.send.bind(bridge.a.ctl)
  bridge.a.ctl.send = d => { seen.push(Buffer.from(d)); return orig(d) }

  const got = []
  bch.onmessage = e => { got.push(e.data); bch.send('pong:' + e.data) }
  const back = []
  channel.onmessage = e => back.push(e.data)
  channel.send('secret ping')
  channel.send(new Uint8Array([1, 2, 3]))
  await until(() => back.length === 2)
  assert.equal(got[0], 'secret ping')
  assert.deepEqual([...new Uint8Array(got[1])], [1, 2, 3])
  assert.equal(back[0], 'pong:secret ping')
  assert.ok(seen.length && seen.every(f => !f.toString('latin1').includes('secret')), 'relay saw only ciphertext')
  assert.equal(c.peer.channels.size, 0, 'relay holds no channel keys')
})

const fakeConn = address => ({ address, out: [], ctl: { send (d) { this.parent.out.push(typeof d === 'string' ? JSON.parse(d) : d) } } })
const fake = address => { const c = fakeConn(address); c.ctl.parent = c; return c }

test('bridge pairing rules and limits', () => {
  const peer = { relayFor: true, bridges: new Map(), channels: new Map(), limits: { sessions: 1, kbps: 1 } }
  const A = fake('a'.repeat(52)), B = fake('b'.repeat(52)), X = fake('x'.repeat(52))
  const sid = b64(random(9))
  onControl(peer, A, JSON.stringify({ cx: 'bridge', sid, to: B.address }))
  onControl(peer, X, JSON.stringify({ cx: 'bridge', sid, to: A.address }))       // X pretends to be B
  assert.equal(peer.bridges.get(sid).b, undefined, 'forged bridge ignored')
  onControl(peer, B, JSON.stringify({ cx: 'bridge', sid, to: A.address }))
  assert.equal(peer.bridges.get(sid).b, B)
  assert.deepEqual(A.out.at(-1), { cx: 'bridged', sid })
  const sid2 = b64(random(9))
  onControl(peer, X, JSON.stringify({ cx: 'bridge', sid: sid2, to: A.address }))
  onControl(peer, A, JSON.stringify({ cx: 'bridge', sid: sid2, to: X.address }))
  assert.deepEqual(A.out.at(-1), { cx: 'bridge-no', sid: sid2 }, 'session limit enforced')
  // rate: 1 kbit/s → more than ~250 bytes in a second ends the bridge
  const frame = new Uint8Array(200); frame.set(Buffer.from(sid, 'base64url'))
  onControl(peer, A, frame); onControl(peer, A, frame)
  assert.equal(peer.bridges.get(sid), undefined, 'rate limit ends the bridge')
  assert.deepEqual(B.out.at(-1), { cx: 'unbridge', sid })
  clearInterval(peer.bridges.get(sid)?.idle)
})

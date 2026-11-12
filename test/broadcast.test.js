import test from 'node:test'
import assert from 'node:assert/strict'
import { Peer } from '../src/peer.js'
import { makeRecord, makeFrame, encodeFrame, topicId } from '../src/topic.js'
import { identity } from '../src/crypto.js'
import { decode } from '../src/bencode.js'
import { utf8, z32, hex } from '../src/bytes.js'
import { anchors, until } from './helpers.js'

// ---- unit: one real Peer, fake neighbour links ----------------------------------------------------
async function harness () {
  const me = await Peer.create({ anchors: [], fallback: [], RTCPeerConnection: null })
  const t = await me.topic('chess')
  const got = []
  t.subscribe({ message: m => got.push(m) })
  const links = []
  const link = () => {
    const out = [], ch = { send: d => out.push(new Uint8Array(d)), close () {} }
    const address = z32(crypto.getRandomValues(new Uint8Array(32)))
    me.topics.attach(address, t.hex, ch, 'test')
    const l = { address, ch, out, inject: bytes => ch.onmessage({ data: bytes }) }
    links.push(l)
    return l
  }
  const sender = async () => {
    const id = await identity()
    const rec = await makeRecord(id, t.id, 1, Date.now() + 600e3)
    return { id, rec, frame: async (body = utf8('"hi"'), o = {}) => encodeFrame({ ...await makeFrame(id, t.id, body, rec), ...o }) }
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 30))
  return { me, t, got, link, links, sender, settle }
}

test('deliver once, forward to ≤ 3 others with hop − 1, never back; duplicates and loops suppressed', async t => {
  const h = await harness(); t.after(() => h.me.close())
  const ls = [h.link(), h.link(), h.link(), h.link()]
  const s = await h.sender(), wire = await s.frame()
  ls[0].inject(wire); await h.settle()
  assert.equal(h.got.length, 1); assert.deepEqual(h.got[0].body, 'hi'); assert.equal(h.got[0].from, z32(s.id.pub))
  assert.equal(ls[0].out.length, 0, 'not sent back on the incoming link')
  const forwarded = ls.slice(1).flatMap(l => l.out)
  assert.equal(forwarded.length, 3)
  assert.ok(forwarded.every(f => decode(f).hop === 3))
  for (const l of ls) l.inject(wire)                                             // the same message comes back around
  await h.settle()
  assert.equal(h.got.length, 1, 'delivered exactly once')
  assert.equal(h.me.topics.stats.dropped.duplicate, 4)
  assert.equal(ls.slice(1).flatMap(l => l.out).length, 3, 'loops are not forwarded again')
})

test('fan-out capped at 3 even with more links; hop 1 is delivered but not forwarded', async t => {
  const h = await harness(); t.after(() => h.me.close())
  const ls = Array.from({ length: 4 }, h.link)
  h.me.topics.L.neighbours = 8; ls.push(h.link(), h.link())                   // pretend more neighbours exist
  const s = await h.sender()
  ls[0].inject(await s.frame()); await h.settle()
  assert.equal(ls.flatMap(l => l.out).length, 3)
  ls[0].inject(await s.frame(utf8('"last hop"'), { hop: 1 })); await h.settle()
  assert.equal(h.got.length, 2); assert.equal(ls.flatMap(l => l.out).length, 3, 'hop 1 not forwarded')
})

test('rejects forged, oversized, old, ineligible, wrong-topic and own frames; rate limit per sender', async t => {
  const h = await harness(); t.after(() => h.me.close())
  const [l] = [h.link()]
  const s = await h.sender(), other = await identity()
  const f = decode(await s.frame())
  l.inject(encodeFrame({ ...f, body: utf8('"tampered"') }))
  l.inject(await s.frame(new Uint8Array(1025)))
  const old = decode(await s.frame()); old.ts -= 121e3; l.inject(encodeFrame(old))
  l.inject(encodeFrame(await makeFrame(other, h.t.id, utf8('1'), s.rec)))       // someone else's record
  const go = await topicId('go')
  l.inject(encodeFrame(await makeFrame(s.id, go, utf8('1'), await makeRecord(s.id, go, 1, Date.now() + 600e3))))
  const mine = await makeRecord(h.me.id, h.t.id, 1, Date.now() + 600e3)
  l.inject(encodeFrame(await makeFrame(h.me.id, h.t.id, utf8('1'), mine)))
  await h.settle()
  assert.equal(h.got.length, 0)
  assert.deepEqual(h.me.topics.stats.dropped, { signature: 1, size: 1, age: 1, eligibility: 1, topic: 1, own: 1 })
  for (let i = 0; i < 12; i++) l.inject(await s.frame(utf8(String(i))))
  await h.settle()
  assert.equal(h.got.length, 10, '10 per sender per topic per minute')
  assert.equal(h.me.topics.stats.dropped.rate, 2)
})

test('broadcast(): requires publish, size limit, own rate limit; neighbour limits', async t => {
  const h = await harness(); t.after(() => h.me.close())
  await assert.rejects(h.t.broadcast('x'), e => e.code === 'not-published')
  h.t.published = true; h.t.record = await makeRecord(h.me.id, h.t.id, 1, Date.now() + 600e3)
  await assert.rejects(h.t.broadcast('x'.repeat(1100)), e => e.code === 'too-large')
  const l = h.link()
  for (let i = 0; i < 10; i++) await h.t.broadcast(i)
  await assert.rejects(h.t.broadcast(11), e => e.code === 'rate-limited')
  assert.equal(l.out.length, 10); assert.ok(l.out.every(f => decode(f).hop === 4))
  h.t.published = false
  // neighbour limits: 4 per topic (1 used by l), 16 in total
  const accepted = [1, 2, 3, 4].map(() => h.me.topics.accept(z32(crypto.getRandomValues(new Uint8Array(32))), h.t.hex))
  assert.deepEqual(accepted, [true, true, true, false])
  assert.equal(h.me.topics.accept('x'.repeat(52), hex(await topicId('unsubscribed'))), false)
})

test('simultaneous link attempts: the lower address wins, the other gets busy', async t => {
  const h = await harness(); t.after(() => h.me.close())
  const self = h.me.address
  const lower = '1'.repeat(52) < self ? '1'.repeat(52) : null, higher = 'z'.repeat(52)
  for (const other of [lower, higher].filter(Boolean)) {
    h.me.topics.reserved.set(`${h.t.hex}|${other}`, { until: Date.now() + 40e3, out: true })   // we are dialling them
    assert.equal(h.me.topics.accept(other, h.t.hex), other < self, `${other < self ? 'lower' : 'higher'} address`)
  }
})

// ---- integration: a real WebRTC mesh of 5 Node peers ------------------------------------------------
test('5-peer mesh over WebRTC: every member receives a broadcast exactly once', async t => {
  const nodes = await anchors(5)
  const lines = nodes.map(n => n.line())
  const peers = await Promise.all(Array.from({ length: 5 }, () => Peer.create({ anchors: lines, allowPrivate: true, topicLimits: { lease: 4000, renew: 2000 } })))
  t.after(async () => { for (const p of peers) await p.close(); for (const n of nodes) await n.close() })
  await Promise.all(peers.map(p => p.publish()))
  const inbox = new Map(peers.map(p => [p.address, []]))
  const topics = await Promise.all(peers.map(p => p.topic('mesh')))
  topics.forEach((tp, i) => tp.subscribe({ message: m => inbox.get(peers[i].address).push(m) }))
  await Promise.all(topics.map(tp => tp.publish()))
  // wait until the neighbour graph connects everyone
  const connected = () => {
    const adj = new Map(peers.map(p => [p.address, new Set([...p.topics.links.values()].map(l => l.address))]))
    const seen = new Set([peers[0].address]), stack = [peers[0].address]
    while (stack.length) for (const n of adj.get(stack.pop()) || []) if (!seen.has(n)) { seen.add(n); stack.push(n) }
    return seen.size === peers.length
  }
  await until(connected, 40000, 200)
  for (const p of peers) assert.ok(p.topics.links.size <= 4)
  const { sent } = await topics[0].broadcast({ move: 'e4' })
  assert.ok(sent >= 1)
  await until(() => peers.slice(1).every(p => inbox.get(p.address).length >= 1), 10000)
  await new Promise(resolve => setTimeout(resolve, 500))
  for (const p of peers.slice(1)) assert.deepEqual(inbox.get(p.address).map(m => m.body), [{ move: 'e4' }], 'exactly once')
  assert.equal(inbox.get(peers[0].address).length, 0, 'the sender does not receive its own message')
})

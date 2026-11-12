// Topic presence against 6 real storage peers (anchors), with Node peers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { anchors, until } from './helpers.js'
import { Peer } from '../src/peer.js'
import { topicId, readRecord } from '../src/topic.js'
import { hex, xor, compare, unz32 } from '../src/bytes.js'

const fast = { lease: 3000, renew: 1500, jitter: 0.2 }
let nodes, lines
const peers = []
const peer = async (o = {}) => { const p = await Peer.create({ anchors: lines, allowPrivate: true, topicLimits: fast, ...o }); peers.push(p); return p }
const holders = async name => { const t = hex(await topicId(name)); return nodes.filter(n => n.store.topics.get(t)?.size) }
const live = async (name, address) => {
  const t = hex(await topicId(name))
  return nodes.filter(n => { const e = [...(n.store.topics.get(t)?.values() || [])].find(x => x.exp > Date.now()); return e }).length
}

test.before(async () => { nodes = await anchors(6); lines = nodes.map(n => n.line()) })
test.after(async () => { for (const p of peers) await p.close(); for (const n of nodes) await n.close().catch(() => {}) })

test('publish: 4 XOR-closest + 1 random storage peer (none established yet); search finds the provider', async () => {
  const a = await peer(), b = await peer()
  const t = await a.topic('Chess')
  const { stored } = await t.publish()
  assert.equal(stored, 5)
  const id = await topicId('chess')
  const closest = [...nodes].sort((x, y) => compare(xor(unz32(x.key), id), xor(unz32(y.key), id))).slice(0, 4).map(n => n.key)
  const held = (await holders('chess')).map(n => n.key)
  assert.equal(held.length, 5)
  assert.ok(closest.every(k => held.includes(k)), 'the 4 closest hold it, plus one random other')
  const found = await (await b.topic('  CHESS ')).search()
  assert.deepEqual(found.map(f => [f.address, f.presence]), [[a.address, 'recent']])
  assert.ok(found[0].expires > Date.now())
})

test('watch: recent on publish, expired on unpublish; renewal keeps a provider recent', async () => {
  // lease ≫ renewal + 2 s coalescing, as in production (10 min vs 5 min); a 3 s lease would flap by design
  const slow = { topicLimits: { lease: 8000, renew: 2000, jitter: 0.2 } }
  const a = await peer(slow), w = await peer(slow)
  const events = []
  ;(await w.topic('go')).subscribe({ presence: e => events.push([e.address, e.presence]) })
  const t = await a.topic('go')
  await t.publish()
  await until(() => events.some(([x, p]) => x === a.address && p === 'recent'), 10000)
  await new Promise(resolve => setTimeout(resolve, 9000))                      // longer than one lease (8 s)
  assert.ok(!events.some(([, p]) => p === 'expired'), 'renewals kept it recent')
  assert.equal((await (await w.topic('go')).search()).length, 1)
  await t.unpublish()
  await until(() => events.some(([x, p]) => x === a.address && p === 'expired'), 10000)
  assert.equal((await (await w.topic('go')).search()).length, 0)
})

test('offline provider (no renewals, no tombstone) expires', async () => {
  const a = await peer(), w = await peer()
  const events = []
  ;(await w.topic('poker')).subscribe({ presence: e => events.push(e.presence) })
  await (await a.topic('poker')).publish()
  await until(() => events.includes('recent'), 10000)
  clearTimeout(a.topics.renewTimer); a.topics.closed = true; a.abort.abort()  // vanish without a word
  await until(() => events.includes('expired'), 12000)
  assert.equal((await (await w.topic('poker')).search()).length, 0)
})

test('a failed storage peer is replaced on renewal; search still works meanwhile', async () => {
  const a = await peer(), b = await peer()
  await (await a.topic('backgammon')).publish()
  const before = await holders('backgammon')
  assert.equal(before.length, 5)
  const victim = before[0]
  await victim.close()
  nodes = nodes.filter(n => n !== victim)
  assert.equal((await (await b.topic('backgammon')).search()).length, 1, 'found on the remaining replicas')
  await until(async () => (await live('backgammon')) === 5, 10000)              // renewal moved a copy to the 6th node
})

test('clock skew: a provider 5 minutes ahead corrects itself from the storage clock', async () => {
  const ahead = await peer({ now: () => Date.now() + 5 * 60e3, topicLimits: { lease: 600e3 } })   // real lease: 5 min ahead is rejected at first
  const b = await peer()
  const { stored } = await (await ahead.topic('skewed')).publish()
  assert.ok(stored >= 4, `stored on ${stored}`)
  assert.ok(Math.abs(ahead.topics.skew() + 5 * 60e3) < 5000, 'skew estimate ≈ −5 min')
  assert.equal((await (await b.topic('skewed')).search())[0]?.presence, 'recent')
})

test('one long poll per storage peer for many topics; lost cursor → snapshot resync; close cleans up', async () => {
  const w = await peer(), a = await peer()
  const seen = []
  for (const name of ['t1', 't2', 't3', 't4']) (await w.topic(name)).subscribe({ presence: e => seen.push([name, e.presence]) })
  await until(() => w.topics.polls.size > 0, 5000)
  const plan = new Set()
  for (const name of ['t1', 't2', 't3', 't4']) for (const e of w.topics.pick(await topicId(name), 4)) plan.add(e.key)
  await until(() => w.topics.polls.size === plan.size, 5000)
  for (const [key, p] of w.topics.polls) assert.ok(plan.has(key) && p.topics.size >= 1)
  const mine = new Set(await Promise.all(['t1', 't2', 't3', 't4'].map(async n => hex(await topicId(n)))))
  for (const n of nodes) {
    const polls = [...n.store.waiters].filter(x => [...x.want].some(h => mine.has(h))).length
    assert.ok(polls <= 1, `node holds ${polls} polls from one watcher`)
  }

  for (const n of nodes) { n.store.epoch = 'reset'; n.store.close() }          // every cursor is now invalid
  await (await a.topic('t3')).publish()
  await until(() => seen.some(([n, p]) => n === 't3' && p === 'recent'), 10000)

  await w.close()
  assert.equal(w.topics.polls.size, 0); assert.equal(w.topics.links.size, 0)
  assert.equal(w.topics.renewTimer ?? null, null); assert.equal(w.topics.expiry, null)
})

test('placement prefers established storage peers; a fresh key closer to the topic cannot take a closest slot', async () => {
  const { z32: enc } = await import('../src/bytes.js')
  const p = await Peer.create({ anchors: [], fallback: [], allowPrivate: true, RTCPeerConnection: null })
  peers.push(p)
  const id = await topicId('eclipse')
  const near = k => { const b = new Uint8Array(id); b[31] ^= k; return enc(b) }       // keys XOR-close to the topic id
  const far = () => enc(crypto.getRandomValues(new Uint8Array(32)))
  const add = (key, ageDays) => {
    p.addAnchors(`corvax-anchor:${key}@10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}:4799`)
    p.book.record(key, 'id', true); p.book.record(key, 'http', true); p.book.get(key).storage = true
    p.book.get(key).first = Date.now() - ageDays * 86400e3
  }
  const established = Array.from({ length: 6 }, far), sybils = [near(1), near(2), near(3)]
  for (const k of established) add(k, 10)
  for (const k of sybils) add(k, 0)                                                   // brand new, but closest of all
  const placed = p.topics.pick(id, 4, 1).map(e => e.key)
  assert.equal(placed.length, 5)
  assert.ok(placed.slice(0, 4).every(k => established.includes(k)), 'closest slots go to established peers')
  assert.ok(!placed.slice(0, 4).some(k => sybils.includes(k)))
  const randoms = new Set()
  for (let i = 0; i < 40; i++) randoms.add(p.topics.pick(id, 4, 1)[4].key)
  assert.ok(randoms.size > 1, 'the fifth copy goes to a random other peer')
  // a young network: fewer than 4 established → the closest of the rest fill in
  const q = await Peer.create({ anchors: [], fallback: [], allowPrivate: true, RTCPeerConnection: null })
  peers.push(q)
  for (const k of sybils) { q.addAnchors(`corvax-anchor:${k}@10.1.1.1:4799`); q.book.record(k, 'id', true); q.book.record(k, 'http', true); q.book.get(k).storage = true }
  assert.equal(q.topics.pick(id, 4, 1).length, 3)
})

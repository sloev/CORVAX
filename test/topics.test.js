// Topic presence against 6 real storage nodes (anchors), with Node peers.
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

test('publish replicates to exactly the 5 XOR-closest storage nodes; search finds the provider', async () => {
  const a = await peer(), b = await peer()
  const t = await a.topic('Chess')
  const { stored } = await t.publish()
  assert.equal(stored, 5)
  const id = await topicId('chess')
  const closest = [...nodes].sort((x, y) => compare(xor(unz32(x.key), id), xor(unz32(y.key), id))).slice(0, 5).map(n => n.key).sort()
  assert.deepEqual((await holders('chess')).map(n => n.key).sort(), closest)
  const found = await (await b.topic('  CHESS ')).search()
  assert.deepEqual(found.map(f => [f.address, f.presence]), [[a.address, 'recent']])
  assert.ok(found[0].expires > Date.now())
})

test('watch: recent on publish, expired on unpublish; renewal keeps a provider recent', async () => {
  const a = await peer(), w = await peer()
  const events = []
  ;(await w.topic('go')).subscribe({ presence: e => events.push([e.address, e.presence]) })
  const t = await a.topic('go')
  await t.publish()
  await until(() => events.some(([x, p]) => x === a.address && p === 'recent'), 10000)
  await new Promise(resolve => setTimeout(resolve, 4500))                      // longer than one lease (3 s)
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

test('a failed storage node is replaced on renewal; search still works meanwhile', async () => {
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

test('one long poll per storage node for many topics; lost cursor → snapshot resync; close cleans up', async () => {
  const w = await peer(), a = await peer()
  const seen = []
  for (const name of ['t1', 't2', 't3', 't4']) (await w.topic(name)).subscribe({ presence: e => seen.push([name, e.presence]) })
  await until(() => w.topics.polls.size > 0, 5000)
  const plan = new Set()
  for (const name of ['t1', 't2', 't3', 't4']) for (const e of w.topics.nodes(await topicId(name), 5)) plan.add(e.key)
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

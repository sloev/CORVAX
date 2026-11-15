// No anchors anywhere: peers linked by hand are each other's inbox, Beacon store and topic storage (SPEC §13).
import test from 'node:test'
import assert from 'node:assert/strict'
import { until, node } from './helpers.js'
import { Peer } from '../src/index.js'
import { utf8 } from '../src/bytes.js'
import { sign } from '../src/crypto.js'
import { encode, decode } from '../src/bencode.js'

const alone = () => Peer.create({ fallback: [], local: false, platform: { loadCache: () => '', saveCache () {} } })
async function link (a, b) {
  const invite = await a.link(), reply = await b.link(invite.code)
  const [x] = await Promise.all([invite.accept(reply.code), reply.connected])
  return x
}

test('by hand: two codes make a connection; then messages, Beacons and topics need no anchor', async t => {
  const [a, b] = [await alone(), await alone()]
  t.after(async () => { await a.close(); await b.close() })
  assert.equal(a.inboxes.length, 0)
  const got = []
  b.on(m => got.push([m.from, m.body]))
  const { address, channel } = await link(a, b)
  assert.equal(address, b.address)
  assert.equal(channel.readyState, 'open')
  await until(() => a.held.has(b.address) && b.held.has(a.address), 5000)       // Beacons swapped on connect
  await a.send(b.address, { hi: 'no anchors' })
  await until(() => got.length, 5000)
  assert.deepEqual(got, [[a.address, { hi: 'no anchors' }]])
  await a.publish({ n: 'A' })                                                   // the neighbour keeps it
  assert.equal((await b.resolve(a.address, { fresh: true })).fields.n[0], 'A')
  const tb = await b.topic('offline'), ta = await a.topic('offline')
  assert.equal((await ta.publish()).stored, 1, 'the connected peer stores the record')
  assert.deepEqual((await tb.search()).map(p => p.address), [a.address])
  await assert.rejects(a.link('cx1AAAA'), e => e.code === 'bad-code')
})

test('through a mutual peer: A and B, both linked only to C, find each other by topic and connect', async t => {
  const [a, b, c] = [await alone(), await alone(), await alone()]
  t.after(async () => { await a.close(); await b.close(); await c.close() })
  await link(a, c); await link(b, c)
  b.accept(({ channel }) => { channel.onmessage = e => channel.send('echo ' + e.data) })
  await (await a.topic('friends')).publish()
  await (await b.topic('friends')).publish()
  const found = await (await a.topic('friends')).search()                       // C answers from its store
  assert.deepEqual(found.map(p => p.address), [b.address])
  const { channel, kind } = await a.connect(b.address)                          // resolve and signalling pass through C
  assert.equal(kind, 'direct')
  const reply = new Promise(resolve => { channel.onmessage = e => resolve(String(e.data)) })
  channel.send('hi')
  assert.equal(await reply, 'echo hi')
  await c.close()                                                               // the introducer leaves: A and B carry on
  const got = new Promise(resolve => b.on(m => resolve(m.body)))
  await a.send(b.address, 'still connected')
  assert.equal(await got, 'still connected')
})

test('any medium: a card and an envelope as text', async t => {
  const [a, b] = [await alone(), await alone()]
  t.after(async () => { await a.close(); await b.close() })
  assert.equal(await a.learn(await b.card()), b.address)
  const got = new Promise(resolve => b.on(m => resolve([m.from, m.body])))
  await b.receive(await a.envelope(b.address, { on: 'paper' }))
  assert.deepEqual(await got, [a.address, { on: 'paper' }])
  await assert.rejects(a.learn('cxb' + 'A'.repeat(200)), e => e.code === 'bad-code')
})

test('inbox polls are bound to their anchor and their ack; a dead inbox is replaced', async t => {
  const n1 = await node({ anchor: 'force' }), n2 = await node({ anchor: 'force' })
  const p = await Peer.create({ anchors: [n1.line(), n2.line()], allowPrivate: true, fallback: [], local: false })
  t.after(async () => { await p.close(); await n2.close(); await n1.close().catch(() => {}) })
  const poll = async (n, signedFor, after, sentAfter = after) => {
    const ts = Date.now(), sig = await sign(p.id, utf8(`cx-listen:${ts}:${after}:${signedFor}`))
    const r = await fetch(`http://127.0.0.1:${n.port}/krpc`, { method: 'POST', body: encode({ t: crypto.getRandomValues(new Uint8Array(4)), y: 'q', q: 'cx_listen', a: { k: p.id.pub, ts, sig, after: sentAfter, v: 2 } }) })
    return decode(new Uint8Array(await r.arrayBuffer()))
  }
  assert.equal((await poll(n2, n1.key, 1e15)).e?.[0], 206, 'a poll signed for another anchor is refused')
  assert.equal((await poll(n1, n1.key, 0, 1e15)).e?.[0], 206, 'a forged ack is refused')

  await p.publish()
  assert.equal(p.inboxes.length, 2)
  const dead = p.inboxes[0].entry.key === n1.key ? n1 : n2, live = dead === n1 ? n2 : n1
  await dead.close()
  await until(() => p.inboxes.length === 1 && p.inboxes[0].entry.key === live.key, 30000)
  const q = await Peer.create({ anchors: [live.line()], allowPrivate: true, fallback: [], local: false })
  t.after(() => q.close())
  const got = new Promise(resolve => p.on(m => resolve(m.body)))
  await until(async () => (await q.resolve(p.address, { fresh: true }))?.c.length === 1, 10000)   // the new Beacon names only the live inbox
  await q.send(p.address, 'moved')
  assert.equal(await got, 'moved')
})

let playwright
try { playwright = (await import('node:module')).createRequire(import.meta.url)('playwright') } catch {}

test('browsers by hand: two tabs with no anchor in reach link with two codes and talk', { skip: !playwright && 'playwright not installed' }, async t => {
  const a = await node({ anchor: 'force' }), browser = await playwright.chromium.launch()
  t.after(async () => { await browser.close(); await a.close().catch(() => {}) })
  const page = async () => {
    const p = await (await browser.newContext()).newPage()
    await p.goto(`http://127.0.0.1:${a.port}/`)
    await p.evaluate(async () => { window.lib = await import('/cx/index.js') })
    return p
  }
  const [A, B] = [await page(), await page()]
  await a.close()                                                               // the only anchor is gone before any peer exists
  for (const p of [A, B]) await p.evaluate(async () => {
    window.me = await window.lib.Peer.create({ fallback: [], platform: { loadCache: () => '', saveCache () {} } })
    window.got = []
    window.me.on(m => window.got.push(m.body))
  })
  assert.equal(await A.evaluate(() => window.me.inboxes.length), 0)
  const invite = await A.evaluate(async () => { window.invite = await window.me.link(); return window.invite.code })
  const reply = await B.evaluate(async code => { window.reply = await window.me.link(code); return window.reply.code }, invite)
  const to = await A.evaluate(async code => (await window.invite.accept(code)).address, reply)
  assert.equal(to, await B.evaluate(() => window.me.address))
  await until(() => A.evaluate(to => window.me.held.has(to), to), 5000, 100)
  await A.evaluate(to => window.me.send(to, 'by hand'), to)
  await until(() => B.evaluate(() => window.got.length), 5000, 100)
  assert.deepEqual(await B.evaluate(() => window.got), ['by hand'])
  console.log(`# link codes: ${invite.length} and ${reply.length} characters`)
})

test('backbone: peers that share a mutual peer link up by themselves (peer exchange) and survive its leaving', async t => {
  const [a, b, c] = [await alone(), await alone(), await alone()]
  t.after(async () => { await a.close(); await b.close(); await c.close() })
  await link(a, c); await link(b, c)                                            // nobody ever asks A and B to connect
  await until(() => a.conns.has(b.address) && b.conns.has(a.address), 30000)
  await c.close()
  const got = new Promise(resolve => b.on(m => resolve(m.body)))
  await a.send(b.address, 'healed')
  assert.equal(await got, 'healed')
})

test('memory: a restarted peer remembers anchors and peers, and re-links to a peer it knew', async t => {
  const n = await node({ anchor: 'force' })
  const disk = {}, platform = { loadCache: () => disk.anchors || '', saveCache: x => { disk.anchors = x }, loadPeers: () => disk.peers || '', savePeers: x => { disk.peers = x } }
  const o = { allowPrivate: true, fallback: [], local: false }
  const b = await Peer.create({ ...o, anchors: [n.line()] })
  let a = await Peer.create({ ...o, anchors: [n.line()], platform })
  t.after(async () => { await a.close(); await b.close(); await n.close() })
  await a.publish(); await b.publish()
  b.accept(() => {})
  await a.connect(b.address)
  const seed = a.seed
  await a.close()
  assert.ok(disk.anchors.includes(n.key), 'anchor remembered')
  assert.ok(disk.peers.startsWith('cxb'), 'peer remembered')
  a = await Peer.create({ ...o, seed, platform })                               // no anchors given: all from memory
  assert.equal(a.inboxes.length, 1)
  await until(() => a.conns.has(b.address), 30000)                              // the backbone re-links without being asked
})

test('anchor lists sync by filter: only unknown lines are sent', async () => {
  const { Book, without } = await import('../src/book.js'), { z32, random } = await import('../src/bytes.js')
  const lines = Array.from({ length: 40 }, (_, i) => `corvax-anchor:${z32(random(32))}@8.8.${i}.1:4799`)
  const mine = new Book()
  mine.add(lines.slice(0, 30).join('\n'))
  const news = without(lines.join('\n'), mine.have()).split('\n').filter(Boolean)
  assert.ok(news.length >= 9 && news.length <= 10 && news.every(l => lines.indexOf(l) >= 30), `${news.length} of 40 lines sent`)
  assert.equal(without('x', 'not a filter'), 'x')
})

test('store, carry, forward: a kept message travels with a peer to a recipient the sender never meets', async t => {
  const [a, b, c] = [await alone(), await alone(), await alone()]
  t.after(async () => { await b.close(); await c.close() })
  await a.learn(await b.card())                                                 // A knows B's key (a card), nothing else
  await link(a, c)
  assert.equal(await a.send(b.address, { note: 'see you friday' }, { keep: 86400e3 }), 'kept')
  await until(() => c.carry.size === 1, 5000)                                   // C now carries it (sealed: C can't read it)
  await a.close()                                                               // the sender is gone
  const got = new Promise(resolve => b.on(m => resolve([m.from, m.body])))
  await link(c, b)                                                              // later, C meets B
  assert.deepEqual(await got, [a.address, { note: 'see you friday' }])
  await until(() => c.carry.size === 0, 5000)                                   // delivered: C drops its copy
})

test('outbox: a kept message survives a restart and is delivered when a path appears; the sender hears back', async t => {
  const disk = {}, platform = { loadCache: () => '', saveCache () {}, loadPeers: () => disk.peers || '', savePeers: x => { disk.peers = x }, loadCarry: () => disk.carry || '', saveCarry: x => { disk.carry = x } }
  const o = { fallback: [], local: false, platform }
  let a = await Peer.create(o)
  const b = await alone(), seed = a.seed
  t.after(async () => { await a.close(); await b.close() })
  await a.learn(await b.card())
  assert.equal(await a.send(b.address, 'later', { keep: 3600e3 }), 'kept')
  await a.close()
  assert.ok(disk.carry.length > 100, 'the parcel is on disk')
  a = await Peer.create({ ...o, seed })
  assert.equal(a.carry.size, 1)
  const got = new Promise(resolve => b.on(m => resolve(m.body)))
  await link(a, b)
  assert.equal(await got, 'later')
  await until(() => a.carry.size === 0, 5000)
  await assert.rejects(a.send(b.address, Array.from(crypto.getRandomValues(new Uint8Array(5000)), x => x.toString(16)).join(''), { keep: 1e3 }), e => e.code === 'too-large')
})

test('routing: a message crosses a chain of four peers hop by hop; then they connect directly through it', async t => {
  const quiet = () => Peer.create({ fallback: [], local: false, mesh: 0, platform: { loadCache: () => '', saveCache () {} } })   // no backbone: the chain stays a chain
  const [a, b, c, d] = [await quiet(), await quiet(), await quiet(), await quiet()]
  t.after(async () => { for (const p of [a, b, c, d]) await p.close() })
  await link(a, b); await link(b, c); await link(c, d)
  await a.learn(await d.card()); await d.learn(await a.card())                  // they know each other's key, and share no peer
  const got = new Promise(resolve => d.on(m => resolve([m.from, m.body])))
  await a.send(d.address, 'three hops')
  assert.deepEqual(await got, [a.address, 'three hops'])
  assert.deepEqual([a.routes.get(d.address).h, b.routes.get(d.address).h, a.routes.get(d.address).via], [3, 2, b.address])
  d.accept(({ channel }) => { channel.onmessage = e => channel.send('echo ' + e.data) })
  const { channel, kind } = await a.connect(d.address)                          // offer, answer and candidates all travel the chain
  assert.equal(kind, 'direct')
  const reply = new Promise(resolve => { channel.onmessage = e => resolve(String(e.data)) })
  channel.send('hi')
  assert.equal(await reply, 'echo hi')
  const e = await quiet()
  t.after(() => e.close())
  await a.learn(await e.card())
  await assert.rejects(a.send(e.address, 'nobody knows E'), x => x.code === 'no-anchor')
})

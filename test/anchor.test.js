import test from 'node:test'
import assert from 'node:assert/strict'
import { anchors, node, until } from './helpers.js'
import { Peer } from '../src/peer.js'
import { encode, decode } from '../src/bencode.js'
import { random, utf8, str } from '../src/bytes.js'

const rpc = async (n, q, a, t = random(4)) => decode(new Uint8Array(await (await fetch(`http://127.0.0.1:${n.port}/krpc`, { method: 'POST', body: encode({ t, y: 'q', q, a }) })).arrayBuffer()))

test('anchors promote, peers publish, resolve and message across anchors', async t => {
  const [a1, a2, a3] = await anchors(3)
  const peers = []
  t.after(async () => { peers.forEach(p => p.close()); await Promise.all([a1, a2, a3].map(a => a.close())) })

  assert.ok(a1.isAnchor && a2.isAnchor && a3.isAnchor, 'second and third anchors promoted themselves')
  assert.ok(a2.book.get(a1.key)?.verified)

  const A = await Peer.create({ anchors: [a1.line()], allowPrivate: true, RTCPeerConnection: null })
  const B = await Peer.create({ anchors: [a3.line()], allowPrivate: true, RTCPeerConnection: null })
  peers.push(A, B)
  await A.publish({ n: 'alice' })
  await B.publish()
  const rec = await B.resolve(A.address)
  assert.deepEqual(rec.fields.n, ['alice'])

  const got = []
  A.on(m => got.push(m))
  await B.send(A.address, { hi: 1 })
  await B.send(A.address, 'two')
  await until(() => got.length === 2)
  assert.equal(got[0].from, B.address)
  assert.deepEqual(got.map(m => m.body), [{ hi: 1 }, 'two'])
})

test('HTTP: retried POST runs once, acks delete, newer poll ends older, rate limit', async t => {
  const a = await node({ anchor: 'force', rate: { burst: 60, perSecond: 1 } })
  t.after(() => a.close())
  const { identity, sign } = await import('../src/crypto.js')
  const me = await identity()
  const listen = async after => { const ts = Date.now(); return rpc(a, 'cx_listen', { k: me.pub, ts, sig: await sign(me, utf8(`cx-listen:${ts}`)), after }) }

  const tid = random(4)
  await rpc(a, 'cx_send', { to: me.pub, msg: random(200) }, tid)
  await rpc(a, 'cx_send', { to: me.pub, msg: random(200) }, tid)            // same transaction id: answered from cache
  await rpc(a, 'cx_send', { to: me.pub, msg: random(150) })
  let r = await listen(0)
  assert.deepEqual(r.r.msgs.map(m => m.seq), [1, 2], 'retried POST stored once')
  r = await listen(1)
  assert.deepEqual(r.r.msgs.map(m => m.seq), [2], 'ack deletes seq 1')

  const older = listen(2), t0 = Date.now()
  await new Promise(resolve => setTimeout(resolve, 200))
  const newer = listen(2)
  assert.deepEqual((await older).r.msgs, [], 'older poll ended empty')
  assert.ok(Date.now() - t0 < 5000, 'older poll ended early')
  await rpc(a, 'cx_send', { to: me.pub, msg: random(100) })
  assert.deepEqual((await newer).r.msgs.map(m => m.seq), [3], 'newer poll gets the next message')

  let limited = false
  for (let i = 0; i < 12 && !limited; i++) limited = (await rpc(a, 'cx_check', { k: random(32) })).e?.[0] === 202
  assert.ok(limited, 'cx_check is rate limited')
})

test('homepage: tiny shell + app.js for browsers, plain anchor list for everything else', async t => {
  const [a1, a2] = await anchors(2)
  t.after(async () => { await a1.close(); await a2.close() })
  const { LINE_RE, parseLine } = await import('../src/book.js')
  a2.book.add(`corvax-anchor:${'y'.repeat(52)}@8.8.8.8:1;web=https://x.example`)
  const base = `http://127.0.0.1:${a2.port}`

  const page = await fetch(base + '/', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.equal(page.headers.get('vary'), 'accept')
  const html = await page.text()
  assert.ok(html.length < 4096, `shell is ${html.length} bytes`)
  const scripts = [...html.matchAll(/<script[^>]*>/g)].map(m => m[0])
  assert.deepEqual(scripts, ['<script type="module" src="/cx/app.js">'], 'exactly one script: the same-origin app')
  assert.ok(!/(src|href)="https?:/i.test(html), 'no external requests')
  assert.ok(html.indexOf('/cx/app.js') < html.indexOf('<pre id="anchors">'), 'anchor list comes after the script tag')
  assert.ok(html.match(LINE_RE).every(l => parseLine(l)), 'everything that greps as an anchor line is valid')

  const app = await fetch(base + '/cx/app.js')
  assert.match(app.headers.get('content-type'), /javascript/)
  const js = await app.text()
  assert.match(js, /const LOGO = 'data:image\/png;base64,iVBOR/, 'logo inlined')
  assert.ok(!/https?:\/\/(?!github\.com)/.test(js.replace(/\$\{node\.origin\}/g, '')), 'app makes no external requests')
  assert.equal((await fetch(base + '/logo')).status, 404, '/logo endpoint removed')
  assert.equal((await fetch(base + '/demo')).status, 404, '/demo endpoint removed (the homepage is the demo)')

  for (const accept of ['*/*', undefined]) {
    const res = await fetch(base + '/', { headers: accept ? { accept } : {} })
    assert.match(res.headers.get('content-type'), /text\/plain/)
    const lines = (await res.text()).trim().split('\n')
    assert.equal(lines[0], a2.line())
    assert.ok(lines.every(l => parseLine(l)), 'plain text is nothing but anchor lines')
    assert.equal(lines.filter(l => l.startsWith(`corvax-anchor:${a2.key}@`)).length, 1, 'own line exactly once')
  }
  const p = await Peer.create({ anchors: [], allowPrivate: true, RTCPeerConnection: null })
  t.after(() => p.close())
  assert.ok(p.addAnchors(html) >= 2, 'the HTML shell is also a valid anchor source')
  const ico = await fetch(base + '/favicon.ico')
  assert.equal(ico.headers.get('content-type'), 'image/x-icon')
})

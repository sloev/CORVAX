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

test('homepage, logo, favicon', async t => {
  const a = await node({ anchor: 'force' })
  t.after(() => a.close())
  const evil = `corvax-anchor:${'y'.repeat(52)}@8.8.8.8:1;web=https://x.example`
  a.book.add(evil)
  const res = await fetch(`http://127.0.0.1:${a.port}/`)
  const html = await res.text()
  assert.ok(html.length < 10240, `homepage is ${html.length} bytes`)
  assert.ok(!/<script/i.test(html) && !/src="https?:/i.test(html) && !/<link[^>]+href="https?:/i.test(html), 'no scripts, no external requests')
  assert.ok(html.includes(a.line()))
  const p = await Peer.create({ anchors: [], allowPrivate: true, RTCPeerConnection: null })
  t.after(() => p.close())
  assert.ok(p.addAnchors(html) >= 1, 'the page is a valid anchor source')
  for (const [path, type] of [['/logo', 'image/png'], ['/favicon.ico', 'image/x-icon']]) {
    const r = await fetch(`http://127.0.0.1:${a.port}${path}`)
    assert.equal(r.headers.get('content-type'), type)
    assert.match(r.headers.get('cache-control'), /max-age=31536000/)
  }
})

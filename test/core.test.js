import test from 'node:test'
import assert from 'node:assert/strict'
import { z32, unz32, random, equal, utf8 } from '../src/bytes.js'
import { encode, decode } from '../src/bencode.js'
import { identity, sign, verify } from '../src/crypto.js'
import { seal, open } from '../src/message.js'
import { makeBeacon, verifyBeacon, fields, pack, unpack } from '../src/record.js'
import { Book, parseLine, formatLine, isPublic } from '../src/book.js'
import { Inboxes } from '../src/inbox.js'

test('z-base32 round trip (52 chars for a key)', () => {
  for (let i = 0; i < 50; i++) {
    const b = random(32)
    assert.equal(z32(b).length, 52)
    assert.ok(equal(unz32(z32(b)), b))
  }
})

test('bencode round trip and hostile input', () => {
  const v = { a: 1, b: utf8('x'), l: [1, utf8('y'), { z: 2 }] }
  assert.deepEqual(decode(encode(v)), Object.assign(Object.create(null), { a: 1, b: utf8('x'), l: [1, utf8('y'), Object.assign(Object.create(null), { z: 2 })] }))
  for (const bad of ['d1:a', 'l', 'i12', '5:abc', 'd', 'li1e', 'd1:ai1e', '']) assert.throws(() => decode(utf8(bad)))
  const p = decode(utf8('d9:__proto__i1ee'))
  assert.equal(Object.getPrototypeOf(p), null)
})

test('same seed gives the same keys; Ed25519 and X25519 differ', async () => {
  const seed = random(32), a = await identity(seed), b = await identity(seed)
  assert.ok(equal(a.pub, b.pub) && equal(a.xpub, b.xpub))
  assert.ok(!equal(a.pub, a.xpub))
  const sig = await sign(a, utf8('hi'))
  assert.ok(await verify(b.pub, sig, utf8('hi')))
  assert.ok(!await verify(b.pub, sig, utf8('ho')))
})

test('Beacon: sign, pack, verify, tamper', async () => {
  const id = await identity()
  const rec = await makeBeacon(id, { c: ['corvax-anchor:x'], n: 'demo' })
  assert.ok(await verifyBeacon(rec))
  assert.deepEqual(fields(unpack(rec.pub, pack(rec))).n, ['demo'])
  assert.ok(fields(rec).x[0].length > 40)
  const bad = { ...rec, v: rec.v.slice() }; bad.v[bad.v.length - 1] ^= 1
  assert.ok(!await verifyBeacon(bad))
})

test('messages: open, tamper, reflection, redirection', async () => {
  const a = await identity(), b = await identity(), c = await identity()
  const wire = await seal(a, b.pub, b.xpub, { hello: 'b' })
  const m = await open(b, wire)
  assert.ok(equal(m.from, a.pub)); assert.deepEqual(m.body, { hello: 'b' })
  const t = wire.slice(); t[t.length - 1] ^= 1
  await assert.rejects(open(b, t))                                   // tampered
  await assert.rejects(open(a, wire))                                // reflected back to the sender
  await assert.rejects(open(c, wire))                                // someone else
  // redirection: C re-seals A's signed inner to itself: the signature covers "to", so it fails for C's keys
  const forC = await seal(a, b.pub, c.xpub, { x: 1 })                // addressed to b, encrypted to c
  await assert.rejects(open(c, forC))
})

test('anchor lines: grep from messy text, parse, format, public filter', () => {
  const key = z32(random(32))
  const html = `<pre>corvax-anchor:${key}@203.0.113.7:4799;web=https://a.example.org;q=93</pre> junk "corvax-anchor:bad@1.2.3.4:1"`
  const book = new Book({ allowPrivate: false })
  // 203.0.113.0/24 is a documentation range and refused as non-public
  assert.equal(book.add(html).length, 0)
  const ok = `see corvax-anchor:${key}@8.8.8.8:4799;web=https://a.example.org;q=93.`
  const [e] = book.add(ok)
  assert.equal(e.host, '8.8.8.8'); assert.equal(e.web, 'https://a.example.org'); assert.equal(e.hint, 93)
  assert.equal(parseLine(formatLine(e, 5)).hint, 5)
  assert.equal(parseLine(`corvax-anchor:${key}@[2a01:4f8::1]:4799`).host, '2a01:4f8::1')
  assert.ok(isPublic('2a01:4f8::1') && !isPublic('fd00::1') && !isPublic('10.1.2.3') && !isPublic('192.168.1.1') && isPublic('1.1.1.1'))
  assert.ok(!isPublic('203.0.113.9') && isPublic('203.0.114.9') && !isPublic('192.0.2.1') && isPublic('192.0.3.1') && isPublic('198.51.1.1'), 'only the documentation /24s')
  const hostile = `corvax-anchor:${key}@8.8.4.4:1;web=<script>`
  assert.equal(parseLine(hostile.slice(0, hostile.indexOf('<'))).web, undefined)
  for (const web of ['http://127.0.0.1:80', 'http://x@10.0.0.1', 'https://[fd00::1]'])
    assert.equal(new Book().add(`corvax-anchor:${z32(random(32))}@8.8.8.8:1;web=${web}`)[0].web, undefined, `private web= dropped: ${web}`)
})

test('inbox sequence numbers keep rising across restarts', async () => {
  const k = random(32), a = new Inboxes()
  await a.put(k, random(10))
  const [{ seq }] = await a.listen(k, 0)
  await new Promise(resolve => setTimeout(resolve, 2))
  const b = new Inboxes()                                                  // the anchor restarted; the client still acks `seq`
  await b.put(k, random(10))
  assert.equal((await b.listen(k, seq)).length, 1, 'new message not hidden by an old ack')
})

test('score: unverified capped at 50, verified grows with age, dead decays', () => {
  let now = 0
  const book = new Book({ allowPrivate: true, now: () => now })
  const key = z32(random(32))
  const [e] = book.add(`corvax-anchor:${key}@10.0.0.1:1;q=99`)
  assert.equal(book.score(e), 50)
  book.record(key, 'id', true); book.record(key, 'udp', true)
  assert.equal(book.score(e), 60)
  now = 7 * 86400e3
  assert.equal(book.score(e), 100)
  for (let i = 0; i < 20; i++) book.record(key, 'udp', false)
  assert.ok(book.score(e) < 5)
  assert.equal(book.score(e, 'browser'), 0)                         // never probed over http
  book.record(key, 'id', false)
  assert.equal(book.get(key), undefined)                             // wrong key: dropped
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize, topicId, makeRecord, readRecord, makeFrame, encodeFrame, checkFrame } from '../src/topic.js'
import { identity } from '../src/crypto.js'
import { decode, encode } from '../src/bencode.js'
import { equal, utf8, hex } from '../src/bytes.js'

test('topic names normalize to one id', async () => {
  assert.equal(normalize('  Chess   Club '), 'chess club')
  assert.equal(normalize('ＣＨＥＳＳ'), 'chess')                                   // NFKC folds full-width letters
  assert.ok(equal(await topicId('Chess Club'), await topicId('chess  club')))
  assert.ok(!equal(await topicId('chess'), await topicId('chess2')))
  assert.equal(hex(await topicId('chess')).length, 64)
  for (const bad of ['', '   ', 'x'.repeat(201)]) assert.throws(() => normalize(bad), e => e.code === 'bad-topic')
})

test('provider records: verify, tamper, wrong key', async () => {
  const id = await identity(), t = await topicId('chess')
  const raw = await makeRecord(id, t, 5, Date.now() + 600e3)
  const r = await readRecord(raw)
  assert.ok(r && r.seq === 5 && equal(r.k, id.pub) && equal(r.raw, raw))
  const d = decode(raw)
  assert.equal(await readRecord(encode({ ...d, seq: 6 })), null, 'seq is signed')
  assert.equal(await readRecord(encode({ ...d, exp: d.exp + 1 })), null, 'exp is signed')
  assert.equal(await readRecord(encode({ ...d, t: await topicId('other') })), null, 'topic is signed')
  assert.equal(await readRecord(encode({ ...d, k: (await identity()).pub })), null, 'key must match signature')
  assert.equal(await readRecord(utf8('garbage')), null)
})

test('broadcast frames: valid, tampered, wrong topic, oversize, old, ineligible', async () => {
  const id = await identity(), t = await topicId('chess'), other = await topicId('go')
  const rec = await makeRecord(id, t, 1, Date.now() + 600e3)
  const f = await makeFrame(id, t, utf8('{"hi":1}'), rec)
  assert.equal(typeof await checkFrame(encodeFrame(f), t), 'object')
  assert.equal(await checkFrame(encodeFrame(f), other), 'topic')
  assert.equal(await checkFrame(encodeFrame({ ...f, body: utf8('{"hi":2}') }), t), 'signature')
  assert.equal(await checkFrame(encodeFrame({ ...f, hop: 3 }), t).then(x => typeof x), 'object', 'hop is not signed')
  assert.equal(await checkFrame(encodeFrame({ ...f, hop: 9 }), t), 'hop')
  assert.equal(await checkFrame(encodeFrame(await makeFrame(id, t, new Uint8Array(1025), rec)), t), 'size')
  assert.equal(await checkFrame(encodeFrame(f), t, Date.now() + 121e3), 'age')
  assert.equal(await checkFrame(encodeFrame(f), t, Date.now() - 61e3), 'age', 'future-dated')
  const other1 = await identity()
  assert.equal(await checkFrame(encodeFrame(await makeFrame(other1, t, utf8('1'), rec)), t), 'eligibility', 'record of someone else')
  const goRec = await makeRecord(id, other, 1, Date.now() + 600e3)
  assert.equal(await checkFrame(encodeFrame(await makeFrame(id, t, utf8('1'), goRec)), t), 'eligibility', 'record for another topic')
  const expired = await makeRecord(id, t, 2, Date.now() - 120e3)
  assert.equal(await checkFrame(encodeFrame(await makeFrame(id, t, utf8('1'), expired)), t), 'eligibility', 'lapsed lease')
})

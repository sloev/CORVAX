import test from 'node:test'
import assert from 'node:assert/strict'
import { TopicStore } from '../src/store.js'
import { makeRecord, topicId, readRecord } from '../src/topic.js'
import { identity } from '../src/crypto.js'

const LEASE = 600e3
async function setup (o = {}) {
  let now = Date.now()
  const store = new TopicStore({ now: () => now, poll: 300, coalesce: 100, ...o })
  return { store, clock: { get: () => now, add: ms => { now += ms } }, t: await topicId('chess'), u: await topicId('go') }
}

test('put: ok, dup, stale, bad, expired, future; find only live', async () => {
  const { store, clock, t } = await setup(), a = await identity()
  const r1 = await makeRecord(a, t, 1, clock.get() + LEASE)
  assert.equal(await store.put(r1), 'ok')
  assert.equal(await store.put(r1), 'dup')
  assert.equal(await store.put(await makeRecord(a, t, 3, clock.get() + LEASE)), 'ok')
  assert.equal(await store.put(await makeRecord(a, t, 2, clock.get() + LEASE)), 'stale')
  const bad = r1.slice(); bad[bad.length - 3] ^= 1
  assert.equal(await store.put(bad), 'bad')
  const b = await identity()
  assert.equal(await store.put(await makeRecord(b, t, 1, clock.get() - 61e3)), 'expired')
  assert.equal(await store.put(await makeRecord(b, t, 1, clock.get() + LEASE + 61e3)), 'future', 'publisher clock too far ahead')
  assert.equal(await store.put(await makeRecord(b, t, 1, clock.get() + LEASE + 30e3)), 'ok', 'within skew')
  assert.equal(store.find([t]).length, 2)
  clock.add(LEASE + 31e3)
  assert.equal(store.find([t]).length, 0, 'leases lapsed')
  store.sweep(); clock.add(61e3); store.sweep()
  assert.equal(store.size, 0, 'swept')
})

test('tombstone removes presence and blocks replay of older records', async () => {
  const { store, clock, t } = await setup(), a = await identity()
  const old = await makeRecord(a, t, 10, clock.get() + LEASE)
  await store.put(old)
  assert.equal(await store.put(await makeRecord(a, t, 11, clock.get())), 'ok')
  assert.equal(store.find([t]).length, 0)
  clock.add(LEASE / 2); store.sweep()
  assert.equal(await store.put(old), 'stale', 'replayed old record rejected')
  assert.equal(store.find([t]).length, 0)
})

test('restore after a restart keeps live records and tombstones', async () => {
  const { store, clock, t } = await setup(), a = await identity(), b = await identity()
  const old = await makeRecord(b, t, 1, clock.get() + LEASE)
  await store.put(await makeRecord(a, t, 1, clock.get() + LEASE)); await store.put(old)
  await store.put(await makeRecord(b, t, 2, clock.get()))                  // b leaves: a tombstone
  const raws = [...store.topics.get([...store.topics.keys()][0]).values()].map(e => e.raw)
  const fresh = new TopicStore({ now: clock.get })
  await fresh.load(raws)
  assert.equal(fresh.find([t]).length, 1, 'live record restored')
  assert.equal(await fresh.put(old), 'stale', 'tombstone still blocks the replay')
})

test('limits per provider', async () => {
  const { store, clock } = await setup({ perProvider: 2 }), a = await identity()
  for (const [i, name] of ['a', 'b', 'c'].entries()) {
    const r = await store.put(await makeRecord(a, await topicId(name), 1, clock.get() + LEASE))
    assert.equal(r, i < 2 ? 'ok' : 'full')
  }
})

test('watch: snapshot, delta, coalescing, timeout, abort, epoch change, trimmed log', async () => {
  const { store, clock, t, u } = await setup({ logMax: 3 }), a = await identity(), b = await identity()
  await store.put(await makeRecord(a, t, 1, clock.get() + LEASE))
  let r = await store.watch([t], undefined)
  assert.equal(r.snap, 1); assert.equal(r.r.length, 1)
  const c = r.c

  let t0 = Date.now()
  r = await store.watch([t], c)
  assert.ok(Date.now() - t0 >= 280 && !r.snap && r.r.length === 0, 'timed out empty')

  t0 = Date.now()
  const pending = store.watch([t], c)
  setTimeout(async () => {
    await store.put(await makeRecord(b, t, 1, clock.get() + LEASE))
    await store.put(await makeRecord(b, t, 2, clock.get() + LEASE))
    await store.put(await makeRecord(a, u, 1, clock.get() + LEASE))       // other topic: not delivered
  }, 20)
  r = await pending
  const got = await Promise.all(r.r.map(readRecord))
  assert.deepEqual(got.map(x => x.seq), [2], 'coalesced: newest per provider, only watched topics')
  assert.ok(Date.now() - t0 >= 100, 'waited for the coalescing window')

  const ac = new AbortController()
  t0 = Date.now()
  setTimeout(() => ac.abort(), 30)
  await store.watch([t], r.c, ac.signal)
  assert.ok(Date.now() - t0 < 250, 'abort ends the poll')

  assert.equal((await store.watch([t], 'deadbeef:1')).snap, 1, 'other epoch → snapshot')
  for (let i = 3; i < 8; i++) await store.put(await makeRecord(b, t, i, clock.get() + LEASE))
  assert.equal((await store.watch([t], c)).snap, 1, 'cursor older than the log → snapshot')
  assert.equal((await store.watch([t], `${store.epoch}:999999`)).snap, 1, 'cursor from the future → snapshot')
})

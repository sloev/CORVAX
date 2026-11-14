// TopicStore: what a storage peer keeps. Leased, signed provider records; no topic authority.
//   put(record)          validate → 'ok' | 'dup' | 'stale' | 'expired' | 'future' | 'full' | 'bad'
//   find([ids])          live records (exp > now), newest first, ≤ 100 per topic
//   watch([ids], cursor) snapshot or coalesced delta, long poll ≤ 25 s
// Tombstones (exp ≤ now, higher seq) are kept until now + lease + skew so old records can't be replayed.
import { readRecord, LIMITS } from './topic.js'
import { sign } from './crypto.js'
import { hex, random, concat, utf8 } from './bytes.js'

export class TopicStore {
  constructor ({ now = () => Date.now(), lease = LIMITS.lease, skew = LIMITS.skew, perProvider = 64, maxRecords = 50000,
    perTopic = 100, logMax = 10000, logAge = 30 * 60e3, poll = 25e3, coalesce = 2e3 } = {}) {
    Object.assign(this, { now, lease, skew, perProvider, maxRecords, perTopic, logMax, logAge, poll, coalesce })
    this.topics = new Map()       // hex(t) -> Map(hex(k) -> { seq, exp, keep, raw })
    this.counts = new Map()       // hex(k) -> topics held for this provider
    this.size = 0
    this.log = []                 // [{ n, t: hex, raw, at }]
    this.n = 0
    this.epoch = hex(random(4))
    this.waiters = new Set()
  }

  async put (raw, restore = false) {
    const r = await readRecord(raw)
    if (!r) return 'bad'
    const now = this.now(), t = hex(r.t), k = hex(r.k)
    if (r.exp > now + this.lease + this.skew) return 'future'
    const old = this.topics.get(t)?.get(k)
    if (old && old.seq > r.seq) return 'stale'
    if (old && old.seq === r.seq) return 'dup'
    if (r.exp < now - this.skew && !old && !restore) return 'expired'          // a tombstone for nothing we hold: nothing to do
    if (!old) {
      if ((this.counts.get(k) || 0) >= this.perProvider || this.size >= this.maxRecords) return 'full'
      this.counts.set(k, (this.counts.get(k) || 0) + 1); this.size++
      if (!this.topics.has(t)) this.topics.set(t, new Map())
    }
    // keep until the record lapses, or (for tombstones) long enough to outlive any older record
    const keep = r.exp > now ? r.exp + this.skew : now + this.lease + this.skew
    this.topics.get(t).set(k, { seq: r.seq, exp: r.exp, keep, raw: r.raw })
    this.#event(t, k, r.raw, now)
    return 'ok'
  }

  find (ids) {
    const now = this.now()
    return ids.flatMap(t => [...(this.topics.get(hex(t))?.values() || [])]
      .filter(e => e.exp > now).sort((a, b) => b.seq - a.seq).slice(0, this.perTopic).map(e => e.raw))
  }

  cursor () { return `${this.epoch}:${this.n}` }

  // Long poll for a set of topics. Returns { snap, r, c }.
  async watch (ids, c, signal, wait) {
    const want = new Set(ids.map(hex))
    const from = this.#parse(c)
    if (from === null) return { snap: 1, r: this.find(ids), c: this.cursor() }
    let events = this.#since(from, want)
    if (!events.length && !signal?.aborted) {
      await new Promise(resolve => {
        const w = { want, timer: null, coalescing: false }
        const done = () => { clearTimeout(w.timer); this.waiters.delete(w); signal?.removeEventListener('abort', done); resolve() }
        w.wake = () => { if (w.coalescing) return; w.coalescing = true; clearTimeout(w.timer); w.timer = setTimeout(done, this.coalesce) }
        w.timer = setTimeout(done, wait ? Math.min(Math.max(wait, 1e3), 55e3) : this.poll)
        w.done = done
        this.waiters.add(w)
        signal?.addEventListener('abort', done)
      })
      events = this.#since(from, want)
    }
    const latest = new Map()                                         // newest record per (topic, provider) among the events
    for (const e of events) latest.set(e.key, e.raw)
    return { r: [...latest.values()], c: this.cursor() }
  }

  // Expire records and trim the log. Call every ~30 s.
  sweep () {
    const now = this.now()
    for (const [t, m] of this.topics) {
      for (const [k, e] of m) {
        if (e.keep < now) { m.delete(k); this.size--; const n = (this.counts.get(k) || 1) - 1; n ? this.counts.set(k, n) : this.counts.delete(k) }
      }
      if (!m.size) this.topics.delete(t)
    }
    while (this.log.length && (this.log.length > this.logMax || now - this.log[0].at > this.logAge)) this.log.shift()
  }

  // Restore persisted records, tombstones included (they keep blocking replays of older records).
  async load (raws) { for (const raw of raws) await this.put(raw, true) }

  close () { for (const w of [...this.waiters]) w.done() }

  #event (t, k, raw, at) {
    this.log.push({ n: ++this.n, t, key: `${t}|${k}`, raw, at })
    if (this.log.length > this.logMax) this.log.shift()
    for (const w of this.waiters) if (w.want.has(t)) w.wake()
  }
  #since (from, want) { return this.log.filter(e => e.n > from && want.has(e.t)) }
  // A cursor is usable only if it is ours (same epoch) and no events after it have been trimmed.
  #parse (c) {
    if (typeof c !== 'string') return null
    const [epoch, n] = c.split(':')
    const at = Number(n)
    if (epoch !== this.epoch || !Number.isSafeInteger(at) || at > this.n) return null
    const oldest = this.log.length ? this.log[0].n : this.n + 1
    if (at < oldest - 1) return null
    return at
  }
}

// cx_hi and the storage queries, answered identically by every peer over UDP, HTTP and WebRTC.
export async function serve ({ id, store, line, relay, stored }, q, a) {
  const list = (x, max, ok) => Array.isArray(x) ? x.filter(ok).slice(0, max) : []
  if (q === 'cx_hi') {
    if (!(a.n instanceof Uint8Array) || a.n.length > 64) throw [203, 'bad nonce']
    return { k: id.pub, sig: await sign(id, concat(utf8('cx-hi'), a.n)), ...(line && { line }), ...(store && { st: 1 }), ...(relay && { rl: 1 }) }
  }
  if (q !== 'cx_tpub' && q !== 'cx_tfind') throw [204, 'method unknown']
  if (!store) throw [204, 'storage disabled on this peer']
  if (q === 'cx_tfind') return { r: store.find(list(a.t, 16, b => b instanceof Uint8Array && b.length === 32)), now: Date.now() }
  const ok = []
  for (const raw of list(a.r, 32, r => r instanceof Uint8Array && r.length <= 512)) {
    const s = await store.put(raw)
    ok.push(utf8(s))
    if (s === 'ok') stored?.(raw)
  }
  return { ok, now: Date.now() }
}

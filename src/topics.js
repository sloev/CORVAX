// Peer side of topics: presence (leased provider records on storage nodes) and best-effort broadcast.
//   publish/renew/unpublish  → the 5 XOR-closest storage nodes, batched, one timer, ±20 % jitter
//   search                   → cx_tfind on the 8 closest; every record is verified here (storage is untrusted)
//   subscribe                → one multiplexed cx_twatch long poll per storage node + topic neighbours
//   broadcast                → signed frame to ≤ 4 neighbours; receivers verify, dedup, rate-limit, forward to ≤ 3
import { topicId, normalize, makeRecord, readRecord, makeFrame, encodeFrame, checkFrame, LIMITS } from './topic.js'
import { hex, z32, unz32, utf8, str, xor, compare } from './bytes.js'

const err = (code, message) => Object.assign(new Error(message || code), { code })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const jitter = (ms, j) => ms * (1 - j + 2 * j * Math.random())
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
const bytesOf = d => d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null
const toWire = u8 => typeof Buffer !== 'undefined' ? Buffer.from(u8.buffer, u8.byteOffset, u8.length) : u8
const unref = t => { t?.unref?.(); return t }

export class Topics {
  constructor (peer, limits = {}) {
    this.peer = peer
    this.L = { ...LIMITS, ...limits }
    this.handles = new Map()      // hex(topic id) -> Topic
    this.skews = []               // recent samples of (storage clock − local clock)
    this.down = new Map()         // storage node key -> until (skipped while down)
    this.polls = new Map()        // storage node key -> { ac, topics: Set(hex) }
    this.links = new Map()        // `${tid}|${address}` -> { address, tid, channel, kind }
    this.reserved = new Map()     // `${tid}|${address}` -> { until, out } (out = our own attempt)
    this.failed = new Map()       // `${tid}|${address}` -> time of last failed link attempt
    this.seen = new Map()         // hex(frame id) -> time
    this.rates = new Map()        // `${tid}|${from}` -> [times]
    this.debounce = new Map()     // tid -> timer
    this.stats = { delivered: 0, forwarded: 0, dropped: {} }
    this.closed = false
  }

  now () { return this.peer.now() }
  skew () {
    if (!this.skews.length) return 0
    const s = [...this.skews].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  sample (remote, t0, t1) {
    if (!Number.isSafeInteger(remote)) return
    this.skews.push(remote - (t0 + t1) / 2)
    if (this.skews.length > 8) this.skews.shift()
  }

  async topic (name) {
    const id = await topicId(name), h = hex(id)
    if (!this.handles.has(h)) this.handles.set(h, new Topic(this, normalize(name), id))
    return this.handles.get(h)
  }

  // The n XOR-closest verified storage nodes we can reach, skipping ones that recently failed.
  nodes (id, n) {
    const now = Date.now()
    return this.peer.book.best(1000, 'native', e => e.verified && e.storage && this.peer.urlOf(e) && !(this.down.get(e.key) > now))
      .sort((a, b) => compare(xor(unz32(a.key), id), xor(unz32(b.key), id))).slice(0, n)
  }
  markDown (key) { this.down.set(key, Date.now() + 5 * 60e3); this.peer.book.record(key, 'http', false) }

  // ---- presence: publish / renew / unpublish ----------------------------------------------------
  // Send records to the closest nodes, falling back to the next ones, until each has `replicas` copies.
  async push (items) {
    const want = this.L.replicas, count = new Map(), tried = new Map(), ranked = new Map()
    for (const x of items) { count.set(x, 0); tried.set(x, 0); ranked.set(x, this.nodes(x.topic.id, this.L.maxNodes)) }
    for (let round = 0; round < 4; round++) {
      const batches = new Map()
      for (const x of items) {
        const need = want - count.get(x)
        if (need <= 0) continue
        const next = ranked.get(x).slice(tried.get(x), tried.get(x) + need)
        tried.set(x, tried.get(x) + next.length)
        for (const e of next) { if (!batches.has(e.key)) batches.set(e.key, { e, list: [] }); batches.get(e.key).list.push(x) }
      }
      if (!batches.size) break
      await Promise.all([...batches.values()].map(async ({ e, list }) => {
        for (let i = 0; i < list.length; i += 32) {
          const chunk = list.slice(i, i + 32), t0 = this.now()
          try {
            const r = await this.peer.rpc(this.peer.urlOf(e), 'cx_tpub', { r: chunk.map(x => x.raw) }, { timeout: 6000, retries: 1 })
            this.sample(r.now, t0, this.now())
            chunk.forEach((x, j) => {
              const s = r.ok?.[j] ? str(r.ok[j]) : ''
              if (s === 'ok' || s === 'dup') { count.set(x, count.get(x) + 1); x.nodes?.push(e.key) } else if (s === 'future' || s === 'expired') x.skewed = true
            })
          } catch { this.markDown(e.key) }
        }
      }))
    }
    return count
  }

  // Sign fresh records for these topics and store them; one retry with corrected clock skew.
  async publishNow (topics) {
    const sign = async t => ({ topic: t, raw: await t.sign(this.now() + this.skew() + this.L.lease), nodes: [] })
    const items = await Promise.all(topics.map(sign))
    const count = await this.push(items)
    const retry = items.filter(x => !count.get(x) && x.skewed)
    if (retry.length) {
      const again = await Promise.all(retry.map(x => sign(x.topic)))
      for (const [x, n] of await this.push(again)) count.set(x, n)
    }
    const out = new Map()
    for (const [x, n] of count) out.set(x.topic, Math.max(out.get(x.topic) || 0, n))
    return out
  }

  schedule () {
    if (this.renewTimer || this.closed) return
    this.renewTimer = unref(setTimeout(() => this.renew(), jitter(this.L.renew, this.L.jitter)))
  }
  async renew () {
    this.renewTimer = null
    if (this.closed) return
    const published = [...this.handles.values()].filter(t => t.published)
    if (published.length) await this.publishNow(published).catch(() => {})
    for (const t of this.handles.values()) if (t.subs.size) this.maintain(t)
    if (published.length) this.schedule()
  }

  // ---- search and watch --------------------------------------------------------------------------
  async search (topic) {
    const found = []
    await Promise.allSettled(this.nodes(topic.id, this.L.searchNodes).map(async e => {
      const t0 = this.now()
      try {
        const r = await this.peer.rpc(this.peer.urlOf(e), 'cx_tfind', { t: [topic.id] }, { timeout: 6000, retries: 1 })
        this.sample(r.now, t0, this.now())
        found.push(...(Array.isArray(r.r) ? r.r : []))
      } catch { this.markDown(e.key) }
    }))
    for (const raw of found) { const rec = await readRecord(raw); if (rec && hex(rec.t) === topic.hex) topic.merge(rec) }
    const now = this.now() + this.skew()
    return [...topic.providers].filter(([, p]) => p.exp > now)
      .map(([address, p]) => ({ address, presence: 'recent', expires: p.exp - this.skew(), seq: p.seq }))
  }

  // Recompute which storage nodes watch which topics; one long poll per node.
  rewatch () {
    clearTimeout(this.rewatchTimer)
    this.rewatchTimer = unref(setTimeout(() => this.#rewatch(), 20))
  }
  #rewatch () {
    if (this.closed) return
    const plan = new Map()
    for (const t of this.handles.values()) {
      if (!t.subs.size) continue
      for (const e of this.nodes(t.id, this.L.replicas)) {
        if (!plan.has(e.key)) plan.set(e.key, { e, topics: new Set() })
        plan.get(e.key).topics.add(t.hex)
      }
    }
    for (const [key, p] of this.polls) {
      const next = plan.get(key)
      if (!next || next.topics.size !== p.topics.size || [...next.topics].some(h => !p.topics.has(h))) { p.ac.abort(); this.polls.delete(key) }
    }
    for (const [key, { e, topics }] of plan) if (!this.polls.has(key)) this.#poll(key, e, topics)
    const watching = [...this.handles.values()].some(t => t.subs.size)
    if (watching && !this.expiry) this.expiry = unref(setInterval(() => this.#expire(), 5000))
    if (!watching && this.expiry) { clearInterval(this.expiry); this.expiry = null }
  }
  async #poll (key, e, topics) {
    const state = { ac: new AbortController(), topics }
    this.polls.set(key, state)
    const ids = [...topics].map(h => this.handles.get(h)?.id).filter(Boolean).slice(0, 64)
    let cursor, fails = 0
    while (!state.ac.signal.aborted && !this.closed) {
      try {
        const t0 = this.now()
        const r = await this.peer.rpc(this.peer.urlOf(e), 'cx_twatch', { t: ids, ...(cursor && { c: cursor }) }, { timeout: 35000, retries: 0, signal: state.ac.signal })
        this.sample(r.now, t0, this.now())
        fails = 0
        cursor = r.c instanceof Uint8Array ? str(r.c) : undefined
        for (const raw of Array.isArray(r.r) ? r.r : []) {
          const rec = await readRecord(raw), t = rec && this.handles.get(hex(rec.t))
          if (t && topics.has(t.hex)) t.merge(rec)
        }
      } catch {
        if (state.ac.signal.aborted || this.closed) return
        if (++fails >= 3) { this.markDown(key); if (this.polls.get(key) === state) this.polls.delete(key); return this.rewatch() }
        await sleep(Math.min(30e3, 1000 * 2 ** fails))
      }
    }
  }
  #expire () { for (const t of this.handles.values()) if (t.subs.size) t.expire() }

  // ---- topic neighbours ----------------------------------------------------------------------------
  #count (tid) {
    const now = Date.now()
    for (const [k, r] of this.reserved) if (r.until < now) this.reserved.delete(k)
    let topic = 0
    for (const k of [...this.links.keys(), ...this.reserved.keys()]) if (k.startsWith(tid + '|')) topic++
    return { topic, total: this.links.size + this.reserved.size }
  }
  // Called for incoming topic offers (direct or relayed). Reserves a slot when it says yes.
  // If both sides try at once, the attempt from the lower address wins (the other side answers busy).
  accept (from, tid) {
    const t = this.handles.get(tid), key = `${tid}|${from}`, mine = this.reserved.get(key)
    if (this.closed || !t?.subs.size || this.links.has(key)) return false
    if (mine) {
      if (!(mine.out && from < this.peer.address)) return false
      mine.out = false                                           // their attempt replaces ours, same slot
      return true
    }
    const c = this.#count(tid)
    if (c.topic >= this.L.neighbours || c.total >= this.L.links) return false
    this.reserved.set(key, { until: Date.now() + 40e3, out: false })
    return true
  }
  release (from, tid) { this.reserved.delete(`${tid}|${from}`) }
  attach (address, tid, channel, kind) {
    const key = `${tid}|${address}`, t = this.handles.get(tid)
    this.reserved.delete(key)
    if (this.closed || !t?.subs.size || this.links.has(key)) { try { channel.close() } catch {} return }
    const link = { address, tid, channel, kind }
    this.links.set(key, link)
    channel.binaryType = 'arraybuffer'
    channel.onmessage = e => this.#onFrame(link, e.data).catch(() => {})
    channel.onclose = () => { if (this.links.get(key) === link) { this.links.delete(key); this.maintainSoon(t) } }
  }
  dropLinks (t) {
    for (const [key, l] of this.links) if (l.tid === t.hex) { this.links.delete(key); try { l.channel.close() } catch {} }
  }
  maintainSoon (t) {
    if (this.closed || !t.subs.size || this.debounce.has(t.hex)) return
    this.debounce.set(t.hex, unref(setTimeout(() => { this.debounce.delete(t.hex); this.maintain(t) }, 1000)))
  }
  // Top up to 4 neighbours from the topic's recent providers (at most 2 attempts per run).
  async maintain (t) {
    if (this.closed || !t.subs.size || t.maintaining || !this.peer.RTC) return
    t.maintaining = true
    try {
      const c = this.#count(t.hex), now = Date.now()
      const room = Math.min(this.L.neighbours - c.topic, this.L.links - c.total)
      const cands = shuffle([...t.providers].filter(([a, p]) => p.presence === 'recent' && a !== this.peer.address &&
        !this.links.has(`${t.hex}|${a}`) && !this.reserved.has(`${t.hex}|${a}`) && !(now - (this.failed.get(`${t.hex}|${a}`) || 0) < 120e3)).map(([a]) => a))
      for (const address of cands.slice(0, Math.min(room, 2))) {
        const key = `${t.hex}|${address}`
        const mine = { until: Date.now() + 40e3, out: true }
        this.reserved.set(key, mine)
        try {
          const r = await this.peer.connect(address, { purpose: 'topic', tp: t.hex, timeout: 8000 })
          this.attach(address, t.hex, r.channel, r.kind)
        } catch {
          this.failed.set(key, Date.now())
          if (this.reserved.get(key) === mine && mine.out) this.reserved.delete(key)   // keep it if their attempt took the slot
        }
      }
    } finally { t.maintaining = false }
  }

  // ---- broadcast ------------------------------------------------------------------------------------
  #linksFor (tid) { return [...this.links.values()].filter(l => l.tid === tid) }
  #rate (tid, from) {
    const key = `${tid}|${from}`, now = Date.now(), list = (this.rates.get(key) || []).filter(x => now - x < 60e3)
    if (list.length >= this.L.rate) { this.rates.set(key, list); return false }
    list.push(now); this.rates.set(key, list)
    if (this.rates.size > 5000) for (const [k, v] of this.rates) if (!v.some(x => now - x < 60e3)) this.rates.delete(k)
    return true
  }
  #remember (id) {
    const now = Date.now()
    this.seen.set(id, now)
    if (this.seen.size > 10000) for (const [k, t] of this.seen) if (now - t > this.L.dedup || this.seen.size > 10000) this.seen.delete(k)
  }
  #drop (reason) { this.stats.dropped[reason] = (this.stats.dropped[reason] || 0) + 1 }
  #send (link, wire) { try { link.channel.send(toWire(wire)) } catch { this.#drop('send') } }

  async broadcast (t, body) {
    if (!t.published || !t.record) throw err('not-published', 'publish() the topic before broadcasting')
    const bytes = utf8(JSON.stringify(body ?? null))
    if (bytes.length > this.L.body) throw err('too-large', `broadcast body is ${bytes.length} bytes (max ${this.L.body})`)
    if (!this.#rate(t.hex, this.peer.address)) throw err('rate-limited', `at most ${this.L.rate} broadcasts per minute per topic`)
    const f = await makeFrame(this.peer.id, t.id, bytes, t.record, this.L.hops)
    this.#remember(hex(f.id))
    const wire = encodeFrame(f), links = this.#linksFor(t.hex)
    for (const l of links) this.#send(l, wire)
    return { sent: links.length }
  }

  async #onFrame (link, data) {
    const bytes = bytesOf(data), t = this.handles.get(link.tid)
    if (!bytes || !t) return this.#drop('encoding')
    if (bytes.length > this.L.frame) return this.#drop('size')
    const r = await checkFrame(bytes, t.id, this.now() + this.skew(), this.L)
    if (typeof r === 'string') return this.#drop(r)
    const f = r.frame, id = hex(f.id)
    if (this.seen.has(id)) return this.#drop('duplicate')
    this.#remember(id)                                               // only verified frames enter the cache
    const from = z32(f.from)
    if (from === this.peer.address) return this.#drop('own')
    if (!this.#rate(t.hex, from)) return this.#drop('rate')
    let body
    try { body = JSON.parse(str(f.body)) } catch { return this.#drop('encoding') }
    this.stats.delivered++
    for (const s of t.subs) try { s.message?.({ topic: t.name, from, body }) } catch {}
    if (f.hop <= 1) return
    const next = encodeFrame({ ...f, hop: f.hop - 1 })
    for (const l of shuffle(this.#linksFor(t.hex).filter(l => l !== link && l.address !== from)).slice(0, this.L.fanout)) {
      this.#send(l, next); this.stats.forwarded++
    }
  }

  async close () {
    if (this.closed) return
    const published = [...this.handles.values()].filter(t => t.published)
    await Promise.race([Promise.allSettled(published.map(t => t.unpublish())), sleep(3000)])
    this.closed = true
    clearTimeout(this.renewTimer); clearTimeout(this.rewatchTimer); clearInterval(this.expiry)
    this.renewTimer = this.rewatchTimer = this.expiry = null
    for (const timer of this.debounce.values()) clearTimeout(timer)
    for (const p of this.polls.values()) p.ac.abort()
    for (const l of this.links.values()) try { l.channel.close() } catch {}
    this.polls.clear(); this.links.clear(); this.reserved.clear(); this.debounce.clear()
  }
}

export class Topic {
  constructor (topics, name, id) {
    Object.assign(this, { topics, name, id, hex: hex(id) })
    this.published = false
    this.seq = 0
    this.record = null
    this.subs = new Set()
    this.providers = new Map()     // address -> { seq, exp, presence }
  }

  async sign (exp) {
    this.seq = Math.max(this.seq + 1, Date.now())
    this.record = await makeRecord(this.topics.peer.id, this.id, this.seq, Math.round(exp))
    return this.record
  }

  async publish () {
    if (this.topics.closed) throw err('closed')
    this.published = true
    const stored = (await this.topics.publishNow([this])).get(this) || 0
    this.topics.schedule()
    if (!stored) throw err('no-storage', 'no storage node accepted the record')
    return { stored }
  }
  async unpublish () {
    if (!this.published) return
    this.published = false
    const raw = await this.sign(this.topics.now() + this.topics.skew())   // tombstone: newer seq, already expired
    this.record = null
    await this.topics.push([{ topic: this, raw }]).catch(() => {})
  }
  search () { return this.topics.search(this) }

  subscribe ({ presence, message } = {}) {
    const s = { presence, message }
    this.subs.add(s)
    this.topics.rewatch()
    this.topics.maintainSoon(this)
    return () => {
      if (!this.subs.delete(s) || this.subs.size) return
      this.topics.dropLinks(this)
      this.topics.rewatch()
    }
  }
  broadcast (body) { return this.topics.broadcast(this, body) }

  // Merge a verified record (from search or watch); emit presence only on transitions.
  merge (rec) {
    const address = z32(rec.k)
    if (address === this.topics.peer.address) return
    const cur = this.providers.get(address)
    if (cur && rec.seq <= cur.seq) return
    const presence = rec.exp > this.topics.now() + this.topics.skew() ? 'recent' : 'expired'
    this.providers.set(address, { seq: rec.seq, exp: rec.exp, presence })
    if (presence !== (cur?.presence ?? 'expired')) this.#emit(address, presence, rec.exp)
    if (presence === 'recent') this.topics.maintainSoon(this)
  }
  expire () {
    const now = this.topics.now() + this.topics.skew()
    for (const [address, p] of this.providers) {
      if (p.presence === 'recent' && p.exp <= now) { p.presence = 'expired'; this.#emit(address, 'expired', p.exp) }
      if (p.presence === 'expired' && now - p.exp > 3600e3) this.providers.delete(address)
    }
  }
  #emit (address, presence, exp) {
    for (const s of this.subs) try { s.presence?.({ topic: this.name, address, presence, expires: exp - this.topics.skew() }) } catch {}
  }

  async close () {
    this.subs.clear()
    this.topics.dropLinks(this)
    await this.unpublish()
    this.topics.handles.delete(this.hex)
    this.topics.rewatch()
  }
}

// Topics, peer side: leased presence on storage peers and best-effort broadcast (SPEC §6).
//   publish/renew → 4 closest established + 1 random storage peers, own store, neighbours; batched, one timer
//   search        → own store, neighbours, 6 + 2 storage peers; every record verified here (storage is untrusted)
//   subscribe     → one cx_twatch long poll per storage peer, plus ≤ 4 neighbour links for broadcast
import { topicId, normalize, makeRecord, readRecord, makeFrame, encodeFrame, checkFrame, LIMITS } from './topic.js'
import { hex, z32, unz32, utf8, str, xor, compare, fail, sleep, unref, shuffle, bytesOf, toWire, random } from './bytes.js'
import { encode } from './bencode.js'

const jitter = (ms, j) => ms * (1 - j + 2 * j * Math.random())

export class Topics {
  constructor (peer, limits = {}) {
    this.peer = peer
    this.L = { ...LIMITS, ...limits }
    this.handles = new Map()      // hex(topic id) -> Topic
    this.skews = []               // recent samples of (storage clock − local clock)
    this.down = new Map()         // storage peer key -> until (skipped while down)
    this.polls = new Map()        // storage peer key -> { ac, topics: Set(hex) }
    this.links = new Map()        // `${tid}|${address}` -> { address, tid, channel, kind }
    this.reserved = new Map()     // `${tid}|${address}` -> { until, out } (out = our own attempt)
    this.failed = new Map()       // `${tid}|${address}` -> time of last failed link attempt
    this.seen = new Map()         // hex(frame id) -> time
    this.rates = new Map()        // `${tid}|${from}` -> [times]
    this.debounce = new Map()     // tid -> timer
    this.stats = { delivered: 0, forwarded: 0, dropped: {} }
    this.closed = false
    // Browsers: leaving the page withdraws every lease at once (pre-signed, sent with keepalive); back from bfcache, rejoin.
    if (typeof document !== 'undefined' && typeof addEventListener === 'function') {
      this.onHide = () => { for (const t of this.handles.values()) if (t.published) { t.unpublish(); t.rejoin = true } }
      this.onShow = e => { if (e.persisted) for (const t of this.handles.values()) if (t.rejoin) { t.rejoin = false; t.publish(t.opts).catch(() => {}) } }
      addEventListener('pagehide', this.onHide); addEventListener('pageshow', this.onShow)
    }
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

  // Topic members must be reachable by key (others resolve our Beacon to connect), so make sure it exists.
  ensureBeacon () {
    if (!this.beacon) this.beacon = this.peer.beaconSeq ? Promise.resolve() : this.peer.publish().catch(e => { this.beacon = null; throw e })
    return this.beacon
  }

  async topic (name) {
    const id = await topicId(name), h = hex(id)
    if (!this.handles.has(h)) this.handles.set(h, new Topic(this, normalize(name), id))
    return this.handles.get(h)
  }

  // Storage peers we can reach over HTTP, skipping ones that recently failed.
  candidates () {
    const now = Date.now()
    return this.peer.book.best(1000, 'native', e => e.verified && e.storage && this.peer.urlOf(e) && !(this.down.get(e.key) > now))
  }
  // `closest` XOR-closest storage peers, established ones first (fresh keys can't grab a topic), plus
  // `random` others picked at random. When too few are established, the closest of the rest fill in.
  pick (id, closest, random = 0) {
    const all = this.candidates(), score = e => this.peer.book.score(e)
    const byXor = list => list.sort((a, b) => compare(xor(unz32(a.key), id), xor(unz32(b.key), id)))
    const near = [...byXor(all.filter(e => score(e) >= this.L.established)), ...byXor(all.filter(e => score(e) < this.L.established))].slice(0, closest)
    return [...near, ...shuffle(all.filter(e => !near.includes(e))).slice(0, random)]
  }
  // Records that reach this peer by any path (HTTP storage, a neighbour's cx_tpub) update local presence.
  async local (raw) {
    const rec = await readRecord(raw), t = rec && this.handles.get(hex(rec.t))
    if (t) t.merge(rec)
  }
  markDown (key) { this.down.set(key, Date.now() + 5 * 60e3); this.peer.book.record(key, 'http', false) }

  // Send records to the closest nodes, falling back to the next ones, until each has `replicas` copies.
  async push (items) {
    const want = this.L.closest + this.L.random, count = new Map(), tried = new Map(), ranked = new Map()
    for (const x of items) {
      count.set(x, 0); tried.set(x, 0)
      const first = this.pick(x.topic.id, this.L.closest, this.L.random)            // 4 established-closest + 1 random
      ranked.set(x, [...first, ...this.pick(x.topic.id, this.L.maxNodes).filter(e => !first.includes(e))].slice(0, this.L.maxNodes))
    }
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
              if (s === 'ok' || s === 'dup') { count.set(x, count.get(x) + 1); x.topic.nodes.add(this.peer.urlOf(e)) } else if (s === 'future' || s === 'expired') x.skewed = true
            })
          } catch { this.markDown(e.key) }
        }
      }))
    }
    await this.copies(items)
    return count
  }
  // Extra copies: our own store, and every connected neighbour of the topic (over WebRTC).
  async copies (items) {
    await Promise.allSettled(items.map(async x => {
      await this.peer.store?.put(x.raw)
      await Promise.allSettled(this.#linksFor(x.topic.hex).map(l => this.peer.chanRpc(l.channel, 'cx_tpub', { r: [x.raw] }, 5000)))
    }))
  }
  // A cx_tpub that outlives a closing page (fetch keepalive); answers are not awaited by the page.
  sendNow (urls, raw) {
    const body = encode({ t: random(4), y: 'q', q: 'cx_tpub', a: { r: [raw] } })
    return urls.map(u => fetch(u.replace(/\/$/, '') + '/krpc', { method: 'POST', headers: { 'content-type': 'text/plain' }, body, keepalive: true }).catch(() => {}))
  }

  // Sign fresh records for these topics and store them; one retry with corrected clock skew.
  async publishNow (topics) {
    const sign = async t => ({ topic: t, raw: await t.sign(this.now() + this.skew() + (t.opts?.lease ?? this.L.lease)) })
    for (const t of topics) t.nodes = new Set()
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

  // One timer renews every published topic, at half the shortest lease (default: every 5 min).
  schedule () {
    if (this.closed) return
    const halves = [...this.handles.values()].filter(t => t.published && t.opts?.lease).map(t => t.opts.lease / 2)
    const at = Date.now() + jitter(Math.min(this.L.renew, ...halves), this.L.jitter)
    if (this.renewTimer && this.renewAt <= at) return
    clearTimeout(this.renewTimer)
    this.renewAt = at
    this.renewTimer = unref(setTimeout(() => this.renew(), at - Date.now()))
  }
  async renew () {
    this.renewTimer = null
    if (this.closed) return
    const published = [...this.handles.values()].filter(t => t.published)
    if (published.length) await this.publishNow(published).catch(() => {})
    for (const t of this.handles.values()) if (t.subs.size) this.maintain(t)
    if (published.length) this.schedule()
  }

  async search (topic) {
    const found = []
    for (const raw of this.peer.store?.find([topic.id]) || []) found.push(raw)
    await Promise.allSettled([...this.#linksFor(topic.hex).map(async l => {        // neighbours answer over WebRTC
      const r = await this.peer.chanRpc(l.channel, 'cx_tfind', { t: [topic.id] }, 5000)
      found.push(...(Array.isArray(r.r) ? r.r : []))
    }), ...this.pick(topic.id, this.L.searchClosest, this.L.searchRandom).map(async e => {
      const t0 = this.now()
      try {
        const r = await this.peer.rpc(this.peer.urlOf(e), 'cx_tfind', { t: [topic.id] }, { timeout: 6000, retries: 1 })
        this.sample(r.now, t0, this.now())
        found.push(...(Array.isArray(r.r) ? r.r : []))
      } catch { this.markDown(e.key) }
    })])
    for (const raw of found) { const rec = await readRecord(raw); if (rec && hex(rec.t) === topic.hex) topic.merge(rec) }
    const now = this.now() + this.skew()
    return [...topic.providers].filter(([, p]) => p.exp > now)
      .map(([address, p]) => ({ address, presence: 'recent', expires: p.exp - this.skew(), seq: p.seq }))
  }

  // Recompute which storage peers watch which topics; one long poll per node.
  rewatch () {
    clearTimeout(this.rewatchTimer)
    this.rewatchTimer = unref(setTimeout(() => this.#rewatch(), 20))
  }
  #rewatch () {
    if (this.closed) return
    const plan = new Map()
    for (const t of this.handles.values()) {
      if (!t.subs.size) continue
      for (const e of this.pick(t.id, this.L.watchClosest)) {
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
    if (this.closed || !t?.wantsLinks() || this.links.has(key)) return false
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
    if (this.closed || !t?.wantsLinks() || this.links.has(key)) { try { channel.close() } catch {} return }
    const link = { address, tid, channel, kind }
    this.links.set(key, link)
    channel.binaryType = 'arraybuffer'
    channel.onmessage = e => typeof e.data !== 'string' ? this.#onFrame(link, e.data).catch(() => {})
      : e.data[0] === 'K' ? this.peer.onChanText(channel, e.data)          // KRPC over the link (topic storage queries)
      : e.data[0] === 'M' && this.peer.deliver(address, e.data.slice(1))  // an app message over the mesh (see sendVia)
    channel.onclose = () => { if (this.links.get(key) === link) { this.links.delete(key); this.maintainSoon(t) } }
  }
  // Send an app message to a topic neighbour over its link, if we have one (no anchor involved). The link is an
  // authenticated WebRTC connection to that address, so the receiver attributes it to the link's peer.
  sendVia (address, body) {
    const l = [...this.links.values()].find(l => l.address === address && l.channel.readyState === 'open')
    if (!l) return false
    l.channel.send('M' + JSON.stringify(body))
    return true
  }
  dropLinks (t) {
    for (const [key, l] of this.links) if (l.tid === t.hex) { this.links.delete(key); try { l.channel.close() } catch {} }
  }
  maintainSoon (t) {
    if (this.closed || !t.wantsLinks() || this.debounce.has(t.hex)) return
    this.debounce.set(t.hex, unref(setTimeout(() => { this.debounce.delete(t.hex); this.maintain(t) }, 1000)))
  }
  // Top up to 4 neighbours from the topic's recent providers (at most 2 attempts per run).
  async maintain (t) {
    if (this.closed || !t.wantsLinks() || t.maintaining || !this.peer.RTC) return
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
    if (!t.published || !t.record) throw fail('not-published', 'publish() the topic before broadcasting')
    const bytes = utf8(JSON.stringify(body ?? null))
    if (bytes.length > this.L.body) throw fail('too-large', `broadcast body is ${bytes.length} bytes (max ${this.L.body})`)
    if (!this.#rate(t.hex, this.peer.address)) throw fail('rate-limited', `at most ${this.L.rate} broadcasts per minute per topic`)
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
    if (this.onHide) { removeEventListener('pagehide', this.onHide); removeEventListener('pageshow', this.onShow) }
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
    this.nodes = new Set()         // storage peer URLs holding our record
  }

  // Sign a record, and its withdrawal (next seq, already expired) right away, so leaving needs no async work.
  async sign (exp) {
    const id = this.topics.peer.id, seq = Math.max(this.seq + 1, Date.now())
    this.record = await makeRecord(id, this.id, seq, Math.round(exp))
    this.leave = await makeRecord(id, this.id, seq + 1, Math.round(this.topics.now() + this.topics.skew()) - 1)
    this.seq = seq + 1
    return this.record
  }
  // Broadcast links, unless every subscription is presence-only (a presence handler, no message handler).
  wantsLinks () { return [...this.subs].some(s => s.message || !s.presence) }

  // beacon: false = presence only (no Beacon, so nobody can link to you). lease: ms, ≤ 10 min; renewed at half.
  async publish (opts = {}) {
    if (this.topics.closed) throw fail('closed')
    const lease = opts.lease && Math.max(10e3, Math.min(this.topics.L.lease, opts.lease))
    this.opts = { ...opts, ...(lease && { lease }) }
    this.published = true
    if (opts.beacon !== false) await this.topics.ensureBeacon().catch(() => {})
    const stored = (await this.topics.publishNow([this])).get(this) || 0
    this.topics.schedule()
    if (!stored) throw fail('no-storage', 'no storage peer accepted the record')
    return { stored }
  }
  // Withdraw the lease: the pre-signed withdrawal goes out synchronously, so it survives a closing page.
  async unpublish () {
    if (!this.published) return
    this.published = false
    const raw = this.leave
    this.record = this.leave = null
    if (!raw) return
    await Promise.allSettled([...this.topics.sendNow([...this.nodes], raw), this.topics.copies([{ topic: this, raw }])])
  }
  search () { return this.topics.search(this) }

  subscribe ({ presence, message } = {}) {
    const s = { presence, message }
    this.subs.add(s)
    if (message || !presence) this.topics.ensureBeacon().catch(() => {})    // only broadcast links need us reachable
    this.topics.rewatch()
    this.topics.maintainSoon(this)
    return () => {
      if (!this.subs.delete(s)) return
      if (!this.wantsLinks()) this.topics.dropLinks(this)
      if (!this.subs.size) this.topics.rewatch()
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

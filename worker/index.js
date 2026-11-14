// CORVAX anchor on Cloudflare Workers. Same HTTP protocol as a native anchor, minus what needs UDP or WebRTC
// (DHT routing, STUN, LAN, cx_check). Relays only over WebSocket, as a rate-limited last resort. Beacons are kept here and mirrored to the Mainline DHT
// through a pkarr relay. Key: secret CORVAX_SEED (hex), or generated once and kept in Durable Object storage.
import { DurableObject } from 'cloudflare:workers'
import { identity, hiOk, random, sha1, verify } from '../src/crypto.js'
import { encode, decode } from '../src/bencode.js'
import { TopicStore, serve } from '../src/store.js'
import { Inboxes } from '../src/inbox.js'
import { MAX_MESSAGE } from '../src/message.js'
import { Book, formatLine } from '../src/book.js'
import { homepage, stats } from '../src/home.js'
import { pack, unpack, verifyBeacon } from '../src/record.js'
import { serveSocket } from '../src/relay.js'
import { hex, unhex, utf8, str, z32, unz32, equal, readCapped } from '../src/bytes.js'
import favicon from '../assets/logo/favicon.ico'
import og from '../assets/logo/corvax-256.png'

const RELAY = 'https://relay.pkarr.org', CORS = { 'access-control-allow-origin': '*' }
// WebSocket relaying is a last resort here: few, slow sessions and a small hourly budget.
const RELAYING = { sessions: 4, kbps: 256, hourBytes: 200e6, socketsPerIp: 2, opensPerIpMinute: 6 }
const POLLS_PER_IP = 64, BODY_MAX = 24576
const COST = { put: 6, cx_tpub: 2, cx_send: 1, cx_tfind: 1, get: 1 }

export default {
  async fetch (req, env) {
    const { pathname } = new URL(req.url)
    if (req.method === 'GET' && /^\/cx\/[a-z]+\.js$/.test(pathname)) {
      const r = await env.ASSETS.fetch(new URL(pathname.slice(3), req.url))
      return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...CORS } })
    }
    const year = 'public, max-age=31536000, immutable'
    if (pathname === '/favicon.ico') return new Response(favicon, { headers: { 'content-type': 'image/x-icon', 'cache-control': year } })
    if (pathname === '/og.png') return new Response(og, { headers: { 'content-type': 'image/png', 'cache-control': year } })
    return env.ANCHOR.get(env.ANCHOR.idFromName('anchor')).fetch(req)
  }
}

export class Anchor extends DurableObject {
  constructor (ctx, env) {
    super(ctx, env)
    Object.assign(this, { inboxes: new Inboxes(), store: new TopicStore(), book: new Book(), beacons: new Map(), buckets: new Map(), replays: new Map(), polls: new Map(), started: Date.now(), swept: 0 })
    this.relayHost = { relayFor: true, bridges: new Map(), channels: new Map(), limits: RELAYING }
    this.sockets = new Map()                                     // ip -> { open, opens: [times] }
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const seed = env.CORVAX_SEED || await ctx.storage.get('seed') || hex(random(32))
      await ctx.storage.put('seed', seed)
      this.id = await identity(unhex(seed))
      this.key = this.relayHost.address = z32(this.id.pub)
      this.book.add(await ctx.storage.get('book') || '')
      // Topic records outlive eviction: every accepted record (and tombstone) is kept in SQLite until it lapses.
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS topics (t TEXT, k TEXT, raw BLOB, exp INTEGER, PRIMARY KEY (t, k))')
      await this.store.load(ctx.storage.sql.exec('SELECT raw FROM topics').toArray().map(r => new Uint8Array(r.raw)))
    })
  }
  line (origin) { const u = new URL(origin); return formatLine({ key: this.key, host: u.hostname, port: +(u.port || 443), web: origin }) }
  listing (origin) { return [this.line(origin), ...this.book.shared('browser').split('\n').filter(Boolean)].join('\n') }

  async fetch (req) {
    await this.ready
    const url = new URL(req.url), origin = url.origin, ip = req.headers.get('cf-connecting-ip') || 'local'
    if (Date.now() - this.swept > 30e3) { this.swept = Date.now(); this.store.sweep(); this.inboxes.sweep(); this.ctx.storage.sql.exec('DELETE FROM topics WHERE exp < ?', Date.now() - 2 * (this.store.lease + this.store.skew)) }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } })
    if (req.method === 'POST' && url.pathname === '/krpc') return this.krpc(req, origin, ip)
    if (url.pathname === '/relay' && req.headers.get('upgrade') === 'websocket') return this.relay(ip)
    if (req.method !== 'GET' || url.pathname !== '/') return new Response(null, { status: 404, headers: CORS })
    const headers = { ...CORS, vary: 'accept', 'cache-control': 'public, max-age=30' }
    if (!/text\/html/.test(req.headers.get('accept') || '')) return new Response(this.listing(origin) + '\n', { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } })
    const html = homepage({ origin, line: this.line(origin), anchor: true, services: ['https', 'storage'], uptime: Date.now() - this.started, anchors: this.listing(origin), stats: stats(this, { inboxes: this.inboxes, store: this.store, bridges: this.relayHost.bridges, extra: { beacons: this.beacons.size } }) })
    return new Response(html, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
  }

  async krpc (req, origin, ip) {
    const reply = m => new Response(encode(m), { headers: { ...CORS, 'content-type': 'text/plain' } })
    const body = await readCapped(req, BODY_MAX)
    let m
    try { m = decode(body) } catch { return reply({ y: 'e', e: [203, 'bad message'] }) }
    if (!(m.q instanceof Uint8Array) || !m.a || !(m.t instanceof Uint8Array) || m.t.length > 8) return reply({ y: 'e', e: [203, 'bad query'] })
    const q = str(m.q), key = `${ip}|${hex(m.t)}`
    const hit = this.replays.get(key)
    if (hit && Date.now() - hit.t < 60e3) return reply(hit.m)
    if (!this.allow(ip, q)) return reply({ t: m.t, y: 'e', e: [202, 'rate limited'] })
    let out
    const poll = q === 'cx_listen' || q === 'cx_twatch'
    if (poll && (this.polls.get(ip) || 0) >= POLLS_PER_IP) return reply({ t: m.t, y: 'e', e: [202, 'too many polls'] })
    if (poll) this.polls.set(ip, (this.polls.get(ip) || 0) + 1)
    try { out = { t: m.t, y: 'r', r: await this.answer(q, m.a, origin, req.signal) } } catch (e) {
      const [code, msg] = Array.isArray(e) ? e : [201, e.message || 'error']
      out = { t: m.t, y: 'e', e: [code, msg] }
    } finally { if (poll) { const n = this.polls.get(ip) - 1; n ? this.polls.set(ip, n) : this.polls.delete(ip) } }
    if (!poll) {
      this.replays.set(key, { m: out, t: Date.now() })
      if (this.replays.size > 5000) for (const [k, v] of this.replays) if (Date.now() - v.t > 60e3) this.replays.delete(k)
    }
    return reply(out)
  }

  allow (ip, q) {
    const now = Date.now(), b = this.buckets.get(ip) || { tokens: 120, t: now }
    b.tokens = Math.min(120, b.tokens + (now - b.t) / 250); b.t = now
    this.buckets.set(ip, b)
    if (this.buckets.size > 10000) this.buckets.delete(this.buckets.keys().next().value)
    const cost = COST[q] ?? 0.5
    return b.tokens >= cost && (b.tokens -= cost, true)
  }

  async answer (q, a, origin, signal) {
    if (q === 'ping') return {}
    if (['cx_hi', 'cx_tpub', 'cx_tfind'].includes(q)) return serve({ id: this.id, store: this.store, line: this.line(origin), relay: true, stored: raw => this.persist(raw) }, q, a)
    if (q === 'cx_anchors') { if (a.me instanceof Uint8Array && a.me.length <= 255) this.ctx.waitUntil(this.learn(str(a.me))); return { a: this.listing(origin) } }
    if (q === 'cx_send') {
      if (!(a.to instanceof Uint8Array) || a.to.length !== 32 || !(a.msg instanceof Uint8Array) || a.msg.length > MAX_MESSAGE) throw [203, 'bad message']
      await this.inboxes.put(a.to, a.msg)
      return { queued: 1 }
    }
    if (q === 'cx_listen') {
      if (!(a.k instanceof Uint8Array) || a.k.length !== 32 || typeof a.ts !== 'number' || Math.abs(Date.now() - a.ts) > 300e3) throw [203, 'bad listen']
      const after = typeof a.after === 'number' ? a.after : 0
      // v 2 binds the poll to this anchor and to its ack; the old form stays for older clients
      if (!await verify(a.k, a.sig, utf8(a.v === 2 ? `cx-listen:${a.ts}:${after}:${this.key}` : `cx-listen:${a.ts}`))) throw [206, 'bad signature']
      return { msgs: await this.inboxes.listen(a.k, after, signal) }
    }
    if (q === 'cx_twatch') {
      const t = Array.isArray(a.t) ? a.t.filter(b => b instanceof Uint8Array && b.length === 32).slice(0, 64) : []
      if (!t.length) throw [203, 'no topics']
      const r = await this.store.watch(t, a.c instanceof Uint8Array ? str(a.c) : undefined, signal)
      return { c: r.c, r: r.r, now: Date.now(), ...(r.snap && { snap: 1 }) }
    }
    if (q === 'put') {
      const rec = { pub: a.k, seq: a.seq, sig: a.sig, v: a.v }
      if (!(a.k instanceof Uint8Array) || a.k.length !== 32 || !(a.v instanceof Uint8Array) || !await verifyBeacon(rec)) throw [206, 'bad signature']
      const old = this.beacons.get(z32(a.k))
      if (old && old.seq > a.seq) throw [302, 'sequence number less than current']
      this.keep(rec)
      this.ctx.waitUntil(fetch(`${RELAY}/${z32(a.k)}`, { method: 'PUT', body: pack(rec) }).catch(() => {}))   // → Mainline
      return {}
    }
    if (q === 'get') {
      if (!(a.k instanceof Uint8Array) || a.k.length !== 32 || !(a.target instanceof Uint8Array) || !equal(await sha1(a.k), a.target)) return {}   // needs k (SPEC §3)
      let rec = this.beacons.get(z32(a.k))
      if (!rec || Date.now() - rec.at > 2 * 3600e3) {
        const r = await fetch(`${RELAY}/${z32(a.k)}`).catch(() => null)
        const raw = r?.ok && await readCapped(r, 2048), got = raw && unpack(a.k, raw)
        if (got && await verifyBeacon(got) && (!rec || got.seq >= rec.seq)) rec = this.keep(got)
      }
      return rec ? { k: rec.pub, seq: rec.seq, sig: rec.sig, v: rec.v } : {}
    }
    if (q === 'get_peers') return { values: [] }
    throw [204, 'not available on this anchor']
  }

  relay (ip) {
    const s = this.sockets.get(ip) || { open: 0, opens: [] }, now = Date.now()
    s.opens = s.opens.filter(t => now - t < 60e3)
    if (s.open >= RELAYING.socketsPerIp || s.opens.length >= RELAYING.opensPerIpMinute) return new Response('relay busy', { status: 429, headers: CORS })
    s.open++; s.opens.push(now); this.sockets.set(ip, s)
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    const ws = { send: d => server.send(d), close: () => server.close(), onmessage () {}, onclose () {} }
    serveSocket(this.relayHost, ws)
    server.addEventListener('message', e => ws.onmessage(e.data))
    server.addEventListener('close', () => { s.open--; ws.onclose() })
    return new Response(null, { status: 101, webSocket: client })
  }

  persist (raw) {
    const r = decode(raw)
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO topics VALUES (?, ?, ?, ?)', hex(r.t), hex(r.k), raw.slice().buffer, r.exp)
  }

  keep (rec) {
    this.beacons.delete(z32(rec.pub))
    this.beacons.set(z32(rec.pub), { ...rec, at: Date.now() })
    if (this.beacons.size > 10000) this.beacons.delete(this.beacons.keys().next().value)
    return rec
  }

  // An anchor introduced itself: verify it over HTTPS before listing it.
  async learn (text) {
    for (const e of this.book.add(text)) {
      const n = random(16), url = e.web
      if (!url) continue
      const r = await fetch(`${url}/krpc`, { method: 'POST', body: encode({ t: random(4), y: 'q', q: 'cx_hi', a: { n } }), signal: AbortSignal.timeout(5000) })
        .then(async res => decode(await readCapped(res, BODY_MAX)).r).catch(() => null)
      this.book.record(e.key, 'id', await hiOk(r, unz32(e.key), n))
      if (this.book.get(e.key)) this.book.record(e.key, 'http', !!r)
    }
    await this.ctx.storage.put('book', this.book.toText())
  }
}

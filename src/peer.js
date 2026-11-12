// The Peer: one identity that bootstraps from the anchor book, announces itself (Beacon),
// resolves others, exchanges signed+encrypted messages through anchors' inboxes, and opens
// DataChannels (direct, or relayed by a third peer). Uses only fetch + WebCrypto + WebRTC,
// so the same file runs in browsers, Node, Bun and Deno.
import { identity, supported, sign, verify, sha1 } from './crypto.js'
import { seal, open, MAX_AGE } from './message.js'
import { makeBeacon, verifyBeacon, fields } from './record.js'
import { encode, decode } from './bencode.js'
import { Book, parseLine, formatLine } from './book.js'
import { b64, unb64, hex, unhex, utf8, str, z32, unz32, random, concat, equal } from './bytes.js'
import * as rtc from './rtc.js'
import * as relay from './relay.js'
import baked from './anchors.js'
import { Topics } from './topics.js'

export class CorvaxError extends Error {
  constructor (code, message) { super(message || code); this.code = code }
}

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const REPUBLISH = 30 * 60e3

export const hostUrl = e => `http://${e.host.includes(':') ? `[${e.host}]` : e.host}:${e.port}`

export class Peer {
  static async create (o = {}) {
    if (!await supported()) throw new CorvaxError('unsupported', 'this runtime lacks WebCrypto Ed25519/X25519')
    const p = new Peer()
    p.id = await identity(typeof o.seed === 'string' ? unhex(o.seed) : (o.seed || undefined))
    p.address = z32(p.id.pub)
    p.seed = hex(p.id.seed)
    p.book = o.book || new Book({ allowPrivate: o.allowPrivate })
    p.platform = { ...defaultPlatform(), ...o.platform }
    p.relay = o.relay ?? 'fallback'
    p.relayFor = o.relayFor ?? true
    p.limits = { ...(isBrowser ? { sessions: 2, kbps: 256 } : { sessions: 16, kbps: 2048 }), ...o.relayLimits }
    p.RTC = await pickRTC(o.RTCPeerConnection)
    p.self = o.self || null                  // { key, line, url } when this peer is itself an anchor
    p.handlers = new Set()
    p.acceptors = new Set()
    p.seen = new Map()                       // message id -> time (replay protection)
    p.beacons = new Map()                    // address -> { beacon, t }
    p.conns = new Map()                      // address -> open direct connection { pc, app, ctl }
    p.sessions = new Map()                   // sid -> WebRTC negotiation state
    p.bridges = new Map()                    // sid -> sessions we relay for others
    p.channels = new Map()                   // sid -> relayed channels we are an end of
    p.blockDirect = new Set()                // test hook: pretend direct ICE fails to these addresses
    p.inboxes = []
    p.abort = new AbortController()
    p.now = o.now || (() => Date.now())          // injectable clock (tests)
    p.topics = new Topics(p, o.topicLimits)
    await p.bootstrap(o)
    for (const ib of p.inboxes) p.#poll(ib)
    return p
  }

  // ---- anchor book ---------------------------------------------------------------------------
  async bootstrap (o = {}) {
    for (const t of [baked, await this.platform.loadCache?.() || '', ...(o.anchors || [])]) this.book.add(t)
    if (this.self) { this.book.add(this.self.line); this.book.record(this.self.key, 'id', true) }
    const sources = [...(o.sources || [])]
    const home = typeof location !== 'undefined' && /^https?:/.test(import.meta.url) ? new URL('/', import.meta.url).href : null
    if (home) sources.push(home)            // the anchor that served this library is a source
    await Promise.allSettled([
      ...sources.map(u => this.platform.fetchText(u).then(t => this.book.add(t))),
      ...(o.dohDomains || []).map(d => this.platform.dnsTxt(`_corvax-anchors.${d}`).then(t => this.book.add(t))),
      this.platform.discover?.().then(t => this.book.add(t || '', { lan: true }))
    ])
    await this.verify(12)
    this.inboxes = this.#chooseInboxes()
    await this.refresh()
    this.refresher = setInterval(() => this.refresh().catch(() => {}), 10 * 60e3)
    this.refresher.unref?.()
  }

  // Pull anchor lists from our anchors and verify what is new, so every peer converges on the same
  // set of anchors and storage nodes (topic records go to the closest ones in *our* book).
  async refresh () {
    await Promise.allSettled(this.inboxes.map(ib => this.rpc(ib.url, 'cx_anchors', {}).then(r => this.book.add(str(r.a)))))
    await this.verify(16)
    this.platform.saveCache?.(this.book.toText())
  }

  // Probe entries: does the anchor answer, and does it hold the key in its line?
  async verify (n = 16) {
    const due = this.book.due(n).filter(e => this.urlOf(e))
    if (this.platform.probe) return this.platform.probe(due)
    await Promise.allSettled(due.map(e => this.hi(e)))
  }
  async hi (e) {
    const n = random(16), t0 = Date.now()
    let r
    try { r = await this.rpc(this.urlOf(e), 'cx_hi', { n }, { timeout: 5000, retries: 0 }) } catch { return this.book.record(e.key, 'http', false) }
    const ok = r.k instanceof Uint8Array && equal(r.k, unz32(e.key)) && await verify(r.k, r.sig, concat(utf8('cx-hi'), n))
    this.book.record(e.key, 'id', ok)
    if (ok) { this.book.get(e.key).storage = !!r.st; this.book.record(e.key, 'http', true, Date.now() - t0) }
    return ok
  }
  anchors () { return this.book.shared(isBrowser ? 'browser' : 'native') }
  addAnchors (text) { return this.book.add(text).length }

  // Where to reach an anchor over HTTP from here (browsers on https pages need an https origin).
  urlOf (e) {
    if (this.self && e.key === this.self.key) return this.self.url
    if (isBrowser && typeof location !== 'undefined' && location.protocol === 'https:') return e.web?.startsWith('https:') ? e.web : null
    return e.web || hostUrl(e)
  }
  #chooseInboxes () {
    if (this.self) return [{ entry: this.book.get(this.self.key), url: this.self.url }]
    return this.book.best(2, isBrowser ? 'browser' : 'native', e => e.verified && this.urlOf(e))
      .map(entry => ({ entry, url: this.urlOf(entry) }))
  }
  iceServers () {
    return this.book.best(2, 'native', e => e.verified)
      .map(e => ({ urls: `stun:${e.host.includes(':') ? `[${e.host}]` : e.host}:${e.port}` }))
  }

  // ---- KRPC over HTTP --------------------------------------------------------------------------
  async rpc (url, q, a = {}, { timeout = 8000, retries = 2, signal: extra } = {}) {
    if (!url) throw new CorvaxError('no-anchor', 'no reachable anchor')
    const body = encode({ t: random(4), y: 'q', q, a, ro: 1 })       // same t on retries → executed once
    for (let i = 0; ; i++) {
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(timeout), this.abort.signal, ...(extra ? [extra] : [])])
        const res = await fetch(url.replace(/\/$/, '') + '/krpc', { method: 'POST', headers: { 'content-type': 'text/plain' }, body, signal })
        const m = decode(new Uint8Array(await res.arrayBuffer()))
        if (m.y && str(m.y) === 'r') return m.r
        const [code, msg] = Array.isArray(m.e) ? m.e : [0, 'bad reply']
        throw Object.assign(new CorvaxError('remote', `${q}: ${code} ${str(msg instanceof Uint8Array ? msg : utf8(String(msg)))}`), { remote: true })
      } catch (e) {
        if (e.remote || this.abort.signal.aborted || extra?.aborted || i >= retries) throw e
        await sleep(300 * 2 ** i)
      }
    }
  }

  // ---- Beacon ------------------------------------------------------------------------------------
  async publish (extra = {}) {
    if (!this.inboxes.length) throw new CorvaxError('no-anchor', 'no verified anchor to publish through')
    const rec = await makeBeacon(this.id, { ...extra, c: this.inboxes.map(ib => formatLine(ib.entry)) })
    const targets = [...this.inboxes.map(ib => ib.url), ...this.book.best(2, 'native', e => e.verified).map(e => this.urlOf(e))]
    const ok = await Promise.allSettled([...new Set(targets.filter(Boolean))].map(u =>
      this.rpc(u, 'put', { k: rec.pub, seq: rec.seq, sig: rec.sig, v: rec.v })))
    if (!ok.some(r => r.status === 'fulfilled')) throw new CorvaxError('no-anchor', 'no anchor accepted the beacon')
    clearTimeout(this.republish)
    this.republish = setTimeout(() => this.publish(extra).catch(() => {}), REPUBLISH)
    this.republish.unref?.()
    return rec
  }

  async resolve (address, { fresh = false } = {}) {
    const cached = this.beacons.get(address)
    if (cached && !fresh && Date.now() - cached.t < 30e3) return cached.beacon
    const pub = unz32(address), target = await sha1(pub)
    const urls = [...new Set([...this.inboxes.map(ib => ib.url), ...this.book.best(3, 'native', e => e.verified).map(e => this.urlOf(e))].filter(Boolean))].slice(0, 3)
    let best = null
    await Promise.allSettled(urls.map(async u => {
      const r = await this.rpc(u, 'get', { target })
      if (!r.v || !(r.k instanceof Uint8Array) || !equal(r.k, pub)) return
      const rec = { pub, seq: r.seq, sig: r.sig, v: r.v }
      if ((!best || rec.seq > best.seq) && await verifyBeacon(rec)) best = rec
    }))
    if (!best) return null
    const f = fields(best)
    const beacon = { address, seq: best.seq, x: f.x?.[0] && unb64(f.x[0]), c: f.c || [], fields: f }
    for (const line of beacon.c) this.book.add(line)
    this.beacons.set(address, { beacon, t: Date.now() })
    return beacon
  }

  // ---- messages ----------------------------------------------------------------------------------
  async signal (address, body, beacon) {
    beacon ??= await this.resolve(address)
    if (!beacon?.x) throw new CorvaxError('not-found', `no record for ${address}`)
    const to = unz32(address), msg = await seal(this.id, to, beacon.x, body)
    let last = 'no usable anchor line'
    for (const line of beacon.c) {
      const e = parseLine(line), url = e && this.urlOf(e)
      if (!url) continue
      try { await this.rpc(url, 'cx_send', { to, msg }); return true } catch (err) { last = err.message }
    }
    throw new CorvaxError('no-anchor', `no inbox of ${address} is reachable (${last})`)
  }
  send (address, body) { return this.signal(address, { app: body }) }
  on (fn) { this.handlers.add(fn); return () => this.handlers.delete(fn) }

  async #onWire (wire) {
    let m
    try { m = await open(this.id, wire) } catch { return }
    if (this.seen.has(m.id)) return
    const now = Date.now()
    this.seen.set(m.id, now)
    if (this.seen.size > 5000) for (const [k, t] of this.seen) if (now - t > MAX_AGE) this.seen.delete(k)
    const from = z32(m.from), body = m.body
    if (body?.cx) {
      if (body.cx.startsWith('via')) return relay.onSignal(this, from, body).catch(() => {})
      return rtc.onSignal(this, from, body).catch(() => {})
    }
    if ('app' in (body || {})) for (const fn of this.handlers) fn({ from, body: body.app })
  }

  async #poll (ib) {
    let after = 0, fails = 0
    while (!this.abort.signal.aborted) {
      try {
        const ts = Date.now(), sig = await sign(this.id, utf8(`cx-listen:${ts}`))
        const r = await this.rpc(ib.url, 'cx_listen', { k: this.id.pub, ts, sig, after }, { timeout: 35000, retries: 0 })
        fails = 0
        for (const m of r.msgs || []) { after = Math.max(after, m.seq); this.#onWire(m.msg) }
      } catch {
        if (this.abort.signal.aborted) return
        await sleep(Math.min(30e3, 500 * 2 ** ++fails))
      }
    }
  }

  // ---- connections -------------------------------------------------------------------------------
  accept (fn) { this.acceptors.add(fn); return () => this.acceptors.delete(fn) }

  // purpose 'topic' (with tp = topic id hex) is used by topic neighbours; apps use the default.
  async connect (address, { relay: mode = this.relay, timeout = 10000, purpose = 'app', tp } = {}) {
    try {
      return await rtc.direct(this, address, { timeout, purpose, tp })
    } catch (e) {
      if (mode !== 'fallback' || !['ice-failed', 'no-answer'].includes(e.code)) throw e
    }
    return relay.via(this, address, { timeout: timeout * 3, purpose, tp })
  }

  // Topics: presence and best-effort broadcast (see PLAN.md §8–9)
  topic (name) { return this.topics.topic(name) }

  async close () {
    await this.topics.close()                // unpublishes (tombstones) before the network goes away
    clearInterval(this.refresher)
    this.abort.abort()
    clearTimeout(this.republish)
    for (const c of this.conns.values()) try { c.pc.close() } catch {}
    for (const s of this.sessions.values()) try { s.pc?.close() } catch {}
    this.conns.clear(); this.sessions.clear()
  }
}

async function pickRTC (given) {
  if (given) return given
  if (globalThis.RTCPeerConnection) return globalThis.RTCPeerConnection
  try { const name = 'werift'; return (await import(name)).RTCPeerConnection } catch { return null }
}

export function defaultPlatform () {
  const ls = (() => { try { return globalThis.localStorage } catch { return null } })()
  return {
    loadCache: () => { try { return ls?.getItem('corvax.anchors') || '' } catch { return '' } },
    saveCache: t => { try { ls?.setItem('corvax.anchors', t) } catch {} },
    fetchText: async u => (await fetch(u, { signal: AbortSignal.timeout(8000) })).text(),
    // DNS TXT through public DNS-over-HTTPS (JSON API); works in browsers and every runtime
    dnsTxt: async name => {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
        { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) })
      const j = await r.json()
      return (j.Answer || []).map(a => String(a.data).replace(/"\s*"/g, '').replace(/^"|"$/g, '')).join('\n')
    }
  }
}

// Peer services for native runtimes: the cx_* query handlers, inboxes, topic storage and the HTTP server.
// Every native peer runs the same code; being publicly reachable (an anchor) only decides who can use it.
//   HTTP  GET /  homepage + anchor list · POST /krpc · GET /cx/*.js (library, app.js) · GET /favicon.ico
// Anchors are trusted with nothing: records are signed and messages end-to-end encrypted.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { encode, decode } from './bencode.js'
import { sign, verify, sha256, random } from './crypto.js'
import { verifyBeacon } from './record.js'
import { hex, utf8, str, concat, equal, z32 } from './bytes.js'
import { homepage } from './home.js'

const INBOX_TTL = 120e3, INBOX_MAX = 64, POLL_MAX = 25e3, BODY_MAX = 8192
const COST = { put: 6, cx_check: 12, cx_tpub: 2, cx_send: 1, cx_tfind: 1, cx_listen: 0.5, cx_twatch: 0.5, get: 1, get_peers: 1 }
const ids = (x, max) => Array.isArray(x) ? x.filter(b => b instanceof Uint8Array && b.length === 32).slice(0, max) : []
const srcDir = new URL('./', import.meta.url), logoDir = new URL('../assets/logo/', import.meta.url)

// ---- inboxes: short-lived queues of sealed messages, drained by long polls ---------------------
export class Inboxes {
  constructor () { this.boxes = new Map() }
  #box (k) {
    const id = hex(k)
    if (!this.boxes.has(id)) this.boxes.set(id, { seq: 0, msgs: [], waiter: null })
    const box = this.boxes.get(id), now = Date.now()
    box.msgs = box.msgs.filter(m => now - m.t < INBOX_TTL)
    return box
  }
  async put (to, msg) {
    const box = this.#box(to), h = hex(await sha256(msg))
    if (!box.msgs.some(m => m.h === h)) {                              // retries are idempotent
      box.msgs.push({ seq: ++box.seq, msg, h, t: Date.now() })
      if (box.msgs.length > INBOX_MAX) box.msgs.shift()
    }
    box.waiter?.(); box.waiter = null
  }
  async listen (k, after, signal) {
    const box = this.#box(k)
    box.msgs = box.msgs.filter(m => m.seq > after)                      // acknowledged → deleted
    if (!box.msgs.length && !signal?.aborted) {
      box.waiter?.()                                                    // a newer poll ends the older one
      await new Promise(resolve => {
        const timer = setTimeout(done, POLL_MAX)
        function done () { clearTimeout(timer); signal?.removeEventListener('abort', done); if (box.waiter === done) box.waiter = null; resolve() }
        box.waiter = done
        signal?.addEventListener('abort', done)
      })
    }
    return box.msgs.map(m => ({ seq: m.seq, msg: m.msg }))
  }
  close () { for (const box of this.boxes.values()) box.waiter?.() }
  sweep () {
    const now = Date.now()
    for (const [id, box] of this.boxes) {
      box.msgs = box.msgs.filter(m => now - m.t < INBOX_TTL)
      if (!box.msgs.length && !box.waiter) this.boxes.delete(id)
    }
  }
}

// ---- query handlers (UDP and HTTP) ------------------------------------------------------------
export function installHandlers (node) {
  const h = node.dht.handlers
  h.cx_hi = async a => {
    if (!(a.n instanceof Uint8Array) || a.n.length > 64) throw [203, 'bad nonce']
    return { k: node.id.pub, sig: await sign(node.id, concat(utf8('cx-hi'), a.n)), ...(node.line() && { line: node.line() }), ...(node.storing() && { st: 1 }) }
  }
  h.cx_anchors = async (a, from) => {
    if (a.me instanceof Uint8Array && a.me.length <= 255) node.book.add(str(a.me))
    return { a: node.listing() }
  }
  // "Can strangers reach me?" The check is done by a different anchor when we know one.
  h.cx_check = async (a, from) => {
    if (!(a.k instanceof Uint8Array) || a.k.length !== 32) throw [203, 'bad key']
    const port = a.port || from.port, hport = a.hport || 0
    for (const e of node.book.best(6, 'native', e => e.verified && e.key !== node.key && e.key !== z32(a.k))) {
      const r = await node.dht.query({ host: e.host, port: e.port }, 'cx_probe', { ip: utf8(from.host), port, hport, k: a.k })
      if (r) return { udp: r.udp ? 1 : 0, http: r.http ? 1 : 0, ip: utf8(from.host), by: utf8(e.key) }
    }
    const r = await probe(node, from.host, port, hport, a.k)
    return { ...r, ip: utf8(from.host), by: utf8('self') }
  }
  h.cx_probe = async (a, from) => {
    if (!node.book.best(1000, 'native', e => e.verified && e.host === from.host).length) throw [201, 'only for known anchors']
    return probe(node, str(a.ip), a.port, a.hport, a.k)
  }
  // Topic storage (only while this node is a reachable storage peer)
  const storage = () => { if (!node.storing()) throw [204, 'storage disabled on this peer']; return node.store }
  h.cx_tpub = async a => {
    const st = storage(), recs = Array.isArray(a.r) ? a.r.filter(r => r instanceof Uint8Array && r.length <= 512).slice(0, 32) : []
    const ok = []
    for (const r of recs) ok.push(utf8(await st.put(r)))
    return { ok, now: Date.now() }
  }
  h.cx_tfind = async a => ({ r: storage().find(ids(a.t, 16)), now: Date.now() })
  h.cx_send = async a => {
    if (!(a.to instanceof Uint8Array) || a.to.length !== 32 || !(a.msg instanceof Uint8Array) || a.msg.length > 4096) throw [203, 'bad message']
    await node.inboxes.put(a.to, a.msg)
    return { queued: 1 }
  }
}

async function probe (node, ip, port, hport, k) {
  const out = { udp: 0, http: 0 }
  const checkHi = async (r, n) => r && r.k instanceof Uint8Array && equal(r.k, k) && verify(r.k, r.sig, concat(utf8('cx-hi'), n))
  if (port) {
    const n = random(16)
    out.udp = await checkHi(await node.dht.query({ host: ip, port }, 'cx_hi', { n }), n) ? 1 : 0
  }
  if (hport) {
    const n = random(16)
    try {
      const host = ip.includes(':') ? `[${ip}]` : ip
      const res = await fetch(`http://${host}:${hport}/krpc`, { method: 'POST', body: encode({ t: random(4), y: 'q', q: 'cx_hi', a: { n } }), signal: AbortSignal.timeout(4000) })
      out.http = await checkHi(decode(new Uint8Array(await res.arrayBuffer())).r, n) ? 1 : 0
    } catch {}
  }
  return out
}

// ---- HTTP -------------------------------------------------------------------------------------
export function httpServer (node) {
  const buckets = new Map(), replays = new Map()
  const { burst, perSecond, polls: maxPolls } = { burst: 120, perSecond: 4, polls: 64, ...node.o?.rate }
  const allow = (ip, q) => {
    const now = Date.now(), b = buckets.get(ip) || { tokens: burst, t: now }
    b.tokens = Math.min(burst, b.tokens + (now - b.t) / 1000 * perSecond); b.t = now
    buckets.set(ip, b)
    if (buckets.size > 10000) buckets.delete(buckets.keys().next().value)
    const cost = COST[q] ?? 0.5
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }
  const polls = new Map()   // ip -> open long polls

  async function krpc (req, res, ip, port) {
    const body = await readBody(req)
    let m
    try { m = decode(body) } catch { return reply(res, { y: 'e', e: [203, 'bad message'] }) }
    if (!(m.q instanceof Uint8Array) || !m.a || !(m.t instanceof Uint8Array) || m.t.length > 8) return reply(res, { y: 'e', e: [203, 'bad query'] })
    const q = str(m.q), a = m.a, key = `${ip}|${hex(m.t)}`
    if (replays.has(key)) return res.end(replays.get(key).bytes)
    if (!allow(ip, q)) return reply(res, { t: m.t, y: 'e', e: [202, 'rate limited'] })
    const from = { host: ip, port, http: true }
    let out
    try { out = { t: m.t, y: 'r', r: { id: node.dht.id, ...await answer(q, a, from, res) } } } catch (e) {
      const [code, msg] = Array.isArray(e) ? e : [201, e.message || 'error']
      out = { t: m.t, y: 'e', e: [code, msg] }
    }
    const bytes = encode(out)
    if (q !== 'cx_listen') {
      replays.set(key, { bytes, t: Date.now() })
      if (replays.size > 5000) for (const [k, v] of replays) if (Date.now() - v.t > 60e3) replays.delete(k)
    }
    res.end(bytes)
  }

  // Over HTTP, get/put/get_peers are recursive: the anchor does the DHT work for the client.
  async function answer (q, a, from, res) {
    if (q === 'get') {
      if (!(a.target instanceof Uint8Array) || a.target.length !== 20) throw [203, 'bad target']
      const item = await node.dht.get(a.target)
      return item ? { k: item.k, seq: item.seq, sig: item.sig, v: item.v } : {}
    }
    if (q === 'put') {
      const rec = { pub: a.k, seq: a.seq, sig: a.sig, v: a.v }
      if (!(a.k instanceof Uint8Array) || a.k.length !== 32 || !(a.v instanceof Uint8Array) || !await verifyBeacon(rec)) throw [206, 'bad signature']
      await node.dht.put({ k: a.k, seq: a.seq, sig: a.sig, v: a.v }).catch(e => { throw [302, e.message] })
      return {}
    }
    if (q === 'get_peers') {
      if (!(a.info_hash instanceof Uint8Array) || a.info_hash.length !== 20) throw [203, 'bad info_hash']
      return { values: (await node.dht.getPeers(a.info_hash)).filter(p => !p.host.includes(':')).slice(0, 50)
        .map(p => Uint8Array.of(...p.host.split('.').map(Number), p.port >> 8, p.port & 255)) }
    }
    if (q === 'cx_twatch') {
      if (!node.storing()) throw [204, 'storage disabled on this peer']
      const t = ids(a.t, 64)
      if (!t.length) throw [203, 'no topics']
      const open = polls.get(from.host) || 0
      if (open >= maxPolls) throw [202, 'too many polls']
      polls.set(from.host, open + 1)
      const ac = new AbortController()
      res.on('close', () => ac.abort())
      try {
        const r = await node.store.watch(t, a.c instanceof Uint8Array ? str(a.c) : undefined, ac.signal)
        return { c: r.c, r: r.r, now: Date.now(), ...(r.snap && { snap: 1 }) }
      } finally { polls.set(from.host, polls.get(from.host) - 1) }
    }
    if (q === 'cx_listen') {
      if (!(a.k instanceof Uint8Array) || a.k.length !== 32 || typeof a.ts !== 'number' || Math.abs(Date.now() - a.ts) > 300e3) throw [203, 'bad listen']
      if (!await verify(a.k, a.sig, utf8(`cx-listen:${a.ts}`))) throw [206, 'bad signature']
      const open = polls.get(from.host) || 0
      if (open >= maxPolls) throw [202, 'too many polls']
      polls.set(from.host, open + 1)
      const ac = new AbortController()
      res.on('close', () => ac.abort())                                 // the client went away
      try { return { msgs: await node.inboxes.listen(a.k, typeof a.after === 'number' ? a.after : 0, ac.signal) } } finally { polls.set(from.host, polls.get(from.host) - 1) }
    }
    return node.dht.answer(q, a, from)
  }

  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), port = req.socket.remotePort
    try {
      const path = new URL(req.url, 'http://x').pathname
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
      if (req.method === 'POST' && path === '/krpc') { res.setHeader('content-type', 'text/plain'); return await krpc(req, res, ip, port) }
      if (req.method !== 'GET') { res.statusCode = 405; return res.end() }
      if (path === '/') {
        res.setHeader('vary', 'accept')
        if (!/text\/html/.test(req.headers.accept || '')) {             // curl, wget, scripts, fetch(): plain anchor lines
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          return res.end(node.listing() + '\n')
        }
        res.setHeader('content-type', 'text/html; charset=utf-8')
        const origin = node.web || `http://${String(req.headers.host || `${node.host}:${node.port}`).replace(/[^\w.:[\]-]/g, '')}`
        return res.end(homepage({ origin, line: node.line() || `(not an anchor) ${node.key}`, anchor: !!node.line(), services: node.services(), uptime: Date.now() - node.started, anchors: node.listing() }))
      }
      if (path === '/favicon.ico') return send(res, new URL('favicon.ico', logoDir), 'image/x-icon', true)
      if (/^\/cx\/[a-z]+\.js$/.test(path)) return send(res, new URL(path.slice(4), srcDir), 'text/javascript; charset=utf-8')
      res.statusCode = 404; res.end()
    } catch { if (!res.headersSent) res.statusCode = 400; res.end() }
  })
  server.requestTimeout = 40e3
  return server
}

async function send (res, url, type, cache = false) {
  const data = await readFile(url)
  res.setHeader('content-type', type)
  if (cache) res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  res.end(data)
}
function readBody (req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0
    req.on('data', d => { n += d.length; if (n > BODY_MAX) { req.destroy(); reject(new Error('too large')) } else parts.push(d) })
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts)))).on('error', reject)
  })
}
function reply (res, m) { res.end(encode(m)) }

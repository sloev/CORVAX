// Peer services for native hosts: the cx_* query handlers, inboxes, topic storage and the HTTP handler. No I/O here:
// a host (SPEC §11) provides sockets and files, so the same code runs in Node, Bun, Deno, a desktop app or Android.
// Every native peer runs the same code; being publicly reachable (an anchor) only decides who can use it.
//   HTTP  GET /  homepage + anchor list · POST /krpc · GET /cx/*.js (library, app.js) · GET /favicon.ico, /og.png
// Anchors are trusted with nothing: records are signed and messages end-to-end encrypted.
import { encode, decode } from './bencode.js'
import { verify, random, hiOk } from './crypto.js'
import { verifyBeacon } from './record.js'
import { hex, utf8, str, z32 } from './bytes.js'
import { homepage, stats } from './home.js'
import { Inboxes } from './inbox.js'
import { MAX_MESSAGE } from './message.js'
export { Inboxes }
import { serve } from './store.js'
import { without } from './book.js'
import { serveSocket } from './relay.js'

const BODY_MAX = 24576                                // a 16 KB message plus its query
const COST = { put: 6, cx_check: 12, cx_tpub: 2, cx_send: 1, cx_tfind: 1, cx_listen: 0.5, cx_twatch: 0.5, get: 1, get_peers: 1 }
const ids = (x, max) => Array.isArray(x) ? x.filter(b => b instanceof Uint8Array && b.length === 32).slice(0, max) : []

export function installHandlers (node) {
  const h = node.dht.handlers
  const ctx = () => ({ id: node.id, store: node.store, line: node.line(), relay: !!node.peer?.relayFor, stored: raw => node.peer?.topics.local(raw).catch(() => {}) })
  for (const q of ['cx_hi', 'cx_tpub', 'cx_tfind']) h[q] = a => serve(ctx(), q, a)
  h.cx_anchors = async (a, from) => {
    if (a.me instanceof Uint8Array && a.me.length <= 255) node.book.add(str(a.me))
    return { a: without(node.listing(), a.have) }             // only the lines the asker lacks
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
  h.cx_send = async a => {
    if (!(a.to instanceof Uint8Array) || a.to.length !== 32 || !(a.msg instanceof Uint8Array) || a.msg.length > MAX_MESSAGE) throw [203, 'bad message']
    await node.inboxes.put(a.to, a.msg)
    return { queued: 1 }
  }
}

// One KRPC query over HTTP (used to probe peers that may not be our anchors).
export async function post (url, q, a, timeout = 4000) {
  const res = await fetch(`${url}/krpc`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: encode({ t: random(4), y: 'q', q, a }), signal: AbortSignal.timeout(timeout) })
  return decode(new Uint8Array(await res.arrayBuffer())).r
}

async function probe (node, ip, port, hport, k) {
  const n = random(16), url = `http://${ip.includes(':') ? `[${ip}]` : ip}:${hport}`
  const udp = port && await hiOk(await node.dht.query({ host: ip, port }, 'cx_hi', { n }), k, n)
  const http = hport && await post(url, 'cx_hi', { n }).then(r => hiOk(r, k, n), () => false)
  return { udp: udp ? 1 : 0, http: http ? 1 : 0 }
}

// The HTTP side of a node as one host-independent function (SPEC §11): req → res. Hosts (Node, desktop, Android)
// own the sockets and HTTP parsing; long polls end when req.signal aborts (the client went away).
//   req = { method, path, headers (lower-case), ip, port, body: max → Promise<Uint8Array | null>, signal }
//   res = { status, headers, body }
export function handler (node) {
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
  const bytes = body => ({ status: 200, headers: { 'content-type': 'text/plain' }, body }), reply = m => bytes(encode(m))

  async function krpc (req) {
    const body = await req.body(BODY_MAX)
    let m
    try { m = decode(body) } catch { return reply({ y: 'e', e: [203, 'bad message'] }) }
    if (!(m.q instanceof Uint8Array) || !m.a || !(m.t instanceof Uint8Array) || m.t.length > 8) return reply({ y: 'e', e: [203, 'bad query'] })
    const q = str(m.q), a = m.a, key = `${req.ip}|${hex(m.t)}`
    const hit = replays.get(key)
    if (hit && Date.now() - hit.t < 60e3) return bytes(hit.bytes)
    if (!allow(req.ip, q)) return reply({ t: m.t, y: 'e', e: [202, 'rate limited'] })
    const from = { host: req.ip, port: req.port, http: true }
    let out
    try { out = { t: m.t, y: 'r', r: { id: node.dht.id, ...await answer(q, a, from, req.signal) } } } catch (e) {
      const [code, msg] = Array.isArray(e) ? e : [201, e.message || 'error']
      out = { t: m.t, y: 'e', e: [code, msg] }
    }
    const wire = encode(out)
    if (q !== 'cx_listen' && q !== 'cx_twatch') {
      replays.set(key, { bytes: wire, t: Date.now() })
      if (replays.size > 5000) for (const [k, v] of replays) if (Date.now() - v.t > 60e3) replays.delete(k)
    }
    return bytes(wire)
  }
  // Long polls: at most `polls` open per IP, released however they end.
  async function poll (ip, fn) {
    const open = polls.get(ip) || 0
    if (open >= maxPolls) throw [202, 'too many polls']
    polls.set(ip, open + 1)
    try { return await fn() } finally { const n = polls.get(ip) - 1; n ? polls.set(ip, n) : polls.delete(ip) }
  }

  // Over HTTP, get/put/get_peers are recursive: the anchor does the DHT work for the client.
  async function answer (q, a, from, signal) {
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
      return poll(from.host, async () => {
        const r = await node.store.watch(t, a.c instanceof Uint8Array ? str(a.c) : undefined, signal, a.w * 1000)
        return { c: r.c, r: r.r, now: Date.now(), ...(r.snap && { snap: 1 }) }
      })
    }
    if (q === 'cx_listen') {
      if (!(a.k instanceof Uint8Array) || a.k.length !== 32 || typeof a.ts !== 'number' || Math.abs(Date.now() - a.ts) > 300e3) throw [203, 'bad listen']
      const after = typeof a.after === 'number' ? a.after : 0
      // v 2 binds the poll to this anchor and to its ack; the old form stays for older clients
      if (!await verify(a.k, a.sig, utf8(a.v === 2 ? `cx-listen:${a.ts}:${after}:${node.key}` : `cx-listen:${a.ts}`))) throw [206, 'bad signature']
      return poll(from.host, async () => ({ msgs: await node.inboxes.listen(a.k, after, signal, a.w * 1000) }))
    }
    return node.dht.answer(q, a, from)
  }

  const file = async (name, type, cache) => ({ status: 200, headers: { 'content-type': type, ...(cache && { 'cache-control': 'public, max-age=31536000, immutable' }) }, body: await node.io.asset(name) })
  return async req => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' }
    const out = await route(req).catch(() => ({ status: 400 }))
    return { ...out, headers: { ...cors, ...out.headers } }
  }
  async function route (req) {
    const { method, path } = req
    if (method === 'OPTIONS') return { status: 204 }
    if (method === 'POST' && path === '/krpc') return krpc(req)
    if (method !== 'GET') return { status: 405 }
    if (path === '/') {
      const headers = { vary: 'accept', 'cache-control': 'public, max-age=30' }
      if (!/text\/html/.test(req.headers.accept || '')) return { status: 200, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }, body: node.listing() + '\n' }   // curl, scripts, fetch()
      const origin = node.web || `http://${String(req.headers.host || `${node.host}:${node.port}`).replace(/[^\w.:[\]-]/g, '')}`
      return { status: 200, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' }, body: homepage({ origin, line: node.line() || `(not an anchor) ${node.key}`, anchor: !!node.line(), services: node.services(), uptime: Date.now() - node.started, anchors: node.listing(), stats: stats(node, { inboxes: node.inboxes, store: node.store, bridges: node.peer?.bridges, extra: { dht: node.dht.nodes.size } }) }) }
    }
    if (path === '/favicon.ico') return file('assets/logo/favicon.ico', 'image/x-icon', true)
    if (path === '/og.png') return file('assets/logo/corvax-256.png', 'image/png', true)
    if (/^\/cx\/[a-z]+\.js$/.test(path)) return file('src/' + path.slice(4), 'text/javascript; charset=utf-8')
    return { status: 404 }
  }
}

// WebSocket upgrades: the host has done the RFC 6455 handshake and hands over { send, close, onmessage, onclose }.
export function socket (node, path, ws) {
  if (path !== '/relay' || !node.peer?.relayFor) return ws.close()
  serveSocket(node.peer, ws)
}

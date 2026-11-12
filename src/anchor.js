// Peer services for native runtimes: the cx_* query handlers, inboxes, topic storage and the HTTP server.
// Every native peer runs the same code; being publicly reachable (an anchor) only decides who can use it.
//   HTTP  GET /  homepage + anchor list · POST /krpc · GET /cx/*.js (library, app.js) · GET /favicon.ico
// Anchors are trusted with nothing: records are signed and messages end-to-end encrypted.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { encode, decode } from './bencode.js'
import { verify, random, hiOk } from './crypto.js'
import { verifyBeacon } from './record.js'
import { hex, utf8, str, z32 } from './bytes.js'
import { homepage, stats } from './home.js'
import { Inboxes } from './inbox.js'
export { Inboxes }
import { serve } from './store.js'
import { serveSocket } from './relay.js'
import { createHash } from 'node:crypto'

const BODY_MAX = 8192
const COST = { put: 6, cx_check: 12, cx_tpub: 2, cx_send: 1, cx_tfind: 1, cx_listen: 0.5, cx_twatch: 0.5, get: 1, get_peers: 1 }
const ids = (x, max) => Array.isArray(x) ? x.filter(b => b instanceof Uint8Array && b.length === 32).slice(0, max) : []
const srcDir = new URL('./', import.meta.url), logoDir = new URL('../assets/logo/', import.meta.url)

export function installHandlers (node) {
  const h = node.dht.handlers
  const ctx = () => ({ id: node.id, store: node.store, line: node.line(), relay: !!node.peer?.relayFor, stored: raw => node.peer?.topics.local(raw).catch(() => {}) })
  for (const q of ['cx_hi', 'cx_tpub', 'cx_tfind']) h[q] = a => serve(ctx(), q, a)
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
  h.cx_send = async a => {
    if (!(a.to instanceof Uint8Array) || a.to.length !== 32 || !(a.msg instanceof Uint8Array) || a.msg.length > 4096) throw [203, 'bad message']
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
    const hit = replays.get(key)
    if (hit && Date.now() - hit.t < 60e3) return res.end(hit.bytes)
    if (!allow(ip, q)) return reply(res, { t: m.t, y: 'e', e: [202, 'rate limited'] })
    const from = { host: ip, port, http: true }
    let out
    try { out = { t: m.t, y: 'r', r: { id: node.dht.id, ...await answer(q, a, from, res) } } } catch (e) {
      const [code, msg] = Array.isArray(e) ? e : [201, e.message || 'error']
      out = { t: m.t, y: 'e', e: [code, msg] }
    }
    const bytes = encode(out)
    if (q !== 'cx_listen' && q !== 'cx_twatch') {
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
        res.setHeader('cache-control', 'public, max-age=30')
        if (!/text\/html/.test(req.headers.accept || '')) {             // curl, wget, scripts, fetch(): plain anchor lines
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          return res.end(node.listing() + '\n')
        }
        res.setHeader('content-type', 'text/html; charset=utf-8')
        const origin = node.web || `http://${String(req.headers.host || `${node.host}:${node.port}`).replace(/[^\w.:[\]-]/g, '')}`
        return res.end(homepage({ origin, line: node.line() || `(not an anchor) ${node.key}`, anchor: !!node.line(), services: node.services(), uptime: Date.now() - node.started, anchors: node.listing(), stats: stats(node, { inboxes: node.inboxes, store: node.store, bridges: node.peer?.bridges, extra: { dht: node.dht.nodes.size } }) }))
      }
      if (path === '/favicon.ico') return send(res, new URL('favicon.ico', logoDir), 'image/x-icon', true)
      if (/^\/cx\/[a-z]+\.js$/.test(path)) return send(res, new URL(path.slice(4), srcDir), 'text/javascript; charset=utf-8')
      res.statusCode = 404; res.end()
    } catch { if (!res.headersSent) res.statusCode = 400; res.end() }
  })
  server.requestTimeout = 40e3
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://x').pathname !== '/relay' || !node.peer?.relayFor) return socket.destroy()
    serveSocket(node.peer, websocket(req, socket))
  })
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

// Minimal RFC 6455 server socket: text and binary messages, ping/pong, close. Frames ≤ 64 KB.
function websocket (req, socket) {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const frame = (op, data) => {
    const n = data.length, head = n < 126 ? [0x80 | op, n] : [0x80 | op, 126, n >> 8, n & 255]
    if (n < 65536 && !socket.destroyed) socket.write(Buffer.concat([Buffer.from(head), data]))
  }
  const ws = { send: d => frame(typeof d === 'string' ? 1 : 2, Buffer.from(d)), close: () => socket.end(), onmessage () {}, onclose () {} }
  let buf = Buffer.alloc(0), parts = []
  socket.on('data', d => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 6) {
      let len = buf[1] & 127, off = 2
      if (len === 126) { len = buf.readUInt16BE(2); off = 4 } else if (len === 127) return socket.destroy()
      if (!(buf[1] & 128) || buf.length < off + 4 + len) return                  // clients must mask; wait for more
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len)), op = buf[0] & 15, fin = buf[0] & 128
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
      buf = buf.subarray(off + 4 + len)
      if (op === 8) return socket.end()
      if (op === 9) { frame(10, data); continue }
      if (op === 1 || op === 2) parts = [data, op]; else if (op === 0) parts[0] = Buffer.concat([parts[0], data]); else continue
      if (fin) ws.onmessage(parts[1] === 1 ? parts[0].toString() : new Uint8Array(parts[0]))
    }
  })
  socket.on('close', () => ws.onclose()).on('error', () => socket.destroy())
  return ws
}

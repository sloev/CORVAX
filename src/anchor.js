// The anchor: one Node/Bun process on one port number.
//   UDP  -> Mainline-compatible DHT node + STUN server (so browsers can use it in iceServers)
//   TCP  -> HTTP: pkarr-relay-compatible GET/PUT /<address>, the browser library, the demo page
//        -> WebSocket: publish / resolve / deliver Letters for peers that can't speak UDP
// An anchor is just a peer that happens to be reachable. Anyone can run one; peers trust none of them
// because every record is signed and every Letter is end-to-end encrypted.
import { createServer } from 'node:http'
import { createSocket } from 'node:dgram'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DHT, MAINLINE } from './dht.js'
import { pack, unpack, verifyBeacon, target } from './record.js'
import { verify } from './crypto.js'
import { b64, unb64, hex, utf8, unz32, concat, u64 } from './bytes.js'

const MAILBOX_TTL = 120e3, MAX_MSG = 64 * 1024
const here = new URL('.', import.meta.url)

export async function anchor ({ port = 4799, host = '0.0.0.0', bootstrap = [], mainline = false, log = () => {} } = {}) {
  const udp = createSocket('udp4')
  const dht = new DHT({ send: (b, to) => udp.send(b, to.port, to.host) })
  udp.on('message', (b, r) => {
    const from = { host: r.address, port: r.port }
    if (isStun(b)) udp.send(stunReply(b, from), from.port, from.host)
    else dht.receive(new Uint8Array(b), from)
  })

  const inboxes = new Map()   // hex(pub) -> Set(ws)
  const mailbox = new Map()   // hex(pub) -> [{ letter, t }]

  async function resolve (pub) {
    const item = await dht.get(await target(pub))
    return item && { pub, seq: item.seq, sig: item.sig, v: item.v }
  }
  async function publish (r) {
    if (!await verifyBeacon(r)) throw new Error('bad signature')
    const item = { k: r.pub, seq: r.seq, sig: r.sig, v: r.v }
    const p = dht.put(item)                       // stores locally at once, spreads to the DHT in the background
    p.then(n => log(`published ${hex(r.pub).slice(0, 8)} to ${n} DHT nodes`), e => log('publish', e.message))
  }
  function deliver (to, letter) {
    const id = hex(to), live = inboxes.get(id)
    if (live?.size) { for (const ws of live) ws.send(JSON.stringify({ op: 'letter', letter })); return true }
    const box = (mailbox.get(id) || []).filter(x => Date.now() - x.t < MAILBOX_TTL).slice(-63)
    box.push({ letter, t: Date.now() }); mailbox.set(id, box)
    return false
  }

  const ops = {
    async hello (m, ws) {   // proves the client owns the key whose Letters it wants to receive
      const pub = unb64(m.pub)
      if (Math.abs(Date.now() - m.ts) > 300e3 || !await verify(pub, unb64(m.sig), utf8(`cx-hello:${m.ts}`))) throw new Error('bad hello')
      const id = hex(pub)
      if (!inboxes.has(id)) inboxes.set(id, new Set())
      inboxes.get(id).add(ws); ws.inbox = id
      for (const { letter } of mailbox.get(id) || []) ws.send(JSON.stringify({ op: 'letter', letter }))
      mailbox.delete(id)
    },
    async publish (m) { const pub = unb64(m.pub); await publish(unpack(pub, unb64(m.rec))) },
    async resolve (m) { const r = await resolve(unb64(m.pub)); return { rec: r && b64(pack(r)) } },
    async send (m) { return { delivered: deliver(unb64(m.to), m.letter) } }
  }

  const http = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, PUT, OPTIONS')
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (req.method === 'OPTIONS') return res.end()
      if (path === '/logo') return asset(res, 'corvax-web.png', 'image/png')
      if (path === '/favicon.ico') return asset(res, 'favicon.ico', 'image/x-icon')
      if (path === '/') return file(res, 'demo.html', 'text/html')
      if (/^\/cx\/[a-z]+\.js$/.test(path)) return file(res, path.slice(4), 'text/javascript')
      const addr = path.slice(1)
      if (/^[a-z0-9]{52}$/.test(addr)) {                                     // pkarr relay API
        const pub = unz32(addr)
        if (req.method === 'PUT') { await publish(unpack(pub, await body(req))); return res.end() }
        const r = await resolve(pub)
        if (!r) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', 'application/pkarr.org/relays#payload')
        return res.end(pack(r))
      }
      res.statusCode = 404; res.end()
    } catch (e) { res.statusCode = 400; res.end(e.message) }
  })

  http.on('upgrade', (req, socket) => websocket(req, socket, ws => {
    ws.onmessage = async text => {
      let m
      try {
        m = JSON.parse(text)
        const r = await ops[m.op]?.(m, ws)
        if (m.id !== undefined) ws.send(JSON.stringify({ id: m.id, ok: true, ...r }))
      } catch (e) { if (m?.id !== undefined) ws.send(JSON.stringify({ id: m.id, ok: false, error: e.message })) }
    }
    ws.onclose = () => inboxes.get(ws.inbox)?.delete(ws)
  }))

  await new Promise(resolve => udp.bind(port, host, resolve))
  await new Promise(resolve => http.listen(port, host, resolve))
  const seeds = [...bootstrap, ...(mainline ? MAINLINE : [])]
  if (seeds.length) dht.bootstrap(seeds).then(n => log(`DHT: ${n} nodes`))
  log(`anchor on udp+tcp port ${port}: http://localhost:${port}/`)
  return { dht, port, close: () => { udp.close(); http.closeAllConnections?.(); http.close() } }
}

const body = req => new Promise((resolve, reject) => {
  const parts = []; let n = 0
  req.on('data', d => { n += d.length; if (n > MAX_MSG) req.destroy(); else parts.push(d) })
  req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts)))).on('error', reject)
})
// The logo never changes for a given release, so browsers may cache it for a year.
const logoDir = new URL('../assets/logo/', import.meta.url)
async function asset (res, name, type) {
  res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  res.setHeader('content-type', type)
  res.end(await readFile(new URL(name, logoDir)))
}
async function file (res, name, type) {
  res.setHeader('content-type', type)
  res.end(await readFile(new URL(name, here)))
}

// ---- STUN binding responder (RFC 5389), so anchors double as STUN servers --------------------
const COOKIE = 0x2112a442
const isStun = b => b.length >= 20 && b[0] < 2 && b.readUInt32BE(4) === COOKIE
function stunReply (req, { host, port }) {
  const b = Buffer.alloc(32)
  b.writeUInt16BE(0x0101, 0); b.writeUInt16BE(12, 2); b.writeUInt32BE(COOKIE, 4); req.copy(b, 8, 8, 20)
  b.writeUInt16BE(0x0020, 20); b.writeUInt16BE(8, 22); b.writeUInt16BE(1, 24)       // XOR-MAPPED-ADDRESS, IPv4
  b.writeUInt16BE(port ^ (COOKIE >>> 16), 26)
  b.writeUInt32BE((host.split('.').reduce((a, x) => a * 256 + +x, 0) ^ COOKIE) >>> 0, 28)
  return b
}

// ---- WebSocket server (RFC 6455), text frames only -------------------------------------------
function websocket (req, socket, onopen) {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  const frame = (op, data) => {
    const n = data.length, head = n < 126 ? Buffer.from([0x80 | op, n])
      : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), Buffer.from(u64(n))])
    if (!socket.destroyed) socket.write(Buffer.concat([head, data]))
  }
  const ws = { send: text => frame(1, Buffer.from(text)), onmessage () {}, onclose () {} }
  let buf = Buffer.alloc(0), parts = []
  socket.on('data', d => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 2) {
      let len = buf[1] & 127, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (len > MAX_MSG) return socket.destroy()
      const masked = buf[1] & 128, mask = buf.subarray(off, off + 4)
      if (masked) off += 4
      if (buf.length < off + len) return
      const data = Buffer.from(buf.subarray(off, off + len)), op = buf[0] & 15, fin = buf[0] & 128
      if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
      buf = buf.subarray(off + len)
      if (op === 8) { frame(8, Buffer.alloc(0)); return socket.end() }
      if (op === 9) { frame(10, data); continue }
      if (op > 2) continue
      parts.push(data)
      if (fin) { const text = Buffer.concat(parts).toString(); parts = []; ws.onmessage(text) }
    }
  })
  socket.on('close', () => ws.onclose()).on('error', () => socket.destroy())
  onopen(ws)
}

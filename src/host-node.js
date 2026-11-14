// The Node host (also Bun and Deno): the I/O a CORVAX node needs, behind the host interface of SPEC §11.
// Desktop and Android apps implement the same five things natively and run the rest of CORVAX unchanged.
//   udp(opts, onmessage) · http(opts, handle, onsocket) · asset(name) · kv(dir) · dnsTxt(name)
import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)

// A UDP socket: { port, send(bytes, port, host), close() }. group/broadcast: LAN discovery.
async function udp ({ port = 0, address, reuse = false, group, broadcast = false }, onmessage) {
  const s = createSocket({ type: 'udp4', reuseAddr: reuse })
  s.on('message', (b, r) => onmessage(new Uint8Array(b), { address: r.address, port: r.port }))
  await new Promise((resolve, reject) => { s.once('error', reject); s.bind(port, address, () => { s.off('error', reject); resolve() }) })
  s.on('error', () => {})
  try { if (broadcast) s.setBroadcast(true); if (group) { s.addMembership(group); s.setMulticastLoopback(true) } } catch {}
  return { port: s.address().port, send: (b, p, h) => { try { s.send(b, p, h) } catch {} }, close: () => { try { s.close() } catch {} } }
}

// An HTTP server around a req → res handler (anchor.js), plus WebSocket upgrades handed over framed.
async function http ({ port, address }, handle, onsocket) {
  const server = createServer(async (req, res) => {
    const ac = new AbortController()
    res.on('close', () => ac.abort())                                    // the client went away (ends long polls)
    const out = await handle({
      method: req.method, path: new URL(req.url, 'http://x').pathname, headers: req.headers,
      ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), port: req.socket.remotePort, signal: ac.signal,
      body: max => new Promise((resolve, reject) => {
        const parts = []; let n = 0
        req.on('data', d => { if ((n += d.length) > max) { req.destroy(); reject(new Error('too large')) } else parts.push(d) })
        req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts)))).on('error', reject)
      })
    }).catch(() => ({ status: 500 }))
    if (res.destroyed) return
    res.writeHead(out.status, out.headers)
    res.end(out.body)
  })
  server.requestTimeout = 75e3
  server.on('upgrade', (req, socket) => onsocket(new URL(req.url, 'http://x').pathname, websocket(req, socket)))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve) })
  return { close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }) }
}

// Minimal RFC 6455 server socket: text and binary messages, ping/pong, close. Frames ≤ 64 KB.
function websocket (req, socket) {
  const ws = { send () {}, close: () => socket.end(), onmessage () {}, onclose () {} }
  crypto.subtle.digest('SHA-1', new TextEncoder().encode(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')).then(h => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${Buffer.from(h).toString('base64')}\r\n\r\n`)
    const frame = (op, data) => {
      const n = data.length, head = n < 126 ? [0x80 | op, n] : [0x80 | op, 126, n >> 8, n & 255]
      if (n < 65536 && !socket.destroyed) socket.write(Buffer.concat([Buffer.from(head), data]))
    }
    ws.send = d => frame(typeof d === 'string' ? 1 : 2, Buffer.from(d))
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
  })
  socket.on('close', () => ws.onclose()).on('error', () => socket.destroy())
  return ws
}

// Package files the homepage serves: 'src/app.js', 'assets/logo/favicon.ico', …
const asset = name => readFile(new URL(name, root)).then(b => new Uint8Array(b))

// Small persistent values (the seed, the anchor cache), one file each in dir (default ~/.config/corvax).
function kv (dir = join(homedir(), '.config', 'corvax')) {
  return {
    get: name => readFile(join(dir, name), 'utf8').catch(() => null),
    set: async (name, value) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, name), value, { mode: 0o600 }) }
  }
}

const dnsTxt = name => import('node:dns/promises').then(d => d.resolveTxt(name)).then(r => r.map(x => x.join('')).join('\n'))

export default { udp, http, asset, kv, dnsTxt }

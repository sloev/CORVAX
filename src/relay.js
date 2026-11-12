// Relaying through a third peer C (any peer: browser, native node or anchor).
//   A → B   msg {cx:'via?', sid, e: eph_a, via: [candidate addresses]}
//   B → A   msg {cx:'via',  sid, e: eph_b, c: chosen C}      (or {cx:'via-no'})
//   A, B → C  on the control channel: {cx:'bridge', sid, to: other}; C pairs them → {cx:'bridged'}
//   frames  sid 9 | counter 8 | AES-GCM_Kdir(type 1 | data)   — end-to-end; C only sees ciphertext
import { ephemeral, ecdh, hkdf, aesKey, encrypt, decrypt } from './crypto.js'
import { b64, unb64, random, concat, utf8, str, u64, readU64, fail, toWire, bytesOf } from './bytes.js'
import * as rtc from './rtc.js'

const MAX_FRAME = 16 * 1024, HOUR_BYTES = 1e9, IDLE = 120e3
const waiters = new Map()      // sid -> { resolve, reject } for A waiting on B's answer

// A: ask B to meet through a third peer
export async function via (peer, address, { timeout = 30000, purpose = 'app', tp } = {}) {
  const beacon = await peer.resolve(address)
  if (!beacon) throw fail('not-found')
  const sid = b64(random(9)), eph = await ephemeral()
  const candidates = [...peer.conns.keys(), ...peer.book.best(8, 'native', e => e.verified).map(e => e.key)]
  const list = [...new Set(candidates)].filter(a => a !== address && a !== peer.address).slice(0, 8)
  if (!list.length) throw fail('no-relay', 'no peer to relay through')
  const answer = new Promise((resolve, reject) => waiters.set(sid, { resolve, reject }))
  const timer = setTimeout(() => waiters.get(sid)?.reject(fail('no-relay', 'no answer')), timeout)
  timer.unref?.()
  try {
    await peer.signal(address, { cx: 'via?', sid, e: b64(eph.pub), via: list, p: purpose, ...(tp && { tp }) }, beacon)
    const r = await answer
    const conn = peer.conns.get(r.c) || await connTo(peer, r.c)
    const ch = await RelayChannel.create(peer, conn, sid, eph.priv, unb64(r.e), 'a')
    conn.ctl.send(JSON.stringify({ cx: 'bridge', sid, to: address }))
    await ch.ready(timeout)
    return { channel: ch, kind: 'peer', via: r.c, address }
  } finally { clearTimeout(timer); waiters.delete(sid) }
}

const connTo = (peer, address) => rtc.direct(peer, address, { purpose: 'relay', timeout: 8000 }).then(() => peer.conns.get(address))

// B: pick C, answer A, ask C to bridge
export async function onSignal (peer, from, body) {
  const sid = String(body.sid || '')
  if (body.cx === 'via') return waiters.get(sid)?.resolve({ c: String(body.c), e: String(body.e) })
  if (body.cx === 'via-no') return waiters.get(sid)?.reject(fail('no-relay', 'peer found no common relay'))
  if (body.cx !== 'via?' || !Array.isArray(body.via)) return
  const tp = body.p === 'topic' ? String(body.tp || '') : null
  if (!tp && !peer.acceptors.size) return
  if (tp && !peer.topics.accept(from, tp)) return peer.signal(from, { cx: 'via-no', sid }).catch(() => {})
  const list = body.via.map(String).filter(a => /^[a-z0-9]{52}$/.test(a) && a !== peer.address && a !== from).slice(0, 8)
  let c = list.find(a => peer.conns.has(a))
  for (const a of c ? [] : list) {
    try { await connTo(peer, a); c = a; break } catch {}
  }
  if (!c) { if (tp) peer.topics.release(from, tp); return peer.signal(from, { cx: 'via-no', sid }).catch(() => {}) }
  const eph = await ephemeral(), conn = peer.conns.get(c)
  const ch = await RelayChannel.create(peer, conn, sid, eph.priv, unb64(String(body.e)), 'b')
  await peer.signal(from, { cx: 'via', sid, e: b64(eph.pub), c })
  conn.ctl.send(JSON.stringify({ cx: 'bridge', sid, to: from }))
  try { await ch.ready(30000) } catch { if (tp) peer.topics.release(from, tp); return ch.close() }
  if (tp) return peer.topics.attach(from, tp, ch, 'peer')
  for (const fn of peer.acceptors) fn({ from, channel: ch, kind: 'peer', via: c })
}

// C (and endpoints): control channel traffic
export function onControl (peer, conn, data) {
  if (typeof data === 'string' && data[0] === 'K') return peer.onChanText(conn.ctl, data)   // KRPC over WebRTC
  if (typeof data === 'string') {
    let m
    try { m = JSON.parse(data) } catch { return }
    const sid = String(m.sid || '')
    if (m.cx === 'bridge') return bridge(peer, conn, sid, String(m.to || ''))
    if (m.cx === 'bridged') return peer.channels.get(sid)?.opened()
    if (m.cx === 'unbridge' || m.cx === 'bridge-no') {
      peer.channels.get(sid)?.close(false)
      const b = peer.bridges.get(sid)
      if (b && (b.a === conn || b.b === conn)) endBridge(peer, sid)
    }
    return
  }
  const bytes = bytesOf(data)
  if (!bytes || bytes.length < 9 + 8 + 16 || bytes.length > MAX_FRAME + 64) return
  const sid = b64(bytes.subarray(0, 9))
  const ch = peer.channels.get(sid)
  if (ch && ch.conn === conn) return ch.receive(bytes)
  const b = peer.bridges.get(sid)
  if (!b?.b || (conn !== b.a && conn !== b.b)) return
  const now = Date.now()
  if (now - b.window > 1000) { b.window = now; b.inWindow = 0 }
  b.inWindow += bytes.length; b.last = now
  peer.relayBytes = (peer.relayHour === Math.floor(now / 3600e3) ? peer.relayBytes : 0) + bytes.length
  peer.relayHour = Math.floor(now / 3600e3)
  if (b.inWindow > peer.limits.kbps * 125 * 2 || peer.relayBytes > HOUR_BYTES) return endBridge(peer, sid)
  try { (conn === b.a ? b.b : b.a).ctl.send(toWire(bytes)) } catch { endBridge(peer, sid) }
}

function bridge (peer, conn, sid, to) {
  const say = (c, m) => { try { c.ctl.send(JSON.stringify(m)) } catch {} }
  if (!peer.relayFor) return say(conn, { cx: 'bridge-no', sid })
  const b = peer.bridges.get(sid)
  if (!b) {
    const active = [...peer.bridges.values()].filter(x => x.b).length
    if (active >= peer.limits.sessions || peer.bridges.size > 64) return say(conn, { cx: 'bridge-no', sid })
    peer.bridges.set(sid, { a: conn, to, window: 0, inWindow: 0, last: Date.now() })
    setTimeout(() => { if (!peer.bridges.get(sid)?.b) peer.bridges.delete(sid) }, 30e3).unref?.()
    return
  }
  // pair only when both ends asked for each other, over two different direct connections
  if (b.b || b.a === conn || b.to !== conn.address || to !== b.a.address) return
  b.b = conn
  say(b.a, { cx: 'bridged', sid }); say(b.b, { cx: 'bridged', sid })
  b.idle = setInterval(() => { if (Date.now() - b.last > IDLE) endBridge(peer, sid) }, 10e3)
  b.idle.unref?.()
}
function endBridge (peer, sid) {
  const b = peer.bridges.get(sid)
  if (!b) return
  peer.bridges.delete(sid); clearInterval(b.idle)
  for (const c of [b.a, b.b]) try { c?.ctl.send(JSON.stringify({ cx: 'unbridge', sid })) } catch {}
}
export function onClosed (peer, conn) {
  for (const [sid, b] of peer.bridges) if (b.a === conn || b.b === conn) endBridge(peer, sid)
  for (const ch of peer.channels.values()) if (ch.conn === conn) ch.close(false)
}

// the relayed channel: same surface as RTCDataChannel
class RelayChannel {
  static async create (peer, conn, sid, myEph, theirEph, role) {
    const shared = await ecdh(myEph, theirEph), info = d => concat(utf8('cx/relay'), unb64(sid), utf8(d))
    const ab = await aesKey(await hkdf(shared, info('a2b'))), ba = await aesKey(await hkdf(shared, info('b2a')))
    const ch = new RelayChannel()
    Object.assign(ch, { peer, conn, sid, sidBytes: unb64(sid), tx: role === 'a' ? ab : ba, rx: role === 'a' ? ba : ab })
    peer.channels.set(sid, ch)
    return ch
  }

  constructor () {
    this.readyState = 'connecting'; this.binaryType = 'arraybuffer'; this.label = 'app'
    this.onopen = this.onmessage = this.onclose = null
    this.sent = 0; this.received = -1
    this.outQ = this.inQ = Promise.resolve()
    this.whenOpen = new Promise(resolve => { this.opened = () => { if (this.readyState !== 'connecting') return; this.readyState = 'open'; resolve(); this.onopen?.({}) } })
  }
  ready (ms) {
    let timer
    return Promise.race([this.whenOpen, new Promise((resolve, reject) => { timer = setTimeout(() => reject(fail('no-relay', 'relay did not bridge')), ms); timer.unref?.() })])
      .finally(() => clearTimeout(timer))
  }

  send (data) {
    if (this.readyState !== 'open') throw new Error('channel not open')
    const isText = typeof data === 'string', body = isText ? utf8(data) : bytesOf(data)
    if (!body || body.length > MAX_FRAME) throw new Error('frame too large or unsupported data')
    const n = this.sent++
    this.outQ = this.outQ.then(async () => {
      const ctr = u64(n), iv = concat(new Uint8Array(4), ctr)
      const ct = await encrypt(this.tx, iv, concat(Uint8Array.of(isText ? 0 : 1), body))
      this.conn.ctl.send(toWire(concat(this.sidBytes, ctr, ct)))
    }).catch(() => this.close())
  }
  receive (frame) {
    this.inQ = this.inQ.then(async () => {
      const n = readU64(frame.subarray(9, 17))
      if (n <= this.received) return                       // replayed or reordered: drop
      const pt = await decrypt(this.rx, concat(new Uint8Array(4), frame.subarray(9, 17)), frame.subarray(17))
      this.received = n
      const data = pt[0] === 0 ? str(pt.subarray(1)) : pt.slice(1).buffer
      this.onmessage?.({ data })
    }).catch(() => {})
  }
  close (notify = true) {
    if (this.readyState === 'closed') return
    if (notify) try { this.conn.ctl.send(JSON.stringify({ cx: 'unbridge', sid: this.sid })) } catch {}
    this.readyState = 'closed'
    this.peer.channels.delete(this.sid)
    this.onclose?.({})
  }
}

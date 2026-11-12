// Direct connections: plain WebRTC offer/answer, carried as signed+encrypted messages.
// Every connection has two pre-agreed DataChannels: id 0 "app" (handed to the app) and
// id 1 "cx" (control: used to relay for others).
import { b64, random, fail } from './bytes.js'
import * as relay from './relay.js'


function withTimeout (promise, ms, code) {
  let timer
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(fail(code)), ms); timer.unref?.() })])
    .finally(() => clearTimeout(timer))
}
const opened = ch => new Promise(resolve => {
  if (ch.readyState === 'open') return resolve()
  ch.onopen = () => resolve()
})

// One negotiation. Candidates can arrive before the offer, so a placeholder may already exist.
function session (peer, address, sid, beacon) {
  const s = peer.sessions.get(sid) || { queue: [] }
  peer.sessions.set(sid, s)
  s.pc = new peer.RTC({ iceServers: peer.iceServers() })
  s.app = s.pc.createDataChannel('app', { negotiated: true, id: 0 })
  s.ctl = s.pc.createDataChannel('cx', { negotiated: true, id: 1 })
  s.app.binaryType = s.ctl.binaryType = 'arraybuffer'
  s.open = Promise.all([opened(s.app), opened(s.ctl)])
  s.pc.onicecandidate = e => {
    const c = e.candidate
    if (c?.candidate) peer.signal(address, { cx: 'cand', sid, c: c.candidate, m: c.sdpMid ?? '0', i: c.sdpMLineIndex ?? 0 }, beacon).catch(() => {})
  }
  setTimeout(() => { if (peer.sessions.get(sid) === s) peer.sessions.delete(sid) }, 60e3).unref?.()
  return s
}
function flush (s) {
  if (!s.pc?.remoteDescription) return
  for (const c of s.queue.splice(0)) s.pc.addIceCandidate({ candidate: c.c, sdpMid: c.m, sdpMLineIndex: c.i }).catch(() => {})
}

function register (peer, address, s) {
  const conn = { address, pc: s.pc, app: s.app, ctl: s.ctl }
  peer.conns.set(address, conn)
  s.ctl.onmessage = e => relay.onControl(peer, conn, e.data)
  const gone = () => { if (peer.conns.get(address) === conn) peer.conns.delete(address); relay.onClosed(peer, conn) }
  s.ctl.onclose = gone
  return conn
}

export async function direct (peer, address, { timeout = 10000, purpose = 'app', tp } = {}) {
  if (!peer.RTC) throw fail('no-webrtc', 'no RTCPeerConnection available (pass one to Peer.create)')
  const beacon = await peer.resolve(address)
  if (!beacon) throw fail('not-found', `no record for ${address}`)
  if (peer.blockDirect.has(address)) throw fail('ice-failed', 'direct path blocked (test hook)')
  const sid = b64(random(9))
  const s = session(peer, address, sid, beacon)
  const answered = new Promise((resolve, reject) => { s.answered = resolve; s.busy = () => reject(fail('busy', 'peer declined')) })
  try {
    await s.pc.setLocalDescription(await s.pc.createOffer())
    await peer.signal(address, { cx: 'offer', sid, sdp: s.pc.localDescription.sdp, p: purpose, ...(tp && { tp }) }, beacon)
    const sdp = await withTimeout(answered, timeout, 'no-answer')
    await s.pc.setRemoteDescription({ type: 'answer', sdp })
    flush(s)
    await withTimeout(s.open, timeout, 'ice-failed')
    const conn = register(peer, address, s)
    return { channel: conn.app, pc: conn.pc, kind: 'direct', address }
  } catch (e) {
    try { s.pc.close() } catch {}
    throw e
  } finally { peer.sessions.delete(sid) }
}

// Incoming signalling: offer / answer / cand
export async function onSignal (peer, from, body) {
  const sid = String(body.sid || '')
  if (!sid || sid.length > 24) return
  if (body.cx === 'cand') {
    const s = peer.sessions.get(sid) || peer.sessions.set(sid, { queue: [] }).get(sid)
    if (s.queue.length < 64) s.queue.push({ c: String(body.c), m: body.m, i: body.i })
    return flush(s)
  }
  if (body.cx === 'answer') return peer.sessions.get(sid)?.answered?.(String(body.sdp))
  if (body.cx === 'busy') return peer.sessions.get(sid)?.busy?.()
  if (body.cx !== 'offer' || !peer.RTC || peer.sessions.get(sid)?.pc) return
  const purpose = ['relay', 'topic'].includes(body.p) ? body.p : 'app'
  const tp = purpose === 'topic' ? String(body.tp || '') : null
  const busy = () => peer.signal(from, { cx: 'busy', sid }).catch(() => {})
  if (purpose === 'app' && !peer.acceptors.size) return                       // nobody is accepting
  if (purpose === 'relay' && !peer.relayFor) return busy()
  if (peer.blockDirect.has(from)) return
  if (purpose === 'topic' && !peer.topics.accept(from, tp)) return busy()     // reserves a neighbour slot
  const s = session(peer, from, sid)
  try {
    await s.pc.setRemoteDescription({ type: 'offer', sdp: String(body.sdp) })
    await s.pc.setLocalDescription(await s.pc.createAnswer())
    flush(s)
    await peer.signal(from, { cx: 'answer', sid, sdp: s.pc.localDescription.sdp })
    await withTimeout(s.open, 30000, 'ice-failed')
  } catch { try { s.pc.close() } catch {} if (tp) peer.topics.release(from, tp); return } finally { peer.sessions.delete(sid) }
  const conn = register(peer, from, s)
  if (purpose === 'topic') return peer.topics.attach(from, tp, conn.app, 'direct')
  if (purpose === 'app') for (const fn of peer.acceptors) fn({ from, channel: conn.app, pc: conn.pc, kind: 'direct' })
}

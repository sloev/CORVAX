// Direct connections: plain WebRTC offer/answer, carried as signed+encrypted messages.
// Every connection has two pre-agreed DataChannels: id 0 "app" (handed to the app) and
// id 1 "cx" (control: used to relay for others).
import { b64, unb64, random, fail, utf8, str, concat, equal, z32, unz32 } from './bytes.js'
import { encode, decode } from './bencode.js'
import { sign, verify } from './crypto.js'
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
  s.address = address
  s.pc = new peer.RTC({ iceServers: peer.iceServers() })
  s.app = s.pc.createDataChannel('app', { negotiated: true, id: 0 })
  s.ctl = s.pc.createDataChannel('cx', { negotiated: true, id: 1 })
  s.app.binaryType = s.ctl.binaryType = 'arraybuffer'
  s.open = Promise.all([opened(s.app), opened(s.ctl)])
  // Fewer, smaller messages through anchors: candidates found before the offer/answer is sent (s.sent) ride in its
  // SDP; later ones go out together every 150 ms (one message `cs` to peers with v ≥ 2, else one each).
  const batch = []
  const flushOut = () => {
    s.timer = null
    const cs = batch.splice(0)
    if (!cs.length) return
    if (beacon?.fields.v?.[0] >= 2 || s.batched) return peer.signal(address, { cx: 'cand', sid, cs }, beacon).catch(() => {})
    for (const [c, m, i] of cs) peer.signal(address, { cx: 'cand', sid, c, m, i }, beacon).catch(() => {})
  }
  s.pc.onicecandidate = e => {
    const c = e.candidate
    if (!c?.candidate || !address || !s.sent) return
    batch.push([c.candidate, c.sdpMid ?? '0', c.sdpMLineIndex ?? 0])
    s.timer ||= setTimeout(flushOut, 150)
  }
  setTimeout(() => { if (peer.sessions.get(sid) === s) peer.sessions.delete(sid) }, 60e3).unref?.()
  return s
}
// Give ICE 150 ms (or until it is done) so the local candidates are inside the SDP we are about to send.
const brief = s => new Promise(resolve => {
  const done = () => { s.sent = true; resolve() }
  if (s.pc.iceGatheringState === 'complete') return done()
  const timer = setTimeout(done, 150), on = s.pc.onicecandidate
  s.pc.onicecandidate = e => { if (!e.candidate) { clearTimeout(timer); s.pc.onicecandidate = on; done() } }
  setTimeout(() => { s.pc.onicecandidate = on }, 150)
})
function flush (s) {
  if (!s.pc?.remoteDescription) return
  for (const c of s.queue.splice(0)) s.pc.addIceCandidate({ candidate: c.c, sdpMid: c.m, sdpMLineIndex: c.i }).catch(() => {})
}

function register (peer, address, s) {
  const conn = { address, pc: s.pc, app: s.app, ctl: s.ctl }
  peer.conns.set(address, conn)
  s.ctl.onmessage = e => relay.onControl(peer, conn, e.data)
  const gone = () => { if (peer.conns.get(address) === conn) peer.conns.delete(address); relay.onClosed(peer, conn); peer.weaveSoon() }   // heal the backbone
  s.ctl.onclose = gone
  peer.greet(s.ctl, address).catch(() => {})              // mesh: swap Beacons and anchor lists, remember the peer
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
    await brief(s)
    await peer.signal(address, { cx: 'offer', sid, sdp: s.pc.localDescription.sdp, p: purpose, v: 2, ...(tp && { tp }) }, beacon)
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
  // A session belongs to one address: only that peer may answer it or add candidates to it.
  const mine = peer.sessions.get(sid), theirs = mine?.address === from ? mine : null
  if (body.cx === 'cand') {
    let s = theirs
    if (!s) {                                              // candidates can arrive before their offer: hold a few, briefly
      if (mine || [...peer.sessions.values()].filter(x => !x.pc).length >= 32) return
      peer.sessions.set(sid, s = { queue: [], address: from })
      setTimeout(() => { if (peer.sessions.get(sid) === s && !s.pc) peer.sessions.delete(sid) }, 30e3).unref?.()
    }
    for (const [c, m, i] of Array.isArray(body.cs) ? body.cs.slice(0, 32) : [[body.c, body.m, body.i]]) if (s.queue.length < 64) s.queue.push({ c: String(c), m, i })
    return flush(s)
  }
  if (body.cx === 'answer') return theirs?.answered?.(String(body.sdp))
  if (body.cx === 'busy') return theirs?.busy?.()
  if (body.cx !== 'offer' || !peer.RTC || mine?.pc || (mine && !theirs)) return
  const purpose = ['relay', 'topic'].includes(body.p) ? body.p : 'app'
  const tp = purpose === 'topic' ? String(body.tp || '') : null
  const busy = () => peer.signal(from, { cx: 'busy', sid }).catch(() => {})
  if (purpose === 'app' && !peer.acceptors.size) return                       // nobody is accepting
  if (purpose === 'relay' && (!peer.relayFor || peer.conns.size >= peer.maxConns)) return busy()
  if (peer.blockDirect.has(from)) return
  if (purpose === 'topic' && !peer.topics.accept(from, tp)) return busy()     // reserves a neighbour slot
  const s = session(peer, from, sid)
  try {
    await s.pc.setRemoteDescription({ type: 'offer', sdp: String(body.sdp) })
    await s.pc.setLocalDescription(await s.pc.createAnswer())
    flush(s)
    s.batched = body.v >= 2                                // the offerer reads batched candidates
    await brief(s)
    await peer.signal(from, { cx: 'answer', sid, sdp: s.pc.localDescription.sdp })
    await withTimeout(s.open, 30000, 'ice-failed')
  } catch { try { s.pc.close() } catch {} if (tp) peer.topics.release(from, tp); return } finally { peer.sessions.delete(sid) }
  const conn = register(peer, from, s)
  if (purpose === 'topic') return peer.topics.attach(from, tp, conn.app, 'direct')
  if (purpose === 'app') for (const fn of peer.acceptors) fn({ from, channel: conn.app, pc: conn.pc, kind: 'direct' })
}

// ---- by hand (SPEC §13) -------------------------------------------------------------------------
// Two short texts, carried over any medium (paste, QR, voice, paper), make a connection with no anchor and no
// network service: code = "cx1" ‖ b64(bencode{ k, sid, sdp, to, sig }), sig = Ed25519("cx-hand" ‖ bencode{ k, sid, sdp, to }).
const gathered = pc => new Promise(resolve => {             // all ICE candidates are in the SDP (or 4 s passed)
  const timer = setTimeout(resolve, 4000)
  pc.onicecandidate = e => { if (!e.candidate) { clearTimeout(timer); resolve() } }
  if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve() }
})
async function handCode (peer, sid, sdp, to = new Uint8Array(0)) {
  const body = { k: peer.id.pub, sid: utf8(sid), sdp: utf8(sdp), to }
  return 'cx1' + b64(encode({ ...body, sig: await sign(peer.id, concat(utf8('cx-hand'), encode(body))) }))
}
async function readCode (code) {
  const text = String(code).trim()
  let m
  try { m = decode(unb64(text.slice(3))) } catch {}
  const bytes = (x, n) => x instanceof Uint8Array && (n === undefined || x.length === n)
  if (!text.startsWith('cx1') || !m || !bytes(m.k, 32) || !bytes(m.sid) || !bytes(m.sdp) || !bytes(m.to) || !bytes(m.sig, 64) ||
      !await verify(m.k, m.sig, concat(utf8('cx-hand'), encode({ k: m.k, sid: m.sid, sdp: m.sdp, to: m.to })))) throw fail('bad-code', 'not a valid link code')
  return { address: z32(m.k), sid: str(m.sid), sdp: str(m.sdp), to: m.to }
}
const result = (conn, address) => ({ channel: conn.app, pc: conn.pc, kind: 'direct', address })

export async function hand (peer, code) {
  if (!peer.RTC) throw fail('no-webrtc', 'no RTCPeerConnection available (pass one to Peer.create)')
  const sid = code ? null : b64(random(9)), o = code && await readCode(code)
  if (o?.to.length) throw fail('bad-code', 'this is a reply; give it to accept()')
  const s = session(peer, null, sid || o.sid)
  peer.sessions.delete(sid || o.sid)                         // nothing arrives by message for this one
  if (!code) {
    await s.pc.setLocalDescription(await s.pc.createOffer())
    await gathered(s.pc)
    return {
      code: await handCode(peer, sid, s.pc.localDescription.sdp),
      accept: async reply => {
        const r = await readCode(reply)
        if (r.sid !== sid || !equal(r.to, peer.id.pub)) throw fail('bad-code', 'this reply answers another code')
        await s.pc.setRemoteDescription({ type: 'answer', sdp: r.sdp })
        await withTimeout(s.open, 30000, 'ice-failed')
        return result(register(peer, r.address, s), r.address)
      }
    }
  }
  await s.pc.setRemoteDescription({ type: 'offer', sdp: o.sdp })
  await s.pc.setLocalDescription(await s.pc.createAnswer())
  await gathered(s.pc)
  const connected = withTimeout(s.open, 600e3, 'ice-failed').then(() => {
    const conn = register(peer, o.address, s)
    for (const fn of peer.acceptors) fn({ from: o.address, channel: conn.app, pc: conn.pc, kind: 'direct' })
    return result(conn, o.address)
  })
  connected.catch(() => { try { s.pc.close() } catch {} })
  return { code: await handCode(peer, o.sid, s.pc.localDescription.sdp, unz32(o.address)), connected }
}

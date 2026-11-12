// Direct browser-to-browser connections with no SDP on the wire.
// Both sides derive the ICE credentials from their shared key K_ab and build the other side's
// SDP from a template. Only the DTLS fingerprint and ICE candidates travel, as small Letters.
import { derive } from './crypto.js'
import { hex, unz32, b64, random } from './bytes.js'

const template = ({ ufrag, pwd }, fp, setup) => [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, 'a=ice-options:trickle', `a=fingerprint:${fp}`,
  `a=setup:${setup}`, 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n')

const munge = (sdp, { ufrag, pwd }) => sdp
  .replace(/a=ice-ufrag:.*\r\n/, `a=ice-ufrag:${ufrag}\r\n`)
  .replace(/a=ice-pwd:.*\r\n/, `a=ice-pwd:${pwd}\r\n`)
const fingerprint = sdp => sdp.match(/a=fingerprint:(.*)\r\n/)[1]

async function creds (peer, address, sid, role) {
  const b = await derive((await peer.key(unz32(address))).sh, `rv/ice/${sid}/${role}`, 20)
  return { ufrag: hex(b.slice(0, 4)), pwd: hex(b.slice(4)) }
}

// One entry per session id. Candidates can arrive before the session exists, so they queue.
const sessions = new Map()
function entry (sid) {
  if (!sessions.has(sid)) {
    sessions.set(sid, { queue: [] })
    setTimeout(() => sessions.delete(sid), 60000)
  }
  return sessions.get(sid)
}
const flush = s => { for (const c of s.queue.splice(0)) s.pc.addIceCandidate({ candidate: c, sdpMid: '0' }).catch(() => {}) }

// A PeerConnection whose ICE candidates trickle out to the other side as Letters.
function start (peer, address, sid, opts) {
  const s = entry(sid)
  s.pc = new RTCPeerConnection({ iceServers: opts.iceServers || [] })
  const channel = s.pc.createDataChannel('rv', { negotiated: true, id: 0 })
  s.pc.onicecandidate = e => e.candidate?.candidate && peer.send(address, { t: 'rtc-c', sid, c: e.candidate.candidate }, opts.beacon)
  s.open = new Promise((resolve, reject) => {
    channel.onopen = () => resolve(channel)
    setTimeout(() => reject(new Error('connection timed out')), opts.timeout || 20000)
  })
  s.open.catch(() => {})
  return s
}

function route (peer) {
  if (peer.rtc) return
  peer.rtc = true
  peer.on(async ({ from, body }) => {
    if (body?.t === 'rtc-c') {
      const s = entry(body.sid)
      s.queue.push(body.c)
      if (s.pc?.remoteDescription) flush(s)
    } else if (body?.t === 'rtc-ok') {
      sessions.get(body.sid)?.answered?.(body.fp)
    } else if (body?.t === 'rtc' && peer.accepting && !sessions.get(body.sid)?.pc) {   // incoming call
      const s = start(peer, from, body.sid, peer.accepting)
      await s.pc.setRemoteDescription({ type: 'offer', sdp: template(await creds(peer, from, body.sid, 'caller'), body.fp, 'actpass') })
      const answer = await s.pc.createAnswer()
      await s.pc.setLocalDescription({ type: 'answer', sdp: munge(answer.sdp, await creds(peer, from, body.sid, 'callee')) })
      flush(s)
      await peer.send(from, { t: 'rtc-ok', sid: body.sid, fp: fingerprint(answer.sdp) })
      s.open.then(channel => peer.accepting.onchannel({ from, channel, pc: s.pc }), () => s.pc.close())
    }
  })
}

// Accept incoming connections: onchannel({ from, channel, pc }) is called for each one.
export function listen (peer, { onchannel, iceServers } = {}) {
  peer.accepting = { onchannel, iceServers }
  route(peer)
}

// Open a direct DataChannel to an address. Resolves to an open RTCDataChannel.
export async function connect (peer, address, opts = {}) {
  route(peer)
  opts.beacon ??= await peer.resolve(address)
  const sid = b64(random(6))
  const s = start(peer, address, sid, opts)
  const answered = new Promise(resolve => { s.answered = resolve })
  try {
    const offer = await s.pc.createOffer()
    await s.pc.setLocalDescription({ type: 'offer', sdp: munge(offer.sdp, await creds(peer, address, sid, 'caller')) })
    await peer.send(address, { t: 'rtc', sid, fp: fingerprint(offer.sdp) }, opts.beacon)
    const fp = await Promise.race([answered, s.open])          // s.open only settles here by timing out
    await s.pc.setRemoteDescription({ type: 'answer', sdp: template(await creds(peer, address, sid, 'callee'), fp, 'active') })
    flush(s)
    return await s.open
  } catch (e) { s.pc.close(); throw e }
}

// One-call helpers on top of Peer and Topic, for the common cases.
//   presence(onCount, options?) → live count of peers on a topic (default: this page)
//   room(name, onMessage, options?) → everyone on a topic gets everyone's messages
// Options not listed below go to Peer.create (anchors, fallback, allowPrivate, …).
import { Peer } from './peer.js'

const doc = typeof document !== 'undefined' ? document : null
const here = () => typeof location !== 'undefined' ? (location.host + location.pathname).slice(0, 150) : 'default'
// One key per tab (sessionStorage): a reload is the same peer, a new tab another one.
async function tabPeer (slot, options) {
  let seed = null
  try { seed = sessionStorage.getItem(slot) } catch {}
  const p = await Peer.create({ seed, ...options })
  try { sessionStorage.setItem(slot, p.seed) } catch {}
  return p
}

// Live presence: onCount(n, info) runs whenever the number of peers here changes (you included).
// Presence only: a short lease, no inbox, no Beacon, no WebRTC between peers. Hidden or closed tabs leave at once.
export async function presence (onCount = () => {}, { topic = here(), lease = 120e3, peer, ...options } = {}) {
  const p = peer || await tabPeer('corvax.presence', { listen: false, storage: false, relayFor: false, ...options })
  const t = await p.topic(topic), others = new Set()
  const info = {
    topic, peer: p,
    get count () { return others.size + 1 },
    get peers () { return [...others] },
    async leave () { off(); doc?.removeEventListener('visibilitychange', visible); await t.close(); if (!peer) await p.close() }
  }
  const off = t.subscribe({ presence: e => { e.presence === 'recent' ? others.add(e.address) : others.delete(e.address); onCount(info.count, info) } })
  const join = () => t.publish({ beacon: false, lease })
  const visible = () => doc.hidden ? t.unpublish() : join().catch(() => {})
  doc?.addEventListener('visibilitychange', visible)
  await join()
  onCount(info.count, info)
  return info
}

// A room: onMessage(body, from) for every message sent by others here. Best effort over the topic mesh
// (≤ 1 KB JSON, ≤ 10 per minute per sender, never stored). Members connect over WebRTC, so they see each other's IP.
export async function room (name, onMessage = () => {}, { peer, ...options } = {}) {
  const p = peer || await tabPeer('corvax.room', options)
  const t = await p.topic(name)
  const off = t.subscribe({ message: m => onMessage(m.body, m.from) })
  await t.publish()
  return {
    topic: name, peer: p,
    send: body => t.broadcast(body),
    async leave () { off(); await t.close(); if (!peer) await p.close() }
  }
}

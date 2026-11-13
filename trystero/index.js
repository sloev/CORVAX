// @sloev/trystero-corvax: a Trystero signalling transport on CORVAX, peer to peer (SPEC §10).
//   room members  → CORVAX topic presence on the room's root topic (signed leases on storage peers, any peer)
//   announce      → a topic broadcast over the room's CORVAX mesh, and a sealed message to each member's inboxes
//   signal        → over a CORVAX mesh link to that peer when there is one (no anchor), else to its inboxes
// Trystero encrypts its signals with the room key; CORVAX seals them again for the one recipient.
import { createTopicStrategy } from '@trystero-p2p/core'
import { Peer } from '@sloev/corvax'

export { clearUserIdentity, createUserIdentity, exportUserIdentity, importUserIdentity, roles, scale } from '@trystero-p2p/core'

const peers = new Map()                         // options key → Promise<Peer>: one CORVAX peer per tab or process
const TAG = 'tr1'

// The CORVAX peer behind this transport: one per tab (sessionStorage seed), or pass your own as corvax.peer.
export function corvaxPeer ({ peer, ...options } = {}) {
  if (peer) return Promise.resolve(peer)
  const key = JSON.stringify(options)
  if (!peers.has(key)) peers.set(key, (async () => {
    let seed = null
    try { seed = sessionStorage.getItem('corvax.trystero') } catch {}
    const p = await Peer.create({ seed, ...options })
    try { sessionStorage.setItem('corvax.trystero', p.seed) } catch {}
    wire(p)
    return p
  })())
  return peers.get(key)
}

// Per CORVAX peer: Trystero topic → handlers; peer topic → CORVAX address (learned from signed messages).
function wire (p) {
  if (p.trystero) return p.trystero
  const s = p.trystero = { handlers: new Map(), routes: new Map(), rooms: new Map(), early: [] }
  const deliver = (from, body) => {
    if (body?.[TAG] !== 1 || typeof body.t !== 'string' || typeof body.st !== 'string') return
    s.routes.set(body.st, from)                                  // reply path: their topic → their verified address
    const fns = s.handlers.get(body.t)
    if (fns?.size) for (const fn of fns) fn(body.t, body.m)
    else s.early = [...s.early.filter(e => Date.now() - e.at < 10e3), { at: Date.now(), body }].slice(-64)   // before we subscribed
  }
  p.on(({ from, body }) => deliver(from, body))
  s.deliver = deliver
  return s
}

// A CORVAX topic per Trystero root topic: members (presence), a mesh (links), and the last announce to repeat.
async function room (p, s, root) {
  if (s.rooms.has(root)) return s.rooms.get(root)
  const r = { members: new Set(), announce: null, topic: await p.topic('trystero:' + root) }
  s.rooms.set(root, r)
  r.off = r.topic.subscribe({
    presence: e => {
      if (e.presence !== 'recent') return r.members.delete(e.address)
      if (r.members.has(e.address)) return
      r.members.add(e.address)
      if (r.announce) send(p, e.address, r.announce)             // a newcomer hears from us at once, not in 60 s
    },
    message: m => s.deliver(m.from, m.body)                      // announces flooded over the room's mesh
  })
  await r.topic.publish()
  return r
}

const send = (p, address, body) => p.topics.sendVia(address, body) || p.send(address, body).catch(() => {})

export const joinRoom = createTopicStrategy({
  init: config => corvaxPeer(config.corvax),

  subscribeTopic: async (p, topic, onMessage, { kind, rootTopic }) => {
    const s = wire(p)
    if (!s.handlers.has(topic)) s.handlers.set(topic, new Set())
    s.handlers.get(topic).add(onMessage)
    for (const e of s.early.filter(e => e.body.t === topic && Date.now() - e.at < 10e3)) onMessage(topic, e.body.m)
    s.early = s.early.filter(e => e.body.t !== topic)
    if (kind === 'root') await room(p, s, rootTopic)
    return () => {
      s.handlers.get(topic)?.delete(onMessage)
      if (kind !== 'root' || s.handlers.get(topic)?.size) return
      const r = s.rooms.get(rootTopic)
      s.rooms.delete(rootTopic)
      r?.off(); r?.topic.close().catch(() => {})
    }
  },

  publishTopic: async (p, topic, msg, { kind, rootTopic, selfTopic }) => {
    const s = wire(p), body = { [TAG]: 1, t: topic, st: selfTopic, m: msg }
    if (kind === 'announce') {
      const r = await room(p, s, rootTopic)
      r.announce = body
      r.topic.broadcast(body).catch(() => {})                   // over the mesh, if we have links
      for (const address of r.members) send(p, address, body)    // and straight to each member
      return
    }
    const address = s.routes.get(topic)                          // signals answer someone we heard from
    if (address) send(p, address, body)
  }
})

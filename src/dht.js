// A Kademlia node speaking the BitTorrent Mainline DHT protocol:
//   BEP 5 (ping, find_node, get_peers, announce_peer), BEP 43 (read-only nodes), BEP 44 (get, put).
// Sans-IO: give it send(bytes, {host, port}) and feed it packets with receive(bytes, from).
// Extra queries (cx_*) are plugged in through `handlers`, so one node serves both protocols.
import { encode, decode } from './bencode.js'
import { random, concat, hex, equal, compare, xor, utf8, str } from './bytes.js'
import { sha1, verify } from './crypto.js'
import { signable } from './record.js'

const K = 8, ALPHA = 3, TTL = 2 * 3600e3, PEER_TTL = 30 * 60e3, MAX_NODES = 1000, MAX_PEERS = 200
const key = n => `${n.host}:${n.port}`
const isV4 = h => /^\d+\.\d+\.\d+\.\d+$/.test(h)
const compactPeer = n => concat(Uint8Array.from(n.host.split('.').map(Number)), Uint8Array.of(n.port >> 8, n.port & 255))

export class DHT {
  constructor ({ send, id = random(20), timeout = 2000, ro = false }) {
    Object.assign(this, { send, id, timeout, ro })
    this.nodes = new Map()      // "host:port" -> { id, host, port, seen }  (nodes that answered us or queried us)
    this.store = new Map()      // hex(target) -> BEP 44 item { k, seq, sig, v, t }
    this.peers = new Map()      // hex(info_hash) -> Map("host:port" -> { host, port, t })
    this.pending = new Map()    // hex(transaction id) -> resolve
    this.handlers = {}          // extra queries: name -> async (a, from) => reply dict (throw [code, msg] to fail)
    this.secret = random(16)
    this.tid = random(2)[0] << 8
  }

  async receive (buf, from) {
    let m
    try { m = decode(buf) } catch { return }
    if (!m?.y || !(m.y instanceof Uint8Array)) return
    const y = str(m.y)
    if (y === 'r' || y === 'e') {
      const t = m.t && hex(m.t), done = this.pending.get(t)
      if (!done) return
      this.pending.delete(t)
      if (y === 'r' && m.r?.id?.length === 20 && !m.ro) this.#remember({ id: m.r.id, ...from })
      return done(y === 'r' ? m.r : null)
    }
    if (y !== 'q' || !(m.q instanceof Uint8Array) || !m.a) return
    const q = str(m.q), a = m.a
    const custom = this.handlers[q]
    if (this.ro && !custom) return                                       // BEP 43: read-only nodes don't serve the DHT
    if (a.id?.length === 20 && !m.ro && !this.ro) this.#remember({ id: a.id, ...from })
    let r
    try { r = await this.answer(q, a, from) } catch (e) {
      const [code, msg] = Array.isArray(e) ? e : [201, e.message || 'error']
      return this.send(encode({ t: m.t, y: 'e', e: [code, msg] }), from)
    }
    this.send(encode({ t: m.t, y: 'r', r: { id: this.id, ...r } }), from)
  }

  // Answers one query. Also used by the HTTP transport, which passes KRPC queries through here.
  async answer (q, a, from) {
    if (this.handlers[q]) return this.handlers[q](a, from)
    if (q === 'ping') return {}
    if (q === 'find_node') return { nodes: this.#compact(a.target) }
    if (q === 'get') {
      const item = this.#load(a.target)
      return { token: await this.token(from), nodes: this.#compact(a.target), ...(item && { k: item.k, seq: item.seq, sig: item.sig, v: item.v }) }
    }
    if (q === 'put') {
      if (!await this.#tokenOk(a.token, from)) throw [203, 'bad token']
      const err = await this.#save(a)
      if (err) throw err
      return {}
    }
    if (q === 'get_peers') {
      const peers = this.#peersFor(a.info_hash)
      return { token: await this.token(from), ...(peers.length ? { values: peers.map(compactPeer) } : { nodes: this.#compact(a.info_hash) }) }
    }
    if (q === 'announce_peer') {
      if (a.info_hash?.length !== 20 || !await this.#tokenOk(a.token, from)) throw [203, 'bad token']
      const port = a.implied_port ? from.port : a.port
      if (!(port > 0 && port < 65536) || !isV4(from.host)) throw [203, 'bad port']
      const h = hex(a.info_hash)
      if (!this.peers.has(h)) this.peers.set(h, new Map())
      const set = this.peers.get(h)
      set.set(`${from.host}:${port}`, { host: from.host, port, t: Date.now() })
      if (set.size > MAX_PEERS) set.delete(set.keys().next().value)
      return {}
    }
    throw [204, 'method unknown']
  }

  query (to, q, a = {}) {
    const t = Uint8Array.of(this.tid >> 8 & 255, this.tid & 255)
    this.tid = (this.tid + 1) & 0xffff
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(hex(t)); resolve(null) }, this.timeout)
      this.pending.set(hex(t), r => { clearTimeout(timer); resolve(r) })
      this.send(encode({ t, y: 'q', q, a: { id: this.id, ...a }, ...(this.ro && { ro: 1 }) }), to)
    })
  }

  async bootstrap (seeds) {
    await Promise.all(seeds.map(s => this.query(s, 'find_node', { target: this.id })))
    await this.lookup(this.id)
    return this.nodes.size
  }

  // Iterative Kademlia lookup: keep asking the closest unasked nodes until nothing closer turns up.
  async lookup (target, q = 'find_node', arg = 'target') {
    const cand = new Map(), asked = new Set(), answers = []
    const add = n => { if (!cand.has(key(n)) && !equal(n.id, this.id)) cand.set(key(n), { ...n, d: xor(n.id, target) }) }
    this.#closest(target, K * 2).forEach(add)
    for (let round = 0; round < 20; round++) {
      const next = [...cand.values()].sort((a, b) => compare(a.d, b.d)).slice(0, K).filter(n => !asked.has(key(n))).slice(0, ALPHA)
      if (!next.length) break
      await Promise.all(next.map(async n => {
        asked.add(key(n))
        const r = await this.query(n, q, { [arg]: target })
        if (!r) return cand.delete(key(n))
        answers.push({ node: n, r })
        parseNodes(r.nodes).forEach(add)
      }))
    }
    return answers.sort((a, b) => compare(a.node.d, b.node.d))
  }

  // BEP 44: newest valid item for target = SHA1(public key), from our store and the network.
  async get (target) {
    let best = this.#load(target)
    for (const { r } of await this.lookup(target, 'get')) {
      if (!r.v || !r.k || !r.sig || typeof r.seq !== 'number' || (best && best.seq >= r.seq)) continue
      if (equal(await sha1(r.k), target) && await verify(r.k, r.sig, signable(r.seq, r.v))) best = { k: r.k, seq: r.seq, sig: r.sig, v: r.v }
    }
    if (best) await this.#save(best)
    return best
  }

  // BEP 44: store locally, then on the K closest nodes. Returns how many accepted it.
  async put (item) {
    const err = await this.#save(item)
    if (err) throw new Error(err[1])
    const near = (await this.lookup(await sha1(item.k), 'get')).filter(x => x.r.token).slice(0, K)
    const acks = await Promise.all(near.map(({ node, r }) =>
      this.query(node, 'put', { token: r.token, k: item.k, seq: item.seq, sig: item.sig, v: item.v })))
    return acks.filter(Boolean).length
  }

  // BEP 5: everyone who announced info_hash, from our store and the network.
  async getPeers (infoHash) {
    const found = new Map(this.#peersFor(infoHash).map(p => [key(p), p]))
    for (const { r } of await this.lookup(infoHash, 'get_peers', 'info_hash')) {
      for (const v of Array.isArray(r.values) ? r.values : []) {
        if (v.length === 6) { const p = { host: v.subarray(0, 4).join('.'), port: v[4] << 8 | v[5] }; found.set(key(p), p) }
      }
    }
    return [...found.values()]
  }

  async announce (infoHash, port) {
    const near = (await this.lookup(infoHash, 'get_peers', 'info_hash')).filter(x => x.r.token).slice(0, K)
    const acks = await Promise.all(near.map(({ node, r }) =>
      this.query(node, 'announce_peer', { info_hash: infoHash, port, token: r.token, implied_port: port ? 0 : 1 })))
    return acks.filter(Boolean).length
  }

  close () { for (const done of this.pending.values()) done(null); this.pending.clear() }

  // Tokens: SHA1(secret | window | ip), valid for the current and previous 10-minute window.
  token (from, w = Math.floor(Date.now() / 600e3)) {
    return sha1(concat(this.secret, utf8(`${w}|${from.host}`))).then(h => h.slice(0, 8))
  }
  async #tokenOk (t, from) {
    if (!(t instanceof Uint8Array)) return false
    const w = Math.floor(Date.now() / 600e3)
    return equal(t, await this.token(from, w)) || equal(t, await this.token(from, w - 1))
  }

  #remember (n) {
    this.nodes.delete(key(n))
    this.nodes.set(key(n), { id: n.id, host: n.host, port: n.port, seen: Date.now() })
    if (this.nodes.size > MAX_NODES) this.nodes.delete(this.nodes.keys().next().value)   // drop oldest
  }
  #closest (target, n) {
    return [...this.nodes.values()].sort((a, b) => compare(xor(a.id, target), xor(b.id, target))).slice(0, n)
  }
  #compact (target) {
    if (!(target instanceof Uint8Array) || target.length !== 20) target = this.id
    return concat(...this.#closest(target, K).filter(n => isV4(n.host)).map(n => concat(n.id, compactPeer(n))))
  }
  #peersFor (infoHash) {
    const set = infoHash instanceof Uint8Array && this.peers.get(hex(infoHash))
    if (!set) return []
    for (const [k, p] of set) if (Date.now() - p.t > PEER_TTL) set.delete(k)
    return [...set.values()].slice(-50)
  }
  #load (target) {
    const item = target instanceof Uint8Array && this.store.get(hex(target))
    return item && Date.now() - item.t < TTL ? item : null
  }
  async #save ({ k, seq, sig, v }) {
    if (k?.length !== 32 || sig?.length !== 64 || !(v instanceof Uint8Array) || v.length > 1000 || typeof seq !== 'number') return [203, 'bad item']
    if (!await verify(k, sig, signable(seq, v))) return [206, 'bad signature']
    const t = hex(await sha1(k)), old = this.store.get(t)
    if (old && old.seq > seq) return [302, 'sequence number less than current']
    this.store.set(t, { k, seq, sig, v, t: Date.now() })
  }
}

function parseNodes (b) {
  const out = []
  for (let i = 0; b instanceof Uint8Array && i + 26 <= b.length; i += 26) {
    out.push({ id: b.slice(i, i + 20), host: b.subarray(i + 20, i + 24).join('.'), port: b[i + 24] << 8 | b[i + 25] })
  }
  return out.filter(n => n.port > 0)
}

export const ANCHOR_TOPIC = 'corvax anchors v1'      // Mainline infohash = SHA1 of this

export const MAINLINE = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 }
]

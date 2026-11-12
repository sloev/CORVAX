// A Kademlia node speaking the BitTorrent Mainline DHT protocol (BEP 5 + BEP 44 get/put).
// Sans-IO: give it a send(bytes, {host, port}) function and feed it packets with receive().
// It is a full node (answers queries and stores records), so a few of these form their own
// network, and pointing them at Mainline's bootstrap nodes joins the real BitTorrent DHT.
import { encode, decode } from './bencode.js'
import { random, concat, hex, equal, compare, xor, utf8 } from './bytes.js'
import { sha1, verify } from './crypto.js'
import { signable } from './record.js'

const K = 8, ALPHA = 3, TTL = 2 * 3600e3, MAX_NODES = 1000
const key = n => `${n.host}:${n.port}`

export class DHT {
  constructor ({ send, id = random(20), timeout = 2000 }) {
    Object.assign(this, { send, id, timeout })
    this.nodes = new Map()      // "host:port" -> { id, host, port, seen }   (only nodes that answered us)
    this.store = new Map()      // hex(target) -> { k, seq, sig, v, t }
    this.pending = new Map()    // hex(transaction id) -> resolve
    this.secret = random(16)
    this.tid = 0
  }

  // ---- incoming ----------------------------------------------------------------------------
  async receive (buf, from) {
    let m
    try { m = decode(buf) } catch { return }
    if (!m || !m.y) return
    const y = String.fromCharCode(m.y[0])
    if (y === 'r' || y === 'e') {
      const t = m.t && hex(m.t), done = this.pending.get(t)
      if (!done) return
      this.pending.delete(t)
      if (y === 'r' && m.r?.id?.length === 20) this.#remember({ id: m.r.id, ...from })
      return done(y === 'r' ? m.r : null)
    }
    if (y !== 'q' || !m.a?.id || !m.q) return
    if (m.a.id.length === 20 && !m.ro) this.#remember({ id: m.a.id, ...from })   // BEP 43: "ro" = client-only
    const reply = r => this.send(encode({ t: m.t, y: 'r', r: { id: this.id, ...r } }), from)
    const fail = (code, msg) => this.send(encode({ t: m.t, y: 'e', e: [code, msg] }), from)
    const a = m.a, q = new TextDecoder().decode(m.q)
    if (q === 'ping') return reply({})
    if (q === 'find_node' || q === 'get_peers') return reply({ nodes: this.#compact(a.target || a.info_hash) })
    if (q === 'get') {
      const item = this.#load(a.target)
      return reply({ token: await this.#token(from), nodes: this.#compact(a.target), ...(item && { k: item.k, seq: item.seq, sig: item.sig, v: item.v }) })
    }
    if (q === 'put') {
      if (!a.token || !equal(a.token, await this.#token(from))) return fail(203, 'bad token')
      const err = await this.#save(a)
      return err ? fail(...err) : reply({})
    }
    fail(204, 'method unknown')
  }

  // ---- outgoing ----------------------------------------------------------------------------
  query (to, q, a = {}) {
    const t = Uint8Array.of(this.tid >> 8 & 255, this.tid++ & 255)
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(hex(t)); resolve(null) }, this.timeout)
      this.pending.set(hex(t), r => { clearTimeout(timer); resolve(r) })
      this.send(encode({ t, y: 'q', q, a: { id: this.id, ...a } }), to)
    })
  }

  async bootstrap (seeds) {
    await Promise.all(seeds.map(s => this.query(s, 'find_node', { target: this.id })))
    await this.lookup(this.id)
    return this.nodes.size
  }

  // Iterative Kademlia lookup: keep asking the closest unasked nodes until nothing closer turns up.
  async lookup (target, q = 'find_node') {
    const cand = new Map(), asked = new Set(), answers = []
    const add = n => { if (!cand.has(key(n)) && !equal(n.id, this.id)) cand.set(key(n), { ...n, d: xor(n.id, target) }) }
    this.#closest(target, K * 2).forEach(add)
    for (let round = 0; round < 20; round++) {
      const next = [...cand.values()].sort((a, b) => compare(a.d, b.d)).slice(0, K).filter(n => !asked.has(key(n))).slice(0, ALPHA)
      if (!next.length) break
      await Promise.all(next.map(async n => {
        asked.add(key(n))
        const r = await this.query(n, q, { target })
        if (!r) return cand.delete(key(n))
        answers.push({ node: n, r })
        parseNodes(r.nodes).forEach(add)
      }))
    }
    return answers.sort((a, b) => compare(a.node.d, b.node.d))
  }

  async get (target) {
    let best = this.#load(target)
    for (const { r } of await this.lookup(target, 'get')) {
      if (!r.v || !r.k || !r.sig || (best && best.seq >= r.seq)) continue
      if (equal(await sha1(r.k), target) && await verify(r.k, r.sig, signable(r.seq, r.v))) best = { k: r.k, seq: r.seq, sig: r.sig, v: r.v }
    }
    return best
  }

  async put (item) {
    const err = await this.#save(item)
    if (err) throw new Error(err[1])
    const near = (await this.lookup(await sha1(item.k), 'get')).filter(x => x.r.token).slice(0, K)
    const acks = await Promise.all(near.map(({ node, r }) =>
      this.query(node, 'put', { token: r.token, k: item.k, seq: item.seq, sig: item.sig, v: item.v })))
    return acks.filter(Boolean).length
  }

  // ---- internals ---------------------------------------------------------------------------
  #remember (n) {
    this.nodes.delete(key(n))
    this.nodes.set(key(n), { id: n.id, host: n.host, port: n.port, seen: Date.now() })
    if (this.nodes.size > MAX_NODES) this.nodes.delete(this.nodes.keys().next().value)   // drop oldest
  }
  #closest (target, n) {
    return [...this.nodes.values()].sort((a, b) => compare(xor(a.id, target), xor(b.id, target))).slice(0, n)
  }
  #compact (target) {
    return concat(...this.#closest(target || this.id, K).filter(n => /^\d+\.\d+\.\d+\.\d+$/.test(n.host))
      .map(n => concat(n.id, Uint8Array.from(n.host.split('.').map(Number)), Uint8Array.of(n.port >> 8, n.port & 255))))
  }
  #token (from) { return sha1(concat(this.secret, utf8(from.host))).then(h => h.slice(0, 8)) }
  #load (target) {
    const item = target && this.store.get(hex(target))
    return item && Date.now() - item.t < TTL ? item : null
  }
  async #save ({ k, seq, sig, v }) {
    if (k?.length !== 32 || sig?.length !== 64 || !v || v.length > 1000 || typeof seq !== 'number') return [203, 'bad item']
    if (!await verify(k, sig, signable(seq, v))) return [206, 'bad signature']
    const t = hex(await sha1(k)), old = this.store.get(t)
    if (old && old.seq > seq) return [302, 'sequence number less than current']
    this.store.set(t, { k, seq, sig, v, t: Date.now() })
  }
}

export function parseNodes (b) {
  const out = []
  for (let i = 0; b && i + 26 <= b.length; i += 26) {
    out.push({ id: b.slice(i, i + 20), host: b.subarray(i + 20, i + 24).join('.'), port: b[i + 24] << 8 | b[i + 25] })
  }
  return out.filter(n => n.port > 0)
}

export const MAINLINE = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 }
]

// The peer: an identity that can announce itself, find others by address, and exchange
// end-to-end encrypted Letters with them through any anchor. Uses only WebSocket + WebCrypto,
// so the same file runs in browsers, Node 22+, Bun, Deno and Cloudflare Workers.
import { keypair, sign, shared, derive, aesKey, encrypt, decrypt } from './crypto.js'
import { makeBeacon, verifyBeacon, fields, pack, unpack } from './record.js'
import { b64, unb64, hex, unhex, utf8, str, z32, unz32, concat, u64, readU64, random, equal } from './bytes.js'

const MAX_AGE = 600e3

export class Peer {
  static async create ({ seed, anchors = [] } = {}) {
    const p = new Peer()
    p.kp = await keypair(seed && (typeof seed === 'string' ? unhex(seed) : seed))
    p.address = z32(p.kp.pub)
    p.seed = hex(p.kp.seed)
    p.anchors = anchors
    p.links = new Map()        // url -> Link
    p.keys = new Map()         // hex(pub) -> { aes, sh }
    p.seen = new Map()         // replay protection: hex(iv) -> time
    p.handlers = new Set()
    await Promise.all(anchors.map(u => p.link(u, true).ready.catch(() => {})))
    return p
  }

  // Announce: "Letters for me go to these anchors" (+ any extra fields), signed, into the DHT.
  async publish (extra = {}) {
    const rec = await makeBeacon(this.kp, { c: this.anchors, ...extra })
    const msg = { op: 'publish', pub: b64(rec.pub), rec: b64(pack(rec)) }
    const ok = await Promise.allSettled(this.anchors.map(u => this.link(u).request(msg)))
    if (!ok.some(r => r.status === 'fulfilled')) throw new Error('no anchor accepted the beacon')
    return rec
  }

  // Look up an address on every anchor we know; keep the newest validly signed record.
  async resolve (address) {
    const pub = unz32(address)
    let best = null
    await Promise.allSettled(this.anchors.map(async u => {
      const { rec } = await this.link(u).request({ op: 'resolve', pub: b64(pub) })
      const r = rec && unpack(pub, unb64(rec))
      if (r && (!best || r.seq > best.seq) && await verifyBeacon(r)) best = r
    }))
    return best && { address, seq: best.seq, ...fields(best) }
  }

  // Send an encrypted Letter (any JSON value). Tries the recipient's anchors, then our own.
  async send (address, body, beacon) {
    const to = unz32(address), letter = b64(await this.seal(to, body))
    beacon ??= await this.resolve(address).catch(() => null)
    const urls = [...new Set([...(beacon?.c || []), ...this.anchors])]
    for (const u of urls) {
      try { if ((await this.link(u).request({ op: 'send', to: b64(to), letter })).delivered) return true } catch {}
    }
    return false     // queued (for ~2 minutes) on the anchors that accepted it
  }

  on (fn) { this.handlers.add(fn); return () => this.handlers.delete(fn) }
  close () { for (const l of this.links.values()) l.close() }

  // ---- Letters: from(32) | iv(12) | AES-GCM( timestamp(8) | JSON ) under K_ab ------------------
  async key (pub) {
    let k = this.keys.get(hex(pub))
    if (!k) {
      const sh = await shared(this.kp, pub)
      this.keys.set(hex(pub), k = { sh, aes: await aesKey(await derive(sh, 'cx/letter')) })
    }
    return k
  }
  async seal (to, body) {
    const iv = random(12)
    const pt = concat(u64(Date.now()), utf8(JSON.stringify(body)))
    return concat(this.kp.pub, iv, await encrypt((await this.key(to)).aes, iv, pt))
  }
  async open (letter) {
    const from = letter.slice(0, 32), iv = letter.slice(32, 44)
    const pt = await decrypt((await this.key(from)).aes, iv, letter.slice(44))
    const ts = readU64(pt), now = Date.now()
    if (Math.abs(now - ts) > MAX_AGE || this.seen.has(hex(iv))) throw new Error('stale or replayed letter')
    this.seen.set(hex(iv), now)
    for (const [k, t] of this.seen) if (now - t > MAX_AGE) this.seen.delete(k)
    return { from: z32(from), body: JSON.parse(str(pt.slice(8))) }
  }
  async #onLetter (letter) {
    let msg
    try { msg = await this.open(unb64(letter)) } catch { return }
    if (equal(unz32(msg.from), this.kp.pub)) return
    for (const fn of this.handlers) fn(msg)
  }

  // A WebSocket to an anchor, with request/response and (for our own anchors) auto-reconnect.
  link (url, home = false) {
    let l = this.links.get(url)
    if (l) return l
    const pending = new Map()
    let n = 0, ws, closed = false, wait = 500
    l = {
      request: m => l.ready.then(() => new Promise((resolve, reject) => {
        const id = n++
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')) }, 10000)
        pending.set(id, r => { clearTimeout(timer); r.ok ? resolve(r) : reject(new Error(r.error)) })
        ws.send(JSON.stringify({ ...m, id }))
      })),
      close: () => { closed = true; ws?.close() }
    }
    const connect = () => {
      l.ready = new Promise((resolve, reject) => {
        ws = new WebSocket(url)
        ws.onopen = async () => {
          wait = 500
          if (home) {
            const ts = Date.now()
            ws.send(JSON.stringify({ op: 'hello', pub: b64(this.kp.pub), ts, sig: b64(await sign(this.kp, utf8(`cx-hello:${ts}`))) }))
          }
          resolve()
        }
        ws.onmessage = e => {
          const m = JSON.parse(e.data)
          if (m.op === 'letter') this.#onLetter(m.letter)
          else pending.get(m.id)?.(m), pending.delete(m.id)
        }
        ws.onerror = () => reject(new Error(`cannot reach ${url}`))
        ws.onclose = () => {
          for (const fn of pending.values()) fn({ ok: false, error: 'connection closed' })
          pending.clear()
          if (closed) return
          if (!home) return this.links.delete(url)
          setTimeout(connect, wait = Math.min(wait * 2, 30000))
        }
      })
      l.ready.catch(() => {})
    }
    connect()
    this.links.set(url, l)
    return l
  }
}

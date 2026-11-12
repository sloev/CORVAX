// A native CORVAX node (Node, Bun, Deno): a Peer plus everything only native runtimes can do.
//   one port number: UDP (DHT · STUN · cx_*) + TCP (HTTP: homepage, /krpc, library)
//   LAN discovery, Mainline DHT, a file cache, and automatic promotion to anchor when reachable.
import { createSocket } from 'node:dgram'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { DHT, MAINLINE, ANCHOR_TOPIC } from './dht.js'
import { Book, formatLine } from './book.js'
import { Peer, hostUrl } from './peer.js'
import { identity, sha1, random, hiOk } from './crypto.js'
import { installHandlers, httpServer, Inboxes, post } from './anchor.js'
import { startLan } from './lan.js'
import { isStun, stunReply } from './stun.js'
import { TopicStore } from './store.js'
import { hex, unhex, utf8, str, z32, unz32 } from './bytes.js'

const DIR = join(homedir(), '.config', 'corvax')

export async function start (o = {}) {
  const node = new CorvaxNode(o)
  await node.start()
  return node
}

export class CorvaxNode {
  constructor (o) {
    this.o = {
      port: 4799, host: '0.0.0.0', anchor: 'auto', storage: true, lan: true, lanPort: 4798, mdns: true, mainline: false,
      seedFile: join(DIR, 'seed'), cacheFile: join(DIR, 'anchors.txt'),
      intervals: { probe: 600e3, check: 1800e3 }, log: () => {}, ...o
    }
    this.port = this.o.port
    this.host = this.o.host
    this.web = this.o.web || null
    this.isAnchor = false        // = publicly reachable (verified by a stranger). The only thing that makes a peer an anchor.
    this.publicHost = this.o.publicHost || null
    this.inboxes = new Inboxes()
    this.store = this.o.storage ? new TopicStore(this.o.store) : null
    this.timers = []
  }

  line () { return this.isAnchor ? formatLine({ key: this.key, host: this.publicHost, port: this.port, web: this.web }) : null }
  // What this node tells everyone: its own line first, then its shared view of the book (without itself).
  listing () {
    const own = this.line(), rest = this.book.shared().split('\n').filter(l => l && !l.startsWith(`corvax-anchor:${this.key}@`))
    return [own, ...rest].filter(Boolean).join('\n')
  }
  // Capabilities are the same for every peer; reachability only decides who can use them.
  services () { return ['udp', 'http', ...(this.storing() ? ['storage'] : []), ...(this.peer?.RTC && this.peer.relayFor ? ['relay'] : [])] }
  storing () { return !!this.store }

  async start () {
    const o = this.o, log = o.log
    this.started = Date.now()
    this.id = await identity(o.seed ? (typeof o.seed === 'string' ? unhex(o.seed) : o.seed) : await this.#seed())
    this.key = z32(this.id.pub)
    this.book = new Book({ allowPrivate: o.allowPrivate })
    this.book.add(await readFile(o.cacheFile, 'utf8').catch(() => ''))
    for (const t of o.anchors || []) this.book.add(t)

    // UDP: STUN and KRPC share the port
    this.udp = createSocket('udp4')
    this.dht = new DHT({ send: (b, to) => { try { this.udp.send(b, to.port, to.host) } catch {} }, id: (await sha1(this.id.pub)), ro: true })
    this.udp.on('message', (b, r) => {
      const from = { host: r.address, port: r.port }
      if (isStun(b)) this.udp.send(stunReply(b, from), r.port, r.address)
      else this.dht.receive(new Uint8Array(b), from)
    })
    this.udp.on('error', e => log('udp', e.message))
    await new Promise((resolve, reject) => { this.udp.once('error', reject); this.udp.bind(this.port, this.host, resolve) })
    this.port = this.udp.address().port
    installHandlers(this)
    this.http = httpServer(this)
    await new Promise((resolve, reject) => { this.http.once('error', reject); this.http.listen(this.port, this.host, resolve) })

    if (o.lan) {
      this.lan = await startLan({ port: o.lanPort, mdns: o.mdns, lines: () => this.listing(), onFound: t => this.book.add(t, { lan: true }) }).catch(() => null)
    }
    if (o.mainline) this.dht.bootstrap(MAINLINE).then(n => log(`mainline: ${n} nodes`)).catch(() => {})

    // Find anchors on every native channel, then verify them over UDP and HTTP.
    await this.discover()
    if (o.anchor === 'force') this.#promote(o.publicHost || '127.0.0.1')
    else if (o.anchor === 'auto') await this.check()

    this.peer = await Peer.create({
      seed: this.id.seed, book: this.book, allowPrivate: o.allowPrivate, relayFor: o.relayFor,
      RTCPeerConnection: o.RTCPeerConnection, relayLimits: o.relayLimits, store: this.store,
      sources: o.sources, dohDomains: o.dohDomains,
      self: this.isAnchor ? { key: this.key, line: this.line(), url: `http://127.0.0.1:${this.port}` } : null,
      platform: {
        loadCache: () => '',
        saveCache: t => this.#saveCache(t),
        probe: entries => this.probe(entries),
        dnsTxt: name => import('node:dns/promises').then(d => d.resolveTxt(name)).then(r => r.map(x => x.join('')).join('\n'))
      }
    })
    if (this.storing()) { const me = this.book.get(this.key); if (me) me.storage = true }
    if (this.peer.inboxes.length) await this.peer.publish().catch(e => log('publish', e.message))
    if (this.isAnchor) await this.#announce()

    const every = (ms, fn) => { const t = setInterval(() => fn().catch(e => log(e.message)), ms); t.unref?.(); this.timers.push(t) }
    every(o.intervals.probe, () => this.maintain())
    every(o.intervals.check, () => o.anchor === 'auto' ? this.check() : Promise.resolve())
    every(60e3, async () => this.inboxes.sweep())
    every(30e3, async () => this.store?.sweep())
    log(`corvax ${this.isAnchor ? 'anchor' : 'node'} ${this.key} on udp+tcp :${this.port}`)
    return this
  }

  // LAN + Mainline + book, then verify what we found.
  async discover () {
    if (this.lan) { this.lan.discover(); await new Promise(resolve => setTimeout(resolve, 600)) }
    if (this.o.mainline) {
      const found = await this.dht.getPeers(await sha1(utf8(ANCHOR_TOPIC))).catch(() => [])
      await Promise.all(found.slice(0, 32).map(p => this.hiUdp(p).catch(() => {})))
    }
    await this.probe(this.book.due(64))
  }

  // cx_hi to an address known only as ip:port (Mainline results): learns its key and anchor line.
  async hiUdp ({ host, port }) {
    const n = random(16), r = await this.dht.query({ host, port }, 'cx_hi', { n })
    if (r?.line && await hiOk(r, r.k, n)) this.book.add(str(r.line))
  }

  // Probe entries over UDP and HTTP: identity, per-service reachability, storage flag.
  async probe (entries) {
    await Promise.all(entries.filter(e => e.key !== this.key).map(async e => {
      const n = random(16), key = unz32(e.key), t0 = Date.now()
      for (const [service, r] of [['udp', await this.dht.query({ host: e.host, port: e.port }, 'cx_hi', { n })],
        ['http', await post(e.web || hostUrl(e), 'cx_hi', { n }).catch(() => null)]]) {
        if (!this.book.get(e.key)) return
        if (r && !await hiOk(r, key, n)) return this.book.record(e.key, 'id', false)    // someone else's key: dropped
        if (r) { this.book.record(e.key, 'id', true); Object.assign(this.book.get(e.key), { storage: !!r.st, relay: !!r.rl }) }
        this.book.record(e.key, service, !!r, Date.now() - t0)
      }
    }))
  }

  // Ask an anchor whether strangers can reach our UDP and HTTP; become an anchor if so.
  async check () {
    for (const e of this.book.best(4, 'native', e => e.verified && e.key !== this.key)) {
      const r = await this.dht.query({ host: e.host, port: e.port }, 'cx_check', { k: this.id.pub, port: this.port, hport: this.port })
      if (!r) continue
      if (r.udp && r.http) this.#promote(this.o.publicHost || str(r.ip))
      else this.#demote()
      return
    }
  }
  #promote (host) {
    if (this.isAnchor && this.publicHost === host) return
    this.isAnchor = true
    this.publicHost = host
    this.dht.ro = false
    this.o.log(`promoted to anchor: ${this.line()}`)
  }
  #demote () { this.isAnchor = false; this.dht.ro = true }

  // Tell known anchors about us, and announce on the Mainline anchor topic.
  async #announce () {
    const me = utf8(this.line())
    await Promise.all(this.book.best(8, 'native', e => e.verified && e.key !== this.key).map(e =>
      this.dht.query({ host: e.host, port: e.port }, 'cx_anchors', { me }).then(r => r?.a && this.book.add(str(r.a)))))
    if (this.o.mainline) await this.dht.announce(await sha1(utf8(ANCHOR_TOPIC)), this.port).catch(() => {})
  }

  // Every 10 minutes: re-probe, pull anchor lists from 3 random anchors, prune, save.
  async maintain () {
    await this.probe(this.book.due(64))
    const verified = this.book.best(100, 'native', e => e.verified && e.key !== this.key).sort(() => Math.random() - 0.5).slice(0, 3)
    await Promise.all(verified.map(e => this.dht.query({ host: e.host, port: e.port }, 'cx_anchors', this.isAnchor ? { me: utf8(this.line()) } : {})
      .then(r => r?.a && this.book.add(str(r.a)))))
    if (this.isAnchor && this.o.mainline) await this.dht.announce(await sha1(utf8(ANCHOR_TOPIC)), this.port).catch(() => {})
    this.book.prune()
    await this.#saveCache(this.book.toText())
  }

  async #seed () {
    try { return unhex((await readFile(this.o.seedFile, 'utf8')).trim()) } catch {}
    const seed = random(32)
    await mkdir(dirname(this.o.seedFile), { recursive: true })
    await writeFile(this.o.seedFile, hex(seed), { mode: 0o600 })
    return seed
  }
  async #saveCache (text) {
    if (!this.o.cacheFile) return
    try { await mkdir(dirname(this.o.cacheFile), { recursive: true }); await writeFile(this.o.cacheFile, text) } catch {}
  }

  async close () {
    for (const t of this.timers) clearInterval(t)
    this.inboxes.close()
    this.store?.close()
    await this.peer?.close()
    this.lan?.close()
    this.dht.close()
    try { this.udp.close() } catch {}
    this.http.closeAllConnections?.()
    await new Promise(resolve => this.http.close(resolve))
  }
}

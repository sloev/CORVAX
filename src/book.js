// The anchor book: a verified, scored list of anchors (the bootstrap nodes).
//   line:   corvax-anchor:<z32 key>@<host>:<port>[;web=<https origin>][;q=<0-100>]
// Lines are claims. An entry becomes "verified" only after the anchor signs a random nonce
// (cx_hi), and each service (http, udp, rtc) is scored separately from our own probes.
import { z32, unz32 } from './bytes.js'

export const LINE_RE = /corvax-anchor:[^\s"'<>`]+/g
const ALPHA = 0.2, MAX = 1000, MAX_LINE = 255, DAY = 86400e3

export function parseLine (s) {
  if (s.length > MAX_LINE) return null
  const m = /^corvax-anchor:([a-z0-9]{52})@(\[[0-9a-f:.]+\]|[0-9.]+|[a-z0-9.-]+):(\d{1,5})((?:;[a-z]+=[^;\s]*)*)$/i.exec(s)
  if (!m) return null
  try { if (unz32(m[1]).length !== 32) return null } catch { return null }
  const port = +m[3]
  if (!port || port > 65535) return null
  const e = { key: m[1].toLowerCase(), host: m[2].replace(/^\[|\]$/g, '').toLowerCase(), port }
  for (const kv of m[4].split(';').slice(1)) {
    const [k, v] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]
    if (k === 'web' && /^https?:\/\/[^\s/]+$/.test(v)) e.web = v
    if (k === 'q' && /^\d{1,3}$/.test(v)) e.hint = Math.min(100, +v)
  }
  return e
}

export function formatLine (e, q) {
  const host = e.host.includes(':') ? `[${e.host}]` : e.host
  return `corvax-anchor:${e.key}@${host}:${e.port}${e.web ? `;web=${e.web}` : ''}${q !== undefined ? `;q=${q}` : ''}`
}

// Public unicast only (private, loopback, link-local, CGNAT, multicast and documentation ranges are refused).
export function isPublic (host) {
  if (host.includes(':')) return !/^(::1?$|f[cd]|fe[89ab]|ff|2001:db8)/i.test(host)
  const p = host.split('.').map(Number)
  if (p.length !== 4) return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)    // a DNS name
  const [a, b] = p
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0))
}

export class Book {
  constructor ({ allowPrivate = false, now = () => Date.now() } = {}) {
    this.entries = new Map()     // key -> entry
    this.allowPrivate = allowPrivate
    this.now = now
  }

  // Merge every anchor line found in any text. Returns the entries that were new.
  add (text, { lan = false } = {}) {
    const added = []
    for (const raw of String(text).match(LINE_RE) || []) {
      const e = parseLine(raw.replace(/[.,;:!?)\]}]+$/, ''))   // lines quoted in prose end in punctuation
      if (!e || (!lan && !this.allowPrivate && !isPublic(e.host))) continue
      const old = this.entries.get(e.key)
      if (old) {
        if (!old.verified) Object.assign(old, { host: e.host, port: e.port, web: e.web ?? old.web })
        old.hint = Math.max(old.hint ?? 0, e.hint ?? 0)
        continue
      }
      const entry = { ...e, verified: false, first: this.now(), lastOk: 0, lastProbe: 0, lan }
      this.entries.set(e.key, entry); added.push(entry)
    }
    if (this.entries.size > MAX) this.prune(true)
    return added
  }

  get (key) { return this.entries.get(key) }
  remove (key) { this.entries.delete(key) }

  // Record one probe result. service: 'id' | 'http' | 'udp' | 'rtc'
  record (key, service, ok, rtt) {
    const e = this.entries.get(key)
    if (!e) return
    e.lastProbe = this.now()
    if (service === 'id') {
      if (!ok) return this.entries.delete(key)                 // wrong key behind this address: drop the line
      e.verified = true
    } else {
      e[service] = e[service] === undefined ? (ok ? 1 : 0) : e[service] * (1 - ALPHA) + (ok ? ALPHA : 0)
    }
    if (ok) e.lastOk = this.now()
    if (ok && rtt !== undefined) e.rtt = e.rtt === undefined ? rtt : e.rtt * 0.8 + rtt * 0.2
  }

  // 0..100. Unverified entries only count their hint, capped at 50.
  score (e, mode = 'native') {
    if (!e.verified) return Math.min(e.hint ?? 0, 50)
    const ok = mode === 'browser' ? (e.http ?? 0) : Math.max(e.udp ?? 0, e.http ?? 0)
    const age = Math.min(1, (this.now() - e.first) / (7 * DAY))
    return Math.round(100 * ok * (0.6 + 0.4 * Math.sqrt(age)))
  }

  best (n = 32, mode = 'native', filter = () => true) {
    return [...this.entries.values()].filter(filter)
      .sort((a, b) => this.score(b, mode) - this.score(a, mode) || (a.rtt ?? 1e9) - (b.rtt ?? 1e9))
      .slice(0, n)
  }

  // What we share with others: best 32 + 8 random others (so new anchors spread), never LAN-only entries.
  shared (mode = 'native') {
    const pub = e => !e.lan && (this.allowPrivate || isPublic(e.host))
    const top = this.best(32, mode, pub), rest = [...this.entries.values()].filter(e => pub(e) && !top.includes(e))
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]] }
    return [...top, ...rest.slice(0, 8)].map(e => formatLine(e, this.score(e, mode))).join('\n')
  }

  // Entries due for a probe: unverified first (at most `fresh` of them), then the longest unprobed.
  due (n = 64, fresh = 16) {
    const all = [...this.entries.values()].sort((a, b) => a.lastProbe - b.lastProbe)
    const unverified = all.filter(e => !e.verified).slice(0, fresh)
    return [...unverified, ...all.filter(e => e.verified)].slice(0, n)
  }

  prune (force = false) {
    for (const [k, e] of this.entries) {
      if (this.score(e) < 10 && this.now() - (e.lastOk || e.first) > 7 * DAY) this.entries.delete(k)
    }
    if (force) for (const e of this.best(Infinity).slice(MAX)) this.entries.delete(e.key)
  }

  // Cache format: plain anchor lines (with our score as hint).
  toText () { return this.best(MAX).map(e => formatLine(e, this.score(e))).join('\n') }
}

export const keyOf = pub => z32(pub)

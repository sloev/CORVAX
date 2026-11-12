// Topic wire formats (cx/1): names → ids, signed provider records, signed broadcast frames.
//   topic id  = SHA-256("cx/topic:" ‖ normalize(name))
//   record    = bencode { t, k, seq, exp, sig }   sig = Ed25519("cx-topic" ‖ bencode{ t, k, seq, exp })
//   frame     = bencode { t, id, ts, from, body, p, hop, sig }   sig = Ed25519("cx-tb" ‖ bencode{ t, id, ts, from, body })
import { encode, decode } from './bencode.js'
import { sign, verify, sha256, random } from './crypto.js'
import { utf8, concat, equal } from './bytes.js'

export const LIMITS = {
  lease: 600e3, skew: 60e3, renew: 300e3, jitter: 0.2,
  // placement: 4 XOR-closest *established* storage peers + 1 random one (anti-eclipse, spreads load);
  // search asks 6 + 2, watch polls the 4 closest. Established = book score ≥ 75 (verified, up, known a while).
  closest: 4, random: 1, searchClosest: 6, searchRandom: 2, watchClosest: 4, maxNodes: 8, established: 75,
  body: 1024, frame: 4096, age: 120e3, future: 60e3, hops: 4, fanout: 3,
  neighbours: 4, links: 16, rate: 10, dedup: 600e3
}

export function normalize (name) {
  const n = String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  const len = utf8(n).length
  if (len < 1 || len > 200) throw Object.assign(new Error('topic name must be 1-200 bytes'), { code: 'bad-topic' })
  return n
}
export const topicId = async name => sha256(utf8('cx/topic:' + normalize(name)))

const is = (b, n) => b instanceof Uint8Array && b.length === n
const int = x => Number.isSafeInteger(x)

// ---- provider records ------------------------------------------------------------------------
export async function makeRecord (id, t, seq, exp) {
  const fields = encode({ t, k: id.pub, seq, exp })
  return encode({ t, k: id.pub, seq, exp, sig: await sign(id, concat(utf8('cx-topic'), fields)) })
}

// Decode and verify. Returns { t, k, seq, exp, raw } or null. Accepts raw bytes or a decoded dict.
export async function readRecord (raw) {
  let r
  try { r = raw instanceof Uint8Array ? decode(raw) : raw } catch { return null }
  if (!r || !is(r.t, 32) || !is(r.k, 32) || !int(r.seq) || r.seq < 0 || !int(r.exp) || !is(r.sig, 64)) return null
  const fields = encode({ t: r.t, k: r.k, seq: r.seq, exp: r.exp })
  if (!await verify(r.k, r.sig, concat(utf8('cx-topic'), fields))) return null
  return { t: r.t, k: r.k, seq: r.seq, exp: r.exp, raw: encode({ t: r.t, k: r.k, seq: r.seq, exp: r.exp, sig: r.sig }) }
}

// ---- broadcast frames ----------------------------------------------------------------------------
export async function makeFrame (id, t, body, record, hop = LIMITS.hops) {
  const msg = { t, id: random(16), ts: Date.now(), from: id.pub, body }
  return { ...msg, p: record, hop, sig: await sign(id, concat(utf8('cx-tb'), encode(msg))) }
}
export const encodeFrame = f => encode(f)

// Full check of a received frame (everything except duplicates and rate, which need state).
// Returns { frame, rec } or a reason string.
export async function checkFrame (bytes, topic, now = Date.now(), limits = LIMITS) {
  if (!(bytes instanceof Uint8Array) || bytes.length > limits.frame) return 'size'
  let f
  try { f = decode(bytes) } catch { return 'encoding' }
  if (!f || !is(f.t, 32) || !is(f.id, 16) || !int(f.ts) || !is(f.from, 32) || !(f.body instanceof Uint8Array) ||
      !(f.p instanceof Uint8Array) || !int(f.hop) || !is(f.sig, 64)) return 'encoding'
  if (!equal(f.t, topic)) return 'topic'
  if (f.body.length > limits.body) return 'size'
  if (f.hop < 1 || f.hop > limits.hops) return 'hop'
  if (now - f.ts > limits.age || f.ts - now > limits.future) return 'age'
  const signed = encode({ t: f.t, id: f.id, ts: f.ts, from: f.from, body: f.body })
  if (!await verify(f.from, f.sig, concat(utf8('cx-tb'), signed))) return 'signature'
  const rec = await readRecord(f.p)
  if (!rec || !equal(rec.t, f.t) || !equal(rec.k, f.from) || rec.exp < now - limits.skew) return 'eligibility'
  return { frame: f, rec }
}

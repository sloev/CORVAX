// The Beacon: a pkarr-compatible signed DNS packet (BEP 44 mutable item, keyed by the Ed25519 key).
// Wire format (same as pkarr relays): sig(64) | seq(8, big-endian microseconds) | DNS packet (<= 1000 bytes)
// Content: TXT records "_cx" = "key=value", e.g. c=wss://anchor.example (where to deliver Letters).
import { utf8, str, concat, u64, readU64 } from './bytes.js'
import { encode } from './bencode.js'
import { sign, verify, sha1 } from './crypto.js'

// BEP 44: the signature covers the bencoded "seq" and "v" (and "salt", which we don't use).
export const signable = (seq, v) => concat(utf8('3:seq'), encode(seq), utf8('1:v'), encode(v))
export const target = pub => sha1(pub)                              // DHT key = SHA1(public key)

export async function makeBeacon (kp, fields, seq = Date.now() * 1000) {
  const txt = Object.entries(fields).flatMap(([k, vals]) => [].concat(vals).map(x => `${k}=${x}`))
  const v = dnsEncode(txt)
  if (v.length > 1000) throw new Error('beacon too large')
  return { pub: kp.pub, seq, v, sig: await sign(kp, signable(seq, v)) }
}
export const verifyBeacon = r => r.v.length <= 1000 && verify(r.pub, r.sig, signable(r.seq, r.v))
export const pack = r => concat(r.sig, u64(r.seq), r.v)
export const unpack = (pub, b) => ({ pub, sig: b.slice(0, 64), seq: readU64(b.subarray(64, 72)), v: b.slice(72) })

export function fields (r) {
  const out = {}
  for (const t of dnsDecode(r.v)) {
    const i = t.indexOf('=')
    if (i > 0) (out[t.slice(0, i)] ??= []).push(t.slice(i + 1))
  }
  return out
}

// Minimal DNS packet: a response holding TXT records named "_cx".
const NAME = concat(Uint8Array.of(3), utf8('_cx'), Uint8Array.of(0))
function dnsEncode (txts) {
  const rrs = txts.map(t => {
    const s = utf8(t)
    if (s.length > 255) throw new Error('TXT value too long')
    const rr = new Uint8Array(NAME.length + 11 + s.length), v = new DataView(rr.buffer)
    rr.set(NAME); let o = NAME.length
    v.setUint16(o, 16); v.setUint16(o + 2, 1); v.setUint32(o + 4, 300); v.setUint16(o + 8, s.length + 1)
    rr[o + 10] = s.length; rr.set(s, o + 11)
    return rr
  })
  const head = new Uint8Array(12), v = new DataView(head.buffer)
  v.setUint16(2, 0x8400); v.setUint16(6, rrs.length)
  return concat(head, ...rrs)
}
function dnsDecode (b) {
  const v = new DataView(b.buffer, b.byteOffset, b.length), out = []
  const skipName = o => { while (b[o]) { if (b[o] >= 0xc0) return o + 2; o += b[o] + 1 } return o + 1 }
  let o = 12
  for (let q = v.getUint16(4); q--;) o = skipName(o) + 4               // skip any questions
  for (let n = v.getUint16(6); n-- && o < b.length;) {
    o = skipName(o)
    const type = v.getUint16(o), len = v.getUint16(o + 8)
    o += 10
    if (type === 16) for (let p = o; p < o + len; p += b[p] + 1) out.push(str(b.subarray(p + 1, p + 1 + b[p])))
    o += len
  }
  return out
}

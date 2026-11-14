// Messages: sealed to the recipient's X25519 key with a fresh ephemeral key, signed by the sender.
//   wire  = eph_x 32 | iv 12 | AES-GCM_K( inner | Ed25519 sig(inner) )
//   K     = HKDF( X25519(eph, recipient_x), "cx/msg" | eph_x | recipient_x )
//   inner = bencode { from, to, id, ts, body }      body = UTF-8 JSON, or z = deflate-raw(UTF-8 JSON) when that is smaller
//                                                   (only sent to peers whose Beacon says v ≥ 2)
import { identity, sign, verify, ephemeral, ecdh, hkdf, aesKey, encrypt, decrypt, random, concat } from './crypto.js'
import { encode, decode } from './bencode.js'
import { utf8, str, equal, hex } from './bytes.js'

export const MAX_MESSAGE = 16384                     // sealed bytes; fits a full WebRTC offer (Trystero, SDP)
export const MAX_AGE = 600e3
export const CAN_INFLATE = typeof DecompressionStream === 'function' && typeof CompressionStream === 'function'
const pipe = async (bytes, stream, max = Infinity) => {
  const w = stream.writable.getWriter(), parts = []
  w.write(bytes).catch(() => {}); w.close().catch(() => {})
  let n = 0
  for (const r = stream.readable.getReader(); ;) {
    const { done, value } = await r.read()
    if (done) break
    if ((n += value.length) > max) { r.cancel().catch(() => {}); throw new Error('too large') }
    parts.push(value)
  }
  return concat(...parts)
}

const key = async (shared, ephX, toX) => aesKey(await hkdf(shared, concat(utf8('cx/msg'), ephX, toX)))

export async function seal (me, to, toX, body, compress = false) {
  const eph = await ephemeral(), json = utf8(JSON.stringify(body))
  const z = compress && CAN_INFLATE && json.length > 200 ? await pipe(json, new CompressionStream('deflate-raw')) : null
  const inner = encode({ from: me.pub, to, id: random(16), ts: Date.now(), ...(z && z.length < json.length ? { z } : { body: json }) })
  const iv = random(12)
  const out = concat(eph.pub, iv, await encrypt(await key(await ecdh(eph.priv, toX), eph.pub, toX), iv, concat(inner, await sign(me, inner))))
  if (out.length > MAX_MESSAGE) throw new Error('message too large')
  return out
}

// Returns { from, id, ts, body } or throws. Replay (seen id) is checked by the caller.
export async function open (me, wire) {
  if (wire.length > MAX_MESSAGE || wire.length < 32 + 12 + 16 + 64) throw new Error('bad size')
  const ephX = wire.subarray(0, 32)
  const pt = await decrypt(await key(await ecdh(me.xpriv, ephX), ephX, me.xpub), wire.subarray(32, 44), wire.subarray(44))
  const inner = pt.subarray(0, pt.length - 64)
  const m = decode(inner)
  if (m.from?.length !== 32 || !m.to || !equal(m.to, me.pub)) throw new Error('not for me')
  if (!await verify(m.from, pt.subarray(pt.length - 64), inner)) throw new Error('bad signature')
  if (typeof m.ts !== 'number' || Math.abs(Date.now() - m.ts) > MAX_AGE) throw new Error('stale')
  const json = m.z ? await pipe(m.z, new DecompressionStream('deflate-raw'), 4 * MAX_MESSAGE) : m.body      // inflates to ≤ 64 KB
  return { from: m.from, id: hex(m.id), ts: m.ts, body: JSON.parse(str(json)) }
}

export { identity }

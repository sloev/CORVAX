// Byte helpers (Uint8Array everywhere, so it runs in every JS runtime) and a few shared utilities.
export const utf8 = s => new TextEncoder().encode(s)
export const str = b => new TextDecoder().decode(b)
export const random = n => crypto.getRandomValues(new Uint8Array(n))
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const unhex = s => Uint8Array.from(s.match(/../g) || [], h => parseInt(h, 16))
export const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
export const compare = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }
export const xor = (a, b) => a.map((x, i) => x ^ b[i])

export const b64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

export const u64 = n => { const b = new Uint8Array(8), v = new DataView(b.buffer); v.setUint32(0, Math.floor(n / 2 ** 32)); v.setUint32(4, n >>> 0); return b }
export const readU64 = b => { const v = new DataView(b.buffer, b.byteOffset, 8); return v.getUint32(0) * 2 ** 32 + v.getUint32(4) }

// z-base32: the address encoding used by pkarr and iroh (52 chars for a 32-byte key).
const Z = 'ybndrfg8ejkmcpqxot1uwisza345h769'
export const z32 = b => {
  let bits = 0, v = 0, out = ''
  for (const x of b) {
    v = (v << 8) | x; bits += 8
    while (bits >= 5) { out += Z[(v >>> (bits - 5)) & 31]; bits -= 5 }
    v &= (1 << bits) - 1
  }
  return bits ? out + Z[(v << (5 - bits)) & 31] : out
}
export const unz32 = s => {
  let bits = 0, v = 0
  const out = []
  for (const c of s.toLowerCase()) {
    const i = Z.indexOf(c)
    if (i < 0) throw new Error('invalid address')
    v = (v << 5) | i; bits += 5
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; v &= (1 << bits) - 1 }
  }
  return Uint8Array.from(out)
}

export class CorvaxError extends Error { constructor (code, message) { super(message || code); this.code = code } }
export const fail = (code, message) => new CorvaxError(code, message)
// Read a fetch body (Request or Response) of at most max bytes; null if it is larger.
export async function readCapped (r, max) {
  if (+r.headers.get('content-length') > max) return null
  const reader = r.body?.getReader(), parts = []
  for (let n = 0, c; reader && !(c = await reader.read()).done;) {
    if ((n += c.value.length) > max) { reader.cancel().catch(() => {}); return null }
    parts.push(c.value)
  }
  return concat(...parts)
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const unref = t => { t?.unref?.(); return t }
export const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
export const bytesOf = d => d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null
export const toWire = u8 => typeof Buffer !== 'undefined' ? Buffer.from(u8.buffer, u8.byteOffset, u8.length) : u8   // werift wants Buffer

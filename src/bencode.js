// Bencode, as used by the BitTorrent DHT (BEP 3).
import { utf8, str, concat } from './bytes.js'

export function encode (x) {
  const out = []
  const go = x => {
    if (typeof x === 'number') out.push(utf8(`i${Math.trunc(x)}e`))
    else if (typeof x === 'string') go(utf8(x))
    else if (x instanceof Uint8Array) out.push(utf8(x.length + ':'), x)
    else if (Array.isArray(x)) { out.push(utf8('l')); x.forEach(go); out.push(utf8('e')) }
    else {
      out.push(utf8('d'))
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) { go(k); go(x[k]) }
      out.push(utf8('e'))
    }
  }
  go(x)
  return concat(...out)
}

export function decode (b) {
  let i = 0
  const until = end => {
    const j = b.indexOf(end, i)
    if (j < 0) throw new Error('bencode: truncated')
    const n = Number(str(b.subarray(i, j))); i = j + 1
    if (!Number.isFinite(n)) throw new Error('bencode: bad number')
    return n
  }
  const go = () => {
    if (i >= b.length) throw new Error('bencode: truncated')
    const c = b[i]
    if (c === 0x69) { i++; return until(0x65) }                     // i...e
    if (c === 0x6c) { i++; const a = []; while (b[i] !== 0x65) a.push(go()); i++; return a }
    if (c === 0x64) {                                                // d...e
      i++; const o = Object.create(null)
      while (b[i] !== 0x65) { const k = str(go()); o[k] = go() }
      i++; return o
    }
    const n = until(0x3a), s = b.subarray(i, i + n)
    if (s.length !== n) throw new Error('bencode: truncated')
    i += n; return s
  }
  return go()
}

// STUN binding responder (RFC 5389): lets peers use any anchor as their STUN server.
const COOKIE = 0x2112a442

export const isStun = b => b.length >= 20 && b[0] < 2 && ((b[4] << 24 | b[5] << 16 | b[6] << 8 | b[7]) >>> 0) === COOKIE

export function stunReply (req, { host, port }) {
  const v6 = host.includes(':')
  const out = new Uint8Array(v6 ? 44 : 32), dv = new DataView(out.buffer)
  dv.setUint16(0, 0x0101); dv.setUint16(2, v6 ? 24 : 12); dv.setUint32(4, COOKIE); out.set(req.subarray(8, 20), 8)
  dv.setUint16(20, 0x0020); dv.setUint16(22, v6 ? 20 : 8); dv.setUint16(24, v6 ? 2 : 1)     // XOR-MAPPED-ADDRESS
  dv.setUint16(26, port ^ (COOKIE >>> 16))
  if (!v6) dv.setUint32(28, (host.split('.').reduce((a, x) => a * 256 + +x, 0) ^ COOKIE) >>> 0)
  else {
    const mask = out.subarray(4, 20), ip = expand6(host)
    for (let i = 0; i < 16; i++) out[28 + i] = ip[i] ^ mask[i]
  }
  return out
}

function expand6 (h) {
  const [a, b = ''] = h.split('::'), pa = a ? a.split(':') : [], pb = b ? b.split(':') : []
  const parts = [...pa, ...Array(8 - pa.length - pb.length).fill('0'), ...pb].map(x => parseInt(x || '0', 16))
  return Uint8Array.from(parts.flatMap(x => [x >> 8, x & 255]))
}

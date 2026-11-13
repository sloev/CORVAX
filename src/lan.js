// LAN discovery (hosts with UDP): every node answers, anchor or not.
//   UDP broadcast/multicast: send "CX?" to 255.255.255.255 and 239.255.42.99 on port 4798 → reply: anchor lines
//   mDNS: query TXT _corvax._udp.local on 224.0.0.251:5353 → answer: one anchor line per TXT string
const GROUP = '239.255.42.99', MDNS = '224.0.0.251', MDNS_PORT = 5353, NAME = '_corvax._udp.local'
const te = new TextEncoder(), td = new TextDecoder()

export async function startLan ({ io, port = 4798, mdns = true, lines, onFound }) {
  const NODE_HOST = './host-node.js'
  io ||= (await import(NODE_HOST)).default
  const sockets = []
  const open = async (p, group, onMsg) => {
    const s = await io.udp({ port: p, reuse: true, group, broadcast: true }, (b, r) => s && onMsg(s, b, r))
    sockets.push(s)
    return s
  }

  const probe = await open(port, GROUP, (s, b, r) => {
    const text = td.decode(b)
    if (text === 'CX?') { const out = te.encode(lines().slice(0, 1200)); if (out.length) s.send(out, r.port, r.address) }
    else if (text.includes('corvax-anchor:')) onFound(text)
  })
  let md = null
  if (mdns) {
    try {
      md = await open(MDNS_PORT, MDNS, (s, b, r) => {
        const m = parseDns(b)
        if (!m) return
        if (!m.response && m.questions.includes(NAME.toLowerCase())) {
          const txt = lines().split('\n').filter(Boolean).slice(0, 8)
          if (txt.length) s.send(dnsAnswer(txt), MDNS_PORT, MDNS)
        } else if (m.response && m.txt.length) onFound(m.txt.join('\n'))
      })
    } catch {}
  }

  return {
    // Ask the network; answers arrive through onFound.
    discover () {
      probe.send(te.encode('CX?'), port, '255.255.255.255')
      probe.send(te.encode('CX?'), port, GROUP)
      md?.send(dnsQuery(), MDNS_PORT, MDNS)
    },
    close () { for (const s of sockets) s.close() }
  }
}

const labels = name => [...name.split('.').flatMap(l => { const b = te.encode(l); return [b.length, ...b] }), 0]
function dnsQuery () {
  return Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...labels(NAME), 0, 16, 0, 1])
}
function dnsAnswer (txts) {
  const rdata = txts.flatMap(t => { const b = te.encode(t).slice(0, 255); return [b.length, ...b] })
  return Uint8Array.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, ...labels(NAME), 0, 16, 0, 1, 0, 0, 0, 120, rdata.length >> 8, rdata.length & 255, ...rdata])
}
function parseDns (b) {
  try {
    const u16 = o => b[o] << 8 | b[o + 1]
    const name = o => {
      const parts = []; let jumped = false, end = o, hops = 0
      while (b[o] && hops++ < 64) {
        if (b[o] >= 0xc0) { if (!jumped) end = o + 2; jumped = true; o = (b[o] & 0x3f) << 8 | b[o + 1]; continue }
        parts.push(td.decode(b.subarray(o + 1, o + 1 + b[o]))); o += b[o] + 1
      }
      return { name: parts.join('.').toLowerCase(), next: jumped ? end : o + 1 }
    }
    const out = { response: !!(b[2] & 0x80), questions: [], txt: [] }
    let o = 12
    for (let i = u16(4); i--;) { const n = name(o); out.questions.push(n.name); o = n.next + 4 }
    for (let i = u16(6) + u16(8) + u16(10); i-- && o < b.length;) {
      const n = name(o); o = n.next
      const type = u16(o), len = u16(o + 8); o += 10
      if (type === 16 && n.name === NAME.toLowerCase()) for (let p = o; p < o + len; p += b[p] + 1) out.txt.push(td.decode(b.subarray(p + 1, p + 1 + b[p])))
      o += len
    }
    return out
  } catch { return null }
}

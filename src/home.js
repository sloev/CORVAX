// The page every HTTP-reachable node serves at GET / to browsers: a tiny shell.
//   <script src="/cx/app.js">  renders the human page, the inlined logo, and the live demo/query tool
//   <pre id="anchors">          the anchor lines, verbatim (works without JavaScript and for grep)
// Anchor stats, shared by every anchor implementation; recomputed at most every 30 s.
const cache = new WeakMap()
export function stats (anchor, { inboxes, store, bridges, extra = {} }) {
  const hit = cache.get(anchor)
  if (hit && Date.now() - hit.at < 30e3) return hit.s
  const now = Date.now(), boxes = [...inboxes.boxes.values()], records = [...store?.topics.values() || []].flatMap(m => [...m.values()])
  const s = {
    peers: boxes.filter(b => b.waiter).length,                      // listening right now (open inbox long polls)
    messages: boxes.reduce((n, b) => n + b.msgs.length, 0),
    topics: store?.topics.size || 0,
    records: records.filter(r => r.exp > now).length,
    relays: [...bridges?.values() || []].filter(b => b.b).length,
    ...extra
  }
  cache.set(anchor, { at: now, s })
  return s
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function homepage ({ origin, line, anchor, services = [], uptime = 0, anchors = '', stats = {} }) {
  // `anchor` = this peer is publicly reachable; every peer serves the same protocol
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CORVAX ${anchor ? 'anchor' : 'node'}</title>
<link rel="icon" href="/favicon.ico">
<script type="module" src="/cx/app.js"></script>
<body data-origin="${esc(origin)}" data-line="${esc(line)}" data-anchor="${anchor ? 1 : 0}" data-services="${esc(services.join(','))}" data-uptime="${Math.round(uptime / 1000)}" data-stats="${esc(JSON.stringify(stats))}">
<noscript><p>CORVAX ${anchor ? 'anchor' : 'node'}: find peers by key or topic and open WebRTC DataChannels. Known anchors:</p></noscript>
<pre id="anchors">${esc(anchors || line)}</pre>
</body>
</html>
`
}

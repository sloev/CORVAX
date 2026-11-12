// The homepage every HTTP-reachable node serves at GET /.
// One template, no JavaScript, no external requests (only the same-origin /logo), well under 10 KB.
// The anchor lines appear verbatim, so the page itself is a valid anchor source.

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function since (ms) {
  const s = Math.floor(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} days`
}

export function homepage ({ origin, line, anchor, services = [], uptime = 0, anchors = '' }) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CORVAX ${anchor ? 'anchor' : 'node'}</title>
<link rel="icon" href="/favicon.ico">
<style>
:root{--fg:#1b1d22;--bg:#fbfaf7;--mute:#5d6170;--line:#e3e0d8;--code:#f1eee6}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--bg:#141519;--mute:#9a9ca6;--line:#2c2e35;--code:#1d1f24}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:44rem;padding:1.5rem 1rem 3rem;font:16px/1.55 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;gap:.8rem}
h1{font-size:1.6rem;margin:0;letter-spacing:.06em}
h2{font-size:1rem;margin:2rem 0 .5rem}
p{margin:.5rem 0}
.mute{color:var(--mute)}
pre,code{font:13px/1.5 ui-monospace,monospace;background:var(--code);border-radius:6px}
code{padding:.1rem .3rem;word-break:break-all}
pre{padding:.75rem;overflow-x:auto;border:1px solid var(--line)}
a{color:inherit}
</style>
<header><img src="/logo" width="48" height="48" alt=""><h1>CORVAX</h1></header>
<p>A CORVAX ${anchor ? 'anchor' : 'node'}: it helps peers find each other by key and open direct WebRTC connections. It stores nothing but signed address records and short-lived encrypted messages.</p>

<h2>This node</h2>
<pre>${esc(line)}</pre>
<p class="mute">Services: ${esc(services.join(', ') || 'none')} · up ${esc(since(uptime))}</p>

<h2>How to use it</h2>
<p>In a browser:</p>
<pre>import { Peer } from '${esc(origin)}/cx/index.js'
const me = await Peer.create()
const { channel } = await me.connect('&lt;address&gt;')</pre>
<p>Run a node (it becomes an anchor if it is reachable): <code>npx corvax node</code></p>
<p>Get the anchor list: <code>curl -s ${esc(origin)} | grep -o 'corvax-anchor:[^ &lt;]*'</code></p>
<p><a href="/demo">Try the demo</a> · <a href="https://github.com/sloev/corvax">Source and spec</a></p>

<h2>Known anchors</h2>
<pre>${esc(anchors || line)}</pre>
</html>
`
}

// The human side of a CORVAX node's homepage (served at /cx/app.js, loaded by GET /).
// Renders the page around the anchor list, then — on "Go live" — loads the library and becomes a
// working peer: connect + chat, send messages, and search / watch / publish / broadcast topics.
// No framework, no external requests. All dynamic text goes through textContent.
const LOGO = 'data:image/png;base64,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'

const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? el.addEventListener(k.slice(2), v) : el.setAttribute(k, v)
  for (const k of kids) el.append(k)
  return el
}
const since = s => s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} days`
const short = a => `${a.slice(0, 8)}…${a.slice(-4)}`
const node = document.body.dataset

// Client-side storage (localStorage): the key ("corvax.seed"), the anchor book ("corvax.anchors", kept by the
// library) and the app state ("corvax.app": live or not, joined topics). Everything works without it, just
// without memory across reloads.
const store = {
  get (k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback } catch { return fallback } },
  set (k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
  clear () { try { for (const k of Object.keys(localStorage)) if (k.startsWith('corvax.')) localStorage.removeItem(k) } catch {} }
}
const app = store.get('corvax.app', { live: false, topics: {} })
const saveApp = () => store.set('corvax.app', app)
const anchors = document.getElementById('anchors')

document.head.append($('style', {}, `
:root{--fg:#1b1d22;--bg:#fbfaf7;--mute:#5d6170;--line:#dcd8cf;--code:#f1eee6;--accent:#2f4b9a}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--bg:#141519;--mute:#9a9ca6;--line:#30323a;--code:#1d1f24;--accent:#8ea8ff}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:46rem;padding:1.5rem 1rem 3rem;font:16px/1.55 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;gap:.8rem}
h1{font-size:1.6rem;margin:0;letter-spacing:.06em}
h2{font-size:1.05rem;margin:2rem 0 .5rem}
h3{font-size:.95rem;margin:1.2rem 0 .3rem}
p{margin:.5rem 0}
.mute{color:var(--mute)}
pre,code{font:13px/1.5 ui-monospace,monospace;background:var(--code);border-radius:6px}
code{padding:.1rem .3rem;word-break:break-all}
pre{padding:.75rem;overflow-x:auto;border:1px solid var(--line);margin:.4rem 0}
input,button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.45rem .65rem}
input{flex:1;min-width:0}
button{cursor:pointer;white-space:nowrap}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:.5rem;margin:.45rem 0;flex-wrap:wrap}
.log{max-height:14rem;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.log:empty{display:none}
.card{border:1px solid var(--line);border-radius:10px;padding:.2rem 1rem .8rem;margin:.8rem 0}
a{color:inherit}
`))

// ---- the static part: what this is and how to use it --------------------------------------------
const intro = $('div', {},
  $('header', {}, $('img', { src: LOGO, width: 48, height: 48, alt: '' }), $('h1', {}, 'CORVAX')),
  $('p', {}, `A CORVAX ${node.anchor === '1' ? 'anchor' : 'node'}: it helps peers find each other by key or by topic and open direct WebRTC connections. ` +
    'It stores nothing but signed address records, leased topic records and short-lived encrypted messages.'),
  $('h2', {}, 'This node'),
  $('pre', {}, node.line),
  $('p', { class: 'mute' }, `Services: ${(node.services || 'none').split(',').join(', ')} · up ${since(+node.uptime || 0)}`),
  $('h2', {}, 'How to use it'),
  $('pre', {}, `import { Peer } from '${node.origin}/cx/index.js'\nconst me = await Peer.create()\nconst { channel } = await me.connect('<address>')`),
  $('p', {}, 'Run a node (it becomes an anchor if it is reachable): ', $('code', {}, 'npx corvax node')),
  $('p', {}, 'Anchor list as plain text: ', $('code', {}, `curl -s ${node.origin}`), ' · ', $('a', { href: 'https://github.com/sloev/corvax' }, 'Source and spec'))
)

// ---- the live part ---------------------------------------------------------------------------
const log = el => (...parts) => { el.append(parts.join(' ') + '\n'); el.scrollTop = el.scrollHeight }
const status = $('span', { class: 'mute' }, 'Not connected. Going live creates a peer in this tab; its key, anchors and topics are kept in this browser.')
const goLive = $('button', { class: 'primary', onclick: () => start() }, 'Go live')
const live = $('div', {}, $('h2', {}, 'Live'), $('div', { class: 'row' }, goLive, status))
const known = $('div', {}, $('h2', {}, 'Known anchors'))
document.body.prepend(intro, live, known)
known.append(anchors)

let me
async function start () {
  goLive.disabled = true
  status.textContent = 'Starting…'
  try {
    const { Peer } = await import('./index.js')
    let seed = null
    try { seed = localStorage.getItem('corvax.seed') } catch {}           // stored raw (hex), for compatibility
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(location.hostname)
    me = await Peer.create({ seed, allowPrivate: local })
    try { localStorage.setItem('corvax.seed', me.seed) } catch {}
    window.corvax = me                                  // for poking at the live peer from devtools
    await me.publish()
    app.live = true; saveApp()
    status.textContent = ''
    status.append('Your address: ', $('code', {}, me.address), ' ',
      $('button', { title: 'Forget this identity, its anchors and topics, and stop', onclick: () => { store.clear(); location.reload() } }, 'Forget'))
    goLive.remove()
    live.append(messages(), connections(), topics())
  } catch (e) {
    status.textContent = `Could not go live: ${e.code || e.message}`
    goLive.disabled = false
  }
}

const field = (placeholder, label = placeholder) => $('input', { placeholder, 'aria-label': label })

function messages () {
  const to = field('Address'), text = field('Message'), out = $('pre', { class: 'log' })
  const say = log(out)
  me.on(({ from, body }) => say(`from ${short(from)}:`, typeof body === 'string' ? body : JSON.stringify(body)))
  const send = async () => {
    try { await me.send(to.value.trim(), text.value); say(`to ${short(to.value.trim())}:`, text.value); text.value = '' } catch (e) { say('failed:', e.code || e.message) }
  }
  return $('div', { class: 'card' }, $('h3', {}, 'Messages'), $('p', { class: 'mute' }, 'Small signed, encrypted messages delivered through the recipient\'s anchors.'),
    $('div', { class: 'row' }, to), $('div', { class: 'row' }, text, $('button', { onclick: send }, 'Send')), out)
}

function connections () {
  const to = field('Address to connect to'), text = field('Chat message'), out = $('pre', { class: 'log' })
  const say = log(out)
  let channel
  const sendBtn = $('button', { disabled: '', onclick: () => { channel.send(text.value); say('me:', text.value); text.value = '' } }, 'Send')
  const use = (ch, who, kind) => {
    channel = ch
    ch.onmessage = e => say(`${short(who)}:`, String(e.data))
    sendBtn.disabled = false
    say(`connected to ${short(who)} (${kind})`)
  }
  me.accept(({ from, channel, kind }) => use(channel, from, kind))
  const go = async () => {
    say(`connecting to ${short(to.value.trim())}…`)
    try { const r = await me.connect(to.value.trim()); use(r.channel, to.value.trim(), r.kind) } catch (e) { say('failed:', e.code || e.message) }
  }
  return $('div', { class: 'card' }, $('h3', {}, 'Connect'), $('p', { class: 'mute' }, 'A WebRTC DataChannel: direct when possible, otherwise relayed by another peer.'),
    $('div', { class: 'row' }, to, $('button', { onclick: go }, 'Connect')), $('div', { class: 'row' }, text, sendBtn), out)
}

function topics () {
  const name = field('Topic, e.g. chess'), text = field('Broadcast (≤ 1 KB)'), out = $('pre', { class: 'log' })
  const joined = $('p', { class: 'mute' })
  const say = log(out)
  const subs = new Map()                                          // normalized name -> unsubscribe fn
  const topic = () => me.topic(name.value)                        // handles are cached per normalized name
  const run = fn => async () => { try { await fn() } catch (e) { say('failed:', e.code || e.message) } }
  const remember = (t, change) => {
    const cur = { sub: false, pub: false, ...app.topics[t.name], ...change }
    if (cur.sub || cur.pub) app.topics[t.name] = cur; else delete app.topics[t.name]
    saveApp(); render(t)
  }
  const render = t => {
    const st = t ? app.topics[t.name] || {} : {}
    sub.textContent = st.sub ? 'Unsubscribe' : 'Subscribe'
    pub.textContent = st.pub ? 'Unpublish' : 'Publish'
    const list = Object.entries(app.topics).map(([n, v]) => `${n} (${[v.sub && 'subscribed', v.pub && 'published'].filter(Boolean).join(', ')})`)
    joined.textContent = list.length ? `Joined: ${list.join(' · ')}` : ''
  }
  const subscribe = t => subs.set(t.name, t.subscribe({
    presence: e => say(`[${t.name}] presence ${short(e.address)}: ${e.presence}`),
    message: m => say(`[${t.name}] broadcast from ${short(m.from)}:`, typeof m.body === 'string' ? m.body : JSON.stringify(m.body))
  }))
  const search = run(async () => {
    const t = await topic(), found = await t.search()
    say(`"${t.name}": ${found.length} other provider(s)`)
    for (const f of found) say(`  ${f.address}  ${f.presence}, lease until ${new Date(f.expires).toLocaleTimeString()}`)
  })
  const pub = $('button', { onclick: run(async () => {
    const t = await topic()
    if (t.published) { await t.unpublish(); remember(t, { pub: false }); return say(`unpublished "${t.name}"`) }
    const { stored } = await t.publish(); remember(t, { pub: true }); say(`published "${t.name}" on ${stored} storage node(s)`)
  }) }, 'Publish')
  const sub = $('button', { onclick: run(async () => {
    const t = await topic()
    if (subs.has(t.name)) { subs.get(t.name)(); subs.delete(t.name); remember(t, { sub: false }); return say(`unsubscribed from "${t.name}"`) }
    subscribe(t); remember(t, { sub: true }); say(`subscribed to "${t.name}" (presence + broadcasts)`)
  }) }, 'Subscribe')
  const cast = run(async () => { const t = await topic(), { sent } = await t.broadcast(text.value); say(`[${t.name}] me (to ${sent} neighbour(s)):`, text.value); text.value = '' })
  name.addEventListener('input', () => topic().then(render, () => render()))

  // restore what this browser had joined before the reload
  run(async () => {
    for (const [n, v] of Object.entries(app.topics)) {
      const t = await me.topic(n)
      if (v.sub) subscribe(t)
      if (v.pub) await t.publish()
      say(`restored "${n}" (${[v.sub && 'subscribed', v.pub && 'published'].filter(Boolean).join(', ')})`)
      name.value ||= n
    }
    render(name.value ? await topic() : null)
  })()

  return $('div', { class: 'card' }, $('h3', {}, 'Topics'),
    $('p', { class: 'mute' }, 'Presence is a 10-minute lease: "recent" means it was renewed lately, not that the peer is online. Broadcasts are best-effort: no history, no delivery guarantee. Publish before broadcasting.'),
    $('div', { class: 'row' }, name, $('button', { onclick: search }, 'Search'), pub, sub),
    $('div', { class: 'row' }, text, $('button', { onclick: cast }, 'Broadcast')), joined, out)
}

// A browser that was live before goes live again on load, with the same identity.
if (app.live) start()

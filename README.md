<p align="center"><img src="assets/logo/corvax-256.png" width="160" alt="CORVAX logo"></p>

# CORVAX

**Find any peer by its key or by a topic, from any runtime, and open an encrypted WebRTC DataChannel to it.**
The connection is direct when possible; otherwise it is relayed through another peer, end-to-end encrypted.

- **One permanent address per peer:** its Ed25519 public key (52 characters). Nothing to register, and it never expires.
- **No central server:** anchors are ordinary nodes that anyone can run. They are trusted with nothing, because records are signed and messages are sealed.
- **Topics:** publish presence for a topic and find the others there. Presence is a signed lease held on several storage nodes, not a central list. Topics also carry short best-effort broadcasts, passed peer to peer.
- **Discovery over everything:**
  - the BitTorrent Mainline DHT (records are pkarr-compatible)
  - DNS TXT records
  - any web page or text containing anchor lines
  - LAN broadcast and mDNS
  - invite links and a local cache
- **Zero runtime dependencies, no build step:** plain ESM JavaScript that runs in browsers, Node ≥ 22, Bun and Deno.

## Use it

In a browser, load it from any anchor:
```js
import { Peer } from 'https://<anchor>/cx/index.js'

const me = await Peer.create()            // bootstraps from the anchor that served this file
await me.publish()                        // announce yourself under your address
console.log(me.address)                   // give this to anyone

me.accept(({ from, channel }) => { channel.onmessage = e => console.log(from, e.data) })
const { channel, kind } = await me.connect('<their address>')   // kind: 'direct' | 'peer'
channel.send('hello')

// topics: who else is here, and short best-effort notices
const chess = await me.topic('chess')
await chess.publish()                     // a 10-minute lease, renewed automatically
chess.subscribe({
  presence: ({ address, presence }) => {},   // 'recent' | 'expired' (a lease, not a promise that they're online)
  message: ({ from, body }) => {}            // broadcasts from other members
})
await chess.search()                      // [{ address, presence: 'recent', expires }]
await chess.broadcast({ move: 'e4' })     // ≤ 1 KB, reaches the members it can: no history, no guarantee
```

In Node, Bun or Deno (`npm i corvax`, or `npm:corvax` in Deno):
```js
import { Peer } from 'corvax'
const me = await Peer.create({ anchors: ['corvax-anchor:…'] })   // any text with anchor lines works
```
Outside browsers, WebRTC comes from [`werift`](https://github.com/shinyoshiaki/werift-webrtc) (pure JS, installed as an optional dependency). Pass your own with `Peer.create({ RTCPeerConnection })`, e.g. from `node-datachannel/polyfill`.

## Run a node

```sh
npx corvax node                          # becomes an anchor automatically if strangers can reach UDP+TCP 4799
npx corvax anchor --public-host <ip>     # the first anchors of a network
npx corvax anchors                       # print the anchor book
```

Every node reachable over HTTP serves `/` in two forms:
- **Browsers** get the homepage. It explains what the node is and how to use it, and lists the known anchors. Its **Go live** button turns it into a working peer: send messages, open a DataChannel chat, and search, publish, subscribe to and broadcast on topics.
- **Everything else** (`curl`, `wget`, scripts) gets the plain anchor list, one line each: `curl -s http://<node>:4799/`.

Anchors also store leased topic records (`--no-storage` opts out). The node also serves the library at `/cx/*.js`, the logo at `/logo` and a demo at `/demo`.

**Browsers on HTTPS pages** need an anchor with an HTTPS origin. Put one in front of a node with any TLS proxy, or for free with `cloudflared tunnel --url http://localhost:4799`, then start the node with `--web https://<that origin>`. The tunnel carries HTTP only; UDP (DHT, STUN) still needs the port.

**Publishing anchors in DNS:** add TXT records at `_corvax-anchors.<your domain>` containing anchor lines (`npx corvax anchors` prints them), and pass `dohDomains: ['<your domain>']` to `Peer.create`.

**Privacy:** a direct WebRTC connection reveals your IP address to the peer you connect to. Relayed connections reveal it to the relaying peer, which sees only ciphertext.

## Tests

```sh
npm test                                  # Node: core, DHT, anchors, LAN, relaying, topics, broadcast, WebRTC (werift + node-datachannel), Chromium, the homepage app
bun test/runtime-smoke.js                 # Bun
deno run -A test/runtime-smoke.js         # Deno
node test/live/pkarr.js                   # needs internet: round-trip through the public pkarr relay (Mainline)
```
CI runs one job when code changes: Node (with Chromium), Bun and Deno. Firefox and WebKit run when triggered by hand (Actions → test → Run workflow).

## Documents
- [SPEC.md](SPEC.md): the wire protocol `cx/1`, complete enough to write another implementation
- [PLAN.md](PLAN.md): scope, design decisions and their reasons

## Logo
All sizes are in [`assets/logo/`](assets/logo): the 1024 px master `corvax.png`, `corvax-512…16.png`, `favicon.ico`, and the 2.9 KB `corvax-web.png`, which is inlined into the homepage app (`src/app.js`).

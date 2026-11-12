<p align="center"><img src="assets/logo/corvax-256.png" width="160" alt="CORVAX logo"></p>

# CORVAX

Find any peer by its key or by a topic, from any runtime, and open an encrypted WebRTC DataChannel to it: direct when possible, otherwise relayed through another peer.

- **Addresses are keys** (Ed25519, 52 chars). Nothing to register, and they never expire.
- **No central servers.** Anchors are ordinary peers that others can reach; anyone can run one, and none is trusted.
- **Topics:** leased, signed presence plus short best-effort broadcasts.
- **Zero runtime dependencies, no build step.** Runs in browsers, Node ≥ 22, Bun and Deno.

## Use

```js
import { Peer } from 'https://<anchor>/cx/index.js'          // or: npm i corvax / npm:corvax

const me = await Peer.create()                 // bootstraps from the anchor that served the file
await me.publish()                             // make your address resolvable
me.accept(({ from, channel }) => channel.onmessage = e => console.log(from, e.data))
const { channel } = await me.connect('<address>')
channel.send('hello')

const chess = await me.topic('chess')
await chess.publish()                          // presence: a 10-minute lease, renewed automatically
chess.subscribe({ presence: e => {}, message: m => {} })
await chess.search()                           // [{ address, presence: 'recent', expires }]
await chess.broadcast({ move: 'e4' })          // ≤ 1 KB, best-effort, never stored
```

Outside browsers, WebRTC comes from `werift` (an optional dependency); pass your own with `Peer.create({ RTCPeerConnection })`. STUN uses anchors that answer UDP plus `stun:stun.cloudflare.com:3478` (`Peer.create({ stun })`). When no given or cached anchor answers, peers fall back to `https://corvax.sloev.workers.dev/` (`Peer.create({ fallback })`).

## Run a node

```sh
npx corvax node                      # becomes an anchor when strangers can reach UDP+TCP 4799
npx corvax anchor --public-host IP   # the first anchors of a network
npx corvax anchors                   # print the anchor book
```

- **Browsers** opening a node's `/` get the CORVAX app: **DOX** (a short introduction), **APP** (identity, peers, messages, topics, follows, updates) and **STATS** (this anchor and your node).
- **`curl -s http://node:4799/`** gets the plain anchor list.
- **Cloudflare Worker anchor:** `npx wrangler deploy` in this repo (HTTPS only: inboxes, topic storage, Beacons mirrored to Mainline via pkarr, and a rate-limited WebSocket relay as a last resort; no UDP, so no DHT routing or STUN). Optional fixed key: `wrangler secret put CORVAX_SEED` (64 hex chars). Check it with `node test/worker-check.js https://corvax.<account>.workers.dev`.
- **HTTPS pages** need an anchor with an HTTPS origin: `cloudflared tunnel --url http://localhost:4799`, then `--web https://…`.
- **A direct connection reveals your IP** to the peer you connect to.

## Test

```sh
npm test                                      # Node, incl. Chromium (Playwright)
bun test/runtime-smoke.js; deno run -A test/runtime-smoke.js
node test/live/pkarr.js                       # internet: Mainline compatibility via the pkarr relay
```

[SPEC.md](SPEC.md) is the wire protocol. [PLAN.md](PLAN.md) holds scope and decisions. Logo sizes are in [assets/logo](assets/logo).

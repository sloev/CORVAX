# CORVAX: Plan v1.0 (frozen scope)

> **Find any peer by its key, from any runtime, and open an encrypted WebRTC DataChannel to it.**
> The infrastructure introduces. The peers communicate.

---

## 1. Scope

CORVAX does five things and then gets out of the way:

1. **Identity:** one seed → an Ed25519 identity key (the permanent address) + an X25519 encryption key.
2. **Anchor book:** every node keeps a verified, scored list of public anchors (the bootstrap nodes) and shares it over every channel it has.
3. **Discovery:** publish a signed record under your address; anyone can resolve it.
4. **Signalling:** send small, signed and encrypted messages to an address.
5. **Connection:** `connect(address)` returns an open channel: a direct `RTCDataChannel` when possible, otherwise **relayed through any third peer** both sides can reach (a browser, a native node or an anchor), end-to-end encrypted (§7).

### Out of scope, permanently
- Anything on top of the DataChannel (framing, RPC, files, media)
- Peer gossip, introductions, rooms/topics, reputation, incentives, telemetry
- Our own WebRTC stack (browsers have one; native runtimes use a standard library, §8)
- WebSocket, WebTransport, UPnP/NAT-PMP, running DNS servers, ICMP, pkarr HTTP endpoints, crypto fallbacks for old browsers (unsupported browsers get a clear `unsupported` error)

### Done when
- [ ] `npm test` is green under Node, Bun and Deno; browser tests pass in Chromium, Firefox and WebKit
- [ ] A Beacon from our code round-trips through the public pkarr relay (real Mainline compatibility)
- [ ] **The proof:** two browsers on unrelated networks, knowing only each other's address, open a verified **direct** DataChannel
- [ ] When direct is impossible, the same two browsers connect **through a third peer**, once via another browser and once via an anchor; a Node peer ↔ browser works with the default native WebRTC library
- [ ] A fresh node with no configuration finds anchors via the homepage/HTTP, DNS TXT, the Mainline DHT and the LAN
- [ ] Every HTTP-reachable node serves the homepage
- [ ] README + `SPEC.md` written. From then on: bug fixes only.

---

## 2. Built to last

- **Standard foundations:** BitTorrent KRPC (BEP 5, 43, 44), pkarr records, DNS TXT, HTTP/1.1, STUN (RFC 5389, binding only), mDNS, and the W3C WebRTC and WebCrypto APIs.
- **Our own protocol on top, versioned as `cx/1`:** the `cx_*` queries, anchor lines, the message format, the anchor book rules and the connect flow. These are specified in `SPEC.md` with test vectors. The protocol only grows: fields and queries never change meaning, new ones get new names, and unknown fields are ignored.
- **Core has zero runtime dependencies and no build step.** Plain ESM JavaScript; the browser loads the same files Node runs. Native runtimes get one *optional* default WebRTC library (§8).
- **Standard crypto only:** WebCrypto Ed25519, X25519, HKDF-SHA256, AES-GCM, SHA-1/256. No custom key conversions.
- **Small but not at the expense of safety.** Target is roughly 1,600 lines; correctness and tests come first.
- **Platforms:** current Chrome, Firefox, Safari; Node ≥ 22, Bun ≥ 1.1, Deno ≥ 2 (via `npm:corvax`).

---

## 3. Architecture

```
          UDP (KRPC · STUN)                            HTTP POST /krpc
 Mainline ◄───────────────► ANCHOR ◄──────────────────────────────── any client
 DHT nodes                     ▲ ▲                                   (browser, Node, Bun, Deno, curl)
                     UDP KRPC  │ │ LAN: broadcast "CX?" + mDNS
                      ANCHOR ◄─┘ └─► native nodes on the same network

 PEER A ◄═════════════════════ RTCDataChannel (direct) ═════════════════════► PEER B
 PEER A ◄════ RTCDataChannel ════► PEER C (any peer) ◄════ RTCDataChannel ════► PEER B
        └──────────── end-to-end encrypted relayed channel (fallback) ───────────┘
```

| Role | Who | Does |
|---|---|---|
| **Anchor** | a native node with at least one verified public service (UDP and/or HTTP) | DHT node (if UDP), HTTP `/krpc` + homepage (if HTTP), inboxes, STUN, anchor book, LAN responder, **and a peer like any other** (it can relay) |
| **Native peer** | Node/Bun/Deno behind NAT | HTTP client; keeps and shares an anchor book; LAN responder; can relay |
| **Browser peer** | any web page; **opportunistic**: may sleep or vanish at any time | HTTPS client; keeps and shares an anchor book; can relay while open |

**Every peer can relay.** Relaying needs no special server, only a WebRTC connection to both sides. Anchors are simply the peers that everyone can reach.

**Two transports, one message format (bencoded KRPC):**
- **UDP:** node ↔ node, Mainline, STUN, LAN discovery.
- **HTTP `POST /krpc`:** every client ↔ anchor. Browsers need an HTTPS origin (`web=`, e.g. through a Cloudflare tunnel; the tunnel covers HTTP only, not the anchor's UDP DHT/STUN). Natives may use `http://ip:port`.

---

## 4. Identity, records and messages

```
Seed       32 random bytes (the only secret to back up)
Identity   Ed25519 key  = from HKDF(seed, "cx/ed25519")    → address = z32(ed_pk), 52 chars
Encryption X25519 key   = from HKDF(seed, "cx/x25519")     → published in the Beacon, signed by the identity key
Anchor     corvax-anchor:<z32>@<ip>:<port>[;web=<https origin>][;q=<0-100>]                 ≤ 255 chars
Beacon     pkarr signed packet (BEP 44 mutable item at SHA1(ed_pk)), ≤ 1000 B, TXT "_cx":
           x=<b64 x25519_pk>   c=<inbox anchor url> (1..n)   [app-defined k=v]
Message    eph_x 32 | iv 12 | AES-GCM_K( inner ) | tag 16                                ≤ 4 KB
           K     = HKDF-SHA256( X25519(eph_sk, recipient_x), info = "cx/msg" ‖ eph_x ‖ recipient_x )
           inner = bencode{ from: ed_pk, to: recipient_ed_pk, id: 16 B, ts, body } ‖ Ed25519 sig over all of it
Relay      frame = counter 8 | AES-GCM_Kdir(data) | tag 16;  Kdir = HKDF(X25519(eph_a, eph_b), "cx/relay" ‖ sid ‖ direction)
```
- **Sealed sender:** each message uses a fresh ephemeral X25519 key, so a recipient's long-term key alone can't decrypt past messages, and keys are never reused across directions.
- **Sender attribution comes from the Ed25519 signature,** not from the shared key. The signature covers `to`, which stops reflection and redirection attacks.
- **Receivers accept a message only if** the signature is valid, `to` is them, `|now − ts| < 10 min`, and the `id` is new. A sender's X25519 key is learned from its Beacon when it's needed (e.g. to reply).

---

## 5. Protocol `cx/1` (KRPC)

| Query | Source | Request → Reply |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get_peers`, `announce_peer` | BEP 5 | anchors announce on infohash `SHA1("corvax anchors v1")`. **One opportunistic bootstrap source**, not an authority: results can be stale or hostile and are verified like any other line |
| `get`, `put` | BEP 44 | resolve / publish a Beacon (signature, seq and token checked) |
| `cx_hi {n}` | ours | → `{k, sig=Ed25519("cx-hi" ‖ n), web?}`: proves the anchor holds its key (identity only, says nothing about reachability) |
| `cx_anchors {}` | ours | → `{a}`: best 32 + 8 random anchor lines |
| `cx_check {port}` | ours | the anchor asks a *different* anchor to probe the caller's UDP and HTTP → `{udp, http}` |
| `cx_send {to, msg}` | ours | → `{queued}`: stored for that address (2 min, ≤ 64 per address, dedup by message `id`, so retries are idempotent). *Queued ≠ delivered*; delivery is only known when the peer answers |
| `cx_listen {k, ts, sig, after?}` | ours | **long poll**, waits ≤ 25 s → `{msgs: [{seq, msg}]}`. `after` acknowledges everything up to that `seq`, which the anchor then deletes (at-least-once delivery; receivers dedup by `id`). A newer poll for the same key ends the older one with an empty reply |

**HTTP details:**
- **Requests:** `POST /krpc` with `Content-Type: text/plain` (a CORS "simple request", so browsers send no preflight). `OPTIONS` is still answered. Body ≤ 8 KB.
- **Every reply is a KRPC reply**, including errors.
- **Clients retry** with backoff, and the same `t` (transaction id) is answered from a short replay cache, so a retried `POST` never executes twice.

**Anchor HTTP endpoints:** `GET /` (homepage = anchor list) · `POST /krpc` · `GET /cx/*.js` (the library) · `GET /logo` (the lightweight logo, long cache) · `GET /favicon.ico` · `GET /demo`. CORS `*` everywhere.

### The homepage (`GET /`)
Every node reachable over HTTP serves a thin page, so anyone who stumbles on it learns what it is and how to join.
0. **The CORVAX logo** (the lightweight version from `/logo`, ~48 px) and the name
1. **What this is:** two sentences ("A CORVAX anchor: it helps peers find each other by key and open direct WebRTC connections. It stores nothing but signed address records and short-lived encrypted messages.")
2. **This node:** its anchor line, which services it offers (UDP/HTTP/relay), and its uptime
3. **How to use it:**
   - browser: `import { Peer } from '<origin>/cx/index.js'`
   - native: `npx corvax node`
   - shell: `curl -s <origin> | grep -o 'corvax-anchor:[^ <]*'`
   - plus links to `/demo` and the repo
4. **Known anchors:** the shared view, one anchor line per row with its score, in a `<pre>`

Rules:
- server-rendered from one template string, **no JavaScript, no external requests** (the only extra request is the same-origin `/logo`: 96 px, 2.9 KB, shown at 48 px, cached for a year)
- ≤ 10 KB, system font, dark and light mode, readable on a phone
- every dynamic value HTML-escaped
- **it is the anchor list:** there's no `/anchors.txt` endpoint, and machines use `cx_anchors`.

---

## 6. The anchor book

**Line:** `corvax-anchor:<z32>@203.0.113.7:4799;web=https://a.example.org;q=93`. Readers grep any text for `corvax-anchor:[^\s"'<]+`. Web pages, READMEs, gists, DNS TXT records, invite links and pasted text all work as sources with no extra code.

**Each entry tracks every service separately**, so a working HTTPS tunnel can't make a dead DHT port look healthy:
```
identity_verified   cx_hi signature valid (with a random nonce)
http_ok / udp_ok / rtc_ok     EWMA(probe success, α = 0.2) per service (rtc = it accepts WebRTC, so it can relay)
rtt, first_seen, last_ok
```
- **Score:** `q = round(100 · max(service ok) · min(1, days_known/7)^½)`. Browsers rank by `http_ok`, natives by `udp_ok` (falling back to `http_ok`). A `q` received from others is only a hint, capped at 50 until verified locally.
- **Size and pruning:** ≤ 1000 entries; dropped when `q < 10` and no success for 7 days. Anchors re-probe 64 entries every 10 min (≤ 16 unverified probes per minute).
- **Shared view:** best 32 + 8 random (so new anchors spread before they have a score).
- **Spreading:** every 10 min each anchor pulls `cx_anchors` from 3 random anchors. Clients pull from every anchor they use. New anchors `announce_peer` and send `cx_hi` to known anchors, which probe back.

**Bootstrap channels** (all tried in parallel, the first verified anchor wins):

| Channel | Browser | Native |
|---|---|---|
| Local cache (IndexedDB / `~/.config/corvax/anchors.txt`) | ✅ | ✅ |
| Baked-in `anchors.txt` file (in the package / repo) | ✅ | ✅ |
| Any text: invite link, paste, file, any URL incl. any anchor's homepage (`sources: [...]`) | ✅ (HTTPS + CORS) | ✅ |
| `cx_anchors` on any known anchor | ✅ (`web=` anchors) | ✅ |
| DNS TXT `_corvax-anchors.<domain>` (`dohDomains: [...]`) | ✅ via public DoH JSON | ✅ via system resolver |
| Mainline `get_peers` on the anchor infohash | ❌ | ✅ |
| LAN: UDP broadcast/multicast `CX?` on port 4799, mDNS `_corvax._udp.local` TXT | ❌ | ✅ (every native node answers) |

**Automatic promotion:** every native node calls `cx_check` at start and every 30 min. Each service that strangers can reach is switched on: UDP → DHT server mode, STUN, `announce_peer`; HTTP → homepage and `/krpc` for others. Relaying is on for every peer anyway. `--no-anchor` opts out.

---

## 7. `connect(address, { relay })`

Plain standard offer/answer. **No SDP templates and no SDP editing.**

### 7.1 Direct
```
1 RESOLVE  Beacon of B (newest valid seq) → B's x25519 key + inbox anchors
2 ICE      iceServers = STUN on own anchors
3 OFFER    A: createOffer → setLocalDescription → msg {t:'offer', sid, sdp}
4 ANSWER   B: setRemoteDescription → createAnswer → setLocalDescription → msg {t:'answer', sid, sdp}
5 TRICKLE  both send msg {t:'cand', sid, c} as candidates appear; candidates that arrive early are queued
6 OPEN     DataChannels open: id 0 = the app's channel, id 1 = "cx" control channel (both negotiated)
```

### 7.2 Relayed through a third peer (automatic when direct fails, default)
If ICE fails or times out (10 s), A and B pick a third peer **C** that both can reach, and C bridges two ordinary DataChannels:
```
1 OFFER VIA   A → B  msg {t:'via?', sid, eph_a, via: [up to 8 addresses]}
              via = A's currently connected peers that relay, then A's best anchors (anchors are peers too)
2 PICK C      B prefers an address it is already connected to; otherwise it tries a direct connect()
              to the candidates in order (no relaying for this hop, so no recursion); the first that works is C
3 ACCEPT      B → A  msg {t:'via', sid, eph_b, c: C}            (A connects to C directly if not already)
4 BRIDGE      A and B each send on their control channel to C:  {t:'bridge', sid, to: other address}
              C pairs the two requests (both must be its direct peers, same sid), then forwards frames
5 CHANNEL     A and B now have a relayed channel with the same interface as RTCDataChannel
              frames end-to-end encrypted with directional keys from eph_a/eph_b (§4); C only sees ciphertext
```
- **Result:** `{ channel, kind: 'direct' | 'peer', via? }`. The app gets the same channel interface either way.
- **Policy:** `relay: 'fallback'` (**default**: direct first, then through a peer) or `'never'` (direct only → error `'ice-failed'`).
- **Relaying for others:** every peer does it by default within its limits (§9). Opt out with `relayFor: false` (`--no-relay` on the CLI).
- **Identity binding:** offers, answers and `via` messages travel inside signed, encrypted messages. So the DTLS fingerprints *and* the relay session keys are bound to both peers' Ed25519 keys, and neither C nor anyone else can swap them.
- **No TURN at all:** anchors relay the same way any other peer does. That works because they are publicly reachable, so both sides can always open a direct DataChannel to them.

Errors: `'not-found' | 'no-answer' | 'ice-failed' | 'no-relay' | 'timeout' | 'no-webrtc' | 'unsupported'`

---

## 8. WebRTC outside browsers: a default you can replace

```js
// resolution order inside Peer.create():
RTCPeerConnection = options.RTCPeerConnection          // 1. injected by the app (always wins)
                 ?? globalThis.RTCPeerConnection        // 2. browsers (and any runtime that adds it)
                 ?? (await import('werift')).RTCPeerConnection   // 3. the default for Node/Bun/Deno
                 ?? null                                // 4. none → connect() throws 'no-webrtc'; everything else works
```
- **Default: `werift`.** It's pure TypeScript and MIT-licensed, with no native binaries, so it runs unchanged on Node, Bun and Deno. It's listed as an **`optionalDependency`**: installed by default, and if it's missing the install doesn't fail and everything except `connect()` still works.
- **Anchors use it too:** it's how they accept WebRTC and relay. A native node without any WebRTC library still discovers, signals and serves the DHT, but can't relay.
- **Tested alternative: `node-datachannel`** (libdatachannel, native, faster), e.g. `Peer.create({ RTCPeerConnection: (await import('node-datachannel/polyfill')).RTCPeerConnection })`.
- **The contract, the minimum interface we use** (documented in `SPEC.md`; any implementation that satisfies it works):
  - `new RTCPeerConnection({ iceServers, iceTransportPolicy })`
  - `createDataChannel(label, { negotiated: true, id })` (ids 0 and 1)
  - `createOffer()`, `createAnswer()`, `setLocalDescription(d)`, `setRemoteDescription(d)`, `addIceCandidate(c)`, `getStats()`, `close()`
  - events: `onicecandidate`, `onconnectionstatechange` / `connectionState`
  - channel: `send`, `close`, `readyState`, `binaryType`, `onopen`, `onmessage`, `onclose`
- **Our tests run against both libraries.** If `werift` ever goes unmaintained, the default moves to `node-datachannel` with no API change.

---

## 9. Limits enforced in code

- **Beacon:** signature, monotonic seq, ≤ 1000 B, checked on store and on use.
- **Message:** ≤ 4 KB, signature, `to`, ts window, id dedup.
- **Per IP, one token bucket** (cost: `put` 6, `cx_check` 12, `cx_send` 1, others 0.5; refill 60/min). HTTP body ≤ 8 KB; ≤ 4 open long polls per IP.
- **DHT:** tokens = SHA1(secret ‖ ip), rotated every 10 min; routing table ≤ 1000; responders added only after they answer.
- **Book:** lines ≤ 255 chars; public unicast IPs only (except entries learned on the LAN).
- **Relaying (each peer, configurable):**
  - bridges only between two of its own direct peers, for one `sid` each
  - defaults: browsers ≤ 2 sessions at ≤ 256 kbit/s each; native nodes ≤ 16 sessions at ≤ 2 Mbit/s each
  - ≤ 1 GB per hour in total; sessions idle for 2 min are closed
  - frames ≤ 16 KB

---

## 10. Files (~1,600 lines)

| File | Job | Lines | Draft? |
|---|---|---|---|
| `src/bytes.js` | hex, base64url, z-base32, u64, concat | 45 | ✅ |
| `src/crypto.js` | WebCrypto: keys from seed, sign/verify, ECDH, HKDF, AES-GCM, hashes | 55 | ✏️ drop ed→x |
| `src/bencode.js` | bencode (hardened) | 45 | ✅ |
| `src/record.js` | Beacon, BEP 44 signable, DNS TXT codec (also used by mDNS) | 80 | ✅ |
| `src/message.js` | sealed-sender seal/open | 60 | ⬜ |
| `src/dht.js` | sans-IO KRPC node: routing, lookup, get/put, get_peers/announce_peer, query hooks | 200 | ✏️ |
| `src/book.js` | anchor lines: grep, format, per-service scores, merge, probe queue | 160 | ⬜ |
| `src/peer.js` | `Peer`: identity, book, HTTP client (retries, long poll, acks), publish/resolve/send | 180 | ✏️ |
| `src/rtc.js` | `connect`/`accept`: offer/answer/trickle, control channel, fallback to relay | 120 | ✏️ |
| `src/relay.js` | `via` negotiation, bridging for others, relayed channel (E2E frames, same interface), limits | 150 | ⬜ |
| `src/anchor.js` | UDP demux, HTTP server, inboxes, `cx_*` handlers, token bucket, replay cache | 220 | ✏️ |
| `src/home.js` | homepage template | 50 | ⬜ |
| `src/stun.js` | STUN binding responder (anchors are the STUN servers) | 25 | ⬜ |
| `src/lan.js` | broadcast/multicast + mDNS responder and query | 100 | ⬜ |
| `src/node.js` | native wiring: UDP socket, book file, LAN, DNS lookup, promotion, default WebRTC loader | 100 | ⬜ |
| `bin/corvax.js` | `corvax node \| anchor \| anchors \| id \| resolve` | 50 | ✏️ |
| `src/demo.html` · `anchors.txt` | two-tab chat demo at `/demo` · baked-in list | 60 | ✏️ |
| `assets/logo/` | CORVAX logo: `corvax-source.jpg` (original with green screen), `corvax.png` (1024 px, transparent), `corvax-{16…512}.png`, `favicon.ico` (16/32/48), **`corvax-web.png` (96 px, 64-colour palette, 2.9 KB) served at `/logo`** | n/a | ✅ |

---

## 11. API (all of it)

```js
import { Peer } from 'corvax'                 // browsers: https://<anchor>/cx/index.js · Deno: npm:corvax

const me = await Peer.create({
  seed,                                           // optional; persisted by the caller
  anchors, sources, dohDomains,                   // optional extra bootstrap inputs
  RTCPeerConnection,                              // optional: overrides the default (§8)
  relay: 'fallback',                              // default; or 'never' (direct only)
  relayFor: true                                  // default; relay for others within limits (§9)
})
me.address                                        // permanent, shareable
await me.publish()                                // Beacon → DHT, refreshed every 30 min
me.accept(({ from, channel, kind }) => {})        // incoming channels
const { channel, kind, via } = await me.connect(address)   // kind: 'direct' | 'peer'

me.anchors()  /  me.addAnchors(text)              // export / import anchor lines
await me.resolve(address)                         // Beacon fields
await me.send(address, body);  me.on(fn)          // raw signed + encrypted messages
me.close()
```
CLI: `corvax node` (a peer that promotes itself), `corvax anchor`, `corvax anchors`, `corvax id`, `corvax resolve <addr>`; `--no-relay` opts out of relaying.

---

## 12. Tests

| Test | Proves |
|---|---|
| `core` | encodings round-trip; truncated bencode can't hang; seed → same keys everywhere; Beacon tamper; message tamper, **reflection**, redirection (`to`) and replay rejected; anchor lines grepped from messy text; score maths |
| `dht` | 20 loopback nodes: put/get, stale seq + bad signature rejected, announce_peer → get_peers |
| `book` | 10 anchors, each knowing one neighbour, converge to all 10; a wrong-key line is never verified; an anchor with HTTP up but UDP dead scores well for browsers only; a dead anchor decays |
| `anchor` | 3 chained anchors: A publishes on #1, B on #3 resolves and sends, A's long poll receives; retried POST not executed twice; `after` acks delete; newer poll ends the older one; `cx_check` turns on only reachable services; token bucket |
| `home` | `GET /logo` and `/favicon.ico` return the image with a long cache header; `GET /` ≤ 10 KB, no `<script>`, no external URLs, escapes a hostile line, `addAnchors(page)` recovers every listed anchor |
| `core` (wire names) | the wire names in `SPEC.md` (`cx_*`, `corvax-anchor:`, `_cx`, `CX?`, `_corvax._udp`, `cx/…` labels) match the code |
| `relay` | with direct ICE blocked between A and B (test hook): connect via a third **browser**, via a **Node** peer and via an **anchor**; C sees only ciphertext (frames not decryptable with C's keys); a forged `bridge` for a sid C wasn't asked by both sides is ignored; limits enforced; `relay: 'never'` gives `'ice-failed'` |
| `lan` | broadcast and mDNS discovery between two nodes |
| `browser` | Playwright **Chromium, Firefox, WebKit**: two pages bootstrap from an anchor homepage, connect direct (`kind: 'direct'`), then with direct blocked through a third page (`kind: 'peer'`) |
| `native` | Node ↔ Chromium and Node ↔ Node with **werift** and with **node-datachannel**; Bun and Deno run `core`, `anchor` and Node ↔ Node with werift |
| `live` (manual) | Beacon via `relay.pkarr.org`; TXT via public DoH; `announce_peer` on real Mainline |

---

## 13. Build order

1. `crypto` (seed → keys), `message`, `dht` hooks + get_peers/announce_peer → `core`, `dht`
2. `book` + `cx_hi`/`cx_anchors` → `book`
3. `anchor` (HTTP `/krpc`, long poll, acks, replay cache, inboxes) + `peer` HTTP client + `home` → `anchor`, `home`
4. `rtc` (standard offer/answer, control channel) + `stun` → `browser` direct
5. `relay` → `relay`, `browser` relayed
6. `node` (default WebRTC loader, promotion, DNS, cache) + `lan` → `native`, `lan`
7. CLI, demo, `anchors.txt`, `live` run, README + `SPEC.md`. **Done.**

---

## 14. Decisions taken in review (and why)

**Naming (wire level, frozen with `cx/1`):** queries `cx_*` · anchor lines `corvax-anchor:` · Beacon TXT name `_cx` · key-derivation labels `cx/…` · signed strings `cx-hi`, `cx-listen:` · LAN probe `CX?` · mDNS `_corvax._udp.local` · DNS bootstrap `_corvax-anchors.<domain>` · Mainline infohash `SHA1("corvax anchors v1")` · library path `/cx/*.js` · control DataChannel label `cx`.


| Change | Why |
|---|---|
| **Separate X25519 key** (from the same seed) instead of converting Ed25519 → X25519 | Uses only standard WebCrypto operations. The key is published in the Beacon, which we always resolve anyway. |
| **Sealed-sender messages:** ephemeral ECDH + Ed25519 signature over `to` | The old shared static key couldn't prove who sent a message and allowed reflecting a message back to its sender. Now sender attribution is explicit and keys are never reused across directions. |
| **Full SDP offer/answer**, no templates | Robust across Chrome, Firefox, Safari and native libraries. Costs ~1 KB per connection, so the message cap goes up to 4 KB. |
| **Relaying through any peer is the default fallback** (`relay: 'fallback'`) | Connections should succeed whenever any path exists. Relaying is not a server role: browsers, native nodes and anchors all relay the same way. |
| **No TURN** | Peer bridging over two ordinary DataChannels covers everything TURN did (anchors are reachable by everyone) and removes ~300 lines of TURN server, credentials and its abuse surface. Only a 25-line STUN responder remains. |
| **Relayed channels are end-to-end encrypted with keys bound to both identities** | The relaying peer sees only sizes and timing, never content, and can't swap keys. |
| **Mainline `get_peers` is one bootstrap source, not "the directory"** | Its results can be stale or hostile. The verified anchor book is the foundation. |
| **Separate identity and per-service reachability** in the book | A working HTTPS tunnel must not make a dead UDP/DHT port look healthy. |
| **Idempotent HTTP:** retry cache, message ids, acked long polls, `text/plain` POST | Retries never execute twice, nothing is silently lost, and browsers send no CORS preflight. |
| **Default native WebRTC = `werift`** (optional dependency), injectable | Pure JS on Node, Bun and Deno; replaceable without API changes. |
| **No hard line limit** | Safety and tests matter more than the line count. |

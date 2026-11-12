# Rendezvous: Plan v1.0 (frozen scope)

> **Find any peer by its key, from any runtime, and open an encrypted WebRTC DataChannel to it.**
> The infrastructure introduces. The peers communicate.

---

## 1. Scope

Rendezvous does five things and then gets out of the way:

1. **Identity:** one seed → an Ed25519 identity key (the permanent address) + an X25519 encryption key.
2. **Anchor book:** every node keeps a verified, scored list of public anchors (the bootstrap nodes) and shares it over every channel it has.
3. **Discovery:** publish a signed record under your address; anyone can resolve it.
4. **Signalling:** send small, signed and encrypted messages to an address.
5. **Connection:** `connect(address)` returns an open `RTCDataChannel`. Direct by default. Relayed through another peer's TURN only if the relay policy allows it (§7).

### Out of scope, permanently
- Anything on top of the DataChannel (framing, RPC, files, media)
- Peer gossip, introductions, rooms/topics, reputation, incentives, telemetry
- Our own WebRTC stack (browsers have one; native runtimes use a standard library, §8)
- WebSocket, WebTransport, UPnP/NAT-PMP, running DNS servers, ICMP, pkarr HTTP endpoints, crypto fallbacks for old browsers (unsupported browsers get a clear `unsupported` error)

### Done when
- [ ] `npm test` is green under Node, Bun and Deno; browser tests pass in Chromium, Firefox and WebKit
- [ ] A Beacon from our code round-trips through the public pkarr relay (real Mainline compatibility)
- [ ] **The proof:** two browsers on unrelated networks, knowing only each other's address, open a verified **direct** DataChannel with TURN disabled
- [ ] The same with `relay: 'fallback'` forced through TURN; and a Node peer ↔ browser using the default native WebRTC library
- [ ] A fresh node with no configuration finds anchors via the homepage/HTTP, DNS TXT, the Mainline DHT and the LAN
- [ ] Every HTTP-reachable node serves the homepage
- [ ] README + `SPEC.md` written. From then on: bug fixes only.

---

## 2. Built to last

- **Standard foundations:** BitTorrent KRPC (BEP 5, 43, 44), pkarr records, DNS TXT, HTTP/1.1, STUN/TURN (RFC 5389/5766), mDNS, and the W3C WebRTC and WebCrypto APIs.
- **Our own protocol on top, versioned as `rv/1`:** the `rv_*` queries, anchor lines, the message format, the anchor book rules and the connect flow. These are specified in `SPEC.md` with test vectors. The protocol only grows: fields and queries never change meaning, new ones get new names, and unknown fields are ignored.
- **Core has zero runtime dependencies and no build step.** Plain ESM JavaScript; the browser loads the same files Node runs. Native runtimes get one *optional* default WebRTC library (§8).
- **Standard crypto only:** WebCrypto Ed25519, X25519, HKDF-SHA256, AES-GCM, SHA-1/256. No custom key conversions.
- **Small but not at the expense of safety.** Target is roughly 1,700 lines; correctness and tests come first.
- **Platforms:** current Chrome, Firefox, Safari; Node ≥ 22, Bun ≥ 1.1, Deno ≥ 2 (via `npm:rendezvous`).

---

## 3. Architecture

```
          UDP (KRPC · STUN/TURN)                       HTTP POST /krpc
 Mainline ◄───────────────► ANCHOR ◄──────────────────────────────── any client
 DHT nodes                     ▲ ▲                                   (browser, Node, Bun, Deno, curl)
                     UDP KRPC  │ │ LAN: broadcast "RV?" + mDNS
                      ANCHOR ◄─┘ └─► native nodes on the same network

 PEER A ◄═════════════ RTCDataChannel (direct; TURN only if allowed) ═════════════► PEER B
```

| Role | Who | Does |
|---|---|---|
| **Anchor** | a native node with at least one verified public service (UDP and/or HTTP) | DHT node (if UDP), HTTP `/krpc` + homepage (if HTTP), inboxes, STUN, TURN (if enabled), anchor book, LAN responder |
| **Native peer** | Node/Bun/Deno behind NAT | HTTP client; keeps and shares an anchor book; LAN responder |
| **Browser peer** | any web page; **opportunistic**: may sleep or vanish at any time, holds no responsibility for others | HTTPS client; keeps and shares an anchor book |

**Two transports, one message format (bencoded KRPC):**
- **UDP:** node ↔ node, Mainline, STUN/TURN, LAN discovery.
- **HTTP `POST /krpc`:** every client ↔ anchor. Browsers need an HTTPS origin (`web=`, e.g. through a Cloudflare tunnel; the tunnel covers HTTP only, not the anchor's UDP DHT/TURN). Natives may use `http://ip:port`.

---

## 4. Identity, records and messages

```
Seed       32 random bytes (the only secret to back up)
Identity   Ed25519 key  = from HKDF(seed, "rv/ed25519")    → address = z32(ed_pk), 52 chars
Encryption X25519 key   = from HKDF(seed, "rv/x25519")     → published in the Beacon, signed by the identity key
Anchor     rv-anchor:<z32>@<ip>:<port>[;web=<https origin>][;q=<0-100>]                 ≤ 255 chars
Beacon     pkarr signed packet (BEP 44 mutable item at SHA1(ed_pk)), ≤ 1000 B, TXT "_rv":
           x=<b64 x25519_pk>   c=<inbox anchor url> (1..n)   [app-defined k=v]
Message    eph_x 32 | iv 12 | AES-GCM_K( inner ) | tag 16                                ≤ 4 KB
           K     = HKDF-SHA256( X25519(eph_sk, recipient_x), info = "rv/msg" ‖ eph_x ‖ recipient_x )
           inner = bencode{ from: ed_pk, to: recipient_ed_pk, id: 16 B, ts, body } ‖ Ed25519 sig over all of it
TURN       user = "<expiry>:<z32>", pass = base64(HMAC-SHA1(anchor_secret, user))
```
- **Sealed sender:** each message uses a fresh ephemeral X25519 key, so a recipient's long-term key alone can't decrypt past messages, and keys are never reused across directions.
- **Sender attribution comes from the Ed25519 signature,** not from the shared key. The signature covers `to`, which stops reflection and redirection attacks.
- **Receivers accept a message only if** the signature is valid, `to` is them, `|now − ts| < 10 min`, and the `id` is new. A sender's X25519 key is learned from its Beacon when it's needed (e.g. to reply).

---

## 5. Protocol `rv/1` (KRPC)

| Query | Source | Request → Reply |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get_peers`, `announce_peer` | BEP 5 | anchors announce on infohash `SHA1("rendezvous anchors v1")`. **One opportunistic bootstrap source**, not an authority: results can be stale or hostile and are verified like any other line |
| `get`, `put` | BEP 44 | resolve / publish a Beacon (signature, seq and token checked) |
| `rv_hi {n}` | ours | → `{k, sig=Ed25519("rv-hi" ‖ n), web?}`: proves the anchor holds its key (identity only, says nothing about reachability) |
| `rv_anchors {}` | ours | → `{a}`: best 32 + 8 random anchor lines |
| `rv_check {port}` | ours | the anchor asks a *different* anchor to probe the caller's UDP and HTTP → `{udp, http}` |
| `rv_send {to, msg}` | ours | → `{queued}`: stored for that address (2 min, ≤ 64 per address, dedup by message `id`, so retries are idempotent). *Queued ≠ delivered*; delivery is only known when the peer answers |
| `rv_listen {k, ts, sig, after?}` | ours | **long poll**, waits ≤ 25 s → `{msgs: [{seq, msg}]}`. `after` acknowledges everything up to that `seq`, which the anchor then deletes (at-least-once delivery; receivers dedup by `id`). A newer poll for the same key ends the older one with an empty reply |
| `rv_turn {k, ts, sig}` | ours | → `{user, pass, ttl, urls}` (only if the anchor runs TURN) |

**HTTP details:**
- **Requests:** `POST /krpc` with `Content-Type: text/plain` (a CORS "simple request", so browsers send no preflight). `OPTIONS` is still answered. Body ≤ 8 KB.
- **Every reply is a KRPC reply**, including errors.
- **Clients retry** with backoff, and the same `t` (transaction id) is answered from a short replay cache, so a retried `POST` never executes twice.

**Anchor HTTP endpoints:** `GET /` (homepage = anchor list) · `POST /krpc` · `GET /rv/*.js` (the library) · `GET /demo`. CORS `*` everywhere.

### The homepage (`GET /`)
Every node reachable over HTTP serves a thin page, so anyone who stumbles on it learns what it is and how to join.
1. **What this is:** two sentences ("A Rendezvous anchor: it helps peers find each other by key and open direct WebRTC connections. It stores nothing but signed address records and short-lived encrypted messages.")
2. **This node:** its anchor line, which services it offers (UDP/HTTP/TURN), and its uptime
3. **How to use it:**
   - browser: `import { Peer } from '<origin>/rv/index.js'`
   - native: `npx rendezvous node`
   - shell: `curl -s <origin> | grep -o 'rv-anchor:[^ <]*'`
   - plus links to `/demo` and the repo
4. **Known anchors:** the shared view, one anchor line per row with its score, in a `<pre>`

Rules:
- server-rendered from one template string, **no JavaScript, no external requests**
- ≤ 10 KB, system font, dark and light mode, readable on a phone
- every dynamic value HTML-escaped
- **it is the anchor list:** there's no `/anchors.txt` endpoint, and machines use `rv_anchors`.

---

## 6. The anchor book

**Line:** `rv-anchor:<z32>@203.0.113.7:4799;web=https://a.example.org;q=93`. Readers grep any text for `rv-anchor:[^\s"'<]+`. Web pages, READMEs, gists, DNS TXT records, invite links and pasted text all work as sources with no extra code.

**Each entry tracks every service separately**, so a working HTTPS tunnel can't make a dead DHT port look healthy:
```
identity_verified   rv_hi signature valid (with a random nonce)
http_ok / udp_ok / turn_ok    EWMA(probe success, α = 0.2) per service
rtt, first_seen, last_ok
```
- **Score:** `q = round(100 · max(service ok) · min(1, days_known/7)^½)`. Browsers rank by `http_ok`, natives by `udp_ok` (falling back to `http_ok`). A `q` received from others is only a hint, capped at 50 until verified locally.
- **Size and pruning:** ≤ 1000 entries; dropped when `q < 10` and no success for 7 days. Anchors re-probe 64 entries every 10 min (≤ 16 unverified probes per minute).
- **Shared view:** best 32 + 8 random (so new anchors spread before they have a score).
- **Spreading:** every 10 min each anchor pulls `rv_anchors` from 3 random anchors. Clients pull from every anchor they use. New anchors `announce_peer` and send `rv_hi` to known anchors, which probe back.

**Bootstrap channels** (all tried in parallel, the first verified anchor wins):

| Channel | Browser | Native |
|---|---|---|
| Local cache (IndexedDB / `~/.config/rv/anchors.txt`) | ✅ | ✅ |
| Baked-in `anchors.txt` file (in the package / repo) | ✅ | ✅ |
| Any text: invite link, paste, file, any URL incl. any anchor's homepage (`sources: [...]`) | ✅ (HTTPS + CORS) | ✅ |
| `rv_anchors` on any known anchor | ✅ (`web=` anchors) | ✅ |
| DNS TXT `_rv-anchors.<domain>` (`dohDomains: [...]`) | ✅ via public DoH JSON | ✅ via system resolver |
| Mainline `get_peers` on the anchor infohash | ❌ | ✅ |
| LAN: UDP broadcast/multicast `RV?` on port 4799, mDNS `_rv._udp.local` TXT | ❌ | ✅ (every native node answers) |

**Automatic promotion:** every native node calls `rv_check` at start and every 30 min. Each service that strangers can reach is switched on: UDP → DHT server mode, STUN, `announce_peer`, TURN if `--turn`; HTTP → homepage and `/krpc` for others. `--no-anchor` opts out.

---

## 7. `connect(address, { relay })`

Plain standard offer/answer. **No SDP templates and no SDP editing.**
```
1 RESOLVE  Beacon of B (newest valid seq) → B's x25519 key + inbox anchors
2 ICE      iceServers = STUN on own anchors (+ TURN from rv_turn if relay ≠ 'never')
3 OFFER    A: createOffer → setLocalDescription → msg {t:'offer', sid, sdp}
4 ANSWER   B: setRemoteDescription → createAnswer → setLocalDescription → msg {t:'answer', sid, sdp}
5 TRICKLE  both send msg {t:'cand', sid, c} as candidates appear; candidates that arrive early are queued
6 VERIFY   getStats(): kind = 'direct' | 'turn'. With relay = 'never', a relayed pair → close + error
7 OPEN     negotiated DataChannel (id 0) open → { channel, pc, kind }
Errors:    'not-found' | 'no-answer' | 'ice-failed' | 'relayed' | 'timeout' | 'no-webrtc' | 'unsupported'
```
- **Relay policy:** `relay: 'never' | 'fallback'`, with **default `'never'`** (no conversation relays unless the app opts in). Apps that want "always connects" set `'fallback'`. TURN is used only then, and only if an anchor offers it.
- **Identity binding:** offer and answer travel inside signed, encrypted messages, so each DTLS fingerprint is bound to the sender's Ed25519 key. Nobody else can inject or swap an SDP.
- **A whole SDP is ~0.6–1.5 KB.** That's why the message cap is 4 KB.

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
- **Tested alternative: `node-datachannel`** (libdatachannel, native, faster), e.g. `Peer.create({ RTCPeerConnection: (await import('node-datachannel/polyfill')).RTCPeerConnection })`.
- **The contract, the minimum interface we use** (documented in `SPEC.md`; any implementation that satisfies it works):
  - `new RTCPeerConnection({ iceServers, iceTransportPolicy })`
  - `createDataChannel(label, { negotiated: true, id: 0 })`
  - `createOffer()`, `createAnswer()`, `setLocalDescription(d)`, `setRemoteDescription(d)`, `addIceCandidate(c)`, `getStats()`, `close()`
  - events: `onicecandidate`, `onconnectionstatechange` / `connectionState`
  - channel: `send`, `close`, `readyState`, `binaryType`, `onopen`, `onmessage`, `onclose`
- **Our tests run against both libraries.** If `werift` ever goes unmaintained, the default moves to `node-datachannel` with no API change.

---

## 9. Limits enforced in code

- **Beacon:** signature, monotonic seq, ≤ 1000 B, checked on store and on use.
- **Message:** ≤ 4 KB, signature, `to`, ts window, id dedup.
- **Per IP, one token bucket** (cost: `put` 6, `rv_check` 12, `rv_turn` 6, `rv_send` 1, others 0.5; refill 60/min). HTTP body ≤ 8 KB; ≤ 4 open long polls per IP.
- **DHT:** tokens = SHA1(secret ‖ ip), rotated every 10 min; routing table ≤ 1000; responders added only after they answer.
- **Book:** lines ≤ 255 chars; public unicast IPs only (except entries learned on the LAN).
- **TURN (opt-in `--turn`):**
  - 10-min allocations, ≤ 4 per key, ≤ 1 Mbit/s and 500 MB each
  - **never relays to private, loopback or link-local addresses** (no reaching into the anchor's LAN)

---

## 10. Files (~1,700 lines)

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
| `src/rtc.js` | `connect`/`accept`: offer/answer/trickle, relay policy, `kind` via getStats | 110 | ✏️ |
| `src/anchor.js` | UDP demux, HTTP server, inboxes, `rv_*` handlers, token bucket, replay cache | 220 | ✏️ |
| `src/home.js` | homepage template | 50 | ⬜ |
| `src/turn.js` | STUN binding + TURN server (UDP, long-term auth, allocate/refresh/permission/channel-bind/send/data), quotas | 300 | ⬜ |
| `src/lan.js` | broadcast/multicast + mDNS responder and query | 100 | ⬜ |
| `src/node.js` | native wiring: UDP socket, book file, LAN, DNS lookup, promotion, default WebRTC loader | 100 | ⬜ |
| `bin/rv.js` | `rv node \| anchor \| anchors \| id \| resolve` | 50 | ✏️ |
| `src/demo.html` · `anchors.txt` | two-tab chat demo at `/demo` · baked-in list | 60 | ✏️ |

---

## 11. API (all of it)

```js
import { Peer } from 'rendezvous'                 // browsers: https://<anchor>/rv/index.js · Deno: npm:rendezvous

const me = await Peer.create({
  seed,                                           // optional; persisted by the caller
  anchors, sources, dohDomains,                   // optional extra bootstrap inputs
  RTCPeerConnection,                              // optional: overrides the default (§8)
  relay: 'never'                                  // or 'fallback'
})
me.address                                        // permanent, shareable
await me.publish()                                // Beacon → DHT, refreshed every 30 min
me.accept(({ from, channel, kind }) => {})        // incoming DataChannels
const { channel, kind } = await me.connect(address, { relay })

me.anchors()  /  me.addAnchors(text)              // export / import anchor lines
await me.resolve(address)                         // Beacon fields
await me.send(address, body);  me.on(fn)          // raw signed + encrypted messages
me.close()
```
CLI: `rv node` (a peer that promotes itself), `rv anchor [--turn]`, `rv anchors`, `rv id`, `rv resolve <addr>`.

---

## 12. Tests

| Test | Proves |
|---|---|
| `core` | encodings round-trip; truncated bencode can't hang; seed → same keys everywhere; Beacon tamper; message tamper, **reflection**, redirection (`to`) and replay rejected; anchor lines grepped from messy text; score maths |
| `dht` | 20 loopback nodes: put/get, stale seq + bad signature rejected, announce_peer → get_peers |
| `book` | 10 anchors, each knowing one neighbour, converge to all 10; a wrong-key line is never verified; an anchor with HTTP up but UDP dead scores well for browsers only; a dead anchor decays |
| `anchor` | 3 chained anchors: A publishes on #1, B on #3 resolves and sends, A's long poll receives; retried POST not executed twice; `after` acks delete; newer poll ends the older one; `rv_check` turns on only reachable services; token bucket |
| `home` | `GET /` ≤ 10 KB, no `<script>`, no external URLs, escapes a hostile line, `addAnchors(page)` recovers every listed anchor |
| `turn` | Chromium with `iceTransportPolicy: 'relay'` connects through our TURN; bad credentials, quotas and private-address peers rejected |
| `lan` | broadcast and mDNS discovery between two nodes |
| `browser` | Playwright **Chromium, Firefox, WebKit**: two pages bootstrap from an anchor homepage, connect **direct with relay 'never'** (`kind: 'direct'`), then forced relay with `'fallback'` (`kind: 'turn'`); `'never'` + relay-only ICE → `'relayed'`/`'ice-failed'` error |
| `native` | Node ↔ Chromium and Node ↔ Node with **werift** and with **node-datachannel**; Bun and Deno run `core`, `anchor` and Node ↔ Node with werift |
| `live` (manual) | Beacon via `relay.pkarr.org`; TXT via public DoH; `announce_peer` on real Mainline |

---

## 13. Build order

1. `crypto` (seed → keys), `message`, `dht` hooks + get_peers/announce_peer → `core`, `dht`
2. `book` + `rv_hi`/`rv_anchors` → `book`
3. `anchor` (HTTP `/krpc`, long poll, acks, replay cache, inboxes) + `peer` HTTP client + `home` → `anchor`, `home`
4. `rtc` (standard offer/answer, relay policy) → `browser` direct
5. `turn` → `turn`, `browser` relayed
6. `node` (default WebRTC loader, promotion, DNS, cache) + `lan` → `native`, `lan`
7. CLI, demo, `anchors.txt`, `live` run, README + `SPEC.md`. **Done.**

---

## 14. Decisions taken in review (and why)

| Change | Why |
|---|---|
| **Separate X25519 key** (from the same seed) instead of converting Ed25519 → X25519 | Uses only standard WebCrypto operations. The key is published in the Beacon, which we always resolve anyway. |
| **Sealed-sender messages:** ephemeral ECDH + Ed25519 signature over `to` | The old shared static key couldn't prove who sent a message and allowed reflecting a message back to its sender. Now sender attribution is explicit and keys are never reused across directions. |
| **Full SDP offer/answer**, no templates | Robust across Chrome, Firefox, Safari and native libraries. Costs ~1 KB per connection, so the message cap goes up to 4 KB. |
| **Relay default `'never'`**, TURN opt-in (`relay: 'fallback'`, `rv anchor --turn`) | "Direct only" is the safe default; apps that want peer relays turn them on. |
| **TURN sized honestly at ~300 lines**, with private-address blocking | A UDP-only, WebRTC-only subset of a frozen RFC, tested against Chromium's strict TURN client. Anchors that don't want to relay simply don't pass `--turn`. |
| **Mainline `get_peers` is one bootstrap source, not "the directory"** | Its results can be stale or hostile. The verified anchor book is the foundation. |
| **Separate identity and per-service reachability** in the book | A working HTTPS tunnel must not make a dead UDP/DHT port look healthy. |
| **Idempotent HTTP:** retry cache, message ids, acked long polls, `text/plain` POST | Retries never execute twice, nothing is silently lost, and browsers send no CORS preflight. |
| **Default native WebRTC = `werift`** (optional dependency), injectable | Pure JS on Node, Bun and Deno; replaceable without API changes. |
| **No hard line limit** | Safety and tests matter more than the line count. |

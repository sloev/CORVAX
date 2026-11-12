# Rendezvous: Plan v1.0 (frozen scope)

> **Find any peer by its key, from any runtime, and open a WebRTC DataChannel to it: direct, or relayed by another peer.**

---

## 1. Scope

Rendezvous does five things and then gets out of the way:

1. **Identity:** an Ed25519 key pair. The public key is the permanent address.
2. **Anchor book:** every node keeps a scored list of public anchors (the bootstrap nodes) and shares it over every channel it has.
3. **Discovery:** publish a signed record under your address; anyone can resolve it.
4. **Signalling:** send small encrypted messages to an address.
5. **Connection:** `connect(address)` returns an open `RTCDataChannel`, direct when possible, otherwise relayed through a peer's TURN.

### Out of scope, permanently
- Anything on top of the DataChannel (framing, RPC, files, media)
- Peer gossip, introductions, rooms/topics, reputation, incentives
- **Our own WebRTC stack.** Browsers have one built in. Node/Bun/Deno pass in any standard `RTCPeerConnection` (e.g. `node-datachannel`, `werift`). Without one, a native node can still do everything except `connect()`.
- WebSocket, WebTransport, UPnP/NAT-PMP port mapping, running DNS servers, ICMP, pkarr HTTP endpoints, telemetry, crypto fallbacks for old browsers

### Done when
- [ ] `npm test` is green under Node and Bun, and the browser tests pass in Chromium, Firefox and WebKit
- [ ] A Beacon from our code round-trips through the public pkarr relay (proves real Mainline compatibility)
- [ ] Two browsers on different networks connect knowing only each other's address, both direct and forced through TURN
- [ ] A fresh node with no configuration finds anchors via HTTP, DNS TXT, the Mainline DHT and the LAN
- [ ] Every HTTP-reachable node serves the homepage (what it is, how to use it, known anchors)
- [ ] README written. From then on: bug fixes only.

---

## 2. Built to last

- **Only frozen standards:** BitTorrent KRPC (BEP 5, 43, 44), DNS TXT, HTTP/1.1, STUN/TURN (RFC 5389/5766), the W3C WebRTC and WebCrypto APIs, mDNS. None of these are expected to change.
- **Zero runtime dependencies, no build step.** Plain ESM JavaScript. The browser loads the same files Node runs.
- **The protocol only grows:** fields and queries never change meaning; new things get new names. Unknown fields are ignored.
- **Small:** about 1,500 lines, every file under 250 lines, each with one job.
- **Platforms:** current Chrome, Firefox and Safari (WebCrypto Ed25519/X25519 required); Node ≥ 22, Bun ≥ 1.1. Deno works through its Node compatibility, best effort.

---

## 3. Architecture

```
          UDP (KRPC · STUN/TURN)                       HTTP POST /krpc
 Mainline ◄───────────────► ANCHOR ◄──────────────────────────────── any client
 DHT nodes                     ▲ ▲                                   (browser, Node, Bun, curl)
                     UDP KRPC  │ │ LAN: broadcast "RV?" + mDNS
                      ANCHOR ◄─┘ └─► native nodes on the same network

 PEER A ◄═════════ RTCDataChannel (direct, or via an anchor's TURN) ═════════► PEER B
```

| Role | Who | Does |
|---|---|---|
| **Anchor** | any native node whose UDP+TCP port passes the reachability check | DHT node, HTTP `/krpc`, inboxes, STUN/TURN, anchor book, LAN responder |
| **Native peer** | Node/Bun behind NAT | client over HTTP; keeps and shares an anchor book; LAN responder |
| **Browser peer** | any web page | client over HTTPS; keeps and shares an anchor book |

**Two transports, one message format (bencoded KRPC):**
- **UDP:** node ↔ node, Mainline, STUN/TURN, LAN discovery.
- **HTTP `POST /krpc`:** every client ↔ anchor. Body = one query, response = one reply. Browsers need anchors with an HTTPS origin (`web=`); natives can use plain `http://ip:port`.

---

## 4. Formats

```
Address   z32(ed25519_pk)                                                      52 chars
Anchor    rv-anchor:<z32>@<ip>:<port>[;web=<https origin>][;q=<0-100>]         one line, ≤ 255 chars
Beacon    pkarr signed packet: sig 64 | seq 8 (BE µs) | DNS packet             ≤ 1000 B
          TXT "_rv" = "c=<anchor http(s) url>"  (1..n: where my inbox is)
Message   from_pk 32 | iv 12 | AES-GCM_K( ts 8 | bencode(body) ) | tag 16    ≤ 1024 B
K         HKDF-SHA256( X25519(ed→x(sk), ed→x(pk_peer)), salt = sorted(pk_a ‖ pk_b), "rv/msg" )
TURN      user = "<expiry>:<z32>", pass = base64(HMAC-SHA1(anchor_secret, user))
```
- A **Beacon** is a BEP 44 mutable item stored at `SHA1(pk)`. It's pkarr-compatible, so it lives on the real Mainline DHT.
- **Messages** are accepted only if `|now − ts| < 10 min` and the IV hasn't been seen before. AEAD authenticates the sender.

---

## 5. Protocol (KRPC queries)

| Query | Source | Request → Reply |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get_peers`, `announce_peer` | BEP 5 | anchors announce on infohash `SHA1("rendezvous anchors v1")`: **Mainline is the global anchor directory** |
| `get`, `put` | BEP 44 | resolve / publish a Beacon (signature, seq and token checked) |
| `rv_hi {n}` | ours | → `{k, sig=Ed25519(n), web?}`: proves the anchor holds the key in its anchor line |
| `rv_anchors {}` | ours | → `{a}`: best 32 + 8 random anchor lines |
| `rv_check {port}` | ours | the anchor asks a *different* anchor to `rv_hi` the caller → `{reachable}` |
| `rv_send {to, msg}` | ours | → `{ok}`: queue for that address (2 min, ≤ 64 per address) |
| `rv_listen {k, ts, sig}` | ours | **long poll**: waits ≤ 25 s → `{msgs: [...]}`. `sig` = Ed25519(`"rv-listen:" ‖ ts`), ±5 min |
| `rv_turn {k, ts, sig}` | ours | → `{user, pass, ttl, urls}` for this anchor's TURN |

**Anchor HTTP endpoints:** `GET /` (homepage, below; it is also the anchor list) · `POST /krpc` · `GET /rv/*.js` (the library) · `GET /demo` (two-tab chat demo). CORS `*` on everything.

### The homepage (`GET /`)
Every node reachable over HTTP serves a thin page, so anyone who stumbles on an anchor's address learns what it is and how to join.
- **Content, in this order:**
  1. **What this is:** two sentences ("A Rendezvous anchor: it helps peers find each other by key and open direct WebRTC connections. It stores nothing but signed address records and short-lived encrypted messages.")
  2. **This node:** its own anchor line, its uptime, and whether it is an anchor or a plain node
  3. **How to use it:**
     - browser: `import { Peer } from '<this origin>/rv/index.js'`
     - native: `npx rendezvous node`
     - list: `curl -s <this origin> | grep -o 'rv-anchor:[^ <]*'`
     - plus links to `/demo` and the repo
  4. **Known anchors:** the book's shared view (best 32 + 8 random), one anchor line per row with its score, inside a `<pre>`
- **Rules:**
  - server-rendered from one template string, **no JavaScript, no external requests** (no fonts, images or CDNs)
  - ≤ 10 KB, with a system font
  - dark and light mode via `prefers-color-scheme`
  - readable on a phone
  - all dynamic values HTML-escaped
- **It is the anchor list:** the anchor lines appear verbatim, so the page itself is a valid `sources` URL and a greppable channel (§6). There is no separate `/anchors.txt` endpoint; machines use `rv_anchors`.

---

## 6. The anchor book

**Line:** `rv-anchor:<z32>@203.0.113.7:4799;web=https://a.example.org;q=93`
- **Greppable:** readers scan any text for `rv-anchor:[^\s"'<]+`. Web pages, READMEs, gists, DNS TXT records, invite links and pasted text all work as sources with zero code.
- **Verified before use:** a line is a claim. A node sends `rv_hi` with a random nonce, and only a valid signature makes the anchor *verified*.
- **Scored locally:** `ok = EWMA(probe success, α=0.2)`, `q = round(100 · ok · min(1, days_known/7)^½)`. A `q` received from others is only a hint (counted as at most 50 until verified).
- **Kept tidy:** ≤ 1000 entries; dropped when `q < 10` and no success for 7 days. Anchors re-probe 64 entries every 10 min.
- **Shared as:** best 32 + 8 random, so new anchors spread before they have a score.

**Spreading:** every 10 min each anchor pulls `rv_anchors` from 3 random anchors in its book. Clients pull from every anchor they use. New anchors `announce_peer` on Mainline and send `rv_hi` to the anchors they know (which probe back).

**Bootstrap channels** (all tried in parallel, first verified anchor wins):

| Channel | Browser | Native |
|---|---|---|
| Local cache (IndexedDB / `~/.config/rv/anchors.txt`) | ✅ | ✅ |
| Baked-in `anchors.txt` file (shipped in the package / repo) | ✅ | ✅ |
| Any text: invite link, paste, file, any URL (`sources: [...]`), including any anchor's homepage | ✅ (HTTPS + CORS) | ✅ |
| `GET /` (homepage) / `rv_anchors` on any known anchor | ✅ (`web=` anchors) | ✅ |
| DNS TXT `_rv-anchors.<domain>` (`dohDomains: [...]`) | ✅ via public DoH JSON | ✅ via system resolver |
| Mainline `get_peers` on the anchor infohash | ❌ | ✅ |
| LAN: UDP broadcast/multicast `RV?` on port 4799, mDNS `_rv._udp.local` TXT | ❌ | ✅ (every native node answers) |

**Automatic promotion:** every native node calls `rv_check` at start and every 30 min. If it's reachable from a stranger, it becomes an anchor: DHT server mode, TURN on, `announce_peer`. `--no-anchor` opts out. Hosts with a public IPv4, IPv6 or a manual port forward qualify. Browsers can't be anchors, but they share their book (invite links, `me.anchors()`).

---

## 7. `connect(address)`

```
1 RESOLVE  Beacon of B (newest valid seq) → B's inbox anchors (c=)
2 RELAYS   rv_turn on own anchors → iceServers = STUN + TURN on own anchors
3 OFFER    A → B  msg {t:'rtc', sid, ufrag, pwd, fp}          A builds B's remote SDP from a template after step 4
4 ANSWER   B → A  msg {t:'rtc-ok', sid, ufrag, pwd, fp}       B builds A's offer from the same template
5 ICE      both trickle msg {t:'rtc-c', sid, c}; ICE prefers host/srflx, falls back to TURN
6 OPEN     negotiated DataChannel id 0 opens → { channel, pc, kind: 'direct' | 'turn' }
Errors:    'not-found' | 'no-answer' | 'ice-failed' | 'timeout' | 'no-webrtc'
```
- **No SDP on the wire and no SDP editing:** each side reads its own ufrag/pwd/fingerprint from its local SDP, sends them in a message, and builds the remote SDP from a 15-line template.
- **Identity is implicit:** only the holder of the address's key can read and answer the `rtc` message, and fingerprints arrive inside authenticated messages, so the DTLS channel is bound to both keys.

---

## 8. Limits enforced in code

- **Records:** Beacon signature + monotonic seq + ≤ 1000 B, checked on store and on use. Messages ≤ 1024 B, AEAD, ts window, IV dedup.
- **Per IP, one token bucket** (cost per query: `put` 6, `rv_check` 12, `rv_turn` 6, `rv_send` 1, others 0.5; refill 60/min). HTTP body ≤ 4 KB.
- **DHT:** tokens = SHA1(secret ‖ ip), rotated every 10 min; routing table ≤ 1000; responders added only after they answer.
- **Book:** lines ≤ 255 chars, public unicast IPs only (except those learned on the LAN), ≤ 16 unverified probes per minute.
- **TURN:** 10-min allocations, ≤ 4 per key, ≤ 1 Mbit/s and 500 MB each.

---

## 9. Files (~1,550 lines)

| File | Job | Lines | Draft? |
|---|---|---|---|
| `src/bytes.js` | hex, base64url, z-base32, u64, concat | 45 | ✅ |
| `src/crypto.js` | WebCrypto: Ed25519, X25519, ed→x, HKDF, AES-GCM, SHA-1 | 55 | ✅ |
| `src/bencode.js` | bencode (hardened) | 45 | ✅ |
| `src/record.js` | Beacon, BEP 44 signable, DNS TXT codec (also used by mDNS) | 80 | ✅ |
| `src/dht.js` | sans-IO KRPC node: routing, lookup, get/put, get_peers/announce_peer, query hooks | 200 | ✏️ |
| `src/book.js` | anchor lines: grep, format, score, merge, probe queue | 140 | ⬜ |
| `src/peer.js` | `Peer`: identity, book, HTTP client, publish/resolve/send/listen | 170 | ✏️ |
| `src/rtc.js` | `connect`/`accept` over any `RTCPeerConnection` | 90 | ✏️ |
| `src/anchor.js` | UDP demux, HTTP server, inboxes, `rv_*` handlers, token bucket | 200 | ✏️ |
| `src/home.js` | homepage template (escaped, no JS, ≤ 10 KB) | 50 | ⬜ |
| `src/turn.js` | STUN binding + TURN server subset | 200 | ⬜ |
| `src/lan.js` | broadcast/multicast + mDNS responder and query | 100 | ⬜ |
| `src/node.js` | native wiring: UDP socket, book file, LAN, DNS lookup, promotion | 90 | ⬜ |
| `bin/rv.js` | `rv node \| anchor \| anchors \| id \| resolve` | 50 | ✏️ |
| `src/demo.html` · `anchors.txt` | two-tab chat demo (served at `/demo`) · baked-in list | 60 | ✏️ |

---

## 10. API (all of it)

```js
import { Peer } from 'rendezvous'                 // browsers: import from https://<anchor>/rv/index.js

const me = await Peer.create({
  seed,                                           // optional; persisted by the caller
  anchors, sources, dohDomains,                   // optional extra bootstrap inputs
  RTCPeerConnection                               // optional outside browsers
})
me.address                                        // permanent, shareable
await me.publish()                                // Beacon → DHT, refreshed every 30 min
me.accept(({ from, channel }) => {})              // incoming DataChannels
const { channel, kind } = await me.connect(address)

me.anchors()  /  me.addAnchors(text)              // export / import anchor lines
await me.resolve(address)                         // Beacon fields
await me.send(address, body);  me.on(fn)          // raw encrypted messages
me.close()
```
CLI: `rv node` (peer that promotes itself), `rv anchor` (forced anchor), `rv anchors` (print book), `rv id`, `rv resolve <addr>`.

---

## 11. Tests

| Test | Proves |
|---|---|
| `core` | encodings round-trip; truncated bencode can't hang; ed→x equals the derived X25519 key; Beacon and message tamper/replay rejected; anchor lines grepped from messy text; score maths |
| `dht` | 20 loopback nodes: put/get, stale seq + bad signature rejected, announce_peer → get_peers |
| `book` | 10 anchors, each knowing one neighbour, converge to all 10; a line with the wrong key is never verified; a dead anchor's score decays |
| `home` | `GET /` returns HTML ≤ 10 KB with no `<script>` and no external URLs; contains this node's anchor line and the shared anchor lines; a book line containing `<script>` comes out escaped; grepping the page with `addAnchors()` recovers every listed anchor |
| `anchor` | 3 chained anchors: A publishes on #1, B on #3 resolves and sends, A's long poll receives; `rv_check` promotes reachable nodes only; token bucket triggers |
| `turn` | allocate → permission → data via the relay; bad credentials and quotas enforced |
| `lan` | broadcast and mDNS discovery between two nodes on loopback/multicast |
| `browser` | Playwright **Chromium, Firefox, WebKit**: two pages bootstrap from an anchor's homepage (`sources: [origin]`), connect direct, then forced relay (`iceTransportPolicy: 'relay'` → `kind: 'turn'`) |
| `live` (manual) | Beacon via `relay.pkarr.org`; TXT via public DoH; `announce_peer` on real Mainline |

---

## 12. Build order

1. `dht.js` hooks + get_peers/announce_peer → `core`, `dht`
2. `book.js` + `rv_hi`/`rv_anchors` → `book`
3. `anchor.js` HTTP `/krpc` + long poll + inboxes, `peer.js` HTTP client → `anchor`
4. `turn.js`, `rtc.js` → `turn`, `browser`
5. `lan.js`, `node.js` (promotion, DNS, cache) → `lan`, promotion part of `anchor`
6. `home.js`, CLI, demo, `anchors.txt`, `live` run, README. **Done.**

---

## 13. Cut in this revision, and why

| Cut | Lines saved | Reason |
|---|---|---|
| Own WebRTC subset (ICE/DTLS/SCTP/X.509) + its fallbacks + Safari WebDriver CI | ~1,900 | Biggest maintenance burden: it has to track browser TLS stacks for years. Browsers have WebRTC built in; natives plug in any standard implementation. |
| WebSocket transport | ~150 | `HTTP POST /krpc` with long polling covers every runtime with one code path |
| SDP editing / derived ICE credentials | ~20, plus a risk | Browsers may block editing. Sending the real credentials costs about 40 bytes and is fully standard |
| UPnP / NAT-PMP / PCP | ~100 | Router quirks mean endless fixes. Promotion works for public IPv4, IPv6 and manual forwards |
| DNS server, DoH endpoint, ICMP | ~80 | Reading DNS TXT is enough; publishing is the domain owner's job (`rv anchors` → zone records) |
| pkarr relay endpoints, `/stats` telemetry, pure-JS crypto fallback | ~280 | Redundant (`/krpc` covers them), not needed, or obsolete (all current browsers have Ed25519/X25519) |

# CORVAX: Plan v1.0

> **Find any peer by its key or by a topic, from any runtime, and open an encrypted WebRTC DataChannel to it.**
> The infrastructure introduces. The peers communicate.

This document is the implementation specification. Wire-level details are mirrored in `SPEC.md` (protocol `cx/1`).

---

## 1. Scope

CORVAX does seven things and then gets out of the way:

1. **Identity:** one seed → an Ed25519 identity key (the permanent address) + an X25519 encryption key.
2. **Anchor book:** every node keeps a verified, scored list of public anchors (the bootstrap nodes) and shares it over every channel it has.
3. **Discovery by key:** publish a signed record (Beacon) under your address; anyone can resolve it.
4. **Signalling:** send small, signed and encrypted messages to an address.
5. **Connection:** `connect(address)` returns an open channel: a direct `RTCDataChannel` when possible, otherwise relayed through any third peer both sides can reach, end-to-end encrypted.
6. **Topic presence:** peers publish leased, signed provider records for topics they take part in; anyone can search a topic and watch its presence change.
7. **Topic broadcast:** short, signed, best-effort messages spread peer-to-peer among a topic's members over WebRTC.

The protocol ends at open DataChannels, presence results and delivered broadcasts. What peers do with them is up to them.

### Peers and anchors

**There is one kind of CORVAX peer.** An anchor is not a separate node type, identity or protocol role.

**Every peer MAY** (whenever its runtime and reachability allow it):
- publish, discover, subscribe to and unsubscribe from topics
- publish signed, leased provider records
- store, validate and serve provider records (`cx_tpub`/`cx_tfind`/`cx_twatch`) and answer discovery queries with incremental updates
- broadcast and forward signed, short-lived topic messages
- open WebRTC connections and relay for other peers
- take part in rendezvous (inboxes, `cx_anchors`, the DHT) and peer discovery

**An anchor is a peer with:**
1. an independently reachable public endpoint (UDP and HTTP, verified by a stranger through `cx_check`), and
2. an operational expectation of high availability: anchors SHOULD run continuously and keep downtime short.

That is the only distinction. In practice, others can only *use* the services of peers they can reach, so storage, inboxes and the DHT end up on anchors. That's a consequence of reachability, not a rule.
- A NATed native peer runs exactly the same handlers; peers on its LAN can use them.
- Browsers can't accept inbound HTTP, so they only use those services.

**Rules:**
- **Availability:** this is an operational expectation, not a protocol guarantee. The network MUST tolerate anchor outages and MUST NOT depend on any single anchor.
  - every peer keeps 2 inbox anchors
  - topic records live on 5 storage peers, and searches ask 8
  - Beacons live in the DHT
  - bootstrap uses many independent sources
  - the anchor book scores availability over time, so long-running anchors rank higher and dead ones decay
- **No anchor-only machinery:** no anchor-only topic indexes, storage protocols, subscription registries or broadcast infrastructure. All peers use the same message formats, validation and security rules.
- **No authority:** anchors have no authority over identity, topic membership or provider records. Everything they hold is signed by its owner and verified by whoever reads it.
- **Dynamic:** reachability and connections are dynamic. A node checks its reachability at start and every 30 min, and becomes or stops being an anchor accordingly.

"Storage peer" below means any peer answering the storage queries; publishers pick from the reachable ones that advertise `st: 1` in `cx_hi`.

**Implementation principle: one uniform peer protocol. Public reachability and expected uptime distinguish anchors; nothing else does.**

**Offline peers can't renew leases or answer. An unexpired lease is evidence of a recent publication, never proof that the peer is online now.**

### Out of scope, permanently
- Anything on top of a DataChannel (framing, RPC, files, media)
- Rooms, chat history, durable or acknowledged messaging, replay or late-join delivery, global membership lists, group encryption
- Peer gossip beyond bounded topic broadcast, introductions, reputation, incentives, telemetry, any central topic service
- Our own WebRTC stack (browsers have one; native runtimes use a standard library, §11)
- WebSocket, WebTransport, TURN, UPnP/NAT-PMP, running DNS servers, ICMP, pkarr HTTP endpoints, crypto fallbacks for old browsers (unsupported runtimes get a clear `unsupported` error)
- Using Mainline BEP 5 `get_peers`/`announce_peer` as a topic index (it is only used for the anchor directory)

### Done when
- [x] `npm test` green under Node; `test/runtime-smoke.js` green under Bun and Deno; browser tests green in Chromium (Firefox/WebKit in CI)
- [x] A Beacon round-trips through the public pkarr relay (`node test/live/pkarr.js`)
- [x] Two browsers connect directly and through a third peer; Node ↔ browser works with the default WebRTC library
- [x] Every HTTP-reachable node serves the homepage / plain anchor list
- [x] Topic presence and broadcast implemented and tested as in §§8–9 and §15
- [x] The homepage is a live demo and query tool (`app.js`, logo inlined)
- [ ] Two browsers on two real networks; live Mainline DHT run (need an environment with outbound UDP)
- [x] README + `SPEC.md` describe topics. From then on: bug fixes only.

---

## 2. Built to last

- **Standard foundations:** BitTorrent KRPC (BEP 5, 43, 44), pkarr records, DNS TXT, HTTP/1.1, STUN binding (RFC 5389), mDNS, and the W3C WebRTC and WebCrypto APIs.
- **Our own protocol on top, `cx/1`:** the `cx_*` queries, anchor lines, messages, topic records, broadcasts, the anchor book rules and the connect flow (`SPEC.md`). It only grows: fields and queries never change meaning, new ones get new names, unknown fields are ignored.
- **Core has zero runtime dependencies and no build step.** Plain ESM JavaScript; browsers load the same files Node runs. Native runtimes get one optional default WebRTC library (§11).
- **Standard crypto only:** WebCrypto Ed25519, X25519, HKDF-SHA256, AES-GCM, SHA-1/256.
- **Platforms:** current Chrome, Firefox, Safari; Node ≥ 22, Bun ≥ 1.1, Deno ≥ 2.

---

## 3. Architecture

```
          UDP (KRPC · STUN)                            HTTP POST /krpc
 Mainline ◄───────────────► ANCHOR (a reachable peer) ◄─────────────────────── any client
 DHT nodes                     ▲ ▲                                   (browser, Node, Bun, Deno, curl)
                     UDP KRPC  │ │ LAN: broadcast "CX?" + mDNS
                      ANCHOR ◄─┘ └─► native nodes on the same network

 PEER A ◄═════════════════════ RTCDataChannel (direct) ═════════════════════► PEER B
 PEER A ◄════ RTCDataChannel ════► PEER C (any peer) ◄════ RTCDataChannel ════► PEER B
        └──────────── end-to-end encrypted relayed channel (fallback) ───────────┘

 topic "chess":  provider records ──► 5 closest storage peers ◄── search / watch (one long poll per node)
                 broadcast:  A ──► ≤ 4 topic neighbours ──► each forwards to ≤ 3 more, ≤ 4 hops
```

**Two transports, one message format (bencoded KRPC):**
- **UDP:** node ↔ node, Mainline, STUN, LAN discovery.
- **HTTP `POST /krpc`:** every client ↔ a reachable peer (anchor). Browsers need an HTTPS origin (`web=`, e.g. a Cloudflare tunnel, which carries HTTP only). Natives may use `http://ip:port`.

Topic broadcasts travel only over WebRTC DataChannels between peers.

---

## 4. Identity, records and messages

```
Seed       32 random bytes (the only secret to back up)
Identity   Ed25519 key  = from HKDF(seed, "cx/ed25519")    → address = z32(ed_pk), 52 chars
Encryption X25519 key   = from HKDF(seed, "cx/x25519")     → published in the Beacon, signed by the identity key
Anchor     corvax-anchor:<z32>@<ip>:<port>[;web=<https origin>][;q=<0-100>]                 ≤ 255 chars
Beacon     pkarr signed packet (BEP 44 mutable item at SHA1(ed_pk)), ≤ 1000 B, TXT "_cx":
           x=<b64 x25519_pk>   c=<anchor line of an inbox> (1..n)   [app-defined k=v]
Message    eph_x 32 | iv 12 | AES-GCM_K( inner ‖ sig ) | tag 16                        ≤ 4 KB
           K     = HKDF-SHA256( X25519(eph_sk, recipient_x), "cx/msg" ‖ eph_x ‖ recipient_x )
           inner = bencode{ from, to, id: 16 B, ts, body: UTF-8 JSON };  sig = Ed25519(inner)
Relay      frame = sid 9 | counter 8 | AES-GCM_Kdir(type 1 | data);  Kdir = HKDF(X25519(eph_a, eph_b), "cx/relay" ‖ sid ‖ dir)
Topic      §8.1       Provider record  §8.2       Broadcast  §9.2
```
Messages are accepted only if they decrypt, the signature verifies, `to` is the recipient, `|now − ts| < 10 min`, and `id` is new. The signature covers `to`, which stops reflection and redirection.

---

## 5. Protocol `cx/1` (KRPC queries)

| Query | Source | Request → Reply |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get_peers`, `announce_peer` | BEP 5 | **anchor directory only**: infohash `SHA1("corvax anchors v1")`. Results are verified like any other anchor line |
| `get`, `put` | BEP 44 | resolve / publish a Beacon. Recursive over HTTP |
| `cx_hi {n}` | ours | → `{k, sig = Ed25519("cx-hi" ‖ n), line?, st?}`; `st: 1` = this node is a storage peer |
| `cx_anchors {me?}` | ours | → `{a}`: own line + best 32 + 8 random anchor lines |
| `cx_check {k, port, hport}` | ours | asks a *different* anchor (`cx_probe`) whether strangers reach the caller → `{udp, http, ip, by}` |
| `cx_probe {ip, port, hport, k}` | ours | anchor ↔ anchor only |
| `cx_send {to, msg}` | ours | → `{queued}` (inbox, 2 min, ≤ 64 per address, deduplicated) |
| `cx_listen {k, ts, sig, after?}` | ours, HTTP | inbox long poll, ≤ 25 s, acked by `after` |
| `cx_tpub {r: [record]}` | ours | **topics** (§8.4): store ≤ 32 provider records → `{ok: [status], now}` |
| `cx_tfind {t: [topic id]}` | ours | **topics**: ≤ 16 topic ids → `{r: [record], now}` |
| `cx_twatch {t: [topic id], c?}` | ours, HTTP | **topics**: one long poll for ≤ 64 topics → `{c, snap?, r: [record], now}` |

**HTTP:** `POST /krpc`, `Content-Type: text/plain` (no CORS preflight), body ≤ 8 KB. Every reply is KRPC, including errors. A repeated `t` from the same IP within 60 s gets the cached reply, so retries are idempotent.

**HTTP endpoints:** `GET /` (homepage for browsers, plain anchor lines for everything else, `Vary: Accept`) · `POST /krpc` · `GET /cx/*.js` (the library and `app.js`) · `GET /favicon.ico`. CORS `*`.

### The homepage (`GET /`)
- **Browsers get a shell (< 1 KB):**
  - `<script type="module" src="/cx/app.js">`, then `<pre id="anchors">` with the anchor lines verbatim (readable and greppable without JavaScript)
  - the node's line, services, uptime and origin as `data-*` attributes on `<body>`
  - every value HTML-escaped
- **`app.js` (≈ 13 KB, same-origin, no external requests):**
  - renders the human page: the logo **inlined** as a data URI (so there's no `/logo` endpoint), what the node is, this node, how to use it, and the known anchors
  - a **"Go live"** button loads the library only on click, creates a peer in the tab (exposed as `window.corvax` for devtools) and turns the page into a demo and query tool:
    - **Messages:** send and receive
    - **Connect:** a DataChannel chat, direct or relayed
    - **Topics:** search, publish/unpublish, subscribe (presence + broadcasts), broadcast
  - dark and light mode, readable on a phone
  - **client-side storage (`localStorage`)** keeps the live node working across reloads:
    - `corvax.seed`: the identity, so the address stays the same
    - `corvax.anchors`: the anchor book, kept by the library, so the next start needs no bootstrap round
    - `corvax.app`: `{ live, topics: { name: { sub, pub } } }`; a tab that was live goes live again on load and re-subscribes and re-publishes its topics
    - **Forget** clears all `corvax.*` keys
    - without storage (private mode, blocked) everything still works, just without memory
- **Plain `curl`** gets no HTML at all; `curl -H 'Accept: text/html'` gets the thin shell.
- **Everything else** (`curl`, `wget`, scripts, `fetch()`) gets `text/plain`: own line first, then the shared view, one anchor line per line. There's no `/anchors.txt`.

---

## 6. The anchor book

**Line:** `corvax-anchor:<z32>@203.0.113.7:4799;web=https://a.example.org;q=93`. Readers grep any text for `corvax-anchor:[^\s"'<>`]+` and strip trailing punctuation.

- **Per entry:** `verified` (`cx_hi` passed), `storage` (`cx_hi` said `st: 1`), and per-service EWMA scores `http`, `udp` (α = 0.2), plus `rtt`, `first`, `lastOk`.
- **Score:** unverified → `min(hint, 50)`. Verified → `round(100 · ok · (0.6 + 0.4 · √min(1, days_known/7)))`, where `ok` = `http` for browsers and `max(udp, http)` for natives.
- **Kept tidy:** ≤ 1000 entries; dropped when score < 10 and no success for 7 days, or immediately when `cx_hi` shows a different key.
- **Shared view:** best 32 + 8 random (new anchors spread before they have a score).
- **Anchors every 10 min:** probe ≤ 64 entries (≤ 16 unverified), pull `cx_anchors` from 3 random anchors, `announce_peer` on the anchor topic.

**Bootstrap sources** (in parallel; the first verified anchor wins):
- local cache (`localStorage` / `~/.config/corvax/anchors.txt`)
- the built-in list `src/anchors.js`
- any text: invite links, files, URLs, any anchor's homepage (`sources`)
- `cx_anchors` on known anchors
- DNS TXT `_corvax-anchors.<domain>` (browsers via public DoH JSON)
- natives only: Mainline `get_peers` on the anchor topic; LAN `CX?` on UDP 4798 and mDNS `_corvax._udp.local`

**Reachability check:** native peers call `cx_check` at start and every 30 min. When UDP and HTTP are reachable from a stranger, the peer is an anchor: its line is published in anchor books, it serves the DHT (not read-only), and it does `announce_peer`. Every native peer serves the same queries (storage unless `--no-storage`) regardless; `--no-anchor` opts out of being listed.

---

## 7. `connect(address, { relay })`

Plain standard offer/answer, no SDP templates or editing. Every connection has two pre-negotiated DataChannels: id 0 (the payload channel) and id 1 `cx` (control).

**Direct:**
1. **Resolve:** look up B's Beacon (newest valid seq) to get B's X25519 key and inbox anchors.
2. **ICE:** use STUN on our own anchors.
3. **Offer:** A sends `{cx:'offer', sid, sdp, p}`, where `p` is `'app' | 'relay' | 'topic'`; topic offers also carry `tp` (§9.1).
4. **Answer:** B replies `{cx:'answer', sid, sdp}`, or `{cx:'busy', sid}` when it declines a `relay`/`topic` offer.
5. **Trickle:** both send `{cx:'cand', sid, c, m, i}`; candidates that arrive early are queued.
6. **Open:** both DataChannels open.

**Through a third peer** (default when direct fails, `relay: 'fallback'`):
1. A sends `{cx:'via?', sid, e, via, p, tp?}`.
2. B picks C (a peer it is already connected to, otherwise the first one it can reach directly) and replies `{cx:'via', sid, e, c}` or `{cx:'via-no'}`.
3. A and B each ask C to bridge on the control channel; C pairs the two requests and forwards end-to-end encrypted frames. C sees only ciphertext.

`connect()` returns `{ channel, kind: 'direct' | 'peer', via? }`.
Errors: `not-found | no-answer | ice-failed | busy | no-relay | timeout | no-webrtc | unsupported`.

---

## 8. Topic presence

### 8.1 Topic names and ids
```
normalize(name) = NFKC → trim → collapse whitespace to " " → lowercase;  1–200 bytes UTF-8 after normalization
topic id        = SHA-256("cx/topic:" ‖ normalize(name))                     32 bytes
```
Topics belong to nobody. Storage peers see only ids, never names. Ids are not secret: anyone who guesses a name can compute its id.

### 8.2 Provider record
```
fields  = bencode { t: topic id 32, k: provider ed_pk 32, seq: int, exp: int (ms since epoch) }
record  = bencode { t, k, seq, exp, sig }      sig = Ed25519("cx-topic" ‖ fields)        ~170 bytes
```
- **`seq`:** monotonic per (topic, provider) = `max(previous + 1, now_ms)`.
- **`exp`:** absolute expiry, `now + skew + LEASE`, with `LEASE` = 10 min.
- **Tombstone (unpublish):** a record with a higher `seq` and `exp ≤ now`.

### 8.3 Storage rules (`TopicStore`, any peer)
On every `cx_tpub` record, in order:

| Check | Result |
|---|---|
| bad encoding, wrong sizes or bad signature | `bad` |
| `exp > now + LEASE + SKEW` (SKEW = 60 s) | `future` (publisher clock ahead) |
| `exp < now − SKEW` and not newer than what is stored | `expired` |
| stored `seq` > record `seq` | `stale` |
| stored `seq` = record `seq` | `dup` (no change, no event) |
| new (topic, provider) beyond limits (≤ 64 topics per provider, ≤ 50 000 records) | `full` |
| otherwise | `ok`: store and append an event |

- **Storage:** in memory, `topic id → provider → { record, seq, exp }`.
- **Live** means `exp > now`.
- **Tombstones** are kept until `now + LEASE + SKEW`, so an older signed record can't be replayed to revive a provider after it unpublished.
- **Sweep:** every 30 s, delete records past `exp + SKEW` (and tombstones past their retention), and trim the event log.

**Event log:** each accepted record appends `{n, t, record}`. `n` increases by 1 per event; the store has a random `epoch` set at start. The cursor is `epoch:n`. The log keeps ≤ 10 000 events and ≤ 30 minutes.

**`cx_tfind {t}`:** for each id, up to 100 live records, newest first.

**`cx_twatch {t, c}`:**
- **Snapshot:** when `c` is missing, of another epoch, older than the log or newer than the head, the reply is `{snap: 1, r: live records for t, c: head}` (snapshot resync).
- **Delta, events waiting:** when events for `t` exist after `c`, the reply is `{r: newest record per (topic, provider) among them, c: head}`.
- **Delta, nothing yet:** the poll waits up to 25 s for a matching event. After the first one, it waits **2 s more to coalesce**, then replies. On timeout: `{r: [], c: head}`.
- A newer poll does not end older ones: different clients share a node.

`now` (the node's clock) is in every topic reply.

### 8.4 Provider side (publish, renew, unpublish)
- **Storage choice:** the 5 verified, reachable storage peers (`st: 1`) in our own book whose key is XOR-closest to the topic id ("closest suitable"). If one fails, the next closest is tried, up to 8 in total.
- **Publish:** sign a record and send it to those nodes. It succeeds if at least one accepts, and reports how many did.
- **Renew:** **one timer** for all published topics, every 5 min ± 20 % jitter. Records are **batched per storage peer** (≤ 32 per `cx_tpub`), and every renewal recomputes the closest set, so a failed node is replaced automatically.
- **Clock skew:** the peer keeps `skew` = median of (storage `now` − local time at reply) over the last 8 topic replies. `exp` uses `now + skew`. A `future` or `expired` status triggers one immediate retry with the updated skew.
- **Unpublish:** send a tombstone to the same nodes and stop renewing.

### 8.5 Searcher side (search, watch)
- **Search:** `cx_tfind` on the 8 closest storage peers. The searcher verifies every record itself (storage is untrusted), keeps the highest `seq` per provider, and drops records that aren't live. Each result: `{ address, presence: 'recent', expires, seq }`.
- **Watch:** for all watched topics, compute each topic's 5 closest storage peers, group the topics by node, and run **one multiplexed long poll per storage peer** (`cx_twatch` with all of that node's topics, ≤ 64). A change to the watched set restarts the polls with a snapshot.
  - Records from any node are verified, then merged by `seq`.
  - **Presence:** `recent` while `exp > now + skew`, otherwise `expired`. A local check every 5 s turns leases that ran out into `expired`.
  - **Events** are emitted only on transitions: new provider `recent`, renewed-after-expiry `recent`, tombstone or lapsed `expired`.
- **Failure handling:**
  - a poll error means exponential backoff (1 s → 30 s)
  - after 3 consecutive failures the node is marked down in the book (`http` score) and the assignment is recomputed
  - an invalid or expired cursor gets a snapshot from the node, and the client simply merges it

There are no per-topic polls, per-peer heartbeats or presence pings.

---

## 9. Topic broadcast (best-effort)

### 9.1 Topic neighbours
- **Link:** one dedicated connection per (peer, topic), opened with `connect(..., p: 'topic', tp: topic id hex)`. It is direct when possible, otherwise relayed through a third peer like any connection. The link's payload channel carries only broadcast frames.
- **Limits:** **≤ 4 neighbours per topic, ≤ 16 links per peer.**
- **Accept rule:** a peer accepts a topic offer only if it is subscribed to that topic and below both limits; otherwise it answers `busy`. Accepted offers reserve a slot for 40 s while connecting.
- **Choosing neighbours:** while subscribed, a peer tops up to 4 neighbours from the topic's `recent` providers. It does this at most twice per maintenance run, after presence changes (1 s debounce) and on each renewal tick. It skips itself, existing links, and addresses that failed in the last 2 minutes.

### 9.2 Broadcast frame (binary, on the topic link)
```
signed = bencode { t: topic id, id: 16 random bytes, ts: ms, from: ed_pk, body: ≤ 1024 bytes (UTF-8 JSON) }
frame  = bencode { t, id, ts, from, body, p: sender's provider record for t, hop: 1..4, sig }     ≤ 4 KB
sig    = Ed25519("cx-tb" ‖ signed)          (hop is not signed: forwarders decrement it)
```

### 9.3 Rules
- **Who may send:** only a peer whose own provider record for the topic is live. `broadcast()` throws `not-published` otherwise.
- **Origin:** sends to all of its links for the topic (≤ 4) with `hop = 4`. Its own messages are never delivered back to it.
- **Each receiver, in order:**

  | Drop if | Rule |
  |---|---|
  | `t` ≠ the link's topic | wrong topic |
  | already seen `id` | duplicate cache, kept 10 min |
  | `now − ts > 2 min` or `ts − now > 60 s` | max age |
  | `body` > 1024 bytes or frame > 4 KB | size |
  | bad `sig` | sender |
  | `p` isn't a valid record for this `t` and `from`, live within SKEW | eligibility |
  | more than 10 messages from this `from` for this topic in 60 s | rate (the message still counts as seen) |

  Otherwise: deliver it to the subscribers, and if `hop > 1`, forward a copy with `hop − 1` to **at most 3** other links for the topic, chosen at random. The copy never goes back on the incoming link or to `from`.

**What broadcast is not:** no history, replay, storage, acknowledgements, retries, ordering, late-join delivery or group encryption. Peers that aren't connected to the mesh at that moment miss the message. It suits short notices ("I'm here", "new move"), **not chat**.

---

## 10. Limits (defaults, configurable per node/peer)

| Area | Limit |
|---|---|
| Records | Beacon ≤ 1000 B; message ≤ 4 KB; provider record ~170 B; broadcast body ≤ 1024 B |
| HTTP per IP | token bucket, burst 120, 4/s; costs `put` 6, `cx_check` 12, `cx_tpub` 2, `cx_send` 1, `get`/`get_peers`/`cx_tfind` 1, others 0.5; ≤ 64 open long polls; body ≤ 8 KB |
| DHT | tokens = SHA1(secret ‖ window ‖ ip), 10-minute windows; routing table ≤ 1000 |
| Topics | lease 10 min; renew 5 min ± 20 %; ≤ 32 records per `cx_tpub`, ≤ 16 ids per `cx_tfind`, ≤ 64 per `cx_twatch`; long poll 25 s; coalesce 2 s; ≤ 64 topics per provider and ≤ 50 000 records per storage peer; ≤ 100 providers per topic per reply; event log ≤ 10 000 / 30 min |
| Broadcast | ≤ 4 neighbours per topic, ≤ 16 links per peer, forward to ≤ 3, hop limit 4, age ≤ 2 min, 10 per sender per topic per minute, duplicate cache 10 min (≤ 10 000 ids) |
| Relaying | browsers ≤ 2 sessions at 256 kbit/s, natives ≤ 16 at 2 Mbit/s; ≤ 1 GB per hour; idle 2 min |

---

## 11. WebRTC outside browsers

```js
RTCPeerConnection = options.RTCPeerConnection ?? globalThis.RTCPeerConnection ?? (await import('werift')).RTCPeerConnection ?? null
```
- **Default:** `werift` (pure JS, MIT), installed as an optional dependency.
- **Tested alternative:** `node-datachannel/polyfill`.
- **Without any library:** everything except `connect()`, relaying and broadcast works.
- **The contract** (any implementation that satisfies it works):
  - `new RTCPeerConnection({ iceServers })`
  - `createDataChannel(label, { negotiated: true, id })`
  - `createOffer`, `createAnswer`, `setLocalDescription`, `setRemoteDescription`, `addIceCandidate`, `close`
  - `localDescription`, `remoteDescription`, `onicecandidate`
  - channels: `send`, `close`, `readyState`, `binaryType`, `onopen`, `onmessage`, `onclose`

---

## 12. API (all of it)

```js
import { Peer } from 'corvax'                     // browsers: https://<anchor>/cx/index.js · Deno: npm:corvax

const me = await Peer.create({ seed, anchors, sources, dohDomains, RTCPeerConnection, relay: 'fallback', relayFor: true })
me.address
await me.publish()                                // Beacon (needed to be reachable by key)
me.accept(({ from, channel, kind }) => {})
const { channel, kind } = await me.connect(address)
await me.resolve(address);  await me.send(address, body);  me.on(fn)
me.anchors();  me.addAnchors(text)

// topics
const chess = await me.topic('Chess')             // handle; normalizes the name, no network I/O
await chess.publish()                             // → { stored: n }  lease renewed automatically until unpublish/close
await chess.unpublish()
await chess.search()                              // → [{ address, presence: 'recent', expires, seq }]
const stop = chess.subscribe({                    // watch presence + join the broadcast mesh
  presence: ({ address, presence, expires }) => {},   // presence: 'recent' | 'expired'
  message: ({ from, body, topic }) => {}
})
await chess.broadcast(body)                       // JSON, ≤ 1024 bytes encoded; requires publish()
stop()                                            // unsubscribe this listener
chess.close()                                     // unpublish, stop watching, close topic links, clear timers
me.close()                                        // closes all topics too
```
CLI: `corvax node | anchor | anchors | id | resolve <addr>`; `--no-relay`, `--no-storage`.

Publishing or subscribing to a topic also publishes the peer's Beacon if it hasn't been yet: other members must be able to resolve you to connect.

---

## 13. Files

| File | Job |
|---|---|
| `src/bytes.js`, `bencode.js`, `crypto.js` | encodings, hardened bencode, WebCrypto |
| `src/record.js`, `message.js` | Beacon (pkarr), sealed messages |
| `src/topic.js` | **new:** normalization, topic ids, provider records, broadcast frames (encode/sign/verify) |
| `src/store.js` | **new:** `TopicStore`: validation, leases, tombstones, event log, cursors, coalesced watch |
| `src/topics.js` | **new:** peer side: handles, publish/renew/unpublish, search, multiplexed watch, neighbours, broadcast |
| `src/dht.js`, `book.js` | DHT; anchor book (+ `storage` flag) |
| `src/peer.js`, `rtc.js`, `relay.js` | Peer API; connections (+ `topic` purpose, `busy`); relaying |
| `src/anchor.js`, `node.js`, `stun.js`, `lan.js`, `home.js` | anchor services (+ `cx_tpub`/`cx_tfind`/`cx_twatch`); native wiring; STUN; LAN; homepage |
| `src/app.js` | the homepage app: page, inlined logo, live demo and query tool |
| `bin/corvax.js`, `src/anchors.js`, `assets/logo/` | CLI, built-in anchors, logo sources (favicon served from here) |

---

## 14. Implementation order (topics)

1. `topic.js`: normalization, ids, records, frames, with signature checks → unit tests
2. `store.js` + `cx_tpub`/`cx_tfind`/`cx_twatch` handlers + `st` in `cx_hi` + book `storage` flag → store tests
3. `topics.js` publish/renew (batched, jitter, skew, fallback nodes)/unpublish/search → integration tests against 6 storage peers
4. Multiplexed watch, coalescing, snapshot resync, local expiry → watch tests
5. `p: 'topic'` connections (`busy`, reservations), neighbour selection, broadcast send/verify/forward/rate/dedup → mesh and adversarial tests
6. API integration and `close()` cleanup → resource tests; browser test
7. `SPEC.md`, README, demo, plan status

---

## 15. Tests

| Test | Proves |
|---|---|
| `core` | encodings; keys from seed; Beacon and message tamper/reflection/redirection/replay; anchor-line grep; scores |
| `dht` | 20 nodes: BEP 44 put/get, stale seq, bad signature, announce_peer/get_peers |
| `anchor` | 3 anchors promote; publish/resolve/message; idempotent retries; acks; long-poll replacement; rate limit; homepage HTML vs plain text; logo |
| `lan` | broadcast and mDNS discovery |
| `native` | Node ↔ Node with werift and node-datachannel |
| `relay` | relaying through an anchor; ciphertext only; forged bridge; limits; `relay: 'never'` |
| `browser` | Chromium: direct, through a third browser, Node ↔ browser; **browser publishes a topic, a Node peer finds it and broadcasts to it** |
| `app` | the homepage as a person uses it: inlined logo, anchors, Go live in two tabs, topic publish/search/subscribe, presence, broadcast between tabs, a message; no page errors |
| `topic` (unit) | normalization; id stability; record and frame tamper; wrong-topic record; oversize |
| `store` (unit, fake clock) | ok/dup/stale/bad/expired/future; tombstone blocks replay; expiry and sweep; limits; find returns only live; watch: snapshot without cursor, delta with cursor, coalescing window, epoch change and trimmed log → snapshot, timeout, abort |
| `topics` (integration, 6 storage peers, Node peers) | replication to exactly the 5 closest; search finds providers; renewal keeps a provider recent past one lease; offline provider expires; unpublish → `expired` event; storage peer killed → search still works and renewal re-replicates; clock skew corrected; cursor loss → snapshot; one long poll per node for many topics; `close()` leaves no timers or polls |
| `broadcast` (unit with fake links + integration mesh) | delivery across a 5-peer mesh, exactly once per peer; loops suppressed; hop limit; forward fan-out ≤ 3; rate limit; oversize; old, future-dated and replayed frames; forged signature; sender without a live record; record for another topic |
| `live` (manual) | pkarr relay; public DoH |

---

## 16. Decisions (and why)

| Decision | Why |
|---|---|
| Separate X25519 key; sealed-sender signed messages | Standard WebCrypto only; sender attribution, no reflection |
| Full SDP offer/answer | Robust across browsers and native libraries |
| Relay through any peer by default; no TURN | Connections succeed whenever any path exists; no relay servers |
| HTTP POST + long polls, no WebSocket | One client transport for every runtime |
| **Topics use CORVAX provider records on storage peers, not BEP 5** | BEP 5 announces IP:port without identity, signatures or expiry control, and spams the public DHT with private data. Our records are signed, leased and revocable |
| **Publisher-driven replication to the 5 XOR-closest storage peers** | No storage-to-storage protocol. Books differ slightly between peers, so searchers query 8 to absorb that |
| **Absolute `exp` + tombstones + skew estimate** | A replayed old record can't revive a provider. Clock offsets are corrected from storage `now` instead of being trusted |
| **Presence is only `recent` / `expired`** | A lease proves a recent publication, not that the peer is online |
| **Eligibility = the sender's own live provider record inside the frame** | Receivers verify membership without any lookup or central list |
| **One link per (peer, topic)** | Keeps the accept rule and the limits trivial; at most 16 links |
| **Broadcast is best-effort only** | Durable or ordered delivery would need storage and history, which are out of scope |
| v1 stays v1 | No version bump; `cx/1` grows by adding queries and fields |

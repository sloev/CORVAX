# Rendezvous: the plan (final scope)

> **Peers find each other by key and end up with an open WebRTC DataChannel.
> Every node carries a scored list of anchors and hands it out over any channel that can carry text.**

## 1. Scope

Rendezvous does exactly five things:

1. **Identity:** a key pair whose public key is a permanent address.
2. **Anchor book:** every node keeps a cached, scored list of publicly reachable anchors and serves it over every channel it can (§4). Anchors are the bootstrap nodes, and we want as many as possible.
3. **Discovery:** publish a signed record under your address; anyone, on any runtime, can resolve it.
4. **Signalling:** deliver small encrypted messages between addresses.
5. **Connection:** open an `RTCDataChannel` between two peers, **direct when possible, otherwise relayed by another peer**.

The protocol ends when `connect()` returns an open DataChannel.

### Non-goals (permanently)
- Anything on top of the DataChannel (framing, RPC, files, media)
- Gossip about *peers*, social introductions, topics/rooms (only *anchors* are gossiped)
- Reputation beyond the local anchor score, incentives, tokens
- A general WebRTC stack. We implement only the DataChannel subset that `connect()` needs (§6). No media, no SDP parser, no renegotiation
- Ports to other languages (the spec is small and text-based, so others can write them)

### Finished when
- [ ] All tests in §9 pass
- [ ] A Beacon published by our code reads back from the public pkarr relay
- [ ] Two browsers on different networks connect knowing only each other's address, both direct and forced through a peer relay
- [ ] A Node peer and a browser connect the same way, and so do two Node peers (our WebRTC subset)
- [ ] The `matrix` CI is green on Chrome, Firefox and Safari (stable + pre-release), and `fallbacks` passes
- [ ] A fresh node with **no configuration** finds anchors through at least one channel in each row of §4.3
- [ ] README + `SPEC.md` are written. After that the project only receives bug fixes.

---

## 2. Design (each decision made once)

| | Decision |
|---|---|
| **Code** | One zero-dependency ESM JavaScript codebase. Browsers, Node 22+, Bun, Deno. No build step. |
| **Crypto** | WebCrypto (Ed25519, X25519, HKDF, AES-GCM, SHA-1). The anchor also uses `node:crypto` for TURN's HMAC-SHA1/MD5. |
| **Address** | Ed25519 public key, z-base32, 52 chars (same as pkarr and iroh) |
| **Discovery protocol** | BitTorrent Mainline KRPC (BEP 5 + BEP 44) on every transport, plus 5 extra queries |
| **Record** | pkarr signed packet (≤ 1000 B) = BEP 44 mutable item at `SHA1(pk)` |
| **Anchor** | Any native node with a public UDP port: DHT node + STUN/TURN + anchor-book server on one port. With a reachable TCP port too, it also serves HTTP/WebSocket for browsers. **Native nodes promote themselves automatically** when a reachability check passes (§4.5). |
| **Connection** | Standard WebRTC, zero SDP on the wire (ICE credentials derived from the shared key). Browsers use their built-in `RTCPeerConnection`. **Node/Bun/Deno use our own DataChannel-only WebRTC subset (§6), written in plain JS on WebCrypto**, so every runtime can connect with zero dependencies |
| **Relaying** | Plain TURN, run by anchors. ICE picks direct first and relay last. |

---

## 3. Protocol

### 3.1 KRPC queries
KRPC is the same bencoded message on every transport. Clients set `ro: 1` (BEP 43).

| Transport | Framing | Used by |
|---|---|---|
| **UDP** | one datagram = one message | native ↔ anchor ↔ Mainline |
| **WebRTC DataChannel** (`webrtc-direct` to an anchor's `IP:port`) | one message = one message | browsers and natives, **no domain or TLS needed** |
| **HTTP(S) `POST /krpc`** | body = one query, response = one reply. `rv_listen` turns into a long poll: the reply waits up to 25 s and carries the queued `rv_msg`s | browsers, `curl`, IoT, anything with HTTP |
| **WebSocket** | one frame = one message | browsers (lower latency than long polling) |

| Query | Source | Meaning |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get_peers`, `announce_peer` | BEP 5 | anchors announce on the infohash `SHA1("rendezvous anchors v1")`, so **the 10M-node Mainline DHT becomes an anchor directory** |
| `get`, `put` | BEP 44 | resolve / publish a Beacon |
| `rv_hi {n}` | ours | → `{k, sig = Ed25519(n), fp, web?}`: proves the anchor's identity and gives its certificate hash and HTTPS origin |
| `rv_anchors {}` | ours | → `{a: "<anchor lines>"}`: the best 32 plus 8 random entries from the responder's book |
| `rv_check {ip, port}` | ours | "please ask a *different* anchor to `rv_hi` this address and tell me the result" (reachability check, §4.5) |
| `rv_listen {k, ts, sig}` | ours | deliver my messages to this connection (`sig` = Ed25519(`"rv-listen:" ‖ ts`), ±5 min) |
| `rv_send {to, msg}` | ours | → `{delivered}`. Delivered to listeners, otherwise held for 2 min (≤ 64 per address) |
| `rv_turn {}` | ours | (after `rv_listen`) → TURN credentials for this anchor |
| `rv_msg {msg}` | ours, anchor → client | delivered message |

### 3.2 Formats
```
Address    z32(ed25519_pk)                                                     52 chars
Anchor     rv-anchor:<z32>@<ip>:<port>[;fp=<b64 cert sha-256>][;web=<https origin>][;q=<0-100>]   ≤ 255 chars
Beacon     pkarr: sig 64 | seq 8 | DNS packet, TXT "_rv" = "c=<anchor ws url>" ≤ 1000 B
Message    from_pk 32 | iv 12 | AES-GCM_K( ts 8 | bencode(body) ) | tag 16     ≤ 1024 B
K          HKDF-SHA256( X25519(ed→x(sk), ed→x(pk_peer)), salt = sorted(pk_a ‖ pk_b) )
ICE        HKDF(K, "rv/ice/<sid>/<role>") → ufrag hex 4 B, pwd hex 16 B
TURN       user = "<expiry>:<z32>", pass = base64(HMAC-SHA1(anchor_secret, user))
```

---

## 4. The anchor book

### 4.1 One format: an anchor line
```
rv-anchor:8pzq4…k3a@203.0.113.7:4799;fp=Xk3…;web=https://a.example.org;q=93
```
- **Greppable:** readers scan *any* text for `rv-anchor:[^\s"'<]+`. A list can be embedded in a web page, a README, a tweet, a gist, a Nostr note, a DNS TXT record, a QR code or a printed flyer, and **every one of them is a channel with zero code**.
- **Self-verifying:** a line is only a *claim*. Before a node relies on an anchor or passes it on as verified, it sends `rv_hi` with a random nonce, and the anchor must sign it with the key in the line. A fake line costs the reader one ping.
- `q` is the *sender's* score and only a hint. Receivers start unverified lines at `min(q, 50)`.

### 4.2 Quality score (local, every node)
```
per anchor:  ok = EWMA(probe success, α = 0.2)    rtt = EWMA(ms)    first_seen, last_ok
score q    = round(100 · ok · min(1, days_known / 7)^½)      ties → lower rtt
```
- Anchors re-probe their book every 10 min (≤ 64 per round, oldest first). Clients probe whenever they use an anchor.
- Book size ≤ 1000. Entries with `q < 10` and no success for 7 days are dropped.
- **Shared view = best 32 + 8 random.** The random part lets new anchors spread even before they have a score.

### 4.3 Channels: where a node *gets* the list and where it *serves* it

| Channel | Served by | Read by | Notes |
|---|---|---|---|
| **Local cache** | n/a | everyone | IndexedDB / `~/.config/rv/anchors.txt`. After the first run, nothing else is needed |
| **Baked-in list** | the npm package / repo `anchors.txt` | everyone | updated on every release |
| **Invite link** | `…#rv=<addr>&a=<1–3 anchor lines>` | everyone | the person inviting you bootstraps you |
| **HTTP** | every anchor: `GET /anchors.txt`, `/.well-known/rv-anchors.txt`; also `POST /krpc` with `rv_anchors` | everyone (browsers: `https` origins, or any origin when the page is `http`) | also from any static host: GitHub raw, gists, IPFS gateways, Pages |
| **Any text URL** | anyone | everyone | `sources: ['https://…']`. Any page containing anchor lines works |
| **DNS TXT** | the domain owner (one TXT string per line) or an anchor run with `--dns` (answers TXT on UDP 53) | native: plain DNS; **browsers: public DoH JSON** (`cloudflare-dns.com`, `dns.google`) | `dig TXT _rv-anchors.example.org` |
| **DoH** | every anchor: `GET /dns-query` (RFC 8484) | everyone | same responder as `--dns` |
| **KRPC `rv_anchors`** | every anchor (UDP + WS) | everyone | the main way anchors gossip with each other |
| **Mainline `get_peers`** | anchors `announce_peer` on the anchor infohash | native | **global, self-registering, no list maintainer** |
| **UDP broadcast / multicast** | **every native node** (anchor or not), port 4799 | native | request `RV?` to `255.255.255.255`, `239.255.42.99`, `ff02::1` → reply with anchor lines (≤ 1200 B) |
| **mDNS / DNS-SD** | every native node | native | `_rv._udp.local` PTR + TXT (one anchor line per TXT string) |
| **Copy / paste / QR / file** | `rv anchors` prints the book | everyone | sneakernet works too |
| **ICMP echo** | spec only | n/a | requires raw sockets, which JavaScript runtimes don't have. Defined in `SPEC.md` for native ports (request payload `RV?`, the echo reply carries anchor lines) |

### 4.3b What a browser can reach (and how we use all of it)
Browsers have plenty of ways out. The one hard rule is **mixed-content blocking**: a page loaded over `https://` may not make `http://` or `ws://` requests to other hosts. Everything below respects it.

| Browser method | Reaches | Works from an HTTPS page? | Used for |
|---|---|---|---|
| **WebRTC** (`webrtc-direct`, zero SDP) | any anchor `IP:port` over UDP | ✅ (not subject to mixed content) | KRPC to **every** anchor, no domain needed |
| **fetch GET/POST** to `https://…` | anchors with `web=`, any static host, pkarr relays, gists, IPFS gateways | ✅ needs a valid cert and CORS (we send `Access-Control-Allow-Origin: *`; GitHub raw, IPFS gateways and DoH resolvers do too) | `/anchors.txt`, `POST /krpc`, Beacons via pkarr relays |
| **DNS over HTTPS** (`cloudflare-dns.com`, `dns.google` JSON API) | any domain's TXT records | ✅ | anchor lines published as DNS TXT, with no server of ours involved |
| **WebSocket** `wss://` | anchors with `web=` | ✅ | low-latency KRPC |
| **fetch / WebSocket to `http://` or `ws://`** | any anchor `IP:port` over TCP | ⚠️ only when the page itself is served over `http://` (e.g. an anchor serving the app) or from `localhost` | KRPC, `/anchors.txt` |
| **WebTransport** with `serverCertificateHashes` | anchor `IP:port` over QUIC, no domain | ✅ in Chromium and Firefox | **not used:** it would need a QUIC/HTTP3 stack, and WebRTC already covers this case |
| **Pasted text / QR / invite links / `localStorage` / IndexedDB** | n/a | ✅ | offline bootstrap and the cache |

So **a browser on any HTTPS site can use every anchor** (via WebRTC) and also gets the list from every HTTPS source on the web. Anchors with a domain (or a free `cloudflared` tunnel) add plain HTTPS and `wss://` on top, for networks that block UDP.

Bootstrap order (all started in parallel, first verified anchor wins): cache → baked-in → invite → LAN (broadcast/mDNS) → configured sources/DoH → Mainline `get_peers`. Then `rv_anchors` on every anchor reached fills the book.

### 4.4 How the list spreads
- Every 10 min each anchor pulls `rv_anchors` from 3 random anchors in its book and merges the result (verifying new entries with `rv_hi` first).
- Every client pulls `rv_anchors` from each anchor it connects to.
- New anchors `announce_peer` on Mainline and send `rv_hi` to the anchors they know; those probe back and add them.
- `rv anchors --watch > anchors.txt` keeps a file up to date for publishing anywhere (git, static site, DNS zone).

### 4.5 More anchors: automatic promotion
Every native node, on start:
1. **Maps a port:** NAT-PMP/PCP (UDP, ~40 lines) and UPnP-IGD (SSDP + one SOAP call, ~60 lines) for UDP/TCP 4799.
2. **Checks reachability:** `rv_check` to anchor X; X asks anchor Y (a different IP) to `rv_hi` us. This passes only if strangers can reach us, not just through a NAT hole we opened ourselves.
3. If it passes → it's an anchor: DHT server mode, STUN/TURN on, `announce_peer`, served in books. Checked again every 30 min. `--no-anchor` opts out.

Browsers can't be anchors, but they cache, score and **re-share** the book (invite links, `rv_anchors` answers over their WebSocket, export).

---

## 5. `connect(address)`
```
1 RESOLVE   Beacon of B → B's anchors          2 RELAYS  rv_turn on own anchors → iceServers (STUN+TURN)
3 OFFER     msg {t:'rtc', sid, fp_A}            4 ANSWER  msg {t:'rtc-ok', sid, fp_B}   (SDP built from the template on both sides)
5 ICE       trickle msg {t:'rtc-c', sid, c}     6 OPEN    → { channel, pc, kind }
Errors: 'not-found' | 'no-answer' | 'ice-failed' | 'timeout'
```
Authentication is implicit: only the key holder can decrypt the `rtc` message and derive the ICE password, and the DTLS fingerprints arrive inside authenticated messages.

---

## 6. Our WebRTC subset (for Node, Bun and Deno)

A port of **just the DataChannel path**, written from the RFCs, using **str0m** (Rust, sans-IO, MIT/Apache-2.0) for structure and **werift** (TypeScript, MIT) and **Pion** (Go, MIT) as references. It is credited in the file headers, and no code is copied verbatim.

Because both sides derive every parameter themselves (zero SDP), **there is no SDP parser and no offer/answer engine.** The subset talks to Chrome, Firefox and Safari as a normal WebRTC peer.

| Layer | What we implement | What we skip | Lines |
|---|---|---|---|
| **STUN / ICE** (RFC 8445, 5389) | binding request/response, USERNAME, MESSAGE-INTEGRITY (HMAC-SHA1), FINGERPRINT (CRC-32), PRIORITY, ICE-CONTROLLING/CONTROLLED + tie-breaker, USE-CANDIDATE (aggressive nomination as controlling, honoured as controlled), consent freshness (answer and send every 5 s); host + srflx candidates; **TURN client** (Allocate, CreatePermission, Send/Data) for the relay case | TCP candidates, ICE restarts, regular nomination | ~300 |
| **DTLS 1.2** (RFC 6347, 7627) | client **and** server; exactly one suite: `ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` on P-256; extended master secret; mutual certificates checked against the signalled fingerprint; HelloVerifyRequest handled as client; handshake fragmentation and reassembly; flight retransmission (1 s, doubling) | DTLS 1.3 (browsers fall back to 1.2), SRTP, resumption, renegotiation, other suites | ~600 |
| **X.509** | generate a self-signed ECDSA P-256 certificate (minimal DER writer); read the peer's public key (minimal DER reader); convert ECDSA signatures between raw and DER | everything else | ~80 |
| **SCTP** (RFC 4960, 8261) | association setup (INIT/INIT-ACK/COOKIE with HMAC cookie), DATA with fragmentation, SACK, retransmission timer, HEARTBEAT reply, SHUTDOWN/ABORT, CRC-32c; **one stream, id 0, reliable and ordered** (our channel is `negotiated: true, id: 0`, so no DCEP is needed) | multiple streams, partial reliability, FORWARD-TSN, gap-ack generation (we accept peers' gap acks), congestion-control tuning | ~400 |

**Crypto mapping:** ECDHE → WebCrypto ECDH P-256; signatures → ECDSA P-256; PRF → HMAC-SHA256; records → AES-128-GCM; STUN → HMAC-SHA1. All of it comes from WebCrypto, so the subset runs on any runtime that has UDP.

**The result:** `connect()`/`listen()` return the same small channel interface everywhere (`send`, `onmessage`, `onopen`, `onclose`, `close`, `readyState`), which is the subset of `RTCDataChannel` apps actually use.

### Payoff: browsers can reach anchors without TLS or a domain
With the subset running inside anchors, **a browser can open a WebRTC connection straight to an anchor's `IP:port`**, with no signalling server and no certificate authority. This is the `webrtc-direct` pattern. The anchor learns the browser's key from the ICE username (`ufrag = hex(browser_pk)`) and derives the shared password from both keys, so the very first packet is authenticated. KRPC then runs over that DataChannel.

The anchor line gains the certificate hash: `rv-anchor:<z32>@<ip>:<port>;fp=<base64url sha-256>`. **Every anchor becomes usable from browsers**, not only the ones with `wss://`. WebSocket stays as the fallback for networks that block outbound UDP.

---

## 6b. Surviving browser updates (Chrome, Firefox, Safari)

**Ground rule:** our own WebRTC code is never the only way to do anything. Each layer has a fallback that uses only standard browser features, so a browser update can at worst make one route slower, never break the project.

### What our DTLS code can and can't break
| Path | Uses our DTLS? | If it breaks |
|---|---|---|
| browser ↔ browser `connect()` | **no**, both sides use the browsers' own stacks | unaffected |
| discovery, signalling, anchor book in browsers | **no**, also runs over HTTPS POST / `wss` / DoH | unaffected |
| browser → IP-only anchor (`webrtc-direct`) | yes | browser uses the anchors that have `web=` (HTTPS/`wss`) instead |
| browser ↔ Node/Bun/Deno peer `connect()` | yes | falls back through the ladder below |

### Fallback ladder for a native ↔ browser connection
1. **Our subset as DTLS client**, and if the handshake fails, **retry with our side as DTLS server**. We write the SDP template, so we choose the role and can simply try both.
2. **A standard WebRTC library, if one is installed** (`node-datachannel`, `werift`, or a future built-in `RTCPeerConnection` in Node/Deno/Bun). It's picked up automatically; we never depend on it.
3. **Message channel:** `connect()` still returns a channel (`kind: 'relay'`), carried as end-to-end encrypted rendezvous messages through the anchors of both peers (sequence numbers, acks, 64 KB/s cap, ~60 lines). It's slow but always works, and it's relayed by peers as the scope allows.

`connect()` result: `{ channel, kind: 'direct' | 'turn' | 'relay' }`. When a route fails, the peer remembers this per browser family and version, so the next attempt skips straight to the route that works.

### Staying inside what browsers can't drop
- We implement **only the profile WebRTC's own security spec (RFC 8827) requires every endpoint to support:** DTLS 1.2, `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256`, P-256, SHA-256 fingerprints. A browser that dropped these would break interop with every SFU and with Pion, libwebrtc and str0m endpoints. That can't happen quietly.
- **DTLS 1.3:** when a browser offers 1.3, we answer 1.2 (standard version negotiation). When we're the client, we offer 1.2 only.
- **Liberal parsing:** unknown extensions are ignored, coalesced or fragmented records are accepted, and messages arriving out of order are handled.

### Browser differences that don't touch our DTLS (each with a fallback)
| Feature | Chrome | Firefox | Safari | Fallback |
|---|---|---|---|---|
| WebCrypto Ed25519 / X25519 | ✅ | ✅ | ✅ (recent) | `src/crypto-fallback.js`: pure-JS Ed25519/X25519 (~250 lines, ported from TweetNaCl, public domain), loaded only when WebCrypto lacks them |
| Editing ICE ufrag/pwd in the local SDP | ✅ (tested) | ⚠️ to verify | ⚠️ to verify | if `setLocalDescription` rejects the edit, **send the real ufrag/pwd inside the `rtc` message** (+40 B). Fully standard; editing is only an optimisation |
| `webrtc-direct` to anchors | needs no SDP editing at all: anchors run **ICE-lite** with a fixed password derived from the anchor's public key. The DTLS fingerprint `fp=` authenticates the anchor; `rv_listen` authenticates the browser | | | HTTPS/`wss` anchors |
| `negotiated: true` DataChannel id 0 | ✅ | ✅ | ✅ | none needed (standard since 2015) |

### Early warning
- **Daily CI against pre-release browsers:** Chrome Beta/Dev/Canary, Firefox Beta/Nightly, Playwright WebKit, and **real Safari + Safari Technology Preview** on a macOS runner (driven through `safaridriver` with a ~50-line WebDriver client, so still no dependency). Pre-release builds reach users about 4–12 weeks later, which leaves time to fix things.
- **Anchors count handshake outcomes** per browser family/major version and serve them at `GET /stats`, so real-world breakage shows up as numbers.

## 7. Files (~3,550 lines total)

| File | Contents | State |
|---|---|---|
| `src/bytes.js`, `crypto.js`, `bencode.js`, `record.js` | primitives, Beacon, DNS codec (generalised for TXT queries/answers) | ✅ draft / ✏️ DNS |
| `src/dht.js` | sans-IO KRPC node + `get_peers`/`announce_peer` + `rv_*` hooks | ✏️ |
| `src/book.js` | anchor lines: parse (grep), format, score, merge, probe scheduling, persistence interface | ⬜ ~150 |
| `src/peer.js` | `create · publish · resolve · send · on · connect · listen · anchors` | ✏️ |
| `src/rtc.js` | zero-SDP DataChannel setup | ✏️ from `webrtc.js` |
| `src/anchor.js` | UDP demux (KRPC · STUN/TURN · DTLS for `webrtc-direct` · LAN `RV?`) · HTTP (`POST /krpc` + long poll, `/anchors.txt`, `/dns-query`, `/rv/*.js`) · WebSocket · rate limits | ✏️ |
| `src/turn.js` | TURN subset (RFC 5766) + quotas | ⬜ ~200 |
| `src/lan.js` | broadcast/multicast responder + client, mDNS responder + query | ⬜ ~110 |
| `src/portmap.js` | NAT-PMP/PCP + UPnP-IGD | ⬜ ~100 |
| `src/native.js` | Node/Bun/Deno node: wires UDP socket, book file, LAN, portmap, promotion, optional DNS:53 | ⬜ ~100 |
| `src/webrtc/stun.js` | STUN codec, ICE agent, TURN client | ⬜ ~300 |
| `src/webrtc/dtls.js` | DTLS 1.2 client+server, one cipher suite | ⬜ ~600 |
| `src/webrtc/x509.js` | self-signed cert, DER helpers | ⬜ ~80 |
| `src/webrtc/sctp.js` | SCTP association, one reliable stream, CRC-32c | ⬜ ~400 |
| `src/webrtc/index.js` | `dial()/accept()` → channel; the same zero-SDP parameters as the browser path | ⬜ ~80 |
| `src/crypto-fallback.js` | pure-JS Ed25519 + X25519 for old browsers (lazy-loaded) | ⬜ ~250 |
| `src/relaychan.js` | message-channel fallback (seq/ack/window over rendezvous messages) | ⬜ ~60 |
| `test/ci/` | WebDriver client for Safari, browser-matrix runner, nightly workflow | ⬜ ~120 |
| `bin/rv.js`, `src/demo.html`, `anchors.txt` | CLI (`anchor · node · id · anchors · resolve · send · listen`), demo, baked-in list | ✏️ |

---

## 8. API

```js
import { Peer } from 'rendezvous'

const me = await Peer.create({ seed })          // bootstraps itself via §4.3. Optional: anchors, sources, dohDomains
me.address
await me.publish()
me.listen(({ from, channel }) => {})
const { channel, kind } = await me.connect(address)   // kind: 'direct' | 'turn' | 'relay'

me.anchors()                                    // → anchor lines, best first (string). Share it anywhere
me.addAnchors(text)                             // merge any text that contains anchor lines
await me.resolve(address); await me.send(address, body); me.on(fn)
```
Native: `rv node` (a peer that promotes itself to an anchor when reachable) or `rv anchor` (forces anchor mode).

## 9. Limits enforced in code
- Beacon: signature, monotonic seq, ≤ 1000 B. Message: AEAD sender authentication, ts window, IV dedup, ≤ 1024 B.
- Anchor lines: ≤ 255 chars, IPs must be public unicast (except entries learned on the LAN), book ≤ 1000, at most 16 unverified probes per minute (so lists can't be used to make us attack someone).
- Per IP: `put` 10/min, `rv_send` 60/min, `get` 120/min, `rv_anchors` 30/min, `rv_check` 5/min, `rv_turn` 10/min; LAN `RV?` replies 10/s.
- TURN: 10-min allocations, ≤ 4 per key, ≤ 1 Mbit/s and 500 MB each.

---

## 10. Tests (`npm test`)
| Test | Proves |
|---|---|
| `core` | encodings, ed→x, Beacon/message tamper and replay, **anchor line grep from messy text**, score maths |
| `dht` | 20 nodes: put/get, stale seq and bad signature rejected, `announce_peer` → `get_peers` finds anchors |
| `book` | 10 anchors start knowing only one neighbour → after N gossip rounds every book holds all 10; a fake line (wrong key) is never marked verified; a dead anchor's score decays |
| `channels` | a fresh node with an empty cache bootstraps through each channel separately: HTTP, any-text URL, DoH (local responder), KRPC, `get_peers`, UDP broadcast, mDNS, file, invite link |
| `promotion` | a node reachable from a second anchor becomes an anchor; an unreachable one doesn't |
| `anchor` / `turn` | messaging across 3 anchors; STUN; TURN allocate/permission/data; quotas; rate limits |
| `browser` | two Chromium pages **served over https** (self-signed test origin): bootstrap via DoH (local resolver), `https` `/anchors.txt` and `webrtc-direct` to an IP-only anchor; KRPC over `POST /krpc`, WebSocket and DataChannel; connect direct and forced-relay |
| `webrtc-unit` | STUN/MI/FINGERPRINT vectors (RFC 5769), CRC-32c vectors, DTLS PRF vector, SCTP chunk round trips, packet-loss simulation (20% drop) still delivers 1 MB in order |
| `webrtc-interop` | **our subset ↔ real Chromium** (Playwright), with our side as DTLS client *and* as server; native ↔ native; native ↔ native through TURN only; browser → anchor `webrtc-direct` running KRPC |
| `fallbacks` | forced DTLS failure → role swap → message channel still delivers; SDP editing disabled → real-credential path connects; WebCrypto Ed25519 hidden → pure-JS fallback produces identical keys and signatures |
| `matrix` (CI, nightly) | `browser` + `webrtc-interop` on Chrome stable/beta/canary, Firefox stable/beta/nightly, WebKit, Safari + Safari TP |
| `bun` | `anchor` + `book` + `webrtc-interop` (native side) pass under Bun |
| `live` (manual) | Beacon via `relay.pkarr.org`; TXT via public DoH; `announce_peer` on real Mainline |

## 11. Build order
1. `dht` (+ get_peers/announce_peer, hooks) → `core`, `dht` green
2. `book` + `rv_hi`/`rv_anchors` → `book` green
3. `anchor` (KRPC over WS, HTTP, DoH, LAN `RV?`) + `lan` + `native` → `channels` green
4. `portmap` + `rv_check` → `promotion` green
5. `turn` + `rtc` + `peer.connect` → `anchor`, `turn`, `browser` green
6. `webrtc/` subset: stun → x509 → dtls → sctp, each against Chromium as soon as it can talk → `webrtc-unit`, `webrtc-interop` green; then anchors accept `webrtc-direct`
7. CLI, demo, baked-in `anchors.txt`, Bun, live checks
8. README + `SPEC.md` (including the ICMP channel for native ports). **Done.**

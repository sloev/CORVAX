# Rendezvous: the plan (final scope)

> **Peers find each other by key and end up with an open WebRTC DataChannel. That's all.**

## 1. Scope

Rendezvous does exactly four things:

1. **Identity:** a key pair whose public key is a permanent address.
2. **Discovery:** publish a signed record under that address; anyone, on any runtime, can resolve it.
3. **Signalling:** deliver small encrypted messages between addresses (used internally to set up the connection, and available to apps).
4. **Connection:** open an `RTCDataChannel` between the two peers, **direct when possible, otherwise relayed by another peer**.

The protocol ends when `connect()` returns an open DataChannel. What the peers send over it is up to them.

### Non-goals (permanently)
- Anything on top of the DataChannel (framing, RPC, streams, files, media)
- Gossip, peer exchange, social introductions, topics/rooms
- Reputation, utility scores, incentives
- Extra carriers (mDNS, BLE, QR, audio, DNS servers, ...)
- Our own WebRTC stack. Browsers have one built in; other runtimes plug in a standard one (§5)
- Ports to other languages (the spec is small enough for others to write them)

### Finished when
- [ ] All tests in §8 pass
- [ ] A Beacon published by our code reads back from the public pkarr relay (real Mainline compatibility)
- [ ] Two browsers on different networks open a DataChannel knowing only each other's address, both **direct** and **forced through a peer relay**
- [ ] README + `SPEC.md` are written. After that the project only receives bug fixes.

---

## 2. Design (each decision made once)

| | Decision |
|---|---|
| **Code** | One zero-dependency ESM JavaScript codebase. Browsers, Node 22+, Bun, Deno. No build step. |
| **Crypto** | WebCrypto only (Ed25519, X25519, HKDF, AES-GCM, SHA-1). The anchor additionally uses `node:crypto` for the HMAC-SHA1 and MD5 that TURN requires. |
| **Address** | Ed25519 public key, z-base32, 52 chars (same as pkarr and iroh). Never expires. |
| **Discovery protocol** | BitTorrent Mainline KRPC (BEP 5 + BEP 44) on every transport, plus 3 extra queries |
| **Record** | pkarr signed packet (≤ 1000 B) = BEP 44 mutable item at `SHA1(pk)` |
| **Anchors** | Ordinary DHT nodes with a public UDP port. They can join the live Mainline DHT (`--mainline`) or form their own network. They serve WebSocket for browsers, plus **STUN and TURN on the same port**, so any anchor is also a relay peer. |
| **Connection** | Standard WebRTC with **zero SDP on the wire**: both sides derive ICE credentials from their shared key and build the remote SDP from a template. Only `{fp, sid}` and candidates are sent, as encrypted messages. |
| **Relaying** | Plain **TURN, run by peers** (anchors). ICE prefers a direct path automatically and falls back to a relay candidate. Relays only ever see DTLS ciphertext, because the DataChannel is end-to-end encrypted. |

---

## 3. Protocol

### 3.1 Discovery and signalling (bencoded KRPC)
Transports: **UDP** (anchor ↔ anchor / Mainline) and **WebSocket** (client ↔ anchor), one message per datagram or frame. Clients set `ro: 1` (BEP 43).

| Query | Source | Meaning |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get`, `put` | BEP 44 | resolve / publish a Beacon |
| `rv_listen {k, ts, sig}` | ours | "deliver my messages to this connection". `sig` = Ed25519(`"rv-listen:" ‖ ts`), ±5 min |
| `rv_send {to, msg}` | ours | → `{delivered: 0/1}`. Delivered to listening connections, otherwise held for 2 min (≤ 64 per address) |
| `rv_turn {}` | ours | (only after `rv_listen`) → `{user, pass, ttl}` TURN credentials for this anchor |
| `rv_msg {msg}` | ours, anchor → client | a delivered message (no reply) |

### 3.2 Formats
```
Address  z32(ed25519_pk)                                                        52 chars
Beacon   pkarr: sig 64 | seq 8 (BE µs) | DNS packet, TXT "_rv" = "k=v"          ≤ 1000 B
         c=<anchor ws url> (1..n): where to message me, and which relays I use
Message  from_pk 32 | iv 12 | AES-GCM_K( ts 8 | bencode(body) ) | tag 16        ≤ 1024 B
K        HKDF-SHA256( X25519(ed→x(sk_self), ed→x(pk_peer)), salt = sorted(pk_a ‖ pk_b) )
ICE      HKDF(K, "rv/ice/<sid>/<caller|callee>") → ufrag = hex 4 B, pwd = hex 16 B
TURN     user = "<expiry>:<z32 pk>", pass = base64(HMAC-SHA1(anchor_secret, user))   (the "TURN REST" scheme)
```
Receivers reject messages with `|now − ts| > 10 min` or a repeated IV.

### 3.3 `connect(address)`
```
1 RESOLVE    Beacon of B (newest valid seq) → B's anchors
2 RELAYS     rv_turn on own anchors → iceServers = [stun+turn on own anchors]
3 OFFER      A: createOffer, swap in derived creds, setLocal → msg {t:'rtc', sid, fp_A}  (to B's anchors)
4 ANSWER     B: same for its own anchors; builds A's offer from the template, answers → msg {t:'rtc-ok', sid, fp_B}
             A: builds B's answer from the template
5 ICE        both trickle msg {t:'rtc-c', sid, c}. ICE picks host/srflx (direct), otherwise relay
6 OPEN       negotiated DataChannel id 0 opens → resolve { channel, pc, relayed }
             (relayed = getStats() selected pair has a relay candidate)
Errors       DirectError: 'not-found' | 'no-answer' | 'ice-failed' | 'timeout'
```
Peer authentication needs no extra step. Only the holder of the address's key can decrypt the `rtc` message and derive the ICE password. The DTLS fingerprints travel inside authenticated messages, so the channel is bound to both identities.

---

## 4. Files (~1,250 lines total)

| File | Contents | State |
|---|---|---|
| `src/bytes.js` | hex, base64url, z-base32, u64, concat | ✅ draft |
| `src/crypto.js` | WebCrypto wrappers, Ed25519→X25519 | ✅ draft |
| `src/bencode.js` | encode/decode (hardened) | ✅ draft |
| `src/record.js` | Beacon + BEP 44 signable + tiny DNS TXT codec | ✅ draft |
| `src/dht.js` | sans-IO KRPC node + `rv_*` hooks | ✏️ add hooks |
| `src/peer.js` | `create · publish · resolve · send · on · connect · listen` | ✏️ KRPC over WS, merge connection code |
| `src/rtc.js` | zero-SDP DataChannel setup (from the tested experiment) | ✏️ from `webrtc.js` |
| `src/anchor.js` | UDP demux (KRPC · STUN/TURN) · WebSocket server · inboxes · rate limits | ✏️ KRPC over WS |
| `src/turn.js` | TURN server subset (RFC 5766): Allocate, Refresh, CreatePermission, ChannelBind, Send/Data, ChannelData; long-term auth; quotas | ⬜ new, ~200 lines |
| `src/index.js`, `bin/rv.js`, `src/demo.html` | exports, CLI, two-tab chat demo | ✅ draft |

---

## 5. API (the whole thing)

```js
import { Peer } from 'rendezvous'          // or https://<anchor>/rv/index.js

const me = await Peer.create({ seed, anchors: ['wss://anchor.example'] })
me.address                                 // permanent, shareable
await me.publish()                         // signed Beacon → DHT (refreshed every 30 min)

me.listen(({ from, channel }) => {})       // incoming DataChannels
const { channel, relayed } = await me.connect(address)

await me.resolve(address)                  // lower level: the Beacon
await me.send(address, body); me.on(fn)    // lower level: encrypted messages ≤ 1 KB
```
**Outside browsers** (Node, Bun, Deno), pass any standard WebRTC implementation: `Peer.create({ RTCPeerConnection })` (e.g. from `node-datachannel/polyfill` or `werift`). Rendezvous itself imports nothing. Without one, everything except `connect`/`listen` still works.

---

## 6. Relays (peers, not servers)
- **Who:** every anchor, i.e. any native peer with a public UDP port. Running one is `rv anchor`.
- **Which:** each side offers TURN on *its own* anchors. ICE tests all pairs and picks the best: direct first, relay last. No selection logic of our own.
- **What they see:** DTLS ciphertext and IP addresses. Never content.
- **Limits:** allocations last 10 min (refreshable), ≤ 4 per key, ≤ 1 Mbit/s and 500 MB per allocation, credentials only for keys that proved ownership with `rv_listen`.

## 7. Limits enforced in code
- Beacon: signature valid, seq monotonic, ≤ 1000 B, checked on store *and* on use
- Message: AEAD authenticates the sender, ts window, IV dedup, ≤ 1024 B
- Anchor per IP: `put` 10/min, `rv_send` 60/min, `get` 120/min, `rv_turn` 10/min; inbox cap 64; frame cap 4 KB
- DHT: tokens tied to the source IP, rotated every 10 min; routing table capped at 1000; responders added only after they answer

---

## 8. Tests (`npm test`)
| Test | Proves |
|---|---|
| `core` | z32 / bencode round trips, truncated bencode never hangs, `ed→x(pk)` equals the derived X25519 key, Beacon tamper detection, message tamper + replay rejection |
| `dht` | 20 nodes on loopback: put on one, get from another; stale seq and bad signature rejected |
| `anchor` | 3 chained anchors: A publishes on #1, B on #3 resolves A and sends a message → A receives it; STUN reply correct; rate limit triggers |
| `turn` | allocate → permission → data round-trips through the relay; bad credentials rejected; quotas enforced |
| `browser` | Playwright, two Chromium pages: `connect()` opens a channel **direct**, and again with `iceTransportPolicy: 'relay'` **through our TURN** (`relayed: true`); messages echo |
| `bun` | the `anchor` test passes under Bun |
| `pkarr-live` (manual) | our Beacon round-trips through `relay.pkarr.org` |

## 9. Build order
1. `dht.js` hooks + `ro` → `core`, `dht` green
2. `anchor.js` KRPC over WebSocket, `rv_listen`/`rv_send`, rate limits → `anchor` green
3. `turn.js` + `rv_turn` → `turn` green
4. `peer.js` + `rtc.js`: `connect`/`listen` → `browser` green (direct + relayed)
5. CLI, demo, `pkarr-live`, Bun run
6. README (quickstart, `cloudflared tunnel` for `wss://`, note that a direct connection reveals your IP to the peer) + `SPEC.md`. **Done.**

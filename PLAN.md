# Rendezvous: the plan (final scope)

> **Peers find each other by key and exchange whatever they need to connect. That's all.**

## 1. Scope

Rendezvous does exactly three things:

1. **Identity:** a key pair whose public key is a permanent address.
2. **Discovery:** publish a signed record under that address; anyone can resolve it.
3. **Signalling:** deliver a small encrypted message to an address (an ICE candidate, an `IP:port`, an offer, anything up to 1 KB).

Then it gets out of the way. **How peers connect afterwards (WebRTC, QUIC, TCP, carrier pigeon) is up to them.**

### Non-goals (permanently, not "later")
- Making or managing connections (WebRTC setup, NAT traversal strategy, relays, TURN)
- Carrying application data (messages are size- and rate-limited, for signalling only)
- Gossip, peer exchange, social introductions, topics/rooms
- Reputation, utility scores, incentives
- Extra carriers (mDNS, BLE, QR, audio, DNS servers, ...)
- Ports to other languages (the spec is small enough that others can write them)

### Finished when
- [ ] All tests in §7 pass
- [ ] A Beacon published by our code can be read back from the public pkarr relay (real Mainline compatibility)
- [ ] Two browsers on different networks exchange messages knowing only each other's address
- [ ] README + spec are written. After that the project only receives bug fixes.

---

## 2. Design (each decision made once)

| | Decision |
|---|---|
| **Code** | One zero-dependency ESM JavaScript codebase. Runs in browsers, Node 22+, Bun, Deno. No build step. |
| **Crypto** | WebCrypto only: Ed25519, X25519, HKDF-SHA256, AES-GCM, SHA-1 |
| **Address** | Ed25519 public key, z-base32, 52 chars (same as pkarr and iroh). Never expires. |
| **Protocol** | BitTorrent Mainline KRPC (BEP 5 + BEP 44) on every transport, plus 2 extra queries |
| **Record** | pkarr signed packet (≤ 1000 B) = BEP 44 mutable item at `SHA1(pk)` |
| **Network** | Anchors are ordinary DHT nodes. They can join the live Mainline DHT (`--mainline`) or form their own network. Browsers reach them over WebSocket. |

---

## 3. Protocol

All messages are bencoded KRPC. Transports: **UDP** (anchor ↔ anchor / Mainline) and **WebSocket** (client ↔ anchor), with one message per datagram or frame. Clients set `ro: 1` (BEP 43).

| Query | From | Meaning |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get`, `put` | BEP 44 | resolve / publish a Beacon |
| `rv_listen {k, ts, sig}` | ours | "deliver my messages to this connection". `sig` = Ed25519(`"rv-listen:" ‖ ts`), ±5 min |
| `rv_send {to, msg}` | ours | → `{delivered: 0/1}`. Delivered to listening connections, otherwise held for 2 min (≤ 64 per address) |
| `rv_msg {msg}` | ours, anchor → client | a delivered message (no reply) |

### Formats
```
Address  z32(ed25519_pk)                                                        52 chars
Beacon   pkarr: sig 64 | seq 8 (BE µs) | DNS packet, TXT "_rv" = "k=v"          ≤ 1000 B
         c=<anchor url>  (where to send me messages; 1..n)   + any app-defined k=v
Message  from_pk 32 | iv 12 | AES-GCM_K( ts 8 | bencode(body) ) | tag 16        ≤ 1024 B
K        HKDF-SHA256( X25519(ed→x(sk_self), ed→x(pk_peer)), salt = sorted(pk_a ‖ pk_b), "rv/msg" )
```
Receivers reject messages with `|now − ts| > 10 min` or a repeated IV.

---

## 4. Files (~900 lines total)

| File | Contents | State |
|---|---|---|
| `src/bytes.js` | hex, base64url, z-base32, u64, concat | ✅ draft |
| `src/crypto.js` | WebCrypto wrappers, Ed25519→X25519 | ✅ draft |
| `src/bencode.js` | encode/decode (hardened) | ✅ draft |
| `src/record.js` | Beacon + BEP 44 signable + tiny DNS TXT codec | ✅ draft |
| `src/dht.js` | sans-IO KRPC node + `rv_*` hooks | ✏️ add hooks |
| `src/anchor.js` | UDP (DHT + STUN responder) · HTTP (pkarr-relay GET/PUT, serves `/rv/*.js`) · WebSocket server | ✏️ KRPC over WS |
| `src/peer.js` | `create · publish · resolve · send · on` | ✏️ KRPC over WS |
| `src/index.js` | exports | ✅ |
| `bin/rv.js` | `rv anchor · id · resolve · send · listen` | ✅ draft |
| `example/webrtc.html` | **Not part of the library.** Shows ~60 lines of zero-SDP WebRTC built on `send`/`on` | ✏️ move from `src/webrtc.js` + `demo.html` |

The STUN responder stays (≈15 lines). It is a reachability primitive ("what is my public `IP:port`?"), which is part of a peer getting its own address.

---

## 5. API (the whole thing)

```js
import { Peer } from 'rendezvous'          // or https://<anchor>/rv/index.js

const me = await Peer.create({ seed, anchors: ['wss://anchor.example'] })
me.address                                 // permanent, shareable
await me.publish({ n: 'name' })            // signed Beacon → DHT (refreshed every 30 min)
await me.resolve(address)                  // → { c: [...], n: [...], seq } | null
await me.send(address, body)               // encrypted, ≤ 1 KB → true (delivered) / false (queued)
me.on(({ from, body }) => {})              // incoming messages
me.close()
```

---

## 6. Limits enforced in code
- Beacon: signature valid, seq monotonic, ≤ 1000 B, checked on store *and* on use
- Message: AEAD authenticates the sender, ts window, IV dedup, ≤ 1024 B
- Anchor per IP: `put` 10/min, `rv_send` 60/min, `get` 120/min; inbox cap 64; frame cap 4 KB
- DHT: tokens tied to the source IP, rotated every 10 min; routing table capped at 1000; responders added only after they answer

---

## 7. Tests (`npm test`)
| Test | Proves |
|---|---|
| `core` | z32 / bencode round trips, truncated bencode never hangs, `ed→x(pk)` equals the derived X25519 key, Beacon tamper detection, message tamper + replay rejection |
| `dht` | 20 nodes on loopback: put on one, get from another, stale seq and bad signature rejected |
| `anchor` | 3 chained anchors: A publishes on #1, B on #3 resolves A and sends → A receives; `GET /<addr>` returns pkarr bytes; STUN reply is correct; rate limit triggers |
| `browser` | Playwright, two Chromium pages: resolve + exchange messages through an anchor; `example/webrtc.html` connects |
| `bun` | the `anchor` test passes under Bun |
| `pkarr-live` (manual) | our Beacon round-trips through `relay.pkarr.org` |

---

## 8. Build order
1. `dht.js` hooks + `ro` → `core`, `dht` green
2. `anchor.js` WebSocket door speaks KRPC, `rv_listen`/`rv_send`, rate limits → `anchor` green
3. `peer.js` on KRPC-over-WS, publish refresh → `browser` (messages) green
4. Move WebRTC into `example/`, CLI, `pkarr-live`, Bun run
5. README (quickstart, `cloudflared tunnel` for `wss://`, IP-exposure note) + `SPEC.md` (§3 as a standalone page). **Done.**

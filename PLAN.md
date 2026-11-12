# Rendezvous: implementation plan (single pass)

> **Find anyone by key. Connect directly. No servers you have to trust, no conversation relays, no dependencies.**

This document replaces the earlier plans: v1 ("signal over anything") and v2 ("peers only"), plus the BrowserMesh concept note. It describes **one codebase**, **one protocol** and **one first milestone**, written precisely enough to build in a single pass. Everything not needed for that milestone is in §12 *Later*.

---

## 1. What we build

```
 BROWSER A ──(WebSocket: KRPC)──► ANCHOR ◄──(UDP: KRPC)──► ANCHOR / Mainline DHT nodes
     │                              ▲
     │ zero-SDP WebRTC              │ (WebSocket: KRPC)
     ▼                              │
 BROWSER B ─────────────────────────┘

 BROWSER A ◄══════ authenticated, direct DataChannel ══════► BROWSER B
```

**Milestone (definition of done):** two browsers on different networks, knowing only each other's address, find each other through the DHT and open a **direct, authenticated** DataChannel. No conversation bytes pass through any anchor. If no direct path exists, the connection **fails loudly**; it is never silently relayed.

---

## 2. Decisions (with the BrowserMesh note reconciled)

| Topic | BrowserMesh note | **Decision** | Why |
|---|---|---|---|
| Foundation | js-libp2p | **Zero dependencies.** Small, reimplemented pieces of standard protocols | Less code, nothing to keep in sync with upstream, one file tree that runs everywhere. libp2p is ~100k lines. |
| Language | TypeScript | **Plain ESM JavaScript** + JSDoc types | Runs unmodified in browsers, Node 22+, Bun, Deno, Workers. No build step. |
| Identity | `peer_id = SHA256(pk)` | **Address = Ed25519 public key**, z-base32 (52 chars) | Anyone holding the address can verify *and* encrypt to it. Same format as pkarr and iroh. |
| DHT | custom Kademlia, 256-bit, K=20 | **The Mainline DHT protocol itself** (BEP 5 + BEP 44): 160-bit IDs, `target = SHA1(pk)`, K=8 | We can join a live network of ~10M nodes instead of bootstrapping a new one. Our own anchors form the same DHT among themselves. |
| Wire encoding | deterministic CBOR | **Bencode KRPC everywhere** (UDP, WebSocket, DataChannel) | One protocol, already deterministic and compatible with Mainline. JSON is dropped. |
| Records | JSON presence, 4 KB, TTL 120 s | **pkarr signed packet** (≤ 1000 B) holding the **Beacon** | Mainline limit. It *is* DNS, and pkarr relays can read it. |
| Identity vs presence | separate | **Beacon** = where to reach me (refreshed every 30 min, expires after 2 h). **Presence** = an open inbox on an anchor (instant, gone on disconnect). | Writing to the DHT every 45 s would be abuse. Presence is cheap where it lives. |
| Signalling | signed SDP + ICE via rendezvous | **Letters**: end-to-end encrypted, ≤ 1 KB, carrying `{fp, sid}` and candidates only. **Zero SDP** (both sides derive it) | Tested in Chromium. The anchor sees only ciphertext. |
| Relays | never, TURN disabled | **`directOnly: true` by default**: no TURN, the selected candidate pair is checked with `getStats()` and the connection is dropped if it is relayed | Matches the note's core principle. Peer relays are a later, opt-in profile. |
| Identity verification | sign session info | **Implicit + explicit:** Letters are authenticated by `K_ab`, so the DTLS fingerprint inside is bound to the identity. Then a challenge in the channel: each side signs `H(both fingerprints ‖ sid)` | A forged fingerprint fails the AEAD check. The challenge proves who is live on the other end. |
| Gossip, introductions, utility scores | v1 features | **§12 Later** | Not needed for the milestone. |

---

## 3. One protocol: KRPC with two extensions

Every node (anchor, native, browser) speaks **Mainline KRPC** (bencoded `{t, y, q, a}` / `{t, y, r}` / `{t, y, e}`). The transport doesn't matter:

| Transport | Used between | Framing |
|---|---|---|
| UDP | anchor ↔ anchor, anchor ↔ Mainline | one datagram = one message |
| WebSocket (binary) | browser/CLI ↔ anchor | one frame = one message |
| DataChannel | browser ↔ browser (§12 Later) | one message = one message |

**Queries:**

| `q` | Standard | Purpose |
|---|---|---|
| `ping`, `find_node` | BEP 5 | routing |
| `get`, `put` | BEP 44 | Beacon lookup and store (signature, seq and token checked) |
| `rv_listen` | **ours** | `{k, ts, sig}`: open my inbox on this anchor (sig = Ed25519 over `"rv-listen:" ‖ ts`, ±5 min) |
| `rv_send` | **ours** | `{to, letter}` → `r: {delivered: 0/1}`. Delivered to open inboxes, otherwise queued for 2 min (≤ 64 per inbox) |
| (push) `rv_letter` | **ours** | anchor → client: `{letter}` (a query that gets no reply) |

Clients connected over WebSocket set `ro: 1` (BEP 43), so they are never added to routing tables. **The anchor is just a DHT node with a WebSocket door**, and the browser runs the same `DHT` class, which saves a whole client protocol.

---

## 4. Data formats (all sizes in bytes)

```
Address      z32(ed25519_pk)                                         52 chars
DHT target   SHA1(pk)                                                20
Beacon       pkarr: sig 64 | seq 8 (BE µs) | DNS packet (TXT "_rv" "k=v")   ≤ 1000
             fields: c=<anchor ws url> (1..n), x=<expiry unix s>, n=<name>
Letter       from_pk 32 | iv 12 | AES-GCM_{K_ab}( ts 8 | bencode(body) ) | tag 16   ≤ 1024
K_ab         HKDF-SHA256( X25519(edToX(sk_a), edToX(pk_b)), salt = sort(pk_a, pk_b) )
ICE creds    HKDF(K_ab, "rv/ice/<sid>/<caller|callee>") → ufrag = hex 4 B, pwd = hex 16 B
```

Letter bodies: `{t:'rtc', sid, fp}` · `{t:'rtc-ok', sid, fp}` · `{t:'rtc-c', sid, c}` · `{t:'bye', sid}`. Replay protection: `|now − ts| < 10 min` and an IV dedup set.

---

## 5. DirectConnect (state machine)

```
DISCOVERING  resolve(address) → Beacon (newest valid seq across ≥ 2 anchors)
INTRODUCING  A → B  Letter {t:'rtc', sid, fp_A}          via B's anchors (c=…)
NEGOTIATING  B builds A's offer from the template + derived creds, answers → Letter {t:'rtc-ok', fp_B}
             A builds B's answer from the template + derived creds
ICE_CHECKING both trickle {t:'rtc-c'}; iceServers = STUN on the anchors' UDP port (no TURN)
VERIFYING    in the channel: each side sends sign(sk, SHA256("rv-auth" ‖ sid ‖ fp_A ‖ fp_B)), the other verifies
             getStats(): the selected pair has no 'relay' candidate → otherwise FAILED
CONNECTED    the channel is handed to the app; getStats re-checked every 10 s
FAILED       explicit error: 'no-beacon' | 'unreachable' | 'ice-failed' | 'relayed' | 'auth-failed' | 'timeout'
```

---

## 6. Files (≈ 1,200 lines in total)

| File | Lines | Contents | State |
|---|---|---|---|
| `src/bytes.js` | 45 | concat, hex, base64url, z-base32, u64 | ✅ written |
| `src/crypto.js` | 55 | WebCrypto Ed25519/X25519, ed→x conversion, HKDF, AES-GCM, SHA-1 | ✅ written |
| `src/bencode.js` | 45 | encode/decode, hardened against truncated input and `__proto__` | ✅ written |
| `src/record.js` | 60 | Beacon make/verify/pack/unpack, BEP 44 signable, mini DNS TXT codec | ✅ written |
| `src/dht.js` | 170 | sans-IO KRPC node: routing, iterative lookup, get/put, token, storage, **+ rv_listen/rv_send hooks** | ✏️ add hooks |
| `src/transport.js` | 60 | `udp(socket)`, `websocket(url)` (client, reconnecting), `wsServer` frames → common `send/receive` | ✏️ extract from anchor/peer |
| `src/anchor.js` | 130 | UDP (DHT + STUN), HTTP (pkarr-relay GET/PUT, static files, demo), WS door, inboxes/mailboxes | ✏️ switch to KRPC-over-WS |
| `src/peer.js` | 110 | identity, publish (+ 30 min refresh), resolve, send/open Letters, inbox | ✏️ switch to KRPC-over-WS |
| `src/direct.js` | 130 | DirectConnect: zero-SDP, trickle, auth challenge, getStats direct-only check, errors | ✏️ rename + add verify |
| `src/index.js` | 10 | public API | ✅ |
| `src/demo.html` | 60 | address + QR-free copy · connect · chat | ✅ |
| `bin/rv.js` | 50 | `rv anchor · id · resolve · send · listen` | ✅ |
| `test/*.test.js` | 300 | see §8 | ⬜ |

The browser loads the library straight from any anchor (`/rv/index.js`), so **no npm, no bundler**.

---

## 7. Public API

```js
import { Peer } from 'rendezvous'                       // or from 'https://<anchor>/rv/index.js'

const me = await Peer.create({ seed, anchors: ['wss://a1.example', 'wss://a2.example'] })
me.address                                              // 52-char key: give it to anyone, it never expires
await me.publish({ n: 'Johannes' })                     // Beacon → DHT, refreshed automatically

me.listen(({ from, channel }) => channel.onmessage = e => …)   // incoming direct connections
const { channel } = await me.connect('8pz…')            // throws DirectError(code) if not direct

await me.resolve('8pz…')                                // { c: [...], n: [...], seq }
```

Native/CLI peers (no `RTCPeerConnection`) get everything except `connect/listen`. They can still publish, resolve and exchange Letters (signalling only, ≤ 1 KB, rate-limited by anchors).

---

## 8. Tests (all must pass in one `npm test`)

| Test | Proves |
|---|---|
| `core` | z32 round trip · bencode round trip + fuzz (truncated input never hangs) · `edToX(pk)` equals the X25519 public key derived from the seed · Beacon sign/verify/tamper · Letter seal/open/tamper/replay |
| `dht` | 20 in-process nodes on loopback UDP: `put` on node 1, `get` on node 20 returns the newest seq; a stale seq is rejected; a bad signature is rejected |
| `anchor` | 3 anchors chained by bootstrap; peer A on anchor 1 publishes; peer B on anchor 3 resolves A and sends a Letter → A receives it · HTTP `GET /<addr>` returns pkarr bytes · STUN reply decodes to the sender's address |
| `browser` (Playwright/Chromium) | two pages, two identities, one anchor: `connect()` → direct channel, auth ok, `getStats` pair is `host`/`srflx`, message echoes · forcing relay-only ICE → `DirectError('relayed' or 'ice-failed')` |
| `runtimes` | the `anchor` test also passes under **Bun**; `core` passes under Deno if present |
| `pkarr-live` (manual, needs network) | PUT our Beacon to `relay.pkarr.org`, GET it back, verify. **Proves wire compatibility with the real Mainline ecosystem.** |

---

## 9. Build order (one pass)

1. **dht.js hooks:** an `onQuery(q, a, from)` extension point; `ro` support; tests `core` + `dht` green.
2. **transport.js:** move the WS frame code out of anchor; client WS that reconnects and speaks bencode.
3. **anchor.js:** WS door = `dht.receive(bytes, wsFrom)`, implement `rv_listen`/`rv_send`; delete the JSON ops. Test `anchor` green.
4. **peer.js:** a `DHT` instance with `ro`, transport = WS links; `publish/resolve/send/listen` via KRPC; 30-min refresh timer.
5. **direct.js:** current `webrtc.js` + auth challenge + `getStats` check + `DirectError`. Test `browser` green.
6. **CLI + demo:** wire up; manual run of `pkarr-live`.
7. **Docs:** README quickstart (run an anchor, open the demo on two devices, or use `cloudflared tunnel --url http://localhost:4799` for instant `wss://`).

---

## 10. Security checklist (all enforced in code)

- Every Beacon: signature + seq monotonic + ≤ 1000 B, before storing *and* before using.
- Every Letter: AEAD under `K_ab` (so the sender is authenticated) + ts window + IV dedup + ≤ 1 KB.
- Anchors: per-IP token bucket (`put` 10/min, `rv_send` 60/min, `get` 120/min), inbox cap 64, WS frame cap 64 KB, `rv_listen` requires a key signature.
- DHT: tokens tied to the source IP (rotated every 10 min), a responder is added only after it answers, routing table capped at 1000.
- Direct: no TURN ever configured; selected pair verified; channel identity proven by signature.
- Disclosure in README: a direct WebRTC connection reveals your IP to the peer you connect to (by design).

---

## 11. Deploying (cost: $0)

- **Anchor:** `npx rendezvous anchor` (or `node bin/rv.js anchor`) on any box with an open UDP+TCP port, e.g. a free-tier VM, a Raspberry Pi with a port forward, or a laptop.
- **TLS for browsers on HTTPS sites:** put the anchor behind Cloudflare (`cloudflared tunnel`, free) → `wss://anchor.yourdomain`.
- **Join the global DHT:** `rv anchor --mainline`. Beacons then live on ~10M BitTorrent nodes and resolve via any pkarr relay as well.

---

## 12. Later (in order of value, none needed for the milestone)

1. **Browser DHT over DataChannels.** Browsers keep connections open and run KRPC over them (same `DHT` class). Tabs start as `ro` and are promoted after N minutes of uptime.
2. **Peer exchange + gossip** (bounded fan-out 3, TTL 5, dedup) for discovering *unknown* peers by topic: `target = SHA1("topic:" ‖ name)`.
3. **Social introductions:** signed "A introduces B to C" Letters; friends-of-friends lookup.
4. **WebRTC-direct anchors:** browsers dial anchors over UDP with no WebSocket and no TLS (needs a ~1,500-line DTLS + SCTP reimplementation).
5. **Opt-in peer relay profile** (`directOnly: false`): deterministic relay selection `closest(H(K_ab))`, friends first.
6. **Utility receipts and tiers:** signed "served you N lookups" receipts; quotas only, never gating incoming connections.
7. **More carriers:** LAN mDNS/broadcast, QR, audio, NFC, DNS-over-HTTPS read path, BEP 44 mailbox Letters for native peers.
8. **Ports:** Rust/Go/Python from the spec + test vectors (the protocol is just KRPC + 3 queries + 2 formats).
9. **Merkle range-sync** of Beacon neighbourhoods; transparency log for key rotation.

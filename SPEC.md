# CORVAX protocol `cx/1`

This is the complete wire specification. An implementation in any language that follows it interoperates with the JavaScript reference implementation in `src/`.

The protocol only grows: fields and queries never change meaning, new ones get new names, and unknown fields are ignored.

Notation: `‖` is byte concatenation. `z32` is z-base32 (alphabet `ybndrfg8ejkmcpqxot1uwisza345h769`, bits MSB-first, last group zero-padded). `b64` is base64url without padding. Strings are UTF-8.

---

## 0. Peers and anchors

There is one kind of peer. Every peer speaks the whole protocol and MAY store, serve, relay and broadcast.

An **anchor** is a peer with an independently reachable public endpoint (UDP and HTTP, verified by a stranger through `cx_check`) whose operator is expected to keep it online. That expectation is operational, not a protocol guarantee: the network tolerates anchor outages and depends on no single anchor.

Anchors have no authority over identities, topic membership or records. Everything they hold is signed by its owner and verified by its readers. Anchor lines (§3.2) list reachable peers; "storage peer" means any peer answering `cx_tpub`/`cx_tfind`/`cx_twatch`.

## 1. Standards this builds on

| Standard | Used for |
|---|---|
| BitTorrent KRPC, BEP 5 / 43 / 44 | the DHT and the message envelope on every transport |
| pkarr signed packets | the Beacon format (so Beacons live on the real Mainline DHT) |
| DNS wire format (RFC 1035) | Beacon contents, mDNS |
| STUN binding (RFC 5389) | anchors as STUN servers |
| HTTP/1.1, CORS | the client transport |
| W3C WebRTC, WebCrypto | connections and all cryptography |

---

## 2. Identity

```
seed       32 random bytes; the only secret
ed_seed  = HKDF-SHA256(ikm = seed, salt = "", info = "cx/ed25519", 32 bytes)  → Ed25519 private key (RFC 8032 seed)
x_priv   = HKDF-SHA256(ikm = seed, salt = "", info = "cx/x25519",  32 bytes)  → X25519 private key (RFC 7748)
address  = z32(ed_pub)        52 characters, case-insensitive
```

---

## 3. Records

### 3.1 Beacon
A Beacon is a pkarr signed packet, which is a BEP 44 mutable item:
```
DHT key    SHA1(ed_pub)
seq        microseconds since the Unix epoch (monotonic per key)
v          DNS message, ≤ 1000 bytes: header (id 0, flags 0x8400, ancount n), then n TXT answers
           named "_cx" (labels: 3 "_cx" 0), class IN, TTL 300, each with one string "key=value"
sig        Ed25519(ed_priv, "3:seq" ‖ bencode(seq) ‖ "1:v" ‖ bencode(v))
wire       sig 64 ‖ seq 8 (big-endian) ‖ v          (identical to pkarr relay payloads)
```
Defined keys (repeatable): `x=<b64 x25519 public key>` (required), `c=<anchor line>` (1 to n: where this peer's inbox is). Any other `key=value` is application data.

### 3.2 Anchor line
```
corvax-anchor:<z32 ed_pub>@<host>:<port>[;web=<http(s) origin>][;q=<0-100>]      ≤ 255 characters
```
- `host` is IPv4, a bracketed IPv6 address, or a DNS name.
- `port` is the same number for UDP (DHT, STUN) and TCP (HTTP).
- `web` is an HTTPS origin that serves the same HTTP API (e.g. a tunnel).
- `q` is the sender's score, a hint only.
- Readers find lines in **any** text with `corvax-anchor:[^\s"'<>\`]+`, then strip trailing `.,;:!?)]}`.
- A line is a claim. It's only trusted after `cx_hi` (§5) proves the anchor holds the key.

### 3.3 Message
```
wire   = eph_x 32 ‖ iv 12 ‖ AES-256-GCM(K, iv, inner ‖ sig)                    ≤ 4096 bytes
K      = HKDF-SHA256(ikm = X25519(eph_priv, recipient_x), salt = "", info = "cx/msg" ‖ eph_x ‖ recipient_x)
inner  = bencode { from: ed_pub 32, to: recipient ed_pub 32, id: 16 random bytes, ts: ms since epoch, body: UTF-8 JSON }
sig    = Ed25519(sender ed_priv, inner)
```
**Accept a message only if** it decrypts, `sig` verifies under `from`, `to` is your key, `|now − ts| < 600 s`, and `id` is new.

---

## 4. Transports

Every transport carries the same bencoded KRPC dictionaries: `{t, y:"q", q, a}`, `{t, y:"r", r}`, `{t, y:"e", e:[code, message]}`.

| Transport | Framing | Notes |
|---|---|---|
| UDP | one datagram = one message | node ↔ node, Mainline. A datagram whose first byte is `< 2` with the STUN magic cookie at bytes 4–7 is STUN |
| HTTP `POST /krpc` | body = one query, response = one reply | `Content-Type: text/plain` (a CORS simple request); body ≤ 8 KB; `ro: 1` |
| WebRTC DataChannel | text frame `"K" ‖ base64url(bencode)` on a connection's `cx` channel or a topic link | `cx_hi`, `cx_tpub`, `cx_tfind`; lets browsers and NATed peers serve storage |

**HTTP semantics:**
- `get`, `put` and `get_peers` are **recursive**: the anchor does the DHT work and answers with the result. `put` needs no token over HTTP.
- A repeated transaction id `t` from the same IP within 60 s gets the cached reply. This makes retries idempotent.

`GET /` on any HTTP-reachable node:
- When the `Accept` header contains `text/html`, the response is a small HTML shell: one `<script type="module" src="/cx/app.js">` (the human page, demo and query tool; it inlines the logo), then `<pre id="anchors">` with the anchor lines verbatim.
- Otherwise it is `text/plain`: the node's own anchor line first (if it is an anchor), then its shared view, one line each.
- Responses carry `Vary: Accept`. This is the simplest way for any client to fetch an anchor list.

Error codes: 201 generic · 202 rate limited · 203 protocol · 204 unknown method · 206 bad signature · 302 stale seq.

---

## 5. Queries

| Query | Arguments → reply | Notes |
|---|---|---|
| `ping`, `find_node` | BEP 5 | |
| `get_peers`, `announce_peer` | BEP 5 | anchor directory: info_hash = `SHA1("corvax anchors v1")` |
| `get`, `put` | BEP 44 | Beacons |
| `cx_hi` | `{n: ≤64 bytes}` → `{k: ed_pub, sig, line?, st?}` | `sig = Ed25519("cx-hi" ‖ n)`. Proves identity only. `st: 1` = storage peer (§10) |
| `cx_anchors` | `{me?: anchor line}` → `{a: text}` | `a` is the responder's own line plus its best 32 and 8 random lines, newline-separated. `me` introduces the caller |
| `cx_check` | `{k, port?, hport?}` → `{udp, http, ip, by}` | "can strangers reach me?" The anchor asks a *different* anchor (`cx_probe`) when it can; `by` is that anchor's key or `"self"`. `ip` is the caller's address as seen |
| `cx_probe` | `{ip, port, hport, k}` → `{udp, http}` | anchor-to-anchor only (callers must be verified anchors). Sends `cx_hi` to `ip:port` over UDP and to `http://ip:hport` |
| `cx_send` | `{to: ed_pub, msg: message}` → `{queued: 1}` | stored ≤ 120 s, ≤ 64 per key, deduplicated by SHA-256(msg). *Queued* is not *delivered* |
| `cx_listen` | `{k, ts, sig, after?}` → `{msgs: [{seq, msg}]}` | HTTP only. `sig = Ed25519("cx-listen:" ‖ ts)` within ±300 s. Messages with `seq ≤ after` are deleted (acknowledged). Waits ≤ 25 s when empty; a newer poll for the same key ends the older one with `[]` |
| `cx_tpub` | `{r: [record]}` → `{ok: [status], now}` | ≤ 32 provider records (§10.2); status per record: `ok`, `dup`, `stale`, `expired`, `future`, `full`, `bad` |
| `cx_tfind` | `{t: [topic id]}` → `{r: [record], now}` | ≤ 16 ids; live records only, ≤ 100 per topic, newest first |
| `cx_twatch` | `{t: [topic id], c?}` → `{c, r: [record], snap?, now}` | HTTP only; ≤ 64 ids; long poll (§10.3) |

---

## 6. The anchor book (rules every node follows)

- Per entry: `verified` (`cx_hi` passed), and `http`, `udp`, `rtc` each as EWMA(success, α = 0.2) of our own probes, plus `rtt`, `first`, `lastOk`.
- **Score:** unverified → `min(hint, 50)`. Verified → `round(100 · ok · (0.6 + 0.4 · √min(1, days_known / 7)))`, where `ok` is `http` for browsers and `max(udp, http)` for natives.
- **Kept tidy:** ≤ 1000 entries. Drop entries with score < 10 and no success for 7 days. Drop an entry immediately if `cx_hi` shows a different key.
- **Shared view:** best 32 plus 8 random others, excluding entries learned only on the LAN and (on public anchors) non-public addresses.
- **Anchors every 10 min:** probe ≤ 64 entries (≤ 16 unverified), pull `cx_anchors` from 3 random verified anchors, `announce_peer` on the anchor topic.
- **Promotion:** a native node calls `cx_check` at start and every 30 min, and becomes an anchor when both UDP and HTTP are reachable.

### Bootstrap sources
- local cache
- built-in list
- invite text, files and URLs (any text, including any anchor's homepage)
- DNS TXT at `_corvax-anchors.<domain>` (one anchor line per string; browsers via DNS-over-HTTPS JSON)
- `cx_anchors` on known anchors
- Mainline `get_peers` on the anchor topic, followed by `cx_hi` to learn keys
- LAN:
  - UDP `CX?` to `255.255.255.255:4798` and `239.255.42.99:4798`; the reply is anchor lines (≤ 1200 bytes)
  - mDNS query for TXT `_corvax._udp.local` on `224.0.0.251:5353`; the answer is one anchor line per TXT string

---

## 7. Connections

Every connection is a standard WebRTC peer connection with two pre-negotiated DataChannels: id 0 `app` (handed to the application) and id 1 `cx` (control).

### 7.1 Direct
Message bodies (§3.3), sent to the peer's inbox anchors (`c=` lines of its Beacon):
```
{cx:"offer",  sid, sdp, p: "app" | "relay" | "topic", tp?}     full SDP; tp = topic id (hex) for p = "topic"
{cx:"answer", sid, sdp}
{cx:"busy",   sid}                              the callee declines a relay or topic offer
{cx:"cand",   sid, c, m, i}                     candidate, sdpMid, sdpMLineIndex (may arrive before the offer)
```
`sid` is `b64(9 random bytes)`. `p: "relay"` asks for a connection used only for relaying; `p: "topic"` for a topic neighbour link (§10.4). Neither is surfaced to the application. `{cx:"via?"}` (§7.2) carries the same `p` and `tp`.

### 7.2 Through a third peer
```
A → B   {cx:"via?", sid, e: b64(eph_a), via: [≤ 8 addresses]}     A's connected peers, then A's best anchors
B → A   {cx:"via",  sid, e: b64(eph_b), c: address of C}  or  {cx:"via-no", sid}
A, B → C on the control channel (text):   {"cx":"bridge","sid":…,"to":<the other address>}
C → A, B: {"cx":"bridged","sid":…}  ·  either side or C: {"cx":"unbridge","sid":…}  ·  C refusing: {"cx":"bridge-no","sid":…}
```
- **B's choice of C:** B prefers a peer it already has a connection to; otherwise it opens a direct connection (`p: "relay"`) to the candidates in order.
- **C pairs only** two requests with the same `sid` that arrive over two different direct connections and name each other.

Frames on the control channel (binary):
```
frame  = sid 9 ‖ counter 8 (big-endian) ‖ AES-256-GCM(K_dir, iv = 0x00000000 ‖ counter, type 1 ‖ data)      ≤ 16 KB data
K_a2b  = HKDF-SHA256(X25519(eph_a, eph_b), salt = "", info = "cx/relay" ‖ sid bytes ‖ "a2b")       (K_b2a with "b2a")
type   0 = text, 1 = binary
```
- Receivers drop frames whose counter is not greater than the last one received.
- C forwards frames unchanged. It can't read them, because `eph_a` and `eph_b` travel only inside signed, sealed messages.

---

## 8. Limits (defaults)

| What | Limit |
|---|---|
| Anchor HTTP, per IP | token bucket (burst 120, 4 per second); costs `put` 6, `cx_check` 12, `cx_tpub` 2, `cx_send` 1, `get`/`get_peers`/`cx_tfind` 1, others 0.5; ≤ 64 open long polls |
| Topics | see §10.5 |
| DHT | tokens = first 8 bytes of SHA1(secret ‖ window ‖ ip), valid for the current and previous 10-minute window; routing table ≤ 1000; peers per info_hash ≤ 200, kept 30 min |
| Relaying | browsers ≤ 2 sessions at 256 kbit/s, natives ≤ 16 at 2 Mbit/s; ≤ 1 GB per hour; idle sessions close after 120 s. A session that bursts above twice its rate is closed |

---

## 9. The `RTCPeerConnection` an implementation needs

Any W3C-compatible object works. CORVAX uses only:
- `new RTCPeerConnection({ iceServers })`
- `createDataChannel(label, { negotiated: true, id })`
- `createOffer()`, `createAnswer()`, `setLocalDescription(d)`, `setRemoteDescription(d)`, `addIceCandidate(c)`, `close()`
- `localDescription`, `remoteDescription`, `onicecandidate`
- channels: `send`, `binaryType`, `readyState`, `onopen`, `onmessage`, `onclose`


---

## 10. Topics

### 10.1 Topic ids
```
normalize(name) = NFKC, trim, collapse whitespace to one space, lowercase; 1–200 bytes UTF-8
topic id        = SHA-256("cx/topic:" ‖ normalize(name))
```

### 10.2 Provider record
```
fields = bencode { t: topic id 32, k: ed_pub 32, seq: int, exp: int (ms since epoch) }
record = bencode { t, k, seq, exp, sig },   sig = Ed25519("cx-topic" ‖ fields)
```
- **`seq`:** strictly increasing per (t, k).
- **`exp`:** absolute and signed, at most `LEASE` = 10 min ahead.
- **Tombstone (unpublish):** a record with a higher `seq` and `exp ≤ now`.
- **A searcher considers a provider `recent`** while `exp > now` by its skew-corrected clock, otherwise `expired`. There is no other presence state.

### 10.3 Storage node
- **`cx_tpub` checks each record in this order:**

  | Check | Status |
  |---|---|
  | signature and sizes | `bad` |
  | `exp > now + LEASE + SKEW` (SKEW = 60 s) | `future` |
  | stored seq > seq | `stale` |
  | stored seq = seq | `dup` |
  | `exp < now − SKEW` with nothing stored | `expired` |
  | a new (t, k) beyond 64 topics per k or 50 000 records | `full` |
  | otherwise | `ok`: stored, and an event is appended to the log |

- **Retention:** live records are kept until `exp + SKEW`. Tombstones are kept until `now + LEASE + SKEW`, so older records can't be replayed.
- **Event log:** `{n, t, record}`, with `n` increasing; at most 10 000 entries or 30 min. The cursor is `"<epoch>:<n>"`, where `epoch` is random per process start.
- **`cx_twatch {t, c}`:**
  - if `c` is missing, from another epoch, newer than the head, or older than the log, the reply is `{snap: 1, r: live records for t, c: head}`
  - otherwise it returns the newest record per (t, k) among events after `c` for those topics
  - when there are none yet, it waits up to 25 s, and after the first matching event 2 s more (coalescing); the reply is `{r, c: head}`
- **Every topic reply carries `now`**, the storage peer's clock in ms.

### 10.4 Peers
- **Replicas:**
  - a provider sends its record to 4 + 1 storage peers (`st: 1`): the 4 with the smallest `ed_pub XOR topic id` among *established* ones (anchor-book score ≥ 75; fresh keys fill in only when fewer exist), plus 1 random other (anti-eclipse); up to 8 are tried when some fail
  - it also sends it to its connected neighbours for the topic over WebRTC (extra copies), and keeps it in its own store
  - it renews every 5 min ± 20 % jitter, batched per storage peer
  - `exp = now + skew + LEASE`, where `skew` = median of (storage `now` − local midpoint) over the last 8 replies; a `future`/`expired` status triggers one retry with the corrected skew
- **Searching and watching:**
  - searchers ask their own store, their topic neighbours (WebRTC), the 6 closest established storage peers and 2 random ones, and verify every record themselves
  - watchers run one `cx_twatch` per storage peer covering all their topics assigned to that node (its 5 closest)
- **Neighbour links:**
  - a topic member keeps at most 4 links per topic and 16 in total, opened with `p: "topic"` to `recent` providers (direct, or relayed via `via?` when direct fails)
  - a peer accepts a topic offer only if it is subscribed and below both limits, otherwise it answers `busy`
  - if both sides dial each other at once, the offer from the lower address wins; the other answers `busy`

### 10.5 Broadcast frame (binary, on a topic link's channel)
```
signed = bencode { t, id: 16 random bytes, ts: ms, from: ed_pub, body: ≤ 1024 bytes UTF-8 JSON }
frame  = bencode { t, id, ts, from, body, p: sender's provider record for t, hop: 1..4, sig }    ≤ 4096 bytes
sig    = Ed25519("cx-tb" ‖ signed)          hop is not signed
```
- **Origin:** sends to all its links for `t` with `hop = 4`.
- **Receivers drop:**
  - a wrong `t` for the link
  - a seen `id` (cache 10 min)
  - `now − ts > 120 s` or `ts − now > 60 s`
  - an oversized body or frame
  - a bad `sig`
  - a `p` that isn't a valid record for this `t` and `from`, or whose `exp < now − 60 s`
  - frames that exceed 10 per (`from`, `t`) per minute
- **Otherwise** a receiver delivers the message, and if `hop > 1`, forwards it with `hop − 1` to at most 3 random other links for `t`, never to the incoming link or to `from`.
- **Never stored** anywhere (not by storage peers, not by neighbours); only provider records are.
- **Best-effort only:** no history, acknowledgements, retries, ordering, late-join delivery or group encryption.

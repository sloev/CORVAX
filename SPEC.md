# CORVAX protocol `cx/1`

The complete wire protocol. It only grows: fields and queries never change meaning, and unknown ones are ignored.

`‖` = concatenation · `z32` = z-base32 (`ybndrfg8ejkmcpqxot1uwisza345h769`) · `b64` = base64url without padding · strings are UTF-8 · times are ms since the epoch unless stated otherwise.

## 1. Peers and anchors

There is one kind of peer. Every peer speaks the whole protocol and MAY store, serve, relay and broadcast.

An **anchor** is a peer with an independently reachable public endpoint (UDP and HTTP on one port number, verified by a stranger via `cx_check`) whose operator is expected to keep it online. That is an operational expectation, not a guarantee: the network depends on no single anchor.

Anchors have no authority. Everything they hold is signed by its owner and verified by its reader.

An **HTTPS-only anchor** (e.g. the Cloudflare Worker in `worker/`) serves everything that runs over HTTP: inboxes, topic storage, `cx_anchors`, the `/relay` WebSocket, and Beacons, which it mirrors to Mainline through a pkarr relay. It has no UDP, so no DHT routing, STUN or `cx_check`. Its line uses port 443 and `web=`.

## 2. Identity and records

```
seed      32 random bytes (the only secret)
ed key    HKDF-SHA256(seed, info "cx/ed25519")   →  address = z32(ed_pub)   (52 chars)
x key     HKDF-SHA256(seed, info "cx/x25519")
```

**Beacon:** a pkarr signed packet, i.e. a BEP 44 mutable item at `SHA1(ed_pub)`.
```
wire  sig 64 ‖ seq 8 (big-endian, µs) ‖ v       sig = Ed25519("3:seq" ‖ bencode(seq) ‖ "1:v" ‖ bencode(v))
v     DNS response (≤ 1000 B) of TXT records named "_cx", each "key=value":
      x=<b64 x_pub>   c=<anchor line of an inbox> (0–2)   v=2 (reads compressed bodies and batched candidates)
      other keys: application data
```

**Anchor line** (≤ 255 chars):
- Format: `corvax-anchor:<z32 ed_pub>@<ip | [ipv6] | dns name>:<port>[;web=<https origin>][;q=<0-100>]`.
- Readers find lines in any text with `corvax-anchor:[^\s"'<>\`]+` and strip trailing `.,;:!?)]}`.
- A line is only a claim until `cx_hi` succeeds. A `web=` whose host isn't public is dropped (except for LAN lines).

**Message** (≤ 16384 B, enough for a full WebRTC offer):
```
wire   eph_x 32 ‖ iv 12 ‖ AES-256-GCM(K, inner ‖ Ed25519(inner))
K      HKDF-SHA256(X25519(eph, x_pub of recipient), info "cx/msg" ‖ eph_x ‖ recipient x_pub)
inner  bencode { from: ed_pub, to: ed_pub, id: 16 B, ts, body: JSON }
       or, to a recipient whose Beacon has v ≥ 2 and when smaller: z: deflate-raw(JSON) instead of body (inflates to ≤ 64 KB)
```
Accept a message only if the signature is valid, `to` is you, `|now − ts| < 10 min`, and `id` is new.

## 3. Transports

Every transport carries bencoded KRPC (`{t, y:"q", q, a}` → `{t, y:"r", r}` | `{t, y:"e", e:[code, text]}`):

| Transport | Framing | Notes |
|---|---|---|
| UDP | one datagram | a datagram with first byte < 2 and the STUN cookie at bytes 4–7 is STUN (binding replies) |
| HTTP `POST /krpc` | one body, one reply | `Content-Type: text/plain` (no CORS preflight), ≤ 24 KB, refused before it is read in full. A repeated `t` from the same IP within 60 s gets the cached reply. `get`, `put` and `get_peers` are recursive (the peer does the DHT work; no token); `get` also carries `k` (the public key) so HTTPS-only anchors can ask a pkarr relay |
| WebRTC | text frame `"K" ‖ b64(bencode)` | on a connection's `cx` channel or a topic link: `cx_hi`, `cx_tpub`, `cx_tfind`. A topic link also carries `"M" ‖ JSON` app messages, attributed to the link's verified peer (mesh delivery, §10) |
| BLE, Wi-Fi Direct | §12 | local radio links between nearby devices (apps) |

Errors: 201 generic · 202 rate limited · 203 protocol · 204 unknown or disabled · 206 bad signature · 302 stale.

**`GET /`:** `text/plain` anchor lines (own line first), or, when `Accept` includes `text/html`, an HTML shell with `<script src="/cx/app.js">` followed by the same lines in `<pre id="anchors">`. `Vary: Accept`. `GET /cx/*.js` serves the library. Every response carries `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`.

**Local node:** apps look for a node on `http://127.0.0.1:4799` first (`cx_hi`, ≤ 800 ms) and use it as their first inbox, store and relay; native runtimes by default, browsers with `local: true`. The entry is LAN-only and never shared.

## 4. Queries

| Query | Request → reply | Notes |
|---|---|---|
| `ping`, `find_node`, `get_peers`, `announce_peer` | BEP 5 | anchors announce on `SHA1("corvax anchors v1")` |
| `get`, `put` | BEP 44 | Beacons |
| `cx_hi` | `{n ≤ 64 B}` → `{k, sig, line?, st?, rl?}` | `sig = Ed25519("cx-hi" ‖ n)`; `st: 1` = stores topic records; `rl: 1` = WebSocket relay at `/relay` |
| `cx_anchors` | `{me?}` → `{a}` | own line + best 32 + 8 random lines; `me` introduces the caller |
| `cx_check` | `{k, port, hport}` → `{udp, http, ip, by}` | asks a different anchor (`cx_probe`) to `cx_hi` the caller |
| `cx_probe` | `{ip, port, hport, k}` → `{udp, http}` | only for callers that are verified anchors |
| `cx_send` | `{to, msg}` → `{queued}` | inbox: 120 s, ≤ 64 messages and ≤ 1 MB per key, deduplicated by SHA-256 |
| `cx_listen` | `{k, ts, sig, after?}` → `{msgs: [{seq, msg}]}` | HTTP. With `v: 2`: `sig = Ed25519("cx-listen:" ‖ ts ‖ ":" ‖ after ‖ ":" ‖ z32 key of this anchor)`, so a poll can't be replayed at another anchor and its ack can't be forged (without `v`: the old `"cx-listen:" ‖ ts`, accepted for older clients). ±300 s. `seq` = max(previous + 1, unix ms), so it keeps rising across anchor restarts. Deletes `seq ≤ after`; waits `w` seconds when idle (≤ 55, default 25; clients ask for 50); a newer poll for `k` ends the older one |
| `cx_tpub` | `{r: [record ≤ 32]}` → `{ok: [status], now}` | §6 |
| `cx_tfind` | `{t: [id ≤ 16]}` → `{r, now}` | live records, ≤ 100 per topic, newest first |
| `cx_twatch` | `{t: [id ≤ 64], c?, w?}` → `{c, r, snap?, now}` | HTTP long poll (`w` as in `cx_listen`), §6 |

## 5. Anchor book

- **Per entry:** `verified` (a `cx_hi` with a random nonce succeeded), `storage` (`st`), EWMA α = 0.2 of probe success per service (`http`, `udp`), `rtt`, `first`, `lastOk`. A line whose `cx_hi` shows a different key is dropped.
- **Score:**
  - unverified: `min(hint, 50)`
  - verified: `round(100 · ok · (0.6 + 0.4 · √min(1, days_known / 7)))`, where `ok` = `http` for browsers and `max(udp, http)` for natives
- **Limits:** ≤ 1000 entries; drop when score < 10 and no success for 7 days.
- **Every 10 min, anchors:** probe 64 entries (≤ 16 unverified) and pull `cx_anchors` from 3 random anchors.
- **Peers:** keep 2 inbox anchors; every 30 min they pull `cx_anchors` from one and re-verify. Among anchors within 20 points of the best score, a peer takes the 2 XOR-closest to its own key, so peers spread over all good anchors. An inbox whose poll fails 3 times in a row is replaced and the Beacon republished. Bootstrap probes explicitly given anchors first, in rounds, until it has an inbox.
- **Bootstrap sources:**
  - cache, built-in list, explicit lines, any URL with anchor lines
  - TXT `_corvax-anchors.<domain>` (DoH JSON in browsers)
  - `cx_anchors`
  - natives only: Mainline `get_peers`, UDP `CX?` to `255.255.255.255` / `239.255.42.99` port 4798 (reply ≤ 1200 B of lines), mDNS TXT `_corvax._udp.local`
- **Reachability check:** native peers `cx_check` at start and every 30 min. Reachable over UDP and HTTP → anchor (listed, DHT server, `announce_peer`).

## 6. Topics

**Topic id:**
```
id     = SHA-256("cx/topic:" ‖ normalize(name))     normalize: NFKC, trim, collapse spaces, lowercase; 1–200 B
```

**Provider record:**
```
record = bencode { t: id, k: ed_pub, seq, exp, sig }    sig = Ed25519("cx-topic" ‖ bencode{ t, k, seq, exp })
```
- `seq` increases per (t, k); `exp ≤ now + 10 min` (a publisher may choose a shorter lease, ≥ 10 s).
- A tombstone has a higher `seq` and `exp ≤ now`. Publishers sign it together with each record, so withdrawing needs no async work: browsers send it on `pagehide` with `fetch(…, { keepalive: true })` to the storage peers that took the record.
- Presence is `recent` while `exp > now` (skew-corrected), otherwise `expired`.

**Storage** (any peer). `cx_tpub` statuses, checked in order:

| Status | When |
|---|---|
| `bad` | signature or sizes are wrong |
| `future` | `exp > now + 11 min` |
| `stale` | stored seq is higher |
| `dup` | same seq |
| `expired` | `exp < now − 60 s` and nothing is stored |
| `full` | a new (t, k) would exceed 64 topics per k or 50 000 records |
| `ok` | otherwise |

- **Retention:** live records are kept until `exp + 60 s`, tombstones for 11 min (so older records can't be replayed). Storage that restarts (e.g. the Worker) reloads both.
- **Event log:** each `ok` appends `{n, t, record}`; ≤ 10 000 entries and 30 min. The cursor is `"<epoch>:<n>"`, with the epoch random per start.
- **`cx_twatch`:**
  - a missing, foreign, future or trimmed cursor gets `{snap: 1, r: live records, c}`
  - otherwise it gets the newest record per (t, k) after `c`
  - when there are none, it waits ≤ 25 s, then 2 s more after the first match (coalescing)

**Placement:**
- **Publish:** 4 XOR-closest (`ed_pub ⊕ id`) *established* storage peers (score ≥ 75; fresh keys fill in only if fewer exist), plus 1 random other. Up to 8 are tried; also the publisher's own store and its topic neighbours.
- **Renew:** at half the shortest lease (default every 5 min) ± 20 %, batched per storage peer.
- **Clock skew:** `skew` = median of (peer `now` − local midpoint) over 8 replies; one retry after `future`/`expired`.
- **Search:** own store + neighbours + 6 closest established + 2 random. Readers verify every record.
- **Watch:** one `cx_twatch` per storage peer covering all of a reader's topics that map to it (each topic's 4 closest). A peer is skipped for 5 min after 3 failures.

## 7. Connections

Each connection is standard WebRTC with negotiated DataChannels id 0 (payload) and id 1 `cx` (control). Signalling uses messages (§2) sent to the inboxes in the callee's Beacon:

```
{cx:"offer", sid, sdp, p: "app"|"relay"|"topic", tp?}   {cx:"answer", sid, sdp}   {cx:"busy", sid}   {cx:"cand", sid, c, m, i}
```
To keep traffic through anchors low: candidates found within 150 ms ride inside the offer/answer SDP, and later ones go out in batches every 150 ms as `{cx:"cand", sid, cs: [[c, m, i] ≤ 32]}` when the other side has v ≥ 2 (an offer says `v: 2` itself). Beacons are cached for 10 min and re-read once when sending fails.
`sid` = b64(9 random bytes). `relay` and `topic` connections are not handed to the app. Direct attempts time out after 10 s.

**Through a third peer C** (fallback):
1. A → B: `{cx:"via?", sid, e: eph_a, via: [≤ 8 addresses], p, tp?}`.
2. B → A: `{cx:"via", sid, e: eph_b, c}` or `{cx:"via-no", sid}`. B picks C: one it is connected to, otherwise the first it can reach directly.
3. A and B each send C, on its `cx` channel, `{"cx":"bridge","sid","to"}`. C pairs requests with the same `sid` that name each other over two different connections, and answers `bridged` (or `bridge-no`); `unbridge` ends it.
   **Last resort:** when no peer path exists, C may be an anchor with `rl: 1`, reached over a WebSocket at `GET /relay`. The client first sends `{"cx":"hello","v":2,"k":b64(ed_pub),"ts","sig":b64(Ed25519("cx-relay:" ‖ ts ‖ ":" ‖ z32 key of this anchor))}` (±300 s; without `v` the old `"cx-relay:" ‖ ts`), then the same bridge messages and frames as on a `cx` channel.
4. Frames: `sid 9 ‖ ctr 8 ‖ AES-256-GCM(K_dir, iv 0⁴ ‖ ctr, type ‖ data)`, with `K_a2b`/`K_b2a` = HKDF(X25519(eph_a, eph_b), "cx/relay" ‖ sid ‖ "a2b"/"b2a"). Counters only increase. C only sees ciphertext.

**Topic links:**
- ≤ 4 per topic and ≤ 16 per peer, opened to `recent` providers with `p: "topic"`, only by peers that subscribe to broadcasts (presence-only readers open none).
- A peer accepts only if subscribed to broadcasts and below both limits, otherwise it answers `busy`.
- If both sides dial at once, the lower address wins.

**Broadcast frame** (binary, on a topic link):
```
frame = bencode { t, id: 16 B, ts, from, body ≤ 1024 B, p: sender's record for t, hop 1–4, sig }   ≤ 4096 B
sig   = Ed25519("cx-tb" ‖ bencode{ t, id, ts, from, body })        hop is not signed
```
- **Drop when:** `t` is not the link's topic, `id` was seen (cache 10 min), `now − ts > 2 min` or `ts − now > 60 s`, the sizes are wrong, `sig` is bad, `p` is not a live record (±60 s) for `t` and `from`, or the sender sent more than 10 frames per topic in the last minute.
- **Otherwise:** deliver, and if `hop > 1`, forward with `hop − 1` to ≤ 3 random other links of `t` (never back, never to `from`). The origin sends to all its links with hop 4.
- **Broadcasts are never stored.** No history, acknowledgements, ordering or late-join delivery.

## 8. Limits

| Area | Default |
|---|---|
| HTTP per IP | token bucket, burst 120, 4/s; costs: `put` 6, `cx_check` 12, `cx_tpub` 2, `cx_send`/`get`/`get_peers`/`cx_tfind` 1, others 0.5; ≤ 64 open long polls |
| DHT | K = 8, α = 3; ≤ 1000 routing entries; items 2 h; ≤ 200 peers per info_hash, 30 min; tokens SHA1(secret ‖ 10-min window ‖ ip), current or previous window |
| Beacons | republished every 30 min |
| Relaying | browsers ≤ 2 sessions at 256 kbit/s, natives ≤ 16 at 2 Mbit/s; bursts above 2× close the session; ≤ 1 GB per hour; idle 120 s; frames ≤ 16 KB. Worker anchor: ≤ 4 sessions at 256 kbit/s, ≤ 200 MB per hour, per IP ≤ 2 open relay sockets and ≤ 6 new per minute |

## 9. `RTCPeerConnection` contract

Any W3C-compatible object works. CORVAX uses only:
- `new RTCPeerConnection({ iceServers })`
- `createDataChannel(label, { negotiated: true, id })`
- `createOffer`, `createAnswer`, `setLocalDescription`, `setRemoteDescription`, `addIceCandidate`, `close`
- `localDescription`, `remoteDescription`, `onicecandidate`
- channels: `send`, `binaryType`, `readyState`, `onopen`, `onmessage`, `onclose`

## 10. Trystero over CORVAX

`@sloev/trystero-corvax` implements Trystero's topic strategy (`createTopicStrategy`) on CORVAX, peer to peer:

| Trystero | CORVAX |
|---|---|
| room (root topic `r`) | topic `"trystero:" ‖ r`: presence (lease, default 10 min) + broadcast links |
| announce `{peerId}` | broadcast over the room's links, and a message to each `recent` member; repeated to newcomers on sight |
| signal to peer topic `p` | to the address that sent from `p`: over its topic link when open (§3 `"M"`), else its inboxes |

Body of every message: `{ tr1: 1, t: topic, st: sender's own topic, m: Trystero payload }`. The receiver maps `st` → the sender's verified address (message signature or link), so replies need no lookup and cannot be redirected. Messages for a topic not yet subscribed are kept 10 s and replayed on subscribe. Trystero encrypts signals with the room key; CORVAX seals them again for the recipient. Once a room has links, re-signalling needs no anchor.

## 11. Host interface

A node's I/O comes from a host; everything else (`node.js`, `anchor.js`, `lan.js`, the library) is shared. `src/host-node.js` is the Node/Bun/Deno host; desktop and Android apps provide their own:

| Member | Contract |
|---|---|
| `udp({ port, address, reuse, group, broadcast }, onmessage(bytes, { address, port }))` | → `{ port, send(bytes, port, host), close() }` |
| `http({ port, address }, handle, onsocket(path, ws))` | serve HTTP: `handle(req)` → `res`; WebSocket upgrades arrive framed as `{ send, close, onmessage, onclose }`. → `{ close() }` |
| `asset(name)` | package files: `src/*.js`, `assets/logo/*` → bytes |
| `kv(dir?)` | → `{ get(name) → string \| null, set(name, value) }` (seed, anchor cache) |
| `dnsTxt(name)` | optional: TXT records (anchor discovery) |

`req = { method, path, headers (lower-case), ip, port, body(max) → bytes, signal }` (`signal` aborts when the client leaves; it ends long polls); `res = { status, headers, body }`.

## 12. Local radio links (apps)

Nearby devices extend the mesh without internet or an access point.

- **BLE:** service `c0a40001-0c0a-4c58-8000-00000000c0a4`; advertisement service data = first 8 bytes of the public key. Characteristic `…0002` (write without response) and `…0003` (notify) carry KRPC (§3) in chunks: `seq (1 B) ‖ flags (1 B: 1 = last) ‖ payload ≤ MTU − 5`; a message is ≤ 16 KB. Used for presence, messages and signalling; bulk data moves to Wi-Fi. Hosts present a BLE peer to the core as the UDP address `ble:<id>`, so the DHT and every query run over BLE unchanged.
- **Wi-Fi Direct:** DNS-SD service `_corvax._udp` with one TXT string, the node's anchor line for the group address. Group members then speak UDP, HTTP and WebRTC over the group network.
- Found peers enter the anchor book as LAN entries (never shared). Offline, nearby nodes answer `get` from the Beacons they hold.

## 13. Mesh services: every peer is a small anchor

What an anchor does over HTTP, every peer also does for the peers connected to it, as KRPC over WebRTC (§3). A network of connected peers therefore keeps working with no anchor at all.

| Query (over any connection's `cx` channel or a relayed topic link) | Every peer answers |
|---|---|
| `get {k}` / `put {k, seq, sig, v}` | Beacons it holds (≤ 512, newest `seq` wins, verified). On every new connection both sides `put` their own Beacon |
| `cx_anchors {}` | its shared anchor list; both sides ask on connect, so anchor lists spread peer to peer |
| `cx_send {to, msg}` | `to` is itself: delivered. `to` is connected to it: passed on once (≤ 100 per 10 s; never if `relayFor` is off). Otherwise error 204 |
| `cx_tpub`, `cx_tfind` | topic storage (§6); publishers store on every connected peer too, and searches ask them |

**Clients:**
- **`resolve`:** asks anchors and connected peers together; the newest valid Beacon wins.
- **Sending a message** (§2):
  1. over an open connection to the recipient
  2. else to an inbox anchor from its Beacon
  3. else through any connected peer that is connected to the recipient
- **`publish`** succeeds when an anchor or a connected peer takes the Beacon.

Signalling (§7) uses messages, so two peers that share only a mutual peer can connect through it, and stay connected when it leaves.

**By hand** (no anchor, no network service): two codes carried over any medium make a direct connection.
```
code = "cx1" ‖ b64(bencode { k: ed_pub, sid, sdp, to, sig })     sig = Ed25519("cx-hand" ‖ bencode{ k, sid, sdp, to })
```
The invitation has an offer SDP with all ICE candidates and empty `to`; the reply has the answer SDP, the same `sid`, and `to` = the inviter's key. About 1,000 characters each.

**Any medium:** a Beacon as text is `"cxb" ‖ b64(ed_pub ‖ Beacon wire)`; a sealed message (§2) as text is `"cxm" ‖ b64(wire)`.

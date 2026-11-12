# RENDEZVOUS — Signal Over Anything

> Fix signalling and peer discovery for good.
> One address per peer that lasts for years. One small signed record. Any transport that can carry **25–100 bytes**.

---

## 0. The core idea

Signalling looks hard because every project ties it to one transport (a WebSocket server, a tracker, a broker) and then has to manage that server.

Rendezvous makes the **message format** the fixed part and lets the **transport** be anything:

```
            ┌──────────────── one identity  (Ed25519 key  → address that lasts for years)
            │   ┌──────────── one record    (signed "Beacon", ≤ 1000 bytes, usually ~110–160)
            │   │   ┌──────── one envelope  (encrypted "Letter", ≤ 1000 bytes)
            ▼   ▼   ▼
   ╔═══════════════════════════════════════════════════════════════════════╗
   ║                         CARRIER INTERFACE                             ║
   ║   publish(beacon) · resolve(addr) · send(topic,letter) · listen(topic) ║
   ║                     · discover()   (for nearby peers)                 ║
   ╚═══════════════════════════════════════════════════════════════════════╝
     │      │       │      │      │      │      │     │     │     │     │
   Worker  Nostr  Torrent MQTT  Mainline DoH/  mDNS  UDP  BLE  QR  Audio  ICMP  Email ...
   (CF)   relays trackers      DHT     DNS         bcast            chirp
```

Signalling is really just **storing and forwarding small signed blobs, addressed by public key**. Anything that can carry ~25–100 bytes from A to B can be a carrier: a QR code, a DNS TXT record, a ping payload, a sound, a Bluetooth advert.

A client **races every carrier it can reach** ("happy eyeballs for signalling"). The first answer wins and duplicates are dropped by message ID. If one carrier goes down, another still works. If every server goes down, peers still find each other over the LAN, Bluetooth, sound or a QR code.

---

## 1. Identity and addresses (the part that lasts)

| Thing | What it is |
|---|---|
| **Secret** | 32-byte Ed25519 seed. Can be backed up as a 24-word phrase. |
| **Address** | `rv1` + z-base32(Ed25519 public key) → 55 characters, case-insensitive, safe in DNS labels, URLs and QR codes |
| **URI** | `rv1:<z32>` · `https://<your-domain>/@<z32>` · `<z32>.rv.<your-domain>` (DNS) |
| **Short code** | `7-guitar-nebula` style one-time pairing codes (PAKE/SPAKE2, like magic-wormhole). Good for reading aloud. |
| **Fingerprint** | 4-emoji or 6-word visual check, to confirm you have the right peer |

- The address **is** the public key. No registry, no account, no expiry. Give it to someone and it keeps working for years.
- **Key rotation:** a Beacon can include a signed `moved-to: rv1…` pointer. Clients follow it and update their address books.
- **Privacy (optional):** Tor-v3-style **key blinding**. Each epoch the published key is blinded, so carriers can't link announcements over time. Only people who already know the real address can derive the blinded key.

---

## 2. The Beacon (announce yourself)

**Design choice:** a Beacon is a **[pkarr](https://pkarr.org)-compatible signed DNS packet** (BEP44 mutable item). This means:

- It can be stored on the **Mainline BitTorrent DHT** (~10M nodes, free, has been running for ~20 years). This is the global, permissionless "phone book".
- It **is** DNS, so serving it over DNS/DoH needs no translation.
- It works with the existing pkarr relays and tools from day one.

Contents (as DNS records inside the signed packet):

```
_rv        TXT  "v=1"
_rv        TXT  "c=wss://rv.example.workers.dev"          ; carrier hints, in order of preference
_rv        TXT  "c=nostr:wss://relay.damus.io"
_rv        TXT  "c=tracker:wss://tracker.openwebtorrent.com"
_rv        TXT  "c=mqtt:wss://broker.emqx.io:8084/mqtt"
_rv        TXT  "c=udp4:203.0.113.7:4799"                  ; direct, if publicly reachable
_webrtc    TXT  "fp=sha-256:AB:CD:..."                      ; persistent DTLS certificate fingerprint
_webrtc    TXT  "ice=<16-byte seed>"                        ; ICE ufrag/pwd are derived from this seed
_rv        TXT  "n=Johannes' laptop"                        ; optional display name
@          A    203.0.113.7                                 ; optional
```

Signed with the Ed25519 key. Includes a `seq` (timestamp) and a TTL. Every carrier stores/forwards it **without having to trust anyone**: the signature proves who it came from, and the highest `seq` wins (last-writer-wins CRDT).

### 🔥 Trick #1: one-shot WebRTC (no offer/answer round trip)
Browsers let you create a **persistent `RTCCertificate`** (`RTCPeerConnection.generateCertificate`) and store it in IndexedDB. If the Beacon already contains the DTLS fingerprint and the ICE credential seed, **a caller can build the callee's remote SDP locally**. The only thing left to send is candidates, which fit in one encrypted Letter. Signalling drops from offer → answer → trickle to **a single one-way message**. A message that small fits in an audio chirp, a BLE advert or a ping.

✅ **Tested in Chromium** (`experiments/zero-sdp-webrtc.js`): the DataChannel opened and carried data with **no SDP exchanged at all** and only one ICE candidate sent one way. See §3b for how far this goes.

---

## 3. The Letter (signal a peer)

```
Letter = [ v:1 | topic:16 | eph_pk:32 | nonce:24 | ciphertext ]
topic  = BLAKE2b-128("rv-inbox" ‖ recipient_pk ‖ floor(unix/3600))   ; rotates every hour
inner  = { from: pk, ts, id, kind: offer|answer|cand|bye|app, body } signed by sender
crypto = X25519 (converted from Ed25519) + XChaCha20-Poly1305 (sealed box)
```

- Carriers only see an hourly-rotating topic and random-looking bytes.
- Replay protection: `ts` plus `id` dedup window.
- **SDP-lite:** a compact binary encoding of only what WebRTC actually needs (fingerprint, ufrag/pwd, candidates). A typical offer is about 120 bytes instead of about 3 KB.
- Large payloads are split into chunks, with **fountain codes** (LT/RaptorQ) for lossy channels (animated QR, audio, ICMP).

---

## 3b. Squeezing it down: the byte budget

Everything that both peers can **work out for themselves** is left off the wire.

**Shared key:** convert both Ed25519 identity keys to X25519 and do a static-static Diffie-Hellman. That gives a pairwise key `K_ab` that both sides can compute without sending anything. Everything else is derived from `K_ab` with HKDF:

| Derived from `K_ab` | Replaces (bytes saved) |
|---|---|
| ICE ufrag + pwd for both sides | 2 × ~26 B of credentials |
| DTLS role (lower public key = `active`) | `setup:` negotiation |
| Pairwise inbox topic `H(K_ab ‖ hour)` | 16 B recipient topic. Also better privacy: carriers can't even tell who the recipient is |
| 4-byte contact hint `H(K_ab ‖ epoch)[0..4]` | 32 B sender public key (for known contacts) |
| AEAD tag (proves the sender holds their key) | 64 B Ed25519 signature |
| Nonce = timestamp/counter | 24 B random nonce |

The SDP itself is rebuilt from a fixed template, so 0 bytes go on the wire for it.

### Letter sizes
| Case | Contents | Size |
|---|---|---|
| **Wake-up** (known contact; the callee's address is in its Beacon or both are on the same LAN) | ver 1 + hint 4 + counter 4 + tag 16 | **25 B** |
| + one public IPv4 candidate | + type 1 + IP 4 + port 2 | **32 B** |
| + one browser mDNS host candidate | + type 1 + UUID 16 + port 2 | **44 B** |
| **First contact** (stranger) | + sender public key 32 + ephemeral key 32 (for forward secrecy). The receiver gets the sender's fingerprint from the sender's Beacon | **~90 B** |
| First contact, fully self-contained (no Beacon lookup) | + DTLS fingerprint 32 | **~125 B** |
| Ultra-narrow channels (LoRa/APRS): 8-byte tag | | wake-up in **17 B** |

Why the wake-up can carry **zero candidates:** ICE learns *peer-reflexive* candidates from incoming connectivity checks. So it's enough for one side's address to be known; the other side is discovered when it connects.

What fits where: the 25 B wake-up fits in **one legacy BLE advert (31 B)**. The 44 B letter fits in a ~1–2 second audio chirp, a tiny QR code (version 3), a single LoRa frame or one SMS.

### Beacon size
| Field | Bytes |
|---|---|
| signature + seq (required by BEP44; the key is the DHT key, so it isn't in the value) | 64 + 8 |
| DTLS fingerprint (browsers check the full SHA-256, so it can't be shortened) | 32 |
| Carrier bitmask, numbered from the signed default-carrier list (custom URLs only when needed) | 2 |
| flags (LAN/BLE/relay-capable, PoW nonce length) | 1 |
| optional public endpoint (IPv4 / IPv6) | 0 / 6 / 18 |
| **Total (compact binary)** | **~107–125 B** |
| As a pkarr DNS packet (one binary TXT record, plus DNS header and name) | **~140–160 B** |

### What can't be shrunk
- **The address stays 32 bytes**, because it is the key. Shorter handles need either trust or a PAKE short code (§1).
- **The full 32-byte fingerprint** is required by browsers. After the first connection it is cached in the contact list.
- General-purpose compression does nothing on ciphertext. Savings only come from leaving fields out.
- **For text channels, pick the right alphabet:** QR alphanumeric mode with base45 instead of base64 in byte mode (~20% smaller QR codes), z-base32 for DNS labels, raw bytes for BLE, audio and LoRa.

### Risks
- **Editing the ICE ufrag/pwd in the SDP before applying it ("munging")** works in Chromium today (tested). Chrome has discussed restricting SDP munging, and Firefox and Safari are not tested yet. **Fallback:** send the real ufrag/pwd in the Letter (+26 B per side). The protocol should allow both modes from day one.
- **Static-static DH gives no forward secrecy for the wake-up itself.** It only carries "call me" plus at most a candidate, never data. The actual channel uses ephemeral DTLS keys, and a Noise handshake inside the DataChannel ties the identity keys to the DTLS fingerprints.

---

## 4. Carriers: every way to say "here I am"

Legend: 🌐 browser · 💻 native (desktop/server) · 📱 mobile app · ✈️ works offline

### Tier A: Online, web-first (ships first)
| Carrier | Where | How | Cost |
|---|---|---|---|
| **Cloudflare Worker "Lighthouse"** | 🌐💻📱 | HTTPS + WebSocket, Durable Objects (hibernation API) per topic shard | free tier / ~$5 per month |
| **Nostr relays** | 🌐💻📱 | ephemeral events (kind 2xxxx), tag = topic. Hundreds of public relays | $0 |
| **WebTorrent trackers** | 🌐💻 | info_hash = topic; offers carried in the announce message (same technique as Trystero) | $0 |
| **MQTT over WSS** | 🌐💻📱 | public brokers, topic = `rv/<topic hex>` | $0 |
| **pkarr relays → Mainline DHT** | 🌐💻📱 | HTTP PUT/GET of the signed packet | $0 |
| **DoH (DNS-over-HTTPS)** | 🌐💻📱 | the Worker *is* a DoH server: `dig +https @rv.example.com TXT <addr>.rv` | $0 |
| **Plain HTTP mailbox** | anything with `curl` | `POST /l/<topic>` / `GET /l/<topic>?wait=30` long-poll | $0 |
| **Static files** | 🌐 | Beacon at `/.well-known/rv/<addr>` on any static host (GitHub Pages, IPFS) | $0 |

### Tier B: LAN / nearby (native first, then bridged to browsers)
| Carrier | Where | How |
|---|---|---|
| **mDNS / DNS-SD** | 💻📱✈️ | `_rendezvous._udp.local`, TXT = beacon fragments plus a hash for fetching the full record |
| **UDP broadcast + multicast** | 💻📱✈️ | `255.255.255.255:4799`, `239.255.42.99:4799`, `ff02::1` |
| **Same-public-IP room** | 🌐 | The Worker groups peers by `CF-Connecting-IP`, so devices behind the same NAT find each other automatically (the PairDrop trick) |
| **Localhost bridge** | 🌐✈️ | The native daemon listens on `http://127.0.0.1:4799`, which browsers allow even from HTTPS pages. Browser tabs then get mDNS, broadcast, BLE and the DHT through it |
| **BLE advertisements** | 💻📱✈️ (🌐 can scan via Web Bluetooth) | 16-byte address hash in the advert, full Beacon over GATT |
| **Wi-Fi Aware / Multipeer** | 📱✈️ | native mobile only |

### Tier C: Offline, human-carried (also works in browsers!)
| Carrier | Where | How |
|---|---|---|
| **QR code** (static or animated with fountain codes) | 🌐📱✈️ | camera + `BarcodeDetector` / jsQR |
| **Audio chirp modem** | 🌐📱💻✈️ | WebAudio FSK/OFDM (ggwave-style). Uses trick #1, so ~100 bytes is enough to connect two phones in the same room with no internet |
| **NFC tap** | 🌐(Android Chrome)📱✈️ | Web NFC NDEF record `rv1:` |
| **Copy-paste / link** | everything | `https://x/#<base64url letter>`, so the hash fragment never reaches a server |
| **Printed paper / sticker** | ✈️ | QR code of your address on a business card. It keeps working because the address lasts |

### Tier D: The wild ones (experimental, "because we can")
| Carrier | How |
|---|---|
| **DNS, the real UDP/53 kind** | Delegate `rv.example.com NS` to native lighthouses. Lookups are `TXT <addr>.rv.example.com`. Writes are encoded in query labels (DNS-tunnel style) for networks that only allow DNS (hotel captive portals!) |
| **ICMP echo** | A lighthouse answers `ping -p <hex>` echo requests that carry a magic `RV1` prefix, and puts Beacon chunks in the echo reply. Works on networks that only let ping through |
| **Raw TCP line protocol** | `nc lighthouse 4799` → `RV1 GET <addr>` → beacon. Usable with telnet from 1985 |
| **Email** | Cloudflare **Email Workers**: `<topic>@rv.example.com` drops a Letter into the mailbox, replies come back by email. Store-and-forward signalling over SMTP |
| **SMS / Meshtastic / LoRa / APRS** | The Letter fits in 1–2 frames thanks to SDP-lite and trick #1 |
| **Sneakernet** | `rv export` writes a `.rvbundle` file that you carry on a USB stick |
| **Tor / I2P onion lighthouse** | for censorship resistance |

---

## 5. The global announce mesh

```
                        ┌──────────────────────────┐
                        │   Mainline DHT (~10M)    │  ← canonical, permissionless, free
                        │   via pkarr records      │
                        └────────────▲─────────────┘
                                     │ republish / bridge
     ┌───────────────┐   gossip   ┌──┴────────────┐   gossip   ┌───────────────┐
     │ CF Lighthouse │◄──────────►│ Native        │◄──────────►│ Someone else's│
     │ (your worker) │            │ lighthouses   │            │ lighthouse    │
     └──▲────────▲───┘            └──▲────────▲───┘            └───────▲───────┘
        │        │                   │        │                        │
   browsers   curl/IoT            LAN/mDNS   BLE                    browsers
        │                                                              │
        └──────── once connected, peers relay for each other ──────────┘
                 (WebRTC DataChannel gossip: "every tab is a lighthouse")
```

1. **Mainline DHT** is the root. Your Beacon lives there and anyone can resolve it. The owner republishes it about every hour while online. Lighthouses can **pin** (keep republishing) beacons for offline-but-reachable peers.
2. **Lighthouses** (Worker, native daemon, anyone's) gossip beacons using anti-entropy (Bloom-filter or IBLT set reconciliation). The records are self-certifying, so **no lighthouse has to trust another**. Running one is a single `wrangler deploy` or a single binary.
3. **Peers relay for each other.** After the first connection, every peer keeps a small DataChannel mesh and forwards Letters for its neighbours (with TTL and rate limits). The more people use it, the less it depends on servers. This is the WebTorrent-swarm effect, applied to signalling.
4. **Shared meeting points with no config.** Both sides derive the same topic from the address and check the same **baked-in default carrier set** (a few nostr relays, trackers, MQTT brokers and public lighthouses). The set is updated through a signed carrier list. Two strangers with nothing but an address will find each other.
5. **Spam resistance on open carriers:** a small proof-of-work stamp (Hashcash on the Beacon/Letter, difficulty set per carrier), per-IP rate limits on the Worker, and records are capped at 1000 bytes.

---

## 6. NAT traversal (the part after signalling)

Signalling is only useful if the connection actually works afterwards:

1. **Host candidates** (same LAN, using the `.local` mDNS names browsers use) → instant.
2. **STUN** (public Google/Cloudflare STUN servers) → handles most NATs.
3. **Simultaneous open / UDP hole punching** for native peers (Hyperswarm/Tailscale-style, with birthday-paradox port prediction for hard NATs).
4. **TURN fallback:** Cloudflare's TURN service (check its current free allowance), self-hosted coturn, or **volunteer peer relays** where a well-connected peer relays for others (libp2p circuit-relay style).
5. **Last resort:** relay data through the Worker's WebSocket (Durable Object pipe). Slow but always works, and costs only per message.

---

## 7. The Cloudflare Worker Lighthouse (the first thing to deploy)

One Worker, one Durable Object class, $0 to start:

| Route | Purpose |
|---|---|
| `GET  /.well-known/rv/<addr>` | resolve Beacon (cache → DO → pkarr relays) |
| `PUT  /.well-known/rv/<addr>` | publish Beacon (verify signature + seq + PoW, then forward to pkarr) |
| `GET/POST /dns-query` | **DoH server** answering `<addr>.rv.<domain>` TXT/A queries |
| `GET  /ws` | WebSocket: subscribe to topics, send Letters (hibernation API, so idle sockets cost almost nothing) |
| `POST /l/<topic>` / `GET /l/<topic>?wait=` | HTTP mailbox for curl, microcontrollers, shell scripts |
| `GET  /lan` | same-public-IP room (DO keyed by a hash of the IP + salt) |
| `GET  /@<addr>` | human landing page: "Connect to this peer" button + QR code |
| `email()` handler | Letters by email |
| `scheduled()` cron | republish pinned beacons to pkarr relays and gossip with peer lighthouses |

Storage: Durable Objects (SQLite-backed) for mailboxes with short TTLs (Letters expire after ~60 s, Beacons after ~2 h). No KV writes in the hot path, because they are slow and quota-limited.

---

## 8. Libraries: every language, web first

```
spec/                 ← THE product: one-page spec + test vectors (JSON). Should take a weekend to implement in any language.
packages/
  core-ts/            ← identity, Beacon, Letter, SDP-lite, fountain codes. Zero deps besides @noble/* crypto. Runs in browser/Node/Deno/Bun/Workers.
  carriers-ts/        ← one file per carrier (worker, nostr, tracker, mqtt, pkarr, doh, http, qr, audio, nfc, ble-scan, localhost-bridge)
  rendezvous-js/      ← the 1-liner API (below)
  lighthouse-worker/  ← Cloudflare Worker + Durable Object
  rvd/                ← native daemon (Rust): mDNS, broadcast, DHT, BLE, DNS/53, ICMP, TCP, localhost bridge, hole punching
  ffi/                ← Rust core → C ABI → Python, Go, Swift, Kotlin, C#, Ruby... plus WASM
  cli/                ← `rv id`, `rv publish`, `rv resolve`, `rv send`, `rv listen`, `rv qr`, `rv chirp`
```

The API we want:

```js
import { Rendezvous } from 'rendezvous'

const me = await Rendezvous.open()            // loads or creates the identity in IndexedDB; publishes on every reachable carrier
console.log(me.address)                       // rv1qx7… — share it, print it, tattoo it

me.on('connection', conn => conn.send('hi'))  // incoming WebRTC DataChannel / stream

const peer = await me.connect('rv1abc…')      // races every carrier, returns a connected channel
```

And from a shell with nothing installed:
```sh
curl https://rv.example.com/.well-known/rv/rv1abc…          # resolve
dig +https @rv.example.com TXT rv1abc….rv.example.com       # resolve via DNS
```

---

## 9. Roadmap

| Phase | Deliverable | "Done" means |
|---|---|---|
| **0. Spec** | `spec/`, test vectors, address format, Beacon/Letter, SDP-lite, zero-SDP mode + fallback, byte budget (§3b) | Two independent implementations agree on the vectors |
| **1. Web MVP** | `core-ts`, Worker lighthouse, `rendezvous-js` | A laptop browser behind home NAT and a phone browser on 4G connect using only an `rv1…` address |
| **2. No single point of failure** | nostr + tracker + MQTT + pkarr carriers, happy-eyeballs racing | Same test **with the Worker turned off** still connects |
| **3. Offline web** | QR (animated), audio chirp, Web NFC, trick #1 | Two phones in airplane-mode-plus-WiFi-hotspot connect by sound alone |
| **4. Native** | `rvd` + CLI: mDNS, broadcast, DHT, localhost bridge, hole punching | A browser on a LAN with no internet finds a peer through the local `rvd` |
| **5. Mesh** | lighthouse gossip, peer relaying, pinning, PoW | 3 lighthouses run by different people converge on each other's beacons |
| **6. Every language** | Rust core + FFI bindings, Python/Go/Swift/Kotlin packages | Python script ↔ browser ↔ iOS app, all using the same address |
| **7. Wild** | DNS/53, ICMP, email, LoRa/Meshtastic, Tor | A demo video that makes people laugh and then go "wait, that actually works" |

---

## 10. Limits we have to design around

- **Browsers cannot** send raw UDP, ICMP, mDNS or broadcasts, or listen on TCP. That is why the browser path is HTTP/WS/WebRTC + QR/audio/NFC, plus the optional **localhost bridge** to `rvd` for everything else.
- **Cloudflare Workers cannot** speak UDP, so the Worker reaches the DHT via pkarr HTTP relays and native lighthouses. It can do outbound TCP (`connect()`) and WebSockets.
- **Symmetric NAT on both sides** needs a relay (TURN, peer relay or Worker pipe). No signalling scheme can avoid that.
- **Public carriers** (nostr relays, trackers, brokers) are run by volunteers and can disappear, which is exactly why we race many of them and treat none as required.
- **Mainline DHT** records expire after about 2 hours, so they must be republished by the owner or by a pinning lighthouse.

## 11. Prior art to borrow from (and improve on)
pkarr (DHT records) · Trystero (signalling over public infrastructure) · PeerJS · libp2p (rendezvous, circuit relay, webrtc-direct) · Nostr · WebTorrent trackers · magic-wormhole (PAKE codes) · PairDrop/Snapdrop (same-IP rooms) · Hyperswarm (DHT + hole punching) · Tailscale DERP · Syncthing discovery · Briar (offline transports) · ggwave (audio modem) · Tor v3 (key blinding).

**What makes this different:** one self-certifying record format that works the same way across *every* medium, from the Mainline DHT to a sound in a room, with the browser as the main target and no required server at all.

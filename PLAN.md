# CORVAX: Plan v1.1

> Find any peer by its key or by a topic, from any runtime, and open an encrypted WebRTC DataChannel to it.
> The infrastructure introduces; the peers communicate.

The protocol is in [SPEC.md](SPEC.md) and usage in [README.md](README.md). This file holds scope, decisions and status.

## Scope

1. **Identity:** one seed gives an Ed25519 address and an X25519 key.
2. **Anchor book:** a verified, scored list of reachable peers, shared over every channel.
3. **Discovery by key:** signed Beacons in the DHT (pkarr-compatible).
4. **Signalling:** signed, sealed messages via inbox anchors, or over the mesh.
5. **Connection:** a WebRTC DataChannel, direct or through any third peer.
6. **Topic presence:** leased, signed provider records on storage peers.
7. **Topic broadcast:** short, signed, best-effort frames between topic neighbours.
8. **Trystero transport:** Trystero rooms signalled over CORVAX, peer to peer (SPEC §10).
9. **One codebase, many hosts:** the JS core everywhere; a host supplies sockets (SPEC §11). Apps on this device find the local node.
10. **Local radios (apps):** BLE and Wi-Fi Direct between nearby devices (SPEC §12).
11. **Mesh services:** every peer is a small anchor for the peers connected to it: Beacons, anchor lists, message passing, topic storage. Links can be made by hand, with no anchor at all (SPEC §13).

**One kind of peer.** An anchor is a peer that is publicly reachable and expected to stay online. Nothing else distinguishes it.

**Never in scope:**
- anything on top of a DataChannel
- rooms, history, durable or acknowledged messaging, group encryption
- gossip beyond bounded broadcast, multi-hop routing (a message is passed on once), reputation, incentives, telemetry, central services
- our own WebRTC stack, TURN, WebTransport, UPnP, DNS servers, ICMP; WebSocket except an anchor's `/relay`
- BEP 5 as a topic index; a second implementation of the protocol

## Decisions

| Decision | Why |
|---|---|
| Zero runtime dependencies, plain ESM, WebCrypto only | Runs unchanged everywhere; little to maintain |
| Mainline KRPC on UDP, HTTP and WebRTC | One protocol; joins a live DHT of millions of nodes |
| Separate X25519 key; sealed-sender signed messages | Standard crypto; sender attribution; no reflection |
| Full SDP offer/answer | Works across browsers and native WebRTC libraries |
| Relay through any peer by default; no TURN | Connects whenever any path exists, without relay servers |
| Anchors also relay over WebSocket (`/relay`), only as a last resort | Works where WebRTC can't (Workers); same bridge protocol, tight limits |
| HTTP POST + long polls | One client transport for every runtime |
| Any peer may store; placement 4 established-closest + 1 random | Uniform protocol; fresh keys can't eclipse a topic |
| Absolute `exp`, tombstones, skew from storage clocks | Replays can't revive a provider; bad clocks self-correct |
| Presence only `recent` / `expired` | A lease proves a recent publication, not that the peer is online |
| Broadcasts never stored | Durability is out of scope |
| `werift` as the default native WebRTC, injectable | Pure JS on Node, Bun and Deno |
| Messages ≤ 16 KB sealed | Fits any WebRTC offer, Trystero's included (its signals measure 150 B – 1 KB) |
| Trystero via its public `createTopicStrategy`, our own package | No fork, no relay; members by presence, signals mesh-first |
| One JS core + hosts, not a native rewrite | One protocol implementation; apps stay small (system webview + a thin native shell) |
| Apps live in `sloev/corvax-native` | The protocol repo stays small and runtime-free |
| Peers serve what anchors serve, over WebRTC | A connected network survives losing every anchor; all nodes have the same features |
| Inbox anchors by XOR distance among the good ones; dead inboxes replaced | Load spreads over all anchors instead of the top two; peers stay reachable |
| Light on anchors: 50 s polls, deflated message bodies, candidates in the SDP or batched, Beacons cached 10 min, refresh every 30 min | One connection costs 2 messages (~1.6 KB) instead of 4+ (~3 KB); idle traffic halves. Negotiated by `v=2` in the Beacon, so older peers keep working |
| Inbox polls and relay hellos name the anchor (v 2) | A poll or hello can't be replayed elsewhere, an ack can't be forged |

## One-shot plan v1.1

| # | Where | Work | Status |
|---|---|---|---|
| 1 | here | Messages ≤ 16 KB (library, native and Worker anchors, SPEC) | ✅ |
| 2 | here | `@sloev/trystero-corvax`: presence for members, announce over mesh + to members, signals over mesh links else inboxes; early-message buffer | ✅ |
| 3 | here | Tests: stock Trystero rooms (Node + werift; Chromium), join time, recovery with no anchor left | ✅ joined in 0.3 s (Chromium); re-signals over the mesh with the anchor gone |
| 4 | here | Host interface: `anchor.js` / `node.js` / `lan.js` free of Node APIs; `host-node.js` | ✅ |
| 5 | here | Local node: apps find `127.0.0.1:4799` (native by default, browsers `local: true`), never shared; loopback allowed on https pages | ✅ |
| 6 | here | SPEC §10–12, README, DOX, release job publishes the transport; `dist/corvax-node.min.js` (70 KB) for app hosts | ✅ (the transport's first npm version is published by hand) |
| 7 | corvax-native | Desktop app (Tauri v2): the core in a hidden webview, Rust host (UDP, HTTP long polls, WebSocket, kv, DNS), tray, autostart, App Nap off; ≤ 8 MB | ✅ built on Linux: **4.6 MB**; run headless, it serves the node and other CORVAX apps use it as their local node. macOS/Windows not yet built |
| 8 | corvax-native | Android app: foreground service (`connectedDevice`) with a headless WebView, Kotlin host, BLE (KRPC as `ble:<id>`) + Wi-Fi Direct; APK ≤ 6 MB; GitHub + F-Droid | sketched (not built: no Android SDK here) |
| 9 | upstream | Trystero issue with design and numbers, then a PR as the maintainer prefers | after 2 releases of the transport |

## Status

- [x] **Node:** 58 tests (unit, integration, adversarial, WebRTC with `werift` and `node-datachannel`, Chromium, the homepage app, Trystero, mesh)
- [x] **No anchors at all** (`test/mesh.test.js`): peers linked by hand exchange messages, Beacons and topic records; two peers that share only a mutual peer find each other by topic, connect through it and stay connected when it leaves; also between two Chromium tabs with the only anchor shut down
- [x] **Bun 1.4 and Deno 2.9:** smoke test (anchors, messages, direct and relayed channels, topics)
- [x] **Live:** our Beacon round-trips through `relay.pkarr.org`; DNS TXT via DoH
- [x] **Homepage app:** DOX (overview + JS API reference) / APP / STATS; DOX first, then the last view remembered. APP: identity, peers with honest presence, messages and live chat, topics, follows, live-only updates, optional local node. Driven end to end in Chromium (`test/app.test.js`); no sideways scroll at 320–420 px
- [x] **Releases:** every green push to `main` is `v0.1.<run>`: minified ESM bundle (~50 KB, 18 KB gzipped) published to npm as `@sloev/corvax` (and `@sloev/trystero-corvax`), GitHub release with bundle and tarball, `latest` tag moved, 10 newest kept. One way to load it everywhere: `cdn.jsdelivr.net/npm/@sloev/corvax@0.1/dist/corvax.min.js` in browsers, `npm i @sloev/corvax` elsewhere
- [x] **Helpers:** `presence(onCount)` (a live visitor counter in one call) and `room(name, onMessage)` (topic chat), in `src/kit.js`
- [x] **Live presence counter:** the homepage counts its viewers on topic `corvax-worker-home`: per-tab key, 2-min lease, pre-signed withdrawal sent on hide/close, live via one watch poll, no Beacon, inbox or WebRTC links
- [x] **Community anchors:** "Add an anchor" issue form → live `cx_hi` check commented on the issue → a maintainer's `accepted` label appends it to `anchors.txt`; each release bakes the lines that answer into `src/anchors.js`
- [x] **Public anchor** `https://corvax.sloev.workers.dev` (Cloudflare Worker, `worker/`): `test/worker-check.js` passes live; topic records persist in SQLite across evictions; zero-config peers bootstrap from it; its Beacons reach Mainline via the pkarr relay
- [ ] Firefox and WebKit (CI, run by hand), real Safari
- [ ] Two browsers on two real networks
- [ ] A live run on the Mainline DHT (needs outbound UDP)
- [ ] Apps ([corvax-native](https://github.com/sloev/corvax-native)): desktop on macOS and Windows; Android build, 24 h background test, offline mesh between two phones

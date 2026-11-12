# CORVAX: Plan v1.0

> Find any peer by its key or by a topic, from any runtime, and open an encrypted WebRTC DataChannel to it.
> The infrastructure introduces; the peers communicate.

The protocol is in [SPEC.md](SPEC.md) and usage in [README.md](README.md). This file holds scope, decisions and status.

## Scope

1. **Identity:** one seed gives an Ed25519 address and an X25519 key.
2. **Anchor book:** a verified, scored list of reachable peers, shared over every channel.
3. **Discovery by key:** signed Beacons in the DHT (pkarr-compatible).
4. **Signalling:** signed, sealed messages via inbox anchors.
5. **Connection:** a WebRTC DataChannel, direct or through any third peer.
6. **Topic presence:** leased, signed provider records on storage peers.
7. **Topic broadcast:** short, signed, best-effort frames between topic neighbours.

**One kind of peer.** An anchor is a peer that is publicly reachable and expected to stay online. Nothing else distinguishes it.

**Never in scope:**
- anything on top of a DataChannel
- rooms, history, durable or acknowledged messaging, group encryption
- gossip beyond bounded broadcast, introductions, reputation, incentives, telemetry, central services
- our own WebRTC stack, TURN, WebTransport, UPnP, DNS servers, ICMP; WebSocket except an anchor's `/relay`
- BEP 5 as a topic index

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

## Status

- [x] **Node:** 46 tests (unit, integration, adversarial, WebRTC with `werift` and `node-datachannel`, Chromium, the homepage app)
- [x] **Bun 1.4 and Deno 2.9:** smoke test (anchors, messages, direct and relayed channels, topics)
- [x] **Live:** our Beacon round-trips through `relay.pkarr.org`; DNS TXT via DoH
- [x] **Homepage app:** DOX (overview + JS API reference) / APP / STATS; DOX first, then the last view remembered; CORVAX wordmark in the header. APP: identity, peers with honest presence, messages and live chat, topics, follows, live-only updates. Driven end to end in Chromium (`test/app.test.js`); no sideways scroll at 320–420 px
- [x] **Releases:** every green push to `main` is `v0.1.<run>`: minified ESM bundle (~50 KB, 18 KB gzipped) published to npm as `@sloev/corvax`, GitHub release with bundle and tarball, `latest` tag moved, 10 newest kept. One way to load it everywhere: `cdn.jsdelivr.net/npm/@sloev/corvax@0.1/dist/corvax.min.js` in browsers, `npm i corvax` elsewhere
- [x] **Live presence counter:** the homepage counts its viewers on topic `corvax-worker-home`: per-tab key (a reload is the same visitor), 2-min lease, pre-signed withdrawal sent on hide/close, live via one watch poll, no Beacon, inbox or WebRTC links
- [x] **Public anchor** `https://corvax.sloev.workers.dev` (Cloudflare Worker, `worker/`): `test/worker-check.js` passes live; topic records persist in SQLite across evictions; zero-config peers bootstrap from it; its Beacons reach Mainline via the pkarr relay
- [ ] Firefox and WebKit (CI, run by hand), real Safari
- [ ] Two browsers on two real networks
- [ ] A live run on the Mainline DHT (needs outbound UDP)

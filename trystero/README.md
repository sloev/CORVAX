# @sloev/trystero-corvax

[Trystero](https://github.com/dmotz/trystero) signalling over [CORVAX](https://github.com/sloev/CORVAX): no relay server, nothing to configure.

```sh
npm i @trystero-p2p/core @sloev/trystero-corvax
```

```js
import { joinRoom } from '@sloev/trystero-corvax'

const room = joinRoom({ appId: 'my-app' }, 'lobby')
room.onPeerJoin(({ peerId }) => console.log('joined', peerId))
```

Browsers without a bundler: `import { joinRoom } from 'https://cdn.jsdelivr.net/npm/@sloev/trystero-corvax/+esm'`.

**How it signals** (peer to peer):

- **Members:** CORVAX topic presence on the room's topic: signed leases kept by many storage peers, not one server.
- **Announce:** flooded over the room's CORVAX mesh, and sealed straight to each member through that member's own inbox anchors.
- **Offers, answers, candidates:** over a CORVAX mesh link to that peer when there is one (no anchor at all), otherwise to its inboxes. Senders are verified by signature.
- **Once a room's mesh exists, it no longer needs any anchor:** reconnects re-signal over the mesh.

Trystero encrypts its signals with the room key, and CORVAX seals them again for the one recipient. Joining took 0.3 s between two Chromium tabs in our tests.

Options: `joinRoom({ appId, corvax: { peer, ...Peer.create options } }, roomId)`. Pass `corvax.peer` to share an existing CORVAX peer.

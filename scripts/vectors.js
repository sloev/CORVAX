#!/usr/bin/env node
// Test vectors (test/vectors.json) from this implementation: every other implementation (corvax-native's Rust port)
// must reproduce or accept them byte for byte. Deterministic except sealed messages, which a port must open.
//   node scripts/vectors.js > test/vectors.json
import { identity, sign, hkdf } from '../src/crypto.js'
import { encode } from '../src/bencode.js'
import { hex, unhex, utf8, z32, concat } from '../src/bytes.js'
import { seal } from '../src/message.js'
import { makeBeacon, pack, signable } from '../src/record.js'
import { parseLine, formatLine } from '../src/book.js'

const seeds = ['00'.repeat(32), '01'.repeat(32), hex(Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3))]
const ids = await Promise.all(seeds.map(s => identity(unhex(s))))
const out = { version: 1 }

out.z32 = [[], [0], [255, 1, 2, 3, 4], [...ids[0].pub]].map(b => ({ bytes: hex(Uint8Array.from(b)), z32: z32(Uint8Array.from(b)) }))
out.bencode = [
  { value: { a: 1, b: 'hi', c: [1, -2, 'x'], aa: { z: 0 } }, hex: hex(encode({ a: 1, b: utf8('hi'), c: [1, -2, utf8('x')], aa: { z: 0 } })) }
]
out.hkdf = [{ ikm: seeds[2], info: 'cx/ed25519', okm: hex(await hkdf(unhex(seeds[2]), 'cx/ed25519')) }]
out.identity = ids.map((id, i) => ({ seed: seeds[i], ed_pub: hex(id.pub), x_pub: hex(id.xpub), address: z32(id.pub) }))
out.sign = [{ seed: seeds[1], msg: hex(utf8('cx-hi') ), sig: hex(await sign(ids[1], utf8('cx-hi'))) },
  { seed: seeds[2], msg: hex(concat(utf8('cx-listen:'), utf8('1700000000000:0:abc'))), sig: hex(await sign(ids[2], utf8('cx-listen:1700000000000:0:abc'))) }]

const now = Date.now()
const sdp = { cx: 'offer', sid: 'AAAAAAAAAAAA', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' + 'a=candidate:1 1 udp 2113937151 192.168.1.20 54400 typ host\r\n'.repeat(5), p: 'app', v: 2 }
out.seal = [
  { note: 'plain body', from_seed: seeds[1], to_seed: seeds[2], body: { app: 'hello' }, wire: hex(await seal(ids[1], ids[2].pub, ids[2].xpub, { app: 'hello' })), ts_after: now - 1000 },
  { note: 'deflated body (z)', from_seed: seeds[1], to_seed: seeds[2], body: sdp, wire: hex(await seal(ids[1], ids[2].pub, ids[2].xpub, sdp, true)), ts_after: now - 1000 },
  { note: 'kept (exp)', from_seed: seeds[2], to_seed: seeds[1], body: { app: 'later' }, wire: hex(await seal(ids[2], ids[1].pub, ids[1].xpub, { app: 'later' }, false, now + 86400e3)), exp: now + 86400e3 }
]
out.seal_valid_until = now + 500e3

const line = 'corvax-anchor:' + z32(ids[0].pub) + '@corvax.example.org:443;web=https://corvax.example.org'
const b = await makeBeacon(ids[1], { n: 'esp32', c: [line], v: 2 }, 1700000000000000)
out.beacon = [{ seed: seeds[1], fields: [['n', 'esp32'], ['c', line], ['v', '2'], ['x', 'b64url(x_pub)']], seq: 1700000000000000,
  v: hex(b.v), sig: hex(b.sig), signable: hex(signable(b.seq, b.v)), packed: hex(pack(b)) }]
out.anchor_line = [line, 'corvax-anchor:' + z32(ids[2].pub) + '@8.8.8.8:4799;q=93'].map(l => ({ line: l, parsed: parseLine(l), formatted: formatLine(parseLine(l)) }))
console.log(JSON.stringify(out, null, 1))

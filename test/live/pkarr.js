// Manual check (needs internet): our Beacon round-trips through the public pkarr relay,
// which validates it and stores it on the real Mainline DHT.   node test/live/pkarr.js
import { identity } from '../../src/crypto.js'
import { makeBeacon, pack, unpack, verifyBeacon, fields } from '../../src/record.js'
import { z32, equal } from '../../src/bytes.js'

const relay = process.argv[2] || 'https://relay.pkarr.org'
const id = await identity()
const rec = await makeBeacon(id, { c: ['corvax-anchor:test@203.0.113.1:4799'], n: 'corvax live check' })
const url = `${relay}/${z32(id.pub)}`
const put = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/pkarr.org/relays#payload' }, body: pack(rec) })
console.log('PUT', put.status, put.status < 300 ? 'accepted' : await put.text())
const res = await fetch(url)
const back = unpack(id.pub, new Uint8Array(await res.arrayBuffer()))
const ok = res.ok && equal(back.v, rec.v) && back.seq === rec.seq && await verifyBeacon(back)
console.log('GET', res.status, ok ? 'identical and valid' : 'MISMATCH', fields(back).n)
process.exit(ok ? 0 : 1)

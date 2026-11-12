import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { DHT } from '../src/dht.js'
import { identity, sha1 } from '../src/crypto.js'
import { makeBeacon } from '../src/record.js'
import { utf8, equal } from '../src/bytes.js'

async function network (n) {
  const nodes = []
  for (let i = 0; i < n; i++) {
    const sock = createSocket('udp4')
    const dht = new DHT({ send: (b, to) => sock.send(b, to.port, to.host), timeout: 500 })
    sock.on('message', (b, r) => dht.receive(new Uint8Array(b), { host: r.address, port: r.port }))
    await new Promise(resolve => sock.bind(0, '127.0.0.1', resolve))
    nodes.push({ dht, sock, addr: { host: '127.0.0.1', port: sock.address().port } })
  }
  for (const [i, x] of nodes.entries()) if (i) await x.dht.bootstrap([nodes[i - 1].addr, nodes[0].addr])
  for (const x of nodes) await x.dht.lookup(x.dht.id)
  return { nodes, close: () => nodes.forEach(x => { x.dht.close(); x.sock.close() }) }
}

test('20 nodes: put on one, get from another; stale seq and bad signature rejected; peers announce', async () => {
  const net = await network(20)
  try {
    const { nodes } = net, id = await identity()
    const rec = await makeBeacon(id, { n: 'v1' }, 1000)
    assert.ok(await nodes[3].dht.put({ k: rec.pub, seq: rec.seq, sig: rec.sig, v: rec.v }) >= 3)
    const got = await nodes[17].dht.get(await sha1(id.pub))
    assert.ok(got && equal(got.v, rec.v))

    const newer = await makeBeacon(id, { n: 'v2' }, 2000)
    await nodes[9].dht.put({ k: newer.pub, seq: newer.seq, sig: newer.sig, v: newer.v })
    assert.equal((await nodes[0].dht.get(await sha1(id.pub))).seq, 2000)
    await assert.rejects(nodes[9].dht.put({ k: rec.pub, seq: rec.seq, sig: rec.sig, v: rec.v }))     // stale seq refused locally
    const forged = { k: newer.pub, seq: 3000, sig: newer.sig, v: newer.v }
    await assert.rejects(nodes[5].dht.put(forged))                                                     // bad signature
    assert.equal((await nodes[12].dht.get(await sha1(id.pub))).seq, 2000)

    const topic = await sha1(utf8('corvax anchors v1'))
    assert.ok(await nodes[2].dht.announce(topic, 4799) >= 3)
    const peers = await nodes[19].dht.getPeers(topic)
    assert.ok(peers.some(p => p.port === 4799))
  } finally { net.close() }
})

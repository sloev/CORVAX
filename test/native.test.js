import test from 'node:test'
import assert from 'node:assert/strict'
import { node, until } from './helpers.js'
import { Peer } from '../src/peer.js'

const libs = {
  werift: async () => undefined,                                     // undefined = the default loader (werift)
  'node-datachannel': async () => (await import('node-datachannel/polyfill')).RTCPeerConnection
}

for (const [name, load] of Object.entries(libs)) {
  test(`Node ↔ Node direct DataChannel with ${name}`, async t => {
    const a = await node({ anchor: 'force', relayFor: false })
    const RTC = await load()
    const A = await Peer.create({ anchors: [a.line()], allowPrivate: true, RTCPeerConnection: RTC })
    const B = await Peer.create({ anchors: [a.line()], allowPrivate: true, RTCPeerConnection: RTC })
    t.after(async () => { A.close(); B.close(); await a.close() })
    await B.publish(); await A.publish()
    const incoming = new Promise(resolve => B.accept(resolve))
    const { channel, kind } = await A.connect(B.address)
    assert.equal(kind, 'direct')
    const { from, channel: bch } = await incoming
    assert.equal(from, A.address)
    const got = []
    bch.onmessage = e => { got.push(String(e.data)); bch.send('pong:' + e.data) }
    const back = []
    channel.onmessage = e => back.push(String(e.data))
    channel.send('ping')
    await until(() => back.length === 1)
    assert.deepEqual(got, ['ping']); assert.deepEqual(back, ['pong:ping'])

    // the same KRPC queries over the WebRTC control channel: B (not reachable over HTTP) serves storage
    const { random, concat, utf8, equal } = await import('../src/bytes.js'), { verify } = await import('../src/crypto.js')
    const { makeRecord, topicId } = await import('../src/topic.js')
    const ctl = A.conns.get(B.address).ctl, n = random(16)
    const hi = await A.chanRpc(ctl, 'cx_hi', { n })
    assert.ok(equal(hi.k, B.id.pub) && await verify(hi.k, hi.sig, concat(utf8('cx-hi'), n)) && hi.st === 1)
    const tid = await topicId('over-webrtc'), rec = await makeRecord(A.id, tid, 1, Date.now() + 600e3)
    const put = await A.chanRpc(ctl, 'cx_tpub', { r: [rec] })
    assert.equal(new TextDecoder().decode(put.ok[0]), 'ok')
    assert.ok(equal((await A.chanRpc(ctl, 'cx_tfind', { t: [tid] })).r[0], rec))
    await assert.rejects(A.chanRpc(ctl, 'nope', {}), e => e.code === 'remote')
  })
}

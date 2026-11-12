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
  })
}

// Runs under Node, Bun and Deno: anchors, messaging, a direct and a relayed DataChannel (werift).
//   bun test/runtime-smoke.js      deno run -A test/runtime-smoke.js      node test/runtime-smoke.js
import { anchors, until } from './helpers.js'
import { Peer } from '../src/peer.js'

const runtime = globalThis.Bun ? `bun ${Bun.version}` : globalThis.Deno ? `deno ${Deno.version.deno}` : `node ${process.version}`
const step = (s) => console.log(`✓ ${s}`)
const [a1, a2] = await anchors(2)
const A = await Peer.create({ anchors: [a1.line()], allowPrivate: true, relayFor: false })
const B = await Peer.create({ anchors: [a2.line()], allowPrivate: true, relayFor: false })
try {
  if (!a2.isAnchor) throw new Error('second anchor did not promote itself')
  step('anchors promote')
  await A.publish(); await B.publish()
  const got = []
  A.on(m => got.push(m.body))
  await B.send(A.address, 'hello')
  await until(() => got.length === 1)
  step('publish, resolve, message')

  const incoming = new Promise(resolve => B.accept(resolve))
  const d = await A.connect(B.address)
  const { channel: bd } = await incoming
  const echo = ch => { ch.onmessage = e => ch.send('pong:' + e.data) }
  echo(bd)
  const roundtrip = ch => new Promise(resolve => { ch.onmessage = e => resolve(String(e.data)); ch.send('ping') })
  if (d.kind !== 'direct' || await roundtrip(d.channel) !== 'pong:ping') throw new Error('direct failed')
  step('direct DataChannel')

  A.blockDirect.add(B.address); B.blockDirect.add(A.address)
  const incoming2 = new Promise(resolve => B.accept(resolve))
  const r = await A.connect(B.address)
  echo((await incoming2).channel)
  if (r.kind !== 'peer' || await roundtrip(r.channel) !== 'pong:ping') throw new Error('relay failed')
  step('relayed through a third peer')

  A.blockDirect.clear(); B.blockDirect.clear()
  const heard = []
  const ta = await A.topic('smoke'), tb = await B.topic('smoke')
  tb.subscribe({ message: m => heard.push(m.body) })
  ta.subscribe({})
  await tb.publish()
  if ((await ta.publish()).stored < 1) throw new Error('topic not stored')
  if (!(await ta.search()).some(f => f.address === B.address)) throw new Error('topic search failed')
  step('topic publish + search')
  await until(() => A.topics.links.size > 0 && B.topics.links.size > 0, 20000)
  await ta.broadcast('hello topic')
  await until(() => heard.length === 1)
  step('topic broadcast')
  console.log(`runtime smoke test passed on ${runtime}`)
} catch (e) {
  console.error(`FAILED on ${runtime}:`, e.message)
  process.exitCode = 1
} finally {
  await A.close(); await B.close(); await a1.close(); await a2.close()
  setTimeout(() => process.exit(), 100)
}

// Manual check of a Worker anchor (local `wrangler dev` or deployed):  node test/worker-check.js [origin]
import { Peer } from '../src/peer.js'

const origin = process.argv[2] || 'http://127.0.0.1:8787'
const step = s => console.log('✓', s)
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (!await fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)) } }
const line = (await (await fetch(origin)).text()).split('\n')[0]
const opts = { anchors: [line], allowPrivate: true, platform: { loadCache: () => '', saveCache: () => {} } }
const A = await Peer.create(opts), B = await Peer.create(opts)
try {
  if (!A.inboxes.length || !A.book.get(line.slice(14, 66))?.storage) throw new Error('anchor not verified as storage')
  step(`bootstrapped from ${line.slice(0, 40)}…`)
  await A.publish(); await B.publish()
  if (!(await B.resolve(A.address))?.x) throw new Error('resolve failed')
  step('Beacon publish + resolve')
  const got = []
  A.on(m => got.push(m.body))
  await B.send(A.address, 'hi via worker')
  await until(() => got.length === 1)
  step('message through the worker inbox')
  const incoming = new Promise(resolve => B.accept(resolve))
  const { channel } = await A.connect(B.address)
  await incoming
  step('WebRTC connection signalled through the worker')
  channel.close?.()
  const ta = await A.topic('worker-topic'), tb = await B.topic('worker-topic')
  const seen = []
  ta.subscribe({ presence: e => seen.push(e.presence) })
  const { stored } = await tb.publish()
  if (!(await ta.search()).some(f => f.address === B.address)) throw new Error('topic search failed')
  step(`topic stored on ${stored} storage peer(s), found by search`)
  await until(() => seen.includes('recent'))
  await tb.unpublish()
  await until(() => seen.includes('expired'))
  step('watch: recent → expired')
  console.log('worker anchor OK')
} catch (e) { console.error('FAILED:', e.message); process.exitCode = 1 } finally { await A.close(); await B.close(); setTimeout(() => process.exit(), 100) }

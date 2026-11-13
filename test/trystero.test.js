// Trystero over CORVAX: stock Trystero rooms, signalled peer to peer through CORVAX (trystero/index.js).
// Trystero allows one copy of a room per JS context, so the second member runs in a worker thread.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { anchors, until } from './helpers.js'

// trystero/ is its own package and imports '@sloev/corvax': link this repo in as that package, as an install would.
const { mkdir, symlink } = await import('node:fs/promises')
const pkg = new URL('../node_modules/@sloev/', import.meta.url)
await mkdir(pkg, { recursive: true }).then(() => symlink(new URL('..', import.meta.url), new URL('corvax', pkg), 'dir')).catch(() => {})

let joinRoom, RTCPeerConnection
try { ({ joinRoom } = await import('../trystero/index.js')); ({ RTCPeerConnection } = await import('werift')) } catch {}

const member = `
  import { workerData, parentPort } from 'node:worker_threads'
  const { joinRoom } = await import(workerData.transport)
  const { RTCPeerConnection } = await import('werift')
  const room = joinRoom({ appId: 'corvax-test', corvax: workerData.corvax, rtcPolyfill: RTCPeerConnection, rtcConfig: { iceServers: [] } }, 'lobby')
  const chat = room.makeAction('chat')
  chat.onMessage(data => chat.send('echo: ' + data))
  parentPort.on('message', async m => { if (m === 'leave') { await room.leave(); parentPort.postMessage('left') } })
`

test('trystero: two members find each other via CORVAX and talk over a Trystero connection', { skip: !joinRoom && '@trystero-p2p/core or werift not installed' }, async t => {
  const nodes = await anchors(3)
  const corvax = { anchors: nodes.map(n => n.line()), allowPrivate: true, fallback: [] }
  const w = new Worker(member, { eval: true, type: 'module', workerData: { transport: new URL('../trystero/index.js', import.meta.url).href, corvax } })
  const room = joinRoom({ appId: 'corvax-test', corvax, rtcPolyfill: RTCPeerConnection, rtcConfig: { iceServers: [] } }, 'lobby')
  t.after(async () => {
    w.postMessage('leave'); await new Promise(resolve => { w.once('message', resolve); setTimeout(resolve, 5000) }); await w.terminate()
    await room.leave(); for (const n of nodes) await n.close()
  })
  const t0 = Date.now(), joined = []
  room.onPeerJoin(({ peerId }) => joined.push(peerId))
  await until(() => joined.length, 30000)
  process.stderr.write(`# joined in ${((Date.now() - t0) / 1000).toFixed(1)} s (werift)\n`)
  const chat = room.makeAction('chat'), got = []
  chat.onMessage(data => got.push(data))
  await chat.send('hello over corvax')
  await until(() => got.length, 10000)
  assert.deepEqual(got, ['echo: hello over corvax'])
})

let playwright
try { playwright = (await import('node:module')).createRequire(import.meta.url)('playwright') } catch {}

test('trystero in browsers: native WebRTC, CORVAX signalling, join time, and recovery with no anchor left', { skip: (!joinRoom || !playwright) && 'needs @trystero-p2p/core and playwright' }, async t => {
  const { node } = await import('./helpers.js')
  const a = await node({ anchor: 'force' })
  const browser = await playwright.chromium.launch()
  t.after(async () => { await browser.close(); await a.close().catch(() => {}) })
  const root = new URL('..', import.meta.url).pathname
  const files = { '/__t/trystero.js': root + 'trystero/index.js' }
  const page = async () => {
    const p = await (await browser.newContext()).newPage()
    p.on('pageerror', e => console.error('pageerror', e.message))
    await p.route('**/__t/**', r => {
      const path = new URL(r.request().url()).pathname
      if (path === '/__t/room.html') return r.fulfill({ contentType: 'text/html', body: `<script type="importmap">{"imports":{"@trystero-p2p/core":"/__t/core/index.mjs","@sloev/corvax":"/cx/index.js"}}</script>` })
      const file = files[path] || (path.startsWith('/__t/core/') && root + 'node_modules/@trystero-p2p/core/dist/' + path.slice(10))
      return file ? r.fulfill({ path: file, contentType: 'text/javascript' }) : r.fulfill({ status: 404 })
    })
    await p.goto(`http://127.0.0.1:${a.port}/__t/room.html`)
    await p.evaluate(async line => {
      const { joinRoom } = await import('/__t/trystero.js')
      window.t0 = Date.now()
      window.room = joinRoom({ appId: 'corvax-browser', corvax: { anchors: [line], allowPrivate: true, fallback: [] } }, 'lobby')
      window.joined = new Promise(resolve => window.room.onPeerJoin(() => resolve(Date.now() - window.t0)))
      window.chat = window.room.makeAction('chat')
      window.got = []
      window.chat.onMessage(d => window.got.push(d))
      window.joins = 0
      window.room.onPeerJoin(() => window.joins++)
      window.cp = await (await import('/__t/trystero.js')).corvaxPeer({ anchors: [line], allowPrivate: true, fallback: [] })
    }, a.line())
    return p
  }
  const [A, B] = [await page(), await page()]
  const ms = await A.evaluate(() => window.joined)
  process.stderr.write(`# joined in ${(ms / 1000).toFixed(1)} s (Chromium)\n`)
  await B.evaluate(() => window.joined)
  await A.evaluate(() => window.chat.send('hi from A'))
  await until(() => B.evaluate(() => window.got.length), 10000, 200)
  assert.deepEqual(await B.evaluate(() => window.got), ['hi from A'])
  assert.ok(ms < 8000, 'joins within 8 s')

  // Peer to peer: once the room's CORVAX mesh exists, signalling no longer needs any anchor.
  await until(() => A.evaluate(() => window.cp.topics.links.size > 0), 20000, 200)
  await a.close()                                                          // the only anchor is gone
  await A.evaluate(() => Object.values(window.room.getPeers())[0].connection.close())
  await until(() => A.evaluate(() => window.joins >= 2), 30000, 250)      // Trystero re-signals over the mesh
  await A.evaluate(() => window.chat.send('still here'))
  await until(() => B.evaluate(() => window.got.includes('still here')), 10000, 200)
})

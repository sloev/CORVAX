// Browsers via Playwright. Runs Chromium here; CI also runs Firefox and WebKit (BROWSERS=chromium,firefox,webkit).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { node, until } from './helpers.js'
import { Peer } from '../src/peer.js'

let playwright
try { playwright = createRequire(import.meta.url)('playwright') } catch {}
const browsers = (process.env.BROWSERS || 'chromium').split(',')

for (const name of browsers) {
  test(`browser (${name}): direct, through a third browser, and Node ↔ browser`, { skip: !playwright && 'playwright not installed' }, async t => {
    const a = await node({ anchor: 'force' })
    const browser = await playwright[name].launch()
    t.after(async () => { await browser.close(); await a.close().catch(() => {}) })
    const origin = `http://127.0.0.1:${a.port}`

    // each page gets its own context (own storage, own identity)
    const open = async () => {
      const page = await (await browser.newContext()).newPage()
      page.on('pageerror', e => console.error(name, e.message))
      await page.goto(origin + '/')
      const address = await page.evaluate(async () => {
        const { Peer } = await import('/cx/index.js')
        const me = window.me = await Peer.create({ allowPrivate: true })
        window.inbox = []
        me.accept(({ from, channel, kind }) => {
          window.inbox.push({ from, kind })
          channel.onmessage = e => channel.send('pong:' + e.data)
        })
        await me.publish()
        return me.address
      })
      return { page, address }
    }
    const connect = (page, to) => page.evaluate(async to => {
      const { channel, kind, via } = await window.me.connect(to, { timeout: 8000 })
      const reply = new Promise(resolve => { channel.onmessage = e => resolve(e.data) })
      channel.send('ping')
      return { kind, via, reply: await reply }
    }, to)

    const [A, B, C] = [await open(), await open(), await open()]

    // 1. direct
    const d = await connect(A.page, B.address)
    assert.deepEqual([d.kind, d.reply], ['direct', 'pong:ping'])

    // 2. through a third browser: A and B both know C; their direct path is blocked
    await connect(A.page, C.address); await connect(B.page, C.address)
    await A.page.evaluate(b => window.me.blockDirect.add(b), B.address)
    await B.page.evaluate(a => window.me.blockDirect.add(a), A.address)
    const r = await connect(A.page, B.address)
    assert.deepEqual([r.kind, r.via, r.reply], ['peer', C.address, 'pong:ping'])

    // 3. a Node peer (default WebRTC: werift) connects to a browser
    const N = await Peer.create({ anchors: [a.line()], allowPrivate: true })
    t.after(() => N.close())
    await N.publish()
    const { channel, kind } = await N.connect(C.address)
    const reply = new Promise(resolve => { channel.onmessage = e => resolve(String(e.data)) })
    channel.send('from node')
    assert.equal(kind, 'direct')
    assert.equal(await reply, 'pong:from node')

    // 4. topics: a browser provider is found by a Node peer, and receives its broadcast over the mesh
    await C.page.evaluate(async () => {
      window.heard = []
      const t = await window.me.topic('chess')
      t.subscribe({ message: m => window.heard.push(m) })
      await t.publish()
    })
    const nt = await N.topic('Chess')
    nt.subscribe({})
    await nt.publish()
    const found = await nt.search()
    assert.ok(found.some(f => f.address === C.address && f.presence === 'recent'), 'Node finds the browser provider')
    await until(() => [...N.topics.links.values()].some(l => l.address === C.address), 20000, 200)
    await nt.broadcast({ move: 'e4' })
    const heard = await until(() => C.page.evaluate(() => window.heard.length && window.heard), 10000, 200)
    assert.deepEqual(heard.map(m => [m.from, m.body.move]), [[N.address, 'e4']])

    // 5. neighbours hold extra copies over WebRTC: with every anchor gone, the members still find each other
    assert.ok(await C.page.evaluate(n => window.me.store.find([[...window.me.topics.handles.values()][0].id]).length >= 1, N.address), 'the browser stores the Node peer\'s record')
    await a.close()
    const still = await nt.search()
    assert.ok(still.some(f => f.address === C.address), 'search answered by the neighbour with no anchor up')
  })
}

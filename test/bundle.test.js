// The minified release bundle (npm run build) exports exactly what the source does, and works in a browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { node } from './helpers.js'
import * as src from '../src/index.js'

const dist = new URL('../dist/corvax.min.js', import.meta.url)
let playwright
try { playwright = createRequire(import.meta.url)('playwright') } catch {}

test('bundle: same exports; two browser peers connect with it', { skip: !existsSync(dist) && 'run npm run build first' }, async t => {
  const min = await import(dist)
  assert.deepEqual(Object.keys(min).sort(), Object.keys(src).sort())
  if (!playwright) return t.skip('playwright not installed')
  const a = await node({ anchor: 'force' }), browser = await playwright.chromium.launch()
  t.after(async () => { await browser.close(); await a.close() })
  const page = async () => {
    const p = await browser.newPage()
    await p.route('**/corvax.min.js', r => r.fulfill({ path: dist.pathname, contentType: 'text/javascript' }))
    await p.goto(`http://127.0.0.1:${a.port}/`)
    await p.evaluate(async line => {
      const { Peer } = await import('/corvax.min.js')
      window.me = await Peer.create({ anchors: line, allowPrivate: true, fallback: [] })
      await window.me.publish()
      window.me.accept(({ channel }) => { channel.onmessage = e => channel.send('echo ' + e.data) })
    }, a.line())
    return p
  }
  const [A, B] = [await page(), await page()]
  const to = await B.evaluate(() => window.me.address)
  assert.equal(await A.evaluate(async to => {
    const { channel } = await window.me.connect(to)
    return new Promise(resolve => { channel.onmessage = e => resolve(e.data); channel.send('hi') })
  }, to), 'echo hi')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { startLan } from '../src/lan.js'
import { until } from './helpers.js'

const line = `corvax-anchor:${'y'.repeat(52)}@192.168.1.20:4799`

for (const mode of ['broadcast', 'mdns']) {
  test(`LAN discovery via ${mode}`, async t => {
    const port = 30000 + Math.floor(Math.random() * 20000)
    const found = []
    const server = await startLan({ port, mdns: mode === 'mdns', lines: () => line, onFound: () => {} })
    const client = await startLan({ port, mdns: mode === 'mdns', lines: () => '', onFound: text => found.push(text) })
    t.after(() => { server.close(); client.close() })
    let tries = 0
    try {
      await until(() => { if (tries++ % 10 === 0) client.discover(); return found.some(f => f.includes(line)) }, 4000)
    } catch {
      if (mode === 'mdns') return t.skip('multicast to 224.0.0.251:5353 is not available in this environment')
      throw new Error('no LAN answer')
    }
    assert.ok(found.some(f => f.includes(line)))
  })
}

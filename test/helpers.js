import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../src/node.js'

let nextPort = 20000 + Math.floor(Math.random() * 20000)
export const port = () => nextPort++

// Start a node on loopback with its own temp dir. LAN discovery off unless asked.
export async function node (o = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'corvax-'))
  return start({
    port: port(), host: '127.0.0.1', allowPrivate: true, lan: false, publicHost: '127.0.0.1',
    dir, intervals: { probe: 3600e3, check: 3600e3 }, rate: { burst: 1e6, perSecond: 1e6 }, ...o
  })
}

// A small network: the first anchor is forced, the others promote themselves through cx_check.
export async function anchors (n, o = {}) {
  const list = [await node({ anchor: 'force', ...o })]
  for (let i = 1; i < n; i++) list.push(await node({ anchors: [list[0].line()], ...o }))
  return list
}

export const until = async (fn, ms = 10000, step = 50) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, step))
  }
}

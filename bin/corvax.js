#!/usr/bin/env node
// corvax node     [--port 4799] [--anchors <file|url|line>...] [--no-relay] [--no-storage] [--mainline] [--web https://…] [--public-host ip]
// corvax anchor   (same flags; forces anchor mode, for the first anchors of a network)
// corvax anchors  print the anchor book
// corvax id       print this node's address
// corvax resolve <address>
import { start } from '../src/node.js'
import { readFile } from 'node:fs/promises'

const [cmd, ...rest] = process.argv.slice(2)
const flags = { anchors: [] }, args = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (!a.startsWith('--')) { args.push(a); continue }
  const k = a.slice(2), v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
  if (k === 'anchors') flags.anchors.push(v); else flags[k] = v
}
const anchorText = async s => /^https?:/.test(s) ? (await fetch(s)).text() : s.startsWith('corvax-anchor:') ? s : readFile(s, 'utf8').catch(() => s)
const log = (...a) => console.error(...a)

const opts = async extra => ({
  port: +(flags.port || 4799),
  anchors: await Promise.all(flags.anchors.map(anchorText)),
  relayFor: !flags['no-relay'],
  storage: !flags['no-storage'],
  mainline: !!flags.mainline,
  web: typeof flags.web === 'string' ? flags.web : undefined,
  publicHost: typeof flags['public-host'] === 'string' ? flags['public-host'] : undefined,
  lan: !flags['no-lan'],
  log,
  ...extra
})

if (cmd === 'node' || cmd === 'anchor') {
  const node = await start(await opts({ anchor: cmd === 'anchor' ? 'force' : flags['no-anchor'] ? 'off' : 'auto' }))
  console.log(node.line() || `node ${node.key} (not publicly reachable, client only)`)
  const stop = async () => { await node.close(); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
} else if (cmd === 'anchors' || cmd === 'id' || cmd === 'resolve') {
  const node = await start(await opts({ anchor: 'off', lan: cmd === 'anchors', port: 0 }))
  if (cmd === 'id') console.log(node.key)
  if (cmd === 'anchors') console.log(node.book.toText())
  if (cmd === 'resolve') console.log(JSON.stringify(await node.peer.resolve(args[0]), (k, v) => v instanceof Uint8Array ? undefined : v, 2))
  await node.close(); process.exit(0)
} else {
  console.log('usage: corvax node | anchor | anchors | id | resolve <address>   [--port 4799] [--anchors <file|url|line>] [--no-relay] [--no-storage] [--mainline] [--web https://…]')
}

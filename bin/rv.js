#!/usr/bin/env node
// rv anchor   [--port 4799] [--bootstrap host:port,...] [--mainline]
// rv id
// rv resolve <address>        [--anchor ws://...]
// rv send    <address> <text> [--anchor ws://...]
// rv listen                   [--anchor ws://...]
import { anchor } from '../src/anchor.js'
import { Peer } from '../src/peer.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const [cmd, ...rest] = process.argv.slice(2)
const flags = {}, args = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]
  else args.push(rest[i])
}
const anchors = String(flags.anchor || process.env.RV_ANCHOR || 'ws://localhost:4799').split(',')
const seedFile = process.env.RV_SEED_FILE || join(homedir(), '.config', 'rv', 'seed')

async function me () {
  let seed
  try { seed = (await readFile(seedFile, 'utf8')).trim() } catch {}
  const peer = await Peer.create({ seed, anchors })
  if (!seed) { await mkdir(dirname(seedFile), { recursive: true }); await writeFile(seedFile, peer.seed, { mode: 0o600 }) }
  return peer
}

if (cmd === 'anchor') {
  const bootstrap = flags.bootstrap ? String(flags.bootstrap).split(',').map(s => { const [host, port] = s.split(':'); return { host, port: +port } }) : []
  await anchor({ port: +(flags.port || 4799), bootstrap, mainline: !!flags.mainline, log: (...a) => console.log(...a) })
} else if (cmd === 'id') {
  const p = await me(); console.log(p.address); p.close()
} else if (cmd === 'resolve') {
  const p = await me(); console.log(JSON.stringify(await p.resolve(args[0]), null, 2)); p.close()
} else if (cmd === 'send') {
  const p = await me(); console.log((await p.send(args[0], args.slice(1).join(' '))) ? 'delivered' : 'queued'); p.close()
} else if (cmd === 'listen') {
  const p = await me()
  await p.publish()
  console.log(`listening as ${p.address}`)
  p.on(({ from, body }) => console.log(`${from}: ${typeof body === 'string' ? body : JSON.stringify(body)}`))
} else {
  console.log('usage: rv anchor | id | resolve <addr> | send <addr> <text> | listen   [--anchor ws://host:port]')
}

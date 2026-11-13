#!/usr/bin/env node
// The community anchor list (anchors.txt): check lines live, accept submissions, bake working ones into releases.
//   node scripts/anchors.js check [file]   report every anchor line in a file (default anchors.txt; '-' = ISSUE_BODY)
//   node scripts/anchors.js add            ISSUE_BODY → append its working, new anchor lines to anchors.txt
//   node scripts/anchors.js bake           write the working lines of anchors.txt into src/anchors.js (releases)
// An anchor works if it answers cx_hi over HTTP(S) with a valid signature from the key in its line.
import { readFile, writeFile } from 'node:fs/promises'
import { Book, formatLine } from '../src/book.js'
import { encode, decode } from '../src/bencode.js'
import { hiOk, random } from '../src/crypto.js'
import { unz32 } from '../src/bytes.js'

const LIST = new URL('../anchors.txt', import.meta.url), BAKED = new URL('../src/anchors.js', import.meta.url)
const entries = text => new Book().add(text)                                 // public, valid, one per key

async function works (e) {
  const n = random(16), url = (e.web || `http://${e.host.includes(':') ? `[${e.host}]` : e.host}:${e.port}`) + '/krpc'
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: encode({ t: random(4), y: 'q', q: 'cx_hi', a: { n } }), signal: AbortSignal.timeout(8000) })
    return await hiOk(decode(new Uint8Array(await res.arrayBuffer())).r, unz32(e.key), n) ? 'works' : 'answers, but not with the key in its line'
  } catch { return 'unreachable' }
}
async function check (text) {
  return Promise.all(entries(text).map(async e => ({ line: formatLine(e), status: await works(e) })))
}
const report = list => list.length ? list.map(r => `- ${r.status === 'works' ? '✅' : '❌'} \`${r.line}\` ${r.status}`).join('\n') : 'No public `corvax-anchor:` line found.'

const [cmd, file] = process.argv.slice(2)
if (cmd === 'check') {
  const list = await check(file === '-' ? process.env.ISSUE_BODY || '' : await readFile(file || LIST, 'utf8'))
  console.log(report(list))
} else if (cmd === 'add') {
  const known = new Set(entries(await readFile(LIST, 'utf8')).map(e => e.key))
  const list = await check(process.env.ISSUE_BODY || '')
  const fresh = list.filter(r => r.status === 'works' && !known.has(entries(r.line)[0].key))
  if (fresh.length) await writeFile(LIST, (await readFile(LIST, 'utf8')).trimEnd() + '\n' + fresh.map(r => r.line).join('\n') + '\n')
  console.log(report(list) + (fresh.length ? `\n\nAdded ${fresh.length} to anchors.txt; releases from now on ship ${fresh.length > 1 ? 'them' : 'it'} while ${fresh.length > 1 ? 'they work' : 'it works'}.` : '\n\nNothing new to add.'))
  process.exitCode = fresh.length ? 0 : 3
} else if (cmd === 'bake') {
  const list = await check(await readFile(LIST, 'utf8')), ok = list.filter(r => r.status === 'works').map(r => r.line)
  const src = await readFile(BAKED, 'utf8')
  await writeFile(BAKED, src.replace(/export default `[^`]*`/, `export default \`\n${ok.join('\n')}\n\``))
  console.error(report(list) + `\n\nShipping ${ok.length} of ${list.length} anchors.`)
} else {
  console.error('usage: node scripts/anchors.js check [file] | add | bake')
  process.exitCode = 1
}

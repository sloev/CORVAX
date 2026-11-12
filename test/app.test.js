// The homepage app as a person uses it: DOX/APP/STATS, identity, peers, messages, topics, updates, persistence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { node } from './helpers.js'

let playwright
try { playwright = createRequire(import.meta.url)('playwright') } catch {}
const name = (process.env.BROWSERS || 'chromium').split(',')[0]

test(`homepage app (${name})`, { skip: !playwright && 'playwright not installed' }, async t => {
  const a = await node({ anchor: 'force' })
  const browser = await playwright[name].launch()
  t.after(async () => { await browser.close(); await a.close() })
  const open = async () => {
    const page = await (await browser.newContext()).newPage(), errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('dialog', d => d.accept())
    await page.goto(`http://127.0.0.1:${a.port}/`)
    return { page, errors }
  }
  const [A, B] = [await open(), await open()]
  await B.page.getByText('2 live visitors').waitFor({ timeout: 20000 })   // the page counts itself over CORVAX topic presence
  const tab = (p, label) => p.getByRole('navigation').getByRole('button', { name: label }).click()

  // header: inlined logo; DOX first for new visitors, the last view remembered across reloads
  assert.match(await A.page.locator('header img').getAttribute('src'), /^data:image\/png;base64,/)
  assert.equal(await A.page.getByRole('button', { name: 'DOX' }).getAttribute('aria-pressed'), 'true')
  await A.page.getByRole('heading', { name: 'Technical documentation' }).waitFor()
  assert.ok(await A.page.getByText('topic.broadcast(body)').count(), 'API reference')
  assert.ok((await A.page.locator('article pre').last().textContent()).includes(a.line()), 'known anchors listed')
  await A.page.getByRole('button', { name: 'STATS' }).click()
  await A.page.getByText('Peers listening').waitFor()
  await A.page.getByText('Go online in APP').waitFor()
  await A.page.reload()
  await A.page.getByText('Peers listening').waitFor()
  for (const p of [A.page, B.page]) await p.getByRole('button', { name: 'APP' }).click()

  // identities
  const live = async p => { await p.getByRole('button', { name: 'Create identity' }).click(); await p.getByRole('button', { name: 'Copy address' }).waitFor({ timeout: 15000 }); return p.evaluate(() => window.corvax.address) }
  const addrA = await live(A.page), addrB = await live(B.page)

  // B adds A and sends a message; A sees the conversation
  await tab(B.page, 'Peers')
  await B.page.getByLabel('Peer address').fill(`http://x/#peer=${addrA}`)
  await B.page.getByRole('button', { name: 'Add', exact: true }).click()
  await B.page.getByRole('button', { name: 'Message', exact: true }).click()
  await B.page.getByLabel('Message', { exact: true }).fill('hello A')
  await B.page.getByRole('button', { name: 'Send' }).click()
  await tab(A.page, 'Messages')
  await A.page.getByText('hello A').waitFor({ timeout: 10000 })

  // topics: both join #chess, B finds A there
  for (const p of [A.page, B.page]) {
    await tab(p, 'Discover')
    await p.getByLabel('Topic').fill('Chess')
    await p.getByRole('button', { name: 'Search' }).click()
    await p.getByRole('button', { name: 'Join' }).click()
    await p.getByRole('button', { name: 'Leave' }).waitFor({ timeout: 10000 })
  }
  await B.page.getByRole('button', { name: 'Search' }).click()
  await B.page.getByText(addrA.slice(0, 6)).first().waitFor({ timeout: 10000 })

  // updates: once linked, A shares and B sees it live
  await A.page.waitForFunction(() => window.corvax.topics.links.size > 0, null, { timeout: 20000 })
  await tab(A.page, 'Updates'); await tab(B.page, 'Updates')
  await A.page.getByLabel('Update').fill('e4')
  await A.page.getByRole('button', { name: 'Share' }).click()
  await B.page.getByText('e4', { exact: true }).waitFor({ timeout: 10000 })

  // reload: same identity, back online by itself, topic and peers restored
  await B.page.reload()
  await B.page.getByRole('button', { name: 'Copy address' }).waitFor({ timeout: 15000 })
  assert.equal(await B.page.evaluate(() => window.corvax.address), addrB)
  await tab(B.page, 'Discover'); await B.page.getByText('chess', { exact: true }).waitFor()
  await tab(B.page, 'Peers'); await B.page.getByText(addrA.slice(0, 6)).first().waitFor()

  // Forget (APP → Home) clears everything; a cleared browser starts on DOX again
  await tab(B.page, 'Home')
  await B.page.getByRole('button', { name: 'Forget my identity' }).click()
  await B.page.getByRole('heading', { name: 'Technical documentation' }).waitFor({ timeout: 10000 })
  await B.page.getByRole('button', { name: 'APP' }).click()
  await B.page.getByRole('button', { name: 'Create identity' }).waitFor({ timeout: 10000 })
  assert.deepEqual([...A.errors, ...B.errors], [], 'no page errors')
})

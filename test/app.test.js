// The homepage as a person uses it: render, go live, topics (publish/search/subscribe/broadcast), messages.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { node } from './helpers.js'

let playwright
try { playwright = createRequire(import.meta.url)('playwright') } catch {}
const name = (process.env.BROWSERS || 'chromium').split(',')[0]

test(`homepage app (${name}): renders, goes live, topics and messages between two tabs`, { skip: !playwright && 'playwright not installed' }, async t => {
  const a = await node({ anchor: 'force' })
  const browser = await playwright[name].launch()
  t.after(async () => { await browser.close(); await a.close() })
  const open = async () => {
    const page = await (await browser.newContext()).newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${a.port}/`)
    return { page, errors }
  }
  const [A, B] = [await open(), await open()]

  // static part: logo inlined, node line, anchors below
  const logo = await A.page.locator('header img').getAttribute('src')
  assert.match(logo, /^data:image\/png;base64,/)
  assert.ok((await A.page.locator('#anchors').textContent()).includes(a.line()))
  assert.ok(await A.page.getByText('How to use it').isVisible())

  // go live in both tabs
  const live = async p => {
    await p.getByRole('button', { name: 'Go live' }).click()
    await p.getByText('Your address:').waitFor({ timeout: 15000 })
    return p.locator('span', { hasText: 'Your address:' }).locator('code').textContent()
  }
  const [addrA, addrB] = [await live(A.page), await live(B.page)]
  assert.match(addrA, /^[a-z0-9]{52}$/)

  // topics: A subscribes + publishes, B subscribes + publishes and searches, then A broadcasts
  const topicCard = p => p.locator('.card', { hasText: 'Topics' })
  for (const p of [A.page, B.page]) {
    await topicCard(p).getByLabel('Topic, e.g. chess').fill('Chess')
    await topicCard(p).getByRole('button', { name: 'Subscribe' }).click()
    await topicCard(p).getByRole('button', { name: 'Publish' }).click()
    await topicCard(p).locator('.log').getByText(/published "chess" on 1 storage node/).waitFor({ timeout: 10000 })
  }
  await topicCard(B.page).getByRole('button', { name: 'Search' }).click()
  await topicCard(B.page).locator('.log').getByText(addrA).waitFor({ timeout: 10000 })
  // presence arrives through the watch (coalesced for 2 s), then the topic link forms; then broadcast once
  await topicCard(A.page).locator('.log').getByText(/presence .*: recent/).waitFor({ timeout: 15000 })
  await A.page.waitForFunction(() => window.corvax.topics.links.size > 0, null, { timeout: 20000 })
  await topicCard(A.page).getByLabel('Broadcast (≤ 1 KB)').fill('e4')
  await topicCard(A.page).getByRole('button', { name: 'Broadcast' }).click()
  await topicCard(A.page).locator('.log').getByText('me (to 1 neighbour(s)): e4').waitFor({ timeout: 5000 })
  await topicCard(B.page).locator('.log').getByText(/broadcast from .*: e4/).waitFor({ timeout: 10000 })

  // messages: B → A
  const msgCard = p => p.locator('.card', { hasText: 'Messages' })
  await msgCard(B.page).getByLabel('Address').fill(addrA)
  await msgCard(B.page).getByLabel('Message').fill('hello from B')
  await msgCard(B.page).getByRole('button', { name: 'Send' }).click()
  await msgCard(A.page).locator('.log').getByText(/from .*: hello from B/).waitFor({ timeout: 10000 })
  void addrB

  // client-side storage: a reload keeps the identity, the anchor book and the joined topics, and goes live again
  const stored = await A.page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('corvax.')).map(k => [k, localStorage.getItem(k)])))
  assert.match(stored['corvax.seed'], /^[0-9a-f]{64}$/)
  assert.ok(stored['corvax.anchors'].includes(a.line().split(';')[0]), 'anchor book cached')
  assert.deepEqual(JSON.parse(stored['corvax.app']), { live: true, topics: { chess: { sub: true, pub: true } } })
  await A.page.reload()
  await A.page.getByText('Your address:').waitFor({ timeout: 15000 })           // went live by itself
  assert.equal(await A.page.locator('span', { hasText: 'Your address:' }).locator('code').textContent(), addrA, 'same identity')
  await topicCard(A.page).locator('.log').getByText('restored "chess" (subscribed, published)').waitFor({ timeout: 10000 })
  assert.equal(await topicCard(A.page).getByRole('button', { name: 'Unpublish' }).count(), 1)
  const search = (await topicCard(B.page).getByRole('button', { name: 'Search' }).click(), topicCard(B.page).locator('.log'))
  await search.getByText(addrA).last().waitFor({ timeout: 10000 })

  // Forget: clears everything and returns to the start
  await A.page.getByRole('button', { name: 'Forget' }).click()
  await A.page.getByRole('button', { name: 'Go live' }).waitFor({ timeout: 10000 })
  assert.equal(await A.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('corvax.')).length), 0)
  assert.deepEqual([...A.errors, ...B.errors], [], 'no page errors')
})

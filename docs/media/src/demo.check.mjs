// Walks the demo the way you will on camera: opens demo.html at 1920 × 1080, presses → through every stop, and checks
// that each chapter's key item is on screen. Fails on a page error, a lost session, or a stop that shows the wrong thing.
//
//   npx -y -p playwright@1.64.1 -c "node docs/media/src/demo.check.mjs"
//
// SHOTS=<folder> saves a screenshot of every stop there, for looking at it.
import { createRequire } from 'node:module'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const bin = process.env.PATH.split(path.delimiter).find(p => p.includes('_npx') && p.endsWith('.bin'))
const { chromium } = require(bin ? path.join(bin, '..', 'playwright') : 'playwright')
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const ok = file.startsWith(ROOT) && existsSync(file) && statSync(file).isFile()
  res.writeHead(ok ? 200 : 404, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  ok ? createReadStream(file).pipe(res) : res.end()
})

// What the dashboard has to show once a moment is up, by moment and page. A missing one fails the walk.
const EXPECT = {
  'draft@': ["Preset: full-stack, Claude's pick"],
  'locked@': ['Invite form', 'Invite email'],
  'overseer@#task-e2e': ['marks the token used'],
  'loop@': ['1×'],
  'asks@': ['hands-free'],
  'decided@': ['Decided'],
  'done@': ['Came back'],
  'library-on@#library': ['fails-without-change'],
  'system@#system': ['Invites API'],
}
// What has to be in the camera's view at some stop of that moment, and inside the plan box's scroll when it is in it.
const SEEN = { 'overseer@#task-e2e': '#v-task li:has(.k-look)' }
// The toasts that must be up at some stop.
const TOASTS = ['picked the preset full-stack', 'the overseer found something on e2e', 'ran /sentinel on fails-without-change']

const fails = []
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  page.on('pageerror', e => fails.push(`page error: ${e.message}`))
  // A failed load names its URL only in the message's location. The dashboard polls state.js for a live session,
  // which a demo doesn't have.
  page.on('console', m => {
    const said = `${m.text()} ${m.location()?.url ?? ''}`
    if (m.type() === 'error' && !/fonts\.g|favicon|\/web\/state\.js\?/.test(said)) fails.push(`console: ${said}`)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  await page.goto(`http://127.0.0.1:${server.address().port}/docs/media/src/demo.html`)
  await page.waitForFunction(() => window.scene?.where, null, { timeout: 30_000 })
  const shots = process.env.SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  const { stops } = await page.evaluate(() => window.scene.where())
  const seen = new Set(), toasts = new Set(), inView = new Set()
  for (let i = 1; i < stops; i++) {
    // The first press plays the step, the second finishes it at once; a frame later it holds at the stop.
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(60)
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => !window.scene.where().moving)
    await page.waitForTimeout(120)
    const w = await page.evaluate(() => ({ ...window.scene.where(), ...window.scene.shown() }))
    if (w.stop !== i) fails.push(`stop ${i}: the page holds at stop ${w.stop}`)
    const frame = page.frames().find(f => f.url().includes('/web/view.html'))
    const body = await frame.evaluate(() => document.body.innerText)
    if (/Lost the session/.test(body)) fails.push(`stop ${i} (${w.moment}): the dashboard says it lost the session`)
    // A field the story fills in a shape the plugin doesn't use shows up as one of these.
    for (const bad of ['Invalid Date', 'NaN', 'undefined']) if (body.includes(bad)) fails.push(`stop ${i} (${w.moment}${w.route}): the dashboard shows "${bad}"`)
    for (const want of EXPECT[`${w.moment}@${w.route}`] ?? []) if (!body.includes(want)) fails.push(`stop ${i} (${w.moment}${w.route}): "${want}" is not on the dashboard`)
    seen.add(`${w.moment}@${w.route}`)
    const sel = SEEN[`${w.moment}@${w.route}`]
    if (sel && await frame.evaluate(([sel, top, bottom]) => {
      const e = document.querySelector(sel)
      if (!e) return false
      const r = e.getBoundingClientRect(), box = e.closest('#pbox')?.getBoundingClientRect()
      return r.top >= top && r.bottom <= bottom && (!box || (r.top >= box.top && r.bottom <= box.bottom))
    }, [sel, ...w.view])) inView.add(sel)
    for (const want of TOASTS) if (w.toast.includes(want)) toasts.add(want)
    if (shots) await page.screenshot({ path: path.join(shots, `${String(i).padStart(2, '0')}-${w.moment}${w.route.replace('#', '-')}.png`) })
  }
  for (const k of Object.keys(EXPECT)) if (!seen.has(k)) fails.push(`no stop shows ${k}`)
  for (const want of TOASTS) if (!toasts.has(want)) fails.push(`no stop shows the toast "${want}"`)
  for (const [k, sel] of Object.entries(SEEN)) if (!inView.has(sel)) fails.push(`no stop at ${k} has ${sel} in view`)
  // ← goes back a stop, and Home to the start.
  await page.keyboard.press('ArrowLeft')
  const back = await page.evaluate(() => window.scene.where())
  if (back.stop !== stops - 2) fails.push(`← should go back to stop ${stops - 2}, it went to ${back.stop}`)
  await page.keyboard.press('Home')
  if ((await page.evaluate(() => window.scene.where().t)) !== 0) fails.push('Home should go to the start')
  console.log(`walked ${stops - 1} stops`)
} finally {
  await browser.close()
  server.close()
}
if (fails.length) {
  console.log(fails.map(f => `FAIL ${f}`).join('\n'))
  process.exit(1)
}
console.log('demo check passed')

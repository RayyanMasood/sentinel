// The dashboard's Library page, instruction editor and draft card in a real browser, served by the real web/serve.mjs:
//   npx -y -p playwright@1.64.1 -c 'node tests/page.check.mjs'
// It fails on a console or policy error, a page wider than its window at 390, 860 or 1440 px (light and dark), a part
// that doesn't show, or a message the page sends in the wrong shape. SHOTS=<dir> also saves a screenshot of each.
// SERVE=<variant> (library, light, insDraft or draft) checks nothing: it keeps the server up on that variant for a
// person to try, prints the address, and prints each message the page sends. No browser package is needed for it.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { act, emptyRun, libraryOn, summarize } from '../hooks/core.ts'
import { BUILTIN_FLOWS, BUILTINS } from '../hooks/builtins.ts'

const PAGE = new URL('../web/view.html', import.meta.url)
const html = readFileSync(PAGE, 'utf8')
const fails = []
const check = (ok, what) => { if (!ok) fails.push(what) }

// The page's own rules: one inline script with no attributes, and no on* handlers in the markup.
check((html.match(/<script\b[^>]*>/g) ?? []).join() === '<script>', 'one bare <script>')
check(!/<[a-z][^>]*\son[a-z]+\s*=\s*["']/i.test(html), 'no on*= attributes')

// ---- what Sentinel would send ----

const now = Date.now()
const own = [
  { name: 'plain-prose', at: 'always', text: 'Comments, docs and commit messages are plain and direct.', scope: 'personal', file: '~/.sentinel/instructions/plain-prose.json' },
  { name: 'dashboard-widths', description: 'The dashboard at phone, tablet and desktop widths', at: 'start', files: ['web/**'], text: 'Check dashboard changes at 390, 860 and 1440 px, light and dark, with the script kept in tests/.', scope: 'project', file: '.sentinel/instructions/dashboard-widths.json' },
  { name: 'release-notes', at: 'final', text: 'Add a line to CHANGELOG.md for every change a user would notice.', scope: 'project', file: '.sentinel/instructions/release-notes.json', trusted: false },
]
const flows = [
  { name: 'review', description: 'Lint, then a review you sign off', scope: 'project', file: '.sentinel/flows/review.json', when: { at: 'after', files: ['src/**'] }, states: [{ id: 'lint', label: 'Lint the change', check: 'npm run lint' }, { id: 'read', label: 'Review the diff', wait: 'after' }] },
]
// The snapshot fields the plugin adds for the Library: the instructions with their switches worked out, and the flows.
function library(project = {}, personal = {}) {
  const items = [...BUILTINS.map(b => ({ ...b, scope: 'built-in' })), ...own.map(i => ({ kind: 'told', ...i }))]
  const fl = [...BUILTIN_FLOWS.map(f => ({ ...f, scope: 'built-in' })), ...flows]
  const { weight, on } = libraryOn([...items, ...fl], project, personal)
  return {
    library: { weight, project, personal, instructions: items.map(i => ({ ...i, on: on.includes(i.name), trusted: i.trusted ?? true })), flowsOn: Object.fromEntries(fl.map(f => [f.name, on.includes(f.name)])) },
    flows: fl.map(f => ({ trusted: true, ...f })),
  }
}
const page = (r, extra = {}) => ({ ...summarize(r), savedAt: now, parallel: false, members: {}, ...library(), ...extra })
const plan = {
  action: 'define', title: 'Order search',
  states: [
    { id: 'explore', label: 'Read the orders code' },
    { id: 'api', label: 'Search endpoint', check: 'npm test -- search.api', files: ['src/api/**'] },
    { id: 'perf', label: 'Time the search on 50,000 orders', check: 'npm test -- search.perf', files: ['tests/perf/**'] },
    { id: 'page', label: 'Search page', check: 'npm test -- search.page', files: ['web/**'] },
  ],
}
const drafted = act({ ...emptyRun(), signedOff: true, review: true }, plan, '', {}, now).run
if (!drafted.draft) throw new Error('no draft')
const standardOn = libraryOn(BUILTINS.map(b => ({ ...b })), {}, {}).on
// A parallel plan with a state nothing needs, early on, and a way back across rows: the two lines most likely to run under a card.
const step = (id, ...needs) => ({ id, label: id, needs, check: `npm test -- ${id}`, files: [`src/${id}/**`] })
const graph = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Graph', states: [{ id: 'a', label: 'a' }, step('b', 'a'), step('side', 'a'), step('c', 'b'), step('d', 'c'), step('e', 'd')], loops: [['e', 'b']] }, '', {}, now).run

const VARIANTS = {
  graph: page(graph, { parallel: true }),
  library: page(emptyRun()),
  light: page(emptyRun(), library({ weight: 'light', on: { 'failure-list': true } })),
  insDraft: page({ ...emptyRun(), flowDraft: { name: 'quick-checks', description: 'Checks under a minute', at: 'start', text: 'Keep each check under a minute: one test file, a type check or a build.', asked: 'keep checks quick' } }),
  draft: page(drafted, {
    draftKey: 'k1',
    draftLibrary: { weight: 'standard', on: library().library.instructions.filter(i => i.on).map(i => i.name), told: [] },
    depth: [
      { id: 'perf', ask: 'expert', text: 'Time the search on 50,000 orders', state: 'perf' },
      { id: 'raw', ask: 'raw', text: 'Start from the slow-query log, not a guess at which filters matter' },
    ],
  }),
}

// ---- the server and the browser ----

const dir = mkdtempSync(join(tmpdir(), 'sentinel-page-'))
const STATE = join(dir, 'state.js')
const write = vm => writeFileSync(STATE, `window.__sentinel && window.__sentinel(${JSON.stringify(vm)})\n`)
write(VARIANTS.library)
const server = spawn(process.execPath, [fileURLToPath(new URL('../web/serve.mjs', import.meta.url))], { env: { ...process.env, SENTINEL_PAGE: fileURLToPath(PAGE), SENTINEL_STATE: STATE, SENTINEL_PORT: '' }, stdio: ['ignore', 'pipe', 'inherit'] })
const lines = createInterface({ input: server.stdout })
const posts = []
const { port, token } = await new Promise(res => lines.once('line', l => res(JSON.parse(l))))
lines.on('line', l => posts.push(JSON.parse(l)))
const base = `http://127.0.0.1:${port}/?k=${token}`
if (process.env.SERVE) {
  write(VARIANTS[process.env.SERVE])
  console.log(`${base}${process.env.SERVE === 'draft' ? '' : '#library'}`)
  lines.on('line', l => console.log(l))
  await new Promise(() => {})
}

// The page's POST that matches, waited for a short while.
async function sent(what, match) {
  for (let i = 0; i < 30; i++) {
    const k = posts.findIndex(match)
    if (k >= 0) return posts.splice(k, 1)[0]
    await new Promise(r => setTimeout(r, 100))
  }
  fails.push(`sent ${what}`)
}

// npx puts the package's bin folder on PATH; playwright is beside it. The installed Chrome runs it when there is one,
// so the check needs no browser download.
const bin = process.env.PATH.split(delimiter).find(p => p.includes('_npx') && p.endsWith('.bin'))
const { chromium } = createRequire(join(bin ?? process.cwd(), 'x.js'))('playwright')
const browser =await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
const errors = []
async function open(variant, hash, opts = {}) {
  write(VARIANTS[variant])
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light' })
  const p = await ctx.newPage()
  // Fonts come from Google; the check doesn't need them.
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }))
  p.on('console', m => { if (m.type() === 'error') errors.push(`${variant}${hash}: ${m.text()}`) })
  p.on('pageerror', e => errors.push(`${variant}${hash}: ${e.message}`))
  await p.goto(base + hash)
  await p.waitForFunction(() => document.body.dataset.state !== undefined && !document.querySelector('#p-flows[hidden]') === location.hash.length > 1, null, { timeout: 5000 }).catch(() => fails.push(`${variant}${hash} opened`))
  return p
}
const shots = process.env.SHOTS
if (shots) mkdirSync(shots, { recursive: true })
async function layout(variant, hash, name) {
  for (const width of [390, 860, 1440]) for (const dark of [false, true]) {
    const p = await open(variant, hash, { width, dark })
    const wide = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    check(wide <= 0, `${name} at ${width}${dark ? ' dark' : ''} fits (${wide}px over)`)
    if (shots) await p.screenshot({ path: join(shots, `${name}-${width}${dark ? '-dark' : ''}.png`), fullPage: true })
    await p.context().close()
  }
}

try {
  // The Library at Standard: the weights, the instruction list grouped by moment, the totals and the panel.
  let p = await open('library', '#library')
  check(await p.locator('#wLabel').textContent() === 'This project: Standard, from your default', 'weight label')
  check(await p.locator('.wcard[aria-pressed=true] .wn').textContent() === 'Standard', 'Standard picked')
  check(await p.locator('.irow').count() === BUILTINS.length + own.length, 'a row for each instruction')
  check(await p.locator('.mg-h').count() === 5, 'a group for each moment')
  check(await p.locator('.irow[data-ins="project/release-notes"] .tag.off').textContent() === 'Not trusted', 'untrusted row marked')
  check((await p.locator('#tot').textContent()).includes(`${standardOn.length + 2} of ${BUILTINS.length + own.length}`), 'totals count what is on')
  await p.locator('.irow[data-ins="built-in/failure-list"] .ck.sw').click()
  await sent('libon', b => b.kind === 'libon' && b.name === 'failure-list' && b.scope === 'project' && b.on === false)
  await p.locator('.wcard[data-weight=thorough]').click()
  await sent('libweight', b => b.kind === 'libweight' && b.scope === 'project' && b.weight === 'thorough')
  await p.locator('.irow[data-ins="project/release-notes"] .im').click()
  check((await p.locator('#idet .prev').textContent()).startsWith('Before the plan completes:'), 'final told text')
  await p.locator('#idet [data-act=libtrust]').click()
  await sent('libtrust', b => b.kind === 'libtrust' && b.name === 'release-notes' && b.scope === 'project' && b.item === 'instruction')
  await p.locator('.irow[data-ins="built-in/break-it-once"] .im').click()
  check((await p.locator('#idet .prev').textContent()).startsWith('Before you advance api:'), 'close told text names a state')
  await p.locator('#swScope [data-sws=personal]').click()
  check(await p.locator('.irow[data-ins^="project/"]').count() === 0, 'my default hides project items')
  await p.locator('.irow[data-ins="built-in/fast-checks"] .ck.sw').click()
  await sent('libon personal', b => b.kind === 'libon' && b.name === 'fast-checks' && b.scope === 'personal' && b.on === true)
  await p.locator('#askBtn').click()
  await p.locator('#askf').fill('keep checks quick')
  await p.locator('[data-act=sendflow]').click()
  await sent('askflow for an instruction', b => b.kind === 'askflow' && b.item === 'instruction' && b.text === 'keep checks quick')
  await p.context().close()

  // A project that picked Light and turned one built-in back on.
  p = await open('light', '#library')
  check(await p.locator('#wLabel').textContent() === 'This project: Light, 1 change', 'changed weight label')
  check(await p.locator('.irow[data-ins="built-in/failure-list"] input').isChecked(), 'project switch wins over the weight')
  await p.locator('.irow[data-ins="built-in/failure-list"] .im').click()
  await p.locator('#idet [data-act=libreset]').click()
  await sent('libon reset', b => b.kind === 'libon' && b.name === 'failure-list' && b.scope === 'project' && b.on === null)
  await p.locator('.irow[data-ins="project/dashboard-widths"] .im').click()
  await p.locator('#idet [data-act=insdel]').click()
  await p.locator('#idet [data-act=insdelyes]').click()
  await sent('delflow for an instruction', b => b.kind === 'delflow' && b.item === 'instruction' && b.name === 'dashboard-widths' && b.scope === 'project')
  await p.context().close()

  // The Flows tab: a switch on each row, and the built-in flow read-only.
  p = await open('library', '#flows')
  check(!(await p.locator('#t-flows').isHidden()) && await p.locator('#t-ins').isHidden(), 'the flows tab')
  check(!(await p.locator('tr[data-flow="built-in/close-phase"] input').isChecked()), 'close-phase starts off')
  await p.locator('tr[data-flow="built-in/close-phase"] td.nm').click()
  check(await p.locator('#fdet [data-act=dup]').first().textContent() === 'Copy and edit', 'a built-in flow is copied to edit')
  await p.locator('tr[data-flow="project/review"] .ck.sw').click()
  await sent('libon for a flow', b => b.kind === 'libon' && b.name === 'review' && b.on === false)
  await p.locator('#libTabs [data-tab=ins]').click()
  check(await p.evaluate(() => location.hash) === '#library', 'the tab sets the address')
  await p.context().close()

  // The instruction editor: the moment decides the files field and the text Claude reads.
  p = await open('library', '#ins-new')
  await p.locator('#ien').fill('quick-checks')
  await p.locator('input[name=iem][value=close]').check()
  await p.locator('#ietext').fill('Keep each check under a minute.')
  check((await p.locator('#ieprev').textContent()).startsWith('Before you advance api:'), 'editor preview')
  check(!(await p.locator('#iefilesBox').isHidden()), 'files for a state moment')
  await p.locator('input[name=iem][value=final]').check()
  check(await p.locator('#iefilesBox').isHidden(), 'no files for a plan moment')
  await p.locator('#ien').fill('review')
  check(await p.locator('[data-act=iesave]').isDisabled(), 'a flow name is refused')
  await p.locator('#ien').fill('quick-checks')
  await p.locator('[data-act=iesave]').click()
  await sent('saveflow for an instruction', b => b.kind === 'saveflow' && b.item === 'instruction' && b.scope === 'project' && b.flow.name === 'quick-checks' && b.flow.at === 'final' && !b.flow.files)
  await p.context().close()

  // An instruction Claude drafted.
  p = await open('insDraft', '#library')
  check((await p.locator('#dfl h2').textContent()).includes('drafted an instruction'), 'instruction draft card')
  await p.locator('#dfl [data-act=savedraft]').click()
  await sent('saveflow from a draft', b => b.kind === 'saveflow' && b.fromDraft && b.item === 'instruction' && b.flow.name === 'quick-checks' && b.flow.at === 'start' && !b.flow.asked)
  await p.context().close()

  // The draft card: depth ticks, the plan's own switches, and Lock carrying both.
  p = await open('draft', '')
  check(await p.locator('#slip .deep label').count() === 2, 'depth items')
  check(await p.locator('#slip .planins input').count() === VARIANTS.draft.library.instructions.filter(i => i.trusted).length, 'a switch per trusted instruction')
  await p.locator('#slip [data-deep=perf]').check()
  await p.locator('#slip [data-plan=failure-list]').uncheck()
  const key = VARIANTS.draft.draftKey
  await sent('libplan', b => b.kind === 'libplan' && b.draft === key && b.weight === 'standard' && !b.on.includes('failure-list'))
  await p.locator('#slip [data-act=planweight][data-pw=thorough]').click()
  await sent('libplan weight', b => b.kind === 'libplan' && b.weight === 'thorough' && b.on.includes('fails-without-change') && b.on.includes('plain-prose'))
  await p.locator('#slip input[name=pkeep][value=project]').check()
  await p.locator('#stub [data-act=lock]').click()
  await sent('lock with picks', b => b.kind === 'lock' && b.draft === key && b.picked?.join() === 'perf' && b.keep === 'project')
  await p.context().close()

  // The Map of a parallel plan: no line runs under a card.
  p = await open('graph', '')
  await p.locator('#viewSeg [data-v=map]').click()
  const under = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#v-map .mcard')].map(c => c.getBoundingClientRect()), hits = []
    const paths = [...document.querySelectorAll('#v-map svg path.ar, #v-map svg path.lp')]
    for (const l of paths) {
      const m = l.getScreenCTM()
      for (let i = 3; i < l.getTotalLength() - 3; i += 3) {
        const q = l.getPointAtLength(i), x = q.x * m.a + m.e, y = q.y * m.d + m.f
        if (cards.some(c => x > c.left + 2 && x < c.right - 2 && y > c.top + 2 && y < c.bottom - 2)) { hits.push(`${l.dataset.a}>${l.dataset.b}`); break }
      }
    }
    return { lines: paths.length, back: document.querySelectorAll('#v-map svg path.lp').length, hits }
  })
  check(under.lines >= 7 && under.back === 1, `the graph draws its lines and its way back (${under.lines}, ${under.back})`)
  check(!under.hits.length, `no line runs under a card (${under.hits.join(', ')})`)
  if (shots) await p.screenshot({ path: join(shots, 'graph.png'), fullPage: true })
  await p.context().close()

  await layout('library', '#library', 'library')
  await layout('library', '#flows', 'flows')
  await layout('library', '#ins-new', 'editor')
  await layout('insDraft', '#library', 'ins-draft')
  await layout('draft', '', 'draft')
} finally {
  await browser.close()
  server.kill()
  rmSync(dir, { recursive: true, force: true })
}

for (const e of errors) fails.push(`console: ${e}`)
for (const b of posts) fails.push(`unexpected message: ${JSON.stringify(b)}`)
if (fails.length) {
  console.error(fails.map(f => `FAIL ${f}`).join('\n'))
  process.exit(1)
}
console.log('page check passed')

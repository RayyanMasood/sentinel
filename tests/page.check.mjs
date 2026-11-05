// The dashboard's Library page, instruction editor, draft card, task page and source page in a real browser, served by the real web/serve.mjs:
//   npx -y -p playwright@1.64.1 -c 'node tests/page.check.mjs'
// It fails on a console or policy error, a page wider than its window at 390, 860 or 1440 px (light and dark), a part
// that doesn't show, or a message the page sends in the wrong shape. SHOTS=<dir> also saves a screenshot of each.
// SERVE=<variant> (library, light, insDraft, draft or a proof variant) checks nothing: it keeps the server up on that variant for a
// person to try, prints the address, and prints each message the page sends. No browser package is needed for it.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { act, emptyRun, libraryOn, lockDraft, summarize } from '../hooks/core.ts'
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

// A plan that quotes its source. How the page can fail here: the count, note or quotes are wrong or missing, the quotes
// aren't folded, Keep and Take it out send the wrong thing, Lock can be pressed with an addition unanswered (even after a
// failed send), Asked for isn't first, the Plan: line stays, another state's refusal shows, an addition has no reason, marks
// change the text or land on the wrong words, a note lands on a quoted section, a chip or Back goes to the wrong place, words
// from a source run as markup, a Windows line ending leaves a stray character, the finish misses an addition or shows an
// empty heading, or a plan that doesn't compare quotes shows any of it.
const PAY = 'Members pay by card at checkout, and the card company tells us when a payment succeeds or fails.'
const REFUND = 'Partial refunds attach after the capture settles.'
const SOME = 'Partial refunds attach after the capture'
const TYPED = 'add a waitlist for full classes please'
const WHY = 'Card rules ask for a receipt.'
const NASTY = 'Staff see <img src=x> & <b>bold</b> words here.'
const CARDS = 'Cards only for now, and'
const DOC = `# Studio\r\n## Payments\r\n${PAY}\r\n${REFUND}\r\n${CARDS} the receipt goes out by email.\r\n## Exports\r\nStaff can export a class roster to a sheet.\r\n## Reports\r\n${NASTY}\r\n\`\`\`\r\n# not a heading\r\n\`\`\`\r\n`
const LIB = { weight: 'standard', on: ['quote-the-source'], told: [] }
const SAVED = { kind: 'approved', text: DOC, at: '09:00', name: 'C:\\plans\\studio.md' }
const quotedPlan = (states, more = {}, t = '09:10') => act({ ...emptyRun(), signedOff: true, sources: [SAVED], ...more }, { action: 'define', title: 'Studio', library: LIB, loops: [], states, messages: [{ kind: 'message', text: TYPED, at: '09:05' }] }, t)
const asks = [
  { id: 'pay', label: 'Take payment', title: 'Take payment', asked: [PAY], problem: 'Claude describes this one itself.', ref: 'Payments, step 1', files: ['src/pay/**'] },
  { id: 'refund', label: 'Refunds', asked: [REFUND, SOME], check: 'npm test -- refund', files: ['src/refund/**'] },
  { id: 'wait', label: 'Waitlist', asked: [TYPED, CARDS], files: ['src/wait/**'] },
]
const drafting = (states = [...asks, { id: 'r1', label: 'Receipts', added: WHY, files: ['src/r/**'] }, { id: 'r2', label: 'Reminders', added: `Classes <i>fill</i> up.`, files: ['src/m/**'] }]) => quotedPlan(states).run
const answered = (r, id) => ({ ...r, draft: { ...r.draft, plan: { ...r.draft.plan, states: r.draft.plan.states.map(s => s.id === id ? { ...s, okAt: '09:12' } : s) } } })
const proofDraft = drafting()
// A first try with a made-up quote for each of two states leaves refusals on the record of the plan that follows.
const tried = quotedPlan([{ id: 'pay', label: 'p', asked: ['Members pay by card at the counter'] }, { id: 'refund', label: 'r', asked: ['Staff pay by card at the counter'] }]).run
const midRun = (() => {
  const r = quotedPlan([...asks, { id: 'r1', label: 'Receipts', added: WHY }], tried).run
  const kept = lockDraft(r, '09:12')
  return act(kept, { action: 'revise', order: ['pay', 'refund', 'wait', 'r1', 'pkg'], states: [{ id: 'pkg', label: 'Add a package', added: 'It needs a new package.', files: ['package.json'] }] }, '09:30').run
})()

const VARIANTS = {
  proofDraft: page(proofDraft, { draftKey: 'p1' }),
  proofOneLeft: page(answered(proofDraft, 'r1'), { draftKey: 'p2' }),
  proofAnswered: page(answered(answered(proofDraft, 'r1'), 'r2'), { draftKey: 'p3' }),
  proofRun: page(midRun),
  proofNone: page(drafting([{ id: 'x', label: 'x', added: WHY }]), { draftKey: 'p4' }),
  proofDone: page({ ...midRun, active: 'done' }),
  onceDraft: page(act({ ...emptyRun(), signedOff: true, review: true }, { ...plan, states: plan.states.map(s => (s.id === 'perf' ? { ...s, once: true } : s)) }, '', {}, now).run),
  blocked: page(act(act({ ...emptyRun(), signedOff: true }, plan, '', {}, now).run, { action: 'escalate', kind: 'blocked', reason: 'The Mac build machine is locked. Someone needs to unlock it.' }, '09:30', {}, now).run),
  closedDone: page(act(midRun, { action: 'finish', reason: 'Enough for now' }, '09:40', {}, Date.now(), true).run),
  proofNoAdds: page({ ...quotedPlan(asks).run, active: 'done' }),
  noProof: page(act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Old', loops: [], states: [{ id: 'a', label: 'a', ref: 'plan.md, step 1' }] }, '09:01').run),
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
  console.log(`${base}${/draft|proof/i.test(process.env.SERVE) ? '' : '#library'}`)
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
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, colorScheme: opts.dark ? 'dark' : 'light' })
  const p = await ctx.newPage()
  // Fonts come from Google; the check doesn't need them.
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }))
  p.on('console', m => { if (m.type() === 'error' && !p.sendsFail) errors.push(`${variant}${hash}: ${m.text()}`) })
  p.on('pageerror', e => errors.push(`${variant}${hash}: ${e.message}`))
  await p.goto(base + hash)
  await p.waitForFunction(() => document.body.dataset.state !== undefined && !document.querySelector('#p-flows[hidden]') === /^#(?!task-)./.test(location.hash), null, { timeout: 5000 }).catch(() => fails.push(`${variant}${hash} opened`))
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

  // The draft card of a plan that quotes its source: the count, the note, the quotes folded, and each addition to answer.
  p = await open('proofDraft', '')
  const slipText = await p.locator('#slip').innerText()
  check(slipText.includes('3 of 5 states'), 'draft: the count')
  check(slipText.includes('Exports and Reports are in studio.md, but no state quotes them.'), 'draft: the note names the sections')
  check(slipText.includes('studio.md') && slipText.includes('Claude wrote it and you approved it at 09:00'), 'draft: where it came from')
  check(!(await p.locator('#askRows').evaluate(d => d.open)), 'draft: the quotes start folded')
  check((await p.locator('#askRows summary').innerText()) === 'See the 5 quotes', 'draft: the fold counts the quotes')
  check(!(await p.locator('#askRows .aq').first().isVisible()), 'draft: a folded quote is hidden')
  await p.locator('#askRows summary').click()
  check((await p.locator('#askRows li').count()) === 3, 'draft: a row per state that quotes')
  check((await p.locator('#askRows li').nth(0).innerText()).includes(PAY), 'draft: the whole quote in its row')
  check((await p.locator('#askRows li').nth(1).innerText()).includes(SOME), 'draft: a second quote in its row')
  check((await p.locator('#askRows li').nth(2).innerText()).includes('Your message at 09:05'), 'draft: a message says so')
  check((await p.locator('#askRows li').nth(2).innerText()).includes(CARDS), 'draft: every quote a state has')
  check((await p.locator('#slip .askn.open').count()) === 2, 'draft: each addition asks')
  check((await p.locator('#slip .askn.open').nth(1).innerText()).includes('Classes <i>fill</i> up.'), 'draft: a reason stays as written')
  check(await p.locator('#slip .askn i').count() === 0, 'draft: a reason runs no markup')
  check(await p.locator('#stub [data-act=lock]').isDisabled(), 'draft: Lock waits for the answers')
  check((await p.locator('#stub h2').innerText()) === '2 states need your answer', 'draft: the stub counts them')
  check((await p.locator('#stub').innerText()).includes('which keeps them'), 'draft: the stub says what typing lock does')
  await p.locator('#slip .askn.open [data-act=keepadded]').first().click()
  await sent('keepadded', b => b.kind === 'keepadded' && b.draft === 'p1' && b.state === 'r1')
  await p.locator('#slip .askn.open').nth(1).locator('[data-act=dropadded]').click()
  await sent('dropadded', b => b.kind === 'dropadded' && b.draft === 'p1' && b.state === 'r2')
  check(await p.locator('#askRows').evaluate(d => d.open), 'draft: the quotes stay open through a redraw')
  // A send that fails leaves Lock as it was, twice over.
  p.sendsFail = true
  await p.route('**/answer', r => r.abort())
  for (let i = 0; i < 2; i++) await p.locator('#slip .askn.open [data-act=keepadded]').first().click()
  await p.waitForFunction(() => document.querySelector('#stub .fine.err') && !document.querySelector('#slip .askn.open [data-act=keepadded]').disabled)
  check(await p.locator('#stub [data-act=lock]').isDisabled(), 'draft: Lock stays off after a failed send')
  await p.context().close()

  // Nothing quoted at all is a warning, and there is nothing to unfold.
  p = await open('proofNone', '')
  check((await p.locator('#slip .m-warn').first().innerText()).includes('0 of 1 states') && await p.locator('#slip .m-ok').count() === 0, 'draft: no quotes is no tick')
  check(await p.locator('#askRows').count() === 0, 'draft: no quotes, no fold')
  check((await p.locator('#stub h2').innerText()) === 'One state needs your answer', 'draft: its addition asks')
  await p.context().close()

  p = await open('proofOneLeft', '')
  check((await p.locator('#stub h2').innerText()) === 'One state needs your answer', 'draft: one left')
  check((await p.locator('#stub').innerText()).includes('which keeps it'), 'draft: one left, in the singular')
  check(await p.locator('#slip .askn.open').count() === 1, 'draft: an answered one stops asking')
  check((await p.locator('#slip .askn:not(.open)').innerText()).includes('You kept it at 09:12'), 'draft: the answer shows')
  await p.locator('#slip .askn:not(.open) [data-act=dropadded]').click()
  await sent('dropadded after keeping', b => b.kind === 'dropadded' && b.draft === 'p2' && b.state === 'r1')
  await p.context().close()

  p = await open('proofAnswered', '')
  check(await p.locator('#stub [data-act=lock]').isEnabled(), 'draft: Lock opens once all are answered')
  check((await p.locator('#stub h2').innerText()) === 'Check the draft, then lock it', 'draft: the usual stub comes back')
  await p.locator('#stub [data-act=lock]').click()
  await sent('lock after answers', b => b.kind === 'lock' && b.draft === 'p3')
  await p.context().close()

  // The draft's links open the saved copy, at the state or at the first section nothing quotes.
  p = await open('proofDraft', '')
  await p.setViewportSize({ width: 390, height: 300 })
  await p.locator('[data-src="@gap"]').click()
  check(await p.evaluate(() => location.hash) === '#source-@gap', 'draft: Show me opens the source')
  check(await p.locator('#srcp [data-gap]').first().evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }), 'source: Show me lands on the first gap')
  check(await p.locator('.nav [data-page=run][aria-current=page]').count() === 1, 'source: Run stays the current tab')
  await p.locator('#srcBack').click()
  await p.waitForFunction(() => location.hash === '')
  check(await p.locator('#p-run').isVisible(), 'source: Back returns to the draft')
  await p.context().close()

  // A task page opens with what asked for it, and the plan's own pointer goes.
  p = await open('proofRun', '#task-pay')
  let main = await p.locator('.tp-main').innerText()
  check(main.indexOf('ASKED FOR') === 0, 'task: Asked for comes first')
  check(main.includes(PAY), 'task: the whole quote')
  check(main.includes('studio.md, Payments. Claude wrote it and you approved it at 09:00.'), 'task: where and origin')
  check(main.includes('Sentinel found these exact words in its saved copy.'), 'task: found')
  check(!(await p.locator('.tp').innerText()).includes('Payments, step 1'), 'task: the Plan: line goes')
  check(main.includes('Refused') && main.includes('“Members pay by card at the counter” wasn\'t in the sources, word for word.'), 'task: its own refusal')
  check(!main.includes('Staff pay by card at the counter'), "task: no other state's refusal")
  check(main.indexOf('Refused') > main.indexOf('ALONG THE WAY'), 'task: the refusal sits under Along the way')
  await p.locator('#v-task [data-task=refund]').first().click()
  main = await p.locator('.tp-main').innerText()
  check(main.includes(REFUND) && main.includes(SOME), 'task: every quote it has')
  check(main.split('Sentinel found these exact words').length === 2, 'task: found says it once')
  check(main.includes('Refused') && main.includes('Staff pay by card at the counter'), 'task: the next state has its own refusal')
  await p.locator('#v-task [data-task=wait]').first().click()
  main = await p.locator('.tp-main').innerText()
  check(main.includes('You typed it at 09:05.') && !main.includes('Your message at'), 'task: a quoted message')
  check(!main.includes('Refused') && main.includes('Nothing was decided, asked or refused here.'), 'task: nothing on the record')
  await p.locator('#v-task [data-task=r1]').first().click()
  main = await p.locator('.tp-main').innerText()
  check(main.includes(`Nothing asked for this. Claude's reason: “${WHY}”`), 'task: an addition gives its reason')
  check(main.includes('You kept it on the draft at 09:12.'), 'task: your answer')
  check(!main.includes('found these exact words') && !main.includes('asks you first'), 'task: nothing else about it')
  check(await p.locator('.tp .mini.need').count() === 0, 'task: a kept addition is not amber')
  await p.locator('#v-task [data-task=pkg]').first().click()
  main = await p.locator('.tp-main').innerText()
  check(main.includes('It needs a new package.') && main.includes('It asks you first, because it could involve a dependency change.'), 'task: why an addition stops')
  check(!main.includes('You kept it'), 'task: no answer yet')
  await p.context().close()
  p = await open('proofDraft', '#task-r1')
  check(await p.locator('.tp .mini.need').count() === 1, 'task: an unanswered addition is amber')
  check((await p.locator('.tp-main').innerText()).includes('Keep it or take it out on the draft'), 'task: where to answer')
  await p.context().close()

  // From a task page to the saved copy and back, and from a chip to its state.
  p = await open('proofRun', '')
  await p.locator('#p-run [data-task=refund]').first().click()
  await p.locator('.tp [data-src=refund]').click()
  check(await p.evaluate(() => location.hash) === '#source-refund', 'source: its own address')
  check(await p.locator('#srcp mark.on').count() === 1 && await p.locator('#srcp mark.on').first().evaluate((e, want) => e.textContent === want, REFUND), 'source: this state is marked, its two quotes as one')
  const marks = await p.locator('#srcp mark:not(.on)').allInnerTexts()
  check(marks.includes(PAY) && marks.includes(TYPED), "source: other states' quotes are marked")
  await p.locator('#srcBack').click()
  await p.waitForFunction(() => location.hash === '#task-refund')
  check(await p.locator('.tp h2').isVisible(), 'source: Back returns to the task')
  await p.locator('.tp [data-src=refund]').click()
  await p.locator('#srcp .doc-n [data-task=pay]').click()
  await p.waitForFunction(() => location.hash === '#task-pay')
  check((await p.locator('.tp-main').innerText()).includes(PAY), 'source: a chip opens its state')
  await p.locator('#tpBack').click()
  await p.waitForFunction(() => location.hash === '#source-refund')
  check(await p.locator('#srcp').isVisible(), "task: Back returns to the source it came from")
  await p.context().close()

  // The page itself, opened from a bookmark.
  p = await open('proofRun', '#source-wait', { width: 390, height: 300 })
  check(await p.locator('#srcp mark.on').first().evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }), 'source: a state opened by its address comes into view')
  await p.context().close()

  p = await open('proofRun', '#source')
  const lines = await p.locator('#srcp .doc-p p').allInnerTexts()
  check(lines.join('|') === [PAY, REFUND, `${CARDS} the receipt goes out by email.`, 'Staff can export a class roster to a sheet.', NASTY, '```', '# not a heading', '```'].join('|'), `source: the words as saved (${lines.join('|')})`)
  check(await p.locator('#srcp .doc-p img, #srcp .doc-p p b').count() === 0, "source: a source's words run no markup")
  check(await p.locator('#srcp mark.on').count() === 0, 'source: nothing is picked out without a state')
  const heads = await p.locator('#srcp article h2, #srcp article h3').allInnerTexts()
  check(heads.join('|') === 'Studio|Payments|Exports|Reports', `source: the headings (${heads.join('|')})`)
  check(await p.locator('#srcp [data-gap]').count() === 2, 'source: a note on each section nothing quotes')
  check(await p.locator('#srcp h3:has-text("Payments") + [data-gap]').count() === 0, 'source: no note on a quoted section')
  check(await p.locator('#srcp h3:has-text("Exports") + [data-gap]').count() === 1, 'source: the note sits under its section')
  const chips = id => p.locator('#srcp .doc-p').filter({ has: p.locator(`mark:has-text("${id}")`) }).locator('.doc-n [data-task]').allInnerTexts()
  check((await chips('Members pay')).join() === 'pay', 'source: a chip beside the quote')
  check((await chips('Partial refunds')).join() === 'refund', 'source: two quotes by one state, one chip')
  const refundMarks = await p.locator('#srcp .doc-p p').nth(1).locator('mark').allInnerTexts()
  check(refundMarks.join('|') === REFUND, `source: overlapping marks read as one (${refundMarks.join('|')})`)
  const cardMarks = await p.locator('#srcp .doc-p p').nth(2).locator('mark').allInnerTexts()
  check(cardMarks.join('|') === CARDS, `source: a mark stops where the quote does (${cardMarks.join('|')})`)
  const facts = await p.locator('#srcp .doc-src').innerText()
  check(facts.includes('studio.md') && facts.includes('Claude wrote it and you approved it at 09:00') && facts.includes('3 of 5 states'), `source: its facts (${facts})`)
  const msgs = await p.locator('#srcMsgs').innerText()
  check(msgs.includes(TYPED) && msgs.includes('You typed it at 09:05'), 'source: the quoted message')
  check((await p.locator('#srcAdded').innerText()).includes(`r1 has no quote. Claude added it because: ${WHY} You kept it at 09:12.`), 'source: what quotes nothing')
  await p.locator('#srcBack').click()
  await p.waitForFunction(() => !location.hash)
  check(await p.locator('#p-run').isVisible(), 'source: Back from a bookmark goes to the run')
  await p.context().close()

  // The finish lists what Claude added, and each opens its page.
  p = await open('proofDone', '')
  const add = p.locator('#side .sec', { hasText: 'Claude added along the way' })
  check(await add.count() === 1, 'finish: the heading')
  const addText = await add.innerText()
  check(addText.includes(`r1 ${WHY} You kept it at 09:12.`), 'finish: the reason and your answer')
  check(addText.includes('pkg It needs a new package.') && addText.split('You kept it').length === 2, 'finish: no answer it never had')
  await add.locator('[data-task=r1]').click()
  check((await p.locator('.tp-main').innerText()).includes(WHY), 'finish: an addition opens its page')
  await p.context().close()
  p = await open('proofNoAdds', '')
  check(await p.locator('#side .sec', { hasText: 'Claude added along the way' }).count() === 0, 'finish: nothing added, no heading')
  await p.context().close()
  p = await open('proofRun', '')
  check(await p.locator('#side .sec', { hasText: 'Claude added along the way' }).count() === 0, 'finish: not while it runs')
  await p.context().close()

  // A check marked once shows on the draft and on its task page, so the user sees it before the lock.
  p = await open('onceDraft', '')
  check((await p.locator('body').innerText()).includes('Its check runs once'), 'once: the draft card')
  await p.context().close()
  p = await open('onceDraft', '#task-perf')
  check((await p.locator('body').innerText()).includes('does not run again at the end'), 'once: the task page')
  await p.context().close()

  // A blocked report says what is needed and offers the way out.
  p = await open('blocked', '')
  const blockedText = await p.locator('body').innerText()
  check(blockedText.includes('The Mac build machine is locked'), 'blocked: what is needed')
  check(blockedText.includes('Needs you'), 'blocked: who it waits on')
  check(await p.getByRole('button', { name: "It's ready, go on" }).first().isVisible(), 'blocked: the button')
  await p.getByRole('button', { name: "It's ready, go on" }).first().click()
  await sent('the ready press', b => b.kind === 'ready' && typeof b.at === 'number')
  await p.context().close()

  // A plan the user closed says so, and how much of it stands unproven.
  p = await open('closedDone', '')
  const closedText = await p.locator('body').innerText()
  check(closedText.includes('You closed the plan'), 'closed: the heading')
  check(closedText.includes('Enough for now'), 'closed: the reason')
  check(closedText.includes('never finished'), 'closed: what never finished')
  await p.context().close()

  // A plan that doesn't compare quotes looks as it did.
  p = await open('noProof', '#task-a')
  check((await p.locator('.tp').innerText()).includes('Plan: plan.md, step 1'), 'no proof: the Plan: line stays')
  check(!(await p.locator('.tp-main').innerText()).includes('ASKED FOR'), 'no proof: no Asked for')
  await p.context().close()
  p = await open('noProof', '#source')
  check((await p.locator('#srcp').innerText()).includes('This plan has no saved source.'), 'no proof: the source page says so')
  await p.context().close()
  p = await open('draft', '')
  check(await p.locator('#slip .askn, #askRows, [data-src]').count() === 0, 'no proof: nothing on the draft card')
  check(await p.locator('#stub [data-act=lock]').isEnabled(), 'no proof: Lock is open')
  check((await p.locator('#slip').innerText()).includes('Add a saved flow'), 'no proof: the card keeps its parts')
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
  await layout('proofDraft', '', 'proof-draft')
  await layout('proofRun', '#task-pay', 'proof-task')
  await layout('proofRun', '#task-pkg', 'proof-added')
  await layout('proofRun', '#source-refund', 'proof-source')
  await layout('proofDone', '', 'proof-finish')
  await layout('blocked', '', 'blocked')
  await layout('closedDone', '', 'closed-finish')
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

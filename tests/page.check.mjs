// The dashboard's Library page, instruction editor, draft card, task page, source page, System page and project tabs in a real browser, served by the real web/serve.mjs:
//   npx -y -p playwright@1.64.1 -c 'node tests/page.check.mjs'
// ONLY=system runs the System page's checks alone (about a third of the time). ONLY=others runs everything else. ONLY=hub runs the project tabs, usage figures and grouped Map alone. DUMP=<variant> prints that variant's System view.
// It fails on a console or policy error, a page wider than its window at 390, 860 or 1440 px (light and dark), a part
// that doesn't show, or a message the page sends in the wrong shape. SHOTS=<dir> also saves a screenshot of each.
// SERVE=<variant> (library, light, presets, mcpDraft, insDraft, draft or a proof variant) checks nothing: it keeps the server up on that variant for a
// person to try, prints the address, and prints each message the page sends. No browser package is needed for it.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { act, emptyRun, libraryOn, lockDraft, observe, summarize } from '../hooks/core.ts'
import { BUILTIN_FLOWS, BUILTINS } from '../hooks/builtins.ts'
import { parseSystem } from '../hooks/system.ts'

const PAGE = new URL('../web/view.html', import.meta.url)
const html = readFileSync(PAGE, 'utf8')
const fails = []
const check = (ok, what) => { if (!ok) fails.push(what) }

// The page's own rules: one inline script with no attributes, and no on* handlers in the markup.
check((html.match(/<script\b[^>]*>/g) ?? []).join() === '<script>', 'one bare <script>')
check(!/<[a-z][^>]*\son[a-z]+\s*=\s*["']/i.test(html), 'no on*= attributes')
const barHtml = readFileSync(new URL('../web/hub.html', import.meta.url), 'utf8')
check((barHtml.match(/<script\b[^>]*>/g) ?? []).join() === '<script>', 'the bar has one bare <script>')
check(!/<[a-z][^>]*\son[a-z]+\s*=\s*["']/i.test(barHtml), 'the bar has no on*= attributes')

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
// preset: the switches of the preset in use, and mine: its own instructions.
function library(project = {}, personal = {}, preset = {}, mine = []) {
  const items = [...BUILTINS.map(b => ({ ...b, scope: 'built-in' })), ...[...own, ...mine].map(i => ({ kind: 'told', own: true, ...i }))]
  const fl = [...BUILTIN_FLOWS.map(f => ({ ...f, scope: 'built-in' })), ...flows]
  const { weight, on } = libraryOn([...items, ...fl], project, personal, preset)
  return {
    library: { weight, project, personal, instructions: items.map(i => ({ ...i, on: on.includes(i.name), trusted: i.trusted ?? true })), flowsOn: Object.fromEntries(fl.map(f => [f.name, on.includes(f.name)])) },
    flows: fl.map(f => ({ trusted: true, ...f })),
  }
}
const page = (r, extra = {}, look) => ({ ...summarize(r, look), savedAt: now, parallel: false, members: {}, ...library(), ...extra })
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
// A draft with the Library's settings per state on: mixed weights, one addition on two states, and a plan setting held for the user.
const XS = 'state-settings'
const settingsPlan = {
  action: 'define', title: 'Card payments',
  library: {
    weight: 'standard', on: [...standardOn.filter(n => n !== 'quote-the-source'), XS], told: [],
    states: { hand: { [XS]: true }, weights: Object.fromEntries(BUILTINS.filter(b => b.weights?.length).map(b => [b.name, b.weights])), spare: [] },
    settings: [{ name: 'fails-first', on: false, why: 'the suite takes an hour', held: true }],
  },
  states: [
    { id: 'copy', label: 'Reword the checkout text', check: 'npm test -- copy', files: ['docs/**'], weight: 'light', weightWhy: 'only changes text' },
    { id: 'docs', label: 'Update the README', check: 'npm test -- docs', files: ['README.md'], weight: 'light', weightWhy: 'only changes text' },
    { id: 'form', label: 'Build the checkout form', check: 'npm test -- form', files: ['web/**'] },
    { id: 'charge', label: 'Charge the card', check: 'npm test -- charge', files: ['src/charge/**'], adds: [{ name: 'dashboard-widths', why: 'it shows the card form' }] },
    { id: 'refund', label: 'Handle refunds', check: 'npm test -- refund', files: ['src/refund/**'], adds: [{ name: 'dashboard-widths', why: 'it shows the card form' }] },
    { id: 'export', label: 'Rewrite saved data', check: 'npm test -- export', files: ['src/export/**'], weight: 'thorough', weightWhy: 'rewrites saved data <i>on disk</i>' },
    { id: 'asked', label: 'Asked for by name', check: 'npm test -- asked', files: ['src/asked/**'], weight: 'light', weightQuote: 'keep this one light please', weightOk: true },
    { id: 'long-state-name-that-keeps-going-past-the-column-it-sits-in', label: 'A long name', check: 'npm test -- long', files: ['long/**'], weight: 'light', weightWhy: 'a much longer reason than the others, written out in full so the row has to wrap at every width it is shown at' },
  ],
}
const settingsActed = act({ ...emptyRun(), signedOff: true, review: true }, settingsPlan, '', {}, now)
const withSettings = settingsActed.run
const settingsOff = act({ ...emptyRun(), signedOff: true, review: true }, { ...settingsPlan, library: { weight: 'standard', on: [], told: [] } }, '', {}, now).run
if (!withSettings.draft?.library?.states) throw new Error(`no draft with settings: ${settingsActed.text}`)
const lockedSettings = lockDraft(withSettings, '09:12', now)
// A parallel plan with a state nothing needs, early on, and a way back across rows: the two lines most likely to run under a card.
const step = (id, ...needs) => ({ id, label: id, needs, check: `npm test -- ${id}`, files: [`src/${id}/**`] })
const graph = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Graph', states: [{ id: 'a', label: 'a' }, step('b', 'a'), step('side', 'a'), step('c', 'b'), step('d', 'c'), step('e', 'd')], loops: [['e', 'b']] }, '', {}, now).run

// The plan whose Map had group boxes crossing: groups side by side, with lines between them, and a step waiting on two others.
const inGroup = (group, id, ...needs) => ({ ...step(id, ...needs), label: `${id} with a label that runs on for some way`, group })
const groupedGraph = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Groups', states: [
  inGroup('usage', 'usage-numbers'), inGroup('usage', 'usage-display', 'usage-numbers'),
  inGroup('tabs', 'hub-survives'), inGroup('tabs', 'hub-server', 'hub-survives'), inGroup('tabs', 'tabs-open', 'usage-numbers', 'hub-server'), inGroup('tabs', 'tabs-page', 'tabs-open', 'usage-display'),
  inGroup('finish', 'docs', 'tabs-page'), inGroup('finish', 'verify', 'docs'), inGroup('finish', 'commit', 'verify'),
] }, '', {}, now).run
// Groups one after another have no reason to leave the first row.
const lineGraph = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Line', states: [inGroup('one', 'a'), inGroup('one', 'b', 'a'), inGroup('two', 'c', 'b'), inGroup('three', 'd', 'c')] }, '', {}, now).run
// Two lines have to pass under the same card, on their way to the group below.
const twoLinesGraph = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Two lines', states: [inGroup('one', 'a'), inGroup('one', 'b', 'a'), inGroup('two', 'c', ...[]), inGroup('two', 'd', 'c'), inGroup('two', 'e', 'd', 'a'), inGroup('two', 'f', 'd', 'a')] }, '', {}, now).run

// Group one's box has an empty corner, where group two's step would fit if only cards were kept apart. Its line leaves by the next
// gap, so nothing else stops it landing there.
const cornerGraph = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Corner', states: [inGroup('one', 'a'), inGroup('one', 'a2', 'a'), inGroup('one', 'a3', 'a'), inGroup('two', 'b', ...[]), inGroup('three', 'c', 'b')] }, '', {}, now).run

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
const quotedPlan = (states, more = {}, t = '09:10', points) => act({ ...emptyRun(), signedOff: true, sources: [SAVED], ...more }, { action: 'define', title: 'Studio', library: LIB, loops: [], states, ...(points && { points }), messages: [{ kind: 'message', text: TYPED, at: '09:05' }] }, t)
const asks = [
  { id: 'pay', label: 'Take payment', title: 'Take payment', asked: [PAY], problem: 'Claude describes this one itself.', ref: 'Payments, step 1', files: ['src/pay/**'] },
  { id: 'refund', label: 'Refunds', asked: [REFUND, SOME], check: 'npm test -- refund', files: ['src/refund/**'] },
  { id: 'wait', label: 'Waitlist', asked: [TYPED, CARDS], files: ['src/wait/**'] },
]
const drafting = (states = [...asks, { id: 'r1', label: 'Receipts', added: WHY, files: ['src/r/**'] }, { id: 'r2', label: 'Reminders', added: `Classes <i>fill</i> up.`, files: ['src/m/**'] }]) => quotedPlan(states).run
const answered = (r, id) => ({ ...r, draft: { ...r.draft, plan: { ...r.draft.plan, states: r.draft.plan.states.map(s => s.id === id ? { ...s, okAt: '09:12' } : s) } } })
const proofDraft = drafting()
// The points Claude lists on a draft: two the plan delivers, and two it leaves out with a reason.
const EXPORT = 'Staff can export a class roster to a sheet.', LATER = 'Reports <i>wait</i> for the next plan.'
const POINTS = [{ said: PAY, states: ['pay', 'refund'] }, { said: TYPED, states: ['wait'] }, { said: EXPORT, left: 'Exports come after payments.' }, { said: NASTY, left: LATER }]
// A first try with a made-up quote for each of two states leaves refusals on the record of the plan that follows.
const tried = quotedPlan([{ id: 'pay', label: 'p', asked: ['Members pay by card at the counter'] }, { id: 'refund', label: 'r', asked: ['Staff pay by card at the counter'] }]).run
const midRun = (() => {
  const r = quotedPlan([...asks, { id: 'r1', label: 'Receipts', added: WHY }], tried).run
  const kept = lockDraft(r, '09:12')
  return act(kept, { action: 'revise', order: ['pay', 'refund', 'wait', 'r1', 'pkg'], states: [{ id: 'pkg', label: 'Add a package', added: 'It needs a new package.', files: ['package.json'] }] }, '09:30').run
})()

// The overseer's looks: a timed check run that fails, then the same file read again and again until the detector marks
// the state stuck. The overseer looked once as the state ran long and once at the stuck mark.
const LOOK_LINE = 'The rounding is in <b>money.ts</b>, see `round()`.'
const looked = (() => {
  let r = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Refunds', states: [{ id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/**'] }, { id: 'verify', label: 'Full suite', check: 'npm test' }] }, '09:00', {}, now).run
  const go = o => { r = observe(r, o, '09:05').run }
  go({ kind: 'check', label: 'npm test -- refund', pass: false, sig: 'A', sigText: 'expected 49.99, received 50.00', fails: 1, ms: 42_000 })
  for (let i = 0; i < 9; i++) go({ kind: 'look', label: 'Read src/refund.ts', fp: 'same' })
  if (!r.traps[0]) throw new Error('no stuck mark')
  return { ...r, looks: [
    { state: 'service', why: 'time', at: now - 600_000, word: 'faster', line: 'Run one test file instead of the suite.' },
    { state: 'service', why: 'stuck', trap: r.traps[0].step, at: now - 60_000, word: 'wrong', line: LOOK_LINE },
  ] }
})()
const T0 = looked.traps[0]
// Finished: the overseer agreed with the first stuck mark, said the second was moving, and never saw the third.
const lookedDone = { ...looked, active: 'done', traps: [
  { ...T0, end: T0.step + 9 },
  { state: 'service', pattern: 'static', step: T0.step + 20, end: T0.step + 30, notes: 2, lastNote: T0.step + 28, muted: true },
  { state: 'verify', pattern: 'cycle', step: T0.step + 40, end: T0.step + 48, notes: 1, lastNote: T0.step + 40 },
], looks: [...looked.looks, { state: 'service', why: 'stuck', trap: T0.step + 20, at: now - 30_000, word: 'fine', line: 'Each read compares a new fixture.' }] }

const VARIANTS = {
  looksRun: page(looked),
  looksDone: page(lookedDone),
  proofDraft: page(proofDraft, { draftKey: 'p1' }),
  proofOneLeft: page(answered(proofDraft, 'r1'), { draftKey: 'p2' }),
  proofAnswered: page(answered(answered(proofDraft, 'r1'), 'r2'), { draftKey: 'p3' }),
  proofRun: page(midRun),
  proofNone: page(drafting([{ id: 'x', label: 'x', added: WHY }]), { draftKey: 'p4' }),
  proofPoints: page(quotedPlan(asks, { review: true }, '09:10', POINTS).run, { draftKey: 'p5' }),
  proofDone: page({ ...midRun, active: 'done' }),
  usageRun: page(midRun, { usage: { windows: [{ name: 'Week', percent: 52, resetsAt: new Date(now + 3_600_000).toISOString(), was: 50 }, { name: '5 hours', percent: 23 }], plan: { cost: '$4.20', share: 'about 1.4%' }, steps: { pay: { cost: '$1.75', share: 'about 0.6%' }, refund: { cost: '$0.40' } } } }),
  usageNoShare: page(midRun, { usage: { windows: [{ name: 'Week', percent: 52 }], plan: { cost: '$0.01' }, steps: {} } }),
  usageNoLimits: page(midRun, { usage: { windows: [], plan: { cost: '$3.10' }, steps: { pay: { cost: '$3.10' } } } }),
  onceDraft: page(act({ ...emptyRun(), signedOff: true, review: true }, { ...plan, states: plan.states.map(s => (s.id === 'perf' ? { ...s, once: true } : s)) }, '', {}, now).run),
  blocked: page(act(act({ ...emptyRun(), signedOff: true }, plan, '', {}, now).run, { action: 'escalate', kind: 'blocked', reason: 'The Mac build machine is locked. Someone needs to unlock it.' }, '09:30', {}, now).run),
  closedDone: page(act(midRun, { action: 'finish', reason: 'Enough for now' }, '09:40', {}, Date.now(), true).run),
  proofNoAdds: page({ ...quotedPlan(asks).run, active: 'done' }),
  noProof: page(act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Old', loops: [], states: [{ id: 'a', label: 'a', ref: 'plan.md, step 1' }] }, '09:01').run),
  graph: page(graph, { parallel: true }),
  groupedGraph: page(groupedGraph, { parallel: true }),
  lineGraph: page(lineGraph, { parallel: true }),
  cornerGraph: page(cornerGraph, { parallel: true }),
  twoLinesGraph: page(twoLinesGraph, { parallel: true }),
  library: page(emptyRun()),
  settings: page(withSettings, { draftKey: 's1', draftLibrary: withSettings.draft.library, parallel: true }),
  settingsRun: page({
    ...lockedSettings,
    library: { ...lockedSettings.library, settings: [...lockedSettings.library.settings, { name: 'fails-without-change', on: true, why: 'it rewrites saved data' }] },
    audit: [...lockedSettings.audit, { step: 1, t: '09:13', kind: 'decided', state: 'form', by: 'claude', text: 'Skipped failure-list for form: the form is copied from the design file', skip: { name: 'failure-list', why: 'the form is copied from the design file' } }],
  }, { parallel: true }),
  settingsOff: page(settingsOff, { draftKey: 'o1', parallel: true }),
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
// Presets and the MCPs needed here, as the plugin adds them to the Library's snapshot. This project uses game-dev, which
// switches fast-checks off and has an instruction of its own; shared came from a teammate, so its items are untrusted
// and its flow's check is a shell command to read before using it.
const UNITY = { name: 'Unity', state: 'missing' }, NOTION = { name: 'Notion', state: 'connected', server: 'claude_ai_Notion' }
const PLAYTEST = { name: 'playtest', at: 'close', text: 'Play the change before calling it done.' }
const GAME_DEV = { on: { 'fast-checks': false }, mcps: ['Unity'] }
const PRESETS = [
  { name: 'backend', trusted: true, file: '~/.sentinel/presets/backend/', raw: { weight: 'standard' }, weight: 'standard', on: {}, instructions: [], flows: [], mcps: [], preview: { turnsOn: ['fast-checks'], turnsOff: [] } },
  { name: 'game-dev', trusted: true, file: '~/.sentinel/presets/game-dev/', raw: { ...GAME_DEV, instructions: [PLAYTEST] },
    on: GAME_DEV.on, instructions: [{ ...PLAYTEST, trusted: true }], flows: [], mcps: [UNITY], preview: { turnsOn: [], turnsOff: [] } },
  { name: 'shared', trusted: false, file: '~/.sentinel/presets/shared/', raw: { on: { 'failure-list': false }, mcps: ['Notion'] },
    on: { 'failure-list': false }, instructions: [{ name: 'house-style', at: 'close', text: 'Follow STYLE.md.', trusted: false }],
    flows: [{ name: 'release', description: 'Build before a release', checks: ['npm run build && rm -rf dist'], trusted: false }], mcps: [NOTION],
    preview: { turnsOn: ['fast-checks'], turnsOff: ['failure-list'] } },
]
const SERVERS = [{ server: 'claude_ai_Notion', name: 'Notion', signIn: false }, { server: 'plugin_playwright_playwright', name: 'playwright', signIn: false }]
const usingGameDev = () => {
  const project = { preset: 'game-dev', mcps: ['Notion'] }
  const v = { ...page(emptyRun()), ...library(project, {}, GAME_DEV, [{ ...PLAYTEST, scope: 'preset', file: '~/.sentinel/presets/game-dev/instructions/playtest.json' }]) }
  return { ...v, library: { ...v.library, using: { name: 'game-dev', ...GAME_DEV }, presets: PRESETS, servers: SERVERS, mcps: [{ ...NOTION, scope: 'project' }, { ...UNITY, scope: 'preset' }] } }
}
VARIANTS.presets = usingGameDev()
VARIANTS.noPresets = (() => { const v = page(emptyRun()); return { ...v, library: { ...v.library, presets: [], mcps: [], servers: SERVERS } } })()
// A teammate's project names game-dev, which this computer lacks.
VARIANTS.presetMissing = (() => { const v = page(emptyRun(), library({ preset: 'game-dev' })); return { ...v, library: { ...v.library, using: { name: 'game-dev', missing: true }, presets: PRESETS.filter(p => p.name !== 'game-dev'), mcps: [], servers: SERVERS } } })()
VARIANTS.mcpDraft = { ...VARIANTS.draft, library: { ...VARIANTS.draft.library, mcps: [UNITY, { name: 'amp', state: 'sign-in', server: 'amp' }] } }
VARIANTS.missingDraft = { ...VARIANTS.draft, library: { ...VARIANTS.draft.library, using: { name: 'game-dev', missing: true } } }

// ---- a system map ----
// How the System page can fail: the tab shows with no map, or not with one, or stays marked when another page is open; a
// level shows the wrong parts, or pressing a block opens more than that block, or a level change keeps old openings; a
// part shows a status with no word (colour alone), a word that differs from the terminal pane's, or the wrong colour; a
// group's count differs from the pane's; an outside part shows a Tested mark, or no evidence, or a guess unmarked; the
// panel shows another part, misses its proof, its files, its builders, its connections, its shared file or the note that
// the lines are Claude's drawing; a line is drawn dashed, to the wrong part, or stays after the pointer leaves, or runs
// to a part hidden inside a block instead of the block; Testing misorders or misses a section; Changes misses an entry
// or says something changed when nothing did; the finish list is missing, or stops the green; the drawing's notes or the
// guesses are missing; words from the map run as markup; a new snapshot loses the pick or the level; the page is wider
// than its window at 390, 860 or 1440 px, light or dark; the page sends a message.
const WEB = {
  name: 'Webshop',
  actors: [{ id: 'buyers', name: 'Buyers', desc: 'order and ask for refunds' }, { id: 'staff', name: 'Staff', desc: 'handle refunds' }],
  parts: [
    { id: 'shop', name: 'Shop' },
    { id: 'catalog', parent: 'shop', name: 'Catalog', desc: 'Products and prices', files: ['src/catalog/**'] },
    { id: 'orders', parent: 'shop', name: 'Orders' },
    { id: 'refunds', parent: 'orders', name: 'Refunds', desc: 'Money back to cards', files: ['src/refund/**'] },
    { id: 'shipping', parent: 'orders', name: 'Shipping', files: ['src/ship/**'] },
    { id: 'guide', parent: 'shop', name: 'Guide', desc: 'The refund rules', files: ['guide/**'] },
    { id: 'faq', parent: 'shop', name: 'FAQ', files: ['guide/faq.md'] },
    { id: 'admin', parent: 'shop', name: 'Admin', desc: 'In the project before this plan', files: ['admin/**'] },
    { id: 'billing', name: 'Billing' },
    { id: 'invoices', parent: 'billing', name: 'Invoices', files: ['src/invoice/**'] },
    { id: 'tax', parent: 'billing', name: 'Tax', files: ['src/tax/**', 'src/vat.ts', 'src/gst.ts', 'src/duty.ts'] },
    { id: 'reports', parent: 'billing', name: 'Reports' },
    { id: 'cards', name: 'Card company', kind: 'outside', where: 'their servers', evidence: { seen: [{ file: 'src/refund.ts', text: 'cards.example.com' }] } },
    { id: 'queue', name: 'Job queue', kind: 'outside', where: 'a container', evidence: { guess: 'refunds probably run as jobs' } },
  ],
  lines: [
    { from: 'buyers', to: 'refunds', says: 'ask for money back' }, { from: 'refunds', to: 'cards', says: 'send the refund' },
    { from: 'refunds', to: 'queue', says: 'queue refund jobs' }, { from: 'invoices', to: 'tax', says: 'ask for the rate' },
    { from: 'staff', to: 'guide', says: 'read the rules' },
  ],
}
const webMap = (extra = {}) => { const r = parseSystem(JSON.stringify({ version: 1, ...WEB, ...extra })); if (!r.ok) throw new Error(r.error); return r.map }
const built = (id, label, ...parts) => ({ id, label, check: `npm test -- ${id}`, files: [`src/${id}/**`], parts })
const webStates = [{ id: 'explore', label: 'Read the shop code' }, built('catalog', 'Catalog', 'catalog'), built('refunds', 'Refunds', 'refunds'), built('guide', 'Guide', 'guide', 'faq'), built('invoices', 'Invoices', 'invoices'), built('tax', 'Tax', 'tax'), built('shipping', 'Shipping', 'shipping'), { id: 'verify', label: 'Full suite', check: 'npm test' }]
const webRun = (active, done, map = webMap()) => ({
  ...act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Refunds', loops: [], states: webStates, drawn: { map, exists: ['admin'] } }, '09:00', {}, now).run,
  active, done,
})
const proof = (check, at, hash = 'bbbb') => ({ base: 'aaaa', hash, check, weight: 'standard', at })
const marksA = { catalog: proof('npm test -- catalog', '09:12'), refunds: proof('npm test -- refund', '09:20'), guide: { base: 'aaaa' }, faq: { base: 'aaaa' } }
const printsA = { catalog: { hash: 'bbbb', files: 4 }, refunds: { hash: 'cccc', files: 2 }, guide: { hash: 'dddd', files: 3 }, faq: { hash: 'dddd', files: 1 } }
const sysMid = webRun('invoices', ['explore', 'catalog', 'refunds', 'guide'])
const lookA = { marks: marksA, now: printsA }
const lookB = { marks: { ...marksA, invoices: proof('npm test -- invoices', '09:31') }, now: { ...printsA, invoices: { hash: 'bbbb', files: 2 } } }
// The map changes after the lock: a part added, one dropped, one edited, a line added and a line dropped.
const changedRun = (() => {
  const r = webRun('invoices', ['explore', 'catalog', 'refunds', 'guide'])
  const m = r.drawing.map
  const parts = m.parts.filter(p => p.id !== 'faq').map(p => (p.id === 'refunds' ? { ...p, files: ['src/refund/**', 'src/tip.ts'] } : p))
  parts.push({ id: 'receipts', parent: 'orders', name: 'Receipts', files: ['src/receipt/**'] })
  return { ...r, drawing: { ...r.drawing, map: { ...m, parts, lines: [...m.lines.slice(1), { from: 'staff', to: 'refunds', says: 'approve refunds' }] } } }
})()
const finishedRun = act(webRun('tax', ['explore', 'catalog', 'refunds', 'guide', 'invoices']), { action: 'finish', reason: 'Enough for now' }, '09:40', {}, now, true).run
// The terminal pane's words for each status and tag. The page must say the same, so they are read from there.
const paneSrc = readFileSync(new URL('../hooks/views.tsx', import.meta.url), 'utf8')
const PANE_PART = Object.fromEntries([...paneSrc.match(/const PART:[^=]*=\s*\{([\s\S]*?)\n\}/)[1].matchAll(/(\w+): \['[^']*', '([^']+)'/g)].map(m => [m[1], m[2]]))
const PANE_TAG = Object.fromEntries([...paneSrc.match(/const TAG: Record<string, string> = \{([\s\S]*?)\n\}/)[1].matchAll(/(?:'([\w-]+)'|(\w+)): '([^']+)'/g)].map(m => [m[1] ?? m[2], m[3]]))
// Every status, group colour, tag and kind of evidence at once, in groups that carry the roll the pane would give them.
const LONG_WHY = 'the refund route calls the card company at https://cards.example.com/v2/refunds/create with the order id and the amount in cents'
const leafOf = (id, status, tags = [], more = {}) => ({ id, name: 'Part ' + id, builtBy: [], kids: [], status: { status, tags, ...more } })
const outsideOf = (id, kind, why) => ({ id, name: 'Out ' + id, builtBy: [], kids: [], status: { status: 'outside', tags: [], evidence: kind }, outside: { kind, why, where: 'somewhere else' } })
const rollOf = (id, tone, kids) => ({ id, name: 'Group ' + tone, builtBy: [], kids, roll: { tone, total: kids.length, counts: Object.fromEntries(Object.keys(PANE_PART).map(k => [k, kids.filter(n => n.status.status === k).length])) } })
const everyStatus = () => {
  const vm = page(sysMid, {}, lookA)
  const st = k => leafOf('s-' + k, k)
  const tagged = Object.keys(PANE_TAG).map(g => leafOf('t-' + g, 'untested', [g]))
  vm.system.tree = [
    rollOf('g-red', 'red', ['failing', 'needs'].map(st)),
    rollOf('g-amber', 'amber', ['changed', 'untested'].map(st)),
    rollOf('g-blue', 'blue', ['now', 'change'].map(st)),
    rollOf('g-green', 'green', [st('tested')]),
    rollOf('g-dashed', 'dashed', ['planned', 'dropped'].map(st)),
    rollOf('g-plain', 'plain', [st('exists')]),
    rollOf('g-neutral', 'neutral', [...tagged, leafOf('n-note', 'untested', [], { note: 'Passed once, failed once' })]),
    outsideOf('o-seen', 'seen', LONG_WHY), outsideOf('o-said', 'said', 'refunds go through the card company'),
  ]
  vm.system.here = ['now', 'change', 'tested'].map(k => ({ id: 's-' + k, name: 'Part s-' + k }))
  vm.system.warnings = []
  vm.system.guessed = []
  vm.system.links = []
  vm.system.actors = []
  return vm
}
const retag = (ns, f) => ns.forEach(n => { if (n.kids.length) retag(n.kids, f); else if (!n.outside) n.status = f(n.status) })
const without = (vm, id) => {
  const c = structuredClone(vm)
  const cut = ns => ns.filter(n => n.id !== id).map(n => ({ ...n, kids: cut(n.kids) }))
  c.system.tree = cut(c.system.tree)
  c.system.links = c.system.links.filter(l => l.from !== id && l.to !== id)
  return c
}
const HTML_BAIT = '<img src=x onerror="window.__pwn=1">'
const nastyMap = webMap({
  name: HTML_BAIT, actors: [{ id: 'p', name: HTML_BAIT, desc: HTML_BAIT }], lines: [{ from: 'shop', to: 'ext', says: HTML_BAIT }],
  parts: [{ id: 'shop', name: HTML_BAIT, desc: HTML_BAIT, files: [HTML_BAIT] }, { id: 'g', name: HTML_BAIT }, { id: 'k', parent: 'g', name: HTML_BAIT }, { id: 'ext', name: HTML_BAIT, kind: 'outside', where: HTML_BAIT, evidence: { said: HTML_BAIT } }],
})
// Bait in every place a map word can land: a finished plan lists its loose ends, the drawing has notes, and the map has changed.
const nastyPage = () => {
  const vm = page(act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'x', loops: [], states: [{ id: 'a', label: 'a', check: 'true', files: ['a/**'], parts: ['shop'] }], drawn: { map: nastyMap, exists: [] } }, '09:00', {}, now).run, {})
  vm.phase = 'complete'
  vm.system.warnings = [HTML_BAIT]
  vm.system.guessed = ['ext']
  retag(vm.system.tree, s => ({ ...s, tags: ['not-finished'] }))
  vm.system.changes = { added: [{ id: 'x', name: HTML_BAIT }], dropped: [{ id: 'y', name: HTML_BAIT }], edited: [{ id: 'shop', name: HTML_BAIT, what: [HTML_BAIT] }], linesAdded: [{ from: 'shop', to: 'ext', says: HTML_BAIT }], linesDropped: [{ from: 'shop', to: 'ext', says: HTML_BAIT }] }
  return vm
}
const cleanPage = () => { const vm = structuredClone(page(finishedRun, {}, lookB)); retag(vm.system.tree, () => ({ status: 'tested', tags: [] })); return vm }
Object.assign(VARIANTS, {
  sysMid: page(sysMid, {}, lookA),
  sysLater: page(webRun('tax', ['explore', 'catalog', 'refunds', 'guide', 'invoices']), {}, lookB),
  sysChanges: page(changedRun, {}, lookA),
  sysDone: page(finishedRun, {}, lookB),
  sysClean: cleanPage(),
  sysStatuses: everyStatus(),
  sysNasty: nastyPage(),
})
// The same map under another plan, and the same plan with one part gone.
VARIANTS.sysOther = { ...VARIANTS.sysMid, title: 'Another plan', system: { ...VARIANTS.sysMid.system, name: 'Other shop' } }
VARIANTS.sysGone = without(VARIANTS.sysMid, 'refunds')
// The Tasks level: the plan above, with bait in the title of the state that builds Catalog.
VARIANTS.sysTasks = (() => { const vm = structuredClone(VARIANTS.sysMid); vm.states.find(s => s.id === 'catalog').title = HTML_BAIT; return vm })()

// ---- history: the update check and the past plans, on the System page with no plan running ----
// How they can fail: the banner shows when nothing drifted, or is missing when something did; a reason is not the one the
// check gave; a button sends the wrong message or none; a long list runs on; "no git" reads as "nothing changed"; a past plan
// is listed in the wrong order, or pointing at it lights the wrong parts and keeps them lit; the panel offers Redraw on a
// part nothing marked; words from git or from plans.json run as markup; the page is wider than its window.
const DRIFT_RAW = {
  parts: { refunds: 'changed', faq: 'gone', tax: 'changed' },
  why: {
    refunds: '3 files changed since it was drawn: 2 edited, 1 added.',
    faq: "All 1 of its files are gone. Git can't tell where they went.",
    tax: '1 file changed since it was drawn: 1 edited.',
  },
  loose: ['src/analytics/events.ts', 'src/analytics/index.ts', 'src/analytics/sink.ts', 'scripts/seed.ts', 'scripts/dump.ts', 'scripts/fix.ts', 'notes.md'],
}
// plans.json lists the oldest first; the page gets them newest first.
const PAST = [
  { title: 'Add refunds', at: '2026-10-28T09:00:00.000Z', ended: 'complete', parts: ['refunds', 'cards'] },
  { title: 'Try a new invoice layout', at: '2026-11-03T10:00:00.000Z', ended: 'closed', parts: ['invoices'] },
]
const historyOf = (drift, plans = PAST) => page(emptyRun(), {}, { map: webMap(), now: {}, drift, plans })
const MANY = ['refunds', 'faq', 'tax', 'catalog', 'guide', 'invoices', 'shipping']
Object.assign(VARIANTS, {
  sysDrift: historyOf(DRIFT_RAW),
  sysDriftMany: historyOf({ parts: Object.fromEntries(MANY.map(i => [i, 'changed'])), why: Object.fromEntries(MANY.map(i => [i, '1 file changed since it was drawn: 1 edited.'])), loose: [] }),
  sysNoGit: historyOf({ parts: {}, why: {}, loose: [], noGit: true }, []),
  sysQuiet: historyOf({ parts: {}, why: {}, loose: [] }, []),
})
// The first map: folders no part reaches and the endpoint keys nothing names.
const FOLDERS = n => Array.from({ length: n }, (_, i) => ({ path: i ? `folder${i}` : 'billing', files: 30 - i }))
const firstOf = (unmapped, leads) => page(emptyRun(), {}, { map: webMap(), now: {}, unmapped, leads })
Object.assign(VARIANTS, {
  sysFirst: firstOf([{ path: 'billing', files: 14 }, { path: 'docs', files: 1 }], ['STRIPE_API_URL', 'REDIS_HOST']),
  sysFirstMany: firstOf(FOLDERS(15), Array.from({ length: 11 }, (_, i) => `K${i}_URL`)),
})
VARIANTS.sysFirstNasty = (() => {
  const vm = structuredClone(VARIANTS.sysFirst)
  vm.system.unmapped.rows[0].path = HTML_BAIT
  vm.system.leads.keys[0] = HTML_BAIT
  return vm
})()
VARIANTS.sysDriftNasty = (() => {
  const vm = structuredClone(VARIANTS.sysDrift)
  vm.system.drift.why.refunds = HTML_BAIT
  vm.system.drift.loose = [HTML_BAIT]
  vm.system.plans[0].title = HTML_BAIT
  return vm
})()

// DUMP=<variant> prints that variant's System view and stops, to see what a fixture holds.
if (process.env.DUMP) { console.log(JSON.stringify(VARIANTS[process.env.DUMP].system, null, 1)); process.exit(0) }

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
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: opts.motion === false ? 'reduce' : 'no-preference' })
  const p = await ctx.newPage()
  p.setDefaultTimeout(4000)
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
async function layout(variant, hash, name, setup) {
  for (const width of [390, 860, 1440]) for (const dark of [false, true]) {
    const p = await open(variant, hash, { width, dark })
    if (setup) await setup(p)
    const wide = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    check(wide <= 0, `${name} at ${width}${dark ? ' dark' : ''} fits (${wide}px over)`)
    if (shots) await p.screenshot({ path: join(shots, `${name}-${width}${dark ? '-dark' : ''}.png`), fullPage: true })
    await p.context().close()
  }
}

// ---- the System page ----

const flat = ns => ns.flatMap(n => [n, ...flat(n.kids)])
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
// A group's line, as the pane says it.
const rollSay = r => [plural(r.total, 'part'), ...Object.keys(PANE_PART).filter(k => k !== 'outside' && k !== 'dropped' && r.counts[k]).map(k => `${r.counts[k]} ${PANE_PART[k]}`)].join(' · ')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function systemPage() {
  const sys = VARIANTS.sysMid.system, t = sys.tally
  const all = flat(sys.tree), byId = Object.fromEntries(all.map(n => [n.id, n]))
  const leaves = all.filter(n => !n.kids.length)
  const trail = {}
  const mark = (ns, path) => ns.forEach(n => { trail[n.id] = path; mark(n.kids, [...path, n.name]) })
  mark(sys.tree, [])
  const people = sys.actors.map(a => a.id)
  // The behaviour checks run with reduced motion, so nothing is caught halfway through moving. The motion has its own check.
  const sopen = (v, h, o = {}) => open(v, h, { motion: false, ...o })
  // What a level shows: a block is open when it sits above the level, and the people are always there.
  const shown = open => { const out = [...people]; const go = (ns, d) => ns.forEach(n => { out.push(n.id); if (n.kids.length && d < open) go(n.kids, d + 1) }); go(sys.tree, 0); return out.sort() }
  const ids = p => p.$$eval('#sysMain [data-id]', els => els.map(e => e.dataset.id).sort())
  const side = p => p.locator('#sysSide').textContent()
  const picked = p => p.locator('#sysSide h3').first().textContent()
  const lv = (p, name) => p.locator(`#sysLevel [data-lv=${name}]`).click()
  const views = (p, name) => p.locator(`#sysViews [data-sv=${name}]`).click()
  const dim = (p, id) => p.locator(`#sysMain [data-id="${id}"]`).first().evaluate(e => e.classList.contains('dim'))
  const current = p => p.evaluate(() => [...document.querySelectorAll('.nav [aria-current=page]')].map(b => b.dataset.page))
  // A line joins when it starts on the edge of one card, ends on the edge of the other, and keeps clear of both between.
  const lines = (p, sel = '#sysLn path.lt') => p.evaluate(sel => {
    const rect = id => document.querySelector(`#sysMain [data-id="${id}"]`)?.getBoundingClientRect()
    const home = document.getElementById('sysLn').getBoundingClientRect()
    const edge = (pt, r) => !!r && pt.x >= r.left - 2 && pt.x <= r.right + 2 && pt.y >= r.top - 2 && pt.y <= r.bottom + 2 && Math.min(Math.abs(pt.x - r.left), Math.abs(pt.x - r.right), Math.abs(pt.y - r.top), Math.abs(pt.y - r.bottom)) <= 2
    const inside = (pt, r) => !!r && pt.x > r.left + 2 && pt.x < r.right - 2 && pt.y > r.top + 2 && pt.y < r.bottom - 2
    return [...document.querySelectorAll(sel)].map(l => {
      const n = l.getTotalLength(), A = rect(l.dataset.a), B = rect(l.dataset.b)
      const at = f => { const q = l.getPointAtLength(n * f); return { x: q.x + home.left, y: q.y + home.top } }
      const clear = [.1, .2, .3, .4, .5, .6, .7, .8, .9].every(f => !inside(at(f), A) && !inside(at(f), B))
      const css = getComputedStyle(l), box = l.getBoundingClientRect()
      // Each end meets its card head-on: the last 14px run straight and square to the edge it lands on, so an arrowhead
      // never sits in a corner or points along an edge.
      const side = (pt, r) => !r ? '' : Math.abs(pt.y - r.top) <= 2 ? 'top' : Math.abs(pt.y - r.bottom) <= 2 ? 'bottom' : Math.abs(pt.x - r.left) <= 2 ? 'left' : Math.abs(pt.x - r.right) <= 2 ? 'right' : ''
      let k
      const square = (end, back, r) => { const s = side(end, r); return (s === 'top' || s === 'bottom') ? Math.abs(back.x - end.x) < .5 && Math.abs(back.y - end.y) > k - .5 : (s === 'left' || s === 'right') ? Math.abs(back.y - end.y) < .5 && Math.abs(back.x - end.x) > k - .5 : false }
      const run = f => { const q = l.getPointAtLength(Math.max(0, Math.min(n, f))); return { x: q.x + home.left, y: q.y + home.top } }
      // A line shorter than two runs must be one straight stroke from edge to edge.
      k = Math.min(14, n / 2)
      const headOn = square(at(1), run(n - k), B) && square(at(0), run(k), A)
      return { a: l.dataset.a, b: l.dataset.b, dash: css.strokeDasharray, shown: css.display !== 'none' && css.visibility !== 'hidden' && box.width + box.height > 0, joins: edge(at(0), A) && edge(at(1), B) && clear, headOn, enters: side(at(1), B) }
    })
  }, sel)
  const says = p => p.$$eval('#sysLbl .lbl', ts => ts.map(t => t.textContent).sort())

  // The tab shows only with a map, and says so plainly when it is opened without one.
  let p = await sopen('library', '')
  check(!(await p.locator('[data-page=system]').isVisible()), 'no map: no System tab')
  await p.context().close()
  p = await sopen('proofRun', '')
  check(!(await p.locator('[data-page=system]').isVisible()), 'a plan with no map: no System tab')
  await p.context().close()
  p = await sopen('library', '#system')
  check((await p.locator('#sysp').innerText()).includes('No system map'), 'no map: #system says so')
  check(!(await p.locator('#sysLevel button').count()), 'no map: no level controls')
  await p.context().close()

  // The tab moves between pages, and only the page that is open is marked.
  p = await sopen('sysMid', '')
  check((await p.locator('[data-page=system]').textContent()) === 'System', 'the tab says System')
  await p.locator('[data-page=system]').click()
  check((await p.evaluate(() => location.hash)) === '#system', 'the tab opens #system')
  check((await p.locator('#sysp').isVisible()) && !(await p.locator('#p-run').isVisible()), 'System shows and Run hides')
  check(same(await current(p), ['system']), `only System is marked (${await current(p)})`)
  await p.locator('[data-page=flows]').click()
  check((await p.evaluate(() => location.hash)) === '#library' && same(await current(p), ['flows']) && !(await p.locator('#sysp').isVisible()), 'Library replaces System')
  await p.locator('[data-page=system]').click()
  await p.locator('[data-page=run]').click()
  check((await p.evaluate(() => location.hash)) === '' && same(await current(p), ['run']) && (await p.locator('#p-run').isVisible()), 'Run replaces System')
  check((await p.locator('#sysp').isHidden()), 'Run hides System')
  await p.context().close()

  // The head, the people, the notes, the key and the title block.
  p = await sopen('sysMid', '#system')
  const head = await p.locator('#sysSum').innerText()
  check(head.startsWith(`${sys.name} · ${plural(t.total, 'part')} · ${t.built} built · ${t.untestedOrChanged} to test`), `the head counts as the pane does (${head})`)
  check(head.includes('Claude is in Invoices'), `the head says where Claude is (${head})`)
  check(same(await p.locator('#sysMain .actor b').allInnerTexts(), sys.actors.map(a => a.name)), 'the people are named')
  const notes = await p.locator('#sysNotes').textContent()
  check(notes.includes('Drawing notes') && sys.warnings.every(w => notes.includes(w)), 'the drawing\'s notes show')
  check(/Guessed/.test(notes) && notes.includes('Job queue'), 'a guessed outside part is named')
  check(!(await p.locator('#sysFinish').isVisible()), 'no finish list while the plan runs')
  check((await picked(p)) === 'Invoices' && (await side(p)).includes('Claude is here'), `with nothing picked, the panel follows Claude (${await picked(p)})`)
  check((await p.locator('#sysMain [data-id=invoices]').getAttribute('aria-pressed')) === 'true', 'the part Claude is in is marked while nothing is picked')
  check((await p.locator('#sysLevel [data-lv=areas]').getAttribute('aria-pressed')) === 'true' && (await p.locator('#sysViews [data-sv=all]').getAttribute('aria-pressed')) === 'true', 'it opens on Areas and All')
  const foot = await p.locator('#sysFoot').innerText()
  check(foot.includes('Line Claude drew') && foot.includes('Drawn by') && foot.includes('Claude') && foot.includes('Marks set by') && foot.includes('Sentinel') && foot.includes('As signed off'), `the key and the title block show (${foot.replace(/\n/g, ' | ')})`)
  for (const k of new Set(leaves.map(n => n.status.status))) check(foot.includes(PANE_PART[k]), `the key names ${PANE_PART[k]}`)

  // Levels: each shows its parts, a block opens alone, and a level change forgets the openings.
  check(same(await ids(p), shown(1)), `Areas shows the top two layers (${await ids(p)})`)
  await lv(p, 'overview')
  check(same(await ids(p), shown(0)), `Overview shows the blocks only (${await ids(p)})`)
  await p.locator('.sg[data-id=billing] .sg-h').click()
  check(same(await ids(p), [...shown(0), 'invoices', 'reports', 'tax'].sort()), `pressing Billing opens Billing alone (${await ids(p)})`)
  check((await p.locator('.sg[data-id=billing] .sg-h').getAttribute('aria-expanded')) === 'true' && (await p.locator('.sg[data-id=shop] .sg-h').getAttribute('aria-expanded')) === 'false', 'blocks say whether they are open')
  check((await p.evaluate(() => document.activeElement?.dataset.tog)) === 'billing', 'the block pressed keeps the focus after the map is drawn again')
  await p.locator('.sg[data-id=billing] .sg-h').click()
  check(same(await ids(p), shown(0)), 'pressing it again closes it')
  await lv(p, 'areas')
  await p.locator('.sg[data-id=orders] .sg-h').click()
  check(same(await ids(p), [...shown(1), 'refunds', 'shipping'].sort()), `pressing Orders at Areas opens Orders alone (${await ids(p)})`)
  await lv(p, 'overview')
  await lv(p, 'areas')
  check(same(await ids(p), shown(1)), 'a level change forgets the openings')
  await lv(p, 'parts')
  check(same(await ids(p), shown(99)), `Parts shows every part (${await ids(p)})`)

  // Every part says its status in words, with the pane's words, and a group says how its parts stand.
  for (const n of leaves) {
    const card = p.locator(`#sysMain .pt[data-id=${n.id}]`)
    const text = await card.innerText()
    const w = PANE_PART[n.status.status]
    check((await card.locator('.pt-f').innerText()).trim() === w && (await card.getAttribute('class')).includes(`k-${n.status.status}`), `${n.id} says ${w} (${text.replace(/\n/g, ' | ')})`)
    for (const g of n.status.tags) if (g !== 'shares-file') check(text.includes(PANE_TAG[g]), `${n.id} says "${PANE_TAG[g]}"`)
  }
  for (const n of all.filter(x => x.roll)) check((await p.locator(`.sg[data-id=${n.id}] > .sg-h .sg-s`).innerText()) === rollSay(n.roll), `${n.id} counts its parts like the pane`)
  check((await p.locator('.pt[data-id=faq]').innerText()).includes('Shares a file with Guide'), 'a shared file is said')
  const cards = await p.locator('.pt[data-id=cards]').innerText(), queue = await p.locator('.pt[data-id=queue]').innerText()
  check(cards.includes('Outside the project') && cards.includes('seen in src/refund.ts') && !cards.includes('Tested'), `an outside part shows its evidence and no Tested mark (${cards.replace(/\n/g, ' | ')})`)
  check(queue.includes('guessed: refunds probably run as jobs'), 'a guess is marked as a guess')
  check((await p.locator('.pt[data-id=cards]').getAttribute('class')).includes('k-outside'), 'an outside part has its own look')
  check((await p.locator('.pt[data-id=queue]').evaluate(e => getComputedStyle(e).borderTopStyle)) === 'dotted', 'a guessed part is drawn dotted')

  // The panel.
  await p.locator('.pt[data-id=refunds]').click()
  let s = await side(p)
  for (const want of ['Refunds', 'Shop, Orders', 'Money back to cards', 'Changed since test', 'npm test -- refund', 'standard', '09:20', 'src/refund/**', 'Buyers', 'ask for money back', 'Card company', 'send the refund', 'Job queue', 'queue refund jobs', 'Claude\'s drawing', 'Why it shows that'])
    check(s.includes(want), `the panel for Refunds says "${want}"`)
  check((await p.locator('#sysSide [data-task=refunds]').count()) === 1, 'the panel names the state that builds it')
  check((await p.locator('.pt[data-id=refunds]').getAttribute('aria-pressed')) === 'true' && (await p.locator('.pt[data-id=catalog]').getAttribute('aria-pressed')) === 'false' && (await p.locator('.pt[data-id=invoices]').getAttribute('aria-pressed')) === 'false', 'the picked card says it is picked, the others do not')
  await p.locator('.pt[data-id=guide]').click()
  s = await side(p)
  check(s.includes('Shares a file with FAQ') && /change together/.test(s), 'the panel says why a shared file changes both')
  await p.locator('.sg[data-id=orders] .sg-h').click()
  s = await side(p)
  check(s.includes('Orders') && s.includes('Parts inside') && s.includes('Refunds') && s.includes('Shipping') && s.includes('Not built'), 'a block\'s panel lists its parts')
  check(s.includes(rollSay(byId.orders.roll)), `a block's panel says how its parts stand (${rollSay(byId.orders.roll)})`)
  check(!(await p.locator('.pt[data-id=refunds]').count()), 'pressing an open block closes it')
  check((await p.locator('.sg[data-id=orders] > .sg-h').getAttribute('aria-pressed')) === 'true', 'a picked block says it is picked')
  await p.locator('.sg[data-id=orders] .sg-h').click()
  await p.locator('.sg[data-id=billing] .sg-h').click()
  s = await side(p)
  check(s.includes('Billing') && !s.includes('ask for the rate') && !s.includes('Connects to'), 'a block\'s panel leaves out the lines that stay inside it')
  await p.locator('.sg[data-id=billing] .sg-h').click()
  await p.locator('.actor[data-id=buyers]').click()
  s = await side(p)
  check(s.includes('Buyers') && s.includes('order and ask for refunds') && s.includes('Refunds') && s.includes('ask for money back'), 'a person\'s panel says what they do and what they use')
  await p.locator('.pt[data-id=cards]').click()
  s = await side(p)
  check(s.includes('their servers') && s.includes('seen in src/refund.ts') && !s.includes('Tested'), 'an outside part\'s panel shows where it runs and its evidence')
  await p.locator('.pt[data-id=queue]').click()
  check(/guess/i.test(await side(p)) && (await side(p)).includes('refunds probably run as jobs'), 'a guessed part\'s panel says it is a guess')
  await p.locator('.pt[data-id=catalog]').focus()
  await p.keyboard.press('Enter')
  s = await side(p)
  check(s.includes('Catalog') && s.includes('Tested') && s.includes('npm test -- catalog'), 'a part can be picked from the keyboard')

  // Lines come out on a pointer or a pick, solid, and join the right two things.
  await p.mouse.move(5, 5)
  await p.locator('.pt[data-id=refunds]').hover()
  let ls = await lines(p)
  check(ls.length === 3 && ls.every(l => l.shown && l.dash === 'none' && l.joins), `hovering Refunds draws its three lines, drawn, solid, from card edge to card edge (${JSON.stringify(ls)})`)
  check(ls.every(l => l.headOn), `every line meets its cards head-on, with a straight run of 14px at each end (${JSON.stringify(ls)})`)
  check(['queue', 'cards'].every(id => ls.find(l => l.b === id)?.enters === 'top'), `a line that comes down to an outside card enters through its top (${JSON.stringify(ls)})`)
  check(same(await says(p), ['ask for money back', 'queue refund jobs', 'send the refund']), `each line says what it carries (${await says(p)})`)
  check(!(await dim(p, 'cards')) && !(await dim(p, 'buyers')) && (await dim(p, 'catalog')), 'pointing at a part keeps what its lines reach lit and quiets the rest')
  await p.locator('.pt[data-id=shipping]').hover()
  check((await lines(p)).length === 0, 'a part with no lines draws none')
  // A link from a part to the block that holds it has no line: the part is inside it already.
  write({ ...VARIANTS.sysMid, system: { ...sys, links: [...sys.links, { from: 'refunds', to: 'orders', says: 'part of' }] } })
  await p.waitForTimeout(1200)
  await p.mouse.move(5, 5)
  await p.locator('.pt[data-id=refunds]').hover()
  check((await lines(p)).length === 3, 'a link from a part to its own block draws no line')
  write(VARIANTS.sysMid)
  await p.waitForTimeout(1200)
  await p.locator('.pt[data-id=shipping]').hover()
  await p.locator('.pt[data-id=refunds]').click()
  await p.mouse.move(5, 5)
  check((await lines(p)).length === 3, 'a picked part keeps its lines when the pointer leaves')
  check(!(await dim(p, 'catalog')), 'nothing stays quiet once the pointer leaves')
  await p.locator('.pt[data-id=shipping]').hover()
  check((await lines(p)).length === 0, 'pointing at another part shows that part\'s lines')
  await p.mouse.move(5, 5)
  check((await lines(p)).length === 3, 'the picked part\'s lines come back when the pointer leaves another part')
  await lv(p, 'overview')
  await p.mouse.move(5, 5)
  await p.locator('.sg[data-id=shop] .sg-h').hover()
  ls = await lines(p)
  check(ls.length === 4 && ls.every(l => l.shown && l.joins && l.headOn && (l.a === 'shop' || l.b === 'shop')), `at Overview the lines end on the block that holds the part (${JSON.stringify(ls)})`)
  await p.locator('.sg[data-id=billing] .sg-h').hover()
  check((await lines(p)).length === 0, 'a line inside one block is not drawn from that block')
  // At rest the main lines join the top-level blocks; "Show every line" brings out the rest.
  await p.mouse.move(5, 5)
  await lv(p, 'areas')
  const rest = await lines(p, '#sysRest path.ln')
  check(rest.length > 0 && rest.every(l => l.shown && l.joins && l.headOn && l.dash === 'none'), `at rest the main lines join their blocks (${JSON.stringify(rest)})`)
  await p.locator('[data-every]').click()
  const every = await lines(p, '#sysRest path.ln')
  check(every.length > rest.length && every.every(l => l.joins && l.headOn) && (await p.locator('[data-every]').getAttribute('aria-pressed')) === 'true', `"Show every line" draws every line (${every.length} vs ${rest.length})`)
  await p.locator('[data-every]').click()
  // A part picked at Parts, then hidden inside a closed block: its line to a part in the same block has nowhere to go.
  await lv(p, 'parts')
  await p.locator('.pt[data-id=invoices]').click()
  await lv(p, 'overview')
  await p.mouse.move(5, 5)
  check((await lines(p)).length === 0, 'a picked part whose only line stays inside its closed block draws no line')
  await lv(p, 'parts')
  await views(p, 'testing')
  check((await lines(p)).length === 1, 'Testing keeps the map and the picked part\'s line')
  check((await dim(p, 'catalog')) && !(await dim(p, 'refunds')) && !(await dim(p, 'faq')), 'Testing quiets the parts that are proved')
  await views(p, 'changes')
  check((await lines(p)).length === 1, 'Changes keeps the map and the picked part\'s line')
  await views(p, 'all')
  check((await lines(p)).length === 1 && (await lines(p))[0].joins && !(await dim(p, 'catalog')), 'All draws the picked part\'s line, with nothing quiet')
  // The key: pointing at a swatch keeps its parts lit.
  await p.locator('#sysFoot [data-key=tested]').hover()
  check(!(await dim(p, 'catalog')) && (await dim(p, 'refunds')), 'pointing at a swatch in the key keeps its parts lit')
  await p.mouse.move(5, 5)

  // Testing: the parts by how well they are proved, worst first.
  await views(p, 'testing')
  const order = ['failing', 'needs', 'changed', 'untested', 'now', 'tested', 'planned', 'change', 'exists'].filter(k => leaves.some(n => !n.outside && n.status.status === k))
  check(same(await p.$$eval('#sysView .ts', e => e.map(x => x.dataset.st)), order), `Testing orders its sections (${await p.$$eval('#sysView .ts', e => e.map(x => x.dataset.st))})`)
  for (const k of order) {
    const names = leaves.filter(n => !n.outside && n.status.status === k).map(n => n.name)
    const head = await p.locator(`#sysView .ts[data-st=${k}] h4`).textContent()
    check(head.includes(PANE_PART[k]) && head.includes(String(names.length)), `Testing counts ${PANE_PART[k]} (${head})`)
    check(same((await p.locator(`#sysView .ts[data-st=${k}] li`).allInnerTexts()).map(x => x.split('\n')[0]).sort(), names.sort()), `Testing lists the ${PANE_PART[k]} parts`)
  }
  check((await p.locator('#sysView .ts[data-st=tested]').innerText()).includes('npm test -- catalog (standard) at 09:12'), 'Testing says what proved a part')
  for (const n of leaves.filter(x => !x.outside)) {
    const row = await p.locator(`#sysView .ts-r[data-id=${n.id}]`).innerText()
    check(row.includes(trail[n.id].join(', ')), `Testing says where ${n.name} sits (${row.replace(/\n/g, ' | ')})`)
  }
  check(!(await p.locator('#sysView').innerText()).includes('Card company'), 'Testing leaves out the outside parts')
  await p.locator('#sysView .ts-r[data-id=faq]').click()
  check((await picked(p)) === 'FAQ', 'a Testing row picks its part')
  await views(p, 'changes')
  check((await p.locator('#sysView').innerText()).includes('Nothing has changed since you signed off'), 'Changes says when nothing changed')
  check(!(await p.locator('#sysViews [data-sv=changes] .cnt').count()), 'Changes has no count when nothing changed')
  await views(p, 'all')
  check(same(await ids(p), shown(99)) && !(await p.locator('#sysView').innerText()).trim(), 'All is back with every part and no list beside it')
  // Outline: the same map as a list, with the same openings.
  await p.locator('#sysLay [data-lay=outline]').click()
  check(!(await p.locator('#sysMain .pt').count()) && same(await ids(p), shown(99)), 'Outline lists every part')
  check((await p.locator('#sysMain .orow[data-id=refunds]').innerText()).includes(PANE_PART.changed), 'Outline says each part\'s status')
  await p.locator('#sysMain .orow[data-tog=orders]').click()
  check(!(await p.locator('#sysMain [data-id=refunds]').count()) && (await p.locator('#sysMain .orow[data-tog=orders]').getAttribute('aria-expanded')) === 'false', 'a block closes in Outline too')
  check(!(await p.locator('#sysRest path').count()) && !(await p.locator('#sysLn path').count()), 'Outline draws no lines')
  await p.context().close()

  // A narrow screen gets Outline, with no layout switch.
  p = await sopen('sysMid', '#system', { width: 390 })
  check((await p.locator('#sysMain .orow').count()) > 0 && !(await p.locator('#sysMain .pt').count()) && (await p.locator('#sysLay').isHidden()), 'a narrow screen uses Outline')
  await p.context().close()

  // The level and view are remembered on this computer.
  p = await sopen('sysMid', '#system')
  await lv(p, 'parts')
  await p.reload()
  await p.waitForFunction(() => document.body.dataset.state !== undefined)
  check((await p.locator('#sysLevel [data-lv=parts]').getAttribute('aria-pressed')) === 'true', 'the level is remembered')
  await p.context().close()

  // A new snapshot moves the statuses and keeps the pick and the level.
  p = await sopen('sysMid', '#system')
  await lv(p, 'parts')
  await p.locator('.pt[data-id=refunds]').click()
  write(VARIANTS.sysLater)
  await p.waitForFunction(() => /Tested/.test(document.querySelector('#sysMain .pt[data-id=invoices]')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => fails.push('a new snapshot moves Invoices to Tested'))
  check((await picked(p)) === 'Refunds' && (await p.locator('#sysLevel [data-lv=parts]').getAttribute('aria-pressed')) === 'true', 'a new snapshot keeps the pick and the level')
  check((await p.locator('#sysSum').innerText()).includes('Claude is in Tax'), 'the head follows Claude')
  write(VARIANTS.sysMid)
  await p.context().close()

  // A different plan forgets the openings, the pick and the view, and keeps the level.
  p = await sopen('sysMid', '#system')
  await lv(p, 'overview')
  await p.locator('.sg[data-id=billing] .sg-h').click()
  await views(p, 'testing')
  write(VARIANTS.sysOther)
  await p.waitForFunction(() => /Other shop/.test(document.getElementById('sysSum').textContent), null, { timeout: 6000 }).catch(() => fails.push('a different plan arrives'))
  check(same(await ids(p), shown(0)), `a different plan forgets the openings (${await ids(p)})`)
  check((await p.locator('#sysViews [data-sv=all]').getAttribute('aria-pressed')) === 'true' && (await picked(p)) === 'Invoices', `a different plan forgets the pick and the view (${await picked(p)})`)
  check((await p.locator('#sysLevel [data-lv=overview]').getAttribute('aria-pressed')) === 'true', 'a different plan keeps the level')
  write(VARIANTS.sysMid)
  await p.context().close()

  // A pick whose part has gone is forgotten, and does not come back with the part.
  p = await sopen('sysMid', '#system')
  await lv(p, 'parts')
  await p.locator('.pt[data-id=refunds]').click()
  write(VARIANTS.sysGone)
  await p.waitForFunction(() => !document.querySelector('#sysMain .pt[data-id=refunds]'), null, { timeout: 6000 }).catch(() => fails.push('a part leaves the map'))
  check((await picked(p)) === 'Invoices', 'a pick on a part that left is forgotten, and the panel follows Claude')
  write(VARIANTS.sysMid)
  await p.waitForFunction(() => !!document.querySelector('#sysMain .pt[data-id=refunds]'), null, { timeout: 6000 }).catch(() => fails.push('a part returns to the map'))
  check((await picked(p)) === 'Invoices', 'a part that returns is not picked again')
  await p.context().close()

  // Keyboard focus brings out a part's lines as the pointer does, and a resize redraws them where the cards moved to.
  p = await sopen('sysMid', '#system')
  await lv(p, 'parts')
  await p.mouse.move(5, 5)
  await p.locator('.pt[data-id=refunds]').focus()
  check((await lines(p)).length === 3, 'focusing a part draws its lines')
  await p.keyboard.press('Tab')
  await p.keyboard.press('Shift+Tab')
  check((await p.locator('.pt[data-id=refunds]').evaluate(e => e === document.activeElement && getComputedStyle(e).outlineStyle !== 'none')), 'a part reached from the keyboard shows a focus ring')
  await p.locator('.pt[data-id=refunds]').blur()
  ls = await lines(p)
  check(ls.length === 1 && ls[0].a === 'invoices', 'when focus leaves, the lines go back to the part Claude is in')
  await p.locator('.pt[data-id=refunds]').click()
  await p.mouse.move(5, 5)
  await p.setViewportSize({ width: 900, height: 900 })
  await p.waitForTimeout(200)
  ls = await lines(p)
  check(ls.length === 3 && ls.every(l => l.shown && l.joins && l.headOn), `after a resize the lines still join their parts head-on (${JSON.stringify(ls)})`)
  await p.context().close()

  // Motion: a changed map moves into place, and a line draws itself in. Reduced motion turns both off (the checks above).
  p = await open('sysMid', '#system')
  await p.evaluate(() => { window.__vt = 0; const go = document.startViewTransition.bind(document); document.startViewTransition = f => { window.__vt++; return go(f) } })
  await lv(p, 'parts')
  await p.waitForTimeout(500)
  check((await p.evaluate(() => window.__vt)) === 1, 'a level change moves the map into place')
  await p.mouse.move(5, 5)
  await p.locator('.pt[data-id=refunds]').hover()
  check((await p.$$eval('#sysLn path.lt.new', ls => ls.map(l => l.getAnimations().map(a => a.animationName).join()))).every(n => n === 'sy-draw') && (await p.locator('#sysLn path.lt.new').count()) === 3, 'a line drawn for the first time draws itself in')
  await p.locator('.pt[data-id=refunds]').click()
  await p.evaluate(() => { window.__vt = 0 })
  await p.locator('.pt[data-id=catalog]').click()
  check((await p.evaluate(() => window.__vt)) === 0, 'a pick changes the map in place without moving it')
  await p.context().close()

  // Changes: what differs from the map that was signed off.
  p = await sopen('sysChanges', '#system')
  await views(p, 'changes')
  const chg = await p.locator('#sysView').textContent()
  for (const want of ['Added', 'Receipts', 'Dropped', 'FAQ', 'Changed', 'Refunds', 'files', 'Staff', 'approve refunds', 'Buyers', 'ask for money back'])
    check(chg.includes(want), `Changes says "${want}"`)
  check((await p.locator('#sysViews [data-sv=changes] .cnt').innerText()) === '5', 'Changes counts its entries')
  await lv(p, 'parts')
  await p.locator('.pt[data-id=refunds]').hover()
  ls = await lines(p)
  check(ls.length >= 3 && ls.every(l => l.joins && l.headOn), `with the map changed, the lines still end head-on (${JSON.stringify(ls)})`)
  check((await p.locator('#sysFoot').innerText()).includes('Changed since sign-off'), 'the title block says the map changed since sign-off')
  await p.context().close()

  // The finish: parts left unfinished or unchecked are listed, and the plan stays green.
  p = await sopen('sysDone', '#system')
  const fin = flat(VARIANTS.sysDone.system.tree).filter(n => !n.kids.length)
  check(await p.locator('#sysFinish').isVisible(), 'a finished plan lists its loose ends')
  for (const [key, test] of [['not-finished', n => n.status?.tags.includes('not-finished')], ['not-rechecked', n => n.status?.tags.includes('not-rechecked')], ['untested', n => n.status?.status === 'untested']]) {
    const names = fin.filter(test).map(n => n.name).sort()
    const got = (await p.locator(`#sysFinish [data-fin=${key}] li`).allInnerTexts()).map(x => x.split('\n')[0]).sort()
    check(same(got, names), `the finish lists ${key} parts (${got} vs ${names})`)
  }
  check((await p.evaluate(() => document.body.dataset.state)) === 'done', 'untested parts keep the finish green')
  check((await picked(p)) === 'Nothing picked', 'with Claude nowhere and nothing picked, the panel says so')
  await p.context().close()
  p = await sopen('sysClean', '#system')
  const nothing = await p.locator('#sysFinish').textContent()
  check(nothing.includes('Nothing is left over') && nothing.includes('Every part was finished and tested'), 'a plan with nothing left over says so')
  await p.context().close()

  // Every status, group colour, tag and kind of evidence. The words and the order are checked once; the colours and shapes in
  // light and dark, against the page's own colour tokens.
  const eq = (what, got, want) => check(got === want, `${what} (${got} vs ${want})`)
  const STATUS = Object.keys(PANE_PART).filter(x => x !== 'outside')
  for (const dark of [false, true]) {
    const mode = dark ? 'dark' : 'light'
    p = await open('sysStatuses', '#system', { dark })
    await lv(p, 'parts')
    await p.waitForTimeout(600)
    if (!dark) {
      const out = VARIANTS.sysStatuses.system
      for (const k of STATUS) {
        const card = p.locator(`#sysMain .pt[data-id=s-${k}]`)
        check((await card.count()) === 1 && (await card.locator('.pt-f').innerText()).trim() === PANE_PART[k] && (await card.getAttribute('class')).includes(`k-${k}`), `${k} is drawn with "${PANE_PART[k]}"`)
      }
      for (const n of flat(out.tree).filter(x => x.roll)) eq(`${n.id} counts its parts like the pane`, await p.locator(`.sg[data-id=${n.id}] > .sg-h .sg-s`).innerText(), rollSay(n.roll))
      for (const g of Object.keys(PANE_TAG)) check((await p.locator(`#sysMain .pt[data-id=t-${g}]`).innerText()).includes(PANE_TAG[g]), `the tag ${g} says "${PANE_TAG[g]}"`)
      const seen = await p.locator('.pt[data-id=o-seen]').innerText()
      check(seen.includes('seen in ' + LONG_WHY.slice(0, 60)) && !seen.includes(LONG_WHY) && seen.includes('…'), `long evidence is cut (${seen.replace(/\n/g, ' | ')})`)
      check((await p.locator('.pt[data-id=o-said]').innerText()).includes('said by you: refunds go through the card company'), 'what you said is marked as said by you')
      const crowd = await p.locator('#sysSum').innerText()
      check(crowd.includes('Claude is in Part s-now, Part s-change and 1 more'), `the head names two parts and counts the rest (${crowd})`)
      await p.locator('.pt[data-id=n-note]').click()
      check((await side(p)).includes('Passed once, failed once'), 'the panel shows the note on a part')
      check(!(await p.locator('#sysNotes').innerText()).trim(), 'no notes when the drawing has none')
      // Testing: every section, worst first, each with its colour class, and a row picks its part.
      await views(p, 'testing')
      const order = ['failing', 'needs', 'changed', 'untested', 'now', 'tested', 'planned', 'change', 'exists']
      check(same(await p.$$eval('#sysView .ts', e => e.map(x => x.dataset.st)), order), `Testing orders every section (${await p.$$eval('#sysView .ts', e => e.map(x => x.dataset.st))})`)
      for (const k of order) check((await p.locator(`#sysView .ts[data-st=${k}]`).getAttribute('class')).includes(`k-${k}`), `the ${k} section carries its colour class`)
      check((await p.locator('#sysView .ts-r[data-id=s-failing]').innerText()).includes('Group red'), 'a Testing row says which group the part is in')
      await p.locator('#sysView .ts-r[data-id=s-needs]').click()
      check((await side(p)).includes('Part s-needs'), 'a Testing row picks its part')
      await views(p, 'all')
      await p.mouse.move(2, 2)
      await p.waitForTimeout(300)
    }
    const T = await p.evaluate(() => {
      const css = (el, pseudo) => getComputedStyle(el, pseudo)
      const tone = v => { const e = document.createElement('i'); e.style.color = `var(${v})`; document.body.append(e); const c = css(e).color; e.remove(); return c }
      const card = id => document.querySelector(`#sysMain .pt[data-id=${id}]`)
      const look = id => {
        const c = card(id), cs = css(c), box = c.querySelector('.pt-h .box'), m = css(box), a = css(box, '::after'), f = c.querySelector('.pt-f'), fs = css(f)
        return {
          border: cs.borderTopColor, style: cs.borderTopStyle, bg: cs.backgroundColor, img: cs.backgroundImage, words: css(f.firstElementChild).color, strike: css(c.querySelector('.pt-n')).textDecorationLine,
          mark: { bg: m.backgroundColor, img: m.backgroundImage, shadow: m.boxShadow, outline: m.outlineStyle, turn: m.transform, after: { content: a.content, bg: a.backgroundColor, round: a.borderTopLeftRadius, move: a.animationName, size: `${a.width}x${a.height}` } },
          foot: { icon: f.querySelector('use')?.getAttribute('href') || '', hatch: fs.backgroundImage.includes('repeating-linear-gradient') },
        }
      }
      const group = id => {
        const g = document.querySelector(`.sg[data-id=${id}]`), s = css(g), n = css(g.querySelector(':scope > .sg-h .sg-n'))
        return { edge: s.outlineColor, style: s.outlineStyle, wide: s.outlineWidth, bg: s.backgroundColor, say: css(g.querySelector(':scope > .sg-h .sg-s')).color, bold: n.fontWeight, name: n.color }
      }
      const cells = id => [...document.querySelectorAll(`.sg[data-id=${id}] > .sg-h .cells i`)].map(i => ({ cls: i.className, bg: css(i).backgroundColor }))
      const names = ['--red', '--red-fill', '--red-soft', '--amber', '--amber-fill', '--amber-soft', '--blue', '--blue-fill', '--blue-soft', '--green', '--ink', '--ink-2', '--ink-4', '--sunk', '--panel', '--hair-2']
      const cardIds = ['failing', 'needs', 'changed', 'untested', 'now', 'tested', 'planned', 'change', 'exists', 'dropped']
      return {
        W: Object.fromEntries(names.map(v => [v, tone(v)])),
        C: { ...Object.fromEntries(cardIds.map(k => [k, look('s-' + k)])), outside: look('o-seen') },
        G: Object.fromEntries(['red', 'amber', 'blue', 'green', 'dashed', 'plain', 'neutral'].map(g => [g, group('g-' + g)])),
        S: Object.fromEntries(['red', 'amber', 'blue', 'green', 'neutral'].map(g => [g, cells('g-' + g)])),
      }
    })
    const { W, C, G, S } = T
    // The card: its edge, its fill, its words.
    eq(`${mode}: a failing card's edge`, C.failing.border, W['--red'])
    check(C.failing.img.includes(W['--red-soft']), `${mode}: a failing card is washed red (${C.failing.img})`)
    eq(`${mode}: a needs-you card's edge`, C.needs.border, W['--amber-fill'])
    check(C.needs.img.includes(W['--amber-soft']), `${mode}: a needs-you card is washed amber`)
    eq(`${mode}: the card Claude is in: edge`, C.now.border, W['--blue-fill'])
    check(C.now.img.includes(W['--blue-soft']), `${mode}: the card Claude is in is washed blue`)
    eq(`${mode}: an already-there card's fill`, C.exists.bg, W['--sunk'])
    eq(`${mode}: a plain card's fill`, C.tested.bg, W['--panel'])
    for (const [k, c] of Object.entries(C)) eq(`${mode}: ${k} card edge style`, c.style, ['planned', 'dropped', 'outside'].includes(k) ? 'dashed' : 'solid')
    for (const [k, w] of [['failing', '--red'], ['needs', '--amber'], ['changed', '--ink-2'], ['untested', '--ink-2'], ['now', '--blue'], ['tested', '--green'], ['change', '--ink']]) eq(`${mode}: ${k} words`, C[k].words, W[w])
    for (const k of Object.keys(C)) check(C[k].strike.includes('line-through') === (k === 'dropped'), `${mode}: only a dropped part has its name struck through (${k}: ${C[k].strike})`)
    // The mark: a box that says whether it is built, and a foot that says how well it is proved. Each status has its own
    // pair, and the colour is never the only difference.
    for (const [k, w] of [['failing', '--red-fill'], ['needs', '--amber-fill'], ['now', '--blue-fill'], ['tested', '--ink'], ['untested', '--ink'], ['changed', '--ink']]) eq(`${mode}: ${k} box fill`, C[k].mark.bg, W[w])
    for (const k of ['planned', 'dropped', 'outside']) eq(`${mode}: ${k} box outline`, C[k].mark.outline, 'dashed')
    check(C.outside.mark.turn !== 'none' && C.planned.mark.turn === 'none', `${mode}: an outside part's box is turned`)
    check(C.dropped.mark.img.includes('linear-gradient') && C.planned.mark.img === 'none', `${mode}: a dropped part's box is struck through`)
    const drawn = m => m.after.content !== 'none' && m.after.content !== 'normal'
    for (const k of ['tested', 'untested', 'changed', 'failing', 'needs', 'now']) check(drawn(C[k].mark), `${mode}: ${k} has a drawn shape inside its box`)
    for (const k of ['planned', 'exists', 'change', 'dropped', 'outside']) check(!drawn(C[k].mark), `${mode}: ${k} has no shape inside its box`)
    eq(`${mode}: now spins`, C.now.mark.after.move, 'spin')
    check(C.failing.mark.after.size !== C.needs.mark.after.size, `${mode}: the failing and needs-you boxes carry different shapes (${C.failing.mark.after.size} vs ${C.needs.mark.after.size})`)
    for (const [k, icon] of [['tested', '#i-check'], ['failing', '#i-warn'], ['changed', '#i-pen'], ['change', '#i-pen'], ['needs', '#i-bell'], ['untested', ''], ['now', ''], ['exists', ''], ['planned', '']]) eq(`${mode}: ${k} foot icon`, C[k].foot.icon, icon)
    for (const k of Object.keys(C)) eq(`${mode}: ${k} foot hatched`, C[k].foot.hatch, ['untested', 'changed'].includes(k))
    const shape = c => JSON.stringify([c.mark.outline, c.mark.turn !== 'none', drawn(c.mark), c.mark.img !== 'none', c.foot.icon, c.foot.hatch])
    const kinds = Object.keys(C)
    for (const [i, a] of kinds.entries()) for (const b of kinds.slice(i + 1)) check(shape(C[a]) !== shape(C[b]), `${mode}: ${a} and ${b} differ in shape, not only colour`)
    // The group: its colour follows its tone, and plain and neutral differ by weight.
    for (const [g, edge, say] of [['red', '--red', '--red'], ['amber', '--amber-fill', '--amber'], ['blue', '--blue-fill', '--blue']]) {
      eq(`${mode}: a ${g} group's edge`, G[g].edge, W[edge])
      eq(`${mode}: a ${g} group's tally`, G[g].say, W[say])
      eq(`${mode}: a ${g} group's edge style`, G[g].style, 'solid')
    }
    eq(`${mode}: a green group's tally`, G.green.say, W['--green'])
    eq(`${mode}: a green group has no coloured edge`, G.green.style, 'none')
    eq(`${mode}: a group with nothing built has a dashed edge`, G.dashed.style, 'dashed')
    eq(`${mode}: a plain group's name`, G.plain.bold, '600')
    eq(`${mode}: a neutral group's name`, G.neutral.bold, '700')
    eq(`${mode}: a neutral group has no coloured edge`, G.neutral.style, 'none')
    check(new Set(Object.values(G).map(x => JSON.stringify(x))).size === 7, `${mode}: the seven group tones look different from one another`)
    // The cells on a group's header: one per part, in the part's colour.
    eq(`${mode}: the red group's cells`, S.red.map(c => c.cls).join(' '), 'fail need')
    eq(`${mode}: the red group's cell fills`, S.red.map(c => c.bg).join('|'), [W['--red-fill'], W['--amber-fill']].join('|'))
    eq(`${mode}: the amber group's cells`, S.amber.map(c => c.cls).join(' '), 'un un')
    eq(`${mode}: the green group's cell fill`, S.green[0].bg, W['--ink'])
    eq(`${mode}: the blue group's now cell`, S.blue[0].bg, W['--blue-fill'])
    check(![W['--red-fill'], W['--amber-fill'], W['--ink'], W['--blue-fill']].includes(S.blue[1].bg), `${mode}: a part not yet proved has a plain cell`)
    check(S.amber[0].bg !== S.green[0].bg && S.amber[0].bg !== S.blue[1].bg, `${mode}: built-but-untested cells differ from tested and from already-there`)
    eq(`${mode}: a cell for every part`, S.neutral.length, Object.keys(PANE_TAG).length + 1)
    await p.context().close()
  }

  // Words from the map are text, never markup, wherever they land.
  p = await sopen('sysNasty', '#system')
  await lv(p, 'parts')
  const quiet = async what => check(!(await p.evaluate(() => window.__pwn)) && (await p.locator('#sysp img').count()) === 0, `${what}: map words do not run as markup`)
  const typed = async (sel, what) => check((await p.locator(sel).first().textContent()).includes(HTML_BAIT), `${what} shows as typed`)
  await p.locator('.pt[data-id=shop]').click()
  await quiet('a part and its panel')
  for (const [sel, what] of [['#sysSide', 'the panel'], ['.sg[data-id=g] .sg-n', 'a group name'], ['#sysNotes', 'the drawing notes'], ['#sysFinish', 'the finish list'], ['#sysSum', 'the head'], ['.actor', 'a person']]) await typed(sel, what)
  await p.locator('.pt[data-id=ext]').click()
  await quiet('an outside part and its panel')
  await typed('#sysSide', 'an outside part\'s panel')
  await p.locator('.actor').click()
  await typed('#sysSide', 'a person\'s panel')
  await p.locator('.pt[data-id=shop]').hover()
  await quiet('the lines')
  if (await p.locator('#sysLbl .lbl').count()) await typed('#sysLbl', 'a line\'s label')
  await views(p, 'changes')
  await quiet('Changes')
  await typed('#sysView', 'Changes')
  await views(p, 'testing')
  await quiet('Testing')
  await typed('#sysView', 'Testing')
  await p.locator('#sysLay [data-lay=outline]').click()
  await quiet('Outline')
  await typed('#sysMain', 'Outline')
  await p.context().close()
}

// ---- history on the System page ----

async function historyPage() {
  const sys = VARIANTS.sysDrift.system, d = sys.drift
  const sopen = (v, h, o = {}) => open(v, h, { motion: false, ...o })
  const nameOf = id => flat(sys.tree).find(n => n.id === id).name
  const dim = (p, id) => p.locator(`#sysMain [data-id="${id}"]`).first().evaluate(e => e.classList.contains('dim'))
  const drifted = flat(sys.tree).filter(n => d.why[n.id]).map(n => n.id)
  const text = (p, sel) => p.locator(sel).innerText()

  // The banner: a row for each part that changed, with the reason git gave and the two things the user can do.
  let p = await sopen('sysDrift', '#system')
  check(await p.locator('#sysDrift').isVisible(), 'with no plan running, a map that drifted shows the banner')
  check((await text(p, '#sysDrift h3')) === '3 parts changed since the map was drawn', `the banner counts the parts (${await text(p, '#sysDrift h3')})`)
  check(same(await p.$$eval('#sysDrift [data-drift]', rows => rows.map(r => r.dataset.drift)), drifted), "a row for each part that changed, in the map's order")
  for (const id of drifted) {
    const row = p.locator(`#sysDrift [data-drift="${id}"]`), says = await row.innerText()
    check(says.includes(nameOf(id)) && says.includes(d.why[id]), `${id}: the row names the part and gives the reason (${says.replace(/\n/g, ' | ')})`)
    check((await row.locator('[data-redraw]').textContent()) === 'Redraw this area' && (await row.locator('[data-fine]').textContent()) === "It's fine", `${id}: Redraw this area and It's fine`)
  }
  const leads = await text(p, '#sysDrift .sy-leads')
  check(leads.includes('Files in no part') && d.loose.slice(0, 5).every(f => leads.includes(f)) && !leads.includes(d.loose[5]) && leads.includes('and 2 more'), `files in no part are listed and cut after five (${leads.replace(/\n/g, ' | ')})`)
  // Each button sends its message, and the banner says what it did.
  await p.locator('#sysDrift [data-drift=refunds] [data-redraw]').click()
  await sent('redraw', b => b.kind === 'redraw' && b.id === 'refunds' && Object.keys(b).length === 2)
  await p.waitForFunction(() => /Asked Claude/.test(document.querySelector('#sysDrift [role=status]')?.textContent ?? ''))
  check((await text(p, '#sysDrift [role=status]')).includes('Asked Claude to redraw Refunds'), `Redraw says it asked Claude (${await text(p, '#sysDrift [role=status]')})`)
  await p.locator('#sysDrift [data-drift=faq] [data-fine]').click()
  await sent('fine', b => b.kind === 'fine' && b.id === 'faq' && Object.keys(b).length === 2)
  await p.waitForFunction(() => /Marked/.test(document.querySelector('#sysDrift [role=status]')?.textContent ?? ''))
  check((await text(p, '#sysDrift [role=status]')).includes('Marked FAQ as fine'), `It's fine says so (${await text(p, '#sysDrift [role=status]')})`)
  await p.context().close()

  // A long list is cut after five rows.
  p = await sopen('sysDriftMany', '#system')
  check((await p.locator('#sysDrift [data-drift]').count()) === 5 && (await text(p, '#sysDrift')).includes('and 2 more'), 'a long list is cut after five rows, and says how many it left out')
  check((await text(p, '#sysDrift h3')) === '7 parts changed since the map was drawn', 'the banner still counts all of them')
  await p.context().close()

  // Nothing changed, or no update check ran: no banner. No git: the page says nothing was compared, and offers nothing.
  for (const v of ['sysQuiet', 'sysMid']) {
    p = await sopen(v, '#system')
    check((await p.locator('#sysDrift').isHidden()) && (await p.locator('#sysPlans').isHidden()), `${v}: neither the banner nor the past plans show`)
    await p.context().close()
  }
  p = await sopen('sysNoGit', '#system')
  const nogit = await text(p, '#sysDrift')
  check((await p.locator('#sysDrift').isVisible()) && nogit.includes("No git here, so Sentinel can't tell what changed since the map was drawn.") && !/\d parts? changed/.test(nogit) && !(await p.locator('#sysDrift [data-redraw]').count()), `with no git the banner says nothing was compared (${nogit.replace(/\n/g, ' | ')})`)
  await p.context().close()

  // The panel offers the two buttons on a part that is marked and on an area that holds one, and on nothing else.
  p = await sopen('sysDrift', '#system')
  await p.locator('#sysLevel [data-lv=parts]').click()
  await p.locator('.pt[data-id=refunds]').click()
  const panel = await text(p, '#sysSide')
  check(panel.includes(d.why.refunds) && (await p.locator('#sysSide [data-redraw=refunds]').count()) === 1 && (await p.locator('#sysSide [data-fine=refunds]').count()) === 1, `a marked part's panel gives the reason and both buttons (${panel.replace(/\n/g, ' | ')})`)
  await p.locator('.pt[data-id=catalog]').click()
  check(!(await p.locator('#sysSide [data-redraw]').count()) && !(await p.locator('#sysSide [data-fine]').count()), 'a part nothing marked offers neither button')
  await p.locator('.sg[data-id=orders] > .sg-h').click()
  check((await p.locator('#sysSide [data-redraw=orders]').count()) === 1 && (await p.locator('#sysSide [data-fine=orders]').count()) === 1, 'an area that holds a marked part offers both')
  await p.locator('#sysSide [data-redraw=orders]').click()
  await sent('redraw an area', b => b.kind === 'redraw' && b.id === 'orders')
  // Opening the area again, so its parts are on the map for what follows.
  await p.locator('.sg[data-id=orders] > .sg-h').click()

  // Past plans, newest first. Pointing at one, or focusing it, lights the parts it built.
  const plans = await p.locator('#sysPlans li').allInnerTexts()
  check(plans.length === 2 && plans[0].includes('Try a new invoice layout') && plans[0].includes('closed early 3 Nov 2026') && plans[0].includes('Invoices'), `the newest plan is first, closed early (${plans[0]?.replace(/\n/g, ' | ')})`)
  check(plans[1]?.includes('Add refunds') && plans[1].includes('finished 28 Oct 2026') && plans[1].includes('Refunds') && plans[1].includes('Card company'), `the older plan names what it built (${plans[1]?.replace(/\n/g, ' | ')})`)
  await p.locator('#sysPlans [data-plan="1"]').hover()
  check(!(await dim(p, 'refunds')) && !(await dim(p, 'cards')) && (await dim(p, 'catalog')) && (await dim(p, 'invoices')), 'pointing at a plan lights the parts it built and dims the rest')
  await p.mouse.move(2, 2)
  check(!(await dim(p, 'catalog')) && !(await dim(p, 'invoices')), 'moving off the plan lights everything again')
  await p.locator('#sysPlans [data-plan="0"]').focus()
  check(!(await dim(p, 'invoices')) && (await dim(p, 'refunds')), 'focusing a plan with the keyboard does the same')
  await p.locator('#sysPlans [data-plan="0"]').blur()
  check(!(await dim(p, 'refunds')), 'leaving it lights everything again')
  await p.context().close()

  // A short window: the side column scrolls, and no card in it is cut short.
  p = await sopen('sysDrift', '#system', { height: 600 })
  await p.locator('#sysLevel [data-lv=parts]').click()
  await p.locator('.pt[data-id=refunds]').click()
  const cut = await p.$$eval('#sysAside > :not([hidden]):not(:empty)', els => els.filter(e => e.scrollHeight > e.clientHeight + 1).map(e => e.id))
  const scrolls = await p.locator('#sysAside').evaluate(a => a.scrollHeight > a.clientHeight)
  check(scrolls && !cut.length, `a short window scrolls the side column and cuts no card (cut: ${cut.join(', ') || 'none'}${scrolls ? '' : ', and nothing to scroll'})`)
  await p.context().close()

  // Words from git and from plans.json are text, never markup.
  p = await sopen('sysDriftNasty', '#system')
  check(!(await p.evaluate(() => window.__pwn)) && (await p.locator('#sysp img').count()) === 0, 'update-check and plan words do not run as markup')
  check((await p.locator('#sysDrift').textContent()).includes(HTML_BAIT) && (await p.locator('#sysPlans').textContent()).includes(HTML_BAIT), 'they show as typed')
  await p.context().close()

  // The first map: plain boxes for the folders no part reaches, with their counts, and the keys nothing names.
  p = await sopen('sysFirst', '#system')
  const first = await text(p, '#sysFirst')
  check((await p.locator('#sysFirst').isVisible()) && first.includes('Not mapped yet') && same(await p.$$eval('#sysFirst [data-folder]', r => r.map(x => x.dataset.folder)), ['billing', 'docs']), `folders no part reaches show as boxes (${first.replace(/\n/g, ' | ')})`)
  check(first.includes('billing/') && first.includes('14 files') && first.includes('1 file') && !first.includes('1 files'), 'each box gives the folder and its file count')
  check(first.includes('Not placed yet') && first.includes('STRIPE_API_URL') && first.includes('REDIS_HOST') && first.includes('Nothing is drawn from them'), 'the keys nothing names are listed, with what to do about them')
  await p.context().close()
  p = await sopen('sysFirstMany', '#system')
  const many = await text(p, '#sysFirst')
  check((await p.locator('#sysFirst [data-folder]').count()) === 12 && many.includes('and 3 more folders') && many.includes('K7_URL') && !many.includes('K8_URL') && many.includes('and 3 more'), `long lists are cut and say how many they left out (${many.replace(/\n/g, ' | ')})`)
  await p.context().close()
  for (const v of ['sysQuiet', 'sysMid', 'sysDrift']) {
    p = await sopen(v, '#system')
    check(await p.locator('#sysFirst').isHidden(), `${v}: with nothing to list, the first-map panel is hidden`)
    await p.context().close()
  }
  p = await sopen('sysFirstNasty', '#system')
  check(!(await p.evaluate(() => window.__pwn)) && (await p.locator('#sysp img').count()) === 0 && (await p.locator('#sysFirst').textContent()).includes(HTML_BAIT), 'folder and key words show as typed, never as markup')
  await p.context().close()
}

// ---- the Tasks level on the System page ----
// How it can fail: the Tasks button is missing or not pressed; a part lacks the name of the state that builds it; a state
// that builds no part is missing from the row above the map, or one that builds a part is in it; a state's name runs as markup.
async function tasksPage() {
  const p = await open('sysTasks', '#system', { motion: false })
  await p.locator('#sysLevel [data-lv=tasks]').click()
  check((await p.locator('#sysLevel [data-lv=tasks]').getAttribute('aria-pressed')) === 'true', 'the Tasks level is pressed')
  const tags = id => p.locator(`#sysMain .pt[data-id=${id}] .pt-k .mini`).allInnerTexts()
  check(same(await tags('guide'), ['Guide']) && same(await tags('faq'), ['Guide']) && same(await tags('refunds'), ['Refunds']), `a part carries the name of the state that builds it (${await tags('guide')})`)
  const strip = await p.locator('#sysMain .sy-loose').innerText()
  check(strip.includes('Full suite') && strip.includes('Read the shop code') && !strip.includes('Refunds'), `only the states that build no part are in the row above the map (${strip.replace(/\n/g, ' | ')})`)
  const bait = p.locator('#sysMain .pt[data-id=catalog] .pt-k .mini')
  check(!(await p.evaluate(() => window.__pwn)) && (await p.locator('#sysp img').count()) === 0 && (await bait.getAttribute('title')) === HTML_BAIT && (await bait.innerText()).startsWith('<img'), "a state's name shows as typed")
  await p.context().close()
}

// ---- usage ----

async function usagePage() {
  let p = await open('usageRun', '')
  // By its label, as a share's words name the week too.
  const fd = name => p.locator('#fields .fd', { has: p.locator('.label', { hasText: name }) })
  check((await fd('Week').innerText()).includes('52%'), 'the Run page shows the week')
  check((await fd('5 hours').innerText()).includes('23%'), 'the Run page shows the 5 hours when reported')
  // The cost for the plan and each step always shows; the share of the week joins it once known.
  const plan = await fd('This plan').innerText()
  check(plan.includes('$4.20') && plan.includes('about 1.4% of your week'), `the Run page shows the plan's cost and share (${plan})`)
  for (const word of ['Resets', 'Was 50% when you signed off', 'every session']) check((await fd('Week').getAttribute('title')).includes(word), `the week's hover says ${word}`)
  check((await fd('This plan').getAttribute('title')).includes('API prices'), "the plan's hover says what the cost is")
  await p.context().close()
  p = await open('usageRun', '#task-pay')
  const pay = await p.locator('.fd', { hasText: 'Used' }).innerText()
  check(pay.includes('$1.75') && pay.includes('about 0.6% of your week'), `a step page shows its cost and share (${pay})`)
  await p.context().close()
  p = await open('usageRun', '#task-refund')
  const est = await p.locator('.fd', { hasText: 'Used' }).innerText()
  check(est.includes('$0.40') && !est.includes('of your week') && !/estimating/i.test(est), `a step with no share yet shows its cost alone (${est})`)
  await p.context().close()
  p = await open('usageNoShare', '')
  check((await p.locator('#fields .fd', { hasText: '5 hours' }).count()) === 0, 'no 5 hours when it is not reported')
  const first = p.locator('#fields .fd', { hasText: 'This plan' })
  check((await first.innerText()).includes('$0.01') && !/estimating/i.test(await first.innerText()), 'the plan shows its cost before the share is known')
  check((await first.getAttribute('title')).includes('moved by 1%'), 'the hover says when the share will show')
  await p.context().close()
  p = await open('usageNoLimits', '')
  check((await p.locator('#fields .fd .label', { hasText: 'Week' }).count()) === 0 && (await p.locator('#fields .fd', { hasText: 'This plan' }).innerText()).includes('$3.10'), 'with no limits reported the cost for the plan and each step still shows')
  await p.context().close()
  p = await open('proofRun', '')
  check((await p.locator('#fields .fd', { hasText: 'Week' }).count()) === 0, 'no figures, nothing shows')
  await p.context().close()
}

// ---- group boxes on the Map of a parallel plan ----

async function groupedMap() {
  const measure = pg => pg.evaluate(() => {
    const rect = e => e.getBoundingClientRect()
    const cards = [...document.querySelectorAll('#v-map .mcard')], frames = [...document.querySelectorAll('#v-map svg rect.fr')].map(rect)
    const labels = [...document.querySelectorAll('#v-map .mgl')]
    const crossing = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const lines = [...document.querySelectorAll('#v-map svg path.ar')], under = []
    for (const l of lines) {
      const m = l.getScreenCTM()
      for (let i = 3; i < l.getTotalLength() - 3; i += 3) {
        const q = l.getPointAtLength(i), x = q.x * m.a + m.e, y = q.y * m.d + m.f
        if (cards.some(c => { const r = rect(c); return x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2 })) { under.push(`${l.dataset.a}>${l.dataset.b}`); break }
      }
    }
    return {
      frames: frames.length,
      crossed: frames.flatMap((a, i) => frames.slice(i + 1).filter(b => crossing(a, b))).length,
      gap: Math.min(...frames.flatMap((a, i) => frames.slice(i + 1).map(b => Math.max(b.top - a.bottom, a.top - b.bottom, b.left - a.right, a.left - b.right)))),
      // How many frames each card sits in, and each name is clear of every card.
      homes: cards.filter(c => c.dataset.task).map(c => frames.filter(f => crossing(rect(c), f)).length),
      hidden: labels.filter(l => cards.some(c => crossing(rect(l), rect(c)))).map(l => l.textContent),
      names: labels.map(l => l.firstChild.textContent),
      over: cards.flatMap(c => [...c.querySelectorAll('.t1, .t3, .t3 > *, .idt, .lb')].filter(e => rect(e).right > rect(c).right - 1).map(e => e.textContent)),
      cutIds: cards.filter(c => { const i = c.querySelector('.idt'); return i && i.scrollWidth > i.clientWidth }).map(c => c.dataset.task),
      waits: cards.map(c => c.querySelector('.t3')?.textContent ?? '').find(t => t.includes(' and ')),
      tips: cards.map(c => c.title).filter(t => t.includes('Waits for')),
      tops: new Set(cards.map(c => Math.round(rect(c).top))).size,
      between: frames.length > 1 ? frames[1].top - frames[0].bottom : null,
      overlapped: cards.flatMap((a, i) => cards.slice(i + 1).filter(b => crossing(rect(a), rect(b)))).length,
      blurred: cards.filter(c => parseFloat(getComputedStyle(c).top) % 1).length,
      // How high each line runs as it passes under the middle of the second card.
      passing: (() => {
        const c = rect(cards[1]), mid = (c.left + c.right) / 2
        return lines.map(l => {
          const m = l.getScreenCTM()
          for (let i = 0; i < l.getTotalLength(); i += 2) { const q = l.getPointAtLength(i); if (Math.abs(q.x * m.a + m.e - mid) < 2) return q.y * m.d + m.f }
        }).filter(y => y !== undefined && y > c.bottom)
      })(),
      under,
    }
  })
  for (const dark of [false, true]) {
    const p = await open('groupedGraph', '', dark ? { dark } : undefined)
    await p.locator('#viewSeg [data-v=map]').click()
    const m = await measure(p)
    const at = dark ? 'the grouped Map, dark,' : 'the grouped Map'
    check(m.frames === 3, `${at} has its three group boxes (${m.frames})`)
    check(m.crossed === 0 && m.gap >= 10, `${at}: no group box crosses another (${m.crossed} crossed, ${m.gap}px apart)`)
    check(m.homes.every(n => n === 1), `${at}: each step sits in one box (${m.homes.join()})`)
    check(!m.hidden.length, `${at}: a card hides no group's name (${m.hidden.join()})`)
    check(m.names.join() === 'Usage,Tabs,Finish', `${at}: group names have capitals (${m.names.join()})`)
    check(!m.over.length, `${at}: no text runs out of a card (${m.over.join(' | ')})`)
    check(!m.cutIds.length, `${at}: no step's name is cut short (${m.cutIds.join()})`)
    check(m.tips.some(t => t.includes('Waits for tabs-open and usage-display')), `${at}: the hover has what the card shortens (${m.waits})`)
    check(!m.under.length, `${at}: no line runs under a card (${m.under.join()})`)
    check(m.between >= 10 && m.between <= 30, `${at}: a passing line leaves no empty row (${m.between}px between the boxes)`)
    if (shots) await p.screenshot({ path: join(shots, `grouped${dark ? '-dark' : ''}.png`), fullPage: true })
    await p.context().close()
  }
  const p = await open('lineGraph', '')
  await p.locator('#viewSeg [data-v=map]').click()
  const m = await measure(p)
  check(m.frames === 3 && m.crossed === 0, 'groups in a line have their boxes')
  check(m.tops === 1, `groups in a line stay on one row (${m.tops} rows)`)
  await p.context().close()
  const q = await open('cornerGraph', '')
  await q.locator('#viewSeg [data-v=map]').click()
  const n = await measure(q)
  check(n.frames === 3 && n.crossed === 0 && n.homes.every(x => x === 1), `a step stays out of another group's empty corner (${n.homes.join()})`)
  check(n.gap >= 10, `group boxes one above the other keep apart (${n.gap}px)`)
  await q.context().close()
  const t = await open('twoLinesGraph', '')
  await t.locator('#viewSeg [data-v=map]').click()
  const two = await measure(t)
  check(!two.under.length && two.crossed === 0, `two lines pass under one card (${two.under.join()}, ${two.crossed} crossed)`)
  check(two.between >= 10 && two.between <= 40, `the boxes make room for both, and no more (${two.between}px)`)
  check(two.passing.length === 2 && Math.abs(two.passing[0] - two.passing[1]) >= 6, `the two lines run apart (${two.passing.join()})`)
  check(!two.blurred, `cards land on whole pixels (${two.blurred} do not)`)
  await t.context().close()

  // Many shapes of plan, from a fixed seed: boxes never cross, cards never meet, and no line runs under a card.
  const rng = (seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)(7)
  const pick = n => Math.floor(rng() * n)
  const f = await open('graph', '')
  await f.locator('#viewSeg [data-v=map]').click()
  const wrong = []
  for (let k = 0; k < 60; k++) {
    const n = 5 + pick(10), parts = pick(5), states = []
    let g = 0
    for (let i = 0; i < n; i++) {
      if (parts && i && rng() < parts / n) g++
      const needs = new Set()
      for (let tries = pick(4); i && tries > 0; tries--) needs.add(`s${pick(i)}`)
      states.push({ ...step(`s${i}`, ...needs), ...(parts ? { group: `g${g}` } : {}) })
    }
    const vm = page(act({ ...emptyRun(), signedOff: true }, { action: 'define', title: `Shape ${k}`, states }, '', {}, now).run, { parallel: true })
    write(vm)
    await f.evaluate(v => { window.__sentinel(v); return new Promise(requestAnimationFrame) }, vm)
    await f.waitForFunction(id => document.querySelectorAll('#v-map .mcard[data-task]').length === id, n)
    const s = await measure(f)
    const fault = [s.crossed && `${s.crossed} boxes crossed`, s.overlapped && `${s.overlapped} cards met`, s.under.length && `lines under cards: ${s.under.join()}`, parts && s.homes.some(x => x !== 1) && `cards in the wrong box: ${s.homes.join()}`].filter(Boolean)
    if (fault.length) wrong.push(`shape ${k} (${n} steps, ${JSON.stringify(states.map(x => [x.id, x.needs, x.group]))}): ${fault.join('; ')}`)
  }
  check(!wrong.length, `every shape of plan lays out clean (${wrong.length} wrong: ${wrong.slice(0, 2).join(' | ')})`)
  await f.context().close()
}

// ---- the project tabs ----

async function hubPage() {
  const HUB = fileURLToPath(new URL('../web/hub.mjs', import.meta.url)), SERVE = fileURLToPath(new URL('../web/serve.mjs', import.meta.url))
  const free = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const at = s.address().port; s.close(() => ok(at)) }) })
  const hubPort = await free()
  const log = join(dir, 'opened.log'), opener = join(dir, 'opener.mjs')
  writeFileSync(opener, "import { appendFileSync } from 'node:fs'\nappendFileSync(process.argv[2], process.argv[3] + '\\n')\n")
  const env = { ...process.env, SENTINEL_HUB_PORT: String(hubPort), SENTINEL_HUB_CHECK_MS: '100', SENTINEL_HUB_OPENER: JSON.stringify([process.execPath, opener, log]) }
  const running = []
  const helper = async vm => {
    const state = join(dir, `state-${running.length}.js`)
    const put = v => writeFileSync(state, `window.__sentinel && window.__sentinel(${JSON.stringify(v)})\n`)
    put(vm)
    const child = spawn(process.execPath, [SERVE], { env: { ...env, SENTINEL_PAGE: fileURLToPath(PAGE), SENTINEL_STATE: state }, stdio: ['ignore', 'pipe', 'inherit'] })
    running.push(child)
    const { port, token } = await new Promise(res => createInterface({ input: child.stdout }).once('line', l => res(JSON.parse(l))))
    return { port, token, put, child, url: `http://127.0.0.1:${port}/?k=${token}` }
  }
  const hub = spawn(process.execPath, [HUB], { env, stdio: 'ignore' })
  running.push(hub)
  const openTab = (s, name) => new Promise(ok => spawn(process.execPath, [HUB, 'open'], { env: { ...env, SENTINEL_TAB_PORT: String(s.port), SENTINEL_TAB_TOKEN: s.token, SENTINEL_TAB_NAME: name }, stdio: 'ignore' }).once('exit', ok))
  const opened = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  const a = await helper(VARIANTS.proofRun), b = await helper(VARIANTS.proofRun), stranger = await helper(VARIANTS.blocked)

  try {
    // The first session opens the browser, on the hub, with no session token in the address.
    const soon = async (ok, what, ms = 7000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await ok()) return true
      fails.push(`${what} did not happen`)
      return false
    }
    check((await openTab(a, 'shop')) === 0, 'the open command says it worked')
    await soon(() => opened().length, 'the first session opening the browser')
    const line = opened()[0]
    check(new URL(line).hash === `#${a.port}`, 'the address names the first tab')
    check(!line.includes(a.token), 'no session token in the address')

    const newPage = async (opts = {}) => {
      const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: 'reduce' })
      // Records notifications, here and in the frames, where none should fire.
      await ctx.addInitScript(() => {
        window.__notes = []
        window.Notification = class { static permission = 'granted'; constructor(title, o) { window.__notes.push({ title, ...o }) } close() {} }
      })
      const pg = await ctx.newPage()
      pg.setDefaultTimeout(7000)
      await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }))
      pg.on('console', m => { if (m.type() === 'error' && !pg.sendsFail) errors.push(`hub: ${m.text()}`) })
      pg.on('pageerror', e => errors.push(`hub: ${e.message}`))
      await pg.goto(line)
      return pg
    }
    const p = await newPage()
    const tab = name => p.locator('[role=tab]', { hasText: name })
    const names = () => p.$$eval('[role=tab] .name', ts => ts.map(t => t.textContent))
    const chosen = () => p.$eval('[role=tab][aria-selected=true] .name', t => t.textContent)
    const word = async name => ((await tab(name).locator('.st').isHidden()) ? '' : tab(name).locator('.st').innerText())
    const frame = s => p.frames().find(f => f.url().startsWith(`http://127.0.0.1:${s.port}/`))
    const shown = () => p.locator('iframe.on').getAttribute('src')

    await soon(async () => (await names()).join() === 'Shop', 'the first tab showing')
    check((await shown()) === a.url, 'the first tab shows its session')
    await soon(() => frame(a)?.locator('#themeBtn').isVisible(), "the session's page showing in its frame")
    check(await p.locator('#bell').isVisible(), 'the bar has the bell')

    // A second session adds a tab and the page moves to it, with no new browser tab.
    await openTab(b, 'blog')
    await soon(async () => (await names()).join() === 'Shop,Blog', 'the second tab showing')
    await soon(async () => (await chosen()) === 'Blog', 'the page moving to the new tab')
    check((await shown()) === b.url, 'the new tab shows its session')
    check(opened().length === 1, 'the second session opens no second browser tab')

    // Switching, by mouse and by keys, and the address keeps up.
    await tab('shop').click()
    check((await chosen()) === 'Shop' && (await shown()) === a.url, 'a click switches tab')
    await tab('blog').click()
    check(new URL(p.url()).hash === `#${b.port}`, 'the address follows the tab')
    await tab('shop').click()
    check(await p.locator(`iframe[src="${b.url}"]`).evaluate(f => getComputedStyle(f).visibility === 'hidden'), 'the other frame is hidden')
    await tab('shop').focus()
    await p.keyboard.press('ArrowRight')
    check((await chosen()) === 'Blog', 'the arrow key moves on')
    await p.keyboard.press('ArrowRight')
    check((await chosen()) === 'Shop', 'the arrow key wraps round')

    // Status: the word on the tab and the browser tab's title. No notification for the tab you are on.
    a.put(VARIANTS.blocked)
    await soon(async () => (await word('shop')) === 'Needs you', "the tab's word")
    await soon(async () => (await p.title()) === 'Needs you · Sentinel', "the browser tab's title")
    check((await p.locator('#fav').getAttribute('href')).includes('f4b223'), 'the icon gets its plate')
    check((await word('blog')) === '', 'the quiet tab has no word')
    check(await frame(a).locator('#bellBtn').isHidden(), 'the page in a frame has no bell, once it is live')
    check((await p.evaluate(() => window.__notes.length)) === 0, 'no notification for the tab you are on')

    // On another tab it does, once, on the bar.
    b.put(VARIANTS.blocked)
    await soon(async () => (await word('blog')) === 'Needs you', "the other tab's word")
    await soon(async () => (await p.evaluate(() => window.__notes.length)) === 1, 'a notification for another tab')
    const [note] = await p.evaluate(() => window.__notes)
    check(note?.title.startsWith('Blog · Needs you') && note?.tag === `sentinel-${b.port}`, `the notification names the project (${JSON.stringify(note)})`)
    check((await frame(b).evaluate(() => window.__notes.length)) === 0, 'the page in a frame raises none itself')
    b.put(VARIANTS.closedDone)
    await soon(async () => (await word('blog')) === 'Done', 'the Done word')
    a.put(VARIANTS.proofRun)
    await soon(async () => (await word('shop')) === '', 'the word going')
    await soon(async () => (await p.title()) === 'Sentinel', 'the title going back')
    check(!(await p.locator('#fav').getAttribute('href')).includes('f4b223'), 'the plate going')
    b.put(VARIANTS.proofRun)
    await soon(async () => (await word('blog')) === '', "the other tab's word going")
    // A flow Claude drafted waits for you too, with or without a plan.
    a.put({ ...VARIANTS.light, flowDraft: VARIANTS.insDraft.flowDraft })
    await soon(async () => (await word('shop')) === 'Needs you', 'the word for a drafted flow with no plan')
    a.put(VARIANTS.proofRun)
    await soon(async () => (await word('shop')) === '', 'the word going after the flow')
    a.put({ ...VARIANTS.proofRun, flowDraft: VARIANTS.insDraft.flowDraft })
    await soon(async () => (await word('shop')) === 'Needs you', 'the word for a drafted flow during a plan')
    a.put(VARIANTS.proofRun)
    await soon(async () => (await word('shop')) === '', 'the word going after that flow')
    // A session with no plan can still have a question.
    a.put({ ...VARIANTS.light, ask: { id: 'q1', questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] } })
    await soon(async () => (await word('shop')) === 'Needs you', 'the word for a question with no plan')
    a.put(VARIANTS.proofRun)
    await soon(async () => (await word('shop')) === '', 'the word going after the question')

    // The theme goes across, and stays after a reload, from a pick made in any one frame.
    const themeOf = s => frame(s).evaluate(() => document.documentElement.dataset.theme)
    const barTheme = () => p.evaluate(() => document.documentElement.dataset.theme)
    check((await barTheme()) === 'light', 'the bar starts on the system theme')
    await frame(a).locator('#themeBtn').click()
    await soon(async () => (await barTheme()) === 'dark', 'the bar taking the theme')
    await soon(async () => (await themeOf(b)) === 'dark', 'the other frame taking the theme')
    // shop is not the last to ask for the page, so only the address can bring it back.
    await p.reload()
    await soon(async () => (await names()).join() === 'Shop,Blog', 'the tabs after a reload')
    check((await chosen()) === 'Shop', 'a reload stays on the tab')
    await soon(async () => (await barTheme()) === 'dark' && (await frame(b)?.locator('#themeBtn').isVisible()) && (await themeOf(b)) === 'dark', 'the theme after a reload')
    await tab('blog').click()
    await frame(b).locator('#themeBtn').click()
    await soon(async () => (await barTheme()) === 'light' && (await themeOf(a)) === 'light', 'the theme coming back')

    // Messages from anything but a tab's own frame are ignored.
    await p.evaluate(() => postMessage({ kind: 'stuck', plan: 'x', theme: 'dark', note: { title: 'x', body: 'x' } }, '*'))
    await p.evaluate(url => { const f = document.createElement('iframe'); f.id = 'stranger'; f.src = url; document.getElementById('frames').append(f) }, stranger.url)
    await soon(async () => /Needs you/.test((await frame(stranger)?.title()) ?? ''), "the stranger's page saying it needs you")
    await new Promise(r => setTimeout(r, 200))
    check((await p.title()) === 'Sentinel', 'a stranger cannot change the title')
    check((await word('shop')) === '' && (await word('blog')) === '', 'a stranger cannot change a tab')
    check((await barTheme()) === 'light', 'a stranger cannot change the theme')
    check((await p.evaluate(() => window.__notes.length)) === 0, 'a stranger cannot raise a notification')
    await p.evaluate(() => document.getElementById('stranger').remove())
    // A frame that has gone somewhere else no longer speaks for its tab.
    await p.evaluate(([from, to]) => { document.querySelector(`iframe[src="${from}"]`).src = to }, [b.url, stranger.url])
    await soon(async () => /Needs you/.test((await frame(stranger)?.title()) ?? ''), 'the frame showing somewhere else')
    await new Promise(r => setTimeout(r, 200))
    check((await p.title()) === 'Sentinel' && (await word('blog')) === '', 'a frame that left cannot change its tab')
    await p.evaluate(([from, to]) => { document.querySelector(`iframe[src="${from}"]`).src = to }, [stranger.url, b.url])
    await soon(() => frame(b)?.locator('#themeBtn').isVisible(), 'the frame coming back')
    // And a page takes the theme only from the bar.
    await frame(a).evaluate(() => postMessage({ theme: 'dark' }, '*'))
    await new Promise(r => setTimeout(r, 100))
    check((await themeOf(a)) === 'light', 'a page ignores a theme from anything but the bar')

    // A session that ends takes its tab, and the page moves off it.
    await tab('blog').click()
    p.sendsFail = true
    b.child.kill()
    await soon(async () => (await names()).join() === 'Shop', 'the tab going with its session')
    check((await chosen()) === 'Shop' && (await shown()) === a.url, 'the page moves off a tab that went')
    p.sendsFail = false

    // A new token for the same port loads the frame again.
    const blank = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title>') })
    await new Promise(ok => blank.listen(0, '127.0.0.1', ok))
    const other = { port: blank.address().port, token: 'c'.repeat(32) }
    await openTab(other, 'other')
    await soon(async () => (await names()).length === 2, 'the other tab')
    await openTab({ ...other, token: 'd'.repeat(32) }, 'renamed')
    await soon(async () => (await names()).join() === 'Shop,Renamed', 'the tab taking its new name')
    check(await p.locator(`iframe[src$="${'d'.repeat(32)}"]`).count() === 1, 'the frame takes the new token')

    // Closing: a tab has a close button, the next tab takes its place, and the session's next open brings it back.
    const box = name => p.locator('.tab', { hasText: name })
    const closer = name => box(name).locator('.x')
    const openedBefore = opened().length
    check((await closer('Renamed').getAttribute('aria-label')) === 'Close Renamed', 'the close button says what it closes')
    await tab('Shop').click()
    await p.mouse.move(700, 500)
    const seen = l => l.evaluate(e => getComputedStyle(e).opacity)
    check((await seen(closer('Renamed'))) === '0' && (await seen(closer('Shop'))) === '1', 'a close button shows on the tab you are on')
    await box('Renamed').hover()
    check((await seen(closer('Renamed'))) === '1', 'and on the tab you point at')
    await tab('Renamed').click()
    await closer('Renamed').click()
    await soon(async () => (await names()).join() === 'Shop', 'the close button closing the tab')
    check((await chosen()) === 'Shop' && (await shown()) === a.url, 'the page moves to the tab next to it')
    check(await a.child.exitCode === null, 'the session carries on')
    await openTab(other, 'renamed')
    await soon(async () => (await names()).join() === 'Shop,Renamed', 'the closed tab coming back when its session opens again')
    await soon(async () => (await chosen()) === 'Renamed', 'the page moving to the tab that came back')
    check(opened().length === openedBefore, 'a tab coming back opens no second browser tab')
    // By the keys, and the keys stay in the bar.
    await tab('Renamed').focus()
    await p.keyboard.press('Delete')
    await soon(async () => (await names()).join() === 'Shop', 'the Delete key closing the tab')
    await soon(() => tab('Shop').evaluate(e => e === document.activeElement), 'the keys staying on the next tab')
    await openTab(other, 'renamed')
    await soon(async () => (await chosen()) === 'Renamed', 'the tab back again')
    // By the middle button, as in a browser.
    await tab('Renamed').click({ button: 'middle' })
    await soon(async () => (await names()).join() === 'Shop', 'the middle button closing the tab')
    // Closing the middle one of three, the tab after it takes its place. Closing the last, the one before it does.
    const thirdServer = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title>') })
    await new Promise(ok => thirdServer.listen(0, '127.0.0.1', ok))
    const third = { port: thirdServer.address().port, token: 'f'.repeat(32) }
    await openTab(other, 'renamed')
    await openTab(third, 'third')
    await soon(async () => (await names()).join() === 'Shop,Renamed,Third', 'three tabs')
    await tab('Renamed').click()
    await closer('Renamed').click()
    await soon(async () => (await names()).join() === 'Shop,Third', 'the middle tab closing')
    check((await chosen()) === 'Third', `the tab after it takes its place (${await chosen()})`)
    await openTab(other, 'renamed')
    await soon(async () => (await names()).join() === 'Shop,Third,Renamed', 'a tab coming back goes at the end')
    await closer('Renamed').click()
    await soon(async () => (await names()).join() === 'Shop,Third', 'the end tab closing')
    check((await chosen()) === 'Third', `the tab before it takes its place (${await chosen()})`)
    await closer('Third').click()
    await soon(async () => (await names()).join() === 'Shop', 'back to one tab')
    thirdServer.close()
    // The last one leaves the note on how to add a session, and the bar's own tab list stays alive.
    await closer('Shop').click()
    await soon(async () => (await names()).length === 0, 'the last tab closing')
    await p.locator('#none').waitFor()
    await openTab(a, 'shop')
    await soon(async () => (await names()).join() === 'Shop', 'the last tab coming back')
    check(await p.locator('#none').isHidden(), 'the note goes when a tab comes back')
    await soon(() => frame(a)?.locator('#themeBtn').isVisible(), 'its page showing again')
    await openTab(other, 'renamed')
    await soon(async () => (await chosen()) === 'Renamed', 'the second tab back')
    await tab('Shop').click()

    // Capitals: a folder's name reads as words, and the hover keeps how the folder is written.
    const capitals = await p.evaluate(() => [['docs-site', 'Docs Site'], ['my_cool-app', 'My Cool App'], ['k2-xauto-fe', 'K2 Xauto Fe'], ['Sentinel', 'Sentinel'], ['myApp', 'MyApp'], ['---', '---']].filter(([a, b]) => words(a) !== b))
    check(!capitals.length, `folder names read as words (${capitals.join(' | ')})`)
    const folder = { port: other.port, token: other.token }
    await openTab(folder, 'docs-site')
    await soon(async () => (await names()).join() === 'Shop,Docs Site', 'the tab with two words')
    check((await tab('Docs Site').getAttribute('title')) === 'docs-site', 'the hover keeps the folder as written')
    await tab('Shop').click()

    // The look of a browser tab: rounded on top, open at the bottom and in the colour of the page's header, the others on the bar.
    const look = await p.evaluate(() => {
      const css = e => getComputedStyle(e), bar = document.querySelector('.bar'), on = document.querySelector('.tab.on'), off = document.querySelector('.tab:not(.on)')
      const frame = document.querySelector('iframe.on').getBoundingClientRect(), r = on.getBoundingClientRect()
      return {
        joined: Math.round(frame.top - r.bottom), corners: [css(on).borderTopLeftRadius, css(on).borderTopRightRadius, css(on).borderBottomLeftRadius], rule: css(bar).borderBottomWidth,
        same: css(on).backgroundColor === css(document.body).backgroundColor, off: css(off).backgroundColor, bar: css(bar).backgroundColor, body: css(document.body).backgroundColor,
        flares: ['::before', '::after'].map(at => getComputedStyle(on, at).content === 'none' ? 'none' : getComputedStyle(on, at).width),
        width: Math.round(r.width), height: Math.round(r.height),
      }
    })
    check(look.joined === 0 && look.rule === '0px', `the tab you are on joins the page under it (${look.joined}px, ${look.rule} rule)`)
    check(look.corners[0] === '8px' && look.corners[1] === '8px' && look.corners[2] === '0px', `its top corners are round and its bottom ones square (${look.corners})`)
    check(look.same && look.bar !== look.body && look.bar !== 'rgba(0, 0, 0, 0)', `it has the page header's colour, and the bar another (${look.body}, ${look.bar})`)
    check(look.off === 'rgba(0, 0, 0, 0)', `the other tabs lie flat on the bar (${look.off})`)
    check(look.flares.join() === '8px,8px', `its foot curves out to the bar (${look.flares})`)
    check(look.width >= 148 && look.width <= 240 && look.height === 34, `tabs have a browser tab's size (${look.width} by ${look.height})`)
    await box('Docs Site').hover()
    const hovered = await box('Docs Site').evaluate(e => getComputedStyle(e).backgroundColor)
    check(hovered !== 'rgba(0, 0, 0, 0)', 'a tab you point at lights up')
    await p.mouse.move(700, 500)
    if (shots) await p.screenshot({ path: join(shots, 'hub-tabs.png'), clip: { x: 0, y: 0, width: 900, height: 120 } })

    // Sizes: many long names scroll sideways in the bar, and nothing else moves.
    const extra = []
    for (let i = 0; i < 6; i++) {
      const s = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title>') })
      await new Promise(ok => s.listen(0, '127.0.0.1', ok))
      extra.push(s)
      await openTab({ port: s.address().port, token: 'e'.repeat(32) }, `a-rather-long-project-folder-name-${i}`)
    }
    a.put(VARIANTS.blocked)
    if (!process.env.NOLAYOUT) for (const width of [390, 860, 1440]) for (const dark of [false, true]) {
      const q = await newPage({ width, dark })
      await q.waitForFunction(n => document.querySelectorAll('[role=tab]').length === n, 8)
      await q.locator('[role=tab]', { hasText: 'Needs you' }).waitFor()
      const m = await q.evaluate(() => {
        const t = document.getElementById('tabs'), on = document.querySelector('[aria-selected=true]').getBoundingClientRect()
        return { wide: document.documentElement.scrollWidth - innerWidth, tall: document.documentElement.scrollHeight - innerHeight, slides: t.scrollWidth - t.clientWidth, on: on.left >= 0 && on.right <= innerWidth, bell: document.getElementById('bell').getBoundingClientRect().right <= innerWidth, bar: document.querySelector('.bar').offsetHeight }
      })
      const at = `the bar at ${width}${dark ? ' dark' : ''}`
      check(m.wide <= 0 && m.tall <= 0, `${at} fits (${m.wide}px over, ${m.tall}px below)`)
      check(m.on && m.bell, `${at} keeps the chosen tab and the bell in view`)
      check(m.bar <= 41, `${at} stays thin (${m.bar}px)`)
      if (width === 390) check(m.slides > 0, 'at phone width the tabs scroll sideways')
      if (shots) await q.screenshot({ path: join(shots, `hub-${width}${dark ? '-dark' : ''}.png`) })
      await q.context().close()
    }
    extra.forEach(s => s.close())
    blank.close()

    // A hub that has gone: the page says so.
    p.sendsFail = true
    hub.kill()
    await p.locator('#ended').waitFor({ timeout: 12_000 })
    check((await names()).length === 0, 'the tabs go with the hub')
    check(await p.locator('#bell').isHidden(), 'the bell goes with the hub')
    await p.context().close()
  } finally {
    for (const c of running) c.kill()
  }
}

// ONLY=presets, ONLY=points or ONLY=looks runs that block alone, for trying a break on it in seconds.
const only = process.env.ONLY, quick = only === 'presets' || only === 'points' || only === 'looks'
try {
  if (!quick) {
  await hubPage()
  await usagePage()
  await groupedMap()
  }
  if (process.env.ONLY !== 'hub') {
  if (!quick) {
  if (process.env.ONLY !== 'others') await systemPage()
  await historyPage()
  await tasksPage()
  const parts = async p => { await p.locator('#sysLevel [data-lv=parts]').click(); await p.locator('#sysMain [data-id=refunds]').click() }
  // NOLAYOUT=1 skips the size-and-colour sweep, for trying a break quickly.
  if (!process.env.NOLAYOUT) {
  await layout('sysMid', '#system', 'system')
  await layout('sysMid', '#system', 'system-parts', parts)
  await layout('sysMid', '#system', 'system-testing', async p => { await p.locator('#sysViews [data-sv=testing]').click() })
  await layout('sysChanges', '#system', 'system-changes', async p => { await p.locator('#sysViews [data-sv=changes]').click() })
  await layout('sysDone', '#system', 'system-finish')
  await layout('sysStatuses', '#system', 'system-statuses', async p => { await p.locator('#sysLevel [data-lv=parts]').click() })
  await layout('sysNasty', '#system', 'system-markup')
  await layout('sysFirst', '#system', 'system-first')
  await layout('sysDrift', '#system', 'system-history')
  await layout('sysDrift', '#system', 'system-history-parts', parts)
  await layout('sysNoGit', '#system', 'system-no-git')
  await layout('sysTasks', '#system', 'system-tasks', async p => { await p.locator('#sysLevel [data-lv=tasks]').click() })
  }
  }
  // ONLY=system stops here, to try the System page without the 90 seconds of everything else.
  others: {
  if (process.env.ONLY === 'system') break others
  let p
  lib: {
  if (quick) break lib
  // The Library at Standard: the weights, the instruction list grouped by moment, the totals and the panel.
  p = await open('library', '#library')
  check(await p.locator('#wLabel').textContent() === 'This project: Standard, the usual', 'weight label')
  check(same(await p.locator('#swScope button').allTextContents(), ['This project', 'Every project']), 'Change for has two places while no preset is in use')
  check(await p.locator('.wcard[aria-pressed=true] .wn').textContent() === 'Standard', 'Standard picked')
  check(await p.locator('.irow').count() === BUILTINS.length - 1 + own.length, 'a row for each instruction, and the experimental switch apart')
  check(await p.locator('.mg-h').count() === 5, 'a group for each moment')
  check(await p.locator('.irow[data-ins="project/release-notes"] .tag.off').textContent() === 'Not trusted', 'untrusted row marked')
  check((await p.locator('#tot').textContent()).includes(`${standardOn.length + 2} of ${BUILTINS.length - 1 + own.length}`), 'totals count what is on')
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
  await sent('libon personal', b => b.kind === 'libon' && b.name === 'fast-checks' && b.scope === 'personal' && b.on === false)
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
  check(await p.locator('#slip .planins input').count() === VARIANTS.draft.library.instructions.filter(i => i.trusted && i.name !== XS).length, 'a switch per trusted instruction')
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
  check((await p.locator('#stub [data-act=lockfree]').innerText()) === 'Lock and go hands-free', 'draft: the hands-free lock sits beside Lock')
  check((await p.locator('#stub h2').innerText()) === 'Check the draft, then lock it', 'draft: the usual stub comes back')
  await p.locator('#stub [data-act=lock]').click()
  await sent('lock after answers', b => b.kind === 'lock' && b.draft === 'p3' && b.free === undefined)
  await p.context().close()

  p = await open('proofAnswered', '')
  await p.locator('#stub [data-act=lockfree]').click()
  await sent('lock and go hands-free', b => b.kind === 'lock' && b.draft === 'p3' && b.free === true)
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

  // The experimental switch has a row of its own, and only the user's click sends it.
  p = await open('library', '#library')
  check(await p.locator('.irow[data-ins="built-in/state-settings"]').count() === 0, 'switch: not in the list')
  check(await p.locator('#xsw .tag').textContent() === 'Experimental', 'switch: says experimental')
  check((await p.locator('#xsw').innerText()).includes('testing'), 'switch: says it is for testing')
  check(!await p.locator('#xsw input').isChecked(), 'switch: off by default')
  await p.locator('.wcard[data-weight=thorough]').click()
  await sent('a weight, for the switch case', b => b.kind === 'libweight' && b.weight === 'thorough')
  check(!await p.locator('#xsw input').isChecked(), 'switch: a weight leaves it off')
  await p.locator('#xsw .ck.sw').click()
  await sent('libon for the switch', b => b.kind === 'libon' && b.name === XS && b.on === true && b.scope === 'project')
  await p.context().close()
  // With a project weight and the personal default on, the switch reads on: no weight clears it.
  write({ ...VARIANTS.library, library: { ...VARIANTS.library.library, project: { weight: 'light' }, personal: { on: { [XS]: true } } } })
  p = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then(c => c.newPage())
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }))
  await p.goto(`${base}#library`)
  await p.waitForSelector('#xsw input')
  check(await p.locator('#xsw input').isChecked(), 'switch: the personal default holds under a project weight')
  check((await p.locator('#wLabel').textContent()) === 'This project: Light', 'switch: it counts as no change to the weight')
  await p.context().close()

  // The System page says it is experimental, and has no switch.
  p = await open('sysMid', '#system')
  check(await p.locator('#sysp .phead .tag').textContent() === 'Experimental', 'System: says experimental')
  check(await p.locator('#sysp .phead input').count() === 0, 'System: no switch')
  check(await p.evaluate(() => { const h = document.querySelector('#sysp h1'); return h.getBoundingClientRect().width <= h.parentElement.getBoundingClientRect().width }), 'System: the heading fits beside the tag')
  await p.context().close()
  p = await open('sysMid', '#system', { width: 390 })
  check(await p.locator('#sysp .phead h1').isVisible(), 'System: the heading shows on a phone')
  await p.context().close()

  // The draft card: only what differs, one row for each reason, and the answers.
  p = await open('settings', '')
  check((await p.locator('#stub h2').innerText()) === '3 looser settings need your answer', 'settings: the stub counts them')
  check((await p.locator('#stub').innerText()).includes('runs the plan without them'), 'settings: the stub says what typing lock does')
  check(await p.locator('#stub [data-act=lock]').isDisabled(), 'settings: Lock waits for the answers')
  check(await p.locator('#stub [data-act=lockfree]').isEnabled(), 'settings: Lock and go hands-free answers for you')
  check((await p.locator('#stub').innerText()).includes('Lock and go hands-free lets them through'), 'settings: the stub says what the button does')
  await p.locator('#stub [data-act]').first().waitFor()
  const rows = p.locator('.setl li')
  check(await rows.count() === 6, 'settings: one row for each reason')
  const asked = rows.filter({ hasText: 'You asked' })
  check(await asked.locator('[data-keep]').count() === 0 && await asked.locator('button', { hasText: 'Use Standard' }).count() === 1, 'settings: words you typed can still be taken back')
  check((await rows.nth(0).innerText()).startsWith('This plan'), 'settings: the plan row is first')
  check((await rows.nth(0).locator('.mini').innerText()) === 'fails-first off', 'settings: the plan row says what it turns off')
  check(await rows.nth(1).locator('code').count() === 2, 'settings: same reason, same row')
  check((await rows.nth(1).locator('.mini').innerText()) === 'Light', 'settings: the row says the weight')
  check((await p.locator('.setl').innerText()).includes('Plan weight') === false && (await p.locator('#slip').innerText()).includes('Plan weight: Standard'), 'settings: the plan weight shows')
  check(await p.locator('.setl code', { hasText: /^form$/ }).count() === 0, 'settings: a state at the plan weight has no row')
  check((await rows.filter({ hasText: 'Thorough' }).locator('button').count()) === 0, 'settings: a stricter weight needs no answer')
  check(await p.locator('.setl i').count() === 0, 'settings: a reason runs no markup')
  check((await rows.filter({ hasText: 'dashboard-widths' }).locator('code').count()) === 2, 'settings: an addition groups its states')
  await rows.nth(1).locator('[data-keep]').click()
  await sent('Keep on a weight row', b => b.kind === 'setrow' && b.draft === 's1' && b.id.startsWith('weight|light|only changes text') && b.keep === true)
  await rows.nth(1).locator('button', { hasText: 'Use Standard' }).click()
  await sent('Use Standard on a weight row', b => b.kind === 'setrow' && b.id.startsWith('weight|light|only changes text') && b.keep === false)
  await rows.filter({ hasText: 'dashboard-widths' }).locator('button', { hasText: 'Remove' }).click()
  await sent('Remove on an addition', b => b.kind === 'setrow' && b.id.startsWith('add|dashboard-widths') && b.keep === false)
  await rows.nth(0).locator('button', { hasText: 'Leave it on' }).click()
  await sent('Leave it on, on a plan row', b => b.kind === 'setrow' && b.id === 'plan|fails-first' && b.keep === false)
  await p.context().close()

  // The task page: the state's weight and additions, and what a member misses.
  p = await open('settings', '#task-copy')
  const say = () => p.locator('.tp-main').textContent()
  check((await say()).includes('Settings for this state') && (await say()).includes('only changes text'), 'task: the weight and its reason')
  check((await say()).includes('It runs at Standard unless you keep this'), 'task: what it runs at until answered')
  check(!(await say()).includes('member agent'), 'task: no member note on a Light state')
  await p.context().close()
  p = await open('settings', '#task-charge')
  check((await say()).includes('+ dashboard-widths') && (await say()).includes('it shows the card form'), 'task: an addition and its reason')
  await p.context().close()
  p = await open('settings', '#task-export')
  check((await say()).includes('member agent'), 'task: the member note on a Thorough state')
  check(await p.locator('.tp-main i').count() === 0, 'task: a reason runs no markup')
  await p.context().close()
  p = await open('settings', '#task-form')
  check((await say()).includes("Runs at Standard, the plan's weight.") && !(await say()).includes("Claude's reason"), 'task: a plain state says only what it runs at')
  await p.context().close()

  // The weight bars on the Map: each state's weight, amber where it isn't the plan's, and +1 or −1 for what Claude added
  // to or skipped for that state alone.
  p = await open('settingsRun', '')
  const card = id => p.locator(`.mcard[data-task="${id}"]`)
  // Later states sit in a folded group; open it, as a click on its stacked card does.
  for (let i = 0; i < 3 && await p.locator('.mcard', { hasText: 'Later' }).count(); i++) { await p.locator('.mcard', { hasText: 'Later' }).first().click(); await p.waitForTimeout(300) }
  check(await p.locator('.mcard[data-task] .wm').count() === 8, 'map: a weight meter on each state card')
  check(await p.locator('.mcard:not([data-task]) .wm').count() === 0, 'map: none on the closing card')
  check(await p.locator('.mcard .wm.own').count() === 2 && await card('export').locator('.wm.own').count() === 1 && await card('asked').locator('.wm.own').count() === 1, 'map: amber only where a state runs at another weight')
  check(await card('export').locator('.wm b.on').count() === 3 && await card('form').locator('.wm b.on').count() === 2 && await card('asked').locator('.wm b.on').count() === 1, 'map: three bars for Thorough, two for Standard, one for Light')
  check((await card('export').getAttribute('title')).includes("Runs at Thorough. The plan's weight is Standard."), 'map: the hover says the weight in words')
  check((await card('charge').locator('.wx').innerText()) === '+1' && /Adds .+: it shows the card form./.test(await card('charge').getAttribute('title')), 'map: +1 and its words for an addition')
  check((await card('form').locator('.wx').innerText()) === '−1' && /Skips .+: the form is copied from the design file./.test(await card('form').getAttribute('title')), 'map: −1 and its words for a skip')
  check(await card('docs').locator('.wx').count() === 0, 'map: nothing more on a state with the plan\'s instructions')
  check(await p.locator('.planset').isVisible() && (await p.locator('.planset').innerText()) === 'Standard · 1 turned on' && (await p.locator('.planset').getAttribute('title')).includes('for the whole plan: it rewrites saved data'), 'plan bar: the weight and what the plan turned on')
  check((await p.locator('.mnote').innerText()).includes('one bar for Light') && (await p.locator('.mnote').innerText()).includes('skipped for'), 'map key: the bars and the marks')
  await p.context().close()
  p = await open('settingsRun', '#task-form')
  check((await say()).includes("Runs at Standard, the plan's weight.") && (await say()).includes('− failure-list') && (await say()).includes('the form is copied from the design file'), 'task: a skip and its reason')
  await p.context().close()
  p = await open('settingsRun', '#task-export')
  check((await say()).includes("Runs at Thorough. The plan's weight is Standard."), 'task: a weight that differs')
  await p.context().close()
  p = await open('settingsRun', '#task-copy')
  check((await say()).includes('because nobody kept this on the draft'), 'task: a lock left it at the plan weight')
  await p.context().close()
  p = await open('settingsOff', '#task-copy')
  check((await say()).includes("Runs at Standard, the plan's weight.") && !(await say()).includes("Claude's reason"), 'task: with the switch off only what it runs at')
  check(await p.locator('.setl').count() === 0, 'draft: no settings rows with the switch off')
  check(await p.locator('#stub h2').count() === 0 || (await p.locator('#stub h2').innerText()) !== 'A looser setting needs your answer', 'draft: nothing owed with the switch off')
  await p.context().close()

  // Your own instruction with a list: the editor shows it, and it keeps its personal switch under a project weight.
  const ownWeights = l => ({ ...l, instructions: l.instructions.map(i => (i.name === 'dashboard-widths' ? { ...i, weights: ['standard'] } : i)) })
  p = await open('library', '#library')
  await p.context().close()
  VARIANTS.ownWeights = { ...VARIANTS.library, library: ownWeights(VARIANTS.library.library) }
  p = await open('ownWeights', '#ins-dashboard-widths')
  check(await p.locator('[name=iew][value=standard]').isChecked(), 'editor: your own list shows')
  check(!await p.locator('[name=iew][value=light]').isChecked(), 'editor: only what it lists')
  await p.context().close()
  VARIANTS.ownHeld = { ...VARIANTS.ownWeights, library: { ...VARIANTS.ownWeights.library, project: { weight: 'standard' }, personal: { on: { 'dashboard-widths': false } } } }
  p = await open('ownHeld', '#library')
  check(!await p.locator('.irow[data-ins="project/dashboard-widths"] input').isChecked(), 'your own keeps its personal switch under a project weight')
  check((await p.locator('#wLabel').textContent()) === 'This project: Standard', 'your own switch is no change to the weight')
  await p.context().close()

  // A weight picked on the cards moves your own with a list, as the Library's weights do, unless you switched it.
  const ownDraft = sw => ({ ...VARIANTS.draft, library: { ...ownWeights(VARIANTS.draft.library), ...sw } })
  VARIANTS.ownCard = ownDraft({})
  p = await open('ownCard', '')
  await p.locator('#slip [data-act=planweight][data-pw=light]').click()
  await sent('your own list follows the cards', b => b.kind === 'libplan' && b.weight === 'light' && !b.on.includes('dashboard-widths'))
  await p.context().close()
  VARIANTS.ownCardOff = { ...VARIANTS.draft, library: ownWeights(VARIANTS.draft.library), draftLibrary: { ...VARIANTS.draft.draftLibrary, on: VARIANTS.draft.draftLibrary.on.filter(n => n !== 'dashboard-widths') } }
  p = await open('ownCardOff', '')
  await p.locator('#slip [data-act=planweight][data-pw=standard]').click()
  await sent('your own list comes on at its weight', b => b.kind === 'libplan' && b.weight === 'standard' && b.on.includes('dashboard-widths'))
  await p.context().close()
  VARIANTS.ownCardHeld = ownDraft({ personal: { on: { 'dashboard-widths': true } } })
  p = await open('ownCardHeld', '')
  await p.locator('#slip [data-act=planweight][data-pw=light]').click()
  await sent('your own switch holds on the cards', b => b.kind === 'libplan' && b.weight === 'light' && b.on.includes('dashboard-widths'))
  await p.context().close()

  // The editor: a list of weights goes in the file, and none means no list.
  p = await open('library', '#ins-new')
  await p.locator('#ien').fill('quick-weights')
  await p.locator('#ietext').fill('Keep each check short.')
  await p.locator('[name=iew][value=standard]').check()
  await p.locator('[name=iew][value=thorough]').check()
  check((await p.locator('#iejson').textContent()).includes('"thorough"'), 'editor: the file shows the weights')
  await p.locator('[data-act=iesave]').click()
  await sent('saveflow with weights', b => b.kind === 'saveflow' && b.flow.name === 'quick-weights' && b.flow.weights?.join() === 'standard,thorough')
  await p.context().close()
  p = await open('library', '#ins-new')
  await p.locator('#ien').fill('quick-weights')
  await p.locator('#ietext').fill('Keep each check short.')
  await p.locator('[name=iew][value=light]').check()
  await p.locator('[name=iew][value=light]').uncheck()
  await p.locator('[data-act=iesave]').click()
  await sent('saveflow without weights', b => b.kind === 'saveflow' && b.flow.name === 'quick-weights' && !('weights' in b.flow))
  await p.context().close()
  }

  // The overseer's looks on the step's page, and check run times. How it can fail:
  //  1. The step's page leaves out a look, or doesn't say why it started (ran long or stuck) or what it said.
  //  2. The overseer's words run as markup.
  //  3. A step the overseer never looked at shows a look, or says nothing happened when one did.
  //  4. Every call shows no time for a timed check run, or a time on a call that has none.
  //  5. The finished run's Stuck row doesn't say whether the overseer agreed, or says so for a mark it never saw.
  looks: {
  if (only === 'presets' || only === 'points') break looks
  p = await open('looksRun', '#task-service')
  const items = await p.locator('.tlist li').allInnerTexts()
  const ran = items.find(t => t.includes('ran long')), stuck = items.find(t => t.includes('stuck mark'))
  check(!!ran && ran.includes('Overseer') && ran.includes('Could go faster') && ran.includes('Run one test file instead of the suite.'), `looks: the time look shows with what it said (${items.join(' | ')})`)
  check(!!stuck && stuck.includes('Really stuck') && stuck.includes('The rounding is in <b>money.ts</b>, see round().'), `looks: the stuck look shows with what it said (${stuck})`)
  check(await p.locator('.tlist li b:not([class])').count() === 0 && await p.locator('.tlist li code', { hasText: 'round()' }).count() === 1, "looks: the overseer's words run no markup, and code in backticks shows as code")
  await p.context().close()
  p = await open('looksRun', '#task-verify')
  check(await p.locator('.tlist li').count() === 0 && (await p.locator('.tp-main').innerText()).includes('Nothing was decided, asked or refused here.'), 'looks: a step with no look shows none')
  await p.context().close()
  p = await open('looksRun', '')
  const rows = await p.locator('#ledger tr:has(td)').allTextContents()
  const times = await p.locator('#ledger tr:has(td) small').allTextContents()
  check(rows[0]?.includes('42 s') && same(times, ['42 s']), `looks: Every call shows the timed check run's time and no other (${times.join(' | ')})`)
  await p.context().close()
  p = await open('looksDone', '')
  const stuckRow = await p.locator('.dl dt', { hasText: 'Stuck' }).locator('xpath=following-sibling::dd[1]').innerText()
  const lines = stuckRow.split('\n')
  check(lines.length === 3 && lines[0].includes('the overseer agreed') && lines[1].includes('the overseer said it was moving') && !lines[2].includes('overseer'), `looks: the Stuck row says whether the overseer agreed (${lines.join(' | ')})`)
  await p.context().close()
  if (only === 'looks') break others
  }

  // What you asked for, on a draft. How it can fail:
  //  1. A draft with points shows no block, or a row misses the user's words or the steps that deliver them.
  //  2. A point left out isn't amber or misses Claude's reason, or one the plan delivers shows amber.
  //  3. The user's words or Claude's reason run as markup.
  //  4. A draft that compares quotes and lists no points says nothing about it.
  //  5. A plan that doesn't compare quotes and lists no points shows the block.
  points: {
  if (only === 'presets') break points
  p = await open('proofPoints', '')
  const rows = p.locator('#points li'), row = async n => rows.nth(n).innerText()
  check((await p.locator('#points h3').textContent()) === 'What you asked for' && await rows.count() === 4, 'points: a row for each point')
  const [r0, r1, r2, r3] = [await row(0), await row(1), await row(2), await row(3)]
  check(r0.includes(PAY) && r0.includes('pay') && r0.includes('refund') && r1.includes(TYPED) && r1.includes('wait'), 'points: each quote with the steps that deliver it')
  check(same(await rows.evaluateAll(ls => ls.map(l => l.className)), ['m-ok', 'm-ok', 'm-warn', 'm-warn']), 'points: a tick for each delivered, amber for each left out')
  check(r2.includes(EXPORT) && r2.includes('Exports come after payments.') && r3.includes(LATER), "points: a left-out point gives Claude's reason")
  check(r3.includes(NASTY) && await p.locator('#points img, #points i').count() === 0, "points: the user's words and Claude's reason run no markup")
  await p.context().close()
  p = await open('proofDraft', '')
  check((await p.locator('#points .m-warn').innerText()).includes('Claude listed none of the points you asked for.'), 'points: none listed is said in amber')
  await p.context().close()
  p = await open('draft', '')
  check(await p.locator('#slip').isVisible() && await p.locator('#points').count() === 0, "points: no block on a draft that doesn't compare quotes")
  await p.context().close()
  if (only === 'points') break others
  }

  // Presets and needed MCPs. How it can fail:
  //  1. The line misses the preset in use, a needed MCP, where one comes from, its state, or the /mcp hint.
  //  2. Change for misses the preset in use, or offers it with none in use or one this computer lacks.
  //  3. Add and × send the wrong place: they follow Change for, and × shows only on that place's own MCPs.
  //  4. A row hides what decided it ("Off here, from game-dev"), or says so for a switch of the place on screen.
  //  5. A place shows another's items: the preset's own outside it, the project's outside This project.
  //  6. The chooser opens on the wrong preset, or its details miss the switches, what is only in it, the MCPs, what
  //     using it would turn on or off, a flow's checks or the untrusted warning.
  //  7. Use, No preset, Change, New, Move, Make, Delete or Import send nothing or the wrong fields; Delete goes without
  //     asking; New takes a name Sentinel refuses or one taken; a snapshot loses what you typed.
  //  8. Import skips the swap for an MCP this computer lacks, or sends a file the page server would refuse.
  //  9. A preset this computer lacks goes unsaid on the Library or the draft card.
  // 10. Saved in misses the preset in use, or names the wrong folder.
  const title = n => BUILTINS.find(b => b.name === n).title
  p = await open('presets', '#library')
  const line = await p.locator('.pline').textContent()
  check(line.includes('game-dev') && /Notion\s*Connected/.test(line) && /Unity\s*Not connected\s*game-dev/.test(line) && line.includes('Connect with /mcp to lock plans here.'), 'preset line: the name, each MCP with its place, and the hint')
  check(same(await p.locator('#swScope button').allTextContents(), ['This project', 'game-dev', 'Every project']), 'Change for offers the preset in use')
  check(same(await p.locator('#mcpAdd option').allTextContents(), ['Add an MCP', 'playwright']), 'Add offers only servers not needed yet')
  check(await p.locator('[data-p=drop][data-mcp=Notion]').count() === 1 && await p.locator('[data-p=drop][data-mcp=Unity]').count() === 0, "× only on this project's own MCPs")
  await p.locator('#mcpAdd').selectOption('playwright')
  await sent('mcpAdd', b => b.kind === 'mcpAdd' && b.name === 'playwright' && b.scope === 'project')
  await p.locator('[data-p=drop][data-mcp=Notion]').click()
  await sent('mcpDrop', b => b.kind === 'mcpDrop' && b.name === 'Notion' && b.scope === 'project')
  await p.locator('[data-p=check]').click()
  await sent('mcpCheck', b => b.kind === 'mcpCheck')
  // The rows say what decided them.
  const fast = p.locator('.irow[data-ins="built-in/fast-checks"]')
  check(await fast.locator('.diff').textContent() === 'Off here, from game-dev' && !(await fast.locator('input').isChecked()), "rows say what decided them: game-dev's switch")
  check(await p.locator('.irow .diff').count() === 1, 'no row says a place decided it when its own weight did')
  check(await p.locator('.irow[data-ins="preset/playtest"] .tag.sm').textContent() === 'game-dev', "the preset's own instruction shows here, under its name")
  await p.locator('#swScope [data-sws=preset]').click()
  check((await p.locator('.swhint').textContent()) === 'Reaches every project that uses game-dev.', 'the hint says what a change for game-dev reaches')
  check(await fast.locator('.diff').count() === 0, "no 'from' on game-dev's own switch")
  check(await p.locator('.irow[data-ins^="project/"]').count() === 0 && await p.locator('.irow[data-ins="preset/playtest"]').count() === 1, "game-dev shows its own items and not the project's")
  check(await p.locator('[data-p=drop][data-mcp=Unity]').count() === 1 && await p.locator('[data-p=drop][data-mcp=Notion]').count() === 0, "× follows Change for to game-dev's MCPs")
  await p.locator('[data-p=drop][data-mcp=Unity]').click()
  await sent('mcpDrop from the preset', b => b.kind === 'mcpDrop' && b.name === 'Unity' && b.scope === 'preset')
  await fast.locator('.ck.sw').click()
  await sent('libon for the preset', b => b.kind === 'libon' && b.name === 'fast-checks' && b.scope === 'preset' && b.on === true)
  await p.locator('#swScope [data-sws=personal]').click()
  check((await p.locator('.swhint').textContent()) === 'Reaches every project.' && await p.locator('.irow[data-ins^="preset/"]').count() === 0, "every project's switches hide the preset's items")
  await p.locator('#swScope [data-sws=project]').click()
  // The chooser.
  await p.locator('[data-p=open]').click()
  check(await p.locator('.pick[aria-pressed=true]').getAttribute('data-preset') === 'game-dev', 'the chooser opens on the preset in use')
  const det = () => p.locator('.pset').textContent()
  let d = await det()
  check(d.includes('In use') && d.includes(`Off: ${title('fast-checks')}`) && d.includes(PLAYTEST.text) && /Unity\s*Not connected/.test(d) && !d.includes('Turns on'), "game-dev's details: its switches, what is only in it, its MCPs")
  check(await p.locator('[data-p=make]').textContent() === "Move this project's settings into game-dev", 'Make reads as Move while a preset is in use')
  await p.locator('[data-p=edit]').click()
  check(await p.locator('.pline').isVisible() && await p.locator('#swScope [aria-pressed=true]').textContent() === 'game-dev', 'Change game-dev closes the chooser and puts Change for on it')
  await p.locator('#swScope [data-sws=project]').click()
  await p.locator('[data-p=open]').click()
  await p.locator('[data-preset=shared]').click()
  d = await det()
  check(d.includes("didn't make this preset") && d.includes('npm run build && rm -rf dist') && d.includes(`Turns on ${title('fast-checks')}`) && d.includes(`Turns off ${title('failure-list')}`), 'untrusted details: the warning, the checks, what would turn on and off')
  check(await p.locator('[data-preset=shared] .tag.off').textContent() === 'Not trusted', 'an untrusted preset is marked in the list')
  const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('[data-p=export]').click()])
  check(dl.suggestedFilename() === 'shared.json' && same(JSON.parse(readFileSync(await dl.path(), 'utf8')), PRESETS[2].raw), 'Export downloads the preset file')
  await p.locator('[data-p=del]').click()
  check(await p.locator('[data-p=delyes]').isVisible(), 'Delete asks first')
  await p.locator('[data-p=delyes]').click()
  await sent('presetDelete', b => b.kind === 'presetDelete' && b.name === 'shared')
  await p.locator('[data-preset=shared]').click()
  await p.locator('[data-p=use]').click()
  await sent('presetUse', b => b.kind === 'presetUse' && b.name === 'shared' && Object.keys(b).length === 2)
  check(await p.locator('.pline').isVisible(), 'Use closes the chooser')
  write({ ...VARIANTS.presets, flowSaid: { ok: true, text: 'Using shared here.', at: Date.now() + 60_000 } })
  await p.waitForFunction(() => document.getElementById('notice').textContent.includes('Using shared here.')).catch(() => fails.push('the reply to Use shows'))
  write(VARIANTS.presets)
  await p.locator('[data-p=open]').click()
  await p.locator('[data-preset=""]').click()
  await p.locator('[data-p=none]').click()
  await sent('presetNone', b => b.kind === 'presetNone')
  // Move, New and Import.
  await p.locator('[data-p=open]').click()
  await p.locator('[data-p=make]').click()
  d = await det()
  check(d.includes('dashboard-widths') && d.includes('review') && d.includes('Notion'), 'Move lists what moves')
  await p.locator('[data-p=domove]').click()
  await sent('presetMove into the preset in use', b => b.kind === 'presetMove' && b.name === 'game-dev')
  await p.locator('[data-p=open]').click()
  await p.locator('[data-p=new]').click()
  await p.locator('#pname').fill('none')
  check((await p.locator('#pslug').textContent()).includes("can't be names"), 'a reserved name is refused')
  await p.locator('#pname').fill('game-dev')
  check((await p.locator('#pslug').textContent()).includes('There is a preset called game-dev already'), 'a taken name is refused')
  await p.locator('[data-p=create]').click()
  await p.locator('#pname').fill('Mobile App')
  check((await p.locator('#pslug').textContent()).includes('~/.sentinel/presets/mobile-app/'), 'the folder it makes')
  write({ ...VARIANTS.presets, library: { ...VARIANTS.presets.library, presets: PRESETS.slice(1) } })
  await p.locator('[data-preset=backend]').waitFor({ state: 'detached' })
  check(await p.locator('#pname').evaluate(i => i.value === 'Mobile App' && document.activeElement === i && document.getElementById('pslug').textContent.includes('mobile-app')), 'a snapshot that redraws the box keeps what you typed')
  write(VARIANTS.presets)
  await p.locator('#pname').press('Enter')
  await sent('presetNew', b => b.kind === 'presetNew' && b.name === 'mobile-app')
  const made = { ...VARIANTS.presets, library: { ...VARIANTS.presets.library, using: { name: 'mobile-app' }, presets: [...PRESETS, { ...PRESETS[0], name: 'mobile-app', weight: undefined, raw: {} }] }, flowSaid: { ok: true, text: 'Made the preset mobile-app.', at: Date.now() + 60_000 } }
  write(made)
  await p.waitForFunction(() => document.querySelector('#swScope [aria-pressed=true]')?.textContent === 'mobile-app').catch(() => fails.push('New puts Change for on the new preset'))
  write(VARIANTS.presets)
  await p.locator('#swScope [data-sws=project]').click()
  const team = JSON.stringify({ weight: 'light', mcps: ['Unity', 'Notion'] })
  await p.locator('#pfile').setInputFiles({ name: 'team.json', mimeType: 'application/json', buffer: Buffer.from(team) })
  d = await det()
  check(d.includes('Import team') && d.includes("didn't make this preset") && await p.locator('[data-swap=Unity]').count() === 1 && await p.locator('[data-swap=Notion]').count() === 0, 'Import shows the file and asks about the MCP this computer lacks')
  await p.locator('[data-swap=Unity]').selectOption({ label: 'Leave it out' })
  await p.locator('[data-p=doimport]').click()
  await sent('presetImport with a swap', b => b.kind === 'presetImport' && b.name === 'team.json' && b.content === team && same(b.swap, { Unity: null }))
  await p.locator('#pfile').setInputFiles({ name: 'odd.json', mimeType: 'application/json', buffer: Buffer.from('{ nope') })
  await sent('presetImport of a file that does not read', b => b.kind === 'presetImport' && b.name === 'odd.json' && b.content === '{ nope' && !('swap' in b))
  await p.locator('#pfile').setInputFiles({ name: 'big.json', mimeType: 'application/json', buffer: Buffer.from(`{"x":"${'a'.repeat(70_000)}"}`) })
  await p.waitForFunction(() => document.getElementById('fsaid').textContent.includes('too big')).catch(() => fails.push('a file too big for the page server is refused'))
  await p.context().close()
  // Saved in offers the preset in use, with its folder.
  p = await open('presets', '#ins-new')
  const savedIn = await p.locator('[name=iescope]').evaluateAll(xs => xs.map(x => x.closest('.opt').textContent))
  check(savedIn.length === 3 && savedIn[1].includes('~/.sentinel/presets/game-dev/instructions/') && savedIn[1].includes('only in projects that use game-dev'), 'Saved in offers the preset in use, with its folder')
  await p.context().close()
  p = await open('noPresets', '#library')
  check((await p.locator('.pline').textContent()).includes('No MCPs') && same(await p.locator('#swScope button').allTextContents(), ['This project', 'Every project']), 'no needed MCPs, and two places with no preset')
  await p.locator('[data-p=open]').click()
  check((await p.locator('.plist').textContent()).includes('No preset') && (await det()).includes('This project runs on its own settings'), 'no presets: No preset is the one in use')
  await p.locator('[data-p=make]').click()
  await p.locator('#pname').fill('web')
  await p.locator('[data-p=domake]').click()
  await sent('presetMove into a new preset', b => b.kind === 'presetMove' && b.name === 'web')
  await p.context().close()
  p = await open('presetMissing', '#library')
  check((await p.locator('.pline').textContent()).includes("game-dev isn't on this computer") && same(await p.locator('#swScope button').allTextContents(), ['This project', 'Every project']), 'a preset this computer lacks is said on the line, and Change for leaves it out')
  check(await p.locator('.pline [data-p=import]').isVisible(), 'Import sits beside it')
  await p.context().close()
  p = await open('missingDraft', '')
  check((await p.locator('#stub').textContent()).includes("game-dev isn't on this computer"), 'the draft card says a preset this computer lacks')
  await p.context().close()
  p = await open('mcpDraft', '')
  check((await p.locator('#stub .mcpw').textContent()) === "Unity isn't connected, and amp needs you to sign in. Connect them with /mcp, then lock.", 'a draft names a needed MCP that is not ready above Lock')
  await p.context().close()
  p = await open('draft', '')
  check(await p.locator('#stub .mcpw').count() === 0, 'no warning on a draft when every needed MCP is ready')
  await p.context().close()
  if (only === 'presets' && process.env.NOLAYOUT) break others

  await layout('presets', '#library', 'presets-line')
  await layout('presets', '#library', 'presets-open', async p => { await p.locator('[data-p=open]').click() })
  await layout('presets', '#library', 'presets-untrusted', async p => { await p.locator('[data-p=open]').click(); await p.locator('[data-preset=shared]').click() })
  await layout('presets', '#library', 'presets-move', async p => { await p.locator('[data-p=open]').click(); await p.locator('[data-p=make]').click() })
  await layout('presets', '#library', 'presets-new', async p => { await p.locator('[data-p=open]').click(); await p.locator('[data-p=new]').click() })
  await layout('presetMissing', '#library', 'presets-missing')
  await layout('noPresets', '#library', 'presets-empty', async p => { await p.locator('[data-p=open]').click() })
  await layout('mcpDraft', '', 'mcp-draft')
  await layout('settings', '', 'settings-draft')
  await layout('settings', '#task-export', 'settings-task')
  await layout('library', '#library', 'library')
  await layout('library', '#flows', 'flows')
  await layout('library', '#ins-new', 'editor')
  await layout('insDraft', '#library', 'ins-draft')
  await layout('draft', '', 'draft')
  await layout('proofDraft', '', 'proof-draft')
  await layout('proofPoints', '', 'proof-points')
  await layout('proofRun', '#task-pay', 'proof-task')
  await layout('proofRun', '#task-pkg', 'proof-added')
  await layout('proofRun', '#source-refund', 'proof-source')
  await layout('proofDone', '', 'proof-finish')
  await layout('blocked', '', 'blocked')
  await layout('closedDone', '', 'closed-finish')
  await layout('usageRun', '', 'usage')
  await layout('usageRun', '#task-pay', 'usage-task')
  // The overseer's looks on the step's page, and the finished run's Stuck row.
  await layout('looksRun', '#task-service', 'looks-task')
  await layout('looksDone', '', 'looks-finish')
  }
  }
} catch (e) {
  fails.push(`stopped: ${String(e.stack ?? e).split('\n').slice(0, 6).join(' / ')}`)
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

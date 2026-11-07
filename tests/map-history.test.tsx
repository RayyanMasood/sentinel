// The map stays current without Sentinel running: each part records the commit it was drawn at, and a check with no model
// compares the map with what git says changed since. It marks the parts that drifted, lists files in no part, and says
// why, one line a part. The user can say a mark is fine (until the files change again) or ask for the area to be redrawn,
// which ends with a question in the dialog. Finished plans leave one line each in .sentinel/plans.json.
//
// How it can fail, and where each is tested below:
//  1. A part is marked that did not change, or one that changed is missed (matching a file to a part's globs).
//  2. A rename is lost: the file leaves one part and arrives in another, or the part's files are all gone and no one says where.
//  3. Sentinel's own files (.sentinel/) count as changes.
//  4. Parts drawn at different commits are measured against one commit.
//  5. A commit git no longer knows (a force push, a shallow clone) is guessed at instead of marking every part.
//  6. No git repo: marks appear anyway, or nothing says why there are none.
//  7. Outside parts, groups, or parts with no files get a mark.
//  8. Files added since that no part covers go unseen, or Sentinel's own files show as loose.
//  9. "It's fine" hides a mark for good, or does not hide it at all.
// 10. The check runs every turn, not at the three moments it is meant for (session start, the System page, a draft).
// 11. A redraw is kept without the user's yes, or the old drawing is lost on No, words or Esc.
// 12. A redraw leaves the area's marker where it was, so the mark comes straight back.
// 13. A finished plan leaves no line, or a line the page cannot read; a plan still running leaves one early.
// 14. A map Sentinel did not write (a cloned repo) puts its own text into what Claude reads.
import { expect, mock } from 'claude-code/testing'
import { emptyRun, globMatch, redrawAsk, redrawText, summarize } from '../hooks/core'
import { driftOf, parsePlans, partsInside, withoutFine } from '../hooks/system'
import { renderPane } from '../hooks/views'
import type { DriftFacts, MapLook, Marks, PlanLine, Run, SystemMap, SysPart, View } from '../types'
import { REFUND, ROOT, TOOL, engine, openPage, said, test, until } from './kit'

// ---- the check, with git's answer given ----

const part = (id: string, files: string[] | undefined, extra: Partial<SysPart> = {}): SysPart => ({ id, name: id[0]!.toUpperCase() + id.slice(1), ...(files ? { files } : {}), ...extra })
const mapOf = (parts: SysPart[]): SystemMap => ({ name: 'Shop', actors: [], lines: [], parts })
const facts = (since: DriftFacts['since'], files: string[] = [], git = true): DriftFacts => ({ git, since, files })
const drift = (map: SystemMap, f: DriftFacts) => driftOf(map, f, globMatch)

const SHOP = mapOf([
  part('shop', undefined),
  part('refunds', ['src/refund*.ts'], { parent: 'shop', drawnAt: 'aaa1111' }),
  part('guide', ['guide/**'], { parent: 'shop', drawnAt: 'aaa1111' }),
])

test('a part whose file changed since it was drawn is marked, and one whose files did not is not', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'M', path: 'src/refund.ts' }] }, ['src/refund.ts', 'guide/intro.md']))
  expect(d.parts).toEqual({ refunds: 'changed' })
  expect(d.why.refunds).toBe('1 file changed since it was drawn: 1 edited.')
  expect(d.why.guide).toBeUndefined()
})

test('the reason counts what was added, edited and removed, and says nothing about the zeros', () => {
  const d = drift(SHOP, facts({ aaa1111: [
    { how: 'A', path: 'src/refund-queue.ts' }, { how: 'A', path: 'src/refund-log.ts' },
    { how: 'M', path: 'src/refund.ts' }, { how: 'D', path: 'src/refund-old.ts' },
  ] }, ['src/refund.ts', 'src/refund-queue.ts', 'src/refund-log.ts']))
  expect(d.why.refunds).toBe('4 files changed since it was drawn: 2 added, 1 edited, 1 removed.')
})

test('a rename takes a file out of one part and puts it into another', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'R', was: 'src/refund.ts', path: 'guide/refund.md' }] }, ['src/refund-x.ts', 'guide/refund.md']))
  expect(d.parts).toEqual({ refunds: 'changed', guide: 'changed' })
  expect(d.why.guide).toBe('1 file changed since it was drawn: 1 added.')
  expect(d.why.refunds).toBe('1 file changed since it was drawn: 1 removed.')
})

test('a part whose files are all gone says where git saw them go', () => {
  const d = drift(SHOP, facts({ aaa1111: [
    { how: 'R', was: 'guide/a.md', path: 'docs/guide/a.md' }, { how: 'R', was: 'guide/b.md', path: 'docs/guide/b.md' },
  ] }, ['docs/guide/a.md', 'docs/guide/b.md']))
  expect(d.parts.guide).toBe('gone')
  expect(d.why.guide).toBe('All 2 of its files are gone. Git sees them moved to docs/guide/.')
})

test('a part whose files are all gone with no rename says git cannot tell', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'D', path: 'guide/a.md' }, { how: 'D', path: 'guide/b.md' }] }, ['src/refund.ts']))
  expect(d.parts.guide).toBe('gone')
  expect(d.why.guide).toBe("All 2 of its files are gone. Git can't tell where they went.")
})

test('a part that lost some files but still has others is changed, not gone', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'D', path: 'guide/a.md' }] }, ['guide/b.md']))
  expect(d.parts.guide).toBe('changed')
  expect(d.why.guide).toBe('1 file changed since it was drawn: 1 removed.')
})

test('Sentinel\'s own files never count as a change', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'M', path: '.sentinel/system.json' }, { how: 'A', path: '.sentinel/marks.json' }] }, []))
  expect(d.parts).toEqual({})
  expect(d.loose).toEqual([])
})

test('each part is measured against the commit it was drawn at', () => {
  const map = mapOf([
    part('shop', undefined),
    part('refunds', ['src/refund*.ts'], { parent: 'shop', drawnAt: 'aaa1111' }),
    part('guide', ['guide/**'], { parent: 'shop', drawnAt: 'bbb2222' }),
  ])
  // The same edit to both: it came after the first commit and before the second.
  const d = drift(map, facts({ aaa1111: [{ how: 'M', path: 'src/refund.ts' }, { how: 'M', path: 'guide/a.md' }], bbb2222: [] }, ['src/refund.ts', 'guide/a.md']))
  expect(d.parts).toEqual({ refunds: 'changed' })
})

test('a commit git no longer knows marks every part that has files, and says why, without guessing', () => {
  const d = drift(SHOP, facts({ aaa1111: null }, ['src/refund.ts', 'guide/a.md']))
  expect(d.parts).toEqual({ refunds: 'changed', guide: 'changed' })
  expect(d.why.refunds).toBe("The commit it was drawn at (aaa1111) is gone from this repo, as after a force push or in a shallow clone, so Sentinel can't tell what changed.")
})

test('a part with no record of when it was drawn is treated like a missing commit', () => {
  const map = mapOf([part('shop', undefined), part('refunds', ['src/refund*.ts'], { parent: 'shop' })])
  const d = drift(map, facts({}, ['src/refund.ts']))
  expect(d.parts).toEqual({ refunds: 'changed' })
  expect(d.why.refunds).toBe("Nothing records when it was drawn, so Sentinel can't tell what changed.")
})

test('with no git repo nothing is marked, and the result says so', () => {
  const d = drift(SHOP, facts({}, [], false))
  expect(d).toEqual({ parts: {}, why: {}, loose: [], noGit: true })
})

test('outside parts, groups and parts with no files are never marked', () => {
  const map = mapOf([
    part('shop', undefined, { drawnAt: 'aaa1111' }),
    part('bank', undefined, { parent: 'shop', kind: 'outside', evidence: { guess: 'seen in a call' }, drawnAt: 'aaa1111' }),
    part('notes', undefined, { parent: 'shop', drawnAt: 'aaa1111' }),
    part('refunds', ['src/refund*.ts'], { parent: 'shop', drawnAt: 'aaa1111' }),
  ])
  expect(drift(map, facts({ aaa1111: null }, ['src/refund.ts'])).parts).toEqual({ refunds: 'changed' })
})

test('files added since that no part covers are listed, and Sentinel\'s own are not', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'A', path: 'billing/invoice.ts' }, { how: 'A', path: '.sentinel/plans.json' }, { how: 'A', path: 'src/refund-x.ts' }] }, ['billing/invoice.ts', 'src/refund-x.ts']))
  expect(d.loose).toEqual(['billing/invoice.ts'])
})

test('two parts that share a file both change when it does', () => {
  const map = mapOf([
    part('shop', undefined),
    part('report', ['docs/report.md'], { parent: 'shop', drawnAt: 'aaa1111' }),
    part('summary', ['docs/report.md'], { parent: 'shop', drawnAt: 'aaa1111' }),
  ])
  expect(drift(map, facts({ aaa1111: [{ how: 'M', path: 'docs/report.md' }] }, ['docs/report.md'])).parts).toEqual({ report: 'changed', summary: 'changed' })
})

test('nothing changed since the commit: nothing is marked', () => {
  expect(drift(SHOP, facts({ aaa1111: [] }, ['src/refund.ts']))).toEqual({ parts: {}, why: {}, loose: [] })
})

// ---- "It's fine" ----

const NOW = { refunds: { hash: 'h2', files: 1 }, guide: { hash: 'g1', files: 2 } }

test('"It\'s fine" hides a mark while the part\'s files are as they were, and the mark comes back when they change', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'M', path: 'src/refund.ts' }, { how: 'M', path: 'guide/a.md' }] }, ['src/refund.ts', 'guide/a.md']))
  const marks: Marks = { refunds: { fine: 'h2' }, guide: { fine: 'g0' } }
  const shown = withoutFine(d, marks, NOW)
  expect(shown.parts).toEqual({ guide: 'changed' })
  expect(shown.why.refunds).toBeUndefined()
  expect(shown.why.guide).toBeDefined()
})

test('"It\'s fine" with no fingerprint to compare keeps the mark', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'M', path: 'src/refund.ts' }] }, ['src/refund.ts']))
  expect(withoutFine(d, { refunds: { fine: 'h2' } }, { refunds: { none: 'no git' } }).parts).toEqual({ refunds: 'changed' })
  expect(withoutFine(d, { refunds: { fine: 'h2' } }, {}).parts).toEqual({ refunds: 'changed' })
})

// ---- the check in a session ----

const SYSTEM = `${ROOT}/.sentinel/system.json`
const MARKS = `${ROOT}/.sentinel/marks.json`
const DRAWN = JSON.stringify({ version: 1, name: 'Shop', actors: [], lines: [], parts: SHOP.parts })
const diffRuns = (eng: ReturnType<typeof engine>) => eng.runs.filter(r => r.argv.includes('--name-status')).length
const leaf = (eng: ReturnType<typeof engine>, id: string) => {
  const walk = (ns: any[]): any => ns.flatMap(n => [n, ...walk(n.kids ?? [])])
  return walk(eng.snap().system.tree).find((n: any) => n.id === id)
}
// A session that starts in a project that has a map, with the drift check's answer given.
async function started($: any, on: any, eng: ReturnType<typeof engine>, since: Record<string, { how: 'A' | 'M' | 'D' | 'R'; path: string; was?: string }[]> = { aaa1111: [{ how: 'M', path: 'src/refund.ts' }] }, clock = mock.clock(on), history: { untracked?: string[]; deleted?: string[] } = {}) {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  eng.files[SYSTEM] = DRAWN
  eng.setHistory({ ...history, since })
  // The screens read a snapshot the plugin writes while the dashboard is up.
  await openPage($, clock)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // The check runs in the background; two more calls let its write land.
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: TOOL, action: 'status' })
  await until(clock, () => eng.snap().system?.drift)
  await clock.advance(20)
}

test('a session that starts checks the map against git, and the System screens mark what drifted', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng)
  expect(eng.snap().system.drift).toMatchObject({ count: 1, why: { refunds: '1 file changed since it was drawn: 1 edited.' }, loose: [] })
  expect(leaf(eng, 'refunds').status.tags).toContain('changed-since-drawn')
  expect(leaf(eng, 'guide').status.tags).not.toContain('changed-since-drawn')
})

test('a project with a map and no plan still shows the map, as it stands', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[`${ROOT}/guide/intro.md`] = 'welcome'
  await started($, on, eng)
  expect(eng.snap().system).toMatchObject({ name: 'Shop', parts: 3 })
  expect(leaf(eng, 'guide').status.status).toBe('exists')
})

test('the check runs when a session starts, when the System page opens and when a plan is drafted, and not between', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  await started($, on, eng, undefined, clock)
  expect(diffRuns(eng)).toBe(1)
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: TOOL, action: 'status' })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  expect(diffRuns(eng)).toBe(1)
  await $.command.run({ command: 'sentinel', args: 'system' })
  expect(diffRuns(eng)).toBe(2)
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'Refunds', states: [{ id: 'service', label: 'RefundService', files: ['src/**'], parts: ['refunds'] }, { id: 'verify', label: 'Full suite' }] })
  expect(diffRuns(eng)).toBe(3)
  await clock.advance(60_000)
  expect(diffRuns(eng)).toBe(3)
})

test('a draft that names a part which drifted tells Claude to redraw it, and names the reason', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng)
  await $.tool.call({ tool: 'ExitPlanMode' })
  const told = async (r: Promise<any>) => { const got = await r; return [said(got), ...(got.context ?? [])].join('\n') }
  const out = await told($.tool.call({ tool: TOOL, action: 'define', title: 'Refunds', states: [{ id: 'service', label: 'RefundService', files: ['src/**'], parts: ['refunds'] }, { id: 'verify', label: 'Full suite' }] }))
  expect(out).toContain('changed since the map was drawn: refunds (1 file changed since it was drawn: 1 edited.)')
  expect(out).toMatch(/Reread/)
  // A plan that names only parts which did not drift hears nothing of it.
  await $.command.run({ command: 'sentinel', args: 'finish enough for now' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  const quiet = await told($.tool.call({ tool: TOOL, action: 'define', title: 'Guide', states: [{ id: 'docs', label: 'Guide', files: ['guide/**'], parts: ['guide'] }, { id: 'verify', label: 'Full suite' }] }))
  expect(quiet).toContain('Locked "Guide"')
  expect(quiet).not.toMatch(/changed since the map was drawn/)
})

test('with no git repo nothing is marked, and the System screens say there is nothing to compare with', async ($: any, on: any) => {
  const eng = engine(on)
  eng.setHead(undefined)
  await started($, on, eng)
  expect(eng.snap().system.drift).toMatchObject({ count: 0, noGit: true })
  expect(diffRuns(eng)).toBe(0)
})

test('a commit git does not know marks every part with files, and the reason says what happened', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng, {})
  expect(eng.snap().system.drift.count).toBe(2)
  expect(eng.snap().system.drift.why.guide).toMatch(/aaa1111\) is gone from this repo/)
})

test('files added since the map was drawn that no part covers are listed, new and tracked alike', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[`${ROOT}/billing/invoice.ts`] = 'x'
  await started($, on, eng, { aaa1111: [{ how: 'A', path: 'billing/invoice.ts' }] }, undefined, { untracked: ['notes/todo.md'] })
  expect(eng.snap().system.drift.loose).toEqual(['billing/invoice.ts', 'notes/todo.md'])
})

test('the band says how many parts changed, with nothing running', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng, { aaa1111: [{ how: 'M', path: 'src/refund.ts' }, { how: 'M', path: 'guide/a.md' }] })
  eng.files[`${ROOT}/guide/a.md`] = 'x'
  await $.tool.call({ tool: TOOL, action: 'status' })
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Sentinel: 2 parts changed since the map was drawn/ })).toBeDefined()
  await ui.unmount()
})

test('the band stays quiet when nothing drifted', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng, { aaa1111: [] })
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /changed since the map was drawn/ })).toBeUndefined()
  await ui.unmount()
})


// ---- "It's fine" ----

const marksOf = (eng: ReturnType<typeof engine>) => JSON.parse(eng.files[MARKS] ?? '{}')
const fineFrom = async ($: any, on: any, eng: ReturnType<typeof engine>) => {
  const clock = mock.clock(on)
  eng.files[`${ROOT}/guide/intro.md`] = 'welcome'
  await started($, on, eng, { aaa1111: [{ how: 'M', path: 'src/refund.ts' }, { how: 'M', path: 'guide/intro.md' }] }, clock)
  return clock
}

test('"It\'s fine" from the page clears the mark, keeps the proof apart, and the mark returns when the files change again', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await fineFrom($, on, eng)
  expect(eng.snap().system.drift.count).toBe(2)
  eng.page({ kind: 'fine', id: 'refunds' })
  await until(clock, () => eng.snap().system.drift.count === 1)
  expect(marksOf(eng).refunds.fine).toMatch(/^[0-9a-f]{16}$/)
  expect(leaf(eng, 'refunds').status.tags).not.toContain('changed-since-drawn')
  expect(leaf(eng, 'guide').status.tags).toContain('changed-since-drawn')
  // The files change again, and the System page opens: the mark is back.
  eng.files[REFUND] = 'changed once more'
  await $.command.run({ command: 'sentinel', args: 'system' })
  await until(clock, () => eng.snap().system.drift.count === 2)
  expect(leaf(eng, 'refunds').status.tags).toContain('changed-since-drawn')
})

test('"It\'s fine" on an area clears every part inside it that had a mark', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await fineFrom($, on, eng)
  eng.page({ kind: 'fine', id: 'shop' })
  await until(clock, () => eng.snap().system.drift.count === 0)
  expect(Object.keys(marksOf(eng)).sort()).toEqual(['guide', 'refunds'])
})

test('/sentinel fine does what the button does, and says what it did', async ($: any, on: any) => {
  const eng = engine(on)
  await fineFrom($, on, eng)
  const out = said(await $.command.run({ command: 'sentinel', args: 'fine refunds' }))
  expect(out).toBe('Marked Refunds as fine. The mark comes back if its files change again.')
  expect(eng.snap().system.drift.count).toBe(1)
  expect(said(await $.command.run({ command: 'sentinel', args: 'fine refunds' }))).toBe('Refunds has no mark to clear.')
  expect(said(await $.command.run({ command: 'sentinel', args: 'fine nowhere' }))).toBe('"nowhere" is not a part of the map.')
  expect(said(await $.command.run({ command: 'sentinel', args: 'fine' }))).toMatch(/Say which part/)
})

test('"It\'s fine" for a part that has no mark writes nothing', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on)
  await started($, on, eng, { aaa1111: [] }, clock)
  eng.page({ kind: 'fine', id: 'refunds' })
  await clock.advance(50)
  expect(eng.files[MARKS]).toBeUndefined()
})

test('a mark the user said was fine stays away across a new session', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await fineFrom($, on, eng)
  await $.command.run({ command: 'sentinel', args: 'fine refunds' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: TOOL, action: 'status' })
  await clock.advance(50)
  expect(eng.snap().system.drift.count).toBe(1)
})

// ---- past plans ----

const PLANS = `${ROOT}/.sentinel/plans.json`
const BUILD = [{ id: 'build', label: 'Build the refunds', files: ['src/**'], parts: ['refunds'] }, { id: 'ship', label: 'Ship it' }]
const plan = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })
const plansOf = (eng: ReturnType<typeof engine>) => JSON.parse(eng.files[PLANS] ?? '[]')
// A plan that runs from its lock to the last state, ready to be finished or closed.
async function planned($: any, eng: ReturnType<typeof engine>, title = 'Take payment') {
  eng.files[SYSTEM] = DRAWN
  await $.tool.call({ tool: 'ExitPlanMode' })
  await plan($, { action: 'define', title, states: BUILD })
  await plan($, { action: 'advance', to: 'ship', evidence: 'the refund code is in' })
}
const complete = ($: any) => plan($, { action: 'advance', to: 'done', evidence: 'shipped' })

test('a plan that completes leaves one line: its title, the day, how it ended and the parts it built', async ($: any, on: any) => {
  const eng = engine(on)
  await planned($, eng)
  expect(eng.files[PLANS]).toBeUndefined()
  expect(said(await complete($))).toMatch(/complete/i)
  const lines = plansOf(eng)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ title: 'Take payment', ended: 'complete', parts: ['refunds'] })
  expect(lines[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)
})

test('a plan the user closed with /sentinel finish says so in its line', async ($: any, on: any) => {
  const eng = engine(on)
  await planned($, eng)
  await $.command.run({ command: 'sentinel', args: 'finish enough for now' })
  expect(plansOf(eng).map((l: any) => l.ended)).toEqual(['closed'])
})

test('lines add up across plans, newest last, and only the last 200 are kept', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[PLANS] = JSON.stringify(Array.from({ length: 200 }, (_, k) => ({ title: `Old ${k}`, at: '2026-01-01T00:00:00.000Z', ended: 'complete', parts: [] })))
  await planned($, eng, 'Newest')
  await complete($)
  const lines = plansOf(eng)
  expect(lines).toHaveLength(200)
  expect(lines[0].title).toBe('Old 1')
  expect(lines.at(-1).title).toBe('Newest')
})

test('a plans file that does not read is started over, and a field of the wrong type is dropped', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[PLANS] = JSON.stringify([{ title: 7, at: 'x', ended: 'complete', parts: [] }, { title: 'Fine', at: '2026-01-01T00:00:00.000Z', ended: 'complete', parts: ['a', 3] }])
  await planned($, eng)
  await complete($)
  expect(plansOf(eng).map((l: any) => l.title)).toEqual(['Fine', 'Take payment'])
  expect(plansOf(eng)[0].parts).toEqual(['a'])
  eng.files[PLANS] = 'not json {'
  await planned($, eng, 'Again')
  await complete($)
  expect(plansOf(eng).map((l: any) => l.title)).toEqual(['Again'])
})

test('the System view lists past plans, newest first, with only the parts still on the map', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on)
  eng.files[PLANS] = JSON.stringify([
    { title: 'First', at: '2026-01-01T00:00:00.000Z', ended: 'complete', parts: ['guide', 'gone'] },
    { title: 'Second', at: '2026-02-01T00:00:00.000Z', ended: 'closed', parts: ['refunds'] },
  ])
  await started($, on, eng, { aaa1111: [] }, clock)
  expect(eng.snap().system.plans).toEqual([
    { title: 'Second', at: '2026-02-01T00:00:00.000Z', ended: 'closed', parts: ['refunds'] },
    { title: 'First', at: '2026-01-01T00:00:00.000Z', ended: 'complete', parts: ['guide'] },
  ])
})

test('before the first plan finishes the System view has no list of plans', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng, { aaa1111: [] })
  expect(eng.snap().system.plans).toBeUndefined()
})

test('a plan that finishes shows in the list at once', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on)
  await started($, on, eng, { aaa1111: [] }, clock)
  await planned($, eng)
  await complete($)
  await until(clock, () => eng.snap().system?.plans?.length === 1)
  expect(eng.snap().system.plans[0]).toMatchObject({ title: 'Take payment', parts: ['refunds'] })
})

// ---- Redraw this area ----

const ESC = Symbol('esc')
type Asked = { question: string; header?: string; options: { label: string }[] }
function dialog(eng: ReturnType<typeof engine>, how: (q: Asked) => string | typeof ESC) {
  const seen: Asked[] = []
  eng.setDialog(async (e: any) => {
    const q = e.questions[0] as Asked
    seen.push(q)
    const a = how(q)
    if (a === ESC) return { deny: 'The user dismissed the question' }
    return { result: { questions: e.questions, answers: { [q.question]: a } }, text: 'answered' }
  })
  return seen
}
const yes = (q: Asked) => q.options[0]!.label
const no = (q: Asked) => q.options[1]!.label
const REDRAWN = { id: 'refunds', name: 'Refunds', parent: 'shop', files: ['src/refund*.ts'], desc: 'Refunds and the queue behind them' }
const redraw = ($: any, input: object = {}) => plan($, { action: 'map', redraw: ['refunds'], system: { parts: [REDRAWN] }, ...input })
const mapFile = (eng: ReturnType<typeof engine>) => JSON.parse(eng.files[SYSTEM]!).parts as SysPart[]
const partIn = (eng: ReturnType<typeof engine>, id: string) => mapFile(eng).find(p => p.id === id)!

test('asking for a redraw tells Claude which area, which files, and what to send back', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await fineFrom($, on, eng)
  eng.page({ kind: 'redraw', id: 'refunds' })
  await until(clock, () => eng.submitted.some(t => /redraw Refunds/.test(t)))
  const told = eng.submitted.find(t => /redraw Refunds/.test(t))!
  expect(told).toContain('(refunds)')
  expect(told).toContain('src/refund*.ts')
  expect(told).toContain('"redraw": ["refunds"]')
  expect(told).toContain('1 file changed since it was drawn: 1 edited.')
})

test('/sentinel redraw asks Claude the same, and says so', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await fineFrom($, on, eng)
  expect(said(await $.command.run({ command: 'sentinel', args: 'redraw shop' }))).toBe('Asked Claude to redraw Shop.')
  // A command holds the turn while it runs, so Claude hears once it has returned.
  await until(clock, () => eng.submitted.some(t => /redraw Shop/.test(t)))
  const told = eng.submitted.find(t => /redraw Shop/.test(t))!
  expect(told).toContain('refunds (src/refund*.ts)')
  expect(told).toContain('guide (guide/**)')
  expect(told).toContain('"redraw": ["shop"]')
  expect(said(await $.command.run({ command: 'sentinel', args: 'redraw nowhere' }))).toBe('"nowhere" is not a part of the map.')
  expect(said(await $.command.run({ command: 'sentinel', args: 'redraw' }))).toMatch(/Say which part/)
})

test('a redraw ends with a question that names the area and what changed', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  eng.files[SYSTEM] = DRAWN
  await redraw($)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.question).toBe('Claude redrew Refunds.\nIt changes Refunds.\nKeep the new drawing? A yes also marks it as drawn today.')
  expect(seen[0]!.options.map(o => o.label)).toEqual(['Yes, keep it', 'No, keep the old one'])
  expect(seen[0]!.header).toBe('Your OK')
})

test('a redraw that finds nothing to change asks whether to mark the area up to date', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  eng.files[SYSTEM] = DRAWN
  await plan($, { action: 'map', redraw: ['refunds'] })
  expect(seen[0]!.question).toBe('Claude reread Refunds and found the drawing still right.\nMark it as up to date?')
  expect(seen[0]!.options.map(o => o.label)).toEqual(['Yes, mark it up to date', 'No, leave it'])
})

test('a redraw that adds, changes and takes off parts says each in the question', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  eng.files[SYSTEM] = DRAWN
  await plan($, { action: 'map', redraw: ['shop'], drop: ['guide'], system: { parts: [REDRAWN, { id: 'queue', name: 'Refund queue', parent: 'shop', files: ['src/queue.ts'] }] } })
  expect(seen[0]!.question).toBe('Claude redrew Shop.\nIt adds Refund queue, changes Refunds and takes off Guide.\nKeep the new drawing? A yes also marks it as drawn today.')
})

test('Yes keeps the new drawing, and moves the marker of the parts Claude redrew to today', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, yes)
  eng.files[SYSTEM] = DRAWN
  const out = said(await redraw($))
  expect(out).toMatch(/The user kept the new drawing of Refunds/)
  expect(partIn(eng, 'refunds')).toMatchObject({ desc: 'Refunds and the queue behind them', drawnAt: 'abc1234' })
  expect(partIn(eng, 'guide').drawnAt).toBe('aaa1111')
})

test('Yes on an area moves the marker of every part inside it, redrawn or not', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, yes)
  eng.files[SYSTEM] = DRAWN
  await plan($, { action: 'map', redraw: ['shop'] })
  // The file lists parts by id.
  expect(mapFile(eng).map(p => [p.id, p.drawnAt])).toEqual([['guide', 'abc1234'], ['refunds', 'abc1234'], ['shop', 'abc1234']])
})

test('Yes on a redraw that takes a part off removes it', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, yes)
  eng.files[SYSTEM] = DRAWN
  await plan($, { action: 'map', redraw: ['shop'], drop: ['guide'], system: { parts: [] } })
  expect(mapFile(eng).map(p => p.id)).toEqual(['refunds', 'shop'])
})

test('No, words and Esc keep the old drawing exactly, and Claude hears which', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = DRAWN
  dialog(eng, no)
  expect(said(await redraw($))).toMatch(/said no, so the old drawing of Refunds stays\. Ask what they want changed\./)
  dialog(eng, () => 'It needs the queue too.')
  const words = said(await redraw($))
  expect(words).toContain('"It needs the queue too."')
  expect(words).toMatch(/old drawing of Refunds stays/)
  dialog(eng, () => ESC)
  expect(said(await redraw($))).toMatch(/closed the question without answering, so the old drawing of Refunds stays/)
  expect(eng.files[SYSTEM]).toBe(DRAWN)
})

test('after Esc on a redraw the band keeps an Answer button, and a yes keeps the drawing with no second read', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.files[SYSTEM] = DRAWN
  dialog(eng, () => ESC)
  expect(said(await redraw($))).toMatch(/Answer button above the prompt/)
  expect(eng.files[SYSTEM]).toBe(DRAWN)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Claude redrew Refunds\. You closed this question\./ })).toBeDefined()
  const seen = dialog(eng, yes)
  await ui.press({ key: 'answer' })
  await until(clock, () => eng.submitted.some(t => /kept the new drawing of Refunds/.test(t)))
  expect(seen).toHaveLength(1)
  expect(seen[0]!.options.map(o => o.label)).toEqual(['Yes, keep it', 'No, keep the old one'])
  expect(partIn(eng, 'refunds').desc).toBe('Refunds and the queue behind them')
  expect(await ui.find({ type: 'Button', text: 'Answer' })).toBeUndefined()
  await ui.unmount()
})

test('after Esc on a redraw, a no leaves the old drawing and Claude hears it', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.files[SYSTEM] = DRAWN
  dialog(eng, () => ESC)
  await redraw($)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  dialog(eng, no)
  await ui.press({ key: 'answer' })
  await until(clock, () => eng.submitted.some(t => /said no, so the old drawing of Refunds stays/.test(t)))
  expect(eng.files[SYSTEM]).toBe(DRAWN)
  expect(await ui.find({ type: 'Button', text: 'Answer' })).toBeUndefined()
  await ui.unmount()
})

test('a closed redraw question is dropped once the map has changed, so it can\'t write over the newer one', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.files[SYSTEM] = DRAWN
  dialog(eng, () => ESC)
  await redraw($)
  const newer = JSON.stringify({ version: 1, name: 'Shop', actors: [], lines: [], parts: SHOP.parts.map(p => (p.id === 'guide' ? { ...p, desc: 'Edited by hand' } : p)) })
  eng.files[SYSTEM] = newer
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  const seen = dialog(eng, yes)
  await ui.press({ key: 'answer' })
  await until(clock, () => eng.toasts.some((t: string) => /no longer applies/.test(t)))
  expect(seen).toHaveLength(0)
  expect(eng.files[SYSTEM]).toBe(newer)
  expect(await ui.find({ type: 'Button', text: 'Answer' })).toBeUndefined()
  await ui.unmount()
})

test('with a draft open a redraw is refused without a question: the draft carries the drawing', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  eng.files[SYSTEM] = DRAWN
  await $.command.run({ command: 'sentinel', args: 'lock' })
  await plan($, { action: 'define', title: 'Take payment', states: BUILD })
  expect(said(await redraw($))).toMatch(/A draft is open, so put the redrawn parts in its "system" with revise/)
  expect(seen).toHaveLength(0)
  expect(eng.files[SYSTEM]).toBe(DRAWN)
})

test('a redraw of a part that is not on the map, or of nothing, is refused without a question', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  eng.files[SYSTEM] = DRAWN
  expect(said(await redraw($, { redraw: ['nowhere'] }))).toMatch(/"nowhere" is not a part of the map/)
  expect(said(await redraw($, { redraw: [] }))).toMatch(/redraw needs/)
  expect(said(await redraw($, { redraw: 'refunds' }))).toMatch(/redraw needs/)
  expect(seen).toHaveLength(0)
  expect(eng.files[SYSTEM]).toBe(DRAWN)
})

test('with no map there is nothing to redraw', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  expect(said(await redraw($))).toMatch(/There is no map/)
  expect(seen).toHaveLength(0)
})

test('after Yes the update check no longer marks the area it redrew', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on)
  await started($, on, eng, { aaa1111: [{ how: 'M', path: 'src/refund.ts' }], abc1234: [] }, clock)
  expect(eng.snap().system.drift.count).toBe(1)
  dialog(eng, yes)
  await redraw($)
  await until(clock, () => eng.snap().system.drift.count === 0)
  expect(leaf(eng, 'refunds').status.tags).not.toContain('changed-since-drawn')
})

test('during a plan a redraw asks nothing: the drawing changes at once and shows under Changes', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  await planned($, eng)
  const out = said(await plan($, { action: 'map', redraw: ['guide'], system: { parts: [{ id: 'guide', name: 'Guide', parent: 'shop', files: ['guide/**'], desc: 'How to use the shop' }] } }))
  expect(out).toMatch(/Map updated: drew guide/)
  expect(seen).toHaveLength(0)
  expect(partIn(eng, 'guide')).toMatchObject({ desc: 'How to use the shop', drawnAt: 'abc1234' })
  expect(said(await plan($, { action: 'map', redraw: ['nowhere'] }))).toMatch(/"nowhere" is not a part of the map/)
})

// ---- the System tab in the terminal ----

const EL = { Box: 'Box', Text: 'Text', Button: 'Button' }
// Each Text the pane draws is one row; a row Box puts its children side by side.
const text = (n: any): string => {
  if (n === null || n === undefined || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(text).join('')
  if (n.type === 'Button') return `[${n.props.label}]`
  const kids = n.children
  if (n.type === 'Box') {
    const list: any[] = (Array.isArray(kids) ? kids : [kids]).flat(Infinity)
    return list.map(text).filter(s => s !== '').join(n.props?.flexDirection === 'row' ? ' ' : '\n')
  }
  return text(kids)
}
const looking = (over: Partial<MapLook> = {}): MapLook => ({ map: SHOP, now: {}, ...over })
const paneOf = (l: MapLook, v: View = 'system', r: Run = emptyRun()) => text(renderPane(EL, summarize(r, l), v, { pick: () => {}, browser: () => {} }))
const rows = (s: string) => s.split('\n')
const row = (s: string, name: string) => rows(s).find(l => l.includes(name))!
const DRIFTED = drift(SHOP, facts({ aaa1111: [{ how: 'M', path: 'src/refund.ts' }, { how: 'A', path: 'billing/invoice.ts' }] }, ['src/refund.ts', 'billing/invoice.ts', 'guide/a.md']))

test('with no plan running the System tab shows the project\'s map, and the other tabs still say there is no plan', () => {
  const out = paneOf(looking())
  expect(out).not.toMatch(/No plan locked/)
  expect(rows(out)[0]).toBe('[Focus] [Map] [Ledger] [System] [Browser]')
  expect(rows(out).some(l => /^▾ Shop {2}2 parts/.test(l))).toBe(true)
  expect(paneOf(looking(), 'focus')).toMatch(/No plan locked/)
  expect(paneOf({}, 'system')).toMatch(/No plan locked/)
})

test('the tab says how many parts changed since the map was drawn, and how to deal with one', () => {
  const out = paneOf(looking({ drift: DRIFTED }))
  expect(rows(out)).toContain('↻ 1 part changed since the map was drawn.')
  expect(out).toContain('Claude rereads one: /sentinel redraw <part>')
  expect(out).toContain('Mark one as fine: /sentinel fine <part>')
  expect(paneOf(looking({ drift: drift(SHOP, facts({ aaa1111: [] }, [])) }))).not.toMatch(/changed since the map was drawn/)
})

test('a part that changed says why, right under it, and the other parts say nothing', () => {
  const r = rows(paneOf(looking({ drift: DRIFTED })))
  const at = r.findIndex(l => l.includes('Refunds'))
  expect(r[at]).toMatch(/Changed since drawn/)
  expect(r.slice(at + 1, at + 3).join('\n')).toContain('1 file changed since it was drawn: 1 edited.')
  const guide = r.findIndex(l => l.includes('Guide'))
  expect(r.slice(guide, guide + 2).join('\n')).not.toContain('since it was drawn')
})

test('files in no part are listed, and a long list is cut after five', () => {
  expect(paneOf(looking({ drift: DRIFTED }))).toContain('Files in no part\n  billing/invoice.ts')
  const many = { ...DRIFTED, loose: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'] }
  expect(paneOf(looking({ drift: many }))).toContain('  a.ts, b.ts, c.ts, d.ts, e.ts and 2 more')
  expect(paneOf(looking({ drift: { ...DRIFTED, loose: [] } }))).not.toContain('Files in no part')
})

test('with no git the tab says there is nothing to compare with, and marks nothing', () => {
  const out = paneOf(looking({ drift: drift(SHOP, facts({}, [], false)) }))
  expect(out).toContain("No git here, so Sentinel can't tell what changed since the map was drawn.")
  expect(out).not.toMatch(/↻/)
})

const PLAN_LINES: PlanLine[] = [
  { title: 'Take payment', at: '2026-11-03T10:00:00.000Z', ended: 'complete', parts: ['refunds', 'guide'] },
  { title: 'Try a thing', at: '2026-10-30T09:00:00.000Z', ended: 'closed', parts: [] },
]

test('past plans are listed with when, how they ended and the parts they built', () => {
  const out = paneOf(looking({ plans: PLAN_LINES }))
  expect(rows(out)).toContain('Past plans')
  expect(row(out, 'Take payment')).toBe('  Take payment · finished 3 Nov 2026 · built Refunds, Guide')
  expect(row(out, 'Try a thing')).toBe('  Try a thing · closed early 30 Oct 2026')
  expect(paneOf(looking())).not.toContain('Past plans')
})

test('only the five latest plans show, and the pane says how many it left out', () => {
  const many = Array.from({ length: 8 }, (_, k): PlanLine => ({ title: `Plan ${k}`, at: '2026-11-03T10:00:00.000Z', ended: 'complete', parts: [] }))
  // The file lists the oldest first, so the last in it is the newest.
  const out = paneOf(looking({ plans: many }))
  expect(out).toContain('Plan 7')
  expect(out).toContain('Plan 3')
  expect(out).not.toContain('Plan 2')
  expect(out).toContain('  and 3 more')
  expect(rows(out).findIndex(l => l.includes('Plan 7'))).toBeLessThan(rows(out).findIndex(l => l.includes('Plan 6')))
})

// ---- found by breaking the code one way at a time: each of these failed to fail before it was added ----

test('a part that covers everything still skips Sentinel\'s own folder, and an outside part or a group is never marked, files or not', () => {
  const map = mapOf([
    part('shop', ['shop/**'], { drawnAt: 'aaa1111' }),
    part('bank', ['bank/**'], { parent: 'shop', kind: 'outside', evidence: { guess: 'seen in a call' }, drawnAt: 'aaa1111' }),
    part('all', ['**'], { parent: 'shop', drawnAt: 'aaa1111' }),
  ])
  const since = { aaa1111: [{ how: 'M', path: '.sentinel/system.json' }, { how: 'M', path: 'shop/a.ts' }, { how: 'M', path: 'bank/b.ts' }] as const }
  const d = drift(map, facts({ aaa1111: [...since.aaa1111] }, ['shop/a.ts', 'bank/b.ts']))
  expect(d.parts).toEqual({ all: 'changed' })
  expect(d.why.all).toBe('2 files changed since it was drawn: 2 edited.')
})

test('a file renamed inside one part is an edit to it', () => {
  const d = drift(SHOP, facts({ aaa1111: [{ how: 'R', was: 'src/refund.ts', path: 'src/refund-v2.ts' }] }, ['src/refund-v2.ts']))
  expect(d.why.refunds).toBe('1 file changed since it was drawn: 1 edited.')
})

test('files in no part: added or renamed ones that still exist, and never Sentinel\'s own', () => {
  const d = drift(SHOP, facts({ aaa1111: [
    { how: 'A', path: '.sentinel/plans.json' }, { how: 'A', path: 'billing/gone.ts' }, { how: 'M', path: 'billing/edited.ts' },
    { how: 'R', was: 'old/x.ts', path: 'billing/moved.ts' }, { how: 'A', path: 'billing/new.ts' },
  ] }, ['.sentinel/plans.json', 'billing/edited.ts', 'billing/moved.ts', 'billing/new.ts']))
  expect(d.loose).toEqual(['billing/moved.ts', 'billing/new.ts'])
})

test('an area holds every part inside it, at any depth', () => {
  const map = mapOf([part('a', undefined), part('b', undefined, { parent: 'a' }), part('c', ['c/**'], { parent: 'b' }), part('d', ['d/**'])])
  expect(partsInside(map, 'a').sort()).toEqual(['a', 'b', 'c'])
  expect(partsInside(map, 'd')).toEqual(['d'])
})

test('plans.json is read as untrusted: a list of real plans, text cut, the last 200', () => {
  const line = (k: number) => ({ title: `P${k}`, at: '2026-01-01T00:00:00.000Z', ended: 'complete', parts: [] })
  expect(parsePlans(JSON.stringify(line(1)))).toEqual([])
  expect(parsePlans(JSON.stringify([{ ...line(1), ended: 'running' }, line(2)])).map(l => l.title)).toEqual(['P2'])
  expect(parsePlans(JSON.stringify([{ ...line(1), title: 'x'.repeat(300) }]))[0]!.title).toHaveLength(120)
  const many = parsePlans(JSON.stringify(Array.from({ length: 205 }, (_, k) => line(k))))
  expect(many).toHaveLength(200)
  expect(many[0]!.title).toBe('P5')
})

test('the System view carries only the ten latest plans, newest first', () => {
  const lines = Array.from({ length: 12 }, (_, k): PlanLine => ({ title: `P${k}`, at: '2026-01-01T00:00:00.000Z', ended: 'complete', parts: [] }))
  const shown = summarize(emptyRun(), looking({ plans: lines })).system!.plans!
  expect(shown.map(p => p.title)).toEqual(Array.from({ length: 10 }, (_, k) => `P${11 - k}`))
})

const changed = (over: object): any => ({ added: [], edited: [], dropped: [], linesAdded: [], linesDropped: [], ...over })

test('the redraw question counts lines, and cuts a long list of names after five', () => {
  expect(redrawAsk(['Refunds'], changed({ linesAdded: [{}] })).question).toBe('Claude redrew Refunds.\nIt redraws 1 line.\nKeep the new drawing? A yes also marks it as drawn today.')
  expect(redrawAsk(['Refunds'], changed({ linesAdded: [{}, {}], linesDropped: [{}] })).question).toContain('It redraws 3 lines.')
  const seven = Array.from({ length: 7 }, (_, k) => ({ id: `n${k}`, name: `N${k}` }))
  expect(redrawAsk(['Shop'], changed({ added: seven })).question).toContain('It adds N0, N1, N2, N3, N4 and 2 more.')
})

test('what Claude hears of a Yes says whether the drawing changed', () => {
  expect(redrawText(['Refunds'], { how: 'yes' } as any, true)).toBe('The user marked Refunds as up to date.')
  expect(redrawText(['Refunds'], { how: 'yes' } as any, false)).toBe('The user kept the new drawing of Refunds. Its marker moved to today.')
})

test('a redraw that only moves a line still asks, a repeated id names the area once, and a blank id is refused', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  eng.files[SYSTEM] = DRAWN
  await plan($, { action: 'map', redraw: ['refunds', 'refunds'], system: { lines: [{ from: 'refunds', to: 'guide', says: 'links to' }] } })
  expect(seen[0]!.question).toBe('Claude redrew Refunds.\nIt redraws 1 line.\nKeep the new drawing? A yes also marks it as drawn today.')
  expect(said(await plan($, { action: 'map', redraw: [''] }))).toMatch(/redraw needs/)
  expect(seen).toHaveLength(1)
})

test('a redraw after a plan finished starts from the map file as it is now, not from the finished plan\'s drawing', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  await planned($, eng)
  await complete($)
  eng.files[SYSTEM] = JSON.stringify({ version: 1, name: 'Shop', actors: [], lines: [], parts: SHOP.parts.map(p => (p.id === 'guide' ? { ...p, desc: 'Edited by hand' } : p)) })
  await plan($, { action: 'map', redraw: ['refunds'] })
  expect(seen[0]!.question).toBe('Claude reread Refunds and found the drawing still right.\nMark it as up to date?')
})

test('"It\'s fine" leaves the proof already recorded for the part as it was', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[MARKS] = JSON.stringify({ refunds: { hash: 'old', check: 'npm test', at: '2026-01-01T00:00:00.000Z' } })
  await fineFrom($, on, eng)
  await $.command.run({ command: 'sentinel', args: 'fine refunds' })
  expect(marksOf(eng).refunds).toMatchObject({ hash: 'old', check: 'npm test' })
  expect(marksOf(eng).refunds.fine).toMatch(/^[0-9a-f]{16}$/)
})

test('a file git lists but the disk no longer has does not keep its part alive', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng, { aaa1111: [{ how: 'D', path: 'guide/a.md' }] }, undefined, { deleted: ['guide/a.md'] })
  expect(eng.snap().system.drift.why.guide).toBe("All 1 of its files are gone. Git can't tell where they went.")
})

test('git\'s renames and deletions are read as such, not as edits', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[`${ROOT}/docs/a.md`] = 'moved'
  await started($, on, eng, { aaa1111: [{ how: 'R', was: 'guide/a.md', path: 'docs/a.md' }, { how: 'D', path: 'guide/b.md' }] })
  expect(eng.snap().system.drift.why.guide).toBe('All 2 of its files are gone. Git sees them moved to docs/.')
})

test('the band says nothing of drift while a plan runs, and the question about a drafted flow comes first', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng, { aaa1111: [{ how: 'M', path: 'src/refund.ts' }] })
  const flow = { action: 'flow', name: 'ui-check', description: 'Look at the screenshots.', states: [{ id: 'shots', label: 'Save the screenshots' }, { id: 'look', label: 'You look', wait: 'after' }] }
  await plan($, flow)
  const held = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await held.find({ type: 'Text', text: /Claude drafted the flow "ui-check"/ })).toBeDefined()
  expect(await held.find({ type: 'Text', text: /changed since the map was drawn/ })).toBeUndefined()
  await held.unmount()
  await $.command.run({ command: 'sentinel', args: 'flow discard' })
  await planned($, eng)
  const live = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await live.find({ type: 'Text', text: /changed since the map was drawn/ })).toBeUndefined()
  await live.unmount()
})

test('a plan that builds one part in two states leaves the part once in its line', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = DRAWN
  await $.tool.call({ tool: 'ExitPlanMode' })
  await plan($, { action: 'define', title: 'Twice', states: [{ id: 'one', label: 'One', files: ['src/**'], parts: ['refunds'] }, { id: 'two', label: 'Two', files: ['src/**'], parts: ['refunds'] }, { id: 'ship', label: 'Ship it' }] })
  await plan($, { action: 'advance', to: 'two', evidence: 'one done' })
  await plan($, { action: 'advance', to: 'ship', evidence: 'two done' })
  await complete($)
  expect(plansOf(eng)[0].parts).toEqual(['refunds'])
})

// What a draft hears about the parts it names that drifted.
const drafted = async ($: any, ids: string[]) => {
  const got = await plan($, { action: 'define', title: 'Several', states: [...ids.map(id => ({ id: `build-${id}`, label: `Build ${id}`, files: [`${id}/**`], parts: [id] })), { id: 'verify', label: 'Full suite' }] })
  return [said(got), ...(got.context ?? [])].join('\n')
}

test('the note to a draft names only the parts it builds, and leaves out the ones the user said were fine', async ($: any, on: any) => {
  const eng = engine(on)
  await fineFrom($, on, eng)
  await $.tool.call({ tool: 'ExitPlanMode' })
  const first = await drafted($, ['refunds'])
  expect(first).toContain('refunds (1 file')
  expect(first).not.toContain('guide (1 file')
  await $.command.run({ command: 'sentinel', args: 'finish enough for now' })
  await $.command.run({ command: 'sentinel', args: 'fine refunds' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  const again = await drafted($, ['refunds'])
  expect(again).toContain('Locked "Several"')
  expect(again).not.toMatch(/changed since the map was drawn/)
})

test('the note to a draft lists six drifted parts and counts the rest', async ($: any, on: any) => {
  const eng = engine(on)
  await started($, on, eng, {})
  const ids = Array.from({ length: 7 }, (_, k) => `p${k}`)
  eng.files[SYSTEM] = JSON.stringify({ version: 1, name: 'Big', actors: [], lines: [], parts: [part('shop', undefined), ...ids.map(id => part(id, [`${id}/**`], { parent: 'shop', drawnAt: 'aaa1111' }))] })
  await $.tool.call({ tool: 'ExitPlanMode' })
  const out = await drafted($, ids)
  expect(out).toContain('p5 (The commit')
  expect(out).not.toContain('p6 (The commit')
  expect(out).toContain('; and 1 more')
})

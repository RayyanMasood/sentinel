// The system map's marks through the real engine: where each part stood when its state started, and the proof a passing
// check leaves. Git is the kit's fake over the in-memory files.
import { expect, mock } from 'claude-code/testing'
import { editedSince } from '../hooks/core'
import { REFUND, ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const SYSTEM = `${ROOT}/.sentinel/system.json`
const MARKS = `${ROOT}/.sentinel/marks.json`
const MAP = JSON.stringify({
  version: 1, name: 'Shop', actors: [], lines: [],
  parts: [
    { id: 'refunds', name: 'Refunds', files: ['src/refund*.ts'] },
    { id: 'guide', name: 'Guide', files: ['guide/**'] },
    { id: 'queue', name: 'Queue', kind: 'outside', evidence: { said: 'we use one' } },
  ],
})
const STATES = [
  { id: 'explore', label: 'Read payments code' },
  { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'], parts: ['refunds'] },
  { id: 'docs', label: 'Guide', check: 'npm test -- guide', files: ['guide/**'], parts: ['guide'] },
  { id: 'verify', label: 'Full suite', check: 'npm test' },
]
const LOOPS = [['verify', 'service']]
const marksOf = (eng: ReturnType<typeof engine>) => JSON.parse(eng.files[MARKS] ?? '{}')
const HEX = /^[0-9a-f]{16}$/
const gitLists = (eng: ReturnType<typeof engine>) => eng.runs.filter(r => r.argv.includes('ls-files')).length

// Signs off, locks the plan and enters `service`, whose check fails there as a check should. afterLock: what happens to
// the project once the plan has locked, such as the map file going missing.
async function toService($: any, eng: ReturnType<typeof engine>, states: object[] = STATES, afterLock?: () => void) {
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'Refunds', states, loops: LOOPS })
  afterLock?.()
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  eng.setBash({ fail: true, text: 'Tests: 1 failed' })
  return said(await $.tool.call({ tool: TOOL, action: 'advance', to: 'service', evidence: 'found it' }))
}
const plan = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })
// Changes the refund file, as the model's edit does, and has the check pass.
async function build($: any, eng: ReturnType<typeof engine>) {
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'original', new_string: 'built' })
  eng.setBash({ fail: false, text: '14 passed' })
}

test('a state starting records where the parts it builds stand', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  expect(await toService($, eng)).toMatch(/Moved to service/)
  const marks = marksOf(eng)
  expect(Object.keys(marks)).toEqual(['refunds'])
  expect(marks.refunds.base).toMatch(HEX)
  expect(marks.refunds.since).toMatch(/^service@\d+$/)
  expect(marks.refunds.hash).toBeUndefined()
})

test('asking again in the same state does not move the baseline', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await toService($, eng)
  const first = marksOf(eng).refunds
  const listed = gitLists(eng)
  expect(listed).toBeGreaterThan(0)
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'original', new_string: 'built' })
  await plan($, { action: 'status' })
  await plan($, { action: 'status' })
  expect(marksOf(eng).refunds).toEqual(first)
  expect(gitLists(eng)).toBe(listed)
})

test('a passing check records the proof, and the next state records its own baseline', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await toService($, eng)
  const base = marksOf(eng).refunds.base
  await build($, eng)
  expect(said(await plan($, { action: 'advance', to: 'docs' }))).toMatch(/Moved to docs/)
  const marks = marksOf(eng)
  expect(marks.refunds.hash).toMatch(HEX)
  expect(marks.refunds.hash).not.toBe(base)
  expect(marks.refunds.from).toBe(base)
  expect(marks.refunds.check).toBe('npm test -- refund')
  expect(marks.refunds.weight).toBe('standard')
  expect(marks.refunds.at).toMatch(/^\d\d:\d\d$/)
  const run = eng.memory.run!
  expect(marks.refunds.run).toBe(run.startedAt)
  expect(marks.refunds.step).toBeGreaterThanOrEqual(run.calls.findLast(c => c.kind === 'edit')!.step)
  expect(marks.guide.base).toMatch(HEX)
  expect(marks.guide.since).toMatch(/^docs@\d+$/)
  expect(marks.guide.hash).toBeUndefined()
  // The edit ledger agrees with the proof: nothing since, then an edit to the part's files undoes it.
  const map = JSON.parse(MAP)
  expect([...editedSince(map, run, marks)]).toEqual([])
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'built', new_string: 'rebuilt' })
  expect([...editedSince(map, eng.memory.run!, marks)]).toEqual(['refunds'])
})

test('going back along a loop records no proof for the state left', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  const states = STATES.filter(s => s.id !== 'verify')
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'Refunds', states, loops: [['docs', 'service']] })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  eng.setBash({ fail: true, text: 'Tests: 1 failed' })
  await plan($, { action: 'advance', to: 'service', evidence: 'found it' })
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/guide/intro.md`, content: 'Refunds' })
  expect(said(await plan($, { action: 'advance', to: 'service', evidence: 'the guide shows the service needs a change' }))).toMatch(/Moved to service/)
  expect(marksOf(eng).guide.hash).toBeUndefined()
  expect(marksOf(eng).refunds.hash).toMatch(HEX)
})

test('a check that fails records no proof', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await toService($, eng)
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'original', new_string: 'built' })
  expect(said(await plan($, { action: 'advance', to: 'docs' }))).toMatch(/failed/)
  expect(marksOf(eng).refunds.hash).toBeUndefined()
})

test('marks already saved for other parts, or from an earlier plan, stay', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  eng.files[MARKS] = JSON.stringify({ old: { hash: 'abc', check: 'make' }, refunds: { hash: 'prior', check: 'older' } })
  await toService($, eng)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  const marks = marksOf(eng)
  expect(marks.old).toEqual({ hash: 'abc', check: 'make' })
  expect(marks.refunds.check).toBe('npm test -- refund')
  expect(marks.refunds.from).toBeDefined()
})

test('nothing is written when the map file goes missing after the lock', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  expect(await toService($, eng, STATES, () => delete eng.files[SYSTEM])).toMatch(/Moved to service/)
  await build($, eng)
  expect(said(await plan($, { action: 'advance', to: 'docs' }))).toMatch(/Moved to docs/)
  expect(eng.files[MARKS]).toBeUndefined()
})

test('a marks file that cannot be written stops nothing', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  eng.setWriteFails(/marks\.json$/)
  expect(await toService($, eng)).toMatch(/Moved to service/)
  await build($, eng)
  expect(said(await plan($, { action: 'advance', to: 'docs' }))).toMatch(/Moved to docs/)
  expect(eng.files[MARKS]).toBeUndefined()
})

test('a git that fails stops nothing and writes nothing', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  eng.setDuring('hash-object', async () => { throw new Error('git: fatal: unable to read') })
  expect(await toService($, eng)).toMatch(/Moved to service/)
  expect(eng.files[MARKS]).toBeUndefined()
})

test('a map that will not read stops nothing and writes nothing', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  expect(await toService($, eng, STATES, () => (eng.files[SYSTEM] = '{nope'))).toMatch(/Moved to service/)
  await build($, eng)
  expect(said(await plan($, { action: 'advance', to: 'docs' }))).toMatch(/Moved to docs/)
  expect(eng.files[MARKS]).toBeUndefined()
})

test('states that name no part, a part that left the map and an outside part write nothing', async ($: any, on: any) => {
  const eng = engine(on)
  // Both parts are on the map the plan locks with. The map then changes under it, as a merge or a branch switch does:
  // nope is gone, and queue is something outside.
  const planned = { version: 1, name: 'Shop', actors: [], lines: [], parts: [{ id: 'nope', name: 'Nope', files: ['nope/**'] }, { id: 'queue', name: 'Queue', files: ['queue/**'] }] }
  eng.files[SYSTEM] = JSON.stringify(planned)
  const states = STATES.map(s => (s.id === 'service' ? { ...s, parts: ['nope', 'queue'] } : { ...s, parts: undefined }))
  expect(await toService($, eng, states, () => (eng.files[SYSTEM] = MAP))).toMatch(/Moved to service/)
  await build($, eng)
  expect(said(await plan($, { action: 'advance', to: 'docs' }))).toMatch(/Moved to docs/)
  expect(eng.files[MARKS]).toBeUndefined()
})

test('a member state gets its baseline when the member starts and its proof when the work comes back', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on)
  eng.files[`${ROOT}/.sentinel/parallel`] = 'on'
  eng.files[`${ROOT}/ui/box.tsx`] = 'before'
  eng.files[SYSTEM] = JSON.stringify({ version: 1, name: 'Shop', actors: [], lines: [], parts: [{ id: 'search', name: 'Search box', files: ['ui/**'] }] })
  const states = [
    { id: 'explore', label: 'Read the code' },
    { id: 'api', label: 'Search endpoint', check: 'npm test -- api', files: ['api/*.ts'], needs: ['explore'] },
    { id: 'ui', label: 'Search box', check: 'npm test -- ui', files: ['ui/**'], needs: ['explore'], parts: ['search'] },
    { id: 'verify', label: 'Full suite', check: 'npm test', needs: ['api', 'ui'] },
  ]
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'Search page', states, loops: [['verify', 'api']] })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  await plan($, { action: 'advance', to: 'api', evidence: 'read it' })
  expect(marksOf(eng).search).toBeUndefined()
  await plan($, { action: 'brief', to: 'ui', brief: 'Add the search box.' })
  const base = marksOf(eng).search.base
  expect(base).toMatch(HEX)
  expect(marksOf(eng).search.since).toMatch(/^ui@\d+$/)
  // The member's work reaches the project when git applies its diff.
  eng.setPatch('diff --git a/ui/box.tsx b/ui/box.tsx\n--- a/ui/box.tsx\n+++ b/ui/box.tsx\n@@ -1 +1 @@\n-before\n+after\n')
  eng.setDuring('apply', async () => { eng.files[`${ROOT}/ui/box.tsx`] = 'after' })
  eng.setBash({ fail: false, text: 'ok' })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId: 'm-1' })
  await clock.settle()
  const mark = marksOf(eng).search
  expect(mark.hash).toMatch(HEX)
  expect(mark.hash).not.toBe(base)
  expect(mark.from).toBe(base)
  expect(mark.check).toBe('npm test -- ui')
})

// service builds refunds, then verify is the last state: its advance to done runs the final checks.
const LAST = STATES.filter(s => s.id !== 'docs')

test('the final checks prove again the parts of the states that still pass', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await toService($, eng, LAST)
  await build($, eng)
  await plan($, { action: 'advance', to: 'verify' })
  const first = marksOf(eng).refunds.hash
  // The file changes with no edit in the ledger, as a shell command or another tool would change it.
  eng.files[REFUND] = 'changed outside'
  expect(said(await plan($, { action: 'advance', to: 'done' }))).toMatch(/Plan complete|complete/i)
  const hash = marksOf(eng).refunds.hash
  expect(hash).toMatch(HEX)
  expect(hash).not.toBe(first)
})

test('a state the final checks reopen keeps the proof it had', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await toService($, eng, LAST)
  await build($, eng)
  await plan($, { action: 'advance', to: 'verify' })
  const first = marksOf(eng).refunds
  eng.files[REFUND] = 'changed outside'
  eng.setBash((command: string) => (command.includes('refund') ? { fail: true, text: 'Tests: 1 failed' } : { fail: false, text: 'ok' }))
  expect(said(await plan($, { action: 'advance', to: 'done' }))).not.toMatch(/Plan complete/)
  const now = marksOf(eng).refunds
  // The proof stays. The reopened state is a new visit, so its baseline moves on.
  expect({ hash: now.hash, from: now.from, check: now.check, at: now.at, step: now.step, run: now.run })
    .toEqual({ hash: first.hash, from: first.from, check: first.check, at: first.at, step: first.step, run: first.run })
  expect(now.since).not.toBe(first.since)
  expect(now.base).not.toBe(first.base)
})

// ---- found by running it for real (mockups/system-map/live-*.log) ----
//
// How these can fail, and where each is tested below:
//  1. A state with no check ends, and the part it built still reads Not built: the screens never look at its files.
//  2. A part a plan built reads Changed since drawn the moment the plan ends, because its own files differ from the drawn commit.
//  3. The fix for 2 hides a real change: a part a state named and did not touch loses its mark, or a built part keeps it
//     hidden after its files change again.
//  4. A map file Sentinel can't read (a merge conflict) vanishes with no word, or a plan that locks writes over it.
//  5. /sentinel fine answers "no mark to clear" when the session's first look has not finished.
const DRAWN = JSON.stringify({
  version: 1, name: 'Shop', actors: [], lines: [],
  parts: [{ id: 'refunds', name: 'Refunds', files: ['src/refund*.ts'], drawnAt: 'aaa1111' }, { id: 'guide', name: 'Guide', files: ['guide/**'], drawnAt: 'aaa1111' }],
})
const CONFLICT = ['<<<<<<< HEAD', '{"version":1,"name":"A"}', '=======', '{"version":1,"name":"B"}', '>>>>>>> map-b', ''].join('\n')
const NO_CHECK = STATES.map(s => (s.id === 'docs' ? { id: s.id, label: s.label, files: s.files, parts: s.parts } : s))
const leafOf = (eng: ReturnType<typeof engine>, id: string) => {
  const walk = (ns: any[]): any[] => ns.flatMap(n => [n, ...walk(n.kids ?? [])])
  return walk(eng.snap().system?.tree ?? []).find(n => n.id === id)
}
// A session in a project whose map is `map`, with the dashboard up so the screens' snapshot is written.
async function opened($: any, on: any, eng: ReturnType<typeof engine>, map: string, started = true) {
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  eng.files[SYSTEM] = map
  eng.setHistory({ since: { aaa1111: [] } })
  await openPage($, clock)
  if (started) await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return clock
}
const system = async ($: any, clock: any) => {
  await $.command.run({ command: 'sentinel', args: 'system' })
  await clock.advance(20)
}

test('a state with no check ends: its part reads Untested at once, not Not built', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await opened($, on, eng, MAP)
  await toService($, eng, NO_CHECK)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  eng.files[`${ROOT}/guide/intro.md`] = 'welcome'
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/guide/intro.md`, content: 'welcome' })
  expect(said(await plan($, { action: 'advance', to: 'verify', evidence: 'wrote the guide and read it through' }))).toMatch(/Moved to verify/)
  await clock.advance(20)
  expect(leafOf(eng, 'guide').status.status).toBe('untested')
  // It proved nothing, so no proof is saved for it.
  expect(marksOf(eng).guide.hash).toBeUndefined()
  expect(marksOf(eng).guide.check).toBeUndefined()
})

test('a part a state built is not marked Changed since drawn for the plan\'s own files, and is again once they change', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await opened($, on, eng, DRAWN)
  await toService($, eng)
  await build($, eng)
  // Git now sees the file the plan built as changed since the commit the map was drawn at, and a guide page nobody here touched.
  eng.setHistory({ since: { aaa1111: [{ how: 'M', path: 'src/refund.ts' }, { how: 'M', path: 'guide/old.md' }] } })
  await plan($, { action: 'advance', to: 'docs' })
  await system($, clock)
  expect(leafOf(eng, 'refunds').status.tags).not.toContain('changed-since-drawn')
  expect(leafOf(eng, 'guide').status.tags).toContain('changed-since-drawn')
  expect(eng.snap().system.drift.count).toBe(1)
  expect(marksOf(eng).refunds.fine).toMatch(HEX)
  expect(marksOf(eng).guide.fine).toBeUndefined()
  // The file changes after the plan: the mark is back.
  eng.files[REFUND] = 'changed once more'
  await system($, clock)
  expect(leafOf(eng, 'refunds').status.tags).toContain('changed-since-drawn')
  expect(eng.snap().system.drift.count).toBe(2)
})

test('a part a state names and does not touch keeps the mark it had', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await opened($, on, eng, DRAWN)
  await toService($, eng)
  eng.setBash({ fail: false, text: '14 passed' })
  eng.setHistory({ since: { aaa1111: [{ how: 'M', path: 'src/refund.ts' }] } })
  expect(said(await plan($, { action: 'advance', to: 'docs' }))).toMatch(/Moved to docs/)
  await system($, clock)
  expect(marksOf(eng).refunds.fine).toBeUndefined()
  expect(leafOf(eng, 'refunds').status.tags).toContain('changed-since-drawn')
})

test('a map file Sentinel cannot read is said so on every road, and a plan that locks does not write over it', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await opened($, on, eng, CONFLICT)
  await clock.advance(20)
  // The session start says so.
  expect(eng.toasts.join('\n')).toMatch(/system\.json.*merge conflict/)
  // So do the status reply and the command, and the file is left as it was.
  expect(said(await plan($, { action: 'status' }))).toMatch(/system\.json.*merge conflict/)
  expect(said(await $.command.run({ command: 'sentinel', args: 'system' }))).toMatch(/system\.json.*merge conflict/)
  expect(eng.files[SYSTEM]).toBe(CONFLICT)
  // A plan that arrives with a drawing locks, and the drawing stays in the run.
  await $.tool.call({ tool: 'ExitPlanMode' })
  const out = said(await $.tool.call({ tool: TOOL, action: 'define', title: 'Refunds', states: [STATES[1]!, STATES[3]!], loops: [], system: { name: 'Shop', parts: [{ id: 'refunds', name: 'Refunds', files: ['src/refund*.ts'] }] } }))
  expect(out).toMatch(/Locked|Draft saved/)
  expect(out).toMatch(/did not save the map/i)
  expect(eng.files[SYSTEM]).toBe(CONFLICT)
})

test('a map that reads shows no such word', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await opened($, on, eng, MAP)
  await clock.advance(20)
  expect(eng.toasts.join('\n')).not.toMatch(/system\.json/)
  expect(said(await plan($, { action: 'status' }))).not.toMatch(/could not be read|merge conflict/)
})

test('/sentinel fine as the first thing in a session waits for the look instead of saying there is no mark', async ($: any, on: any) => {
  const eng = engine(on)
  await opened($, on, eng, DRAWN, false)
  eng.setHistory({ since: { aaa1111: [{ how: 'M', path: 'src/refund.ts' }] } })
  expect(said(await $.command.run({ command: 'sentinel', args: 'fine refunds' }))).toBe('Marked Refunds as fine. The mark comes back if its files change again.')
  expect(marksOf(eng).refunds.fine).toMatch(HEX)
})

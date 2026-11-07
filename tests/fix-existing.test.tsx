// A part whose files are already in the project when a plan is locked is not "Not built", even when a state of the plan
// will change it. Through the real engine; git is the kit's fake over the in-memory files. Run with
// `node tests/only.mjs fix-existing`.
//
// How this can fail, and where each is tested below:
//  1. A part with files that a state will change reads Not built before the state starts, where it should read Will change.
//  2. A state that ends without changing a part's files leaves it reading Not built, where it should read Already there.
//  3. The fix for 1 and 2 reaches a part that has no files yet, which must still read Not built and then reach Tested.
import { expect, mock } from 'claude-code/testing'
import { REFUND, ROOT, TOOL, engine, openPage, said, test } from './kit'

const SYSTEM = `${ROOT}/.sentinel/system.json`
const MAP = JSON.stringify({
  version: 1, name: 'Shop', actors: [], lines: [],
  parts: [{ id: 'refunds', name: 'Refunds', files: ['src/refund*.ts'], drawnAt: 'aaa1111' }, { id: 'guide', name: 'Guide', files: ['guide/**'], drawnAt: 'aaa1111' }],
})
const STATES = [
  { id: 'explore', label: 'Read payments code' },
  { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'], parts: ['refunds'] },
  { id: 'docs', label: 'Guide', check: 'npm test -- guide', files: ['guide/**'], parts: ['guide'] },
  { id: 'verify', label: 'Full suite', check: 'npm test' },
]
const leafOf = (eng: ReturnType<typeof engine>, id: string) => {
  const walk = (ns: any[]): any[] => ns.flatMap(n => [n, ...walk(n.kids ?? [])])
  return walk(eng.snap().system?.tree ?? []).find(n => n.id === id)
}
const word = (eng: ReturnType<typeof engine>, id: string) => leafOf(eng, id)?.status?.status
const plan = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })

// A session with the dashboard up so the screens' snapshot is written, a map on disk, and the plan locked.
async function locked($: any, on: any, eng: ReturnType<typeof engine>, beforeLock?: () => void) {
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  eng.files[SYSTEM] = MAP
  eng.setHistory({ since: { aaa1111: [] } })
  await openPage($, clock)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'ExitPlanMode' })
  beforeLock?.()
  await plan($, { action: 'define', title: 'Refunds', states: STATES, loops: [['verify', 'service']] })
  await clock.advance(20)
  return clock
}
// Reads, enters service (its check fails there, as a check should), and leaves it with the check passing. edit: the
// state changes the refund file on the way.
async function throughService($: any, eng: ReturnType<typeof engine>, clock: any, edit: boolean) {
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  eng.setBash({ fail: true, text: 'Tests: 1 failed' })
  expect(said(await plan($, { action: 'advance', to: 'service', evidence: 'found it' }))).toMatch(/Moved to service/)
  if (edit) await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'original', new_string: 'built' })
  eng.setBash({ fail: false, text: '14 passed' })
  expect(said(await plan($, { action: 'advance', to: 'docs', evidence: 'done' }))).toMatch(/Moved to docs/)
  await clock.advance(20)
}

test('a part with files that a state will change reads Will change before it starts', async ($: any, on: any) => {
  const eng = engine(on)
  await locked($, on, eng)
  expect(eng.files[REFUND]).toBeDefined()
  expect(word(eng, 'refunds')).toBe('change')
  // The guide has no files yet, so it is still Not built.
  expect(word(eng, 'guide')).toBe('planned')
})

test('a state that ends without changing the files of its part leaves it Already there', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await locked($, on, eng)
  await throughService($, eng, clock, false)
  expect(word(eng, 'refunds')).toBe('exists')
  // docs is the state Claude is in now.
  expect(word(eng, 'guide')).toBe('now')
})

test('a part the state builds from nothing still goes Not built, then Tested, and never Already there', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = await locked($, on, eng)
  await throughService($, eng, clock, true)
  // refunds had files and the state changed them and proved it.
  expect(word(eng, 'refunds')).toBe('tested')
  // guide has none yet. docs starts, writes the page and ends.
  expect(word(eng, 'guide')).toBe('now')
  eng.setBash({ fail: true, text: 'Tests: 1 failed' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/guide/intro.md`, content: 'welcome' })
  eng.setBash({ fail: false, text: '3 passed' })
  expect(said(await plan($, { action: 'advance', to: 'verify', evidence: 'wrote the guide' }))).toMatch(/Moved to verify/)
  await clock.advance(20)
  expect(['tested', 'untested']).toContain(word(eng, 'guide'))
})

test('a git that fails while the lock looks for files stops nothing, and the part is just not counted as there', async ($: any, on: any) => {
  const eng = engine(on)
  await locked($, on, eng, () => eng.setDuring('hash-object', async () => { throw new Error('git: fatal: unable to read') }))
  expect(eng.memory.run?.plan?.title).toBe('Refunds')
  expect(word(eng, 'refunds')).toBe('planned')
})

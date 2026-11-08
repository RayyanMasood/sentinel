// The stuck detector: what counts as progress, what counts as a repeat, and when a stuck mark opens and ends. Pure
// rules through observe, plus one engine test for check times. Run with `node tests/only.mjs detector`.
//
// How this can fail, and where each is tested below:
//  1. Going back to a version no failing check saw counts as a cycle, so removing a debug line reads as stuck.
//  2. Going back to a version that did fail is missed, so a real cycle goes unseen.
//  3. New reads stop counting after a few in a row, so an honest search reads as stuck.
//  4. Reading the same things again is missed, so circling through the same files never shows.
//  5. Output that prints a time looks new on every run, so repeating a command never counts as a repeat.
//  6. A failure that bounces between two kinds (A, B, A, B) counts as progress each time.
//  7. Fewer failures of a kind seen before stop counting as progress.
//  8. A stuck mark ends after a few new reads, though the check still fails the same way, so it opens again at note 1
//     and a second note never comes.
//  9. Notes keep coming while health is fine, or stop while it stays low.
// 10. Edits with the check never run count as progress for ever, or edits are held back when the check was run.
// 11. A check run's time isn't kept, so nobody can see that slow checks ate the time.
import { expect, mock } from 'claude-code/testing'
import type { Run } from '../types'
import { act, emptyRun, lookPrint, observe, span, timeFacts, type PlanInput } from '../hooks/core'
import { REFUND, ROOT, TOOL, engine, test } from './kit'

const PLAN: PlanInput = {
  action: 'define', title: 'Refunds',
  states: [
    { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/**'] },
    { id: 'verify', label: 'Full suite', check: 'npm test' },
  ],
  loops: [],
}
const F = 'src/refund.ts'

// A locked plan at service, and what each call did to it. notes: every recovery note, in order.
function start() {
  const a = act({ ...emptyRun(), signedOff: true }, PLAN, '09:00', {}, Date.UTC(2026, 10, 8, 9))
  if (!a.ok) throw new Error(a.text)
  let r: Run = a.run
  const notes: string[] = []
  const go = (o: Parameters<typeof observe>[1]) => {
    const out = observe(r, o, '09:00')
    r = out.run
    if (out.note) notes.push(out.note)
    return r.calls.at(-1)!
  }
  const s = {
    get run() { return r },
    notes,
    edit: (ver: string, before?: string) => go({ kind: 'edit', label: `Edit ${F}`, file: F, ver, ...(before ? { before } : {}) }),
    fail: (sig: string, fails = 1) => go({ kind: 'check', label: 'npm test -- refund', pass: false, sig, sigText: `expected ${sig}`, fails }),
    pass: () => go({ kind: 'check', label: 'npm test -- refund', pass: true, sig: '', sigText: '', fails: 0 }),
    read: (fp: string) => go({ kind: 'look', label: `Read ${fp}`, fp }),
    trap: () => r.traps.at(-1),
  }
  return s
}

// 1 and 2
test('removing a debug line goes back to a version no failing check saw, which is not a cycle', () => {
  const s = start()
  s.fail('A')
  s.edit('v1', 'v0')
  // The debug line goes in, the check runs with it, and it comes out again.
  s.edit('v2', 'v1')
  s.fail('A')
  const back = s.edit('v1', 'v2')
  expect(back.repeat).toBeUndefined()
  expect(back.revisitOf).toBeUndefined()
  expect(back.u).toBe(1)
})

test('going back to a version that already failed the check is a repeat, and says where it was', () => {
  const s = start()
  s.edit('v1', 'v0')
  s.fail('A')
  s.edit('v2', 'v1')
  s.fail('A')
  const back = s.edit('v1', 'v2')
  expect(back.repeat).toBe(true)
  expect(back.revisitOf).toBe(1)
})

test('the version a file had before its first edit counts as failed when a failing check ran on it', () => {
  const s = start()
  s.fail('A')
  s.edit('v1', 'v0')
  s.fail('A')
  expect(s.edit('v0', 'v1').repeat).toBe(true)
})

// 3 and 4
test('new reads count as progress, however many come in a row', () => {
  const s = start()
  s.fail('A')
  for (let i = 0; i < 12; i++) expect(s.read(`file ${i}`).u).toBe(1)
  expect(s.notes).toEqual([])
  expect(s.trap()).toBeUndefined()
})

test('reading the same things again while the check fails is drift', () => {
  const s = start()
  s.fail('A')
  for (let i = 0; i < 9; i++) s.read(`file ${i % 2}`)
  expect(s.trap()).toMatchObject({ pattern: 'drift' })
  expect(s.notes[0]).toMatch(/Stuck: DRIFT/)
})

// 5
test('a command or read is compared without the times in its output', () => {
  const bash = { command: 'npm run build' }
  expect(lookPrint('Bash', bash, 'built in 12 ms\nat 10:41:03 done')).toBe(lookPrint('Bash', bash, 'built in 873 ms\nat 11:02:59 done'))
  expect(lookPrint('Bash', bash, 'built in 12 ms\ndone')).not.toBe(lookPrint('Bash', bash, 'built in 12 ms\nfailed'))
  expect(lookPrint('Bash', bash, 'done')).not.toBe(lookPrint('Bash', { command: 'npm run lint' }, 'done'))
  expect(lookPrint('Read', { file_path: 'a.ts' }, 'x')).not.toBe(lookPrint('Read', { file_path: 'b.ts' }, 'x'))
})

// 6 and 7
test('a failure that bounces between two kinds is the same failure, and the run is marked stuck', () => {
  const s = start()
  const kinds = ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A']
  kinds.forEach((k, i) => {
    s.edit(`v${i + 1}`, `v${i}`)
    s.fail(k)
  })
  expect(s.run.calls.filter(c => c.kind === 'check').slice(2).every(c => c.same)).toBe(true)
  expect(s.trap()).toBeDefined()
})

test('a failure seen before the window still weighs fully when another came between', () => {
  const s = start()
  s.fail('A')
  s.fail('B')
  for (let i = 0; i < 7; i++) s.read('same file')
  s.fail('A')
  expect(s.run.calls.at(-1)!.p).toBe(1)
  expect(s.trap()).toMatchObject({ pattern: 'drift' })
})

test('fewer failures of a kind seen before still count as progress', () => {
  const s = start()
  s.fail('A', 3)
  s.edit('v1', 'v0')
  s.fail('B', 3)
  s.edit('v2', 'v1')
  const fewer = s.fail('A', 2)
  expect(fewer.u).toBe(1)
  expect(fewer.same).toBeUndefined()
})

// The cycle that opens a stuck mark: the same failure on a version the file went back to.
function stuck() {
  const s = start()
  s.edit('A', 'v0')
  s.fail('X')
  s.edit('B', 'A')
  s.fail('X')
  s.edit('C', 'B')
  s.fail('X')
  s.edit('B', 'C')
  s.fail('X')
  expect(s.trap()).toMatchObject({ pattern: 'cycle', notes: 1 })
  expect(s.trap()!.end).toBeUndefined()
  return s
}

// 8
test('a stuck mark stays through new reads while the check fails the same way', () => {
  const s = stuck()
  for (let i = 0; i < 4; i++) s.read(`new ${i}`)
  expect(s.trap()!.end).toBeUndefined()
  s.fail('X')
  expect(s.trap()!.end).toBeUndefined()
})

test('a stuck mark ends when the check fails a new way', () => {
  const s = stuck()
  const step = s.fail('Y').step
  expect(s.trap()!.end).toBe(step)
})

test('a stuck mark ends when the check passes', () => {
  const s = stuck()
  const step = s.pass().step
  expect(s.trap()!.end).toBe(step)
})

// 9
test('a second note comes only while health stays low', () => {
  const s = stuck()
  // Eight calls of real progress: health recovers, and nothing more is said.
  for (let i = 0; i < 8; i++) s.read(`new ${i}`)
  expect(s.notes).toHaveLength(1)
  // Back to circling: once health is low again, the second note comes.
  for (let i = 0; i < 8; i++) s.read(`new ${i % 2}`)
  expect(s.notes).toHaveLength(2)
  expect(s.trap()!.notes).toBe(2)
})

// 10
test('edits with the check not run stop counting after six, and the note says to run it', () => {
  const s = start()
  s.fail('A')
  const us = Array.from({ length: 12 }, (_, i) => s.edit(`v${i + 1}`, `v${i}`).u)
  expect(us).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0])
  expect(s.trap()).toMatchObject({ pattern: 'static' })
  expect(s.notes[0]).toMatch(/12 edits since the check last ran/)
  expect(s.notes[0]).toMatch(/Run the check/)
})

test('six edits and then a check run is fine, and edits after a pass are not held back', () => {
  const s = start()
  s.fail('A')
  for (let i = 0; i < 6; i++) s.edit(`v${i + 1}`, `v${i}`)
  s.fail('B')
  expect(s.edit('v7', 'v6').u).toBe(1)
  expect(s.trap()).toBeUndefined()
  const t = start()
  t.pass()
  expect(Array.from({ length: 10 }, (_, i) => t.edit(`w${i + 1}`, `w${i}`).u).every(u => u === 1)).toBe(true)
})

// 11
test('the time note adds up how long the check runs took', () => {
  const s = start()
  const calls = [...s.run.calls,
    { step: 1, t: '09:00', state: 'service', kind: 'check' as const, label: 'npm test -- refund', u: 1 as const, n: 1, S: 0, R: 0, p: 0, H: 1, pass: false, ms: 42_000 },
    { step: 2, t: '09:01', state: 'service', kind: 'check' as const, label: 'npm test -- refund', u: 1 as const, n: 2, S: 0, R: 0, p: 0, H: 1, pass: false, ms: 40_000 },
    { step: 3, t: '09:02', state: 'service', kind: 'check' as const, label: 'npm test -- refund', u: 1 as const, n: 3, S: 0, R: 0, p: 0, H: 1, pass: true, ms: 44_000 },
  ]
  expect(timeFacts({ ...s.run, calls }, 'service')).toMatch(/^3 check runs, 2 failed, 2 min in all, about 42 s each/)
  expect(span(400)).toBe('under 1 s')
})

test('a check run Claude starts keeps how long it took', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on, { now: Date.now() })
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, ...PLAN })
  await clock.advance(20)
  eng.setBash({ fail: true, text: 'Tests: 1 failed\nexpected 49.99, received 50.00' })
  eng.setDuring('Bash', () => clock.advance(42_000))
  await $.tool.call({ tool: 'Bash', command: 'npm test -- refund' })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  await clock.advance(20)
  const run = JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}')
  const ran = run.calls.findLast((c: any) => c.kind === 'check')
  expect(ran.ms).toBeGreaterThanOrEqual(42_000)
  expect(ran.ms).toBeLessThan(43_000)
  // A read has no time.
  expect(run.calls.at(-1)).toMatchObject({ kind: 'look', label: expect.stringContaining('refund.ts') })
  expect(run.calls.at(-1).ms).toBeUndefined()
})

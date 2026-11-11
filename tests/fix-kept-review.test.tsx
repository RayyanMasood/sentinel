// A loop back keeps a review the user already gave when that state's own files have not changed since. Pure engine
// calls, no git: run with `node tests/only.mjs fix-kept-review`.
//
// How this can fail, and where each is tested below:
//  1. A loop back sends the user through a review of the same page again, though nothing in it changed.
//  2. The review is kept after the state's own files changed, so the user approves what they did not see.
//  3. A state with no files of its own is kept, though nothing says what would have changed it.
//  4. A review the user never gave is kept (a first walk through, or hands-free), or the notice hides what changed upstream.
//  5. A helper subagent changed the state's files, and the review is kept because only the main conversation's edits count.
import { expect } from 'claude-code/testing'
import type { Run } from '../types'
import { act, emptyRun, helpedBy, observe, stopSettled, type PlanInput } from '../hooks/core'
import { test } from './kit'

const T0 = Date.UTC(2026, 9, 26, 9, 0, 0)
const at = (n: number) => T0 + n * 60_000
const PLAN = (page: object = {}): PlanInput => ({
  action: 'define', title: 'Page',
  states: [
    { id: 'explore', label: 'Read the code' },
    { id: 'service', label: 'Service', check: 'npm test -- svc', files: ['src/**'] },
    { id: 'page', label: 'Page', check: 'npm test -- page', files: ['web/**'], wait: 'after', ...page },
    { id: 'verify', label: 'Full suite', check: 'npm test' },
  ],
  loops: [['verify', 'service']],
})
const go = (r: Run, input: PlanInput, now: number): Run => {
  const a = act(r, input, '09:00', {}, now)
  if (!a.ok) throw new Error(a.text)
  return a.run
}
const look = (r: Run) => observe(r, { kind: 'look', label: `Read ${r.step}`, fp: `x${r.step}` }, '09:00').run
const edit = (r: Run, file: string) => observe(r, { kind: 'edit', label: `Edit ${file}`, file, ver: `v${r.step}` }, '09:00').run
const pass = (r: Run, check: string) => observe(r, { kind: 'check', label: check, pass: true, sig: '', sigText: '', fails: 0 }, '09:00').run

// The first walk to verify, with the page reviewed by the user in the dialog, then the suite fails and verify loops back
// to service. Returns the run in service, on its second visit.
function reviewedThenLooped(page: object = {}): Run {
  let r = go({ ...emptyRun(), signedOff: true }, PLAN(page), T0)
  r = go(look(r), { action: 'advance', to: 'service', evidence: 'found it' }, at(1))
  r = go(pass(edit(r, 'src/a.ts'), 'npm test -- svc'), { action: 'advance', to: 'page' }, at(2))
  r = pass(edit(r, 'web/view.html'), 'npm test -- page')
  const asked = act(r, { action: 'advance', to: 'verify' }, '09:00', {}, at(3))
  expect([asked.ok, asked.stop]).toEqual([false, 'after'])
  // The user answers in the dialog; Claude's call goes on at a later step.
  r = look(stopSettled(asked.run, { how: 'yes' } as any, '09:03', at(4)))
  r = go(r, { action: 'advance', to: 'verify' }, at(5))
  return go(pass(r, 'npm test'), { action: 'advance', to: 'service', evidence: 'the suite fails in service' }, at(6))
}
// Back in service: fix src/a.ts again, and walk to page's advance with its check passing and no edit of its own.
const backAtPage = (r: Run, page = 'npm test -- page') => {
  const there = go(pass(edit(r, 'src/a.ts'), 'npm test -- svc'), { action: 'advance', to: 'page' }, at(7))
  return pass(there, page)
}

test('the first walk asks for the review, and the answer in the dialog settles it', () => {
  let r = go({ ...emptyRun(), signedOff: true }, PLAN(), T0)
  r = go(look(r), { action: 'advance', to: 'service', evidence: 'found it' }, at(1))
  r = go(pass(edit(r, 'src/a.ts'), 'npm test -- svc'), { action: 'advance', to: 'page' }, at(2))
  const asked = act(pass(edit(r, 'web/view.html'), 'npm test -- page'), { action: 'advance', to: 'verify' }, '09:00', {}, at(3))
  expect([asked.ok, asked.stop]).toEqual([false, 'after'])
  expect(asked.run.pending).toMatchObject({ state: 'page', kind: 'after' })
})

test('a loop back keeps the review of a state whose own files have not changed, and says so', () => {
  const r = backAtPage(reviewedThenLooped())
  const kept = act(r, { action: 'advance', to: 'verify' }, '09:00', {}, at(8))
  expect(kept.ok).toBe(true)
  expect(kept.stop).toBeUndefined()
  expect(kept.run.active).toBe('verify')
  expect(kept.run.pending?.state === 'page' && kept.run.pending.at >= at(7)).toBeFalsy()
  expect(kept.text).toMatch(/Your earlier review of page stands/)
  // The files that changed elsewhere since the user looked are named.
  expect(kept.text).toMatch(/src\/a\.ts/)
  expect(kept.run.log.map(l => l.text)).toContain('page · earlier review kept')
})

test('the review is asked again when a file of the state itself changed since', () => {
  const r = edit(backAtPage(reviewedThenLooped()), 'web/view.html')
  const again = act(pass(r, 'npm test -- page'), { action: 'advance', to: 'verify' }, '09:00', {}, at(8))
  expect([again.ok, again.stop]).toEqual([false, 'after'])
  expect(again.run.pending).toMatchObject({ state: 'page', kind: 'after' })
})

test('a state with no files of its own is asked again, since nothing says what would have changed it', () => {
  const r = backAtPage(reviewedThenLooped({ files: [] }))
  const again = act(r, { action: 'advance', to: 'verify' }, '09:00', {}, at(8))
  expect([again.ok, again.stop]).toEqual([false, 'after'])
})

test('a review passed hands-free is not the user\'s, so a loop back asks once they are back', () => {
  let r: Run = { ...go({ ...emptyRun(), signedOff: true }, PLAN(), T0), handsFree: true }
  r = go(look(r), { action: 'advance', to: 'service', evidence: 'found it' }, at(1))
  r = go(pass(edit(r, 'src/a.ts'), 'npm test -- svc'), { action: 'advance', to: 'page' }, at(2))
  r = go(pass(edit(r, 'web/view.html'), 'npm test -- page'), { action: 'advance', to: 'verify' }, at(3))
  r = go(pass(r, 'npm test'), { action: 'advance', to: 'service', evidence: 'the suite fails in service' }, at(4))
  r = backAtPage({ ...r, handsFree: undefined })
  const again = act(r, { action: 'advance', to: 'verify' }, '09:00', {}, at(8))
  expect([again.ok, again.stop]).toEqual([false, 'after'])
})

test("a helper edit to the state's files drops the kept review, and one elsewhere is named", () => {
  // A helper subagent of the main conversation edits page's file in the main checkout: its edit stays out of the calls.
  const back = backAtPage(reviewedThenLooped())
  const r = helpedBy(back, 'web/view.html')
  expect(r.calls).toEqual(back.calls)
  const again = act(r, { action: 'advance', to: 'verify' }, '09:00', {}, at(8))
  expect([again.ok, again.stop]).toEqual([false, 'after'])
  // A helper edit to another state's file keeps the review, and the notice names it.
  const kept = act(helpedBy(backAtPage(reviewedThenLooped()), 'src/b.ts'), { action: 'advance', to: 'verify' }, '09:00', {}, at(8))
  expect(kept.ok).toBe(true)
  expect(kept.text).toMatch(/src\/b\.ts/)
})

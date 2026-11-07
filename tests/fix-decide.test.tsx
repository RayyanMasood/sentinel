// Only Claude's own decide about this check cancels the fails-without-change rerun. A decide about anything else leaves
// it on, and so does a dialog approval, which writes a decided audit entry too. Pure engine calls, no git: run with
// `node tests/only.mjs fix-decide`.
import { expect } from 'claude-code/testing'
import type { Run } from '../types'
import { act, emptyRun, observe, rerunOf, stopSettled, withSnap, type PlanInput } from '../hooks/core'
import { test } from './kit'

const T0 = Date.UTC(2026, 9, 26, 9, 0, 0)
const at = (n: number) => T0 + n * 60_000
const PLAN: PlanInput = {
  action: 'define', title: 'Refunds',
  states: [
    { id: 'explore', label: 'Read payments code' },
    { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts', 'tests/**'], wait: 'before' },
    { id: 'verify', label: 'Full suite', check: 'npm test' },
  ],
  loops: [['verify', 'service']],
  library: { weight: 'thorough', on: ['fails-without-change'], told: [] },
}
const go = (r: Run, input: PlanInput, now: number): Run => {
  const a = act(r, input, '09:00', {}, now)
  if (!a.ok) throw new Error(a.text)
  return a.run
}
const edit = (r: Run, file: string) => observe(r, { kind: 'edit', label: `Edit ${file}`, file, ver: `v${r.step}` }, '09:00').run

// In service, where the user approves the proposal first, with a snapshot and one test and one code file edited.
function inService(): Run {
  let r = go({ ...emptyRun(), signedOff: true }, PLAN, T0)
  r = observe(r, { kind: 'look', label: 'Read x', fp: 'x' }, '09:00').run
  r = go(r, { action: 'advance', to: 'service', evidence: 'found it' }, at(1))
  r = go(r, { action: 'propose', intent: 'Write RefundService' }, at(2))
  // Every tool call the engine sees is a step, so the answer comes at a later step than the entry.
  return observe(r, { kind: 'look', label: 'Read y', fp: 'y' }, '09:01').run
}
const edited = (r: Run) => edit(edit(withSnap(r, 'snap1'), 'tests/refund.test.ts'), 'src/refund.ts')
const passed = (r: Run) => observe(r, { kind: 'check', label: 'npm test -- refund', pass: true, sig: '', sigText: '', fails: 0 }, '09:03').run

test('the rerun is due after a visit that changed a test and a code file', () => {
  expect(rerunOf(edited(inService()))).toMatchObject({ sha: 'snap1', tests: ['tests/refund.test.ts'], code: ['src/refund.ts'] })
})

test('a Yes in the dialog at the stop leaves the rerun on', () => {
  const approved = stopSettled(inService(), { how: 'yes' } as any, '09:02', at(3))
  expect(approved.audit.some(a => a.kind === 'decided' && a.state === 'service')).toBe(true)
  expect(rerunOf(edited(approved))).toMatchObject({ sha: 'snap1' })
})

test('words typed into the dialog leave the rerun on too', () => {
  const answered = stopSettled(inService(), { how: 'words', words: 'go on, but keep it small' } as any, '09:02', at(3))
  expect(rerunOf(edited(answered))).toMatchObject({ sha: 'snap1' })
})

test('words in the dialog that name the check leave the rerun on', () => {
  const answered = stopSettled(inService(), { how: 'words', words: 'fails-without-change is fine here' } as any, '09:02', at(3))
  expect(rerunOf(edited(answered))).toMatchObject({ sha: 'snap1' })
})

test("Claude's own decide about the check skips the rerun", () => {
  const decided = go(inService(), { action: 'decide', topic: 'fails-without-change', choice: 'keep it', reason: 'a refactor that keeps the output' }, at(3))
  expect(rerunOf(edited(decided))).toBeUndefined()
})

test('the wording "Fails without change" counts too', () => {
  const decided = go(inService(), { action: 'decide', topic: 'Fails without change', choice: 'keep it', reason: 'a refactor that keeps the output' }, at(3))
  expect(rerunOf(edited(decided))).toBeUndefined()
})

test('a decide about anything else leaves the rerun on', () => {
  const decided = go(inService(), { action: 'decide', topic: 'rounding', choice: 'half up', reason: 'the ledger rounds that way' }, at(3))
  expect(rerunOf(edited(decided))).toMatchObject({ sha: 'snap1' })
})

test('the refusal names the topic, and a decide with that topic skips the rerun', () => {
  const r = passed(edited(stopSettled(inService(), { how: 'yes' } as any, '09:02', at(3))))
  const refused = act(r, { action: 'advance', to: 'verify' }, '09:04', {}, at(4), false, { pass: true, tests: ['tests/refund.test.ts'], code: ['src/refund.ts'] })
  expect(refused.ok).toBe(false)
  const topic = refused.text.match(/"decide" and the topic "([^"]+)"/)?.[1]
  expect(topic).toBe('fails-without-change')
  expect(rerunOf(go(refused.run, { action: 'decide', topic: topic!, choice: 'keep it', reason: 'a refactor that keeps the output' }, at(5)))).toBeUndefined()
})

test("a decide in another state does not skip this state's rerun", () => {
  let r = go({ ...emptyRun(), signedOff: true }, PLAN, T0)
  r = go(r, { action: 'decide', topic: 'fails-without-change', choice: 'keep it', reason: 'it is the only place' }, at(1))
  r = observe(r, { kind: 'look', label: 'Read x', fp: 'x' }, '09:00').run
  r = go(r, { action: 'advance', to: 'service', evidence: 'found it' }, at(2))
  r = go(r, { action: 'propose', intent: 'Write RefundService' }, at(3))
  r = observe(r, { kind: 'look', label: 'Read y', fp: 'y' }, '09:01').run
  expect(rerunOf(edited(stopSettled(r, { how: 'yes' } as any, '09:02', at(4))))).toMatchObject({ sha: 'snap1' })
})

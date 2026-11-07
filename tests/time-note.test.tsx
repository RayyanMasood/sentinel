// When the active state has run long, and the facts about where the time went. Pure engine calls, no hooks or timers:
// run with `node tests/only.mjs time-note`.
//
// How this can fail, and where each is tested below:
//  1. The mark comes early or late: under 30 minutes, or after the exact minute it falls on.
//  2. A mark repeats on the next look, or the next mark never comes.
//  3. A jump past two marks says both, or says the lower one and the higher one straight after.
//  4. Time the plan waited on the user counts as work, or a mark falls due during the wait.
//  5. A loop back loses the earlier visit's time, or says a mark again.
//  6. A new state starts with the previous state's time, or the previous state's mark holds its own back.
//  7. A mark falls due with no live plan: none at all, paused, finished, or only a draft.
//  8. A run saved before timeSaid breaks or reads as already said, or a state called "constructor" reads Object.prototype.
//  9. timeMarked drops the log, overwrites another state's mark, or keeps the time in place of the mark.
// 10. The facts are wrong: another state's calls, a refused edit or a repeated file counted; a zero shown; a stretch
//     wrong across midnight or spanning another state's visit; a long command pasted whole.
// 11. The note reads as a stop, or gives Claude no way to record what it found.
// 12. The decide the note asks for cancels the fails-without-change rerun.
import { expect } from 'claude-code/testing'
import type { Run } from '../types'
import {
  act, emptyRun, FIRST_MARK_MS, observe, rerunOf, startClock, stopClock, stopSettled, timeDue, timeFacts, timeMarked, timeNote, waitingOn, withSnap, workingMs, type PlanInput,
} from '../hooks/core'
import { test } from './kit'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 26, 9, 0, 0)
const at = (n: number) => T0 + n * MIN
const PLAN: PlanInput = {
  action: 'define', title: 'Refunds',
  states: [
    { id: 'explore', label: 'Read payments code' },
    { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts', 'tests/**'] },
    { id: 'verify', label: 'Full suite', check: 'npm test' },
  ],
  loops: [['verify', 'service']],
}
const go = (r: Run, input: PlanInput, now: number): Run => {
  const a = act(r, input, '09:00', {}, now)
  if (!a.ok) throw new Error(a.text)
  return a.run
}
const fresh = (): Run => ({ ...emptyRun(), signedOff: true })
// The plan just locked at T0, with explore's clock running.
const live = (): Run => go(fresh(), PLAN, T0)
const look = (r: Run, t = '09:00') => observe(r, { kind: 'look', label: `Read ${r.step}`, fp: `x${r.step}` }, t).run
const edit = (r: Run, file: string, t = '09:00', denied = false) => observe(r, { kind: 'edit', label: `Edit ${file}`, file, ver: `v${r.step}`, ...(denied ? { denied } : {}) }, t).run
const check = (r: Run, label: string, pass: boolean, t = '09:00') => observe(r, { kind: 'check', label, pass, sig: pass ? '' : 'boom', sigText: pass ? '' : 'boom', fails: pass ? 0 : 1 }, t).run
const said = (r: Run, now: number) => timeMarked(r, timeDue(r, now)!, '09:00')
// Explore until `now`, then service.
const inService = (r: Run, now: number) => go(look(r), { action: 'advance', to: 'service', evidence: 'found it' }, now)
const inServiceAt = (now: number) => inService(live(), now)

// 1. Early or late
test('nothing is due under 30 minutes, and a mark is due at exactly 30', () => {
  expect(FIRST_MARK_MS).toBe(30 * MIN)
  expect(timeDue(live(), T0)).toBeUndefined()
  expect(timeDue(live(), at(30) - 1)).toBeUndefined()
  expect(timeDue(live(), at(30))).toEqual({ state: 'explore', mark: 30 * MIN, ms: 30 * MIN })
})

// 2. Once per mark
test('a mark is said once: nothing at 31 minutes after it, and due again at 60', () => {
  const r = said(live(), at(30))
  expect(timeDue(r, at(30))).toBeUndefined()
  expect(timeDue(r, at(31))).toBeUndefined()
  expect(timeDue(r, at(60) - 1)).toBeUndefined()
  expect(timeDue(r, at(60))).toEqual({ state: 'explore', mark: 60 * MIN, ms: 60 * MIN })
})

test('the marks double: 30 minutes, 1 h, 2 h, 4 h', () => {
  let r = live()
  const marks: number[] = []
  for (let n = 0; n <= 300; n++) {
    const due = timeDue(r, at(n))
    if (!due) continue
    marks.push(n)
    r = timeMarked(r, due, '09:00')
  }
  expect(marks).toEqual([30, 60, 120, 240])
})

// 3. A jump past two marks
test('a jump from 20 to 130 minutes gives one due at the 120 mark, then nothing until 240', () => {
  const r = live()
  expect(timeDue(r, at(20))).toBeUndefined()
  expect(timeDue(r, at(130))).toEqual({ state: 'explore', mark: 120 * MIN, ms: 130 * MIN })
  const after = said(r, at(130))
  expect(timeDue(after, at(131))).toBeUndefined()
  expect(timeDue(after, at(240) - 1)).toBeUndefined()
  expect(timeDue(after, at(240))?.mark).toBe(240 * MIN)
})

// 4. Waiting on the user
test('working time leaves the wait out: 25 minutes, a 40 minute gap and 1 minute is 26, so nothing is due', () => {
  const r = startClock(stopClock(live(), at(25)), at(65))
  expect(workingMs(r, 'explore', at(66))).toBe(26 * MIN)
  expect(timeDue(r, at(66))).toBeUndefined()
  // The open stretch moves on from there: 30 minutes of work falls at 70 on the wall clock.
  expect(timeDue(r, at(70) - 1)).toBeUndefined()
  expect(timeDue(r, at(70))).toEqual({ state: 'explore', mark: 30 * MIN, ms: 30 * MIN })
})

test('a stopped clock does not move, however late it gets', () => {
  const r = stopClock(live(), at(25))
  expect(workingMs(r, 'explore', at(500))).toBe(25 * MIN)
  expect(timeDue(r, at(500))).toBeUndefined()
})

test('nothing is due while a question to the user waits, and it comes once they answer', () => {
  const asks = { ...PLAN, states: [{ ...PLAN.states![0]!, wait: 'before' as const }, ...PLAN.states!.slice(1)] }
  const asked = go(go(fresh(), asks, T0), { action: 'propose', intent: 'Read the payments code' }, at(1))
  expect(waitingOn(asked)).toBe(true)
  expect(timeDue(asked, at(45))).toBeUndefined()
  const answered = stopSettled(asked, { how: 'yes' } as any, '09:45', at(45))
  expect(waitingOn(answered)).toBe(false)
  expect(timeDue(answered, at(45))?.mark).toBe(30 * MIN)
})

test('nothing is due while an escalation waits', () => {
  const r = go(live(), { action: 'escalate', kind: 'blocked', reason: 'the staging login has expired' }, at(1))
  expect(waitingOn(r)).toBe(true)
  expect(timeDue(r, at(45))).toBeUndefined()
})

// 5. A loop back
test('a loop back keeps the time from the earlier visit and repeats no mark', () => {
  let r = inServiceAt(at(1))
  r = said(r, at(31))
  expect(r.timeSaid?.service).toBe(30 * MIN)
  r = go(check(edit(r, 'src/refund.ts'), 'npm test -- refund', true), { action: 'advance', to: 'verify' }, at(41))
  r = go(check(r, 'npm test', true), { action: 'advance', to: 'service', evidence: 'the suite fails in service' }, at(50))
  expect(r.active).toBe('service')
  // 40 minutes on the first visit and 1 on this one; verify's 9 are its own.
  expect(workingMs(r, 'service', at(51))).toBe(41 * MIN)
  expect(timeDue(r, at(51))).toBeUndefined()
  expect(timeDue(r, at(70) - 1)).toBeUndefined()
  expect(timeDue(r, at(70))).toEqual({ state: 'service', mark: 60 * MIN, ms: 60 * MIN })
})

// 6. A new state
test('a new state starts at zero, even with the previous state at 40 minutes', () => {
  const r = inServiceAt(at(40))
  expect(workingMs(r, 'explore', at(41))).toBe(40 * MIN)
  expect(workingMs(r, 'service', at(41))).toBe(MIN)
  expect(timeDue(r, at(41))).toBeUndefined()
  expect(timeDue(r, at(70) - 1)).toBeUndefined()
})

test("the previous state's mark does not hold back the new state's own", () => {
  const r = inService(said(live(), at(30)), at(40))
  expect(timeDue(r, at(70))).toEqual({ state: 'service', mark: 30 * MIN, ms: 30 * MIN })
})

test('working time of a state never visited is zero', () => {
  expect(workingMs(live(), 'verify', at(45))).toBe(0)
  expect(workingMs(emptyRun(), 'explore', at(45))).toBe(0)
})

// 7. No live plan
test('nothing is due without a live plan: none at all, paused, or finished', () => {
  expect(timeDue(emptyRun(), at(45))).toBeUndefined()
  // A stale task and active state on a run with no plan still say nothing.
  expect(timeDue({ ...emptyRun(), active: 'explore', tasks: { explore: { visits: [{ from: T0 }] } } }, at(45))).toBeUndefined()
  expect(timeDue({ ...live(), paused: true }, at(45))).toBeUndefined()
  expect(timeDue({ ...live(), active: 'done', tasks: { done: { visits: [{ from: T0 }] } } }, at(45))).toBeUndefined()
})

test('nothing is due on a draft', () => {
  const drafted = go({ ...fresh(), review: true }, PLAN, T0)
  expect(drafted.draft?.active).toBe('explore')
  expect(timeDue(drafted, at(45))).toBeUndefined()
})

// 8. Old runs and odd names
test('a run saved with no timeSaid works', () => {
  const saved = JSON.parse(JSON.stringify(live())) as Run
  expect('timeSaid' in saved).toBe(false)
  expect(timeDue(saved, at(30))?.mark).toBe(30 * MIN)
  expect(said(saved, at(30)).timeSaid).toEqual({ explore: 30 * MIN })
})

test('a state called constructor reads its own mark, not one off Object.prototype', () => {
  const odd = { ...PLAN, states: [{ id: 'constructor', label: 'Read' }, ...PLAN.states!.slice(1)] }
  const r = { ...go(fresh(), odd, T0), timeSaid: { service: 30 * MIN } }
  expect(timeDue(r, at(30))).toEqual({ state: 'constructor', mark: 30 * MIN, ms: 30 * MIN })
  expect(timeDue(said(r, at(30)), at(31))).toBeUndefined()
})

// 9. timeMarked
test('timeMarked adds one log line and sets the mark, leaving the rest alone', () => {
  const r = { ...live(), timeSaid: { service: 60 * MIN } }
  const out = timeMarked(r, { state: 'explore', mark: 120 * MIN, ms: 130 * MIN }, '11:10')
  expect(out.timeSaid).toEqual({ service: 60 * MIN, explore: 120 * MIN })
  expect(out.log).toEqual([...r.log, { t: '11:10', icon: '!', tone: 'warn', text: 'explore · 2 h 10 min of working time' }])
  // The run it came from is left as it was.
  expect(r.timeSaid).toEqual({ service: 60 * MIN })
  expect(out.active).toBe('explore')
})

test('time reads as 45 min or 2 h 10 min, and an exact hour has no minutes', () => {
  const says = (ms: number) => timeMarked(live(), { state: 'explore', mark: 30 * MIN, ms }, '09:00').log.at(-1)!.text
  expect(says(45 * MIN)).toBe('explore · 45 min of working time')
  expect(says(130 * MIN)).toBe('explore · 2 h 10 min of working time')
  expect(says(60 * MIN)).toBe('explore · 1 h of working time')
  // It rounds down, so a mark never reads as more than has passed.
  expect(says(120 * MIN - 1)).toBe('explore · 1 h 59 min of working time')
})

// 10. The facts
// In service: an edit, a failing check, the same file again, a refused edit, 40 minutes, another file, then two passes.
function ledger(): Run {
  let r = inService(look(live(), '08:00'), at(1))
  r = edit(r, 'src/refund.ts', '09:00')
  r = check(r, 'npm test -- refund', false, '09:05')
  r = edit(r, 'src/refund.ts', '09:06')
  r = edit(r, 'src/other.ts', '09:07', true)
  r = edit(r, 'tests/refund.test.ts', '09:47')
  r = check(r, 'npm test -- refund', true, '09:50')
  return look(r, '09:51')
}

test('timeFacts gives the numbers from the ledger, with the longest stretch and the call that ended it', () => {
  expect(timeFacts(ledger(), 'service')).toBe('2 check runs, 1 failed; 3 edits to 2 files; longest stretch between calls 40 min by the clock, ended by Edit tests/refund.test.ts')
})

test('timeFacts leaves out what has a zero count', () => {
  expect(timeFacts(live(), 'explore')).toBe('')
  expect(timeFacts(live(), 'no-such-state')).toBe('')
  // Looks alone, all in one minute.
  expect(timeFacts(look(look(live())), 'explore')).toBe('')
  expect(timeFacts(check(live(), 'npm test', true), 'explore')).toBe('1 check run')
  expect(timeFacts(edit(live(), 'src/refund.ts'), 'explore')).toBe('1 edit to 1 file')
  // Refused edits alone are no edits.
  expect(timeFacts(edit(edit(live(), 'src/a.ts', '09:00', true), 'src/b.ts', '09:00', true), 'explore')).toBe('')
  // A stretch with nothing else to report stands alone.
  expect(timeFacts(look(look(live(), '09:00'), '09:12'), 'explore')).toMatch(/^longest stretch between calls 12 min by the clock, ended by Read \d+$/)
})

test("timeFacts counts only this state's calls", () => {
  // Explore has two reads an hour apart. The checks and edits are all service's.
  expect(timeFacts(ledger(), 'explore')).toMatch(/^longest stretch between calls 1 h by the clock, ended by Read \d+$/)
  expect(timeFacts(ledger(), 'verify')).toBe('')
})

test('a stretch across midnight is the 20 minutes it took', () => {
  const r = look(look(live(), '23:50'), '00:10')
  expect(timeFacts(r, 'explore')).toMatch(/^longest stretch between calls 20 min by the clock/)
})

test("counts run across all visits, and the gap while another state worked is not this state's stretch", () => {
  let r = inServiceAt(at(1))
  r = check(edit(r, 'src/refund.ts', '09:00'), 'npm test -- refund', true, '09:05')
  r = go(r, { action: 'advance', to: 'verify' }, at(10))
  r = go(check(r, 'npm test', false, '10:00'), { action: 'advance', to: 'service', evidence: 'the suite fails in service' }, at(180))
  r = edit(look(r, '12:00'), 'src/refund.ts', '12:01')
  expect(timeFacts(r, 'service')).toBe('1 check run; 2 edits to 1 file; longest stretch between calls 5 min by the clock, ended by npm test -- refund')
})

test('a long command that ended the stretch is cut to one short line', () => {
  const r = check(look(live(), '09:00'), `npm test\n  -- ${'x'.repeat(300)}`, true, '09:30')
  const facts = timeFacts(r, 'explore')
  expect(facts).toContain('ended by npm test -- xxx')
  expect(facts).not.toContain('\n')
  expect(facts.length).toBeLessThan(160)
})

// 11. The note
test('timeNote names the state, the time and the facts, says it does not stop the run, and names decide', () => {
  const r = ledger()
  const note = timeNote(r, { state: 'service', mark: 120 * MIN, ms: 130 * MIN })
  expect(note.startsWith('[sentinel] ')).toBe(true)
  expect(note).toContain('service')
  expect(note).toContain('2 h 10 min')
  expect(note).toContain(timeFacts(r, 'service'))
  expect(note).toMatch(/does not stop the run/)
  expect(note).toMatch(/where the time went/)
  expect(note).toMatch(/carry on if it is reasonable/i)
  expect(note).toMatch(/speed it up/)
  expect(note).toMatch(/hung or failing/)
  expect(note).toMatch(/"decide"/)
  expect(note).toMatch(/go on\.$/)
})

test('timeNote with no facts to give still reads as whole sentences', () => {
  const note = timeNote(live(), { state: 'explore', mark: 30 * MIN, ms: 30 * MIN })
  expect(note).toMatch(/^\[sentinel\] explore has taken 30 min of working time\. This does not stop the run\./)
  expect(note).not.toMatch(/\.\.|undefined| \./)
})

// 12. The decide the note asks for
const RERUN: PlanInput = { ...PLAN, library: { weight: 'thorough', on: ['fails-without-change'], told: [] } }
// In service, with a snapshot and one test and one code file edited: a rerun is due.
function rerunDue(): Run {
  const r = go(look(go(fresh(), RERUN, T0)), { action: 'advance', to: 'service', evidence: 'found it' }, at(1))
  return edit(edit(withSnap(r, 'snap1'), 'tests/refund.test.ts'), 'src/refund.ts')
}
const decided = (topic: string, choice: string, reason: string) => go(rerunDue(), { action: 'decide', topic, choice, reason }, at(45))

test('the decide the note asks for leaves the rerun on', () => {
  expect(rerunOf(rerunDue())).toMatchObject({ sha: 'snap1' })
  const topic = timeNote(rerunDue(), { state: 'service', mark: 30 * MIN, ms: 45 * MIN }).match(/topic "([^"]+)"/)?.[1]
  expect(topic).toBe('time on service')
  expect(rerunOf(decided(topic!, 'carry on', 'the suite is slow'))).toMatchObject({ sha: 'snap1' })
})

test('that decide leaves the rerun on when its reason or choice mentions fails-without-change', () => {
  expect(rerunOf(decided('time on service', 'carry on', 'most of it went on the fails-without-change rerun'))).toMatchObject({ sha: 'snap1' })
  expect(rerunOf(decided('time on service', 'drop the fails without change rerun next time', 'it is slow'))).toMatchObject({ sha: 'snap1' })
})

test('a topic naming the check still cancels the rerun', () => {
  expect(rerunOf(decided('fails-without-change', 'keep it', 'a refactor that keeps the output'))).toBeUndefined()
  expect(rerunOf(decided('Fails without change', 'keep it', 'a refactor that keeps the output'))).toBeUndefined()
})

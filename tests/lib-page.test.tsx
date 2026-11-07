// What the draft card and the task page read for a plan with mixed weights, and what each answer does. The page itself is
// in tests/page.check.mjs. Run with `node tests/only.mjs lib-page`.
//
// How this can fail, and where each is tested below:
//  1. A state that matches the plan gets a tag, or states with the same setting and reason show one row each.
//  2. States with different reasons, or one answered and one not, share a row, so one answer settles both.
//  3. A plan with the switch off carries any of this, so the page shows a section that means nothing.
//  4. Keep doesn't hold through a later change on the draft, or reaches past its row.
//  5. "Use Standard" or Remove leaves the state's fields behind, or a revise brings them straight back.
//  6. An answer on a plan setting doesn't change what the plan runs with.
//  7. A stale page answers for a draft that has since changed.
//  8. A change on the draft's instructions forgets Claude's settings, or flips the experimental switch.
//  9. The terminal has no way to answer, so a looser setting can only be left to the lock.
// 10. A pick on the draft's cards leaves the setting it overrules on the card, or a later answer undoes the pick.
// 11. Words the user typed can't be taken back on the draft.
import { expect, mock } from 'claude-code/testing'
import { STATE_SETTINGS, act, answerSetting, emptyRun, settingRows, summarize, weightFor } from '../hooks/core'
import type { PlanInput, PlanLibrary, Run } from '../types'
import { ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const lib = (more: Partial<PlanLibrary> = {}): PlanLibrary => ({
  weight: 'standard', on: ['failure-list', 'fails-first', 'break-it-once', STATE_SETTINGS], told: [],
  states: { hand: { [STATE_SETTINGS]: true }, weights: { 'failure-list': ['standard', 'thorough'], 'fails-first': ['standard', 'thorough'], 'break-it-once': ['standard', 'thorough'], 'fails-without-change': ['thorough'] }, spare: [] },
  ...more,
})
const st = (id: string, more: object = {}) => ({ id, label: id, check: `npm test -- ${id}`, files: [`${id}/**`], ...more })
const MIXED: PlanInput = {
  action: 'define', title: 'Payments',
  states: [
    st('copy', { weight: 'light', weightWhy: 'only changes text' }),
    st('form'),
    st('charge', { adds: [{ name: 'security-review', why: 'handles money' }] }),
    st('refund', { adds: [{ name: 'security-review', why: 'handles money' }] }),
    st('export', { weight: 'thorough', weightWhy: 'rewrites saved data' }),
    st('docs', { weight: 'light', weightWhy: 'only changes text' }),
    st('other', { weight: 'light', weightWhy: 'a different reason' }),
    st('asked', { weight: 'light', weightQuote: 'the words the user typed here', weightOk: true }),
    st('same', { weight: 'standard', weightWhy: 'says the plan weight' }),
  ],
}
const draftOf = (i: PlanInput) => act({ ...emptyRun(), signedOff: true, review: true }, i, '09:00').run

test('the rows: only what differs, grouped by what it says', () => {
  const rows = settingRows(draftOf({ ...MIXED, library: lib() }).draft!)
  const of = (id: string) => rows.find(r => r.states.includes(id))
  expect(rows).toHaveLength(5)
  expect(of('copy')).toMatchObject({ kind: 'weight', weight: 'light', why: 'only changes text', states: ['copy', 'docs'], owed: true, looser: true })
  expect(of('export')).toMatchObject({ kind: 'weight', weight: 'thorough', why: 'rewrites saved data', states: ['export'], owed: false })
  expect(of('export')!.looser).toBeUndefined()
  expect(of('charge')).toMatchObject({ kind: 'add', name: 'security-review', why: 'handles money', states: ['charge', 'refund'], owed: false })
  expect(of('other')).toMatchObject({ states: ['other'], owed: true })
  // The user's own words count as their answer, and their row shows them.
  expect(of('asked')).toMatchObject({ states: ['asked'], quote: 'the words the user typed here', owed: false, looser: true })
  expect(of('form')).toBeUndefined()
  expect(of('same')).toBeUndefined()
  // A row answered apart from another with the same words stands apart.
  const d = draftOf({ ...MIXED, library: lib() }).draft!
  const kept: Run = { ...d, plan: { ...d.plan!, states: d.plan!.states.map(s => (s.id === 'copy' ? { ...s, weightOk: true as const } : s)) } }
  const split = settingRows(kept)
  expect(split.find(r => r.states.includes('copy'))).toMatchObject({ states: ['copy'], owed: false, kept: true })
  expect(split.find(r => r.states.includes('docs'))).toMatchObject({ states: ['docs'], owed: true })
})

test('the rows: a plan\'s own settings come first, and only a held one is owed', () => {
  const settings = [{ weight: 'thorough' as const, why: 'money' }, { name: 'failure-list', on: false, why: 'x', held: true as const }]
  const rows = settingRows(draftOf({ ...MIXED, states: [st('a')], library: lib({ settings }) }).draft!)
  expect(rows).toEqual([
    { id: 'plan|#weight', kind: 'plan', key: '#weight', states: [], weight: 'thorough', why: 'money', owed: false },
    { id: 'plan|failure-list', kind: 'plan', key: 'failure-list', states: [], name: 'failure-list', on: false, why: 'x', owed: true },
  ])
})

test('the rows: none with the switch off, whatever the plan holds', () => {
  const { states: _states, ...off } = lib()
  const r = draftOf({ action: 'define', title: 'P', states: [st('a', { weight: 'light', weightWhy: 'x', adds: [{ name: 'failure-list', why: 'y' }] })], library: { ...off, settings: [{ weight: 'light', why: 'z' }] } })
  expect(settingRows(r.draft!)).toEqual([])
})

test('the rows: words the user typed don\'t read as a Keep', () => {
  const rows = settingRows(draftOf({ ...MIXED, library: lib() }).draft!)
  expect(rows.find(r => r.states.includes('asked'))!.kept).toBeUndefined()
})

test('the view model carries it with the switch on, and none of it with the switch off', () => {
  const vm = summarize(draftOf({ ...MIXED, library: lib() }))
  expect(vm.planWeight).toBe('standard')
  expect(vm.settingRows).toHaveLength(5)
  const s = (id: string) => vm.states.find(x => x.id === id)!
  expect(s('copy')).toMatchObject({ weight: 'light', weightWhy: 'only changes text', weightNow: 'standard' })
  expect(s('export')).toMatchObject({ weightNow: 'thorough', noRerun: true })
  expect(s('form').weightNow).toBe('standard')
  expect('noRerun' in s('form')).toBe(false)
  expect('weightNow' in s('done')).toBe(false)
  const { states: _states, ...off } = lib()
  const plain = summarize(draftOf({ action: 'define', title: 'P', states: [st('a')], library: off }))
  expect('planWeight' in plain).toBe(false)
  expect('settingRows' in plain).toBe(false)
  expect('weightNow' in plain.states[0]!).toBe(false)
  // The note on a member's rerun doesn't depend on the switch.
  const thorough = summarize(draftOf({ action: 'define', title: 'P', states: [st('a')], library: { ...off, on: [...off.on, 'fails-without-change'] } }))
  expect(thorough.states[0]!.noRerun).toBe(true)
})

test('an answer on a plan setting leaves the flows on the plan\'s list alone', () => {
  const items = [{ name: 'failure-list', weights: ['standard', 'thorough'] as const, trusted: true }]
  const out = answerSetting(lib({ on: ['failure-list', 'a-flow'], settings: [{ weight: 'light', why: 'small', held: true }] }), '#weight', true, items)
  expect(out.weight).toBe('light')
  expect(out.on).toEqual(['a-flow'])
  // An answer settles its own row, and nothing else comes back with it.
  const other = lib({ on: ['failure-list'], settings: [{ weight: 'light', quote: 'keep this plan nice and light' }, { name: 'break-it-once', on: true, why: 'x', held: true }] })
  expect(answerSetting(other, 'break-it-once', false, items).weight).toBe('standard')
  expect(answerSetting(other, 'break-it-once', true, items).weight).toBe('standard')
})

async function session($: any, on: any) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  eng.files[`${ROOT}/.sentinel/library.json`] = JSON.stringify({ on: { [STATE_SETTINGS]: true } })
  await $.command.run({ command: 'sentinel', args: 'lock' })
  await openPage($, clock)
  const drafted = () => (JSON.parse(eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}') as Run).draft!
  const answer = async (id: string, keep: boolean, draft = eng.snap().draftKey) => {
    const was = JSON.stringify(drafted())
    eng.page({ kind: 'setrow', draft, id, keep })
    await until(clock, () => JSON.stringify(drafted()) !== was)
  }
  const rowOf = (state: string) => settingRows(drafted()).find(r => r.states.includes(state))!
  return { eng, clock, drafted, answer, rowOf, define: (i: object) => $.tool.call({ tool: TOOL, ...i }) }
}
const DEFINE = {
  action: 'define', title: 'P',
  states: [
    st('copy', { weight: 'light', weightWhy: 'only text' }), st('docs', { weight: 'light', weightWhy: 'only text' }),
    st('pay', { adds: [{ name: 'failure-list', why: 'money' }] }), st('tax', { adds: [{ name: 'failure-list', why: 'money' }, { name: 'break-it-once', why: 'tax rules' }] }),
    st('other', { weight: 'light', weightWhy: 'a different reason' }),
  ],
}
const ORDER = DEFINE.states.map(s => s.id)

test('Keep holds for the whole row and through a later change on the draft, until the reason changes', async ($: any, on: any) => {
  const { answer, rowOf, drafted, define, eng, clock } = await session($, on)
  await define(DEFINE)
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  await answer(rowOf('copy').id, true)
  // The row with another reason is still waiting.
  expect(drafted().plan!.states.filter(s => s.weightOk).map(s => s.id)).toEqual(['copy', 'docs'])
  expect(rowOf('other').owed).toBe(true)
  expect(weightFor(drafted(), drafted().plan!.states[0]!)).toBe('light')
  // A revise that sends the state the same keeps the answer. One with a new reason asks again.
  await define({ action: 'revise', order: ORDER, states: [st('copy', { weight: 'light', weightWhy: 'only text', label: 'New' })] })
  await until(clock, () => drafted().plan!.states[0]!.label === 'New')
  expect(drafted().plan!.states[0]!.weightOk).toBe(true)
  await define({ action: 'revise', order: ORDER, states: [st('copy', { weight: 'light', weightWhy: 'another reason' })] })
  await until(clock, () => drafted().plan!.states[0]!.weightWhy === 'another reason')
  expect(drafted().plan!.states[0]!.weightOk).toBeUndefined()
  expect(drafted().plan!.states[1]!.weightOk).toBe(true)
})

test('Use Standard and Remove take the fields off, and a later revise doesn\'t bring them back', async ($: any, on: any) => {
  const { answer, rowOf, drafted, define, clock, eng } = await session($, on)
  await define(DEFINE)
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  await answer(rowOf('copy').id, false)
  for (const id of [0, 1]) for (const k of ['weight', 'weightWhy', 'weightOk']) expect(k in drafted().plan!.states[id]!).toBe(false)
  expect(drafted().plan!.states[4]!.weight).toBe('light')
  await until(clock, () => eng.snap().draftKey)
  await answer(rowOf('pay').id, false)
  expect('adds' in drafted().plan!.states[2]!).toBe(false)
  expect(drafted().plan!.states[3]!.adds).toEqual([{ name: 'break-it-once', why: 'tax rules' }])
  await define({ action: 'revise', order: ORDER, states: [st('docs', { label: 'New' })] })
  await until(clock, () => drafted().plan!.states[1]!.label === 'New')
  expect(drafted().plan!.states[0]!.weight).toBeUndefined()
  expect(drafted().plan!.states[2]!.adds).toBeUndefined()
})

test('an answer on a plan setting changes what the plan runs with', async ($: any, on: any) => {
  const { answer, drafted, define, clock, eng } = await session($, on)
  await define({ action: 'define', title: 'P', states: [st('a')], settings: [{ weight: 'light', why: 'small' }, { name: 'failure-list', on: false, why: 'x' }] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  expect(drafted().library).toMatchObject({ weight: 'standard' })
  await answer('plan|#weight', true)
  expect(drafted().library!.weight).toBe('light')
  expect(drafted().library!.on).not.toContain('fails-first')
  expect(drafted().library!.settings).toEqual([{ weight: 'light', why: 'small' }, { name: 'failure-list', on: false, why: 'x', held: true }])
  await until(clock, () => eng.snap().draftKey)
  await answer('plan|failure-list', false)
  expect(drafted().library!.settings).toEqual([{ weight: 'light', why: 'small' }])
})

test('a pick on the cards takes the setting it overrules with it, and a later answer leaves the pick alone', async ($: any, on: any) => {
  const { answer, drafted, define, clock, eng } = await session($, on)
  await $.prompt.submit({ text: 'keep this plan nice and light please', origin: { kind: 'composer' } })
  await define({ action: 'define', title: 'P', states: [st('a')], settings: [{ weight: 'light', quote: 'keep this plan nice and light' }, { name: 'break-it-once', on: true, why: 'x' }, { name: 'sources-first', on: true, why: 'a TRD' }, { name: 'fast-checks', on: false, why: 'y' }] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  expect(drafted().library!.weight).toBe('light')
  const was = JSON.stringify(drafted())
  // The user picks Standard on the cards, with sources-first ticked off.
  const list = drafted().library!.on.filter(n => n !== 'sources-first' && n !== STATE_SETTINGS)
  eng.page({ kind: 'libplan', draft: eng.snap().draftKey, weight: 'standard', on: [...list, 'failure-list', 'fails-first'] })
  await until(clock, () => JSON.stringify(drafted()) !== was)
  expect(drafted().library!.weight).toBe('standard')
  // Their pick overrules these, so the rows go. What still waits for them stays.
  expect(drafted().library!.settings!.map(s => s.weight ?? s.name)).toEqual(['break-it-once', 'fast-checks'])
  await until(clock, () => eng.snap().draftKey)
  await answer('plan|fast-checks', false)
  expect(drafted().library!.weight).toBe('standard')
  expect(drafted().library!.on).toContain('fails-first')
  expect(drafted().library!.on).not.toContain('sources-first')
})

const lockedFree = async (eng: any, clock: any, drafted: () => Run) => {
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  eng.page({ kind: 'lock', draft: eng.snap().draftKey, free: true })
  await until(clock, () => !!eng.files[`${ROOT}/.sentinel/run.json`] && JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`]).handsFree)
  return JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`]) as Run
}

test('lock and go hands-free: what waits for you goes through, each listed, and Claude hears it once', async ($: any, on: any) => {
  const { eng, clock, define, drafted } = await session($, on)
  await define({ action: 'define', title: 'P', states: [st('copy', { weight: 'light', weightWhy: 'only text' }), st('pay')], settings: [{ name: 'failure-list', on: false, why: 'slow here' }] })
  const r = await lockedFree(eng, clock, drafted)
  expect(r.active).toBe('copy')
  expect(weightFor(r, r.plan!.states[0]!)).toBe('light')
  expect(r.library!.on).not.toContain('failure-list')
  expect(r.library!.settings![0]!.held).toBeUndefined()
  const list = r.audit.filter(a => a.kind === 'decided').map(a => a.text)
  expect(list).toContain('Went light hands-free: only text')
  expect(list).toContain('Turned failure-list off hands-free: slow here')
  await until(clock, () => eng.submitted.some((t: string) => /locked "P"/.test(t)))
  const told = eng.submitted.filter((t: string) => /locked "P"/.test(t))
  expect(told).toHaveLength(1)
  expect(told[0]).toMatch(/hands-free and away/)
  expect(told[0]).not.toMatch(/Left at the plan's weight/)
  expect(eng.submitted.filter((t: string) => /Continue with the plan/.test(t))).toEqual([])
})

test('the plain Lock stays out of hands-free', async ($: any, on: any) => {
  const { eng, clock, define, drafted } = await session($, on)
  await define({ action: 'define', title: 'P', states: [st('copy', { weight: 'light', weightWhy: 'only text' }), st('pay')] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  eng.page({ kind: 'lock', draft: eng.snap().draftKey })
  await until(clock, () => eng.submitted.some((t: string) => /locked "P"/.test(t)))
  await define({ action: 'status' })
  const r = JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run
  expect(r.handsFree).toBeUndefined()
  expect(weightFor(r, r.plan!.states[0]!)).toBe('standard')
})

test('lock and go hands-free takes the whole plan lighter, and the states Claude added stay', async ($: any, on: any) => {
  const { eng, clock, define, drafted } = await session($, on)
  await define({ action: 'define', title: 'P', states: [st('a')], settings: [{ weight: 'light', why: 'a small job' }] })
  const r = await lockedFree(eng, clock, drafted)
  expect(r.library!.weight).toBe('light')
  expect(r.audit.filter(a => a.kind === 'decided').map(a => a.text)).toContain('Went light for the whole plan hands-free: a small job')
})

test('lock and go hands-free with the switch off: it locks and goes hands-free, and nothing else', async ($: any, on: any) => {
  const { eng, clock, define, drafted } = await session($, on)
  eng.files[`${ROOT}/.sentinel/library.json`] = '{}'
  await define({ action: 'define', title: 'P', states: [st('a')] })
  const r = await lockedFree(eng, clock, drafted)
  expect(r.handsFree).toBe(true)
  expect(r.library!.states).toBeUndefined()
  expect(r.audit.filter(a => a.kind === 'decided')).toEqual([])
})

test('a stale page can\'t lock and go hands-free', async ($: any, on: any) => {
  const { eng, clock, define, drafted } = await session($, on)
  await define({ action: 'define', title: 'P', states: [st('a')] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  eng.page({ kind: 'lock', draft: 'old', free: true })
  await clock.advance(50)
  expect(JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}').handsFree).toBeFalsy()
  expect(drafted().plan).toBeDefined()
})

test('a stale page changes nothing', async ($: any, on: any) => {
  const { rowOf, drafted, define, clock, eng } = await session($, on)
  await define(DEFINE)
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  const was = JSON.stringify(drafted())
  eng.page({ kind: 'setrow', draft: 'an old draft', id: rowOf('copy').id, keep: true })
  eng.page({ kind: 'setrow', draft: eng.snap().draftKey, id: 'weight|nothing', keep: true })
  await clock.advance(5_000)
  expect(JSON.stringify(drafted())).toBe(was)
})

test('a change on the draft\'s instructions keeps Claude\'s settings and the switch as they were', async ($: any, on: any) => {
  const { drafted, define, clock, eng } = await session($, on)
  await define({ action: 'define', title: 'P', states: [st('a')], settings: [{ weight: 'thorough', why: 'money' }] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  const was = JSON.stringify(drafted())
  // The page's list leaves the switch out: it isn't one of the draft's choices.
  eng.page({ kind: 'libplan', draft: eng.snap().draftKey, weight: 'thorough', on: ['failure-list'] })
  await until(clock, () => JSON.stringify(drafted()) !== was)
  expect(drafted().library!.on).toContain(STATE_SETTINGS)
  expect(drafted().library!.states).toBeDefined()
  expect(drafted().library!.settings).toEqual([{ weight: 'thorough', why: 'money' }])
})

test('a page can\'t turn the switch on for a draft that has it off', async ($: any, on: any) => {
  const { drafted, define, clock, eng } = await session($, on)
  eng.files[`${ROOT}/.sentinel/library.json`] = '{}'
  await define({ action: 'define', title: 'P', states: [st('a')] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  const was = JSON.stringify(drafted())
  eng.page({ kind: 'libplan', draft: eng.snap().draftKey, weight: 'standard', on: ['failure-list', STATE_SETTINGS] })
  await until(clock, () => JSON.stringify(drafted()) !== was)
  expect(drafted().library!.on).not.toContain(STATE_SETTINGS)
  expect(drafted().library!.states).toBeUndefined()
})

// A session whose tree the band draws, as the terminal does.
test('the terminal band asks about a looser setting, and each button answers it', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  eng.files[`${ROOT}/.sentinel/library.json`] = JSON.stringify({ on: { [STATE_SETTINGS]: true } })
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(said(await $.tool.call({ tool: TOOL, ...DEFINE }))).toMatch(/draft/i)
  const drafted = () => (JSON.parse(eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}') as Run).draft!
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  await until(clock, () => !!drafted()?.plan)
  expect(await ui.find({ type: 'Text', text: /copy, docs on light, looser than the plan/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Use standard' })).toBeDefined()
  await ui.press({ key: 'keep' })
  await until(clock, () => drafted()?.plan?.states[0]?.weightOk === true)
  // One at a time, and then the band goes back to asking for the lock.
  expect(await ui.find({ type: 'Text', text: /other on light, looser than the plan/ })).toBeDefined()
  await ui.press({ key: 'keep' })
  await until(clock, () => drafted()?.plan?.states[4]?.weightOk === true)
  expect(await ui.find({ type: 'Text', text: /Check it, then lock it/ })).toBeDefined()
  await ui.unmount()
})

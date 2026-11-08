// Claude picks a preset for the plan it drafts: define's "preset", which points the project at it as /sentinel preset
// does and builds the plan on it. Run with `node tests/only.mjs preset-pick`.
//
// How this can fail, and where each is tested below:
//  1. A pick that only adds rules doesn't point the project at it, the plan isn't built on it, or it goes unrecorded:
//     no decision, nothing for the draft card.
//  2. A pick that turns a rule off or lightens the weight goes through on Claude's reason alone, or is refused without
//     saying what it loosens; or the user's words naming it from their last message still don't let it through.
//  3. A pick with no reason, a preset this computer lacks, or a pick on revise changes something.
//  4. A define refused after the pick (an MCP the preset needs isn't connected) leaves the project pointing at it.
//  5. A define sent before the sign-off picks before the user signs off, or not at all when they do.
//  6. Picking the preset already in use records a pick.
//  7. Claude sends what Sentinel records itself: the plan's preset.
//  8. Claude isn't told which presets there are while no plan runs, or still is while one runs.
//  9. A change on the draft card, or an answer to one of its settings, rebuilds the plan's Library without the pick.
// 10. A pick sent with "quote" alone is recorded as the user's words without being checked, or "none" in passing counts
//     as their ask for no preset.
// 11. A pick shows no toast, so one that locks at once (signed off in plan mode, no draft card) goes unseen.
import { expect, mock } from 'claude-code/testing'
import type { Run } from '../types'
import { HOME, ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const LIB = `${ROOT}/.sentinel/library.json`
const PRESETS = `${HOME}/.sentinel/presets`
const STATES = [{ id: 'copy', label: 'Copy', check: 'npm test -- copy', files: ['docs/**'] }, { id: 'form', label: 'Form', check: 'npm test -- form', files: ['src/**'] }]
const define = (more: object = {}) => ({ tool: TOOL, action: 'define', title: 'P', states: STATES, ...more })

async function session($: any, on: any) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  // A preset's weight would turn quoting on, which these plans leave out, so the project keeps it off.
  eng.files[LIB] = JSON.stringify({ on: { 'quote-the-source': false } })
  // backend only adds rules; quick lightens the weight; tools is backend plus a server this session lacks.
  eng.files[`${PRESETS}/backend/library.json`] = JSON.stringify({ weight: 'thorough', on: { 'sources-first': true } })
  eng.files[`${PRESETS}/quick/library.json`] = JSON.stringify({ weight: 'light' })
  eng.files[`${PRESETS}/tools/library.json`] = JSON.stringify({ weight: 'thorough', on: { 'sources-first': true }, mcps: ['Unity'] })
  const sentinel = async (args: string) => said(await $.command.run({ command: 'sentinel', args }))
  return {
    eng, clock, sentinel,
    typed: (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } }),
    call: async (input: object) => said(await $.tool.call(input)),
    pointer: () => (JSON.parse(eng.files[LIB] ?? '{}') as { preset?: string }).preset,
    drafted: () => (JSON.parse(eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}') as Run).draft!,
    section: async () => (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })).sections.find((s: any) => s.id === 'sentinel:library')?.text ?? '',
  }
}

test('a pick that only adds rules points the project at it, builds the draft on it, and is on record', async ($: any, on: any) => {
  const { eng, sentinel, call, pointer, drafted } = await session($, on)
  await sentinel('lock')
  expect(await call(define({ preset: 'backend', reason: 'the plan is API work' }))).toMatch(/Draft saved/)
  expect(pointer()).toBe('backend')
  const r = drafted()
  expect(r.library!.weight).toBe('thorough')
  expect(r.library!.on).toContain('sources-first')
  expect(r.library!.preset).toEqual({ name: 'backend', why: 'the plan is API work' })
  expect(r.audit.map(a => a.text)).toContain('Preset → backend (the plan is API work)')
  expect(eng.toasts).toContain('Sentinel: Claude picked the preset backend for this plan. Undo: /sentinel preset none')
})

test('a pick sent with the user\'s words needs them in their last message, even one that only adds rules', async ($: any, on: any) => {
  const { sentinel, typed, call, pointer, drafted } = await session($, on)
  await sentinel('lock')
  await typed('the plan is for the new API')
  expect(await call(define({ preset: 'backend', quote: 'please use backend' }))).toMatch(/isn't in the user's last message/)
  expect(pointer()).toBeUndefined()
  expect(drafted()).toBeUndefined()
  await typed('please use backend for this plan')
  expect(await call(define({ preset: 'backend', quote: 'please use backend' }))).toMatch(/Draft saved/)
  expect(drafted().library!.preset).toEqual({ name: 'backend', quote: 'please use backend' })
})

test('a pick that loosens the rules is refused on a reason alone, and goes through on the user\'s words naming it', async ($: any, on: any) => {
  const { sentinel, typed, call, pointer, drafted } = await session($, on)
  await sentinel('lock')
  const r = await call(define({ preset: 'quick', reason: 'a small fix' }))
  expect(r).toMatch(/^Picking quick loosens the rules here: it turns off .*failure-list.*, and the weight goes from standard to light\. Ask the user, then send define again with "quote": their words naming quick\.$/)
  expect(pointer()).toBeUndefined()
  expect(drafted()).toBeUndefined()
  await typed('use the quick preset for this one, it is a one-line fix')
  await typed('go on')
  expect(await call(define({ preset: 'quick', quote: 'use the quick preset for this one' }))).toMatch(/isn't in the user's last message/)
  expect(pointer()).toBeUndefined()
  await typed('use the quick preset for this one, it is a one-line fix')
  expect(await call(define({ preset: 'quick', quote: 'use the quick preset for this one' }))).toMatch(/Draft saved/)
  expect(pointer()).toBe('quick')
  expect(drafted().library!.weight).toBe('light')
  expect(drafted().library!.preset).toEqual({ name: 'quick', quote: 'use the quick preset for this one' })
})

test('no reason, a preset this computer lacks, or a pick on revise changes nothing', async ($: any, on: any) => {
  const { sentinel, call, pointer, eng } = await session($, on)
  await sentinel('lock')
  const lib = eng.files[LIB]
  expect(await call(define({ preset: 'backend' }))).toMatch(/needs "reason"/)
  expect(await call(define({ preset: 'nope', reason: 'x' }))).toBe('There is no preset "nope" on this computer. These are: backend, quick and tools.')
  expect(eng.files[LIB]).toBe(lib)
  expect(await call(define())).toMatch(/Draft saved/)
  expect(await call({ tool: TOOL, action: 'revise', order: ['copy', 'form'], preset: 'backend', reason: 'x' })).toMatch(/send define again/)
  expect(pointer()).toBeUndefined()
})

test('a define refused after the pick puts the project\'s preset back', async ($: any, on: any) => {
  const { sentinel, call, pointer } = await session($, on)
  await sentinel('preset backend')
  // Approved in plan mode, so the define would lock at once; the preset needs Unity, which isn't connected.
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(await call(define({ preset: 'tools', reason: 'the plan drives Unity' }))).toMatch(/can't lock: Unity isn't connected/)
  expect(pointer()).toBe('backend')
})

test('a define sent before the sign-off picks only when the user signs off', async ($: any, on: any) => {
  const { sentinel, call, pointer, drafted } = await session($, on)
  await call(define({ preset: 'backend', reason: 'the plan is API work' }))
  expect(pointer()).toBeUndefined()
  expect(await sentinel('lock')).toMatch(/The plan the model sent before is the draft now/)
  expect(pointer()).toBe('backend')
  expect(drafted().library!.preset).toEqual({ name: 'backend', why: 'the plan is API work' })
})

test('picking the preset in use records no pick, and none drops one only on the user\'s words', async ($: any, on: any) => {
  const { sentinel, typed, call, pointer, drafted } = await session($, on)
  await sentinel('preset backend')
  await sentinel('lock')
  expect(await call(define({ preset: 'backend', reason: 'still API work' }))).toMatch(/Draft saved/)
  expect(drafted().library!.preset).toBeUndefined()
  expect(drafted().audit.some(a => /^Preset/.test(a.text))).toBe(false)
  expect(await call(define({ preset: 'none', reason: 'plain work' }))).toMatch(/^Picking no preset loosens the rules here: .*the weight goes from thorough to standard/)
  expect(pointer()).toBe('backend')
  await typed('none of these tests pass yet, carry on')
  expect(await call(define({ preset: 'none', quote: 'none of these tests pass yet' }))).toMatch(/doesn't name backend/)
  expect(pointer()).toBe('backend')
  await typed('stop using the backend preset for this plan')
  expect(await call(define({ preset: 'none', quote: 'stop using the backend preset' }))).toMatch(/Draft saved/)
  expect(pointer()).toBeUndefined()
  expect(drafted().library!.preset).toEqual({ name: 'none', was: 'backend', quote: 'stop using the backend preset' })
})

test('Claude can\'t send the plan\'s preset itself', async ($: any, on: any) => {
  const { sentinel, call, drafted } = await session($, on)
  await sentinel('lock')
  expect(await call(define({ library: { weight: 'light', on: [], told: [], preset: { name: 'quick', why: 'x' } } }))).toMatch(/Draft saved/)
  expect(drafted().library!.preset).toBeUndefined()
  expect(drafted().library!.weight).toBe('standard')
})

test('while no plan runs Claude hears the presets, the one in use and how to pick; while one runs, nothing of them', async ($: any, on: any) => {
  const { sentinel, call, section } = await session($, on)
  await sentinel('preset backend')
  const text = await section()
  expect(text).toMatch(/Presets on this computer, this project using backend:/)
  expect(text).toMatch(/- quick: weight light/)
  expect(text).toMatch(/- tools: .*needs Unity/)
  expect(text).toMatch(/send "preset" with define/)
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(await call(define())).toMatch(/Locked "P"/)
  expect(await section()).not.toMatch(/Presets on this computer/)
})

test('a change on the draft card keeps the preset Claude picked', async ($: any, on: any) => {
  const { eng, clock, sentinel, call, drafted } = await session($, on)
  await openPage($, clock)
  await sentinel('lock')
  await call(define({ preset: 'backend', reason: 'the plan is API work' }))
  await until(clock, () => eng.snap().draftKey)
  const was = JSON.stringify(drafted())
  eng.page({ kind: 'libplan', draft: eng.snap().draftKey, weight: 'thorough', on: ['failure-list'] })
  await until(clock, () => JSON.stringify(drafted()) !== was)
  expect(drafted().library!.on).toEqual(['failure-list'])
  expect(drafted().library!.preset).toEqual({ name: 'backend', why: 'the plan is API work' })
})

test('an answer to a setting on the draft keeps the preset Claude picked, through the lock', async ($: any, on: any) => {
  const { eng, clock, sentinel, call, drafted } = await session($, on)
  eng.files[LIB] = JSON.stringify({ on: { 'quote-the-source': false, 'state-settings': true } })
  await openPage($, clock)
  await sentinel('lock')
  await call(define({ preset: 'backend', reason: 'the plan is API work', settings: [{ weight: 'standard', why: 'a small change' }] }))
  await until(clock, () => eng.snap().draftKey)
  expect(drafted().library!.settings).toEqual([{ weight: 'standard', why: 'a small change', held: true }])
  // Lock and go hands-free answers the held setting, which rebuilds the plan's Library, then locks.
  eng.page({ kind: 'lock', draft: eng.snap().draftKey, free: true })
  const running = () => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run
  await until(clock, () => running().plan)
  expect(running().library!.weight).toBe('standard')
  expect(running().library!.preset).toEqual({ name: 'backend', why: 'the plan is API work' })
})

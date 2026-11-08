// What Claude can send for a plan and its states, and what Sentinel does with it, behind the Library's experimental switch.
// Run with `node tests/only.mjs lib-settings`.
//
// How this can fail, and where each is tested below:
//  1. With the switch off the fields still count, the plan is refused, or Claude isn't told they went.
//  2. Claude gets past the user by sending what Sentinel sets itself: weightOk, or a setting with held taken off.
//  3. A looser setting takes effect with nobody's answer, or locks past the user with no draft to answer on.
//  4. A stricter setting stops the run for an answer it doesn't need.
//  5. A quote counts though the user never typed it, or words from a sentence that says the opposite count.
//  6. A quote the user did type gets asked again.
//  7. An addition names something that can't fire on that state, and shows on the draft doing nothing.
//  8. An instruction the user switched off comes back by Claude's reason, or an instruction off only by weight can't be added.
//  9. Settings change the user's own switch files, or reach beyond this plan.
// 10. A revise or a change on the draft forgets an answer, or a setting that is no longer the same keeps its answer.
// 11. A state added mid-run stops for a looser weight, or settings change a plan that already runs.
// 12. Any five words the user typed unlock a looser setting, whatever they are about.
// 13. A setting applied once applies again and undoes the user's pick on the draft.
// 14. With the switch off the page gets no weight for the plan or a state, so the Map can't show one.
// 15. A skip is free text, so the page can't say which instruction a state went without, or a skip names one the state
//     was never told, one Sentinel runs itself, or a state that isn't there.
import { expect, mock } from 'claude-code/testing'
import { checkSetting } from '../hooks/quote'
import { STATE_SETTINGS, act, emptyRun, handsFree, planSettings, settledStates, startCheck, weightFor } from '../hooks/core'
import { BUILTINS } from '../hooks/builtins'
import type { PlanInput, PlanLibrary, Run } from '../types'
import { ROOT, TOOL, engine, said, test } from './kit'

const FILE = `${ROOT}/.sentinel/library.json`
const COPY = { id: 'copy', label: 'Copy', check: 'npm test -- copy', files: ['docs/**'] }
const FORM = { id: 'form', label: 'Form', check: 'npm test -- form', files: ['src/**'] }
const plan = (copy: object = {}, more: object = {}) => ({ tool: TOOL, action: 'define', title: 'P', states: [{ ...COPY, ...copy }, FORM], ...more })

async function session($: any, on: any, sw?: object | null) {
  const eng = engine(on)
  mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  if (sw !== null) eng.files[FILE] = JSON.stringify(sw ?? { on: { [STATE_SETTINGS]: true } })
  return {
    eng,
    typed: (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } }),
    signOff: () => $.tool.call({ tool: 'ExitPlanMode' }),
    sentinel: async (args: string) => String((await $.command.run({ command: 'sentinel', args })).text ?? ''),
    running: () => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run,
    drafted: () => (JSON.parse(eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}') as Run).draft!,
  }
}

test('with the switch off the fields go, the plan saves, and the reply says so once', async ($: any, on: any) => {
  const { signOff, running } = await session($, on, null)
  await signOff()
  const r = await $.tool.call(plan({ weight: 'light', weightWhy: 'only text', weightOk: true, adds: [{ name: 'failure-list', why: 'x' }] }, { settings: [{ weight: 'thorough', why: 'x' }] }))
  expect(said(r)).toMatch(/Locked "P"/)
  expect((r.context ?? []).filter((c: string) => /per-state settings are off/.test(c))).toHaveLength(1)
  const st = running().plan!.states[0]!
  for (const k of ['weight', 'weightWhy', 'weightOk', 'adds']) expect(k in st).toBe(false)
  expect(running().library!.weight).toBe('standard')
})

test('with the switch off a plan with none of the fields hears nothing of it', async ($: any, on: any) => {
  const { signOff } = await session($, on, null)
  await signOff()
  const r = await $.tool.call(plan())
  expect([said(r), ...(r.context ?? [])].join()).not.toMatch(/per-state settings/)
})

test('a stricter state weight applies with its reason, and the plan locks', async ($: any, on: any) => {
  const { signOff, running } = await session($, on)
  await signOff()
  expect(said(await $.tool.call(plan({ weight: 'thorough', weightWhy: 'rewrites saved data' })))).toMatch(/Locked "P"/)
  const st = running().plan!.states[0]!
  expect(st).toMatchObject({ weight: 'thorough', weightWhy: 'rewrites saved data' })
  expect(weightFor(running(), st)).toBe('thorough')
})

test('a looser state weight waits on the draft, and a lock with no answer keeps the plan\'s weight', async ($: any, on: any) => {
  const { signOff, running, drafted, sentinel } = await session($, on)
  await signOff()
  const r = said(await $.tool.call(plan({ weight: 'light', weightWhy: 'only text' })))
  expect(r).toMatch(/Draft saved/)
  expect(r).toMatch(/copy \(light\)/)
  expect(drafted().plan!.states[0]!.weightOk).toBeUndefined()
  expect(weightFor(drafted(), drafted().plan!.states[0]!)).toBe('standard')
  expect(await sentinel('lock')).toContain("plan's weight: copy (light)")
  await $.tool.call({ tool: TOOL, action: 'status' })
  expect(weightFor(running(), running().plan!.states[0]!)).toBe('standard')
  expect(startCheck(running())).toBe('npm test -- copy')
})

test('Claude can\'t answer for the user', async ($: any, on: any) => {
  const { signOff, drafted } = await session($, on)
  await signOff()
  const r = said(await $.tool.call(plan({ weight: 'light', weightWhy: 'only text', weightOk: true }, { settings: [{ name: 'failure-list', on: false, why: 'x', held: false }] })))
  expect(r).toMatch(/Draft saved/)
  expect(drafted().plan!.states[0]!.weightOk).toBeUndefined()
  expect(drafted().library!.on).toContain('failure-list')
  expect(drafted().library!.settings).toEqual([{ name: 'failure-list', on: false, why: 'x', held: true }])
})

test('what the user typed counts at once, with no second ask', async ($: any, on: any) => {
  const { signOff, typed, running } = await session($, on)
  await typed('Keep the copy state light since it only touches text')
  await signOff()
  expect(said(await $.tool.call(plan({ weight: 'light', weightQuote: 'Keep the copy state light' })))).toMatch(/Locked "P"/)
  const st = running().plan!.states[0]!
  expect(st).toMatchObject({ weight: 'light', weightQuote: 'Keep the copy state light', weightOk: true })
  expect(startCheck(running())).toBeUndefined()
})

test('a quote the user never typed is refused, whatever the plan says', async ($: any, on: any) => {
  const { signOff, eng } = await session($, on)
  await signOff()
  const r = await $.tool.call(plan({ weight: 'light', weightQuote: 'some words nobody ever typed here' }))
  expect(said(r)).toMatch(/isn't in what the user typed/)
  expect(eng.files[`${ROOT}/.sentinel/run.json`] ?? '').not.toContain('"copy"')
})

test('a quote for something looser has to name it, as any five words would otherwise unlock it', async ($: any, on: any) => {
  const msg = 'Take card payments and handle refunds'
  expect(checkSetting(msg, 'Take card payments and handle', 'light', false)).toBe('unnamed')
  expect(checkSetting(msg, msg, 'light', false)).toBe('unnamed')
  expect(checkSetting(msg, 'Take card payments and handle', 'failure-list', false)).toBe('unnamed')
  expect(checkSetting('Keep the copy state light', 'Keep the copy state light', 'light', false)).toBe('ok')
  // Five words about anything still count for what is stricter, which needs no answer.
  expect(checkSetting(msg, 'Take card payments and handle', 'thorough', true)).toBe('ok')
  const { typed, signOff } = await session($, on)
  await typed(msg)
  await signOff()
  const r = await $.tool.call(plan({ weight: 'light', weightQuote: 'Take card payments and handle' }))
  expect(said(r)).toMatch(/doesn't name light/)
  expect(said(r)).not.toMatch(/Locked/)
  const set = await $.tool.call(plan({}, { settings: [{ name: 'failure-list', on: false, quote: 'Take card payments and handle' }] }))
  expect(said(set)).toMatch(/doesn't name failure-list/)
})

test('a short quote: a name and one more word for what is stricter, five words for what is looser', () => {
  const msg = "don't go light on this, make export thorough please, and use the failure-list, don't skip failure-list"
  expect(checkSetting(msg, 'go light', 'light', false)).toBe('short')
  expect(checkSetting(msg, "don't go light on this", 'light', false)).toBe('ok')
  expect(checkSetting(msg, 'export thorough', 'thorough', true)).toBe('ok')
  expect(checkSetting(msg, 'export', 'thorough', true)).toBe('short')
  expect(checkSetting(msg, 'thorough', 'thorough', true)).toBe('short')
  expect(checkSetting(msg, 'make export', 'thorough', true)).toBe('short')
  expect(checkSetting(msg, 'skip failure-list', 'failure-list', false)).toBe('short')
  expect(checkSetting(msg, 'the failure-list', 'failure-list', true)).toBe('ok')
  expect(checkSetting(msg, 'the failure list', 'failure-list', true)).toBe('missing')
  expect(checkSetting('use the failure list', 'the failure list', 'failure-list', true)).toBe('ok')
  expect(checkSetting('use the failure list', 'failure list', 'failure-list', true)).toBe('short')
  expect(checkSetting(msg, 'export thorough', 'light', true)).toBe('short')
  // A whole message is the user's, however short.
  expect(checkSetting('go light', 'go light', 'light', false)).toBe('ok')
})

// A plan on Light, with break-it-once off by hand and a told instruction that only covers api/**.
const LIB: PlanLibrary = {
  weight: 'light', on: ['fast-checks', 'quote-the-source', STATE_SETTINGS, 'api-notes'],
  told: [{ name: 'fast-checks', at: 'draft', text: 'f' }, { name: 'api-notes', at: 'start', files: ['api/**'], text: 'n' }],
  states: {
    hand: { [STATE_SETTINGS]: true, 'break-it-once': false },
    weights: { 'fast-checks': ['light', 'standard', 'thorough'], 'failure-list': ['standard', 'thorough'], 'fails-first': ['standard', 'thorough'], 'break-it-once': ['standard', 'thorough'], 'fails-without-change': ['thorough'] },
    spare: [{ name: 'failure-list', at: 'start', text: 'l' }],
  },
}
const adding = (adds: unknown, files = ['src/**']) => settledStates({ action: 'define', states: [{ id: 'a', label: 'A', files, adds: adds as any }] }, LIB, [])

test('what a state can add', () => {
  const ok = (adds: unknown, files?: string[]) => {
    const got = adding(adds, files)
    if (typeof got === 'string') throw new Error(got)
    return got.states![0]!.adds
  }
  // Off because of the weight doesn't count as off by hand.
  expect(ok([{ name: 'failure-list', why: 'money' }])).toEqual([{ name: 'failure-list', why: 'money' }])
  expect(ok([{ name: 'fails-first', why: 'money' }, { name: 'fails-without-change', why: 'data' }])).toHaveLength(2)
  expect(ok([{ name: 'api-notes', why: 'x' }], ['api/**'])).toHaveLength(1)
  expect(ok([{ name: 'failure-list', why: 'one' }, { name: 'failure-list', why: 'two' }])).toEqual([{ name: 'failure-list', why: 'two' }])
  expect(adding([{ name: 'nope', why: 'x' }])).toMatch(/nope can't be added to a.*failure-list/)
  expect(adding([{ name: 'prove-end-to-end', why: 'x' }])).toMatch(/can't be added/)
  expect(adding([{ name: 'fast-checks', why: 'x' }])).toMatch(/can't be added/)
  expect(adding([{ name: 'quote-the-source', why: 'x' }])).toMatch(/can't be added/)
  expect(adding([{ name: 'break-it-once', why: 'x' }])).toMatch(/switched break-it-once off/)
  expect(adding([{ name: 'failure-list' }])).toMatch(/one-line why/)
  expect(adding([{ why: 'x' }])).toMatch(/needs a name/)
  expect(adding('failure-list')).toMatch(/a list/)
  expect(adding([{ name: 'api-notes', why: 'x' }])).toMatch(/api-notes covers api\/\*\*.*a edits none/)
  expect(adding([{ name: 'failure-list', why: 'x' }], [])).toMatch(/a edits no files/)
})

test('a state\'s weight has to be one, and has to say why', () => {
  const one = (more: object) => settledStates({ action: 'define', states: [{ id: 'a', label: 'A', files: ['src/**'], ...more }] }, LIB, ['make this thorough please'])
  expect(one({ weight: 'heavy', weightWhy: 'x' })).toMatch(/light, standard or thorough/)
  expect(one({ weight: 'thorough' })).toMatch(/weightWhy/)
  expect(one({ weight: 'thorough', weightWhy: '  ' })).toMatch(/weightWhy/)
  expect((one({ weight: 'thorough', weightQuote: 'this thorough' }) as PlanInput).states![0]).toMatchObject({ weightOk: true })
  expect(one({ weight: 'thorough', weightQuote: 'this' })).toMatch(/too short/)
})

const ITEMS = [...BUILTINS, { name: 'mine', at: 'start', text: 'm' }, { name: 'cloned', at: 'start', text: 'c', trusted: false }] as any[]
const STD = { ...LIB, weight: 'standard' as const, on: ['fast-checks', 'failure-list', 'fails-first', STATE_SETTINGS] }
const setting = (x: unknown, typed: string[] = []) => planSettings(STD, x, ITEMS, typed)

test('what a plan\'s settings can name', () => {
  expect(setting('thorough')).toMatch(/a list/)
  expect(setting([{ why: 'x' }])).toMatch(/weight.*name/)
  expect(setting([{ weight: 'heavy', why: 'x' }])).toMatch(/light, standard or thorough/)
  expect(setting([{ weight: 'thorough' }])).toMatch(/"why".*"quote"/)
  expect(setting([{ name: 'nope', on: true, why: 'x' }])).toMatch(/no instruction "nope"/)
  expect(setting([{ name: 'cloned', on: true, why: 'x' }])).toMatch(/no instruction "cloned"/)
  expect(setting([{ name: STATE_SETTINGS, on: false, why: 'x' }])).toMatch(/Only the user/)
  expect(setting([{ name: 'mine', why: 'x' }])).toMatch(/"on"/)
  expect(setting([{ weight: 'thorough', quote: 'not typed at all' }])).toMatch(/isn't in what the user typed/)
})

test('a plan\'s settings: stricter applies, looser waits, and the user\'s words apply', () => {
  const up = setting([{ weight: 'thorough', why: 'money' }])
  expect(up).toMatchObject({ weight: 'thorough', settings: [{ weight: 'thorough', why: 'money' }] })
  expect((up as any).on).toContain('prove-end-to-end')
  expect((up as any).on).toContain('fails-without-change')
  // A hand switch stays where it is, and what no weight lists stays off.
  expect((up as any).on).not.toContain('break-it-once')
  expect((up as any).on).not.toContain('sources-first')
  const down = setting([{ weight: 'light', why: 'small' }])
  expect(down).toMatchObject({ weight: 'standard', settings: [{ weight: 'light', why: 'small', held: true }] })
  expect((down as any).on).toContain('failure-list')
  const said1 = setting([{ weight: 'light', quote: 'please keep this one light' }], ['please keep this one light'])
  expect(said1).toMatchObject({ weight: 'light' })
  expect((said1 as any).settings[0].held).toBeUndefined()
  expect((said1 as any).on).not.toContain('failure-list')
  expect(setting([{ weight: 'light', quote: 'go light' }], ["don't go light"])).toMatch(/too short/)
  expect((setting([{ name: 'sources-first', on: true, why: 'a TRD exists' }]) as any).on).toContain('sources-first')
  const off = setting([{ name: 'failure-list', on: false, why: 'x' }])
  expect((off as any).on).toContain('failure-list')
  expect((off as any).settings[0].held).toBe(true)
  const offSaid = setting([{ name: 'failure-list', on: false, quote: 'drop the failure-list on this plan' }], ['drop the failure-list on this plan'])
  expect((offSaid as any).on).not.toContain('failure-list')
  // Turned off by hand: Claude's reason can't bring it back, the user's own words can.
  expect(setting([{ name: 'break-it-once', on: true, why: 'x' }])).toMatch(/switched break-it-once off/)
  expect((setting([{ name: 'break-it-once', on: true, quote: 'use break-it-once here' }], ['use break-it-once here']) as any).on).toContain('break-it-once')
})

test('a setting applies once: another setting doesn\'t bring it back over the user\'s pick', () => {
  const lib = { weight: 'standard', on: ['failure-list', 'fails-first'], told: [], states: { hand: {}, weights: {}, spare: [] }, settings: [{ weight: 'light', quote: 'please keep this one light' }] } as PlanLibrary
  const got = planSettings(lib, [{ name: 'sources-first', on: true, why: 'a TRD exists' }], ITEMS, []) as any
  expect(got.weight).toBe('standard')
  expect(got.on).toContain('fails-first')
  expect(got.on).toContain('sources-first')
  // The same setting sent again changes nothing. A different one does.
  expect((planSettings(lib, [{ weight: 'light', quote: 'please keep this one light' }], ITEMS, ['please keep this one light']) as any).weight).toBe('standard')
  expect((planSettings(lib, [{ weight: 'thorough', why: 'money' }], ITEMS, []) as any).weight).toBe('thorough')
})

test('a stricter weight from Claude leaves what the user flipped on the draft as they left it', () => {
  // At Standard the user unticked fails-first and ticked sources-first.
  const lib = { weight: 'standard', on: ['failure-list', 'sources-first'], told: [], states: { hand: {}, weights: {}, spare: [] } } as PlanLibrary
  const got = planSettings(lib, [{ weight: 'thorough', why: 'money' }], ITEMS, []) as any
  expect(got.on).toContain('sources-first')
  expect(got.on).not.toContain('fails-first')
  expect(got.on).toContain('fails-without-change')
})

test('settings reach this plan only, and the plan runs by them', async ($: any, on: any) => {
  const { signOff, running, eng } = await session($, on)
  const before = eng.files[FILE]
  await signOff()
  expect(said(await $.tool.call(plan({}, { settings: [{ weight: 'thorough', why: 'handles money' }] })))).toMatch(/Locked "P"/)
  const l = running().library!
  expect(l.weight).toBe('thorough')
  expect(l.told.map(x => x.name)).toContain('prove-end-to-end')
  expect(l.states!.spare.map(x => x.name)).not.toContain('failure-list')
  expect(l.settings).toEqual([{ weight: 'thorough', why: 'handles money' }])
  expect(eng.files[FILE]).toBe(before)
  expect((await $.tool.call({ tool: TOOL, action: 'status' })).deny).toBeUndefined()
})

test('a looser plan setting waits on the draft, and an unanswered one never applies', async ($: any, on: any) => {
  const { signOff, drafted, running, sentinel } = await session($, on)
  await signOff()
  const r = said(await $.tool.call(plan({}, { settings: [{ weight: 'light', why: 'small' }] })))
  expect(r).toMatch(/Draft saved/)
  expect(r).toMatch(/plan weight light/)
  expect(drafted().library!.weight).toBe('standard')
  expect(await sentinel('lock')).toMatch(/plan weight light/)
  await $.tool.call({ tool: TOOL, action: 'status' })
  expect(running().library!.weight).toBe('standard')
  expect(running().library!.on).toContain('failure-list')
})

test('a revise keeps settings it doesn\'t name and replaces those it does', async ($: any, on: any) => {
  const { sentinel, drafted } = await session($, on)
  await sentinel('lock')
  await $.tool.call(plan({ weight: 'light', weightWhy: 'only text' }, { settings: [{ weight: 'thorough', why: 'money' }, { name: 'sources-first', on: false, why: 'x' }] }))
  expect(drafted().library!.weight).toBe('thorough')
  const r = await $.tool.call({ tool: TOOL, action: 'revise', order: ['copy', 'form'], settings: [{ name: 'sources-first', on: true, why: 'a TRD exists' }] })
  expect(r.deny).toBeUndefined()
  expect(drafted().library!.settings).toEqual([{ weight: 'thorough', why: 'money' }, { name: 'sources-first', on: true, why: 'a TRD exists' }])
  expect(drafted().library!.on).toContain('sources-first')
  expect(drafted().library!.on).toContain('prove-end-to-end')
  expect(drafted().plan!.states[0]!.weight).toBe('light')
})

test('with the switch on, a revise that sends no settings changes none', async ($: any, on: any) => {
  const { sentinel, drafted } = await session($, on)
  await sentinel('lock')
  await $.tool.call(plan({}, { settings: [{ weight: 'thorough', why: 'money' }] }))
  await $.tool.call({ tool: TOOL, action: 'revise', order: ['copy', 'form'], states: [{ ...COPY, label: 'New copy' }] })
  expect(drafted().library!.weight).toBe('thorough')
  expect(drafted().plan!.states[0]!.label).toBe('New copy')
})

test('a define sent before the sign-off is checked at the sign-off, against what the user typed by then', async ($: any, on: any) => {
  const { typed, sentinel, drafted } = await session($, on)
  const r = await $.tool.call(plan({ weight: 'light', weightQuote: 'Keep the copy state light' }, { settings: [{ weight: 'thorough', why: 'money' }] }))
  expect(said(r)).toMatch(/No sign-off yet/)
  await typed('Keep the copy state light, go')
  await sentinel('lock')
  expect(drafted().plan!.states[0]!.weightOk).toBe(true)
  expect(drafted().library!.weight).toBe('thorough')
})

// The draft as define leaves it, for the answers a re-define has to keep.
const LOOSER: PlanInput = { action: 'define', title: 'P', library: STD, states: [{ ...COPY, weight: 'light', weightWhy: 'only text' }, FORM] }
const draftOf = (i: PlanInput = LOOSER) => act({ ...emptyRun(), signedOff: true, review: true }, i, '09:00').run
const answered = (r: Run): Run => ({ ...r, draft: { ...r.draft!, plan: { ...r.draft!.plan!, states: r.draft!.plan!.states.map(s => (s.id === 'copy' ? { ...s, weightOk: true } : s)) } } })

test('an answer stands while the setting stays the same', () => {
  const again = (i: PlanInput) => act(answered(draftOf()), i, '09:01').run.draft!.plan!.states[0]!
  expect(again(LOOSER).weightOk).toBe(true)
  expect(again({ ...LOOSER, states: [{ ...COPY, weight: 'light', weightWhy: 'another reason' }, FORM] }).weightOk).toBeUndefined()
  expect(again({ ...LOOSER, states: [{ ...COPY, weight: 'standard', weightWhy: 'only text' }, FORM] }).weightOk).toBeUndefined()
})

const ASK = 'Please build the copy and the form'
const quoted = { tool: TOOL, action: 'define', title: 'P', states: [{ ...COPY, asked: [ASK] }, { ...FORM, asked: [ASK] }] }

test('going hands-free lets the lighter weights through, lists each, and leaves the rest', async ($: any, on: any) => {
  const { signOff, running, sentinel } = await session($, on)
  await signOff()
  const sent = await $.tool.call(plan({}, { states: [{ ...COPY, weight: 'light', weightWhy: 'only text' }, { ...FORM, weight: 'thorough', weightWhy: 'money' }] }))
  expect(said(sent)).toMatch(/wait for the user's answer/)
  // Locked with it unanswered, it stands at the plan's weight until the user goes hands-free.
  // The file is written once a tool call returns, so each command is followed by one.
  const typedThen = async (args: string) => {
    await sentinel(args)
    await $.tool.call({ tool: TOOL, action: 'status' })
  }
  await typedThen('lock')
  const copy = () => running().plan!.states[0]!
  expect(weightFor(running(), copy())).toBe('standard')
  await typedThen('hands-free')
  expect(weightFor(running(), copy())).toBe('light')
  expect(running().plan!.states[1]!.weightOk).toBeUndefined()
  const listed = () => running().audit.filter(a => a.kind === 'decided' && /hands-free/.test(a.text)).map(a => [a.state, a.text])
  expect(listed()).toEqual([['copy', 'Went light hands-free: only text']])
  // Taking hands-free back keeps what Claude chose, and a second time lists nothing new.
  await typedThen('hands-free off')
  expect(weightFor(running(), copy())).toBe('light')
  await typedThen('hands-free')
  expect(listed()).toHaveLength(1)
})

test('going hands-free leaves a state that is done alone', () => {
  const library = { weight: 'standard', on: [], told: [], states: { hand: {}, weights: {}, spare: [] } } as PlanLibrary
  const states = [{ ...COPY, weight: 'light' as const, weightWhy: 'old' }, { ...FORM, weight: 'light' as const, weightWhy: 'new' }]
  const r: Run = { ...emptyRun(), plan: { title: 'P', states, loops: [], lockedAt: '09:00' }, active: 'form', library }
  const out = handsFree(r, true, '09:01')
  expect(out.plan!.states.map(s => !!s.weightOk)).toEqual([false, true])
  expect(out.audit.filter(a => /hands-free/.test(a.text)).map(a => a.state)).toEqual(['form'])
  // Going off lets nothing through.
  expect(handsFree({ ...r, handsFree: true }, false, '09:01').plan!.states.some(s => s.weightOk)).toBe(false)
  // A run with the switch off has nothing to let through.
  const off = { ...r, library: { ...library, states: undefined } }
  expect(handsFree(off, true, '09:01').audit).toEqual(off.audit)
})

test('hands-free, a state added mid-run can be lighter too, and it is listed', async ($: any, on: any) => {
  const { signOff, running, eng, typed, sentinel } = await session($, on)
  eng.quoting()
  await typed(ASK)
  await signOff()
  await $.tool.call(quoted)
  await sentinel('hands-free')
  await $.tool.call({ tool: TOOL, action: 'status' })
  const r = await $.tool.call({ tool: TOOL, action: 'revise', order: ['copy', 'form', 'extra'], states: [{ id: 'extra', label: 'Extra', files: ['extra/**'], added: 'r', weight: 'light', weightWhy: 'only a note' }] })
  expect(r.deny).toBeUndefined()
  expect(weightFor(running(), running().plan!.states.find(s => s.id === 'extra')!)).toBe('light')
  expect(running().audit.some(a => a.kind === 'decided' && a.state === 'extra' && a.text === 'Went light hands-free: only a note')).toBe(true)
})

test('a state added mid-run takes the plan\'s weight unless it names a stricter one, and never stops', async ($: any, on: any) => {
  const { signOff, running, eng, typed } = await session($, on)
  eng.quoting()
  await typed(ASK)
  await signOff()
  await $.tool.call(quoted)
  const add = (id: string, weight: string) => $.tool.call({ tool: TOOL, action: 'revise', order: ['copy', 'form', 'extra', 'more'].filter(x => x !== 'more' || id === 'more'), states: id === 'more' ? [{ id: 'more', label: 'More', files: ['more/**'], added: 'r', weight, weightWhy: 'r' }] : [{ id: 'extra', label: 'E', files: ['extra/**'], added: 'r', weight, weightWhy: 'r' }] })
  expect((await add('extra', 'light')).deny).toBeUndefined()
  const light = running().plan!.states.find(s => s.id === 'extra')!
  expect(weightFor(running(), light)).toBe('standard')
  expect(running().active).toBe('copy')
  // What it sends is checked as it is on a draft.
  expect(said(await add('more', 'heavy'))).toMatch(/light, standard or thorough/)
  expect((await add('more', 'thorough')).deny).toBeUndefined()
  expect(weightFor(running(), running().plan!.states.find(s => s.id === 'more')!)).toBe('thorough')
})

test('settings can\'t change a plan that runs', async ($: any, on: any) => {
  const { signOff, eng, typed } = await session($, on)
  eng.quoting()
  await typed(ASK)
  await signOff()
  await $.tool.call(quoted)
  const r = await $.tool.call({ tool: TOOL, action: 'revise', order: ['copy', 'form', 'x'], states: [{ id: 'x', label: 'X', added: 'r' }], settings: [{ weight: 'thorough', why: 'x' }] })
  expect(said(r)).toMatch(/"settings" can't change/)
})

test('with the switch off the page still gets the plan\'s weight and each state\'s', async ($: any, on: any) => {
  const { signOff, eng } = await session($, on, null)
  await signOff()
  await $.tool.call(plan())
  const v = eng.snap()
  expect(v.planWeight).toBe('standard')
  expect(v.states.map((s: any) => s.weightNow)).toEqual(['standard', 'standard', undefined])
  expect(v.settingRows).toBeUndefined()
})

test('a skip names the instruction, and only one told at that state can be skipped there', async ($: any, on: any) => {
  const { signOff, running, eng } = await session($, on)
  await signOff()
  await $.tool.call(plan())
  const skip = async (o: object) => said(await $.tool.call({ tool: TOOL, action: 'decide', ...o }))
  expect(await skip({ skip: 'failure-list' })).toMatch(/one-line why/)
  const no = await skip({ skip: 'fails-without-change', reason: 'r' })
  expect(no).toMatch(/copy wasn't told fails-without-change/)
  expect(no).toMatch(/These can: failure-list, break-it-once/)
  expect(await skip({ skip: 'failure-list', to: 'nope', reason: 'r' })).toMatch(/no state "nope"/)
  expect(await skip({ skip: 'failure-list', reason: 'the copy has no failures to list' })).toMatch(/Recorded/)
  // A member's state, recorded by the main conversation from its report.
  expect(await skip({ skip: 'break-it-once', to: 'form', reason: 'its member said so' })).toMatch(/Recorded/)
  const st = (id: string) => eng.snap().states.find((s: any) => s.id === id)
  expect(st('copy').skips).toEqual([{ name: 'failure-list', why: 'the copy has no failures to list' }])
  expect(st('form').skips).toEqual([{ name: 'break-it-once', why: 'its member said so' }])
  // The run as it is now: run.json is written after the snapshot.
  expect(eng.memory.run!.audit.at(-1)).toMatchObject({ kind: 'decided', by: 'claude', state: 'form', skip: { name: 'break-it-once' } })
  // A plain decision is no skip.
  await skip({ topic: 'naming', choice: 'kebab' })
  expect(st('copy').skips).toHaveLength(1)
})

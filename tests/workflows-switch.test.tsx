// The Library's second experimental switch, "Workflows in a step", and the workflow field on a plan's states.
// Run with `node tests/only.mjs workflows-switch`.
//
// How this can fail, and where each is tested below:
//  1. With the switch off the field stays in the plan, or the plan is refused, or Claude isn't told it went.
//  2. With the switch on the field is lost, or its model's case or its reason's length isn't cleaned up.
//  3. A step with a workflow also lists files, so its agents could edit what the step claims only to read.
//  4. A bad shape goes through: no agents, a count out of 1 to 50 or a fraction, an unknown model, no reason, a non-object.
//  5. Claude sends ok, which only Sentinel sets when the user presses Keep, and the plan carries it.
//  6. A revise of a running plan adds, changes or removes a workflow, though it is set at the lock.
//  7. Something no weight sets turns the switch on, or a weight picked in one place switches it off in another.
//  8. A change on the draft's cards flips the switch, either way.
//  9. Claude turns the switch on with the library action, or hears of the switch in the list of items it may flip.
// 10. The told text reaches Claude with the switch off, or doesn't with it on.
// 11. The per-state settings switch breaks beside it (its own tests are in lib-settings and lib-page).
import { expect, mock } from 'claude-code/testing'
import { WORKFLOWS, STATE_SETTINGS, handOf, libraryOn, withWeight } from '../hooks/core'
import { BUILTINS } from '../hooks/builtins'
import type { Run } from '../types'
import { ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const FILE = `${ROOT}/.sentinel/library.json`
const WF = { agents: 8, model: 'sonnet', why: 'Eight reports can be read alone, and it takes about two hours.' }
const SCAN = { id: 'scan', label: 'Scan', check: 'npm test -- scan', files: [] as string[], workflow: WF }
const FORM = { id: 'form', label: 'Form', check: 'npm test -- form', files: ['src/**'] }
const plan = (scan: object = {}, more: object = {}) => ({ tool: TOOL, action: 'define', title: 'P', states: [{ ...SCAN, ...scan }, FORM], ...more })

// sw: the switches file as the project has it. Left out, both experimental switches are on; null, there is no file.
async function session($: any, on: any, sw?: object | null) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  if (sw !== null) eng.files[FILE] = JSON.stringify(sw ?? { on: { [STATE_SETTINGS]: true, [WORKFLOWS]: true } })
  return {
    eng, clock,
    signOff: () => $.tool.call({ tool: 'ExitPlanMode' }),
    lock: () => $.command.run({ command: 'sentinel', args: 'lock' }),
    running: () => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run,
    drafted: () => (JSON.parse(eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}') as Run).draft!,
    library: (command: string, quote?: string) => $.tool.call({ tool: TOOL, action: 'library', command, ...(quote !== undefined ? { quote } : {}) }),
  }
}

test('with the switch off the field goes, the plan locks, and the reply says so once', async ($: any, on: any) => {
  const { signOff, running } = await session($, on, null)
  await signOff()
  const r = await $.tool.call(plan({ files: ['docs/**'] }))
  expect(said(r)).toMatch(/Locked "P"/)
  expect((r.context ?? []).filter((c: string) => /workflows switch is off/.test(c))).toHaveLength(1)
  expect('workflow' in running().plan!.states[0]!).toBe(false)
})

test('with the switch off a plan with no workflow hears nothing of it', async ($: any, on: any) => {
  const { signOff } = await session($, on, null)
  await signOff()
  const r = await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [FORM] })
  expect([said(r), ...(r.context ?? [])].join()).not.toMatch(/workflow/i)
})

test('with only the per-state switch on, the workflow still goes and the settings stay', async ($: any, on: any) => {
  const { signOff, running } = await session($, on, { on: { [STATE_SETTINGS]: true } })
  await signOff()
  const r = await $.tool.call(plan({}, { settings: [{ weight: 'thorough', why: 'money' }] }))
  expect(said(r)).toMatch(/Locked "P"/)
  expect((r.context ?? []).join()).toMatch(/workflows switch is off/)
  expect((r.context ?? []).join()).not.toMatch(/per-state settings are off/)
  expect('workflow' in running().plan!.states[0]!).toBe(false)
  expect(running().library!.settings).toEqual([{ weight: 'thorough', why: 'money' }])
})

test('with both switches off one reply carries both notes', async ($: any, on: any) => {
  const { signOff } = await session($, on, null)
  await signOff()
  const r = await $.tool.call(plan({ weight: 'light', weightWhy: 'x' }))
  const said1 = (r.context ?? []).join('\n')
  expect(said1).toMatch(/per-state settings are off/)
  expect(said1).toMatch(/workflows switch is off/)
})

test('with the switch on the field is kept, the model is lowercased and the reason is clipped', async ($: any, on: any) => {
  const { signOff, drafted } = await session($, on)
  await signOff()
  const why = 'x'.repeat(300)
  const r = await $.tool.call(plan({ workflow: { agents: 3, model: 'SONNET', why } }))
  // A workflow waits for the user's Keep, so even a plan-mode sign-off drafts (workflows-draft tests the rest).
  expect(said(r)).toMatch(/Draft saved/)
  const wf = drafted().plan!.states[0]!.workflow!
  expect(wf).toMatchObject({ agents: 3, model: 'sonnet' })
  expect(wf.why).toHaveLength(200)
  expect('ok' in wf).toBe(false)
})

test('with the switch on and nothing sent, no state has a workflow', async ($: any, on: any) => {
  const { signOff, running } = await session($, on)
  await signOff()
  expect(said(await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [FORM] }))).toMatch(/Locked "P"/)
  expect('workflow' in running().plan!.states[0]!).toBe(false)
})

test('a step with a workflow and files is refused, and says what to send instead', async ($: any, on: any) => {
  const { signOff, running } = await session($, on)
  await signOff()
  const r = said(await $.tool.call(plan({ files: ['src/**'] })))
  expect(r).toMatch(/A step with a workflow lists no files: its agents only read\./)
  expect(r).not.toMatch(/Locked/)
  expect(running().plan).toBeUndefined()
})

test('a workflow of the wrong shape is refused, whichever part is wrong', async ($: any, on: any) => {
  const { signOff, running } = await session($, on)
  await signOff()
  const bad: [string, unknown, RegExp][] = [
    ['no agents', { model: 'haiku', why: 'x' }, /agents/],
    ['zero agents', { ...WF, agents: 0 }, /agents/],
    ['51 agents', { ...WF, agents: 51 }, /agents/],
    ['a fraction', { ...WF, agents: 2.5 }, /agents/],
    ['a string count', { ...WF, agents: '5' }, /agents/],
    ['no model', { agents: 3, why: 'x' }, /model/],
    ['an unknown model', { ...WF, model: 'gpt' }, /model/],
    ['no reason', { agents: 3, model: 'haiku' }, /why/],
    ['a blank reason', { agents: 3, model: 'haiku', why: '   ' }, /why/],
    ['a string', 'five agents on sonnet', /workflow/],
    ['a list', [WF], /workflow/],
    ['null', null, /workflow/],
  ]
  for (const [name, workflow, say] of bad) {
    const r = said(await $.tool.call(plan({ workflow })))
    expect(`${name}: ${r}`).toMatch(say)
    expect(`${name}: ${r}`).not.toMatch(/Locked/)
  }
  expect(running().plan).toBeUndefined()
  // The edges of a good one still go through, to a draft.
  expect(said(await $.tool.call(plan({ workflow: { agents: 1, model: 'haiku', why: 'x' } })))).toMatch(/Draft saved/)
})

test('ok sent by Claude is dropped, as only Sentinel sets it', async ($: any, on: any) => {
  const { signOff, drafted } = await session($, on)
  await signOff()
  expect(said(await $.tool.call(plan({ workflow: { ...WF, ok: true } })))).toMatch(/Draft saved/)
  expect(drafted().plan!.states[0]!.workflow).toEqual({ agents: 8, model: 'sonnet', why: WF.why })
})

test('a revise on the draft keeps the field with the switch on and drops it with the switch off', async ($: any, on: any) => {
  const a = await session($, on)
  await a.lock()
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [FORM, { id: 'next', label: 'Next', check: 'true', files: ['n/**'] }] })
  await until(a.clock, () => a.drafted()?.plan)
  const r = await $.tool.call({ tool: TOOL, action: 'revise', order: ['scan', 'form', 'next'], states: [SCAN, FORM, { id: 'next', label: 'Next', check: 'true', files: ['n/**'] }] })
  expect(said(r)).not.toMatch(/switch is off|lists no files/)
  expect(a.drafted().plan!.states[0]!.workflow).toMatchObject({ agents: 8 })
})

test('a revise of a running plan can\'t add, change or remove a workflow', async ($: any, on: any) => {
  const { eng, clock, signOff, running, drafted, lock } = await session($, on)
  await signOff()
  await openPage($, clock)
  expect(said(await $.tool.call(plan()))).toMatch(/Draft saved/)
  await until(clock, () => eng.snap().draftKey)
  eng.page({ kind: 'wfrow', draft: eng.snap().draftKey, state: 'scan', keep: true })
  await until(clock, () => drafted().plan!.states[0]!.workflow!.ok)
  expect(said(await lock())).toMatch(/Locked "P"/)
  await until(clock, () => running().plan?.lockedAt)
  const fixed = /A step's workflow is set when the plan locks: the user approves it on the draft\./
  const next = { id: 'next', label: 'Next', check: 'true', files: [] as string[], added: 'a reason for it' }
  const order = ['scan', 'form', 'next']
  const revise = (states: object[]) => $.tool.call({ tool: TOOL, action: 'revise', order, states })
  // A new step with one, a step Claude says has a different one, and a step sent without the one it has.
  expect(said(await revise([{ ...next, workflow: WF }]))).toMatch(fixed)
  expect(said(await revise([{ ...SCAN, workflow: { ...WF, agents: 9 } }]))).toMatch(fixed)
  expect(said(await revise([{ ...FORM, workflow: WF }]))).toMatch(fixed)
  expect(said(await revise([{ ...SCAN, workflow: undefined }]))).toMatch(fixed)
  expect(running().plan!.states[0]!.workflow).toMatchObject({ agents: 8 })
  // The same workflow sent again, and a new step with none, aren't changes to a workflow.
  expect(said(await revise([{ ...SCAN }]))).not.toMatch(fixed)
  expect(said(await revise([next]))).not.toMatch(fixed)
})

test('a revise of a running plan with the switch off drops the field and adds the step, with the note', async ($: any, on: any) => {
  const { signOff, running } = await session($, on, { on: { 'quote-the-source': true } })
  await $.prompt.submit({ text: 'Build the form step for this plan', origin: { kind: 'composer' } })
  await signOff()
  expect(said(await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [{ ...FORM, asked: ['Build the form step for this plan'] }] }))).toMatch(/Locked/)
  const next = { id: 'next', label: 'Next', check: 'true', files: [], added: 'a reason', workflow: WF }
  const r = await $.tool.call({ tool: TOOL, action: 'revise', order: ['form', 'next'], states: [next] })
  expect(said(r)).toMatch(/Added next/)
  expect((r.context ?? []).join()).toMatch(/workflows switch is off/)
  expect('workflow' in running().plan!.states[1]!).toBe(false)
})

test('no weight turns the switch on, and a switch set in one place survives a weight picked in another', () => {
  const item = BUILTINS.find(b => b.name === WORKFLOWS)!
  expect(item).toMatchObject({ weights: [], at: 'draft', kind: 'told', title: 'Workflows in a step' })
  for (const weight of ['light', 'standard', 'thorough'] as const) expect(libraryOn(BUILTINS, { weight }).on).not.toContain(WORKFLOWS)
  expect(libraryOn(BUILTINS).on).not.toContain(WORKFLOWS)
  // The user's switch in every project counts under this project's weight and a preset's.
  expect(libraryOn(BUILTINS, { weight: 'light' }, { on: { [WORKFLOWS]: true } }).on).toContain(WORKFLOWS)
  expect(libraryOn(BUILTINS, {}, { on: { [WORKFLOWS]: true } }, { weight: 'thorough' }).on).toContain(WORKFLOWS)
  expect(libraryOn(BUILTINS, { weight: 'light', on: { [WORKFLOWS]: false } }, { on: { [WORKFLOWS]: true } }).on).not.toContain(WORKFLOWS)
  expect(handOf(BUILTINS, { weight: 'light' }, { on: { [WORKFLOWS]: true } })).toEqual({ [WORKFLOWS]: true })
  // Picking a weight in the Library clears the built-ins' switches but not this one.
  const names = BUILTINS.map(b => b.name)
  expect(withWeight({ on: { [WORKFLOWS]: true, [STATE_SETTINGS]: true, 'fails-first': false } }, 'light', names)).toEqual({ weight: 'light', on: { [WORKFLOWS]: true, [STATE_SETTINGS]: true } })
})

test('the told text reaches Claude on the plan with the switch on, and not with it off', async ($: any, on: any) => {
  const a = await session($, on)
  await a.signOff()
  await $.tool.call(plan())
  const told = a.drafted().library!.told.find(t => t.name === WORKFLOWS)
  expect(told).toBeDefined()
  expect(told!.text).toMatch(/workflow/)
  expect(told!.text).toMatch(/lists no files/)
})

test('the told text is absent from a plan drafted with the switch off', async ($: any, on: any) => {
  const { signOff, running } = await session($, on, null)
  await signOff()
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [FORM] })
  expect(running().library!.told.some(t => t.name === WORKFLOWS)).toBe(false)
})

test('Claude can\'t turn the switch on or off with the library action', async ($: any, on: any) => {
  const { library } = await session($, on, null)
  for (const command of ['on state-workflows', 'off state-workflows', 'on state-workflows everywhere']) {
    expect(said(await library(command, 'please turn on state-workflows in this project'))).toMatch(/Only the user turns state-workflows on or off/)
  }
})

test('a change on the draft\'s cards leaves the workflows switch as it was drafted', async ($: any, on: any) => {
  const { eng, clock, lock, drafted } = await session($, on)
  await lock()
  await openPage($, clock)
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [SCAN, FORM] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  expect(drafted().library!.on).toContain(WORKFLOWS)
  const was = JSON.stringify(drafted())
  // The page's list leaves both switches out: neither is one of the draft's choices.
  eng.page({ kind: 'libplan', draft: eng.snap().draftKey, weight: 'thorough', on: ['failure-list'] })
  await until(clock, () => JSON.stringify(drafted()) !== was)
  expect(drafted().library!.on).toContain(WORKFLOWS)
  expect(drafted().library!.on).toContain(STATE_SETTINGS)
  expect(drafted().plan!.states[0]!.workflow).toMatchObject({ agents: 8 })
})

test('a page can\'t turn the workflows switch on for a draft that has it off', async ($: any, on: any) => {
  const { eng, clock, lock, drafted } = await session($, on, {})
  await lock()
  await openPage($, clock)
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [FORM] })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  const was = JSON.stringify(drafted())
  eng.page({ kind: 'libplan', draft: eng.snap().draftKey, weight: 'standard', on: ['failure-list', WORKFLOWS] })
  await until(clock, () => JSON.stringify(drafted()) !== was)
  expect(drafted().library!.on).not.toContain(WORKFLOWS)
})

// A step's workflow on the draft: its row with the estimate, Keep and Run it normally, and what the lock and the step's
// start say. Run with `node tests/only.mjs workflows-draft`.
//
// How this can fail, and where each is tested below:
//  1. The row is missing, or misses the estimate, with the per-state settings switch off (its rows need that switch).
//  2. A plan-mode sign-off locks a plan with a workflow at once, so nobody saw the estimate or pressed Keep.
//  3. Keep doesn't set ok, or a page answer from an older draft does.
//  4. Keep is lost when another answer on the draft replays it, or when a revise sends the same workflow again; or it
//     survives a revise that changes the workflow.
//  5. Run it normally leaves the workflow in, or takes the step out with it.
//  6. A lock, typed or hands-free, approves a workflow nobody kept; or it drops one that was kept.
//  7. The lock reply or the model's message doesn't say which workflows run and which don't.
//  8. The step's start doesn't carry the limits, the parallel() advice and the prompt line, or a step without an
//     approved workflow hears of one.
//  9. The share of the week shows without a weekly price, or doesn't with one.
import { expect, mock } from 'claude-code/testing'
import { WORKFLOWS, emptyRun, workflowRows } from '../hooks/core'
import type { Run } from '../types'
import { ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const FILE = `${ROOT}/.sentinel/library.json`
const WF = { agents: 8, model: 'sonnet', why: 'Eight reports can be read alone, and it takes about two hours.' }
const SCAN = { id: 'scan', label: 'Scan', check: 'npm test -- scan', files: [] as string[], workflow: WF }
const FORM = { id: 'form', label: 'Form', check: 'npm test -- form', files: ['src/**'] }
const define = (scan: object = {}) => ({ tool: TOOL, action: 'define', title: 'P', states: [{ ...SCAN, ...scan }, FORM] })

// Only the workflows switch is on: the per-state settings switch is off, as most users will have it.
async function session($: any, on: any) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  eng.files[FILE] = JSON.stringify({ on: { [WORKFLOWS]: true } })
  const drafted = () => (JSON.parse(eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}') as Run).draft!
  const running = () => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run
  const s = {
    eng, clock, drafted, running,
    lock: () => $.command.run({ command: 'sentinel', args: 'lock' }),
    // A draft from a typed /sentinel lock, with the page open.
    draft: async (scan: object = {}) => {
      await s.lock()
      await openPage($, clock)
      await $.tool.call(define(scan))
      await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
    },
    // An answer from the page, waited for until the draft changes.
    answer: async (m: object) => {
      const was = JSON.stringify(drafted())
      eng.page({ draft: eng.snap().draftKey, ...m })
      await until(clock, () => JSON.stringify(drafted()) !== was)
    },
    rows: () => eng.snap().workflowRows,
  }
  return s
}

test('the draft shows the workflow with its estimate, with the per-state settings switch off', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  expect(s.eng.snap().settingRows).toBeUndefined()
  expect(s.rows()).toEqual([{ state: 'scan', agents: 8, model: 'sonnet', why: WF.why, usd: '$12.80', upTo: '$24.80', kept: false }])
})

test('a plan-mode sign-off with a workflow drafts instead of locking, and says the workflow waits', async ($: any, on: any) => {
  const s = await session($, on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  const r = said(await $.tool.call(define()))
  expect(r).not.toMatch(/Locked/)
  expect(r).toMatch(/workflow on scan waits for the user's Keep/)
  expect(s.drafted().plan!.states[0]!.workflow).toEqual(WF)
  expect(s.running().plan).toBeUndefined()
})

test('Keep sets ok and the row shows it kept; an answer from an older draft does nothing', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  const old = s.eng.snap().draftKey
  await s.answer({ kind: 'wfrow', state: 'scan', keep: true })
  expect(s.drafted().plan!.states[0]!.workflow).toEqual({ ...WF, ok: true })
  await until(s.clock, () => s.rows()?.[0]?.kept)
  expect(s.rows()![0]!.kept).toBe(true)
  // Run it normally from a page that still shows the draft as it was before a revise.
  await $.tool.call({ tool: TOOL, action: 'revise', order: ['scan', 'form'], states: [{ ...SCAN, label: 'Scan the reports' }] })
  await until(s.clock, () => s.eng.snap().draftKey !== old)
  s.eng.page({ kind: 'wfrow', draft: old, state: 'scan', keep: false })
  await s.clock.advance(500)
  expect(s.drafted().plan!.states[0]!.workflow).toEqual({ ...WF, ok: true })
})

test('Keep survives another answer that replays the draft and a revise that sends the same workflow', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.answer({ kind: 'wfrow', state: 'scan', keep: true })
  // A change on the draft's cards replays it from what Claude sent.
  await s.answer({ kind: 'libplan', weight: 'thorough', on: ['failure-list'] })
  expect(s.drafted().plan!.states[0]!.workflow).toEqual({ ...WF, ok: true })
  await $.tool.call({ tool: TOOL, action: 'revise', order: ['scan', 'form'], states: [{ ...SCAN, label: 'Scan the reports' }] })
  await until(s.clock, () => s.drafted().plan!.states[0]!.label === 'Scan the reports')
  expect(s.drafted().plan!.states[0]!.workflow).toEqual({ ...WF, ok: true })
})

test('a revise that changes the workflow needs a new Keep', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.answer({ kind: 'wfrow', state: 'scan', keep: true })
  // Each changes one field from the one before it.
  const nine = { ...WF, agents: 9 }, opus = { ...nine, model: 'opus' }
  for (const workflow of [nine, opus, { ...opus, why: 'Another reason for the split.' }]) {
    await $.tool.call({ tool: TOOL, action: 'revise', order: ['scan', 'form'], states: [{ ...SCAN, workflow }] })
    await until(s.clock, () => JSON.stringify(s.drafted().plan!.states[0]!.workflow) === JSON.stringify(workflow))
    expect(s.drafted().plan!.states[0]!.workflow!.ok).toBeUndefined()
    await s.answer({ kind: 'wfrow', state: 'scan', keep: true })
  }
})

test('Run it normally drops the workflow and keeps the step', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.answer({ kind: 'wfrow', state: 'scan', keep: false })
  const st = s.drafted().plan!.states[0]!
  expect(st.id).toBe('scan')
  expect('workflow' in st).toBe(false)
  await until(s.clock, () => !s.rows()?.length)
  expect(s.rows() ?? []).toEqual([])
})

test('a typed lock runs a workflow nobody kept without it, and says so to both', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  const r = said(await s.lock())
  expect(r).toMatch(/Locked "P"/)
  expect(r).toMatch(/scan runs without its workflow: nobody pressed Keep\./)
  await until(s.clock, () => s.running().plan?.lockedAt)
  expect('workflow' in s.running().plan!.states[0]!).toBe(false)
  await until(s.clock, () => s.eng.submitted.some((t: string) => /locked "P"/.test(t)))
  expect(s.eng.submitted.find((t: string) => /locked "P"/.test(t))).toMatch(/scan runs without its workflow/)
})

test('Lock and go hands-free doesn\'t approve a workflow nobody kept', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  s.eng.page({ kind: 'lock', draft: s.eng.snap().draftKey, free: true })
  await until(s.clock, () => s.running().plan?.lockedAt)
  expect('workflow' in s.running().plan!.states[0]!).toBe(false)
  expect(s.running().handsFree).toBeTruthy()
})

test('a kept workflow locks with the plan, and the lock and the start say what it may do', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.answer({ kind: 'wfrow', state: 'scan', keep: true })
  const r = said(await s.lock())
  expect(r).toMatch(/scan runs its workflow: up to 8 agents on sonnet\./)
  await until(s.clock, () => s.running().plan?.lockedAt)
  expect(s.running().plan!.states[0]!.workflow).toEqual({ ...WF, ok: true })
  await until(s.clock, () => s.eng.submitted.some((t: string) => /locked "P"/.test(t)))
  expect(s.eng.submitted.find((t: string) => /locked "P"/.test(t))).toMatch(/scan runs its workflow: up to 8 agents on sonnet/)
  // The state's start, as status gives it.
  const start = said(await $.tool.call({ tool: TOOL, action: 'status' }))
  expect(start).toMatch(/the user approved a workflow for this step when they locked the plan: at most 8 agents in all, counting any rerun in this step, on sonnet/)
  expect(start).toMatch(/one that asks for a dearer model, or names none, runs on sonnet, and one past the 8th is refused/)
  expect(start).toMatch(/adds a line to each agent's prompt/)
  expect(start).toMatch(/inside parallel\(\) or pipeline\(\)/)
  expect(start).toMatch(/Workflow tool/)
})

test('a step without an approved workflow hears nothing of one at its start', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.lock()
  expect(said(await $.tool.call({ tool: TOOL, action: 'status' }))).not.toMatch(/workflow/i)
})

test('on a real draft the row shows the share of the week from a price another session kept', async ($: any, on: any) => {
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  const s = await session($, on)
  // $6 for 1% of the week, as another session measured it; this one reports a weekly window and its cost.
  s.eng.store['usage-prices'] = [{ usd: 18, points: 3, at: '2026-11-20T00:00:00.000Z' }]
  s.eng.setUsage({ rateLimits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-30T00:00:00.000Z' }], cost: { usd: 1 } })
  await s.lock()
  await openPage($, s.clock)
  // Claude's turn: a response, then the define.
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'opus', effort: 'high', messageCount: 1 })) { /* the chunks */ }
  await $.tool.call(define())
  await until(s.clock, () => s.rows()?.[0]?.share)
  expect(s.rows()![0]).toMatchObject({ usd: '$12.80', share: 'about 2.1%' })
})

// A terminal-only user answers in the band above the prompt; a typed lock alone would drop the workflow.
const BAND = { plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' } as const

test('the band asks about an unkept workflow with its estimate, and Keep there approves it', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: `Sentinel: Claude proposes a workflow on scan: up to 8 agents on sonnet, about $12.80 (up to $24.80), spend not capped. "${WF.why}"` })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Run it normally' })).toBeDefined()
  await ui.press({ key: 'keep' })
  await until(s.clock, () => s.drafted().plan!.states[0]!.workflow?.ok)
  // The band moves on to the draft's own line.
  const next = () => ui.find({ type: 'Text', text: /Check it, then lock it/ })
  for (let i = 0; i < 50 && !(await next()); i++) await s.clock.advance(1)
  expect(await next()).toBeDefined()
  await ui.unmount()
})

test('Run it normally in the band drops the workflow', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'takeout' })
  await until(s.clock, () => !('workflow' in s.drafted().plan!.states[0]!))
  await ui.unmount()
})

test('the share of the week shows with a weekly price, and not without one', () => {
  const draft = { ...emptyRun(), plan: { title: 'P', states: [{ ...SCAN, workflow: { ...WF, model: 'sonnet' as const } }, FORM], loops: [] } } as unknown as Run
  expect(workflowRows(draft)[0]).not.toHaveProperty('share')
  expect(workflowRows(draft, 6)[0]).toMatchObject({ usd: '$12.80', share: 'about 2.1%' })
  expect(workflowRows({ ...draft, plan: { ...draft.plan!, states: [FORM] } } as Run, 6)).toEqual([])
})

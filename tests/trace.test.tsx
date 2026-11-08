// The list of points on a draft: what the user asked for, each quoted, with the steps that deliver it or Claude's reason
// for leaving it out. Run with `node tests/only.mjs trace`.
//
// How this can fail, and where each is tested below:
//  1. A draft with no points is refused, or the snapshot leaves out the empty list the page reads.
//  2. A quote that is not in the user's words is accepted as a point, or its refusal doesn't name the point.
//  3. A point's quote from a typed message is refused, or the message isn't kept as a source afterwards.
//  4. A point with no steps and no reason, both, no quote, a step that isn't in the plan, or a list that isn't a list is
//     accepted, or the refusal doesn't name the point.
//  5. The quote check runs with Quote the source off, or the shape check stops running.
//  6. The points are lost, or kept as they were when the model sends new ones, on a revise.
//  7. A revise or a drop that takes steps out leaves a point naming a step that is gone, or keeps one with no steps.
//  8. The snapshot's draft leaves out the points as stored.
//  9. The band doesn't say how many points were left out, says it with none, or gets the plural wrong.
// 10. A running plan's points change on a revise.
import { expect, mock } from 'claude-code/testing'
import { dropStates } from '../hooks/core'
import type { PlanInput } from '../hooks/core'
import type { Run } from '../types'
import { ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const PAY = 'Members pay by card at checkout, and the card company tells us when a payment succeeds or fails.'
const REFUND = 'Partial refunds attach after the capture settles.'
const EXPORT = 'Staff can export a class roster to a sheet.'
const A = { id: 'pay', label: 'Payments', asked: [PAY] }
const B = { id: 'refund', label: 'Refunds', asked: [REFUND] }
const plan = { tool: TOOL, action: 'define', title: 'P', states: [A, B] }
const ORDER = ['pay', 'refund']
const BAND = { plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} }, surface: 'terminal' } as const

async function session($: any, on: any, { quoting = true } = {}) {
  const eng = engine(on)
  const clock = mock.clock(on)
  if (quoting) eng.quoting()
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  const sentinel = async (args: string) => said(await $.command.run({ command: 'sentinel', args }))
  const type = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } })
  const call = async (input: object) => said(await $.tool.call({ tool: TOOL, ...input }))
  const run = () => eng.memory.run as Run
  const band = async (text: RegExp) => {
    const ui = await $.ui.mount(BAND)
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found !== undefined
  }
  // The user signs off with /sentinel lock and types the words Claude will quote.
  const ready = async () => {
    await sentinel('lock')
    for (const t of [PAY, REFUND, EXPORT]) await type(t)
  }
  return { eng, clock, sentinel, type, call, run, band, ready }
}

const USER_POINT = { said: EXPORT, states: ['pay'] }

test('a draft with no points is saved, and the snapshot carries an empty list', async ($: any, on: any) => {
  const { eng, clock, call, ready, run } = await session($, on)
  await openPage($, clock)
  await ready()
  expect(await call(plan)).toMatch(/Draft saved/)
  expect(run().held!.points).toBeUndefined()
  await until(clock, () => eng.snap().phase === 'draft')
  expect(eng.snap().points).toEqual([])
})

test('a quote the user never wrote is refused by name, and a good one next to it is not', async ($: any, on: any) => {
  const { call, ready, run } = await session($, on)
  await ready()
  const got = await call({ ...plan, points: [USER_POINT, { said: 'Staff can export a class roster to a spreadsheet.', states: ['pay'] }, { said: 'Add a loyalty points scheme for members.', left: 'Out of scope.' }] })
  expect(got).toMatch(/- point 2: "Staff can export a class roster to a spreadsheet\." isn't in the sources, word for word\. Nearest: "Staff can export a class roster to a sheet\."/)
  expect(got).toMatch(/- point 3: "Add a loyalty points scheme for members\." isn't in the sources/)
  expect(got).not.toMatch(/point 1/)
  expect(run().draft).toBeUndefined()
  // Too short to count, and over the word limit, share the state quotes' texts.
  expect(await call({ ...plan, points: [{ said: 'Staff can export', states: ['pay'] }] })).toMatch(/point 1: "Staff can export" is too short to count/)
  expect(await call({ ...plan, points: [{ said: `${PAY} ${PAY} ${PAY} ${PAY}`, states: ['pay'] }] })).toMatch(/point 1: .* is over 60 words\. Quote the sentence that asks for it\./)
})

test('a quote from a typed message counts, and the message is kept as a source', async ($: any, on: any) => {
  const { call, ready, run } = await session($, on)
  await ready()
  // The states quote only PAY and REFUND; the point is the only user of the EXPORT message.
  // Stored as checked: spaces trimmed, a step named twice once.
  expect(await call({ ...plan, points: [{ said: `  ${EXPORT} `, states: ['pay', 'pay'] }] })).toMatch(/Draft saved/)
  const texts = run().draft!.sources!.map(s => s.text)
  expect(texts).toContain(EXPORT)
  expect(run().held!.points).toEqual([USER_POINT])
})

test("a state's quote and a point's quote that are both missing are refused together", async ($: any, on: any) => {
  const { call, ready } = await session($, on)
  await ready()
  // A state's quote and a point's quote that are both missing are refused together.
  const got = await call({ ...plan, states: [{ id: 'pay', label: 'Payments', asked: ['Nobody typed this sentence in the session.'] }, B], points: [{ said: 'Nor did anyone type this other one.', states: ['pay'] }] })
  expect(got).toMatch(/- pay: "Nobody typed this sentence in the session\." isn't in the sources/)
  expect(got).toMatch(/- point 1: "Nor did anyone type this other one\." isn't in the sources/)
})

test('a point that is not shaped right is refused, naming it', async ($: any, on: any) => {
  const { call, ready, run } = await session($, on)
  await ready()
  const bad = async (points: unknown, re: RegExp) => {
    expect(await call({ ...plan, points })).toMatch(re)
    expect(run().draft).toBeUndefined()
  }
  await bad({ said: EXPORT, states: ['pay'] }, /^points is a list/)
  await bad([USER_POINT, { states: ['pay'] }], /^Point 2 needs "said"/)
  await bad([{ said: EXPORT }], /^Point 1 \("Staff can export a class roster to a sheet\."\) needs "states", the steps that deliver it, or "left"/)
  await bad([{ said: EXPORT, states: [] }], /^Point 1 .* needs "states"/)
  await bad([{ said: EXPORT, states: ['pay'], left: 'Because.' }], /^Point 1 .* needs "states"/)
  await bad([USER_POINT, { said: REFUND, states: ['refund', 'nope'] }], /^Point 2 names "nope", which is not one of the states\. Send "points" again as it should be\./)
  // Nothing left a half-made draft behind: the same plan with good points saves.
  expect(await call({ ...plan, points: [USER_POINT, { said: REFUND, states: ['refund'] }] })).toMatch(/Draft saved/)
})

test('with Quote the source off, a quote is not compared, but the shape and the steps still are', async ($: any, on: any) => {
  const { call, sentinel, run } = await session($, on, { quoting: false })
  await sentinel('lock')
  const made = { said: 'Something nobody typed at all, in these words.', states: ['pay'] }
  expect(await call({ ...plan, states: [{ id: 'pay', label: 'Payments' }, { id: 'refund', label: 'Refunds' }], points: [made] })).toMatch(/Draft saved/)
  expect(run().held!.points).toEqual([made])
  expect(await call({ ...plan, points: [{ said: made.said, states: ['ghost'] }] })).toMatch(/^Point 1 names "ghost"/)
})

test('a revise keeps the points it does not send, and replaces them when it does', async ($: any, on: any) => {
  const { call, ready, run } = await session($, on)
  await ready()
  const mine = [USER_POINT, { said: REFUND, states: ['refund'] }]
  await call({ ...plan, points: mine })
  expect(await call({ action: 'revise', order: ORDER, title: 'Q' })).toMatch(/Draft saved/)
  expect(run().held!.points).toEqual(mine)
  const fresh = [{ said: EXPORT, left: 'The user dropped it.' }]
  expect(await call({ action: 'revise', order: ORDER, points: fresh })).toMatch(/Draft saved/)
  expect(run().held!.points).toEqual(fresh)
  // The new list is checked like the first.
  expect(await call({ action: 'revise', order: ORDER, points: [{ said: EXPORT, states: ['ghost'] }] })).toMatch(/^Point 1 names "ghost"/)
  expect(run().held!.points).toEqual(fresh)
})

test('a revise that leaves a step out prunes the points that named it', async ($: any, on: any) => {
  const { call, ready, run } = await session($, on)
  await ready()
  await call({ ...plan, points: [{ said: PAY, states: ['pay', 'refund'] }, { said: REFUND, states: ['refund'] }, { said: EXPORT, left: 'Out of scope.' }] })
  expect(await call({ action: 'revise', order: ['pay'] })).toMatch(/Draft saved/)
  expect(run().held!.points).toEqual([
    { said: PAY, states: ['pay'] },
    { said: REFUND, left: 'Its steps were taken out.' },
    { said: EXPORT, left: 'Out of scope.' },
  ])
})

test('dropStates takes the gone ids out of each point, and a point with none left shows as left out', () => {
  const held: PlanInput = {
    action: 'define', states: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }],
    points: [{ said: 'one', states: ['a', 'b'] }, { said: 'two', states: ['b'] }, { said: 'three', states: ['c'] }, { said: 'four', left: 'No.' }],
  }
  expect(dropStates(held, ['b']).points).toEqual([{ said: 'one', states: ['a'] }, { said: 'two', left: 'Its steps were taken out.' }, { said: 'three', states: ['c'] }, { said: 'four', left: 'No.' }])
  expect(dropStates({ ...held, points: undefined }, ['b']).points).toBeUndefined()
})

test('the snapshot of a draft carries the points as stored', async ($: any, on: any) => {
  const { eng, clock, call, ready } = await session($, on)
  await openPage($, clock)
  await ready()
  const points = [USER_POINT, { said: REFUND, left: 'Waits for the payments work.' }]
  await call({ ...plan, points })
  await until(clock, () => eng.snap().points?.length === 2)
  expect(eng.snap().points).toEqual(points)
})

test('the band says how many points were left out, and says nothing when none were', async ($: any, on: any) => {
  const { call, ready, band } = await session($, on)
  await ready()
  await call({ ...plan, points: [USER_POINT] })
  expect(await band(/Check it, then lock it/)).toBe(true)
  expect(await band(/left out/)).toBe(false)
  await call({ action: 'revise', order: ORDER, points: [USER_POINT, { said: REFUND, left: 'Later.' }] })
  expect(await band(/starts at pay · 1 point left out\. Check it, then lock it\./)).toBe(true)
  await call({ action: 'revise', order: ORDER, points: [{ said: EXPORT, left: 'Later.' }, { said: REFUND, left: 'Later.' }] })
  expect(await band(/starts at pay · 2 points left out\./)).toBe(true)
})

test('once the plan runs, a revise cannot change the points', async ($: any, on: any) => {
  const { sentinel, call, ready, run } = await session($, on)
  await ready()
  await call({ ...plan, points: [USER_POINT] })
  expect(await sentinel('lock')).toMatch(/^Locked "P"/)
  expect(await call({ action: 'revise', order: ORDER, points: [] })).toBe('While a plan runs, revise only adds states, so "points" can\'t change.')
  expect(run().plan!.states.map(s => s.id)).toEqual(ORDER)
})

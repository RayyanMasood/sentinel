// How much of the user's limits a plan and its steps used. Claude Code reports the weekly figure for the whole account and
// a running cost for this session. The limit's size isn't published, so the price of 1% comes from the user's own use.
//
// How it can fail, and where each is tested below:
//  1. A saved run with no usage, or an account with no figures, shows something or breaks.
//  2. Cost from before the plan is counted, or a step gets another step's cost.
//  3. /clear or a new session makes the session's cost drop, and the plan loses what it had or goes negative.
//  4. A rebuilt run at the lock loses the count, or a new plan keeps the old one.
//  5. A measurement starts at the first reading, so rounding skews the price of 1%.
//  6. A new week, or a session that sat idle while others ran, gives a price from nothing.
//  7. A small wobble in the reset time stops every measurement from finishing.
//  8. A low price from sessions running at once wins over the true one, or the list grows without end.
//  9. A bad value in the store breaks the reading.
// 10. "What it was when you signed off" is compared across a new week.
// 11. A failed usage read stops the token count.
import { expect, mock } from 'claude-code/testing'
import { addUsage, emptyRun, summarize } from '../hooks/core'
import { keptPrices, parsePrices, perPoint, shareWord, usageView, watch } from '../hooks/usage'
import type { Run, Usage } from '../types'
import { ROOT, TOOL, engine, said, test, until } from './kit'

const WEEK = (percentUsed: number, resetsAt = '2026-11-09T22:00:00.000Z') => ({ kind: 'seven_day', percentUsed, resetsAt })
const running = (active = 'a'): Run => ({ ...emptyRun(), plan: { title: 'T', states: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, active } as Run)
const AT = '2026-11-07T10:00:00.000Z'

// ---- what a plan and its steps cost ----

test('with no plan under way nothing is counted', () => {
  const r = emptyRun()
  expect(addUsage(r, 5, [WEEK(50)], 2)).toBe(r)
})

test('the first reading only sets where counting starts, so earlier cost stays out', () => {
  const u = addUsage(running(), 40, [WEEK(50)], undefined).usage!
  expect(u.usd).toBe(0)
  expect(u.last).toBe(40)
  expect(u.byState).toEqual({})
})

test('what the cost grew by goes to the plan and to the step running then', () => {
  let r = addUsage(running('a'), 10, [WEEK(50)], undefined)
  r = addUsage(r, 12, [WEEK(50)], undefined)
  r = addUsage({ ...r, active: 'b' }, 15, [WEEK(51)], undefined)
  r = addUsage(r, 16, [WEEK(51)], undefined)
  expect(r.usage!.usd).toBe(6)
  expect(r.usage!.byState).toEqual({ a: 2, b: 4 })
})

test('when the session\'s cost drops the plan keeps what it had and counts on from there', () => {
  let r = addUsage(running(), 10, [], undefined)
  r = addUsage(r, 13, [], undefined)
  r = addUsage(r, 1, [], undefined)
  r = addUsage(r, 2, [], undefined)
  expect(r.usage!.usd).toBe(5)
  expect(r.usage!.last).toBe(2)
  expect(r.usage!.byState).toEqual({ a: 5 })
})

test('a reading with no figures keeps the last ones, and a window that appears later gets its own start', () => {
  const five = { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-11-07T15:00:00.000Z' }
  let r = addUsage(running(), 1, [WEEK(50)], undefined)
  r = addUsage(r, 2, [], undefined)
  expect(r.usage!.windows).toEqual([WEEK(50)])
  r = addUsage(r, 3, [WEEK(51), five], undefined)
  expect(r.usage!.windows).toEqual([WEEK(51), five])
  expect(r.usage!.began).toEqual([WEEK(50), five])
})

// ---- what the page and terminal show ----

const USAGE = (o: Partial<Usage> = {}): Usage => ({ usd: 0, last: 0, byState: {}, windows: [WEEK(52)], began: [WEEK(48)], ...o })

test('a saved run with no usage, and an account with no figures, show nothing', () => {
  expect(usageView(undefined)).toBeUndefined()
  expect(usageView(USAGE({ windows: [], began: [] }))).toBeUndefined()
  expect(usageView(USAGE({ windows: [{ kind: 'spend_limit', percentUsed: 3 }] }))).toBeUndefined()
  expect(summarize(running()).usage).toBeUndefined()
})

test('shares say estimating until there is a price, then about so much, then under 0.1%', () => {
  expect(shareWord(1, undefined)).toBe('estimating')
  expect(shareWord(7, 5)).toBe('about 1.4%')
  expect(shareWord(0.4, 5)).toBe('under 0.1%')
  expect(shareWord(0, 5)).toBe('under 0.1%')
  const v = usageView(USAGE({ usd: 7, byState: { a: 3, b: 4 }, perPoint: 5 }))!
  expect(v.plan).toBe('about 1.4%')
  expect(v.usd).toBe(7)
  expect(v.steps).toEqual({ a: 'about 0.6%', b: 'about 0.8%' })
})

test('the week comes first, the 5-hour figure shows only when reported, and each says what it was at the start', () => {
  const five = { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-11-07T15:00:00.000Z' }
  const only = usageView(USAGE())!
  expect(only.windows.map(w => [w.name, w.percent, w.was])).toEqual([['Week', 52, 48]])
  const both = usageView(USAGE({ windows: [five, WEEK(52)], began: [WEEK(48), { ...five, percentUsed: 11 }] }))!
  expect(both.windows.map(w => [w.name, w.percent, w.was])).toEqual([['Week', 52, 48], ['5 hours', 20, 11]])
  expect(both.windows[0]!.resetsAt).toBe(WEEK(52).resetsAt)
})

test('what it was at the start is left out once a new window has begun', () => {
  const v = usageView(USAGE({ windows: [WEEK(3, '2026-11-16T22:00:00.000Z')], began: [WEEK(90)] }))!
  expect(v.windows[0]!.percent).toBe(3)
  expect(v.windows[0]!.was).toBeUndefined()
})

test('with no weekly figure there is no share of it to show', () => {
  const five = { kind: 'five_hour', percentUsed: 20 }
  const v = usageView(USAGE({ windows: [five], began: [five], usd: 4, byState: { a: 4 }, perPoint: 2 }))!
  expect(v.windows.map(w => w.name)).toEqual(['5 hours'])
  expect(v.plan).toBeUndefined()
  expect(v.steps).toEqual({})
})

// ---- the price of 1% ----

const run = (steps: [number, number, string?][]) => {
  let w: ReturnType<typeof watch>['watch'] | undefined
  const prices = []
  for (const [pct, usd, resets] of steps) {
    const m = watch(w, pct, usd, resets ?? WEEK(0).resetsAt, AT)
    w = m.watch
    if (m.price) prices.push(m.price)
  }
  return prices
}

test('a measurement starts when the figure ticks over and ends 3 points later', () => {
  // The cost before the first tick is left out, as the figure may have been about to tick when reading began.
  expect(run([[50, 100], [50, 105], [51, 110], [52, 120], [53, 125]])).toEqual([])
  expect(run([[50, 100], [50, 105], [51, 110], [52, 120], [53, 125], [54, 135]])).toEqual([{ usd: 25, points: 3, at: AT }])
})

test('the next measurement starts where the last one ended', () => {
  expect(run([[50, 0], [51, 10], [54, 40], [57, 100]])).toEqual([{ usd: 30, points: 3, at: AT }, { usd: 60, points: 3, at: AT }])
})

test('a figure with a decimal works the same way, and a jump past 3 points counts them all', () => {
  expect(run([[50.2, 0], [50.5, 2], [53.5, 32]])).toEqual([{ usd: 30, points: 3, at: AT }])
  expect(run([[50, 0], [51, 10], [56, 60]])).toEqual([{ usd: 50, points: 5, at: AT }])
})

test('a new week starts the measurement over', () => {
  expect(run([[90, 0], [91, 10], [93, 30], [1, 40], [2, 50], [4, 60]])).toEqual([])
  expect(run([[90, 0], [91, 10], [93, 30], [1, 40], [2, 50], [5, 90]])).toEqual([{ usd: 40, points: 3, at: AT }])
  expect(run([[1, 0], [2, 10], [3, 30, '2026-11-16T22:00:00.000Z'], [5, 40, '2026-11-16T22:00:00.000Z']])).toEqual([])
})

test('a small wobble in the reset time does not', () => {
  expect(run([[50, 0], [51, 10, '2026-11-09T22:00:01.000Z'], [54, 40, '2026-11-09T21:59:58.000Z']])).toEqual([{ usd: 30, points: 3, at: AT }])
})

test('the session\'s cost dropping starts the measurement over', () => {
  expect(run([[50, 0], [51, 10], [52, 1], [54, 20]])).toEqual([])
})

test('a session that sat idle while others moved the figure gives no price', () => {
  expect(run([[50, 7], [51, 7], [54, 7], [55, 8]])).toEqual([])
})

test('the highest price of the last 20 wins, as sessions running at once only pull it down', () => {
  const p = (usd: number) => ({ usd, points: 3, at: AT })
  expect(perPoint([])).toBeUndefined()
  expect(perPoint([p(15), p(6), p(9)])).toBe(5)
  let list = [p(300)]
  for (let i = 0; i < 20; i++) list = keptPrices(list, p(3))
  expect(list).toHaveLength(20)
  expect(perPoint(list)).toBe(1)
  expect(keptPrices([p(3)], p(6)).map(x => x.usd)).toEqual([3, 6])
})

test('a bad value in the store is dropped', () => {
  const good = { usd: 3, points: 3, at: AT }
  expect(parsePrices(undefined)).toEqual([])
  expect(parsePrices('x')).toEqual([])
  expect(parsePrices([good, null, 1, { usd: 'a', points: 3 }, { usd: 3, points: 0 }, { usd: -1, points: 3 }, { usd: Infinity, points: 3 }])).toEqual([good])
})

// ---- through the engine ----

const REPLY = { model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 }
function harness($: any, on: any) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: REPLY }
  })
  const respond = async (usd?: number, windows: object[] = []) => {
    eng.setUsage(usd === undefined ? { rateLimits: windows } : { rateLimits: windows, cost: { usd } })
    const s = $.turn.step({ turnId: 't', index: 0, model: 'opus', effort: 'high', messageCount: 1 })
    for await (const _ of s) { /* the chunks */ }
    await clock.advance(1)
  }
  const lock = async () => {
    await $.tool.call({ tool: 'ExitPlanMode' })
    await $.tool.call({ tool: TOOL, action: 'define', title: 'Take payment', states: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
  }
  return { eng, clock, respond, lock }
}

test('a slow reading and a newer one stay in order, so the slow one is no drop in cost', async ($: any, on: any) => {
  const { eng, clock, respond, lock } = harness($, on)
  await lock()
  await respond(10, [WEEK(50)])
  await respond(11, [WEEK(50)])
  const fire = async () => { for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'opus', effort: 'high', messageCount: 1 })) { /* the chunks */ } }
  let settle = (_: object) => {}
  eng.setUsage(new Promise<object>(ok => (settle = ok)))
  await fire()
  await clock.advance(1)
  eng.setUsage({ rateLimits: [WEEK(50)], cost: { usd: 15 } })
  await fire()
  await clock.advance(1)
  settle({ rateLimits: [WEEK(50)], cost: { usd: 13 } })
  await until(clock, () => eng.snap().usage?.usd >= 5)
  await clock.advance(5)
  expect(eng.snap().usage.usd).toBe(5)
})

test('a plan resumed in a later session does not take on what that session spent before', async ($: any, on: any) => {
  const { eng, clock, respond } = harness($, on)
  eng.files[`${ROOT}/.sentinel/run.json`] = JSON.stringify({ ...running('a'), signedOff: true, usage: { usd: 1, last: 3, byState: { a: 1 }, windows: [], began: [] }, savedAt: Date.now() })
  await respond(12, [WEEK(50)])
  expect(said(await $.command.run({ command: 'sentinel', args: 'resume' }))).toMatch(/Resumed/)
  await respond(13, [WEEK(50)])
  await until(clock, () => eng.snap().usage?.usd >= 2)
  expect(eng.snap().usage.usd).toBe(2)
})

test('a model response reads the figures, and the page gets them with the share of the week', async ($: any, on: any) => {
  const { eng, clock, respond, lock } = harness($, on)
  await lock()
  await respond(10, [WEEK(50)])
  await respond(12, [WEEK(50)])
  await until(clock, () => eng.snap().usage?.usd === 2)
  expect(eng.snap().usage.plan).toBe('estimating')
  expect(eng.snap().usage.windows[0]).toMatchObject({ name: 'Week', percent: 50, was: 50 })
  expect(eng.snap().usage.steps).toEqual({ a: 'estimating' })
})

test('a finished measurement is kept in the store, and sets the price every session then uses', async ($: any, on: any) => {
  const { eng, clock, respond, lock } = harness($, on)
  await respond(0, [WEEK(50)])
  await respond(10, [WEEK(51)])
  await respond(40, [WEEK(54)])
  await until(clock, () => (eng.store['usage-prices'] as unknown[] | undefined)?.length === 1)
  expect(eng.store['usage-prices']).toMatchObject([{ usd: 30, points: 3 }])
  // No plan was running, and the price is still learned. A plan after it uses it.
  await lock()
  await respond(40, [WEEK(54)])
  await respond(45, [WEEK(54)])
  await until(clock, () => eng.snap().usage?.plan === 'about 0.5%')
})

test('a price another session stored is used here', async ($: any, on: any) => {
  const { eng, clock, respond, lock } = harness($, on)
  eng.store['usage-prices'] = [{ usd: 15, points: 3, at: AT }]
  await lock()
  await respond(10, [WEEK(50)])
  await respond(20, [WEEK(50)])
  await until(clock, () => eng.snap().usage?.plan === 'about 2%')
})

test('with no cost reported nothing is recorded, and tokens still count', async ($: any, on: any) => {
  const { eng, clock, respond, lock } = harness($, on)
  await lock()
  await respond(undefined, [WEEK(50)])
  await until(clock, () => eng.snap().spend?.length === 1)
  expect(eng.snap().usage).toBeUndefined()
})

test('a failed read of the figures leaves the token count alone', async ($: any, on: any) => {
  const { eng, clock, respond, lock } = harness($, on)
  await lock()
  eng.setUsageFails(true)
  await respond(10, [WEEK(50)])
  await until(clock, () => eng.snap().spend?.[0]?.requests === 1)
  expect(eng.snap().usage).toBeUndefined()
})

test('the count carries across the lock of a draft, and a new plan starts over', async ($: any, on: any) => {
  const { eng, clock, respond } = harness($, on)
  await $.command.run({ command: 'sentinel', args: 'lock' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'Take payment', states: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
  await respond(10, [WEEK(50)])
  await respond(13, [WEEK(50)])
  await until(clock, () => eng.snap().usage?.usd === 3)
  expect(said(await $.command.run({ command: 'sentinel', args: 'lock' }))).toMatch(/lock/i)
  await $.tool.call({ tool: TOOL, action: 'status' })
  await respond(14, [WEEK(50)])
  await until(clock, () => eng.snap().usage?.usd === 4)
  await $.command.run({ command: 'sentinel', args: 'finish done for now' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'Next', states: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] })
  await respond(20, [WEEK(50)])
  await until(clock, () => eng.snap().title === 'Next' && eng.snap().usage?.usd === 0)
  expect(eng.files[`${ROOT}/.sentinel/state.js`]).toContain('"usage"')
})

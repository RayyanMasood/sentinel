// The draft's depth answers start ticked where Claude recommends them, and the user unticks what they don't want. Run
// with `node tests/only.mjs depth-defaults`.
//
// How this can fail, and where each is tested below:
//  1. Claude's on doesn't reach the page or the pane, or something other than true turns an answer on.
//  2. A bare lock (typed, or the band's) still takes nothing, or takes the answers without their states, or doesn't
//     say which went in.
//  3. Typed ids don't replace the defaults: a default the user didn't name goes in anyway.
//  4. The terminal has no way to lock with nothing ticked, or "none" can be an answer's id.
//  5. A tick changed on the page is lost when the lock is typed, or a page showing an older draft changes a tick.
//  6. The page's Lock with nothing ticked falls back to the defaults.
//  7. A replay of the draft or a revise without depth resets the user's ticks; a revise with depth keeps old ones.
import { expect, mock } from 'claude-code/testing'
import type { Run } from '../types'
import { ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const STATES = [
  { id: 'explore', label: 'Explore', check: 'npm test -- explore', files: ['src/**'] },
  { id: 'bench', label: 'Benchmark', check: 'npm run bench', files: ['bench/**'] },
  { id: 'csv', label: 'Refund CSV', check: 'test -s refunds.csv', files: ['refunds.csv'] },
  { id: 'verify', label: 'Verify', check: 'npm test', files: ['src/**'] },
]
const DEPTH = [
  { id: 'perf', text: 'Benchmark the refund path.', ask: 'methods', state: 'bench', on: true },
  { id: 'raw', text: 'Start from the failing refund log.', ask: 'raw', on: true },
  { id: 'proof', text: 'Save the refunds as a CSV.', ask: 'proof', state: 'csv' },
]
const define = (depth: object[] = DEPTH) => ({ tool: TOOL, action: 'define', title: 'P', states: STATES, depth })
const PANE = {
  plugin: 'sentinel', component: 'Pane', requestId: 'sentinel', surface: 'terminal',
  props: { title: 'Sentinel', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
}

async function session($: any, on: any) {
  const eng = engine(on)
  const clock = mock.clock(on)
  const sentinel = async (args: string) => {
    const out = said(await $.command.run({ command: 'sentinel', args }))
    await clock.advance(1)
    return out
  }
  const s = {
    eng, clock, sentinel,
    // The plan's states once it locks.
    locked: async () => {
      await $.tool.call({ tool: TOOL, action: 'status' })
      return (JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`]!) as Run).plan!.states.map(x => x.id)
    },
    // The answers as the page sees them, each with its tick.
    ticks: () => (eng.snap().depth ?? []).map((d: any) => `${d.id}${d.on ? '+' : '-'}`).join(' '),
    // A draft from a typed /sentinel lock, with the page open.
    draft: async (depth: object[] = DEPTH) => {
      await sentinel('lock')
      await openPage($, clock)
      const out = said(await $.tool.call(define(depth)))
      await until(clock, () => eng.snap().depth?.length)
      return out
    },
    page: async (m: object, settled: () => unknown) => {
      eng.page({ draft: eng.snap().draftKey, ...m })
      await until(clock, settled)
    },
  }
  return s
}

test("Claude's recommended answers start ticked on the page and in the pane, and only true turns one on", async ($: any, on: any) => {
  const s = await session($, on)
  const out = await s.draft([...DEPTH.slice(0, 2), { ...DEPTH[2], on: 'yes' }])
  expect(out).toMatch(/they tick the depth answers they want \(perf, raw, proof\), starting from the ones you marked on \(perf, raw\); a state named by one they leave unticked comes out/)
  expect(s.ticks()).toBe('perf+ raw+ proof-')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /✓ perf/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· proof/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/sentinel lock none/ })).toBeDefined()
  await ui.unmount()
  // "none" is the word for locking with nothing ticked, so no answer can have it.
  expect(said(await $.tool.call({ tool: TOOL, action: 'revise', order: STATES.map(x => x.id), depth: [{ id: 'None', text: 'x' }] }))).toMatch(/"None" is kept for \/sentinel lock none/)
})

test('a bare lock takes the ticked answers with their states, and says which went in', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  expect(await s.sentinel('lock')).toBe('Locked "P" at explore. Ticked perf (keeps bench), raw. Took out csv, named by answers you left unticked.')
  expect(await s.locked()).toEqual(['explore', 'bench', 'verify'])
  expect(s.eng.submitted.at(-1)).toMatch(/The user chose: Benchmark the refund path; Start from the failing refund log\. The user left out: Save the refunds as a CSV\./)
})

test('typed ids take exactly those, and none takes none', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  expect(await s.sentinel('lock raw')).toBe('Locked "P" at explore. Ticked raw. Took out bench, csv, named by answers you left unticked.')
  expect(await s.locked()).toEqual(['explore', 'verify'])
  await s.sentinel('reset')
  expect(await s.sentinel('lock none')).toMatch(/There is no draft to lock yet/)
  await s.draft()
  expect(await s.sentinel('lock none')).toBe('Locked "P" at explore. Took out bench, csv, named by answers you left unticked.')
  expect(s.eng.submitted.at(-1)).not.toMatch(/The user chose/)
})

test('a tick changed on the page holds for a lock typed later, and a page showing an older draft changes nothing', async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.page({ kind: 'deep', id: 'perf', on: false }, () => s.ticks() === 'perf- raw+ proof-')
  await s.page({ kind: 'deep', id: 'proof', on: true }, () => s.ticks() === 'perf- raw+ proof+')
  // The ticks are saved with the draft, so a session that brings the draft back keeps them.
  await until(s.clock, () => JSON.parse(s.eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}').held?.depth?.map((d: any) => `${d.id}${d.on ? '+' : '-'}`).join(' ') === 'perf- raw+ proof+')
  s.eng.page({ kind: 'deep', id: 'nope', on: true })
  await s.clock.advance(500)
  expect(s.ticks()).toBe('perf- raw+ proof+')
  expect(await s.sentinel('lock')).toBe('Locked "P" at explore. Ticked raw, proof (keeps csv). Took out bench, named by answers you left unticked.')
  expect(await s.locked()).toEqual(['explore', 'csv', 'verify'])
})

test("the page's Lock with nothing ticked takes none", async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.page({ kind: 'lock', picked: [] }, () => s.eng.files[`${ROOT}/.sentinel/run.json`]?.includes('"plan":{'))
  expect(await s.locked()).toEqual(['explore', 'verify'])
})

test("a replay or a revise without depth keeps the user's ticks, and a revise with depth starts from Claude's", async ($: any, on: any) => {
  const s = await session($, on)
  await s.draft()
  await s.page({ kind: 'deep', id: 'perf', on: false }, () => s.ticks() === 'perf- raw+ proof-')
  // A change on the draft's cards replays it from what Claude sent.
  const key = s.eng.snap().draftKey
  await s.page({ kind: 'libplan', weight: 'thorough', on: [] }, () => s.eng.snap().draftKey !== key)
  expect(s.ticks()).toBe('perf- raw+ proof-')
  await $.tool.call({ tool: TOOL, action: 'revise', order: STATES.map(x => x.id), title: 'Q' })
  await until(s.clock, () => s.eng.snap().title === 'Q')
  expect(s.ticks()).toBe('perf- raw+ proof-')
  await $.tool.call({ tool: TOOL, action: 'revise', order: STATES.map(x => x.id), depth: DEPTH })
  await until(s.clock, () => s.ticks() === 'perf+ raw+ proof-')
})

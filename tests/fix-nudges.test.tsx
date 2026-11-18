// Questions and pushes at the right moments: a question reaches a user who is at the keyboard, a hands-free turn that
// answers what the user just typed isn't pushed on, a long run is named once per 30 minutes, and a state that ends with
// the user's review is pushed toward advance.
import { expect, mock } from 'claude-code/testing'
import { REFUND, TOOL, endTurn, engine, said, test, until } from './kit'

const PLAN = {
  action: 'define', title: 'Partial refunds',
  states: [
    { id: 'explore', label: 'Read payments code' },
    { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'] },
    { id: 'review', label: 'Look over the refund screen', wait: 'after' },
  ],
}
const MIN = 60_000
async function at($: any, on: any, state: 'service' | 'review') {
  const clock = mock.clock(on)
  const eng = engine(on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, ...(state === 'review' ? { ...PLAN, states: [PLAN.states[0], PLAN.states[2]] } : PLAN) })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  await $.tool.call({ tool: TOOL, action: 'advance', to: state, evidence: 'read it' })
  const pushes = () => eng.submitted.filter(t => /Auto-continue/.test(t))
  return { clock, eng, pushes }
}
const ask = ($: any) => $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Half-even or half-up?', options: [] }] })
const typed = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } })
const handsFree = async ($: any, clock: any) => {
  await $.command.run({ command: 'sentinel', args: 'hands-free' })
  await clock.settle()
}

test('a question reaches the user who typed in the last 15 minutes, and is held once they have been away longer', async ($: any, on: any) => {
  const { clock } = await at($, on, 'service')
  // Nothing typed in this session yet: held.
  expect(said(await ask($))).toMatch(/holds this question/)
  await typed($, 'Use whichever rounding the ledger uses.')
  expect(said(await ask($))).toBe('answered')
  await clock.advance(14 * MIN)
  expect(said(await ask($))).toBe('answered')
  await clock.advance(2 * MIN)
  expect(said(await ask($))).toMatch(/holds this question/)
})

test('hands-free, a question is held even right after the user typed', async ($: any, on: any) => {
  const { clock } = await at($, on, 'service')
  await handsFree($, clock)
  await typed($, 'Back in an hour.')
  expect(said(await ask($))).toMatch(/holds this question\. The user is hands-free and away/)
})

test('hands-free, a turn that ends right after the user typed is not pushed on, and a long stretch of work after is', async ($: any, on: any) => {
  const { clock, pushes } = await at($, on, 'service')
  await handsFree($, clock)
  const before = pushes().length
  await typed($, 'Stop for a moment, what does the refund screen show?')
  await endTurn($, { answer: 'It shows the order and the amount.' })
  expect(pushes()).toHaveLength(before)
  await clock.advance(6 * MIN)
  await endTurn($)
  expect(pushes()).toHaveLength(before + 1)
})

test('a long run is named in one push per 30 minutes, not again each time the turn stops beside it', async ($: any, on: any) => {
  const { clock, pushes } = await at($, on, 'service')
  const srv = [{ id: 'srv', type: 'shell', status: 'running', description: 'npm run e2e' }]
  await $.turn.start({ text: '', turnId: 't' })
  await endTurn($, { tasks: srv, answer: 'Started the e2e run.' })
  await clock.advance(31 * MIN)
  await until(clock, () => pushes().length)
  expect(pushes()).toHaveLength(1)
  expect(pushes()[0]).toMatch(/Background work has run for over 30 minutes: npm run e2e/)
  // Claude stops again with the run still going: no second push for it.
  await $.turn.start({ text: '', turnId: 't' })
  await endTurn($, { tasks: srv, answer: 'Still waiting on the e2e run.' })
  await clock.settle()
  expect(pushes()).toHaveLength(1)
  // Another 30 minutes on, it is named again: a server never ends.
  await clock.advance(31 * MIN)
  await until(clock, () => pushes().length > 1)
  expect(pushes()).toHaveLength(2)
})

test('a state that ends with the user\'s review is pushed toward advance, not toward a blocked report', async ($: any, on: any) => {
  const { clock, pushes } = await at($, on, 'review')
  await clock.advance(10 * MIN)
  await endTurn($)
  expect(pushes()).toHaveLength(1)
  expect(pushes()[0]).toMatch(/ends with the user's review/)
  expect(pushes()[0]).toMatch(/call advance with your outcome/)
  expect(pushes()[0]).not.toMatch(/escalate/)
})

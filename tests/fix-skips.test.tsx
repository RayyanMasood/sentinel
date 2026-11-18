// Skipping an instruction should cost one call: by its name or its title, several at once. And break-it-once says how
// far to go, so it can't grow into a mutation pass before every advance.
import { expect, mock } from 'claude-code/testing'
import { REFUND, ROOT, TOOL, engine, said, test } from './kit'

const PLAN = {
  action: 'define', title: 'Partial refunds',
  states: [
    { id: 'explore', label: 'Read payments code' },
    { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'] },
  ],
}
const RUN = `${ROOT}/.sentinel/run.json`
async function atService($: any, on: any) {
  mock.clock(on)
  const eng = engine(on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, ...PLAN })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  const moved = said(await $.tool.call({ tool: TOOL, action: 'advance', to: 'service', evidence: 'read it' }))
  return { eng, moved }
}
const skip = async ($: any, name: string) => said(await $.tool.call({ tool: TOOL, action: 'decide', skip: name, reason: 'This state only moves a constant.' }))
// The skips on record, read from the saved run once the writes have landed.
const skips = async ($: any, eng: any) => {
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: TOOL, action: 'status' })
  return JSON.parse(eng.files[RUN]!).audit.filter((a: any) => a.skip).map((a: any) => a.skip.name)
}

test('an instruction can be skipped by its title, any case', async ($: any, on: any) => {
  const { eng } = await atService($, on)
  expect(await skip($, 'A test must be able to fail')).toMatch(/Recorded/)
  expect(await skip($, 'Failure-List')).toMatch(/Recorded/)
  expect(await skips($, eng)).toEqual(['break-it-once', 'failure-list'])
})

test('several instructions are skipped in one call, separated by commas', async ($: any, on: any) => {
  const { eng } = await atService($, on)
  expect(await skip($, 'failure-list, break-it-once')).toMatch(/Recorded/)
  expect(await skips($, eng)).toEqual(['failure-list', 'break-it-once'])
})

test('a name the state was not told is refused with the list, and nothing in that call is recorded', async ($: any, on: any) => {
  const { eng } = await atService($, on)
  const out = await skip($, 'failure-list, measure-twice')
  expect(out).toMatch(/wasn't told measure-twice/)
  expect(out).toMatch(/These can: .*failure-list.*break-it-once|These can: .*break-it-once.*failure-list/)
  expect(await skips($, eng)).toEqual([])
})

test('break-it-once says how far to go: by hand, once, about 10 minutes, and nothing to break without a new test', async ($: any, on: any) => {
  const { moved } = await atService($, on)
  expect(moved).toMatch(/break the code it targets once by hand, run that test alone/)
  expect(moved).toMatch(/No mutation harness/)
  expect(moved).toMatch(/about 10 minutes/)
  expect(moved).toMatch(/A state that adds no test has nothing to break\./)
  expect(moved).toMatch(/A state that writes no logic has nothing to list\./)
})

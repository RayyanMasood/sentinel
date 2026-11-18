// A new process, or a lost hooks worker, starts Sentinel with nothing in memory. The plan on disk can still be closed,
// status names it, and what the user typed before still counts for quotes.
import { expect, mock } from 'claude-code/testing'
import { ROOT, TOOL, engine, said, test } from './kit'

const PLAN = {
  action: 'define', title: 'Partial refunds',
  states: [
    { id: 'explore', label: 'Read payments code', added: 'Reading first.' },
    { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'], added: 'The work.' },
  ],
}
const RUN = `${ROOT}/.sentinel/run.json`
// Writes are queued behind the call, so two more calls make sure the last one has landed.
const landed = async ($: any) => { for (let i = 0; i < 2; i++) await $.tool.call({ tool: TOOL, action: 'status' }) }
const plan = async ($: any, input: object) => said(await $.tool.call({ tool: TOOL, ...input }))
const typed = async ($: any, text: string) => {
  await $.prompt.submit({ text, origin: { kind: 'composer' } })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await $.turn.start({ text: '', turnId: 't' })
}
// A later session: the run is gone from memory, the files stay on disk.
const restart = async ($: any, eng: ReturnType<typeof engine>) => {
  await landed($)
  const disk = { ...eng.files }
  await $.command.run({ command: 'sentinel', args: 'reset' })
  Object.assign(eng.files, disk)
}
const paused = async ($: any, on: any) => {
  mock.clock(on)
  const eng = engine(on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(await plan($, PLAN)).toMatch(/Locked "Partial refunds"/)
  expect(said(await $.command.run({ command: 'sentinel', args: 'pause' }))).toMatch(/Paused at explore/)
  await restart($, eng)
  return eng
}

test('finish closes a plan an earlier session left on disk, in the turn the user asks', async ($: any, on: any) => {
  const eng = await paused($, on)
  await typed($, 'Forget that old plan, close it.')
  expect(await plan($, { action: 'finish', reason: 'The user closed it.' })).toMatch(/closed/i)
  await landed($)
  expect(JSON.parse(eng.files[RUN]!)).toMatchObject({ active: 'done', closed: { why: 'The user closed it.' } })
  expect(await plan($, { action: 'status' })).not.toMatch(/earlier session/)
})

test('status and a refusal name the plan left on disk and /sentinel resume', async ($: any, on: any) => {
  await paused($, on)
  const status = await plan($, { action: 'status' })
  expect(status).toMatch(/No plan is locked/)
  expect(status).toMatch(/"Partial refunds" from an earlier session/)
  expect(status).toMatch(/\/sentinel resume/)
  expect(await plan($, { action: 'advance', to: 'service' })).toMatch(/No plan is locked\.[\s\S]*"Partial refunds" from an earlier session/)
})

test('finish the user did not ask for leaves the saved plan on disk as it was', async ($: any, on: any) => {
  const eng = await paused($, on)
  const before = eng.files[RUN]
  expect(await plan($, { action: 'finish', reason: 'Tidying up.' })).toMatch(/No plan is locked[\s\S]*\/sentinel resume/)
  await landed($)
  expect(eng.files[RUN]).toBe(before)
  expect(await plan($, { action: 'status' })).toMatch(/"Partial refunds" from an earlier session/)
})

test('with nothing on disk, finish and status say only that no plan is locked', async ($: any, on: any) => {
  engine(on)
  await typed($, 'Close the plan please.')
  const r = await plan($, { action: 'finish', reason: 'x' })
  expect(r).toMatch(/No plan is locked/)
  expect(r).not.toMatch(/earlier session/)
  expect(await plan($, { action: 'status' })).not.toMatch(/earlier session/)
})

// A new process asks the store for what this session typed. sess-1 is this session; sess-0 another one.
const ASK = 'Add partial refunds to the payments service please.'
const NOTE = 'Refunds must be logged with the order number.'
// A written file as Sentinel keys it: the drive letter in lower case.
const WROTE = 'd:/proj/notes.md'
const session = (on: any, id: string) => on('session.id', () => ({ value: id }))

test('what the user typed and the files Claude wrote are kept in the store under the session id', async ($: any, on: any) => {
  mock.clock(on)
  session(on, 'sess-1')
  const eng = engine(on)
  eng.store.said = { 'sess-0': { at: 1, said: { messages: [{ text: 'Build a loyalty scheme for members today.', at: '08:00' }], wrote: [] } } }
  await typed($, ASK)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes.md`, content: NOTE })
  const kept = eng.store.said as any
  expect(kept['sess-1'].said.messages.map((m: any) => m.text)).toEqual([ASK])
  expect(kept['sess-1'].said.wrote).toEqual([WROTE])
  // Another session's entry stays as it was.
  expect(kept['sess-0'].said.messages[0].text).toBe('Build a loyalty scheme for members today.')
})

test('a new process reads back what its own session typed and wrote, and not what another session typed', async ($: any, on: any) => {
  mock.clock(on)
  session(on, 'sess-1')
  const eng = engine(on)
  eng.store.said = {
    'sess-0': { at: 1, said: { messages: [{ text: 'Build a loyalty scheme for members today.', at: '08:00' }], wrote: [] } },
    'sess-1': { at: 2, said: { messages: [{ text: ASK, at: '09:00' }], wrote: [WROTE] } },
  }
  eng.quoting()
  eng.files[`${ROOT}/notes.md`] = NOTE
  await $.tool.call({ tool: 'ExitPlanMode' })
  const one = (asked: string) => ({ ...PLAN, source: 'notes.md', states: [{ id: 'service', label: 'RefundService', files: ['src/refund*.ts'], asked: [asked] }] })
  expect(await plan($, one('Build a loyalty scheme for members today.'))).toMatch(/isn't in the sources/)
  // notes.md is Claude's own file from before the restart, so it is no source.
  expect(await plan($, one(NOTE))).toMatch(/isn't in the sources/)
  expect(await plan($, one(ASK))).toMatch(/Locked "Partial refunds"/)
})

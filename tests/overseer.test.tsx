// When the active state runs long, Sentinel starts a read-only agent to look into it, and the main run goes on. Through
// the engine double and a fake clock. Run with `node tests/only.mjs overseer`.
//
// How this can fail, and where each is tested below:
//  1. It starts too early, with no plan, or more than one at a time, so tokens go on looks nobody needs.
//  2. It starts with too little to go on, or able to edit, or on a model the user didn't ask for.
//  3. A FINE reaches the main chat, either as Sentinel's message or as the agent's own hand-back (a real terminal delivers
//     one, seen in mockups/time-note/spike.log), which disturbs the run and can wake an idle chat.
//  4. A finding never reaches the main chat, whether it is working or idle, or an answer it can't read is lost.
//  5. A refused start leaves nobody told: a session stopped with Esc refuses one.
//  6. A running overseer counts as background work, which holds off Auto-continue and keeps the clock running.
//  7. An answer about a state that has since finished misdirects the main chat.
//  8. Its calls land in the ledger and the health window, which measure the main run.
//  9. Dropping hand-backs reaches other agents' reports or what the user typed.
// A stuck look: the detector's second note on one stuck mark starts a look that asks only whether it is stuck.
// 10. The second note still tells Claude to escalate, which pauses a run the user isn't watching, or no look starts.
// 11. A stuck look offers FASTER, which can't say whether it is stuck, or starts with too little to judge the mark.
// 12. FINE on a stuck look leaves the mark open, so notes keep coming on work that is moving.
// 13. WRONG on a stuck look is lost, or a FASTER said anyway is dropped.
// 14. A stuck look uses up a time mark, so the 30-minute look never comes.
// 15. A stuck look starts with the switch off, beside a running look, or more than once for one mark.
// 16. An answer about a stuck mark that has since ended misdirects the main chat.
// 17. Looks leave no record, so nobody can tell later how often the detector was right or whether looks helped.
import { expect, mock } from 'claude-code/testing'
import { overseerPrompt, overseerSays } from '../hooks/core'
import { REFUND, ROOT, TOOL, endTurn, engine, said, test, until } from './kit'

const STATES = [
  { id: 'service', label: 'RefundService', title: 'Build refunds', problem: 'Refunds are missing', approach: 'A service and its tests', check: 'npm test -- refund', files: ['src/refund*.ts'] },
  { id: 'docs', label: 'Guide', check: 'npm test -- guide', files: ['guide/**'] },
  { id: 'verify', label: 'Full suite', check: 'npm test' },
]
const plan = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })
const runOf = (eng: ReturnType<typeof engine>) => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}')
const logOf = (eng: ReturnType<typeof engine>): string[] => (runOf(eng).log ?? []).map((l: any) => l.text)
// run.json is written on a short timer after a change.
const runNow = async (eng: ReturnType<typeof engine>, clock: any) => {
  await clock.advance(20)
  return runOf(eng)
}
const toolNote = async ($: any) => String((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/money.ts` })).context ?? '')
const fromAgent = ($: any, id: string, answer: string, more: object = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer', agentId: id, ...more })
const handBack = ($: any, id: string, kind = 'peer') =>
  $.prompt.submit({ text: `<agent-message from="${id}">\n[Subagent hand-back] The text below is the final report.\n  FINE\n</agent-message>`, origin: { kind } })

// A state's visits are stamped with Date.now, which a test can't move, and the tick reads $.clock. So the fake clock starts
// at the real time, and moving it is time passing.
let started = 0
const clockFrom = (on: any) => mock.clock(on, { now: (started = Date.now()) })
const minutes = (clock: any, n: number) => clock.set(started + n * 60_000)

// A session with a locked plan and the main chat in a turn. setup runs before the plan, such as a Library switch.
const inRun = (name: string, body: (x: { $: any; eng: ReturnType<typeof engine>; clock: any }) => Promise<void>, setup?: ($: any) => Promise<unknown>) =>
  test(name, async ($: any, on: any) => {
    const eng = engine(on)
    const clock = clockFrom(on)
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
    on('tool.register', () => ({ value: undefined }))
    on('command.register', () => ({ value: undefined }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await setup?.($)
    await $.tool.call({ tool: 'ExitPlanMode' })
    await plan($, { action: 'define', title: 'Refunds', states: STATES })
    await clock.advance(20)
    await $.turn.start({ text: '', turnId: 't' })
    await body({ $, eng, clock })
  })

inRun('nothing starts under 30 minutes of working time', async ({ eng, clock }) => {
  await minutes(clock, 29)
  expect(eng.spawns).toHaveLength(0)
})

test('nothing starts without a plan', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = clockFrom(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await minutes(clock, 45)
  expect(eng.spawns).toHaveLength(0)
})

test('switched off in the Library, no agent starts, and the log still notes the time', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = clockFrom(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(said(await $.command.run({ command: 'sentinel', args: 'off overseer' }))).toBe('overseer is off for this project.')
  await $.tool.call({ tool: 'ExitPlanMode' })
  await plan($, { action: 'define', title: 'Refunds', states: STATES })
  await clock.advance(20)
  await $.turn.start({ text: '', turnId: 't' })
  await minutes(clock, 31)
  await until(clock, () => logOf(eng).some(l => /service · .* of working time/.test(l)))
  await clock.advance(60_000)
  expect(eng.spawns).toHaveLength(0)
  expect(eng.submitted.join('\n')).not.toMatch(/overseer/i)
})

inRun('at 30 minutes one read-only agent starts on Opus, with the evidence in its prompt', async ({ $, eng, clock }) => {
  // A second session.start doesn't start a second agent.
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  eng.setBash({ fail: true, text: 'Tests: 2 failed\nexpected 49.99, received 50.00' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- refund' })
  await minutes(clock, 31)
  await until(clock, () => eng.spawns.length)
  expect(eng.spawns).toHaveLength(1)
  const spawn = eng.spawns[0]
  expect(spawn.subagent_type).toBe('Explore')
  expect(spawn.model).toBe('opus')
  expect(spawn.prompt).toMatch(/RefundService/)
  expect(spawn.prompt).toMatch(/Refunds are missing/)
  expect(spawn.prompt).toMatch(/A service and its tests/)
  expect(spawn.prompt).toMatch(/npm test -- refund/)
  expect(spawn.prompt).toMatch(/expected 49\.99, received 50\.00/)
  expect(spawn.prompt).toMatch(/Read only/)
  for (const word of ['FINE', 'FASTER', 'WRONG']) expect(spawn.prompt).toMatch(new RegExp(word))
  await until(clock, () => logOf(eng).some(l => /service · .* of working time/.test(l)))
})

inRun('FINE stays out of the main chat, and goes in the log', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  const id = eng.agents()[0]!.id
  await fromAgent($, id, 'FINE\nA long refactor, moving steadily.')
  await clock.advance(1)
  expect(await toolNote($)).not.toMatch(/overseer/i)
  expect(eng.submitted.join('\n')).not.toMatch(/overseer/i)
  await until(clock, () => logOf(eng).includes('service · overseer: fine · A long refactor, moving steadily.'))
  // 17
  expect((await runNow(eng, clock)).looks).toEqual([{ state: 'service', why: 'time', at: expect.any(Number), word: 'fine', line: 'A long refactor, moving steadily.' }])
})

inRun('WRONG reaches a working main chat on its next tool result, and tells the user', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await fromAgent($, eng.agents()[0]!.id, 'WRONG\nThe same test has failed nine times. Read the fixture.')
  await clock.advance(1)
  const note = await toolNote($)
  expect(note).toMatch(/^\[sentinel\]/m)
  expect(note).toMatch(/overseer/i)
  expect(note).toMatch(/The same test has failed nine times/)
  expect(note).toMatch(/does not stop the run/)
  expect(eng.toasts.join('\n')).toMatch(/overseer/i)
  // Once: the next result carries nothing.
  expect(await toolNote($)).not.toMatch(/overseer/i)
})

inRun('FASTER reaches the main chat too', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await fromAgent($, eng.agents()[0]!.id, 'FASTER\nRun one test file instead of the suite.')
  await clock.advance(1)
  expect(await toolNote($)).toMatch(/Run one test file instead of the suite/)
})

inRun('a finding starts a turn when the main chat is idle', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await endTurn($)
  await fromAgent($, eng.agents()[0]!.id, 'WRONG\nThe server it waits on never started.')
  await clock.advance(1)
  await until(clock, () => eng.submitted.join('\n').includes('The server it waits on never started'))
})

inRun('an answer it cannot read still reaches the main chat', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await fromAgent($, eng.agents()[0]!.id, 'I looked around and the check seems hung.')
  await clock.advance(1)
  expect(await toolNote($)).toMatch(/the check seems hung/)
})

inRun('a look that was stopped, or said nothing, tells the main chat nothing', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await fromAgent($, eng.agents()[0]!.id, 'WRONG\nHalf a thought', { isAborted: true, reason: 'aborted' })
  await clock.advance(1)
  expect(await toolNote($)).not.toMatch(/overseer/i)
  await until(clock, () => logOf(eng).includes('service · overseer: silent'))
})

inRun('a look that answers nothing tells the main chat nothing', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await fromAgent($, eng.agents()[0]!.id, '')
  await clock.advance(1)
  expect(await toolNote($)).not.toMatch(/overseer/i)
})

inRun('a refused start sends the note to the main chat, and the run goes on', async ({ $, eng, clock }) => {
  eng.setSpawnDeny('the session was stopped and nobody has sent input since')
  await minutes(clock, 31)
  await until(clock, () => eng.spawns.length)
  await clock.advance(1)
  const note = await toolNote($)
  expect(note).toMatch(/service has taken/)
  expect(note).toMatch(/does not stop the run/)
  eng.setBash({ fail: false, text: 'ok' })
  expect(said(await plan($, { action: 'status' }))).toMatch(/Active: service/)
})

inRun('no second agent starts while one is still looking, and a later mark starts a new one', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.spawns.length)
  await minutes(clock, 61)
  await clock.advance(60_000)
  expect(eng.spawns).toHaveLength(1)
  // The 60-minute mark is on record even with no new agent.
  await until(clock, () => (runOf(eng).timeSaid?.service ?? 0) === 60 * 60_000)
  const id = eng.agents()[0]!.id
  eng.setAgents(eng.agents().map(a => (a.id === id ? { ...a, status: 'completed' } : a)))
  await fromAgent($, id, 'FINE')
  await minutes(clock, 125)
  await until(clock, () => eng.spawns.length === 2)
})

inRun('a running overseer does not hold Auto-continue, where another agent would', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  const before = eng.submitted.length
  await endTurn($)
  await until(clock, () => eng.submitted.slice(before).join('\n').includes('locked and not finished'))
})

inRun('the Stop input listing a running overseer does not hold Auto-continue, where other background work would', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  const before = eng.submitted.length
  await endTurn($, { tasks: [{ id: 'bg-9', status: 'running', description: 'overseer service' }] })
  await until(clock, () => eng.submitted.slice(before).join('\n').includes('locked and not finished'))
  await $.turn.start({ text: '', turnId: 't' })
  const again = eng.submitted.length
  await endTurn($, { tasks: [{ id: 'bg-10', status: 'running', description: 'npm run build' }] })
  await clock.advance(1)
  expect(eng.submitted.slice(again).join('\n')).not.toMatch(/locked and not finished/)
})

inRun('a finding starts no turn after the user stopped one, and rides on the next tool result', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await endTurn($, { reason: 'aborted' })
  await fromAgent($, eng.agents()[0]!.id, 'WRONG\nThe server it waits on never started.')
  await clock.advance(1)
  expect(eng.submitted.join('\n')).not.toMatch(/never started/)
  await $.turn.start({ text: '', turnId: 't' })
  expect(await toolNote($)).toMatch(/never started/)
})

inRun('a finding starts no turn while the plan waits on the user, and rides on the next tool result', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await plan($, { action: 'escalate', kind: 'blocked', reason: 'Waiting for the staging password.' })
  await endTurn($)
  await fromAgent($, eng.agents()[0]!.id, 'WRONG\nThe server it waits on never started.')
  await clock.advance(1)
  expect(eng.submitted.join('\n')).not.toMatch(/never started/)
  await $.turn.start({ text: '', turnId: 't' })
  expect(await toolNote($)).toMatch(/never started/)
})

inRun('it asks git what changed, and the prompt carries the answer, other agents and only a failure from this visit', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.spawns.length)
  expect(eng.runs.some(run => run.argv.includes('--stat'))).toBe(true)
  eng.setBash({ fail: true, text: 'expected 49.99, received 50.00' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- refund' })
  await clock.advance(1)
  const r = runOf(eng)
  const prompt = overseerPrompt(r, { state: 'service', mark: 1, ms: 1 }, ' src/refund.ts | 4 ++', ['a helper'])
  expect(prompt).toContain('src/refund.ts | 4 ++')
  expect(prompt).toContain('a helper')
  expect(prompt).toContain('49.99')
  expect(overseerPrompt({ ...r, enteredAt: r.lastFail.step }, { state: 'service', mark: 1, ms: 1 }, '', [])).not.toContain('49.99')
})

test('the first word of an answer is what counts', () => {
  expect(overseerSays('FINE\nMoving.')).toEqual({ word: 'fine', rest: 'Moving.' })
  expect(overseerSays('**WRONG**: the fixture is stale')).toEqual({ word: 'wrong', rest: 'the fixture is stale' })
  expect(overseerSays('FINE\n`node build.js` is running').rest).toBe('`node build.js` is running')
  expect(overseerSays('Faster. Run one file.')).toEqual({ word: 'faster', rest: 'Run one file.' })
  expect(overseerSays('Fineness of the check is low').word).toBe('unclear')
  expect(overseerSays('Nothing is wrong')).toEqual({ word: 'unclear', rest: 'Nothing is wrong' })
  expect(overseerSays('  \n ').word).toBe('silent')
})

inRun('another running agent still holds Auto-continue', async ({ $, eng, clock }) => {
  eng.setAgents([{ id: 'other', status: 'running', description: 'a helper', name: undefined } as any])
  const before = eng.submitted.length
  await endTurn($)
  await clock.advance(1)
  expect(eng.submitted.slice(before).join('\n')).not.toMatch(/locked and not finished/)
})

inRun('a running overseer does not keep the clock going once the main chat stops', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  await endTurn($)
  await until(clock, () => runOf(eng).tasks?.service?.visits?.at(-1)?.to !== undefined)
})

// ---- the stuck look ----

// Claude reads the same file n times; the stuck notes those reads carried.
const circle = async ($: any, n: number) => {
  const notes: string[] = []
  for (let i = 0; i < n; i++) {
    const note = String((await $.tool.call({ tool: 'Read', file_path: REFUND })).context ?? '')
    if (/Stuck:/.test(note)) notes.push(note)
  }
  return notes
}
// The check fails, then Claude reads the same file again and again: the detector marks the state stuck, and eight calls
// on, with health still low, sends a second note.
async function stuckTwice($: any, eng: ReturnType<typeof engine>) {
  eng.setBash({ fail: true, text: 'Tests: 1 failed\nexpected 49.99, received 50.00' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- refund' })
  const notes: string[] = []
  for (let i = 0; i < 24 && notes.length < 2; i++) notes.push(...(await circle($, 1)))
  expect(notes).toHaveLength(2)
  return notes
}
const finished = (eng: ReturnType<typeof engine>) => eng.setAgents(eng.agents().map(a => ({ ...a, status: 'completed' })))

// 10
inRun('a stuck mark\'s second note starts a look at once, and no longer tells Claude to escalate', async ({ $, eng }) => {
  const [first, second] = await stuckTwice($, eng)
  expect(first).not.toMatch(/escalate|overseer/)
  expect(eng.spawns).toHaveLength(1)
  expect(eng.spawns[0]).toMatchObject({ subagent_type: 'Explore', model: 'opus', description: 'overseer service' })
  expect(second).toMatch(/This is note 2\./)
  expect(second).toMatch(/asked its overseer/)
  expect(second).not.toMatch(/escalate/)
})

// 11
inRun('a stuck look answers only WRONG or FINE, and its prompt holds what the stuck mark is about', async ({ $, eng }) => {
  await stuckTwice($, eng)
  const prompt = eng.spawns[0].prompt
  expect(prompt).toMatch(/WRONG/)
  expect(prompt).toMatch(/FINE/)
  expect(prompt).not.toMatch(/FASTER/)
  expect(prompt).toMatch(/Read only/)
  expect(prompt).toMatch(/drift/)
  expect(prompt).toMatch(/reading the same things again/)
  expect(prompt).toMatch(/fails "expected 49\.99, received 50\.00" on 1 run/)
  expect(prompt).toMatch(/2 stuck notes/)
  // The last eight calls, each with what the detector made of it, and how many there were in all: a live look took the
  // eight for the whole visit.
  expect(prompt.match(/refund\.ts · repeat/g)).toHaveLength(8)
  expect(prompt).toMatch(/last 8 of 1[0-9] calls in this state/)
})

// 12
inRun('FINE on a stuck look lifts the stuck mark for the rest of the visit, and tells Claude', async ({ $, eng, clock }) => {
  await stuckTwice($, eng)
  await fromAgent($, eng.agents()[0]!.id, 'FINE\nIt reads the fixture each time to compare the outputs.')
  await clock.advance(1)
  const note = await toolNote($)
  expect(note).toMatch(/moving/)
  expect(note).toMatch(/compare the outputs/)
  const r = await runNow(eng, clock)
  expect(r.traps).toHaveLength(1)
  expect(r.traps[0].end).toBeDefined()
  // More circling in this visit opens no new mark and carries no note.
  expect(await circle($, 20)).toEqual([])
  expect((await runNow(eng, clock)).traps).toHaveLength(1)
  await until(clock, () => logOf(eng).some(l => l.startsWith('service · overseer: fine')))
})

// 13
inRun('WRONG on a stuck look reaches Claude, and a FASTER said anyway counts as WRONG', async ({ $, eng, clock }) => {
  await stuckTwice($, eng)
  await fromAgent($, eng.agents()[0]!.id, 'FASTER\nThe same assertion fails each time; the rounding is in money.ts.')
  await clock.advance(1)
  const note = await toolNote($)
  expect(note).toMatch(/^\[sentinel\]/m)
  expect(note).toMatch(/says it is stuck/)
  expect(note).toMatch(/the rounding is in money\.ts/)
  expect(note).not.toMatch(/escalate/)
  expect(eng.toasts.join('\n')).toMatch(/overseer/i)
  expect((await runNow(eng, clock)).traps[0].end).toBeUndefined()
  await until(clock, () => logOf(eng).some(l => l.startsWith('service · overseer: wrong')))
})

// 14
inRun('a stuck look uses up no time mark, so the 30-minute look still comes', async ({ $, eng, clock }) => {
  await stuckTwice($, eng)
  const id = eng.agents()[0]!.id
  finished(eng)
  await fromAgent($, id, 'WRONG\nStuck on the rounding.')
  await minutes(clock, 31)
  await until(clock, () => eng.spawns.length === 2)
  expect(eng.spawns[1].prompt).toMatch(/FASTER/)
})

// 15
inRun('with the overseer switched off, the second note starts no look and says none started', async ({ $, eng }) => {
  const [, second] = await stuckTwice($, eng)
  expect(eng.spawns).toHaveLength(0)
  expect(second).toMatch(/This is note 2\./)
  expect(second).not.toMatch(/overseer|escalate/)
}, $ => $.command.run({ command: 'sentinel', args: 'off overseer' }))

inRun('no stuck look starts beside a running look; the next note starts one, and one mark gets one look', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.spawns.length)
  const [, second] = await stuckTwice($, eng)
  expect(eng.spawns).toHaveLength(1)
  expect(second).not.toMatch(/overseer/)
  finished(eng)
  await fromAgent($, eng.agents()[0]!.id, 'FINE')
  // Note 3 comes eight calls on and starts the stuck look.
  expect(await circle($, 8)).toHaveLength(1)
  expect(eng.spawns).toHaveLength(2)
  expect(eng.spawns[1].prompt).not.toMatch(/FASTER/)
  finished(eng)
  await fromAgent($, eng.agents()[1]!.id, 'WRONG\nStill the rounding.')
  // Note 4 starts none: this mark had its look.
  expect(await circle($, 8)).toHaveLength(1)
  expect(eng.spawns).toHaveLength(2)
})

// 16
inRun('an answer about a stuck mark that has since ended tells Claude nothing', async ({ $, eng, clock }) => {
  await stuckTwice($, eng)
  eng.setBash({ fail: false, text: 'ok' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- refund' })
  expect((await runNow(eng, clock)).traps[0].end).toBeDefined()
  await fromAgent($, eng.agents()[0]!.id, 'WRONG\nThe rounding is off.')
  await clock.advance(1)
  expect(await toolNote($)).not.toMatch(/overseer/i)
  await until(clock, () => logOf(eng).some(l => l.startsWith('service · overseer: wrong')))
})

// 17: a live look's answer was kept cut at 140 characters, mid-word, and the step's page showed it so.
inRun("a look keeps the overseer's whole answer, while the log keeps a short line", async ({ $, eng, clock }) => {
  await stuckTwice($, eng)
  const answer = 'It has read src/refund.js eight times and never edited it. `git diff` is empty, and `npm test` has run only once. The bug is on one line. src/refund.js rounds to tenths. Round to cents instead, then run `npm test`.'
  await fromAgent($, eng.agents()[0]!.id, `WRONG\n${answer}`)
  const r = await runNow(eng, clock)
  expect(r.looks[0].line).toBe(answer)
  expect(r.log.find((l: any) => l.text.startsWith('service · overseer: wrong')).text.length).toBeLessThan(200)
})

// 17
inRun('a stuck look is kept with its mark and answer, and how long the state took to move on after it', async ({ $, eng, clock }) => {
  await stuckTwice($, eng)
  const trap = (await runNow(eng, clock)).traps[0].step
  await fromAgent($, eng.agents()[0]!.id, 'WRONG\nThe rounding is off.')
  expect((await runNow(eng, clock)).looks).toEqual([{ state: 'service', why: 'stuck', trap, at: expect.any(Number), word: 'wrong', line: 'The rounding is off.' }])
  eng.setBash({ fail: false, text: 'ok' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- refund' })
  expect(said(await plan($, { action: 'advance', to: 'docs', outcome: 'Refunds round to the cent.' }))).toMatch(/Moved to docs/)
  expect((await runNow(eng, clock)).looks[0].toAdvanceMin).toBe(0)
})

inRun('an answer about a state that has finished goes to the log only', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  const id = eng.agents()[0]!.id
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'a', new_string: 'b' })
  eng.setBash({ fail: false, text: 'ok' })
  expect(said(await plan($, { action: 'advance', to: 'docs', outcome: 'Done.' }))).toMatch(/Moved to docs/)
  await fromAgent($, id, 'WRONG\nThe same test has failed nine times.')
  await clock.advance(1)
  expect(await toolNote($)).not.toMatch(/nine times/)
  expect(eng.submitted.join('\n')).not.toMatch(/nine times/)
  await until(clock, () => logOf(eng).includes('service · overseer: wrong · The same test has failed nine times.'))
})

inRun('its calls stay out of the ledger', async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  const id = eng.agents()[0]!.id
  await clock.advance(1)
  const calls = runOf(eng).calls?.length ?? 0
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/money.ts`, agentId: id })
  await $.tool.call({ tool: 'Bash', command: 'git log', agentId: id })
  await clock.advance(1)
  expect(runOf(eng).calls?.length ?? 0).toBe(calls)
})

inRun("its hand-back is dropped, and the reason says what it found", async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  const id = eng.agents()[0]!.id
  await fromAgent($, id, 'FINE')
  const out = await handBack($, id)
  expect(out.drop).toMatch(/overseer: fine/)
  expect(eng.submitted.join('\n')).not.toMatch(/agent-message/)
})

inRun("another agent's hand-back and what the user typed are left alone", async ({ $, eng, clock }) => {
  await minutes(clock, 31)
  await until(clock, () => eng.agents().length)
  const id = eng.agents()[0]!.id
  expect((await handBack($, 'somebody-else')).drop).toBeUndefined()
  expect((await handBack($, id, 'composer')).drop).toBeUndefined()
})

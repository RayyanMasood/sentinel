// While a plan runs, a skill runs only if the plan lists it (on the state or plan-wide) or the user named it, and another
// plugin's after-edit note reaches Claude only if it names something allowed. Held notes go in the plan log.
import { expect, mock } from 'claude-code/testing'
import { REFUND, ROOT, TOOL, engine, said, test } from './kit'

const PLAN = {
  action: 'define', title: 'Refund screen',
  skills: ['ponytail:ponytail-review'],
  states: [
    { id: 'explore', label: 'Read the code' },
    { id: 'api', label: 'Refund endpoint', check: 'npm test -- api', files: ['api/*.ts'], needs: ['explore'], skills: ['anthropic-skills:pdf'] },
    { id: 'ui', label: 'Refund screen', check: 'npm test -- ui', files: ['ui/**'], needs: ['explore'], skills: ['impeccable:impeccable'] },
  ],
}
const RUN = `${ROOT}/.sentinel/run.json`
// impeccable's after-edit note, as the real engine hands it over.
const NOTE = { type: 'hook_additional_context', origin: { kind: 'hook', event: 'PostToolUse' }, text: 'PostToolUse:Write hook additional context: [impeccable@1] Design hook scanned ui/refund.html. 2 findings.' }
// The engine beneath: a skill loads, and an attachment goes out as it is.
const below = (on: any) => {
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'Loaded.' }))
  on('prompt.attachment', (_: unknown, e: any) => ({ text: e.text }))
}
async function atApi($: any, on: any) {
  const clock = mock.clock(on)
  const eng = engine(on)
  below(on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(said(await $.tool.call({ tool: TOOL, ...PLAN }))).toMatch(/Locked/)
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  await $.tool.call({ tool: TOOL, action: 'advance', to: 'api', evidence: 'read it' })
  return { clock, eng }
}
const skill = async ($: any, name: string, agentId?: string) => said(await $.tool.call({ tool: 'Skill', skill: name, ...(agentId ? { agentId } : {}) }))
const typed = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } })
const log = async ($: any, eng: any) => {
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: TOOL, action: 'status' })
  return JSON.parse(eng.files[RUN]!).log.map((l: any) => l.text).join('\n')
}

test('a skill the plan lists for the active state goes through, and one listed for another state is held', async ($: any, on: any) => {
  const { eng } = await atApi($, on)
  expect(await skill($, 'anthropic-skills:pdf')).not.toMatch(/Sentinel holds/)
  const held = await skill($, 'impeccable:impeccable')
  expect(held).toMatch(/Sentinel holds the skill "impeccable:impeccable"/)
  expect(held).toMatch(/they allow it by naming it/)
  expect(await log($, eng)).toMatch(/Held the skill impeccable:impeccable/)
  // The active state's own list shows in its text.
  expect(said(await $.tool.call({ tool: TOOL, action: 'status' }))).toMatch(/Skills you may use here: ponytail:ponytail-review, anthropic-skills:pdf/)
})

test('a plan-wide skill goes through in every state', async ($: any, on: any) => {
  await atApi($, on)
  expect(await skill($, 'ponytail:ponytail-review')).not.toMatch(/Sentinel holds/)
})

test('a skill the user named goes through, by its plugin or its own name, and an unnamed one is held', async ($: any, on: any) => {
  await atApi($, on)
  expect(await skill($, 'ponytail:ponytail-audit')).toMatch(/Sentinel holds/)
  await typed($, 'Run the ponytail-audit on this when you get a chance.')
  expect(await skill($, 'ponytail:ponytail-audit')).not.toMatch(/Sentinel holds/)
  await typed($, 'And use impeccable for the screen.')
  expect(await skill($, 'impeccable:impeccable')).not.toMatch(/Sentinel holds/)
  // A word inside another word doesn't name it: "ponytail-audit" doesn't name a skill called ponytail.
  expect(await skill($, 'ponytail:ponytail')).toMatch(/Sentinel holds/)
})

test('with the plan paused, or no plan, every skill goes through', async ($: any, on: any) => {
  await atApi($, on)
  await $.command.run({ command: 'sentinel', args: 'pause' })
  expect(await skill($, 'claude-api')).not.toMatch(/Sentinel holds/)
})

test('skills are fixed at the lock: amend and a mid-run revise refuse them', async ($: any, on: any) => {
  await atApi($, on)
  expect(said(await $.tool.call({ tool: TOOL, action: 'amend', skills: ['claude-api'], reason: 'x' }))).toMatch(/Skills are set when the plan locks/)
  const revise = { action: 'revise', order: ['explore', 'api', 'docs', 'ui'], states: [{ id: 'docs', label: 'Docs', files: ['docs/**'], added: 'Docs.', skills: ['claude-api'] }] }
  expect(said(await $.tool.call({ tool: TOOL, ...revise }))).toMatch(/Skills are set when the plan locks/)
})

test("another plugin's after-edit note is held and logged, and goes through once it names something allowed", async ($: any, on: any) => {
  const { eng } = await atApi($, on)
  expect((await $.prompt.attachment(NOTE)).text).toBeNull()
  expect(await log($, eng)).toMatch(/Held impeccable's PostToolUse note: PostToolUse:Write hook additional context: \[impeccable@1\] Design hook scanned/)
  // A start-up note and Sentinel's own context are never held.
  const start = { type: 'hook_success', origin: { kind: 'hook', event: 'SessionStart' }, text: 'CAVEMAN MODE ACTIVE' }
  expect((await $.prompt.attachment(start)).text).toBe('CAVEMAN MODE ACTIVE')
  await typed($, 'Keep impeccable on for the screen work.')
  expect((await $.prompt.attachment(NOTE)).text).toBe(NOTE.text)
})

test("a helper's skill call is checked against the helper's own state", async ($: any, on: any) => {
  const { eng } = await atApi($, on)
  await $.command.run({ command: 'sentinel', args: 'parallel on' })
  // ui needs nothing but explore, so it gets a member beside api.
  const out = said(await $.tool.call({ tool: TOOL, action: 'brief', to: 'ui', brief: 'Build the refund screen.' }))
  expect(out).toMatch(/Started a member agent for ui/)
  const agent = eng.agents().at(-1)!.id
  expect(await skill($, 'impeccable:impeccable', agent)).not.toMatch(/Sentinel holds/)
  expect(await skill($, 'anthropic-skills:pdf', agent)).toMatch(/Sentinel holds/)
})

test('the draft shows each state\'s skills and the plan-wide ones', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  below(on)
  await $.command.run({ command: 'sentinel', args: 'lock' })
  await clock.settle()
  await $.tool.call({ tool: TOOL, ...PLAN })
  await clock.settle()
  const draft = eng.snap()
  expect(draft.skills).toEqual(['ponytail:ponytail-review'])
  expect(draft.states.find((s: any) => s.id === 'ui').skills).toEqual(['impeccable:impeccable'])
})

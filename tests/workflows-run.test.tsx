// A step's workflow while the plan runs: the Workflow gate, each agent as it starts, its edits, its spend, and the
// auto-continue hold. Run with `node tests/only.mjs workflows-run`.
//
// How this can fail, and where each is tested below:
//  1. A Workflow call is held in the step with an approved workflow, or goes through in another step when the user
//     hasn't named a workflow; or it's held at all with the switch off.
//  2. An agent isn't tied to its step: by the Workflow call's id, else the run's id, else the active step.
//  3. The cap counts per run instead of per step, lets the agent past N start, or counts one the engine refused.
//  4. An agent with no model, or a dearer one, runs on it; a cheaper one gets raised; the prompt doesn't name the step.
//  5. A workflow the user named in a step without one gets a cap, a ceiling or the prompt line.
//  6. An agent of a step's workflow edits a file, or does once Claude advances to a step whose files allow it; or amend
//     gives the step files.
//  7. A workflow agent's response doesn't add its tokens, cost and request to its run, or another agent's does.
//  8. Auto-continue pushes while a workflow runs past 30 minutes.
//  9. workflow-authoring is held in the approved step, or goes through in another.
// 10. A member is briefed for a step with an approved workflow.
import { expect, mock } from 'claude-code/testing'
import { WORKFLOWS, emptyRun, summarize } from '../hooks/core'
import { costOf } from '../hooks/usage'
import type { Run } from '../types'
import { ROOT, TOOL, endTurn, engine, openPage, said, test, until } from './kit'

const MIN = 60_000
const WF = { agents: 3, model: 'sonnet', why: 'Three reports can be read alone, and it takes about two hours.' }
const SCAN = { id: 'scan', label: 'Scan', files: [] as string[], workflow: WF }
const FORM = { id: 'form', label: 'Form', check: 'npm test -- form', files: ['src/**'] }
const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 }

// A locked plan, the workflow kept on the draft, the switch on unless `off`.
async function session($: any, on: any, { states = [SCAN, FORM] as object[], off = false } = {}) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('tool.call', { tool: 'Workflow' }, () => ({ result: { runId: 'wf_1', taskId: 't1' }, text: 'Workflow started' }))
  on('tool.call', { tool: 'Skill' }, () => ({ result: {}, text: 'Skill loaded' }))
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  if (!off) eng.files[`${ROOT}/.sentinel/library.json`] = JSON.stringify({ on: { [WORKFLOWS]: true } })
  const drafted = () => (JSON.parse(eng.files[`${ROOT}/.sentinel/draft.json`] ?? '{}') as Run).draft
  const running = () => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run
  await $.command.run({ command: 'sentinel', args: 'lock' })
  await openPage($, clock)
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states })
  await until(clock, () => !!drafted()?.plan && eng.snap().draftKey)
  if (!off) {
    eng.page({ kind: 'wfrow', draft: eng.snap().draftKey, state: 'scan', keep: true })
    await until(clock, () => drafted()!.plan!.states.find(s => s.id === 'scan')!.workflow?.ok)
  }
  await $.command.run({ command: 'sentinel', args: 'lock' })
  await until(clock, () => running().plan?.lockedAt)
  let calls = 0
  const s = {
    eng, clock, running,
    runs: () => running().workflows ?? [],
    log: () => running().log.map(l => l.text),
    pushes: () => eng.submitted.filter((t: string) => /Auto-continue/.test(t)),
    typed: (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } }),
    // The Workflow tool call that starts a run.
    workflow: async (id = `call-${++calls}`) => said(await $.tool.call({ tool: 'Workflow', tool_use_id: id, script: 'export const meta = { name: "scan" }' })),
    // A workflow agent starting, as the engine raises it.
    spawn: (o: object = {}) => $.agent.spawn({
      tool_use_id: 'call-1', prompt: 'Read report 1 and list its findings.', description: 'report 1', subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, model: 'sonnet',
      workflow: { runId: 'wf_1', agentIndex: 1 }, ...o,
    }),
    advance: (to: string) => $.tool.call({ tool: TOOL, action: 'advance', to, evidence: 'Read the three reports.', outcome: 'Read the reports.' }),
    step: async (agentId?: string) => {
      for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'sonnet', effort: 'high', messageCount: 1, ...(agentId ? { agentId } : {}) })) { /* the chunks */ }
      await clock.advance(10)
    },
  }
  return s
}

test('the Workflow call goes through in the step with an approved workflow, and is held in another unless the user names one', async ($: any, on: any) => {
  const s = await session($, on)
  expect(await s.workflow()).toBe('Workflow started')
  expect(said(await s.advance('form'))).toMatch(/Moved to form/)
  expect(await s.workflow()).toMatch(/Sentinel holds the Workflow call: form has no workflow the user approved/)
  await until(s.clock, () => s.log().includes('Held a Workflow call in form'))
  await s.typed('Use a workflow to check the forms.')
  expect(await s.workflow()).toBe('Workflow started')
})

test("a workflow's result naming a workflow doesn't count as the user naming one", async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow()
  await s.advance('form')
  await $.prompt.submit({ text: '<task-notification><task-id>t1</task-id>The workflow "scan" finished.</task-notification>', origin: { kind: 'task-notification' } })
  expect(await s.workflow()).toMatch(/holds the Workflow call/)
})

test("a helper's Workflow call is held in a step without an approved workflow", async ($: any, on: any) => {
  const s = await session($, on)
  await s.advance('form')
  expect(said(await $.tool.call({ tool: 'Workflow', tool_use_id: 'call-h', script: '', agentId: 'helper-1' }))).toMatch(/Sentinel holds the Workflow call: form has no workflow/)
})

test('with the switch off, a Workflow call is never held', async ($: any, on: any) => {
  const s = await session($, on, { off: true })
  expect(await s.workflow()).toBe('Workflow started')
})

test('two runs in the step share the approved count, and the agent past it is refused', async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow('call-1')
  expect(said(await s.spawn())).not.toMatch(/holds/)
  expect(said(await s.spawn({ workflow: { runId: 'wf_1', agentIndex: 2 } }))).not.toMatch(/holds/)
  await s.workflow('call-2')
  expect(said(await s.spawn({ tool_use_id: 'call-2', workflow: { runId: 'wf_2', agentIndex: 1 } }))).not.toMatch(/holds/)
  const past = await s.spawn({ tool_use_id: 'call-2', workflow: { runId: 'wf_2', agentIndex: 2 } })
  expect(past.deny).toBe("Sentinel holds this step's workflow to 3 agents, as approved.")
  expect(s.eng.spawns).toHaveLength(3)
  await until(s.clock, () => s.runs().length === 2)
  expect(s.runs().map(w => [w.state, w.runId, w.agents.length, w.refused])).toEqual([['scan', 'wf_1', 2, 0], ['scan', 'wf_2', 1, 1]])
})

test('an agent the engine refused frees its place in the count', async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow('call-1')
  s.eng.setSpawnDeny('As many agents run as the session allows.')
  expect((await s.spawn()).deny).toMatch(/as the session allows/)
  s.eng.setSpawnDeny(undefined)
  for (const i of [2, 3, 4]) expect((await s.spawn({ workflow: { runId: 'wf_1', agentIndex: i } })).deny).toBeUndefined()
  expect((await s.spawn({ workflow: { runId: 'wf_1', agentIndex: 5 } })).deny).toMatch(/to 3 agents/)
})

test('an agent ties to its run by the run id when its call is unknown, else to the active step', async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow('call-1')
  await s.spawn()
  // A resumed run: no call id, the same run id.
  await s.spawn({ tool_use_id: '', workflow: { runId: 'wf_1', agentIndex: 2 } })
  // A run the gate never saw: the active step's.
  await s.spawn({ tool_use_id: '', workflow: { runId: 'wf_9', agentIndex: 1 } })
  expect((await s.spawn({ tool_use_id: '', workflow: { runId: 'wf_9', agentIndex: 2 } })).deny).toMatch(/to 3 agents/)
  await until(s.clock, () => s.runs().length === 2)
  expect(s.runs().map(w => [w.state, w.runId, w.agents.length])).toEqual([['scan', 'wf_1', 2], ['scan', 'wf_9', 1]])
})

test('an agent with no model or a dearer one runs on the approved model, a cheaper one keeps its own, and each prompt names the step', async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow('call-1')
  await s.spawn({ model: undefined })
  await s.spawn({ model: 'opus', workflow: { runId: 'wf_1', agentIndex: 2 } })
  await s.spawn({ model: 'haiku', workflow: { runId: 'wf_1', agentIndex: 3 } })
  expect(s.eng.spawns.map((e: any) => e.model)).toEqual(['sonnet', 'sonnet', 'haiku'])
  await until(s.clock, () => s.log().some(t => /asked for opus/.test(t)))
  expect(s.log()).toContain("In scan's workflow wf_1, an agent that asked for opus runs on sonnet")
  expect(s.log()).toContain("In scan's workflow wf_1, an agent that named no model runs on sonnet")
  expect(s.eng.spawns[0].prompt).toMatch(/^Read report 1 and list its findings\./)
  expect(s.eng.spawns[0].prompt).toMatch(/Sentinel: you are an agent of the workflow the user approved for the step scan\. Only read: don't edit or write files\./)
})

test('a workflow the user named in a step without one runs uncapped on what it asks for, and is kept as a run of that step', async ($: any, on: any) => {
  const s = await session($, on)
  await s.advance('form')
  await s.typed('Run a workflow over the forms.')
  await s.workflow('call-5')
  for (const i of [1, 2, 3, 4]) expect((await s.spawn({ tool_use_id: 'call-5', model: 'opus', workflow: { runId: 'wf_5', agentIndex: i } })).deny).toBeUndefined()
  expect(s.eng.spawns.map((e: any) => e.model)).toEqual(['opus', 'opus', 'opus', 'opus'])
  expect(s.eng.spawns[0].prompt).toBe('Read report 1 and list its findings.')
  await until(s.clock, () => s.runs()[0]?.agents.length === 4)
  expect(s.runs()[0]!.state).toBe('form')
})

test("an agent of the step's workflow can't edit, even after Claude advances to a step whose files allow it", async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow('call-1')
  const { agentId } = await s.spawn()
  const edit = (by?: string) => $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/form.ts`, old_string: 'a', new_string: 'b', ...(by ? { agentId: by } : {}) })
  expect((await edit(agentId)).deny).toBeDefined()
  await s.advance('form')
  expect((await edit(agentId)).deny).toMatch(/scan/)
  // The main conversation's edit of the same file, now in form, goes through.
  expect((await edit()).deny).toBeUndefined()
})

test('amend gives a step with a workflow no files', async ($: any, on: any) => {
  await session($, on)
  expect(said(await $.tool.call({ tool: TOOL, action: 'amend', files: ['src/**'], reason: 'The scan writes notes.' }))).toBe('A step with a workflow lists no files: its agents only read.')
})

test("each response of a workflow agent adds its tokens, cost and a request to its run, and no one else's does", async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow('call-1')
  const { agentId } = await s.spawn()
  await s.step(agentId)
  await s.step(agentId)
  await s.step()
  await s.step('someone-else')
  await until(s.clock, () => s.runs()[0]?.agents[0]?.requests === 2)
  const w = s.runs()[0]!
  expect(w.tokens).toEqual({ input: 2000, output: 400, cacheRead: 10000, cacheWrite: 4000 })
  expect(Math.abs(w.usd - 2 * costOf(USAGE, USAGE.model)!)).toBeLessThan(1e-9)
})

test('auto-continue waits for a workflow that runs past 30 minutes, at the stop and at a later stop beside it', async ($: any, on: any) => {
  const s = await session($, on)
  await s.workflow('call-1')
  const wf = [{ id: 'wf-task', type: 'workflow', status: 'running', description: 'scan', name: 'scan' }]
  await $.turn.start({ text: '', turnId: 't' })
  await endTurn($, { tasks: wf, answer: 'The scan runs.' })
  await s.clock.advance(31 * MIN)
  await s.clock.settle()
  expect(s.pushes()).toHaveLength(0)
  // Claude stops again with the run still going.
  await $.turn.start({ text: '', turnId: 't' })
  await endTurn($, { tasks: wf, answer: 'Still waiting on the scan.' })
  await s.clock.settle()
  expect(s.pushes()).toHaveLength(0)
})

test('workflow-authoring runs in the step with an approved workflow, and is held in another', async ($: any, on: any) => {
  const s = await session($, on)
  const skill = () => $.tool.call({ tool: 'Skill', skill: 'workflow-authoring' })
  expect(said(await skill())).toBe('Skill loaded')
  await s.advance('form')
  expect(said(await skill())).toMatch(/holds the skill "workflow-authoring"/)
})

// The step's page reads this. How it can fail: the limits or estimate are missing; a run the engine refused before any
// agent shows; the step's count or spend leaves a run out or takes another step's in; a run's models, tokens or
// requests per agent are wrong; a workflow the user named gets limits it never had.
test("the view of a step's workflows: the limits and estimate, each run with its agents, spend, tokens and requests", () => {
  const T = { input: 1200, output: 30000, cacheRead: 900000, cacheWrite: 120000 }, NONE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const r = {
    ...emptyRun(), active: 'scan',
    plan: { title: 'P', loops: [], states: [{ ...SCAN, workflow: { ...WF, model: 'sonnet' as const, ok: true as const } }, FORM] },
    workflows: [
      { state: 'scan', call: 'c1', runId: 'wf_1', agents: [{ id: 'a', model: 'claude-sonnet-5-5', requests: 12 }, { id: 'b', model: 'claude-haiku-5-5', requests: 4 }], refused: 0, usd: 3.1, tokens: T },
      { state: 'scan', call: 'c2', runId: 'wf_2', agents: [{ id: 'c', model: 'claude-sonnet-5-5', requests: 7 }], refused: 2, usd: 1.25, tokens: T },
      { state: 'scan', call: 'c3', agents: [], refused: 0, usd: 0, tokens: NONE },
      { state: 'form', call: 'c4', runId: 'wf_4', agents: [{ id: 'd', model: 'opus', requests: 2 }], refused: 0, usd: 0.5, tokens: T },
    ],
  } as unknown as Run
  const run = (runId: string, started: number, refused: number, models: string[], usd: string, requests: number[]) => ({ runId, started, refused, models, usd, tokens: T, requests })
  expect(summarize(r).workflows).toEqual({
    scan: { approved: { agents: 3, model: 'sonnet', usd: '$4.80', upTo: '$9.30' }, started: 3, spent: '$4.35', runs: [
      run('wf_1', 2, 0, ['claude-sonnet-5-5', 'claude-haiku-5-5'], '$3.10', [12, 4]),
      run('wf_2', 1, 2, ['claude-sonnet-5-5'], '$1.25', [7]),
    ] },
    form: { started: 1, spent: '$0.50', runs: [run('wf_4', 1, 0, ['opus'], '$0.50', [2])] },
  })
  // A step with an approved workflow and no run yet shows its limits.
  expect(summarize({ ...r, workflows: [] } as Run).workflows).toEqual({ scan: { approved: { agents: 3, model: 'sonnet', usd: '$4.80', upTo: '$9.30' }, started: 0, spent: '$0.00', runs: [] } })
})

test('a step with an approved workflow gets no member', async ($: any, on: any) => {
  const s = await session($, on, { states: [FORM, { ...SCAN, needs: [] }] })
  await $.command.run({ command: 'sentinel', args: 'parallel on' })
  await s.clock.settle()
  expect(said(await $.tool.call({ tool: TOOL, action: 'brief', to: 'scan', brief: 'Read the three reports.' }))).toBe('scan runs the workflow the user approved, so you do it yourself when it comes up: a member agent can\'t start one.')
})

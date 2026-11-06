// Sentinel's own questions go through the engine's question dialog: the approval stops (a state that asks before it starts
// or after it is done) and a part the user signed off on that Claude wants to drop. The user's OK is the Yes label or the
// dashboard's Approve, and nothing else: a typed message goes to Claude and leaves the stop closed.
// The dialog is the kit's: a test answers it with a label, with words (Other), or with Esc (a rejection).
import { expect, mock } from 'claude-code/testing'
import { act, answered, emptyRun, heard, summarize, type PlanInput } from '../hooks/core'
import type { Run } from '../types'
import { REFUND, ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const ESC = Symbol('esc')
type Asked = { question: string; header?: string; options: { label: string }[] }

// The dialog answers each question with what `how` returns: a label or words, or ESC for a dismissed dialog.
function dialog(eng: ReturnType<typeof engine>, how: (q: Asked) => string | typeof ESC) {
  const seen: Asked[] = []
  eng.setDialog(async (e: any) => {
    const q = e.questions[0] as Asked
    seen.push(q)
    const a = how(q)
    if (a === ESC) return { deny: 'The user dismissed the question' }
    return { result: { questions: e.questions, answers: { [q.question]: a } }, text: 'answered' }
  })
  return seen
}
const yes = (q: Asked) => q.options[0]!.label
const no = (q: Asked) => q.options[1]!.label

const AHEAD = [
  { id: 'look', label: 'Check the approach', wait: 'before', files: ['src/**'] },
  { id: 'build', label: 'Build the card form', files: ['src/**'] },
  { id: 'ship', label: 'Ship it' },
]
const REVIEWED = [
  { id: 'build', label: 'Build the card form', files: ['src/**'] },
  { id: 'review', label: 'Review the card form', wait: 'after' },
  { id: 'ship', label: 'Ship it' },
]
const call = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })
async function lock($: any, states: object[]) {
  await $.tool.call({ tool: 'ExitPlanMode' })
  await call($, { action: 'define', title: 'Take payment', states })
}
const edit = ($: any) => $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'original', new_string: 'changed' })
const INTENT = 'Read the ledger code, then pick a rounding.'
const propose = ($: any) => call($, { action: 'propose', intent: INTENT })
const toReview = async ($: any) => {
  await lock($, REVIEWED)
  await call($, { action: 'advance', to: 'review', evidence: 'the form charges a test card' })
}
const finish = ($: any) => call($, { action: 'advance', to: 'ship', evidence: 'the review state holds the form', outcome: 'The card form charges through the existing code.' })
const typed = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } })

// ---- the words ----

test('a proposal asks in the dialog, naming the state, quoting Claude and saying what each answer does', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.question).toBe(`Claude is ready to start Check the approach. It plans to:\n"${INTENT}"\nGo ahead?`)
  expect(seen[0]!.options.map(o => o.label)).toEqual(['Yes, go ahead', 'No, hold off'])
  expect(seen[0]!.header).toBe('Your OK')
  expect(eng.toasts).toContain('Sentinel: look asks for your OK before it starts')
})

test('finished work asks for a review in the dialog, with Claude\'s words quoted', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  await toReview($)
  await finish($)
  expect(seen[0]!.question).toBe('Review the card form is finished and ready for your review.\nClaude says: "The card form charges through the existing code."\nAccept it?')
  expect(seen[0]!.options.map(o => o.label)).toEqual(['Yes, accept it', 'No, it needs changes'])
})

test('Claude\'s words in a question are cut at a length that fits the box', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  await lock($, AHEAD)
  await call($, { action: 'propose', intent: 'Plan. '.repeat(400) })
  expect(seen[0]!.question.length).toBeLessThan(700)
})

// ---- the proposal, every way the dialog can end ----

test('Yes opens the stop in the same call, and Claude is not told to stop its turn', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, yes)
  await lock($, AHEAD)
  const out = said(await propose($))
  expect(out).toMatch(/The user said yes\. Go ahead with look\./)
  expect(out).not.toMatch(/stop your turn/)
  expect(eng.memory.run!.pending).toMatchObject({ state: 'look', kind: 'before', ok: true })
  // The user answered, so the push-on count starts again.
  expect(eng.memory.run!.heardAt).toBeGreaterThan(0)
  expect(said(await edit($))).toBe('ok')
  expect(eng.memory.run!.audit.at(-1)).toMatchObject({ kind: 'decided', text: 'Approved the proposal in the dialog.' })
  expect(eng.memory.run!.log.at(-1)).toMatchObject({ icon: '✓', tone: 'ok', text: 'look · approved' })
  expect(eng.snap().waiting).toBeUndefined()
})

test('No closes the stop, drops the proposal and tells Claude what to do', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, no)
  await lock($, AHEAD)
  const out = said(await propose($))
  expect(out).toMatch(/said no to your proposal for look/)
  expect(out).toMatch(/Don't start it\./)
  expect(out).toMatch(/propose again/)
  expect(eng.memory.run!.pending).toBeUndefined()
  expect(eng.memory.run!.audit.at(-1)).toMatchObject({ kind: 'decided', text: 'Said no to the proposal in the dialog.' })
  expect(eng.memory.run!.log.at(-1)).toMatchObject({ icon: '?', tone: 'ask', text: 'look · said no' })
  expect(said(await edit($))).toMatch(/action "propose"/)
})

test('words under Other go to Claude as the answer, and the stop stays closed', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => 'What does that do to old refunds?')
  await lock($, AHEAD)
  const out = said(await propose($))
  expect(out).toContain('"What does that do to old refunds?"')
  expect(out).toMatch(/not a yes/)
  expect(said(await edit($))).toMatch(/action "propose"/)
  expect(eng.memory.run!.audit.find(a => a.kind === 'decided')).toMatchObject({ text: 'Answered the proposal in the dialog: What does that do to old refunds?' })
  expect(eng.memory.run!.log.find(l => l.text === 'look · answered')).toMatchObject({ icon: '?', tone: 'ask' })
})

test('long words under Other are cut before they reach Claude, and an empty reply is no answer', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => 'x'.repeat(600))
  await lock($, AHEAD)
  const out = said(await propose($))
  expect(out).toContain(`"${'x'.repeat(500)}"`)
  expect(out).not.toContain('x'.repeat(501))
  dialog(eng, () => '   ')
  expect(said(await propose($))).toMatch(/closed the question without answering/)
  expect(eng.memory.run!.pending).toMatchObject({ kind: 'before', ok: false })
})

test('only the exact Yes label typed under Other counts as a yes', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => 'yes')
  await lock($, AHEAD)
  expect(said(await propose($))).toMatch(/not a yes/)
  dialog(eng, () => 'Yes, go ahead')
  expect(said(await propose($))).toMatch(/said yes/)
  expect(said(await edit($))).toBe('ok')
})

test('Esc leaves the stop closed and waiting, and Claude is told to say it and stop', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  const out = said(await propose($))
  expect(out).toMatch(/closed the question without answering/)
  expect(out).toMatch(/stop your turn and wait/)
  expect(eng.memory.run!.pending).toMatchObject({ kind: 'before', ok: false })
  expect(said(await edit($))).toMatch(/waits for the user's answer to your proposal/)
  await until(clock, () => eng.snap().waiting)
  expect(eng.snap().waiting).toMatchObject({ kind: 'before', text: INTENT })
})

test('a typed message does not pass a stop: it goes to Claude and the stop stays closed, until the next call asks once more', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  await typed($, 'what does this mean?')
  expect(said(await edit($))).toMatch(/waits for the user's answer to your proposal/)
  expect(eng.memory.run!.pending).toMatchObject({ ok: false })
  expect(summarize(eng.memory.run!).waiting).toMatchObject({ kind: 'before' })
  // After a typed yes Claude proposes again and the dialog opens for one press.
  await typed($, 'yes, go ahead')
  expect(said(await edit($))).toMatch(/waits for the user's answer to your proposal/)
  const seen = dialog(eng, yes)
  expect(said(await propose($))).toMatch(/said yes/)
  expect(seen).toHaveLength(1)
  expect(said(await edit($))).toBe('ok')
})

test('hands-free opens no dialog and goes ahead as it does today', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  await lock($, AHEAD)
  await $.command.run({ command: 'sentinel', args: 'hands-free' })
  expect(said(await propose($))).toMatch(/hands-free, so go ahead/)
  expect(seen).toHaveLength(0)
})

// ---- finished work ----

test('Yes accepts the work and the advance goes through in the same call', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, yes)
  await toReview($)
  const out = said(await finish($))
  expect(out).toMatch(/The user accepted review\./)
  expect(out).toMatch(/Moved to ship/)
  expect(eng.memory.run!.active).toBe('ship')
  expect(eng.memory.run!.audit.some(a => a.text === 'Approved the work in the dialog.')).toBe(true)
})

test('No sends the work back: Claude is told it needs changes and the state stays', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, no)
  await toReview($)
  const sent = await finish($)
  expect(sent.deny ?? sent.isError).toBeTruthy()
  expect(said(sent)).toMatch(/says review needs changes/)
  expect(eng.memory.run!.active).toBe('review')
  expect(eng.memory.run!.pending).toBeUndefined()
})

test('words under Other on finished work are Claude\'s to answer, and the state stays', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => 'Where do the tests for the card form live?')
  await toReview($)
  const out = said(await finish($))
  expect(out).toContain('"Where do the tests for the card form live?"')
  expect(out).toMatch(/not an acceptance/)
  expect(eng.memory.run!.active).toBe('review')
})

test('Esc on finished work leaves it in review, and a typed yes does not move it', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => ESC)
  await toReview($)
  const closed = said(await finish($))
  expect(closed).toMatch(/closed the question without answering/)
  expect(closed).toMatch(/review stays in review/)
  await typed($, 'looks good')
  expect(eng.memory.run!.active).toBe('review')
  expect(eng.memory.run!.pending).toMatchObject({ kind: 'after', ok: false })
  // Claude advances again after the typed yes: the dialog opens again, and one press moves it.
  const seen = dialog(eng, yes)
  expect(said(await finish($))).toMatch(/Moved to ship/)
  expect(seen).toHaveLength(1)
})

// ---- the page ----

test('an answer from the page closes the dialog, and the call goes on as if the Yes label was pressed', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  await openPage($, clock)
  // The terminal dialog stays open: only the page answers.
  eng.setDialog(() => new Promise(() => {}))
  await lock($, AHEAD)
  const going = propose($)
  await until(clock, () => eng.snap().ask)
  const ask = eng.snap().ask
  expect(ask.questions[0].question).toMatch(/^Claude is ready to start Check the approach/)
  expect(ask).toMatchObject({ by: 'sentinel', state: 'look' })
  eng.page({ kind: 'ask', id: ask.id, answers: { [ask.questions[0].question]: 'Yes, go ahead' } })
  await until(clock, () => eng.memory.run!.pending?.ok === true)
  expect(said(await going)).toMatch(/said yes/)
  expect(said(await edit($))).toBe('ok')
  await until(clock, () => !eng.snap().ask)
})

test('without the dashboard the question is answered in the terminal and the page has nothing to show', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  dialog(eng, yes)
  await lock($, AHEAD)
  await propose($)
  await clock.advance(5)
  expect(eng.snap().ask).toBeUndefined()
})

test('Approve on the page after Esc opens the stop and tells Claude', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  await openPage($, clock)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  await until(clock, () => eng.snap().waiting)
  for (const t0 = Date.now(); Date.now() - t0 < 3;);
  eng.page({ kind: 'approve', state: 'look' })
  await until(clock, () => eng.submitted.some(t => /approved your proposal/.test(t)))
  expect(eng.memory.run!.pending).toMatchObject({ ok: true })
  expect(said(await edit($))).toBe('ok')
})

test('Claude\'s own question goes through untouched while Sentinel\'s is open', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  await openPage($, clock)
  let release: (v: unknown) => void = () => {}
  eng.setDialog((e: any) => {
    const q = e.questions[0].question as string
    // Sentinel's stays open. Claude's is answered at once.
    if (/^Claude is ready to start/.test(q)) return new Promise(done => (release = done))
    return Promise.resolve({ result: { questions: e.questions, answers: { [q]: 'b' } }, text: 'answered' })
  })
  await lock($, AHEAD)
  const going = propose($)
  await until(clock, () => eng.snap().ask)
  const questions = [{ question: 'Which table?', header: 'Table', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }]
  const out = await $.tool.call({ tool: 'AskUserQuestion', questions })
  expect(out.result.answers['Which table?']).toBe('b')
  // The stop's question is still the one the page shows.
  expect(eng.memory.run!.pending).toMatchObject({ kind: 'before', ok: false })
  release({ deny: 'The user dismissed the question' })
  await going
})

// ---- the band ----

test('after Esc the band shows an Answer button, and pressing it asks again and tells Claude the answer', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /look asks for your OK before it starts/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Answer' })).toBeDefined()
  const seen = dialog(eng, yes)
  await ui.press({ key: 'answer' })
  await until(clock, () => eng.memory.run!.pending?.ok === true)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.question).toMatch(/^Claude is ready to start Check the approach/)
  await until(clock, () => eng.submitted.some(t => /said yes/.test(t)))
  expect(eng.submitted.find(t => /said yes/.test(t))).toMatch(/Go ahead with look/)
  await ui.unmount()
})

test('the Answer button on finished work accepts it, and Claude is told to advance again', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  dialog(eng, () => ESC)
  await toReview($)
  await finish($)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /review is ready for your review/ })).toBeDefined()
  const seen = dialog(eng, yes)
  await ui.press({ key: 'answer' })
  await until(clock, () => eng.submitted.some(t => /accepted review/.test(t)))
  expect(eng.submitted.find(t => /accepted review/.test(t))).toMatch(/Call advance again\./)
  expect(eng.memory.run!.pending).toMatchObject({ kind: 'after', ok: true })
  await ui.unmount()
  // The advance goes through without asking a second time.
  expect(said(await finish($))).toMatch(/Moved to ship/)
  expect(seen).toHaveLength(1)
})

test('Esc on the Answer button changes nothing and tells Claude nothing', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  const seen = dialog(eng, () => ESC)
  await ui.press({ key: 'answer' })
  await until(clock, () => seen.length === 1)
  await clock.advance(50)
  expect(eng.submitted).toHaveLength(0)
  expect(eng.memory.run!.pending).toMatchObject({ ok: false })
  expect(await ui.find({ type: 'Button', text: 'Answer' })).toBeDefined()
  await ui.unmount()
})

test('words under Other on the Answer button go to Claude, and the stop closes until it proposes again', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  dialog(eng, () => 'Use the ledger rounding.')
  await ui.press({ key: 'answer' })
  await until(clock, () => eng.submitted.some(t => /Use the ledger rounding/.test(t)))
  expect(eng.submitted.find(t => /Use the ledger rounding/.test(t))).toMatch(/not a yes/)
  expect(eng.memory.run!.pending).toBeUndefined()
  await ui.unmount()
})

test('while the question is open the band does not offer to ask it again', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  let release: (v: unknown) => void = () => {}
  eng.setDialog(() => new Promise(done => (release = done)))
  await lock($, AHEAD)
  const going = propose($)
  await until(clock, () => eng.memory.run!.pending)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: 'Answer' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /look is asking for your OK/ })).toBeDefined()
  await ui.unmount()
  release({ deny: 'The user dismissed the question' })
  await going
})

test('pressing Answer twice at once opens one question, not two', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false }, surface: 'terminal' })
  const seen: Asked[] = []
  let release: (v: unknown) => void = () => {}
  eng.setDialog((e: any) => { seen.push(e.questions[0]); return new Promise(done => (release = done)) })
  const presses = Promise.allSettled([ui.press({ key: 'answer' }), ui.press({ key: 'answer' })])
  await until(clock, () => seen.length > 0)
  await clock.advance(50)
  expect(seen).toHaveLength(1)
  release({ deny: 'The user dismissed the question' })
  await presses
  await ui.unmount()
})

test('the plan pane says the proposal waits for the user\'s OK', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => ESC)
  await lock($, AHEAD)
  await propose($)
  const ui = await $.ui.mount({ plugin: 'sentinel', component: 'Pane', requestId: 'sentinel', props: { title: 'Sentinel', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /for your OK on its proposal/ })).toBeDefined()
  await ui.unmount()
})

test('the task clock stops while a question of Sentinel\'s waits for its answer, and runs again after', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  await mapped($, eng)
  const service = () => eng.snap().states.find((s: any) => s.id === 'service')
  const running = async (yes: boolean) => (await until(clock, () => (service().since !== undefined) === yes), (service().since !== undefined) === yes)
  await $.turn.start({ text: '', turnId: 't' })
  expect(await running(true)).toBe(true)
  let during: unknown = 'not asked'
  eng.setDialog(async () => {
    await running(false)
    during = service().since
    return { deny: 'The user dismissed the question' }
  })
  await dropGuide($)
  expect(during).toBeUndefined()
  expect(await running(true)).toBe(true)
})

// ---- the rule behind it ----

const T0 = Date.now()
const proposed = (): Run => {
  let r: Run = { ...emptyRun(), signedOff: true }
  const go = (i: object, at: number) => { const a = act(r, i as PlanInput, '09:00', {}, at); r = a.run; return a }
  go({ action: 'define', title: 'T', states: AHEAD }, T0)
  go({ action: 'propose', intent: INTENT }, T0 + 1_000)
  return r
}

test('a stop saved before this keeps the old rule: any message the user typed after it answers it', () => {
  const r = proposed()
  expect(r.pending!.ok).toBeUndefined()
  expect(answered(r)).toBe(false)
  expect(answered(heard(r, T0 + 9_000))).toBe(true)
})

test('a stop that carries the flag is answered by the flag alone', () => {
  const r = proposed()
  const strict: Run = { ...r, pending: { ...r.pending!, ok: false } }
  expect(answered(heard(strict, T0 + 9_000))).toBe(false)
  expect(answered({ ...strict, pending: { ...strict.pending!, ok: true } })).toBe(true)
  expect(answered({ ...strict, handsFree: true })).toBe(true)
})

// ---- a part the user signed off on ----

const SHOP = {
  name: 'Shop', actors: [],
  lines: [],
  parts: [
    { id: 'shop', name: 'Shop' },
    { id: 'refunds', parent: 'shop', name: 'Refunds', files: ['src/refund*.ts'] },
    { id: 'guide', parent: 'shop', name: 'Guide', files: ['guide/**'] },
  ],
}
const BUILD = [{ id: 'service', label: 'RefundService', files: ['src/refund*.ts'], parts: ['refunds'] }, { id: 'verify', label: 'Full suite' }]
async function mapped($: any, eng: ReturnType<typeof engine>) {
  eng.files[`${ROOT}/.sentinel/system.json`] = JSON.stringify({ version: 1, ...SHOP })
  await lock($, BUILD)
}
const dropGuide = ($: any, reason = 'Nobody reads it.') => call($, { action: 'map', drop: ['guide'], reason, system: { parts: [] } })
const mapParts = (eng: ReturnType<typeof engine>) => (JSON.parse(eng.files[`${ROOT}/.sentinel/system.json`]!).parts as { id: string }[]).map(p => p.id).sort()

test('dropping a part the user signed off on asks in the dialog, naming the part and quoting the reason', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, () => ESC)
  await mapped($, eng)
  await dropGuide($)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.question).toBe('Claude wants to stop building Guide, which you signed off on.\nClaude\'s reason: "Nobody reads it."\nIf you say yes, it comes off the map and shows under Changes at the finish.\nRemove it?')
  expect(seen[0]!.options.map(o => o.label)).toEqual(['Yes, remove it', 'No, keep it'])
})

test('Yes takes the part off the map', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, yes)
  await mapped($, eng)
  const out = said(await dropGuide($))
  expect(out).toMatch(/Map updated: took off guide \(Nobody reads it\.\)/)
  expect(mapParts(eng)).toEqual(['refunds', 'shop'])
  expect(eng.memory.run!.drawing!.locked!.parts.some(p => p.id === 'guide')).toBe(true)
})

test('No, words and Esc all leave the part where it is, and Claude hears which', async ($: any, on: any) => {
  const eng = engine(on)
  await mapped($, eng)
  dialog(eng, no)
  expect(said(await dropGuide($))).toMatch(/said no, so guide stays on the map\. Keep building it\./)
  dialog(eng, () => 'It is still used by support.')
  const words = said(await dropGuide($))
  expect(words).toContain('"It is still used by support."')
  expect(words).toMatch(/guide stays/)
  dialog(eng, () => ESC)
  expect(said(await dropGuide($))).toMatch(/closed the question without answering, so guide stays/)
  expect(mapParts(eng)).toEqual(['guide', 'refunds', 'shop'])
})

test('hands-free asks nothing and the part stays', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  await mapped($, eng)
  await $.command.run({ command: 'sentinel', args: 'hands-free' })
  expect(said(await dropGuide($))).toMatch(/guide is on the map the user locked, so only they can take it off/)
  expect(seen).toHaveLength(0)
})

test('a part a state builds, or a drop with no reason, asks nothing: the refusal comes first', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  await mapped($, eng)
  expect(said(await call($, { action: 'map', drop: ['refunds'], reason: 'x', system: { parts: [] } }))).toMatch(/refunds is on the map the user locked/)
  expect(said(await dropGuide($, ''))).toMatch(/needs "reason"/)
  expect(seen).toHaveLength(0)
})

test('a drop the model signs off itself is not taken: only the dialog opens the way', async ($: any, on: any) => {
  const eng = engine(on)
  dialog(eng, () => ESC)
  await mapped($, eng)
  expect(said(await call($, { action: 'map', drop: ['guide'], reason: 'Nobody reads it.', approved: ['guide'], system: { parts: [] } }))).toMatch(/closed the question/)
  expect(mapParts(eng)).toEqual(['guide', 'refunds', 'shop'])
})

test('several parts dropped at once are asked about together, in the plural', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, no)
  eng.files[`${ROOT}/.sentinel/system.json`] = JSON.stringify({ version: 1, ...SHOP, parts: [...SHOP.parts, { id: 'faq', parent: 'shop', name: 'FAQ', files: ['faq/**'] }] })
  await lock($, BUILD)
  const out = said(await call($, { action: 'map', drop: ['guide', 'faq'], reason: 'Nobody reads them.', system: { parts: [] } }))
  expect(seen[0]!.question).toBe('Claude wants to stop building Guide and FAQ, which you signed off on.\nClaude\'s reason: "Nobody reads them."\nIf you say yes, they come off the map and show under Changes at the finish.\nRemove them?')
  expect(seen[0]!.options.map(o => o.label)).toEqual(['Yes, remove them', 'No, keep them'])
  expect(out).toMatch(/guide, faq stay on the map\. Keep building them\./)
})

test('a part added during the run, or one the user already let go, asks nothing', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  await mapped($, eng)
  await call($, { action: 'map', system: { parts: [{ id: 'extra', parent: 'shop', name: 'Extra', files: ['extra/**'] }] } })
  expect(said(await call($, { action: 'map', drop: ['extra'], reason: 'Too small to split.', system: { parts: [] } }))).toMatch(/took off extra/)
  expect(seen).toHaveLength(0)
  await dropGuide($)
  expect(seen).toHaveLength(1)
  await dropGuide($)
  expect(seen).toHaveLength(1)
})

test('hands-free, a drop the model signs off itself is still refused', async ($: any, on: any) => {
  const eng = engine(on)
  const seen = dialog(eng, yes)
  await mapped($, eng)
  await $.command.run({ command: 'sentinel', args: 'hands-free' })
  expect(said(await call($, { action: 'map', drop: ['guide'], reason: 'Nobody reads it.', approved: ['guide'], system: { parts: [] } }))).toMatch(/only they can take it off/)
  expect(mapParts(eng)).toEqual(['guide', 'refunds', 'shop'])
  expect(seen).toHaveLength(0)
})

// A state can have its own weight and additions, behind the Library's experimental switch. Pure engine calls, plus the
// engine double where the switch meets the Library's files. Run with `node tests/only.mjs lib-engine`.
//
// How this can fail, and where each is tested below:
//  1. A run saved before this change, or any plan with the switch off, reads a state's fields: it must run as today.
//  2. A weight turns the switch on, or picking one flips it off, directly or by ending a personal switch.
//  3. A looser weight takes effect with nobody's answer, or a stricter one waits for an answer it doesn't need.
//  4. The plan's weight changes on the draft, and a state that has become looser keeps its old effect.
//  5. A hand switch loses to a state's weight, in either direction.
//  6. A state's weight moves an instruction it shouldn't, such as a plan-wide one or one of the user's own.
//  7. An instruction that is off for the plan has no text to tell, so a heavier state or an addition says nothing.
//  8. An addition gets past an instruction's files, past a hand switch, or onto a state with no files.
//  9. The list of spare instructions holds what the user turned off, what isn't trusted, or what no state can use.
// 10. The skip line shows with the switch off, or goes missing with it on.
// 11. Claude hears about the new fields with the switch off.
import { expect, mock } from 'claude-code/testing'
import { BUILTINS, WEIGHTS } from '../hooks/builtins'
import { emptyRun, handOf, libraryOn, onFor, planStates, snapWanted, startCheck, STATE_SETTINGS, toldFor, toldHere, weightFor, withWeight } from '../hooks/core'
import type { LibraryItem, PlanLibrary, Run, StateDef, Switches, Weight } from '../types'
import { ROOT, TOOL, engine, said, test } from './kit'

const MINE = { name: 'security-review', at: 'start', text: 'Review it for security.', kind: 'told', scope: 'project', trusted: true } as Omit<LibraryItem, 'on'>
const ONLY_API = { name: 'api-notes', at: 'start', files: ['api/**'], text: 'Note the API change.', kind: 'told', scope: 'project', trusted: true } as Omit<LibraryItem, 'on'>
const CLONED = { name: 'cloned', at: 'start', text: 'From a clone.', kind: 'told', scope: 'project', trusted: false } as Omit<LibraryItem, 'on'>
const ITEMS: Omit<LibraryItem, 'on'>[] = [...BUILTINS.map(b => ({ ...b, scope: 'built-in' as const, trusted: true })), MINE, ONLY_API, CLONED]

// A plan's library as planLibrary builds it, with the switch on.
function libraryAt(weight: Weight, project: Switches = {}, personal: Switches = {}): PlanLibrary {
  const files = { weight, ...project, on: { [STATE_SETTINGS]: true, ...project.on } }
  const { on } = libraryOn(ITEMS, files, personal)
  const told = ITEMS.filter(x => x.kind === 'told' && on.includes(x.name)).map(({ name, at, files: f, text }) => ({ name, at, ...(f ? { files: f } : {}), text }))
  return { weight, on, told, states: planStates(ITEMS, weight, on, handOf(ITEMS, files, personal)) }
}
const state = (id: string, more: Partial<StateDef> = {}): StateDef => ({ id, label: id, check: 'npm test', files: ['src/**'], ...more })
const runOf = (library: PlanLibrary | undefined, st: StateDef): Run => ({ ...emptyRun(), plan: { title: 't', states: [st], loops: [], lockedAt: '09:00' }, active: st.id, ...(library ? { library } : {}) })
const names = (r: Run, at: 'start' | 'close' | 'final', st: StateDef) => toldFor(r, at, st).map(x => x.name)
const LIGHT = { weight: 'light', weightOk: true } as const

test('a run saved before this change reads none of it', () => {
  const { states: _states, ...saved } = libraryAt('standard')
  for (const st of [state('a', LIGHT), state('b', { weight: 'thorough' }), state('c', { adds: [{ name: 'prove-end-to-end', why: 'x' }] })]) {
    const r = runOf(saved, st)
    expect(startCheck(r)).toBe('npm test')
    expect(snapWanted(r)).toBe(false)
    expect(names(r, 'start', st)).toEqual(['failure-list', 'security-review'])
    expect(names(r, 'close', st)).toEqual(['break-it-once'])
    expect(weightFor(r, st)).toBe('standard')
  }
  // Older still: no library at all.
  expect(startCheck(runOf(undefined, state('a', LIGHT)))).toBe('npm test')
  expect(snapWanted(runOf(undefined, state('a', { weight: 'thorough' })))).toBe(false)
})

test('no weight turns the switch on, and picking one never flips it', () => {
  for (const weight of WEIGHTS) expect(libraryOn(ITEMS, { weight }).on).not.toContain(STATE_SETTINGS)
  expect(libraryOn(ITEMS).on).not.toContain(STATE_SETTINGS)
  expect(BUILTINS.find(b => b.name === STATE_SETTINGS)).toMatchObject({ weights: [], at: 'draft', kind: 'told' })
  const builtins = BUILTINS.map(b => b.name)
  // Picking a weight ends the built-ins' switches, apart from this one.
  expect(withWeight({ on: { [STATE_SETTINGS]: true, 'fails-first': false, mine: true } }, 'light', builtins)).toEqual({ weight: 'light', on: { [STATE_SETTINGS]: true, mine: true } })
  expect(withWeight({ on: { [STATE_SETTINGS]: false } }, 'light', builtins)).toEqual({ weight: 'light', on: { [STATE_SETTINGS]: false } })
  // A project that picks a weight doesn't end the user's own switch for it.
  expect(libraryOn(ITEMS, { weight: 'light' }, { on: { [STATE_SETTINGS]: true } }).on).toContain(STATE_SETTINGS)
  expect(libraryOn(ITEMS, { weight: 'light', on: { [STATE_SETTINGS]: false } }, { on: { [STATE_SETTINGS]: true } }).on).not.toContain(STATE_SETTINGS)
  // It does still end theirs for the other built-ins, as it always has.
  expect(libraryOn(ITEMS, { weight: 'standard' }, { on: { 'fails-first': false } }).on).toContain('fails-first')
})

test('a Light state the user kept drops what Light drops, and the next state keeps it', () => {
  const light = state('copy', LIGHT)
  const plain = state('form')
  const lib = libraryAt('standard')
  const r = runOf(lib, light)
  expect(weightFor(r, light)).toBe('light')
  expect(startCheck(r)).toBeUndefined()
  expect(names(r, 'start', light)).toEqual(['security-review'])
  expect(names(r, 'close', light)).toEqual([])
  const q = runOf(lib, plain)
  expect(weightFor(q, plain)).toBe('standard')
  expect(startCheck(q)).toBe('npm test')
  expect(names(q, 'start', plain)).toEqual(['failure-list', 'security-review'])
  expect(names(q, 'close', plain)).toEqual(['break-it-once'])
})

test('a looser weight nobody answered keeps the plan\'s, and a stricter one needs no answer', () => {
  const lib = libraryAt('standard')
  const unanswered = state('copy', { weight: 'light' })
  const r = runOf(lib, unanswered)
  expect(weightFor(r, unanswered)).toBe('standard')
  expect(startCheck(r)).toBe('npm test')
  expect(names(r, 'start', unanswered)).toEqual(['failure-list', 'security-review'])
  const strict = state('export', { weight: 'thorough' })
  const q = runOf(lib, strict)
  expect(weightFor(q, strict)).toBe('thorough')
  expect(snapWanted(q)).toBe(true)
  expect(snapWanted(runOf(lib, state('form')))).toBe(false)
})

test('looser is worked out from the plan\'s weight as it stands', () => {
  const st = state('form', { weight: 'standard' })
  expect(weightFor(runOf(libraryAt('light'), st), st)).toBe('standard')
  expect(weightFor(runOf(libraryAt('thorough'), st), st)).toBe('thorough')
  const kept = state('form', { weight: 'standard', weightOk: true })
  expect(weightFor(runOf(libraryAt('thorough'), kept), kept)).toBe('standard')
})

test('a hand switch beats a state\'s weight both ways', () => {
  const heavy = state('export', { weight: 'thorough' })
  const light = state('copy', LIGHT)
  const off = libraryAt('standard', { on: { 'fails-first': false, 'fails-without-change': false, 'failure-list': false } })
  expect(startCheck(runOf(off, heavy))).toBeUndefined()
  expect(snapWanted(runOf(off, heavy))).toBe(false)
  expect(names(runOf(off, heavy), 'start', heavy)).toEqual(['security-review'])
  const on = libraryAt('standard', { on: { 'fails-first': true, 'failure-list': true, 'fails-without-change': true } })
  expect(startCheck(runOf(on, light))).toBe('npm test')
  expect(snapWanted(runOf(on, light))).toBe(true)
  expect(names(runOf(on, light), 'start', light)).toEqual(['failure-list', 'security-review'])
  // A project that picked a weight ends the user's switch for a built-in, so that one isn't by hand. With no weight it is.
  const personal = { on: { 'break-it-once': false } }
  expect(names(runOf(libraryAt('standard', {}, personal), heavy), 'close', heavy)).toEqual(['break-it-once'])
  expect(handOf(ITEMS, {}, personal)).toEqual({ 'break-it-once': false })
  expect(handOf(ITEMS, { weight: 'standard' }, personal)).toEqual({})
  expect(planStates(ITEMS, 'standard', libraryOn(ITEMS, {}, personal).on, handOf(ITEMS, {}, personal)).hand).toEqual({ 'break-it-once': false })
})

test('an addition brings in what the state\'s weight left off', () => {
  const lib = libraryAt('light')
  const plain = state('copy')
  expect(names(runOf(lib, plain), 'start', plain)).toEqual(['security-review'])
  const added = state('copy', { adds: [{ name: 'failure-list', why: 'money' }, { name: 'break-it-once', why: 'money' }, { name: 'fails-first', why: 'money' }] })
  const r = runOf(lib, added)
  expect(names(r, 'start', added)).toEqual(['security-review', 'failure-list'])
  expect(names(r, 'close', added)).toEqual(['break-it-once'])
  expect(startCheck(r)).toBe('npm test')
  // The text comes with it, since a plan on Light was never told it.
  expect(toldFor(r, 'start', added).find(x => x.name === 'failure-list')?.text).toContain('write down how it can fail')
})

test('an addition can\'t get past a hand switch, an instruction\'s files or a state with no files', () => {
  const off = libraryAt('standard', { on: { 'failure-list': false } })
  const added = state('form', { adds: [{ name: 'failure-list', why: 'x' }] })
  expect(names(runOf(off, added), 'start', added)).toEqual(['security-review'])
  // A check has no text to go missing, so it shows the order of the two rules.
  const check = state('form', { adds: [{ name: 'fails-first', why: 'x' }] })
  expect(startCheck(runOf(libraryAt('standard', { on: { 'fails-first': false } }), check))).toBeUndefined()
  const lib = libraryAt('light')
  const elsewhere = state('copy', { adds: [{ name: 'api-notes', why: 'x' }] })
  expect(names(runOf(lib, elsewhere), 'start', elsewhere)).not.toContain('api-notes')
  const inApi = state('api', { files: ['api/**'], adds: [{ name: 'failure-list', why: 'x' }] })
  expect(names(runOf(lib, inApi), 'start', inApi)).toContain('api-notes')
  const noFiles = state('look', { files: [], adds: [{ name: 'failure-list', why: 'x' }] })
  expect(names(runOf(lib, noFiles), 'start', noFiles)).toEqual([])
})

test('a state\'s weight moves only the five it should', () => {
  const lib = libraryAt('thorough')
  const light = state('copy', LIGHT)
  const r = runOf(lib, light)
  for (const name of ['failure-list', 'fails-first', 'break-it-once', 'fails-without-change']) expect(onFor(r, light, name)).toBe(false)
  // fast-checks is in the five, and every weight lists it.
  expect(onFor(r, light, 'fast-checks')).toBe(true)
  for (const name of ['quote-the-source', 'depth-before-size', 'draw-system', 'prove-end-to-end', 'measure-before-delete', 'security-review']) expect(onFor(r, light, name)).toBe(true)
  // The final instructions of a Thorough plan still come, whatever a state's weight.
  expect(toldFor(r, 'final').map(x => x.name)).toEqual(['prove-end-to-end'])
  // And a heavier state doesn't bring in the plan-wide ones of a heavier weight.
  const heavy = state('export', { weight: 'thorough' })
  const q = runOf(libraryAt('standard'), heavy)
  expect(onFor(q, heavy, 'prove-end-to-end')).toBe(false)
  expect(onFor(q, heavy, 'measure-before-delete')).toBe(false)
  expect(onFor(q, heavy, 'fails-without-change')).toBe(true)
})

test('what a plan keeps for its states: the hand switches, the five weights, and the spare instructions', () => {
  const { on } = libraryOn(ITEMS, { weight: 'light', on: { [STATE_SETTINGS]: true, mine: false } })
  const s = planStates(ITEMS, 'light', on, handOf(ITEMS, { weight: 'light', on: { [STATE_SETTINGS]: true, 'break-it-once': false, 'security-review': false } }))
  expect(Object.keys(s.weights).sort()).toEqual(['break-it-once', 'fails-first', 'fails-without-change', 'failure-list', 'fast-checks'])
  expect(s.weights['fails-without-change']).toEqual(['thorough'])
  // Only what fires per state and is told. Not one the user turned off, not an untrusted one, not a final or draft one.
  const spare = s.spare.map(x => x.name)
  expect(spare).toContain('failure-list')
  expect(spare).not.toContain('break-it-once')
  expect(spare).not.toContain('security-review')
  expect(spare).not.toContain('cloned')
  expect(spare).not.toContain('prove-end-to-end')
  expect(spare).not.toContain('fails-first')
  expect(spare).not.toContain('sources-first')
  // A switch the draft card changed counts as the card has it, and a box it flipped against the weight counts as by hand.
  const card = planStates(ITEMS, 'standard', ['fails-first', 'break-it-once'], { 'fails-first': false })
  expect(card.hand['fails-first']).toBe(true)
  expect(card.hand['failure-list']).toBe(false)
  expect(card.hand['break-it-once']).toBeUndefined()
})

test('the skip line shows only with the switch on', () => {
  const st = state('form')
  const line = /doesn't fit this state, skip it and record why with "decide"/
  expect(toldHere(runOf(libraryAt('standard'), st), st)).toMatch(line)
  expect(toldHere(runOf(libraryAt('standard'), st), st)).toMatch(/two of them disagree/)
  const { states: _states, ...off } = libraryAt('standard')
  expect(toldHere(runOf(off, st), st)).not.toMatch(line)
  expect(toldHere(runOf(off, st), st)).toMatch(/project's rules win/)
})

const SESSION = async ($: any, on: any) => {
  const eng = engine(on)
  mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const section = async () => (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })).sections.find((s: any) => s.id === 'sentinel:library')?.text ?? ''
  const define = async () => {
    await $.tool.call({ tool: 'ExitPlanMode' })
    return $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [{ id: 'form', label: 'Form', check: 'npm test', files: ['src/**'] }] })
  }
  return { eng, section, define }
}
const FILE = `${ROOT}/.sentinel/library.json`
const saved = (eng: ReturnType<typeof engine>) => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}')

test('with the switch off Claude hears nothing of it, and the plan keeps nothing for its states', async ($: any, on: any) => {
  const { eng, section, define } = await SESSION($, on)
  expect(await section()).not.toMatch(/weightWhy/)
  expect(said(await define())).toMatch(/Locked|Draft/)
  expect(saved(eng).library.states).toBeUndefined()
  expect(saved(eng).library.on).not.toContain(STATE_SETTINGS)
})

test('with the switch on Claude hears of it while drafting, and the plan keeps what its states need', async ($: any, on: any) => {
  const { eng, section, define } = await SESSION($, on)
  eng.files[FILE] = JSON.stringify({ on: { [STATE_SETTINGS]: true, 'fails-first': false } })
  expect(await section()).toMatch(/weightWhy/)
  await define()
  const library = saved(eng).library as PlanLibrary
  expect(library.on).toContain(STATE_SETTINGS)
  // The kit's own switch file turns quote-the-source off for the older tests, and that counts as by hand too.
  expect(library.states?.hand).toEqual({ [STATE_SETTINGS]: true, 'fails-first': false, 'quote-the-source': false })
  expect(library.states?.weights['failure-list']).toEqual(['standard', 'thorough'])
  // Once a plan runs, nothing about drafting is told.
  expect(await section()).not.toMatch(/weightWhy/)
})

test('/sentinel weight leaves the switch where it was', async ($: any, on: any) => {
  const { eng } = await SESSION($, on)
  eng.files[FILE] = JSON.stringify({ on: { [STATE_SETTINGS]: true, 'fails-first': false } })
  await $.command.run({ command: 'sentinel', args: 'weight light' })
  expect(JSON.parse(eng.files[FILE]!)).toEqual({ weight: 'light', on: { [STATE_SETTINGS]: true } })
})

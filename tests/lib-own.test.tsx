// The user's own instructions can list their weights, the Library's switches file is guarded, and a member hears what it
// won't get. These stay outside the experimental switch. Run with `node tests/only.mjs lib-own`.
//
// How this can fail, and where each is tested below:
//  1. A weights list with a bad word gets in, or an empty list turns an instruction off for good.
//  2. An own instruction with a list loses its hand switch to a project's weight, or to /sentinel weight.
//  3. A built-in, or a file that takes a built-in's place, starts keeping switches a weight should end.
//  4. A list applies to the plan's weight only, so "only on Thorough states" means nothing per state.
//  5. Claude edits the switches file, at the project's path or the user's, and turns the experimental switch on itself.
//  6. The guard catches Sentinel's own writes, or other files in the folder.
//  7. A member is told to call decide, which it can't, or isn't told it gets no rerun.
import { expect, mock } from 'claude-code/testing'
import { BUILTINS } from '../hooks/builtins'
import { STATE_SETTINGS, emptyRun, handOf, instructionOf, libraryOn, memberGap, onFor, planStates, startCheck, toldFor, toldHere, withWeight } from '../hooks/core'
import type { InstructionDef, PlanLibrary, Run, StateDef, Switches, Weight } from '../types'
import { HOME, ROOT, TOOL, engine, said, test } from './kit'

const SEC = { name: 'security-review', at: 'start', text: 'Review it.', kind: 'told', weights: ['thorough'] as Weight[], own: true, trusted: true, scope: 'project' }
const OPEN = { name: 'notes', at: 'start', text: 'Notes.', kind: 'told', own: true, trusted: true, scope: 'project' }
const LATE = { name: 'late', at: 'final', text: 'Late.', kind: 'told', weights: ['thorough'] as Weight[], own: true, trusted: true, scope: 'project' }
// A file that takes a built-in's place keeps its weights and its place under them.
const COPY = { name: 'fails-first', at: 'start', text: 'Copy.', kind: 'checks', weights: ['standard', 'thorough'] as Weight[], trusted: true, scope: 'project' }
const ITEMS = [...BUILTINS.filter(b => b.name !== 'fails-first').map(b => ({ ...b, scope: 'built-in', trusted: true })), COPY, SEC, OPEN, LATE] as any[]

test('an instruction can list its weights', () => {
  const of = (weights: unknown) => instructionOf({ name: 'x', at: 'start', text: 'y', weights })
  expect(of(['thorough', 'light'])).toEqual({ name: 'x', at: 'start', text: 'y', weights: ['thorough', 'light'] })
  expect(of(['heavy'])).toMatch(/weights in x are light, standard or thorough/)
  expect(of('thorough')).toMatch(/weights in x are light, standard or thorough/)
  // No list means every weight, and an empty one is no list.
  expect(of([])).toEqual({ name: 'x', at: 'start', text: 'y' })
  expect(of(undefined)).toEqual({ name: 'x', at: 'start', text: 'y' })
})

test('a list decides an own instruction by weight, and no list means every weight', () => {
  for (const weight of ['light', 'standard'] as Weight[]) expect(libraryOn(ITEMS, { weight }).on).not.toContain('security-review')
  expect(libraryOn(ITEMS, { weight: 'thorough' }).on).toContain('security-review')
  for (const weight of ['light', 'standard', 'thorough'] as Weight[]) expect(libraryOn(ITEMS, { weight }).on).toContain('notes')
})

test('an own instruction with a list keeps its hand switches, and a built-in does not', () => {
  // The user's own switch stands under a project's weight.
  expect(libraryOn(ITEMS, { weight: 'light' }, { on: { 'security-review': true } }).on).toContain('security-review')
  expect(libraryOn(ITEMS, { weight: 'thorough' }, { on: { 'security-review': false } }).on).not.toContain('security-review')
  // The project's own switch beats the user's.
  expect(libraryOn(ITEMS, { weight: 'light', on: { 'security-review': false } }, { on: { 'security-review': true } }).on).not.toContain('security-review')
  // A built-in's personal switch ends when the project picks a weight, and so does a file in a built-in's place.
  expect(libraryOn(ITEMS, { weight: 'standard' }, { on: { 'failure-list': false } }).on).toContain('failure-list')
  expect(libraryOn(ITEMS, { weight: 'standard' }, { on: { 'fails-first': false } }).on).toContain('fails-first')
  expect(handOf(ITEMS, { weight: 'standard' }, { on: { 'security-review': false, 'failure-list': false } })).toEqual({ 'security-review': false })
})

async function session($: any, on: any) {
  const eng = engine(on)
  mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return eng
}

test('/sentinel weight keeps an own instruction\'s switch, whatever it lists', async ($: any, on: any) => {
  const eng = await session($, on)
  const FILE = `${ROOT}/.sentinel/library.json`
  eng.files[`${ROOT}/.sentinel/instructions/security-review.json`] = JSON.stringify({ at: 'start', text: 'Review it.', weights: ['thorough'] })
  eng.files[FILE] = JSON.stringify({ on: { 'security-review': true, 'failure-list': false, [STATE_SETTINGS]: true } })
  expect(String((await $.command.run({ command: 'sentinel', args: 'weight light' })).text)).toMatch(/your own items keep their switches/)
  expect(JSON.parse(eng.files[FILE]!)).toEqual({ weight: 'light', on: { 'security-review': true, [STATE_SETTINGS]: true } })
  // A file with a built-in's name goes as the built-in does.
  eng.files[`${ROOT}/.sentinel/instructions/failure-list.json`] = JSON.stringify({ at: 'start', text: 'Mine.' })
  eng.files[FILE] = JSON.stringify({ on: { 'failure-list': false } })
  await $.command.run({ command: 'sentinel', args: 'weight thorough' })
  expect(JSON.parse(eng.files[FILE]!)).toEqual({ weight: 'thorough' })
})

test('through the engine, an own file counts as own and a file in a built-in\'s place doesn\'t', async ($: any, on: any) => {
  const eng = await session($, on)
  const INS = `${ROOT}/.sentinel/instructions`
  eng.files[`${INS}/security-review.json`] = JSON.stringify({ at: 'start', text: 'Review it.', weights: ['thorough'] })
  eng.files[`${INS}/failure-list.json`] = JSON.stringify({ at: 'start', text: 'Mine.' })
  for (const name of ['security-review', 'failure-list']) await $.command.run({ command: 'sentinel', args: `trust ${name}` })
  // The project's weight takes quote-the-source over too, so its own switch turns that off.
  eng.files[`${ROOT}/.sentinel/library.json`] = JSON.stringify({ weight: 'light', on: { 'quote-the-source': false } })
  eng.files[`${HOME}/.sentinel/library.json`] = JSON.stringify({ on: { 'security-review': true, 'failure-list': true } })
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [{ id: 'a', label: 'A', check: 'npm test', files: ['src/**'] }] })
  const lib = (JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`]!) as Run).library!
  expect(lib.on).toContain('security-review')
  expect(lib.on).not.toContain('failure-list')
})

test('withWeight still ends only the names it is given', () => {
  expect(withWeight({ on: { a: true, b: false } }, 'light', ['a'])).toEqual({ weight: 'light', on: { b: false } })
})

const libraryAt = (weight: Weight, project: Switches = {}): PlanLibrary => {
  const sw = { weight, ...project, on: { [STATE_SETTINGS]: true, ...project.on } }
  const { on } = libraryOn(ITEMS, sw)
  const told = ITEMS.filter(x => x.kind === 'told' && on.includes(x.name)).map(({ name, at, text }) => ({ name, at, text }) as InstructionDef)
  return { weight, on, told, states: planStates(ITEMS, weight, on, handOf(ITEMS, sw)) }
}
const state = (id: string, more: Partial<StateDef> = {}): StateDef => ({ id, label: id, check: 'npm test', files: ['src/**'], ...more })
const runOf = (library: PlanLibrary | undefined, st: StateDef): Run => ({ ...emptyRun(), plan: { title: 't', states: [st], loops: [], lockedAt: '09:00' }, active: st.id, ...(library ? { library } : {}) })

test('a list follows the state\'s weight when the switch is on', () => {
  const heavy = state('charge', { weight: 'thorough' })
  const plain = state('form')
  const lib = libraryAt('standard')
  expect(onFor(runOf(lib, heavy), heavy, 'security-review')).toBe(true)
  expect(toldFor(runOf(lib, heavy), 'start', heavy).find(x => x.name === 'security-review')?.text).toBe('Review it.')
  expect(onFor(runOf(lib, plain), plain, 'security-review')).toBe(false)
  expect(toldFor(runOf(lib, plain), 'start', plain).map(x => x.name)).not.toContain('security-review')
  // A Light state the user kept under a Thorough plan loses it.
  const light = state('copy', { weight: 'light', weightOk: true })
  expect(onFor(runOf(libraryAt('thorough'), light), light, 'security-review')).toBe(false)
  // No list, or a moment that isn't per state: the state's weight doesn't move it.
  expect(onFor(runOf(libraryAt('thorough'), light), light, 'notes')).toBe(true)
  expect(onFor(runOf(libraryAt('thorough'), light), light, 'late')).toBe(true)
  expect(onFor(runOf(lib, heavy), heavy, 'late')).toBe(false)
  // A hand switch beats it.
  const off = libraryAt('standard', { on: { 'security-review': false } })
  expect(onFor(runOf(off, heavy), heavy, 'security-review')).toBe(false)
  expect(off.states!.spare.map(x => x.name)).not.toContain('security-review')
  // A file in a built-in's place moves as the built-in does.
  expect(startCheck(runOf(lib, light))).toBeUndefined()
})

const GUARDED = /The Library's switches are the user's/

test('Claude can\'t edit the switches file, at either path', async ($: any, on: any) => {
  await session($, on)
  const edit = (tool: string, file_path: string) => $.tool.call({ tool, file_path, content: '{}', old_string: 'a', new_string: 'b' })
  for (const tool of ['Edit', 'Write']) {
    for (const path of [`${ROOT}/.sentinel/library.json`, '.sentinel/library.json', `${HOME}/.sentinel/library.json`, `${ROOT}/.sentinel/LIBRARY.JSON`]) {
      expect(said(await edit(tool, path))).toMatch(GUARDED)
    }
    expect(said(await edit(tool, `${ROOT}/.sentinel/other.json`))).not.toMatch(GUARDED)
    expect(said(await edit(tool, `${ROOT}/src/library.json`))).not.toMatch(GUARDED)
  }
})

test('the guard leaves Sentinel\'s own writes alone', async ($: any, on: any) => {
  const eng = await session($, on)
  await $.command.run({ command: 'sentinel', args: 'weight light' })
  expect(JSON.parse(eng.files[`${ROOT}/.sentinel/library.json`]!)).toEqual({ weight: 'light' })
})

test('a member hears what it won\'t get, and no word about decide', () => {
  const st = state('export', { weight: 'thorough' })
  const r = runOf(libraryAt('standard'), st)
  expect(memberGap(r, st)).toMatch(/fails-without-change/)
  const plain = state('form')
  expect(memberGap(runOf(libraryAt('standard'), plain), plain)).toBe('')
  expect(memberGap(runOf(undefined, plain), plain)).toBe('')
  // Outside the switch too: a plan on Thorough with no per-state fields.
  const { states: _states, ...off } = libraryAt('thorough')
  expect(memberGap(runOf(off, plain), plain)).toMatch(/fails-without-change/)
  expect(toldHere(r, st, false, true)).not.toMatch(/decide/)
  expect(toldHere(r, st, false, true)).toMatch(/skip it and say why/)
  expect(toldHere(r, st)).toMatch(/record why with "decide"/)
})

test('the prompt a member gets carries the note and the words it can act on', async ($: any, on: any) => {
  const eng = await session($, on)
  eng.files[`${ROOT}/.sentinel/parallel`] = 'on'
  eng.files[`${ROOT}/.sentinel/library.json`] = JSON.stringify({ on: { [STATE_SETTINGS]: true } })
  await $.tool.call({ tool: 'ExitPlanMode' })
  const states = [
    { id: 'look', label: 'Read' },
    { id: 'api', label: 'API', check: 'npm test -- api', files: ['api/**'], needs: ['look'] },
    { id: 'ui', label: 'UI', check: 'npm test -- ui', files: ['ui/**'], needs: ['look'], weight: 'thorough', weightWhy: 'risky' },
  ]
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/a.ts` })
  await $.tool.call({ tool: TOOL, action: 'advance', to: 'api', evidence: 'read it' })
  await $.tool.call({ tool: TOOL, action: 'brief', to: 'ui', brief: 'Build it.' })
  const prompt: string = eng.spawns[0]!.prompt
  expect(prompt).toMatch(/fails-without-change/)
  expect(prompt).toMatch(/skip it and say why/)
  expect(prompt).not.toMatch(/record why with "decide"/)
})

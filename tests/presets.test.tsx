// Presets: a folder in ~/.sentinel/presets/<name>/ that a project points at, between this project and every project.
// Made empty or from a project's settings, used, stopped, deleted, exported and imported. Run with
// `node tests/only.mjs presets`.
//
// How this can fail, and where each is tested below:
//  1. New puts something in the preset, overwrites one, takes a name that is a sub-command or empty, or leaves this
//     project not using it.
//  2. Using a preset or no preset changes more of the project than its pointer, or uses one this computer lacks.
//  3. Moving changes what is on in this project, loses an item's trust or trusts one nobody trusted, leaves the
//     project's settings or items behind, or deletes them when the preset couldn't be written.
//  4. Delete leaves the folder, its items' trust, or this project pointing at it.
//  5. Import takes a bad file, a key that could start something, or overwrites a preset; trusts its items; runs
//     anything; or doesn't write the MCP the user picked in place of one.
//  6. Export gives a file Import refuses, or leaves something out.
//  7. The page's view of the presets or its actions are wrong.
//  8. Claude or another plugin makes, uses, moves or deletes a preset.
// The preset as a layer:
//  9. A farther place beats a closer one: the preset over this project, or every project over the preset.
// 10. A closer weight leaves a farther place's switch on a built-in standing, or ends one on the user's own item.
// 11. A preset's own instruction or flow shows in a project that doesn't use it, or beats the project's file of its name.
// 12. A switch, weight or saved flow meant for the preset writes somewhere when none is in use, or makes one that isn't
//     on this computer again; or the old word personal still works.
// 13. A pointer that isn't a plain name reads or writes outside ~/.sentinel/presets.
// 14. A plan locked while a preset is in use runs without its weight or switches.
import { expect, mock } from 'claude-code/testing'
import { BUILTINS } from '../hooks/builtins'
import { handOf, libraryOn, STATE_SETTINGS } from '../hooks/core'
import { presetOf } from '../hooks/preset'
import type { Run, Switches } from '../types'
import { HOME, ROOT, TOOL, engine, openPage, said, test, until } from './kit'

const LIB = `${ROOT}/.sentinel/library.json`
const PRESETS = `${HOME}/.sentinel/presets`
const GD = `${PRESETS}/game-dev`
const INS = (name: string) => `${ROOT}/.sentinel/instructions/${name}.json`
const FLOW = (name: string) => `${ROOT}/.sentinel/flows/${name}.json`
const PLAYTEST = { at: 'close', text: 'Play the scene before calling it done.' }
const BUILD = { description: 'A build that has to pass.', when: { at: 'end' }, states: [{ id: 'build', label: 'Build it', check: 'npm run build' }] }
// A preset on this computer: a weight, a built-in switched off, an instruction and a flow of its own, and a file that
// shares its name with one of the project's.
const gameDev = (eng: any, lib: object = { weight: 'thorough', on: { 'fails-first': false } }) => {
  eng.files[`${GD}/library.json`] = JSON.stringify(lib)
  eng.files[`${GD}/instructions/playtest.json`] = JSON.stringify(PLAYTEST)
  eng.files[`${GD}/flows/build.json`] = JSON.stringify(BUILD)
  eng.files[`${GD}/instructions/notes.json`] = JSON.stringify({ at: 'start', text: "The preset's notes." })
  eng.files[INS('notes')] = JSON.stringify({ at: 'start', text: "The project's notes." })
}
// Each item's switch as /sentinel library lists it, without where it comes from.
const onOff = (listed: string) => listed.split('\n').filter(l => /^(on |off) /.test(l)).map(l => l.split(' (')[0]!.replace(/ +/, ' ')).sort()

async function session($: any, on: any) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(60_000)
  // The page's snapshot carries the Library, so the dashboard is open.
  await openPage($, clock)
  const sentinel = async (args: string, origin?: object) => said(await $.command.run({ command: 'sentinel', args, ...(origin ? { origin } : {}) }))
  const json = (path: string) => JSON.parse(eng.files[path] ?? 'null')
  // A project with a weight, a switch, a needed MCP, a trusted instruction and flow, and an instruction nobody trusted.
  const setUp = async () => {
    eng.files[INS('playtest')] = JSON.stringify(PLAYTEST)
    eng.files[FLOW('build')] = JSON.stringify(BUILD)
    eng.files[INS('cloned')] = JSON.stringify({ at: 'close', text: 'From a teammate.' })
    await sentinel('trust playtest')
    await sentinel('trust build')
    await sentinel('weight thorough')
    await sentinel('off fails-first')
    await sentinel('mcp add Unity')
  }
  const page = async (m: object) => {
    const at = eng.snap().flowSaid?.at
    eng.page(m)
    await until(clock, () => eng.snap().flowSaid && eng.snap().flowSaid.at !== at)
    return eng.snap().flowSaid.text as string
  }
  const trusted = () => Object.keys((eng.store.trustedFlows ?? {}) as object)
  return { eng, clock, sentinel, json, setUp, page, trusted }
}

test('new starts empty and is used here at once, and a name that is taken, a sub-command or empty makes nothing', async ($: any, on: any) => {
  const { eng, sentinel, json } = await session($, on)
  await sentinel('on sources-first')
  expect(await sentinel('preset new Game Dev')).toBe('Made the preset game-dev in ~/.sentinel/presets/game-dev/, empty. This project uses it now: add preset after /sentinel on, off or weight to change it.')
  expect(Object.keys(eng.files).filter(f => f.startsWith(PRESETS))).toEqual([`${GD}/library.json`])
  expect(json(`${GD}/library.json`)).toEqual({})
  // The project keeps its own settings, and only points at the preset.
  expect(json(LIB)).toEqual({ on: { 'sources-first': true }, preset: 'game-dev' })
  const how = "Name it: /sentinel preset new <name>, in letters, digits and -. new, move, delete and none can't be names."
  for (const n of ['', 'none', 'move', '!!!']) expect(await sentinel(`preset new ${n}`.trim())).toBe(how)
  eng.files[`${GD}/library.json`] = JSON.stringify({ weight: 'light' })
  expect(await sentinel('preset new game-dev')).toBe('There is already a preset game-dev. /sentinel preset game-dev uses it.')
  expect(json(`${GD}/library.json`)).toEqual({ weight: 'light' })
  expect(Object.keys(eng.files).filter(f => f.startsWith(PRESETS))).toEqual([`${GD}/library.json`])
})

test('using a preset or no preset changes only the pointer, and one this computer lacks is refused', async ($: any, on: any) => {
  const { eng, sentinel, json } = await session($, on)
  gameDev(eng, { weight: 'thorough', mcps: ['Unity'] })
  await sentinel('off failure-list')
  const project = () => Object.fromEntries(Object.entries(eng.files).filter(([f]) => f.startsWith(`${ROOT}/.sentinel/`) && /\/(library\.json|instructions\/|flows\/)/.test(f)))
  const before = project()
  expect(await sentinel('preset game-dev')).toBe("Using game-dev here. Its settings sit under this project's own, which still win. Unity isn't connected in this session, so plans here won't lock until it is. /sentinel preset none stops using it.")
  expect(json(LIB)).toEqual({ on: { 'failure-list': false }, preset: 'game-dev' })
  expect(await sentinel('preset none')).toBe('game-dev no longer applies here. Nothing was deleted.')
  expect(project()).toEqual(before)
  expect(await sentinel('preset none')).toBe('This project uses no preset.')
  expect(await sentinel('preset nope')).toBe('There is no preset "nope" on this computer. /sentinel preset lists them.')
  expect(json(LIB)).toEqual({ on: { 'failure-list': false } })
  expect(await sentinel('preset')).toBe('Presets: game-dev. /sentinel preset <name> uses one, /sentinel preset new <name> makes an empty one, and /sentinel preset move <name> moves this project\'s settings into one.')
})

test('moving keeps this project working as it did: its settings and items go into the preset, with their trust', async ($: any, on: any) => {
  const { eng, sentinel, json, setUp, trusted } = await session($, on)
  await setUp()
  const before = onOff(await sentinel('library'))
  expect(await sentinel('preset move game-dev')).toBe("Moved this project's settings into the new preset game-dev: the weight, 1 switch, the instructions cloned and playtest, the flow build and the MCP Unity. This project uses it now, and works as it did.")
  expect(json(LIB)).toEqual({ preset: 'game-dev' })
  for (const f of [INS('playtest'), INS('cloned'), FLOW('build')]) expect(eng.files[f]).toBeUndefined()
  expect(json(`${GD}/library.json`)).toEqual({ weight: 'thorough', on: { 'fails-first': false }, mcps: ['Unity'] })
  expect(json(`${GD}/instructions/playtest.json`)).toEqual({ name: 'playtest', ...PLAYTEST })
  expect(json(`${GD}/flows/build.json`)).toEqual({ name: 'build', ...BUILD })
  // Trust moves with each file: playtest and build stay on, cloned stays off.
  expect(trusted().filter(k => k.startsWith(ROOT))).toEqual([])
  expect(trusted().filter(k => k.startsWith(GD)).sort()).toEqual([`${GD}/flows/build.json`, `${GD}/instructions/playtest.json`])
  expect(onOff(await sentinel('library'))).toEqual(before)
  // Into the preset in use: where it sets the same thing, this project's choice replaces it. A weight here ends the
  // preset's switches on built-ins, as it did while this project's weight sat above them.
  eng.files[INS('playtest')] = JSON.stringify({ at: 'close', text: 'Mine.' })
  await sentinel('trust playtest')
  await sentinel('weight standard')
  const mid = onOff(await sentinel('library'))
  expect(mid).toContain('on fails-first')
  expect(await sentinel('preset move game-dev')).toBe("Moved this project's settings into game-dev: the weight and the instruction playtest. Where game-dev set the same thing, this project's choice replaced it.")
  expect(json(`${GD}/library.json`)).toEqual({ weight: 'standard', mcps: ['Unity'] })
  expect(json(`${GD}/instructions/playtest.json`).text).toBe('Mine.')
  expect(onOff(await sentinel('library'))).toEqual(mid)
  expect(await sentinel('preset move game-dev')).toBe('This project has no settings of its own to move.')
})

test('a move that can\'t write the preset leaves the project as it was', async ($: any, on: any) => {
  const { eng, sentinel, setUp, trusted } = await session($, on)
  await setUp()
  // The dashboard's snapshot (state-<port>.js) and the run file aren't settings.
  const files = () => JSON.stringify(Object.entries(eng.files).filter(([f]) => f.startsWith(`${ROOT}/.sentinel/`) && !/state[-\d]*\.js|run\.json/.test(f)))
  const project = files()
  const trust = trusted()
  eng.setWriteFails(/presets\/game-dev\/flows/)
  expect(await sentinel('preset move game-dev')).toMatch(/^Sentinel couldn't write the preset game-dev, so this project keeps its settings: /)
  expect(files()).toBe(project)
  expect(trusted().filter(k => k.startsWith(ROOT))).toEqual(trust)
})

test('delete takes the folder and its trust, and this project stops pointing at it', async ($: any, on: any) => {
  const { eng, sentinel, json, trusted } = await session($, on)
  gameDev(eng)
  eng.files[LIB] = JSON.stringify({ preset: 'game-dev' })
  await sentinel('trust playtest')
  expect(trusted().some(k => k.startsWith(GD))).toBe(true)
  expect(await sentinel('preset delete game-dev')).toBe("Deleted the preset game-dev, with its own instructions and flows. This project used it, so it runs on its own settings and every project's now.")
  expect(Object.keys(eng.files).some(f => f.startsWith(GD))).toBe(false)
  expect(trusted().some(k => k.startsWith(GD))).toBe(false)
  expect(json(LIB)).toEqual({})
  expect(await sentinel('preset delete nope')).toBe('There is no preset "nope" on this computer. /sentinel preset lists them.')
})

test('import writes a folder with its items untrusted and the MCP the user picked, refuses a bad file, and runs nothing', async ($: any, on: any) => {
  const { eng, page, json, sentinel } = await session($, on)
  const good = { weight: 'light', on: { 'fails-first': false }, instructions: [{ name: 'playtest', ...PLAYTEST }], flows: [{ name: 'build', ...BUILD }], mcps: ['Unity', 'Notion'] }
  const WA = `${PRESETS}/web-app`
  // Trust left from a web-app this computer had once, deleted by hand: the copy that comes in still starts untrusted.
  eng.store.trustedFlows = { [`${WA}/instructions/playtest.json`]: JSON.stringify({ name: 'playtest', ...PLAYTEST }) }
  expect(await page({ kind: 'presetImport', name: 'Web App.json', content: JSON.stringify(good), swap: { Unity: 'unity-editor', Notion: null } }))
    .toBe("Imported the preset web-app. Sentinel didn't make it on this computer, so its instructions and flows stay off until you trust each one. Read its flows' checks first: they are shell commands.")
  expect(json(`${WA}/library.json`)).toEqual({ weight: 'light', on: { 'fails-first': false }, mcps: ['unity-editor'] })
  expect(json(`${WA}/instructions/playtest.json`)).toEqual({ name: 'playtest', ...PLAYTEST })
  expect(json(`${WA}/flows/build.json`)).toEqual({ name: 'build', ...BUILD })
  await sentinel('preset web-app')
  const listed = await sentinel('library')
  expect(listed).toMatch(/^off playtest \(preset web-app, close\): .*Off until you trust it/m)
  expect(listed).toMatch(/^off build \(preset web-app\): .*Off until you trust it/m)
  expect(await page({ kind: 'presetImport', name: 'web-app.json', content: JSON.stringify(good) })).toBe('There is already a preset web-app. Delete it first, or rename the file.')
  expect(await page({ kind: 'presetImport', name: 'x.json', content: '{ nope' })).toMatch(/^Sentinel couldn't import x\.json: /)
  expect(await page({ kind: 'presetImport', name: 'y.json', content: JSON.stringify({ mcps: ['Unity'], command: 'curl evil' }) })).toBe('Sentinel couldn\'t import y.json: A preset has no "command": it holds weight, on, instructions, flows and mcps only.')
  expect(await page({ kind: 'presetImport', name: 'none.json', content: '{}' })).toMatch(/^Sentinel couldn't import none\.json: its name needs letters or digits, and can't be new, move, delete or none\./)
  expect(Object.keys(eng.files).filter(f => f.startsWith(PRESETS) && !f.startsWith(WA))).toEqual([])
  expect(eng.runs.some((r: any) => /npm run build|curl/.test(r.argv.join(' ')))).toBe(false)
})

test('the page sees each preset with what it holds and would change here, exports it whole, and acts on presets and MCPs', async ($: any, on: any) => {
  const { eng, page, json } = await session($, on)
  eng.setTools(['Read', 'mcp__unity-editor__play'])
  gameDev(eng, { weight: 'thorough', on: { 'fails-first': false }, mcps: ['Unity'] })
  await page({ kind: 'mcpCheck' })
  const p = eng.snap().library.presets.find((x: any) => x.name === 'game-dev')
  expect(p).toMatchObject({ name: 'game-dev', file: '~/.sentinel/presets/game-dev/', weight: 'thorough', on: { 'fails-first': false }, trusted: false, mcps: [{ name: 'Unity', state: 'missing' }] })
  expect(p.instructions.map((x: any) => x.name).sort()).toEqual(['notes', 'playtest'])
  expect(p.flows[0]).toMatchObject({ name: 'build', checks: ['npm run build'] })
  // Using it: Thorough turns on what it adds, and its closer weight ends every project's switch on quote-the-source.
  expect(p.preview).toEqual({ turnsOn: ['quote-the-source', 'fails-without-change', 'prove-end-to-end', 'measure-before-delete'], turnsOff: ['fails-first'] })
  // Export is one file, and Import takes it back.
  expect(presetOf(p.raw, 'x')).toEqual({ name: 'x', ...p.raw })
  expect(p.raw).toMatchObject({ weight: 'thorough', on: { 'fails-first': false }, flows: [{ name: 'build', ...BUILD }], mcps: ['Unity'] })
  expect(await page({ kind: 'presetImport', name: 'copy.json', content: JSON.stringify(p.raw) })).toMatch(/^Imported the preset copy\./)
  expect(await page({ kind: 'presetUse', name: 'game-dev' })).toMatch(/^Using game-dev here\./)
  expect(eng.snap().library.using).toMatchObject({ name: 'game-dev', weight: 'thorough' })
  expect(await page({ kind: 'mcpAdd', name: 'Maestro', scope: 'preset' })).toMatch(/^Maestro is on the preset game-dev's list/)
  expect(json(`${GD}/library.json`).mcps).toEqual(['Unity', 'Maestro'])
  expect(await page({ kind: 'mcpDrop', name: 'maestro', scope: 'preset' })).toBe("Maestro is off the preset game-dev's list.")
  expect(await page({ kind: 'presetNone' })).toBe('game-dev no longer applies here. Nothing was deleted.')
  expect(await page({ kind: 'presetNew', name: 'Second' })).toMatch(/^Made the preset second/)
  expect(await page({ kind: 'presetMove', name: 'second' })).toMatch(/^Moved this project's settings into second: the instruction notes\./)
  expect(await page({ kind: 'presetDelete', name: 'second' })).toMatch(/^Deleted the preset second/)
  expect(json(LIB)).toEqual({})
})

test('only the user makes, uses, moves or deletes a preset', async ($: any, on: any) => {
  const { eng, sentinel } = await session($, on)
  gameDev(eng)
  const files = JSON.stringify(eng.files)
  for (const args of ['preset new x', 'preset game-dev', 'preset none', 'preset move x', 'preset delete game-dev']) {
    expect(await sentinel(args, { kind: 'plugin' })).toMatch(/^Only the user runs \/sentinel preset/)
  }
  expect(JSON.stringify(eng.files)).toBe(files)
})

// ---- the preset as a layer ----

test('the closest place wins: this project, then the preset in use, then every project', () => {
  const items = [...BUILTINS.map(b => ({ name: b.name, weights: b.weights })), { name: 'mine', own: true }]
  // [this project, the preset, every project, item, on?]
  const rows: [Switches, Switches, Switches, string, boolean][] = [
    [{}, {}, { on: { mine: false } }, 'mine', false],
    [{}, { on: { mine: true } }, { on: { mine: false } }, 'mine', true],
    [{ on: { mine: false } }, { on: { mine: true } }, {}, 'mine', false],
    // A closer weight ends a farther place's switch on a built-in, and leaves the one on the user's own item.
    [{}, { weight: 'light' }, { on: { 'failure-list': true } }, 'failure-list', false],
    [{ weight: 'standard' }, { on: { 'failure-list': false } }, {}, 'failure-list', true],
    [{}, { weight: 'light' }, { on: { mine: false } }, 'mine', false],
    // A farther weight leaves a closer switch alone.
    [{}, { on: { 'failure-list': false } }, { weight: 'thorough' }, 'failure-list', false],
    // state-settings is in no weight, so its switch stands under any.
    [{ weight: 'light' }, { on: { [STATE_SETTINGS]: true } }, {}, STATE_SETTINGS, true],
  ]
  rows.forEach(([project, preset, personal, name, want], i) => expect([i, libraryOn(items, project, personal, preset).on.includes(name)]).toEqual([i, want]))
  // The weight: the closest place that picked one, then Standard.
  expect(libraryOn(items, {}, { weight: 'thorough' }, { weight: 'light' }).weight).toBe('light')
  expect(libraryOn(items, { weight: 'thorough' }, {}, { weight: 'light' }).weight).toBe('thorough')
  expect(libraryOn(items).weight).toBe('standard')
  // handOf names the switches that decide, by the same rule.
  expect(handOf(items, {}, { on: { 'failure-list': false } }, { weight: 'light', on: { mine: true } })).toEqual({ mine: true })
})

test('a preset\'s own items show only in a project that uses it, and the project\'s file of a name wins', async ($: any, on: any) => {
  const { eng, clock, sentinel } = await session($, on)
  gameDev(eng)
  const item = (name: string) => eng.snap().library.instructions.find((x: any) => x.name === name)
  const flow = (name: string) => eng.snap().flows.find((f: any) => f.name === name)
  await sentinel('library')
  expect(item('playtest')).toBeUndefined()
  expect(flow('build')).toBeUndefined()
  eng.files[LIB] = JSON.stringify({ preset: 'game-dev' })
  await sentinel('trust playtest')
  await sentinel('trust build')
  const listed = await sentinel('library')
  // The page's snapshot is written in the background.
  await until(clock, () => flow('build')?.trusted && eng.snap().library.using)
  expect(listed).toMatch(/^Weight: thorough \(from the preset game-dev\)\.$/m)
  expect(listed).toMatch(/^on +playtest \(preset game-dev, close\): /m)
  expect(item('playtest')).toMatchObject({ scope: 'preset', on: true, file: '~/.sentinel/presets/game-dev/instructions/playtest.json' })
  expect(item('notes')).toMatchObject({ scope: 'project', text: "The project's notes." })
  expect(item('fails-first').on).toBe(false)
  expect(flow('build')).toMatchObject({ scope: 'preset', file: '~/.sentinel/presets/game-dev/flows/build.json', trusted: true })
  expect(eng.snap().library.using).toEqual({ name: 'game-dev', weight: 'thorough', on: { 'fails-first': false } })
  // With no preset they go, and the weight is Standard again. Trusting the project's file writes the snapshot again.
  eng.files[LIB] = JSON.stringify({})
  await sentinel('trust notes')
  await until(clock, () => !eng.snap().library.using)
  expect(item('playtest')).toBeUndefined()
  expect(eng.snap().library.weight).toBe('standard')
  expect(await sentinel('library')).not.toMatch(/playtest|build/)
})

test('a switch, weight or saved flow goes to the preset in use, and nowhere when none is or it isn\'t on this computer', async ($: any, on: any) => {
  const { eng, clock, sentinel, json, page } = await session($, on)
  const written = () => Object.keys(eng.files).filter(f => f.startsWith(PRESETS))
  const none = 'This project uses no preset, so there is none to change. /sentinel preset <name> picks one.'
  expect(await sentinel('weight light preset')).toBe(none)
  expect(await sentinel('off failure-list preset')).toBe(none)
  expect(written()).toEqual([])
  // One that isn't on this computer is said, and a write never makes it again.
  eng.files[LIB] = JSON.stringify({ preset: 'gone' })
  const gone = "The preset gone isn't on this computer, so Sentinel can't change it. Import it, or pick another with /sentinel preset <name>."
  expect(await sentinel('weight light preset')).toBe(gone)
  expect(await page({ kind: 'libon', name: 'failure-list', scope: 'preset', on: false })).toBe(gone)
  expect(written()).toEqual([])
  expect(await sentinel('library')).toMatch(/^The preset gone isn't on this computer, so this project runs on its own settings and every project's\.$/m)
  await until(clock, () => eng.snap().library.using)
  expect(eng.snap().library.using).toEqual({ name: 'gone', missing: true })
  // In use: each goes to the preset's files, and the project's file only points at it.
  gameDev(eng)
  eng.files[LIB] = JSON.stringify({ preset: 'game-dev' })
  expect(await sentinel('weight standard preset')).toBe('The weight is standard in the preset game-dev. The built-ins follow it; your own items keep their switches.')
  expect(json(`${GD}/library.json`)).toEqual({ weight: 'standard' })
  expect(await sentinel('off failure-list preset')).toBe('failure-list is off in the preset game-dev.')
  expect(json(`${GD}/library.json`)).toEqual({ weight: 'standard', on: { 'failure-list': false } })
  // Every project is farther than the preset, so the preset decides.
  expect(await sentinel('on failure-list everywhere')).toBe('failure-list is on for every project. The preset game-dev decides it here, so it stays off.')
  expect(json(`${HOME}/.sentinel/library.json`).on['failure-list']).toBe(true)
  expect(await sentinel('weight light everywhere')).toBe('The weight is light for every project. The preset game-dev picked standard, which wins here.')
  expect(await page({ kind: 'saveflow', scope: 'preset', flow: { name: 'lint', states: [{ id: 'lint', label: 'Lint passes', check: 'npm run lint' }] } })).toBe('Saved the flow "lint" to ~/.sentinel/presets/game-dev/flows/lint.json.')
  expect(json(`${GD}/flows/lint.json`)).toMatchObject({ states: [{ id: 'lint' }] })
  expect(json(LIB)).toEqual({ preset: 'game-dev' })
  // The old word is gone, so the page and the commands use one name.
  expect(await sentinel('on failure-list personal')).toMatch(/^Sentinel has no \/sentinel on failure-list personal/)
})

test('a pointer that isn\'t a plain name reads and writes nothing outside the presets folder', async ($: any, on: any) => {
  const { eng, sentinel } = await session($, on)
  // At both spellings, as a real disk resolves the dots.
  const EVIL = `${HOME}/.sentinel/evil/library.json`
  eng.files[EVIL] = JSON.stringify({ weight: 'light' })
  eng.files[`${PRESETS}/../evil/library.json`] = JSON.stringify({ weight: 'light' })
  eng.files[LIB] = JSON.stringify({ preset: '../evil' })
  const listed = await sentinel('library')
  expect(listed).toMatch(/^Weight: standard \(Sentinel's default\)\.\nThe preset \.\.\/evil isn't on this computer,/)
  expect(await sentinel('weight thorough preset')).toMatch(/isn't on this computer/)
  for (const f of [EVIL, `${PRESETS}/../evil/library.json`]) expect(eng.files[f]).toBe(JSON.stringify({ weight: 'light' }))
})

test('a plan locked while a preset is in use runs on its weight and switches', async ($: any, on: any) => {
  const { eng } = await session($, on)
  gameDev(eng, { weight: 'thorough', on: { 'fails-first': false, 'quote-the-source': false } })
  eng.files[LIB] = JSON.stringify({ preset: 'game-dev' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [{ id: 'a', label: 'A', check: 'npm test', files: ['src/**'] }] })
  const lib = (eng.memory.run as Run).library!
  expect(lib.weight).toBe('thorough')
  expect(lib.on).not.toContain('fails-first')
  expect(lib.on).toContain('fails-without-change')
})

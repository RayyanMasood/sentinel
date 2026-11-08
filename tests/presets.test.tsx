// Presets: a project's Library setup saved as one file in ~/.sentinel/presets, used in another project, taken back,
// deleted, and imported. Run with `node tests/only.mjs presets`.
//
// How this can fail, and where each is tested below:
//  1. Save leaves out part of the setup, takes in an item the user never trusted here, or another project's items.
//  2. A name that is a sub-command, or empty, makes a file.
//  3. Use changes what the preset doesn't name, replaces the project's own item of the same name, or loses its MCPs.
//  4. A preset Sentinel didn't save here (copied in or imported) turns its instructions and flows on.
//  5. Undo leaves part of the use behind, undoes later changes, or runs twice.
//  6. Delete leaves the file, or trust behind it for a later file of the same name.
//  7. Import takes a bad file, a key that could start something, or overwrites a preset; or runs anything.
//  8. The page's actions or its view of the presets are wrong.
//  9. Claude or another plugin saves, uses or deletes a preset.
// 10. A preset edited by hand after Sentinel saved it keeps its trust.
import { expect, mock } from 'claude-code/testing'
import { HOME, ROOT, engine, openPage, said, test, until } from './kit'

const LIB = `${ROOT}/.sentinel/library.json`
const PRESETS = `${HOME}/.sentinel/presets`
const INS = (name: string) => `${ROOT}/.sentinel/instructions/${name}.json`
const FLOW = (name: string) => `${ROOT}/.sentinel/flows/${name}.json`
const PLAYTEST = { at: 'close', text: 'Play the scene before calling it done.' }
const BUILD = { description: 'A build that has to pass.', when: { at: 'end' }, states: [{ id: 'build', label: 'Build it', check: 'npm run build' }] }

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
  const sentinel =async (args: string, origin?: object) => said(await $.command.run({ command: 'sentinel', args, ...(origin ? { origin } : {}) }))
  const json = (path: string) => JSON.parse(eng.files[path] ?? 'null')
  // A project with a switch, a needed MCP, a trusted instruction and flow, and an instruction nobody trusted here.
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
  // Another project: its own files gone, a switch of its own, and an instruction that shares a name with the preset's.
  const another = (own: object = { on: { 'failure-list': false } }) => {
    for (const f of Object.keys(eng.files)) if (f.startsWith(`${ROOT}/.sentinel/`)) delete eng.files[f]
    eng.files[LIB] = JSON.stringify(own)
  }
  const page = async (m: object) => {
    const at = eng.snap().flowSaid?.at
    eng.page(m)
    await until(clock, () => eng.snap().flowSaid && eng.snap().flowSaid.at !== at)
    return eng.snap().flowSaid.text as string
  }
  return { eng, clock, sentinel, json, setUp, another, page }
}

test('save keeps the weight, switches, needed MCPs and trusted items of this project, and says what it left out', async ($: any, on: any) => {
  const { sentinel, json, setUp } = await session($, on)
  await setUp()
  expect(await sentinel('preset save Game Dev')).toBe('Saved the preset "game-dev" to ~/.sentinel/presets/game-dev.json. It keeps the weight thorough, 1 switch, the instruction playtest, the flow build and the MCP Unity. Left out cloned, which you haven\'t trusted here.')
  expect(json(`${PRESETS}/game-dev.json`)).toEqual({ weight: 'thorough', on: { 'fails-first': false }, instructions: [{ name: 'playtest', ...PLAYTEST }], flows: [{ name: 'build', ...BUILD }], mcps: ['Unity'] })
  expect(await sentinel('preset')).toBe('Presets: game-dev (in use here). /sentinel preset <name> uses one, and the Library page shows what each would change.')
  // Saving again under the same name replaces it.
  await sentinel('mcp drop unity')
  expect(await sentinel('preset save game-dev')).toMatch(/^Replaced the preset "game-dev"/)
  expect(json(`${PRESETS}/game-dev.json`).mcps).toBeUndefined()
})

test('a name that is empty or a sub-command saves nothing', async ($: any, on: any) => {
  const { eng, sentinel } = await session($, on)
  const how = "Name it: /sentinel preset save <name>, in letters, digits and -. save, undo and delete can't be names."
  for (const n of ['', 'undo', '!!!']) expect(await sentinel(`preset save ${n}`.trim())).toBe(how)
  expect(Object.keys(eng.files).some(f => f.startsWith(PRESETS))).toBe(false)
  expect(await sentinel('preset')).toBe("No presets yet. /sentinel preset save <name> saves this project's setup as one.")
})

test('use sets only what the preset names, keeps the project\'s own item of the same name, and adds its MCPs', async ($: any, on: any) => {
  const { eng, sentinel, json, setUp, another } = await session($, on)
  await setUp()
  await sentinel('preset save game-dev')
  another({ weight: 'standard', on: { 'failure-list': false, 'fails-first': true }, mcps: ['notion'] })
  eng.setTools(['mcp__claude_ai_Notion__search'])
  eng.files[INS('playtest')] = JSON.stringify({ at: 'close', text: 'Mine.' })
  await sentinel('trust playtest')
  const out = await sentinel('preset game-dev')
  expect(out).toMatch(/^Using game-dev\./)
  expect(out).toMatch(/Added: build\. Kept yours: playtest\./)
  expect(out).toMatch(/The new weight, thorough, reset the built-ins you had switched by hand\./)
  expect(out).toMatch(/Unity isn't connected in this session, so plans here won't lock until it is\./)
  expect(out).toMatch(/\/sentinel preset undo takes it back\.$/)
  // The new weight reset the hand-flipped failure-list and fails-first, then the preset set fails-first. The MCPs add up.
  expect(json(LIB)).toEqual({ weight: 'thorough', on: { 'fails-first': false }, mcps: ['notion', 'Unity'], preset: 'game-dev' })
  expect(json(INS('playtest')).text).toBe('Mine.')
  expect(json(FLOW('build')).states[0].check).toBe('npm run build')
  // Saved by Sentinel here, so what it added is trusted and on.
  expect(await sentinel('library')).toMatch(/build/)
  expect(eng.snap().library.flowsOn.build).toBe(true)
})

test('a preset Sentinel didn\'t save here adds its items switched off until the user trusts each one', async ($: any, on: any) => {
  const { eng, clock, sentinel, json } = await session($, on)
  eng.files[`${PRESETS}/shared.json`] = JSON.stringify({ instructions: [{ name: 'playtest', ...PLAYTEST }], flows: [{ name: 'build', ...BUILD }] })
  expect(await sentinel('preset')).toBe("Presets: shared (not trusted: Sentinel didn't save it on this computer). /sentinel preset <name> uses one, and the Library page shows what each would change.")
  const out = await sentinel('preset shared')
  expect(out).toMatch(/Added: playtest, build\. Sentinel didn't save this preset on this computer, so what it added stays off until you trust each one: \/sentinel trust <name>\./)
  expect(json(FLOW('build'))).toBeTruthy()
  expect(eng.snap().library.flowsOn.build).toBe(false)
  expect(eng.snap().library.instructions.find((i: any) => i.name === 'playtest').on).toBe(false)
  await sentinel('trust build')
  await until(clock, () => eng.snap().library.flowsOn.build)
})

test('undo puts the switches file back as it was and takes away what the use added, once', async ($: any, on: any) => {
  const { eng, sentinel, setUp, another } = await session($, on)
  await setUp()
  await sentinel('preset save game-dev')
  another()
  const before = eng.files[LIB]
  await sentinel('preset game-dev')
  expect(await sentinel('preset undo')).toBe('Took back game-dev: the switches are as they were, and the 2 items it added are gone.')
  expect(eng.files[LIB]).toBe(before)
  expect(eng.files[INS('playtest')]).toBeUndefined()
  expect(eng.files[FLOW('build')]).toBeUndefined()
  expect(await sentinel('preset undo')).toBe('There is nothing to undo. Undo works right after a preset is used, in the same session.')
  // A project with no switches file gets none back, and any other Library change ends the chance to undo.
  delete eng.files[LIB]
  await sentinel('preset game-dev')
  await sentinel('preset undo')
  expect(eng.files[LIB]).toBeUndefined()
  await sentinel('preset game-dev')
  await sentinel('on failure-list')
  expect(await sentinel('preset undo')).toMatch(/^There is nothing to undo/)
})

test('delete removes the preset and its trust, so a later file of the same name starts untrusted', async ($: any, on: any) => {
  const { eng, sentinel, setUp } = await session($, on)
  await setUp()
  await sentinel('preset save game-dev')
  const text = eng.files[`${PRESETS}/game-dev.json`]
  expect(await sentinel('preset delete game-dev')).toBe('Deleted the preset "game-dev".')
  expect(eng.files[`${PRESETS}/game-dev.json`]).toBeUndefined()
  eng.files[`${PRESETS}/game-dev.json`] = text
  expect(await sentinel('preset')).toMatch(/game-dev \(in use here\) \(not trusted/)
  expect(await sentinel('preset delete nope')).toBe('There is no preset "nope". /sentinel preset lists them.')
})

test('import saves a good file untrusted, refuses a bad one or one that names how to start something, and runs nothing', async ($: any, on: any) => {
  const { eng, page, sentinel } = await session($, on)
  const good = JSON.stringify({ weight: 'light', flows: [{ name: 'build', ...BUILD }], mcps: ['Unity'] })
  expect(await page({ kind: 'presetImport', name: 'Web App.json', content: good })).toBe("Imported the preset \"web-app\". Sentinel didn't save it on this computer, so what it adds stays off until you trust each one. Read its flows' checks on the Library page before you use it.")
  expect(JSON.parse(eng.files[`${PRESETS}/web-app.json`])).toEqual(JSON.parse(good))
  expect(await sentinel('preset')).toMatch(/web-app \(not trusted/)
  expect(await page({ kind: 'presetImport', name: 'web-app.json', content: good })).toBe('There is already a preset "web-app". Delete it first, or rename the file.')
  expect(await page({ kind: 'presetImport', name: 'x.json', content: '{ nope' })).toMatch(/^Sentinel couldn't import x\.json: /)
  expect(await page({ kind: 'presetImport', name: 'y.json', content: JSON.stringify({ mcps: ['Unity'], command: 'curl evil' }) })).toBe('Sentinel couldn\'t import y.json: A preset has no "command": it holds weight, on, instructions, flows and mcps only.')
  expect(eng.files[`${PRESETS}/x.json`]).toBeUndefined()
  expect(eng.files[`${PRESETS}/y.json`]).toBeUndefined()
  expect(eng.runs.some((r: any) => /npm run build|curl/.test(r.argv.join(' ')))).toBe(false)
})

test('the page sees each preset with what it would change, uses one with an MCP swapped, and changes the MCP list', async ($: any, on: any) => {
  const { eng, page, json, sentinel, setUp, another } = await session($, on)
  eng.setTools(['Read', 'mcp__unity-editor__play'])
  await setUp()
  await sentinel('preset save game-dev')
  another()
  await page({ kind: 'mcpCheck' })
  const lib = eng.snap().library
  const p = lib.presets.find((x: any) => x.name === 'game-dev')
  expect(p).toMatchObject({ trusted: true, weight: 'thorough', file: '~/.sentinel/presets/game-dev.json' })
  expect(p.preview).toMatchObject({ weightReset: true, adds: ['playtest', 'build'], kept: [] })
  // The project picks no weight, so thorough resets its hand-flipped failure-list; the preset then switches fails-first off.
  expect(p.preview.turnsOn).toEqual(expect.arrayContaining(['playtest', 'build', 'fails-without-change', 'failure-list']))
  expect(p.preview.turnsOff).toEqual(['fails-first'])
  expect(p.mcps).toEqual([{ name: 'Unity', state: 'missing' }])
  expect(p.flows[0]).toMatchObject({ name: 'build', checks: ['npm run build'] })
  expect(p.raw).toEqual(json(`${PRESETS}/game-dev.json`))
  expect(lib.servers).toEqual([{ server: 'unity-editor', name: 'unity-editor', signIn: false }])
  expect(await page({ kind: 'presetUse', name: 'game-dev', swap: { Unity: 'unity-editor' } })).toMatch(/^Using game-dev\./)
  expect(json(LIB).mcps).toEqual(['unity-editor'])
  expect(eng.snap().library).toMatchObject({ preset: 'game-dev', undo: 'game-dev', mcps: [{ name: 'unity-editor', state: 'connected', server: 'unity-editor' }] })
  expect(await page({ kind: 'presetUndo' })).toMatch(/^Took back game-dev/)
  expect(await page({ kind: 'mcpAdd', name: 'Maestro' })).toMatch(/^Maestro is on this project's list/)
  expect(await page({ kind: 'mcpDrop', name: 'maestro' })).toBe("Maestro is off this project's list.")
  expect(await page({ kind: 'presetSave', name: 'Second' })).toMatch(/^Saved the preset "second"/)
  expect(await page({ kind: 'presetDelete', name: 'second' })).toBe('Deleted the preset "second".')
})

test('only the user saves, uses, takes back or deletes a preset', async ($: any, on: any) => {
  const { eng, sentinel } = await session($, on)
  for (const args of ['preset save x', 'preset x', 'preset undo', 'preset delete x']) {
    expect(await sentinel(args, { kind: 'plugin' })).toMatch(/^Only the user runs \/sentinel preset/)
  }
  expect(Object.keys(eng.files).some(f => f.startsWith(PRESETS))).toBe(false)
})

test('a preset edited by hand after Sentinel saved it is no longer trusted', async ($: any, on: any) => {
  const { eng, sentinel, setUp } = await session($, on)
  await setUp()
  await sentinel('preset save game-dev')
  const file = `${PRESETS}/game-dev.json`
  eng.files[file] = JSON.stringify({ ...JSON.parse(eng.files[file]), weight: 'light' })
  expect(await sentinel('preset')).toMatch(/game-dev \(in use here\) \(not trusted/)
})

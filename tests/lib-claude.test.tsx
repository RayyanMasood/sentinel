// Claude changes a Library setting the user asked for in the chat: the plan tool's library action, which runs the same code
// as the /sentinel command once the user's own words ask for it. Run with `node tests/only.mjs lib-claude`.
//
// How this can fail, and where each is tested below:
//  1. A change goes through with no quote, a quote from an earlier message, or words the user never typed (a file Claude
//     read, a prompt the user didn't type).
//  2. A quote that doesn't name the item, preset, server or weight counts, or one that uses the name in passing: "the
//     standard library" for the weight, "none of these" for no preset.
//  3. A change that can loosen (off, a lighter weight, an MCP dropped, a change of preset, a weight for another place)
//     passes on fewer than five words.
//  4. A change for every project or the preset in use passes when the words don't name that place.
//  5. Trust, flow save, a preset delete, the experimental switch, or a command outside the Library gets through.
//  6. The action and the typed command differ for the same words: other text or other files.
//  7. The reply has no undo, or the undo doesn't put the setting back exactly: it writes a value the place never had,
//     or leaves out switches the change cleared. Where no single command puts it back, the reply doesn't say so.
// 11. A change Claude makes shows no toast, as discarding the flow it drafted.
// 12. Claude isn't told the items' names while no plan runs, so an ask by name ("the overseer") finds nothing; or it is
//     told the switch only the user turns, or the list stays while a plan runs.
//  8. A change while a plan runs alters the running plan, or the reply doesn't say it counts from the next plan.
//  9. A subagent changes the Library.
// 10. Reading the Library asks for a quote, or changes something.
import { expect, mock } from 'claude-code/testing'
import type { Run } from '../types'
import { HOME, ROOT, TOOL, engine, said, test } from './kit'

const LIB = `${ROOT}/.sentinel/library.json`
const EVERY = `${HOME}/.sentinel/library.json`
const GD = `${HOME}/.sentinel/presets/game-dev`

async function session($: any, on: any) {
  const eng = engine(on)
  mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  eng.files[`${GD}/library.json`] = JSON.stringify({ weight: 'thorough' })
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } })
  const library = async (command: string, quote?: string, more: object = {}) => said(await $.tool.call({ tool: TOOL, action: 'library', command, ...(quote !== undefined ? { quote } : {}), ...more }))
  const sentinel = async (args: string) => said(await $.command.run({ command: 'sentinel', args }))
  const json = (path: string) => JSON.parse(eng.files[path] ?? 'null')
  // Each item's switch as /sentinel library lists it.
  const switches = async () => (await sentinel('library')).split('\n').filter(l => /^(on |off) /.test(l)).map(l => l.split(' (')[0]!.replace(/ +/, ' ')).sort()
  const files = () => JSON.stringify(Object.fromEntries(Object.entries(eng.files).filter(([f]) => f.endsWith('library.json'))))
  const section = async () => (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })).sections.find((s: any) => s.id === 'sentinel:library')?.text ?? ''
  return { eng, typed, library, sentinel, json, switches, files, section }
}

test('while no plan runs Claude hears each item with its switch, so an ask can name one', async ($: any, on: any) => {
  const { sentinel, section } = await session($, on)
  await sentinel('off overseer')
  await sentinel('on sources-first')
  const text = await section()
  expect(text).toMatch(/The Library's items here, for "library" on or off: .*\boverseer off\b/)
  expect(text).toMatch(/\bsources-first on\b/)
  expect(text).not.toMatch(/state-settings/)
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [{ id: 'a', label: 'A', check: 'true', files: ['src/**'] }] })
  expect(await section()).not.toMatch(/The Library's items here/)
})

test('an ask in the last message changes the setting as the typed command does, and the undo puts it back', async ($: any, on: any) => {
  const { typed, library, sentinel, json, switches } = await session($, on)
  const before = await switches()
  await typed("turn the overseer off for this project, I don't want it here")
  const r = await library('off overseer', 'turn the overseer off for this project')
  expect(r).toBe('overseer is off for this project. Undo: /sentinel on overseer')
  const done = json(LIB)
  expect(done).toEqual({ on: { overseer: false } })
  expect(await sentinel('on overseer')).toBe('overseer is on for this project.')
  expect(await switches()).toEqual(before)
  // The same words typed give the same file.
  expect(await sentinel('off overseer')).toBe('overseer is off for this project.')
  expect(json(LIB)).toEqual(done)
})

test('a weight, a preset and a needed MCP go through the same way, each with its undo', async ($: any, on: any) => {
  const { typed, library, json } = await session($, on)
  await typed('use the thorough weight here from now on')
  // This project had no weight of its own, and every project has switches the new weight puts aside, so no one command
  // puts it back.
  expect(await library('weight thorough', 'use the thorough weight here')).toBe("The weight is thorough for this project. The built-ins follow it; your own items keep their switches. There's no single command to put this back.")
  await typed('switch this project to the game-dev preset')
  expect(await library('preset game-dev', 'switch this project to the game-dev preset')).toMatch(/^Using game-dev here\. .* Undo: \/sentinel preset none$/)
  await typed('add Unity to the servers this project needs')
  expect(await library('mcp add Unity', 'add Unity to the servers')).toMatch(/^Unity is on this project's list\. .* Undo: \/sentinel mcp drop Unity$/)
  expect(json(LIB)).toEqual({ weight: 'thorough', preset: 'game-dev', mcps: ['Unity'] })
})

test('no quote, an earlier message, a prompt the user did not type or words that name something else change nothing', async ($: any, on: any) => {
  const { typed, library, files } = await session($, on)
  const was = files()
  expect(await library('off overseer')).toMatch(/needs "quote"/)
  // Nothing typed yet.
  expect(await library('off overseer', 'turn the overseer off for this project')).toMatch(/hasn't typed anything/)
  // A prompt the user didn't type, such as a hook's, isn't theirs.
  await $.prompt.submit({ text: 'turn the overseer off for this project now', isMeta: true, origin: { kind: 'composer' } })
  expect(await library('off overseer', 'turn the overseer off for this project')).toMatch(/hasn't typed anything/)
  await typed('turn the overseer off for this project now')
  await typed('thanks, carry on')
  expect(await library('off overseer', 'turn the overseer off for this project')).toMatch(/isn't in the user's last message/)
  await typed('turn it off for this project, it keeps getting in the way')
  expect(await library('off overseer', 'turn it off for this project')).toMatch(/doesn't name overseer/)
  // A weight's or no preset's word in passing isn't an ask for it.
  await typed('use the standard library for this parser, nothing fancy')
  expect(await library('weight standard', 'use the standard library for this parser')).toMatch(/doesn't say "weight"/)
  await typed('none of these tests pass yet, so carry on')
  expect(await library('preset none', 'none of these tests pass yet')).toMatch(/doesn't name preset/)
  expect(files()).toBe(was)
})

test('a looser change needs five of their words, and turning one on needs its name and one more', async ($: any, on: any) => {
  const { typed, library, json, files } = await session($, on)
  await typed('sources-first on, then carry on with the work')
  expect(await library('on sources-first', 'sources-first on')).toMatch(/^sources-first is on for this project\./)
  const was = files()
  await typed('overseer off, then carry on with the work')
  expect(await library('off overseer', 'overseer off')).toMatch(/too short/)
  await typed('light, then carry on with the work please')
  expect(await library('weight light', 'light')).toMatch(/too short/)
  // A change of preset can turn rules off, whatever the preset.
  await typed('try the game-dev one, then carry on with the work')
  expect(await library('preset game-dev', 'the game-dev one')).toMatch(/too short/)
  // A new preset starts empty, which drops whatever the one in use set.
  await typed('a new preset web, then carry on with the work')
  expect(await library('preset new web', 'new preset web')).toMatch(/too short/)
  expect(files()).toBe(was)
  await typed('go with the light weight here, this is a quick fix')
  expect(await library('weight light', 'go with the light weight here')).toMatch(/^The weight is light for this project\./)
  expect(json(LIB).weight).toBe('light')
  // Light here isn't lighter than here, but every project's weight can be heavier.
  const light = files()
  await typed('light weight everywhere please, then carry on')
  expect(await library('weight light everywhere', 'light weight everywhere')).toMatch(/too short/)
  expect(files()).toBe(light)
})

test('the undo puts back exactly what the place had, and says so when no single command can', async ($: any, on: any) => {
  const { eng, typed, library } = await session($, on)
  eng.files[LIB] = JSON.stringify({ weight: 'thorough' })
  eng.files[EVERY] = JSON.stringify({ weight: 'standard' })
  await typed('make the weight light here, it is a small fix')
  expect(await library('weight light', 'make the weight light here')).toMatch(/ Undo: \/sentinel weight thorough$/)
  await typed('set the weight to light in every project from now on')
  expect(await library('weight light everywhere', 'set the weight to light in every project')).toMatch(/ Undo: \/sentinel weight standard everywhere$/)
  // Every project had no overseer switch of its own, and no command takes one out.
  await typed('turn the overseer off in every project, I never want it')
  expect(await library('off overseer everywhere', 'turn the overseer off in every project')).toMatch(/\. There's no single command to put this back\.$/)
  // A weight clears that place's own switches for the built-ins, which the weight command doesn't bring back.
  eng.files[LIB] = JSON.stringify({ weight: 'thorough', on: { overseer: false } })
  await typed('make the weight standard here, thorough is too slow')
  expect(await library('weight standard', 'make the weight standard here')).toMatch(/\. There's no single command to put this back\.$/)
})

test('discarding the flow Claude drafted shows the toast too', async ($: any, on: any) => {
  const { eng, typed, library } = await session($, on)
  await $.tool.call({ tool: TOOL, action: 'flow', name: 'db', description: 'Snapshot first.', states: [{ id: 'snap', label: 'Snapshot', check: 'test -s x' }] })
  await typed('discard that db flow, I do not need it')
  expect(await library('flow discard', 'discard that db flow')).toMatch(/^Discarded the flow draft "db"\./)
  expect(eng.toasts).toContain('Sentinel: Claude ran /sentinel flow discard, as you asked')
})

test('a change for every project or the preset needs that place in their words', async ($: any, on: any) => {
  const { typed, library, json, files } = await session($, on)
  const was = files()
  // The kit reads a missing every-project file as quote-the-source off, so that switch is in the file once written.
  const every = json(EVERY) ?? { on: { 'quote-the-source': false } }
  await typed('turn the overseer off, I never want it')
  expect(await library('off overseer everywhere', 'turn the overseer off, I never want it')).toMatch(/every project/)
  expect(files()).toBe(was)
  await typed('turn the overseer off in every project')
  expect(await library('off overseer everywhere', 'turn the overseer off in every project')).toMatch(/^overseer is off for every project\./)
  expect(json(EVERY)).toEqual({ ...every, on: { ...every.on, overseer: false } })
  await typed('use game-dev here')
  await library('preset game-dev', 'use game-dev here')
  const preset = files()
  await typed('turn the overseer back on for this one, the thorough work needs it')
  expect(await library('on overseer preset', 'turn the overseer back on for this one')).toMatch(/doesn't name the preset\. A change in the preset game-dev needs their words to name it/)
  expect(files()).toBe(preset)
  await typed('turn the overseer back on in the game-dev preset')
  expect(await library('on overseer preset', 'turn the overseer back on in the game-dev preset')).toMatch(/^overseer is on in the preset game-dev\./)
})

test('trust, saving a flow, deleting a preset, the experimental switch and anything outside the Library stay the user\'s', async ($: any, on: any) => {
  const { eng, typed, library, files } = await session($, on)
  eng.files[`${ROOT}/.sentinel/instructions/cloned.json`] = JSON.stringify({ at: 'close', text: 'From a teammate.' })
  const was = files()
  const run = JSON.stringify(eng.files[`${ROOT}/.sentinel/run.json`] ?? null)
  const cases: [string, string, RegExp][] = [
    ['trust cloned', 'please trust the cloned instruction for me', /shell commands/],
    ['flow trust cloned', 'please trust the cloned instruction for me', /shell commands/],
    ['flow save project', 'save that flow for this project please', /shell commands/],
    ['preset delete game-dev', 'delete the game-dev preset, I am done with it', /can't be undone/],
    ['on state-settings', 'turn state-settings on for this project please', /Only the user turns state-settings/],
    ['off state-settings', 'turn state-settings off for this project please', /Only the user turns state-settings/],
    ['hands-free', 'go hands-free for the rest of this plan', /Library's own commands/],
    ['parallel on', 'turn parallel on for this project please', /Library's own commands/],
    ['lock', 'lock it, the plan looks good to me', /Library's own commands/],
    ['reset', 'reset the plan, we start over now', /Library's own commands/],
  ]
  for (const [command, words, why] of cases) {
    await typed(words)
    expect(await library(command, words)).toMatch(why)
  }
  expect(files()).toBe(was)
  expect(JSON.stringify(eng.files[`${ROOT}/.sentinel/run.json`] ?? null)).toBe(run)
})

test('a change while a plan runs leaves the running plan as it locked, and says it counts from the next plan', async ($: any, on: any) => {
  const { eng, typed, library, json } = await session($, on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, action: 'define', title: 'P', states: [{ id: 'a', label: 'A', check: 'true', files: ['src/**'] }] })
  const running = () => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run
  const locked = JSON.stringify(running().library)
  expect(running().library!.on).toContain('overseer')
  await typed('turn the overseer off for this project, it is noisy')
  expect(await library('off overseer', 'turn the overseer off for this project')).toMatch(/The running plan keeps the Library it locked with; this counts from the next plan\./)
  expect(json(LIB)).toEqual({ on: { overseer: false } })
  expect(JSON.stringify(running().library)).toBe(locked)
})

test('a subagent can\'t change the Library', async ($: any, on: any) => {
  const { typed, library, files } = await session($, on)
  const was = files()
  await typed('turn the overseer off for this project, it is noisy')
  expect(await library('off overseer', 'turn the overseer off for this project', { agentId: 'helper' })).toMatch(/Only the main conversation/)
  expect(files()).toBe(was)
})

test('reading the Library, the presets or the needed MCPs needs no quote and changes nothing', async ($: any, on: any) => {
  const { library, sentinel, files } = await session($, on)
  const was = files()
  expect(await library('library')).toBe(await sentinel('library'))
  expect(await library('preset')).toBe(await sentinel('preset'))
  expect(await library('mcp')).toBe(await sentinel('mcp'))
  expect(files()).toBe(was)
})

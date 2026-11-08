// A plan waits for the MCP servers its project needs. Run with `node tests/only.mjs mcp-gate`.
//
// How this can fail, and where each is tested below:
//  1. A project that needs no MCP stops locking, or waits for nothing.
//  2. A plan locks while a needed server is missing or only offers sign-in, by /sentinel lock or by an approved define.
//  3. A server under another spelling (claude_ai_Notion for Notion) counts as missing.
//  4. A server still connecting in a new session is called missing, or an old session waits for one that never comes.
//  5. A server gone when a state starts (a new session picked the plan up) goes unnoticed, or the run never goes on.
//  6. /sentinel mcp loses the list, keeps a name twice, or another switch change wipes it.
//  7. Claude or another plugin changes the list.
//  8. One place's list hides another's: this project's, the preset's in use, or every project's.
//  9. A running plan's list changes when the files do.
import { expect, mock } from 'claude-code/testing'
import { blockedOn } from '../hooks/core'
import type { Run } from '../types'
import { HOME, ROOT, TOOL, engine, said, test } from './kit'

const FILE = `${ROOT}/.sentinel/library.json`
const COPY = { id: 'copy', label: 'Copy', check: 'npm test -- copy', files: ['docs/**'] }
const FORM = { id: 'form', label: 'Form', check: 'npm test -- form', files: ['src/**'] }
const plan = { tool: TOOL, action: 'define', title: 'P', states: [COPY, FORM] }
const UNITY = 'mcp__unity__play', NOTION = 'mcp__claude_ai_Notion__notion-search'
const SIGN_IN = ['mcp__plugin_x_amp__authenticate', 'mcp__plugin_x_amp__complete_authentication']

async function session($: any, on: any, mcps?: string[], { young = false } = {}) {
  const eng = engine(on)
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // Servers connect over a session's first half minute; most tests run later than that.
  if (!young) await clock.advance(60_000)
  // No weight here: a project's weight turns quoting on, which these plans leave out.
  if (mcps) eng.files[FILE] = JSON.stringify({ mcps })
  const sentinel = async (args: string, origin?: object) => said(await $.command.run({ command: 'sentinel', args, ...(origin ? { origin } : {}) }))
  return {
    eng, clock, sentinel,
    saved: () => JSON.parse(eng.files[FILE] ?? '{}'),
    running: () => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`] ?? '{}') as Run,
    // A draft to lock: signed off with /sentinel lock, then Claude's define.
    drafted: async () => {
      await sentinel('lock')
      expect(said(await $.tool.call(plan))).toMatch(/Draft saved/)
    },
  }
}

test('a project that needs no MCP locks as it always did', async ($: any, on: any) => {
  const { sentinel, drafted } = await session($, on)
  await drafted()
  expect(await sentinel('lock')).toMatch(/^Locked "P"/)
})

test('/sentinel lock is refused while a needed server is missing, and goes through once it is there', async ($: any, on: any) => {
  const { eng, sentinel, drafted } = await session($, on, ['Unity'])
  await drafted()
  expect(await sentinel('lock')).toBe("Unity isn't connected in this session. Connect it with /mcp, then lock again. Nothing was locked.")
  eng.setTools(['Read', UNITY])
  expect(await sentinel('lock')).toMatch(/^Locked "P"/)
})

test('a server that only offers sign-in refuses the lock too, and the words say so', async ($: any, on: any) => {
  const { eng, sentinel, drafted } = await session($, on, ['amp', 'Unity'])
  eng.setTools(['Read', ...SIGN_IN])
  await drafted()
  expect(await sentinel('lock')).toBe("Unity isn't connected in this session, and amp needs you to sign in. Connect them with /mcp, then lock again. Nothing was locked.")
})

test('a server spelled another way by the tools still counts', async ($: any, on: any) => {
  const { eng, sentinel, drafted } = await session($, on, ['Notion', 'unity'])
  eng.setTools(['Read', NOTION, UNITY])
  await drafted()
  expect(await sentinel('lock')).toMatch(/^Locked "P"/)
})

test('a plan approved in plan mode does not lock while a server is missing, and Claude is told what to tell the user', async ($: any, on: any) => {
  const { eng, running } = await session($, on, ['Unity'])
  await $.tool.call({ tool: 'ExitPlanMode' })
  const r = await $.tool.call(plan)
  expect(r.deny).toBe("The plan can't lock: Unity isn't connected in this session. Ask the user to connect it with /mcp, then send define again. Nothing was locked.")
  expect(running().plan).toBeUndefined()
  eng.setTools([UNITY])
  expect(said(await $.tool.call(plan))).toMatch(/^Locked "P"/)
})

test('in a new session Sentinel waits a little for a server still connecting', async ($: any, on: any) => {
  const { eng, clock, sentinel, drafted } = await session($, on, ['Unity'], { young: true })
  await drafted()
  const locking = sentinel('lock')
  await clock.advance(3000)
  eng.setTools([UNITY])
  for (let i = 0; i < 10; i++) await clock.advance(1000)
  expect(await locking).toMatch(/^Locked "P"/)
})

test('in a new session it stops waiting after 15 seconds, and an old session does not wait at all', async ($: any, on: any) => {
  const young = await session($, on, ['Unity'], { young: true })
  await young.drafted()
  let done = false
  const locking = young.sentinel('lock').then(t => ((done = true), t))
  for (let i = 0; i < 12 && !done; i++) await young.clock.advance(1000)
  expect(done).toBe(false)
  for (let i = 0; i < 10 && !done; i++) await young.clock.advance(1000)
  expect(await locking).toMatch(/^Unity isn't connected/)
})

test('a state that starts with a server gone waits on the user, and goes on once it is back', async ($: any, on: any) => {
  const { eng, running } = await session($, on, ['Unity'])
  eng.setTools([UNITY])
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(said(await $.tool.call(plan))).toMatch(/^Locked "P"/)
  eng.setTools(['Read'])
  const r = await $.tool.call({ tool: TOOL, action: 'advance', to: 'form', outcome: 'Copied.' })
  expect([said(r), ...(r.context ?? [])].join('\n')).toMatch(/Unity isn't connected in this session\. Sentinel stopped the run until the user connects it with \/mcp\. End your turn and tell them/)
  expect(blockedOn(running())?.what).toBe("Unity isn't connected in this session. Connect it with /mcp, then reply here.")
  // The user answers but it is still gone: the next plan call stops the run again.
  await $.prompt.submit({ text: 'done', origin: { kind: 'composer' } })
  expect(blockedOn(running())).toBeUndefined()
  const still = await $.tool.call({ tool: TOOL, action: 'status' })
  expect([said(still), ...(still.context ?? [])].join('\n')).toMatch(/Unity isn't connected/)
  expect(blockedOn(running())?.what).toMatch(/^Unity isn't connected/)
  // The user connects it and says so: the run goes on, and the next plan call finds it.
  eng.setTools([UNITY])
  await $.prompt.submit({ text: 'connected', origin: { kind: 'composer' } })
  const again = await $.tool.call({ tool: TOOL, action: 'status' })
  expect([said(again), ...(again.context ?? [])].join('\n')).not.toMatch(/isn't connected/)
  expect(blockedOn(running())).toBeUndefined()
})

test('/sentinel mcp lists, adds and drops, and other switch changes keep the list', async ($: any, on: any) => {
  const { eng, sentinel, saved } = await session($, on)
  eng.setTools(['Read', NOTION])
  expect(await sentinel('mcp')).toBe('This project needs no MCP servers. /sentinel mcp add <server> adds one. This session has: Notion.')
  expect(await sentinel('mcp add Unity')).toBe("Unity is on this project's list. It isn't connected in this session, so plans here won't lock until it is.")
  expect(await sentinel('mcp add notion')).toBe("notion is on this project's list. It is connected.")
  expect(await sentinel('mcp add UNITY')).toBe("Unity is already on this project's list.")
  expect(saved().mcps).toEqual(['Unity', 'notion'])
  expect(await sentinel('mcp')).toBe("This project needs: Unity (not connected in this session), notion (connected). This session has: Notion.")
  await sentinel('off fails-first')
  await sentinel('weight light')
  expect(saved()).toMatchObject({ weight: 'light', mcps: ['Unity', 'notion'] })
  expect(await sentinel('mcp drop unity')).toBe("Unity is off this project's list.")
  expect(await sentinel('mcp drop maestro')).toBe("maestro isn't on this project's list.")
  expect(await sentinel('mcp add')).toBe('Name the server: /sentinel mcp add <server>, as /mcp lists it.')
  expect(saved().mcps).toEqual(['notion'])
  await sentinel('mcp drop notion')
  expect('mcps' in saved()).toBe(false)
})

test('only the user changes the list, and a bad list in the file reads as none while the rest of the file holds', async ($: any, on: any) => {
  const { eng, sentinel, drafted, saved } = await session($, on)
  expect(await sentinel('mcp add Unity', { kind: 'plugin' })).toMatch(/^Only the user runs \/sentinel mcp/)
  expect('mcps' in saved()).toBe(false)
  eng.files[FILE] = JSON.stringify({ on: { 'fails-first': false }, mcps: 'Unity' })
  expect(await sentinel('mcp')).toMatch(/^This project needs no MCP servers\./)
  await drafted()
  expect(await sentinel('lock')).toMatch(/^Locked "P"/)
  await sentinel('mcp add Maestro')
  expect(saved()).toEqual({ on: { 'fails-first': false }, mcps: ['Maestro'] })
})

test('the needed servers add up across this project, the preset in use and every project', async ($: any, on: any) => {
  const { eng, sentinel, drafted } = await session($, on)
  const GD = `${HOME}/.sentinel/presets/game-dev/library.json`
  eng.files[GD] = JSON.stringify({ mcps: ['Unity'] })
  eng.files[FILE] = JSON.stringify({ mcps: ['Notion'], preset: 'game-dev' })
  eng.files[`${HOME}/.sentinel/library.json`] = JSON.stringify({ on: { 'quote-the-source': false }, mcps: ['maestro', 'notion'] })
  eng.setTools(['Read', NOTION])
  expect(await sentinel('mcp')).toBe('This project needs: Notion (connected), Unity (from game-dev, not connected in this session), maestro (from every project, not connected in this session). This session has: Notion.')
  await drafted()
  expect(eng.memory.run?.draft?.library?.mcps).toEqual(['Notion', 'Unity', 'maestro'])
  expect(await sentinel('lock')).toBe("Unity and maestro aren't connected in this session. Connect them with /mcp, then lock again. Nothing was locked.")
  // Each place keeps its own list.
  expect(await sentinel('mcp drop unity preset')).toBe("Unity is off the preset game-dev's list.")
  expect(await sentinel('mcp drop maestro everywhere')).toBe("maestro is off every project's list.")
  expect(JSON.parse(eng.files[GD]!)).toEqual({})
  expect(await sentinel('mcp add Unity everywhere')).toBe("Unity is on every project's list. It isn't connected in this session, so plans here won't lock until it is.")
  expect(JSON.parse(eng.files[`${HOME}/.sentinel/library.json`]!).mcps).toEqual(['notion', 'Unity'])
})

test('a running plan keeps the list it locked with when the files change', async ($: any, on: any) => {
  const { eng, sentinel, running } = await session($, on, ['Unity'])
  eng.setTools([UNITY])
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(said(await $.tool.call(plan))).toMatch(/^Locked "P"/)
  expect(running().library?.mcps).toEqual(['Unity'])
  // Taken off the list mid-run, Unity is still what this plan needs.
  await sentinel('mcp drop Unity')
  eng.setTools(['Read'])
  const r = await $.tool.call({ tool: TOOL, action: 'advance', to: 'form', outcome: 'Copied.' })
  expect([said(r), ...(r.context ?? [])].join('\n')).toMatch(/Unity isn't connected in this session/)
})

test('/sentinel lock records the list as it stands then, not as it stood at the draft', async ($: any, on: any) => {
  const { eng, sentinel, drafted } = await session($, on)
  eng.setTools(['Read', UNITY])
  await drafted()
  await sentinel('mcp add Unity')
  expect(await sentinel('lock')).toMatch(/^Locked "P"/)
  expect(eng.memory.run?.library?.mcps).toEqual(['Unity'])
})

test('a plan locked with no needs gets none from a server added mid-run', async ($: any, on: any) => {
  const { sentinel, running } = await session($, on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(said(await $.tool.call(plan))).toMatch(/^Locked "P"/)
  expect(running().library?.mcps).toEqual([])
  await sentinel('mcp add Unity')
  const r = await $.tool.call({ tool: TOOL, action: 'advance', to: 'form', outcome: 'Copied.' })
  expect([said(r), ...(r.context ?? [])].join('\n')).not.toMatch(/isn't connected/)
  expect(blockedOn(running())).toBeUndefined()
})

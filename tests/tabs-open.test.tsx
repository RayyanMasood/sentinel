// Opening the page: /sentinel browser hands the session to the hub, which keeps one page with a tab per session.
//
// How it can fail, and where each is tested below:
//  1. The session's token reaches the model, in the reply or on a command line it can list.
//  2. The hub is asked and a browser tab opens as well, or the hub gets the wrong port, token or name.
//  3. The hub can't start and nothing opens at all.
//  4. The session's helper can't start and the hub is handed nothing.
import { expect, mock } from 'claude-code/testing'
import { engine, openPage, test, TOKEN } from './kit'

const SESSION = `http://127.0.0.1:41234/?k=${TOKEN}`
const hubRuns = (eng: any) => eng.runs.filter((r: any) => /web\/hub\.mjs$/.test(r.argv[1] ?? ''))
const openers = (eng: any) => eng.runs.filter((r: any) => ['cmd', 'open', 'xdg-open'].includes(r.argv[0]))

test('opening hands the session to the hub, and opens no browser tab by itself', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  const said = await openPage($, clock)
  expect(hubRuns(eng).length).toBe(1)
  const [run] = hubRuns(eng)
  expect(run.argv[0]).toBe('node')
  expect(run.argv.at(-1)).toBe('open')
  expect(run.env).toEqual({ SENTINEL_TAB_PORT: '41234', SENTINEL_TAB_TOKEN: TOKEN, SENTINEL_TAB_NAME: 'proj' })
  expect(openers(eng)).toEqual([])
  expect(said).toMatch(/Opened the dashboard/)
})

test('the token stays out of the reply and the command line', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  const said = await openPage($, clock)
  expect(said).not.toContain(TOKEN)
  expect(said).not.toContain('127.0.0.1')
  expect(hubRuns(eng)[0].argv.join(' ')).not.toContain(TOKEN)
})

test('the tab is named after the folder, however the path is written', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.setRoot('D:\\work\\shop\\')
  await openPage($, clock)
  expect(hubRuns(eng)[0].env.SENTINEL_TAB_NAME).toBe('shop')
})

test('opening again from the same session asks the hub again, with the helper it already has', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  await openPage($, clock)
  await openPage($, clock)
  expect(hubRuns(eng).map((r: any) => r.env.SENTINEL_TAB_TOKEN)).toEqual([TOKEN, TOKEN])
  expect(openers(eng)).toEqual([])
})

test('if the hub fails, the session opens its own page as it did before', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.setHub(1)
  const said = await openPage($, clock)
  expect(openers(eng)[0].argv.at(-1)).toBe(SESSION)
  expect(openers(eng).length).toBe(1)
  expect(said).toMatch(/Opened the dashboard/)
  expect(said).not.toContain(TOKEN)
})

test('if the hub cannot even run, the session opens its own page as it did before', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.setHub(undefined)
  const said = await openPage($, clock)
  expect(openers(eng)[0].argv.at(-1)).toBe(SESSION)
  expect(said).toMatch(/Opened the dashboard/)
})

test('with no helper there is nothing for the hub, and the page opens as a file', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.setHelperFails(true)
  const said = await openPage($, clock)
  expect(hubRuns(eng)).toEqual([])
  expect(openers(eng)[0].argv.at(-1)).toMatch(/view\.html$/)
  expect(said).toMatch(/needs Node\.js/)
})

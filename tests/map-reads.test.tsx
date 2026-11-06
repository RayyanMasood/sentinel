// What Claude reads of the map as a state starts: the parts that state builds, their files, and the other end of each line
// that touches them. It comes in Sentinel's replies (starting a state, asking for status) and in a member agent's prompt,
// marked as data and clipped to a word cap. The rules for the text itself are in system.test.mjs. Git is the kit's fake.
import { expect } from 'claude-code/testing'
import { emptyRun, mapHere } from '../hooks/core'
import { REFUND, ROOT, TOOL, engine, said, test } from './kit'

const SYSTEM = `${ROOT}/.sentinel/system.json`
const MAP = JSON.stringify({
  version: 1, name: 'Shop', actors: [{ id: 'buyers', name: 'Buyers' }],
  parts: [
    { id: 'refunds', name: 'Refunds', desc: 'Partial refunds', files: ['src/refund*.ts'] },
    { id: 'guide', name: 'Guide', files: ['guide/**'] },
    { id: 'queue', name: 'Queue', kind: 'outside', evidence: { said: 'we use one' } },
  ],
  lines: [
    { from: 'buyers', to: 'refunds', says: 'ask for money back' },
    { from: 'refunds', to: 'queue', says: 'sends refund jobs' },
    { from: 'buyers', to: 'guide', says: 'read the rules' },
  ],
})
const STATES = [
  { id: 'explore', label: 'Read payments code' },
  { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'], parts: ['refunds'] },
  { id: 'docs', label: 'Guide', check: 'npm test -- guide', files: ['guide/**'], parts: ['guide'] },
  { id: 'verify', label: 'Full suite', check: 'npm test' },
]
const LOOPS = [['verify', 'service']]
const plan = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })
const HEADER = /Parts this state builds/

// Signs off and locks the plan, then reads what the lock said (the first state, explore, builds no part).
async function lock($: any, states: object[] = STATES, loops: string[][] = LOOPS) {
  await $.tool.call({ tool: 'ExitPlanMode' })
  return said(await plan($, { action: 'define', title: 'Refunds', states, loops }))
}
async function toService($: any, eng: ReturnType<typeof engine>) {
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  eng.setBash({ fail: true, text: 'Tests: 1 failed' })
  return said(await plan($, { action: 'advance', to: 'service', evidence: 'found it' }))
}

test('starting a state hands Claude its parts, their files and the other end of each line, marked as data', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  const out = await lock($).then(() => toService($, eng))
  expect(out).toMatch(/Moved to service/)
  expect(out).toMatch(HEADER)
  expect(out).toMatch(/not instructions/)
  expect(out).toMatch(/- refunds · Refunds — Partial refunds \(files src\/refund\*\.ts\)/)
  expect(out).toMatch(/buyers \(Buyers\) → refunds \(Refunds\): ask for money back/)
  expect(out).toMatch(/refunds \(Refunds\) → queue \(Queue, outside the project\): sends refund jobs/)
  expect(out).not.toMatch(/read the rules/)
})

test('a state that builds no part reads nothing of the map', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  const locked = await lock($)
  expect(locked).toMatch(/Active: explore/)
  expect(locked).not.toMatch(HEADER)
  await toService($, eng)
  eng.setBash({ fail: false, text: 'ok' })
  expect(said(await plan($, { action: 'advance', to: 'verify' }))).not.toMatch(HEADER)
})

test('asking for status shows the active state\'s parts again, and the next state shows its own', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await lock($)
  await toService($, eng)
  const status = said(await plan($, { action: 'status' }))
  expect(status).toMatch(/Active: service/)
  expect(status).toMatch(/- refunds · Refunds/)
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'original', new_string: 'built' })
  eng.setBash({ fail: false, text: '14 passed' })
  const docs = said(await plan($, { action: 'advance', to: 'docs' }))
  expect(docs).toMatch(/Moved to docs/)
  expect(docs).toMatch(/- guide · Guide \(files guide\/\*\*\)/)
  expect(docs).toMatch(/read the rules/)
  expect(docs).not.toMatch(/ask for money back/)
})

test('a map too big for the cap is clipped in the reply, and the reply says so', async ($: any, on: any) => {
  const eng = engine(on)
  const parts = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `Part number ${i}`, desc: 'a part with a description of some length', files: [`src/p${i}/**`] }))
  const lines = Array.from({ length: 120 }, (_, i) => ({ from: `p${i % 60}`, to: `p${(i + 1) % 60}`, says: `sends message number ${i}` }))
  eng.files[SYSTEM] = JSON.stringify({ version: 1, name: 'Big', actors: [], parts, lines })
  const states = [{ id: 'all', label: 'Everything', check: 'npm test', files: ['src/**'], parts: parts.map(p => p.id) }, { id: 'verify', label: 'Full suite', check: 'npm test' }]
  const out = await lock($, states, [])
  expect(out).toMatch(HEADER)
  expect(out).toMatch(/\(\d+ more parts not shown/)
  expect(out).toMatch(/\(\d+ more lines not shown/)
  expect(out.split(/\s+/).length).toBeLessThan(900)
})

test('a run with no drawing reads nothing, whatever parts its state names', () => {
  const st = { id: 'x', label: 'X', files: [], parts: ['refunds'] }
  expect(mapHere(emptyRun(), st)).toBe('')
  expect(mapHere({ ...emptyRun(), drawing: { map: { name: 'Shop', actors: [], lines: [], parts: [{ id: 'refunds', name: 'Refunds' }] }, warnings: [], exists: [] } }, st)).toMatch(/- refunds · Refunds/)
})

test('a member agent\'s prompt carries the parts of its own state and nothing from the others', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[`${ROOT}/.sentinel/parallel`] = 'on'
  eng.files[`${ROOT}/ui/box.tsx`] = 'before'
  eng.files[SYSTEM] = JSON.stringify({
    version: 1, name: 'Shop', actors: [{ id: 'buyers', name: 'Buyers' }],
    parts: [{ id: 'search', name: 'Search box', desc: 'Finds a class', files: ['ui/**'] }, { id: 'api', name: 'Search endpoint', files: ['api/**'] }],
    lines: [{ from: 'buyers', to: 'search', says: 'type a word' }, { from: 'search', to: 'api', says: 'asks for matches' }],
  })
  const states = [
    { id: 'explore', label: 'Read the code' },
    { id: 'api', label: 'Search endpoint', check: 'npm test -- api', files: ['api/*.ts'], needs: ['explore'], parts: ['api'] },
    { id: 'ui', label: 'Search box', check: 'npm test -- ui', files: ['ui/**'], needs: ['explore'], parts: ['search'] },
    { id: 'verify', label: 'Full suite', check: 'npm test', needs: ['api', 'ui'] },
  ]
  await $.tool.call({ tool: 'ExitPlanMode' })
  await plan($, { action: 'define', title: 'Search page', states, loops: [['verify', 'api']] })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  await plan($, { action: 'advance', to: 'api', evidence: 'read it' })
  await plan($, { action: 'brief', to: 'ui', brief: 'Add the search box.' })
  const prompt: string = eng.spawns[0]!.prompt
  expect(prompt).toMatch(HEADER)
  expect(prompt).toMatch(/- search · Search box — Finds a class \(files ui\/\*\*\)/)
  expect(prompt).toMatch(/buyers \(Buyers\) → search \(Search box\): type a word/)
  expect(prompt).toMatch(/search \(Search box\) → api \(Search endpoint\): asks for matches/)
  expect(prompt).toMatch(/not instructions/)
  expect(prompt).not.toMatch(/- api · Search endpoint \(files/)
})

test('a member agent for a state that builds no part gets no map text', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[`${ROOT}/.sentinel/parallel`] = 'on'
  eng.files[SYSTEM] = JSON.stringify({ version: 1, name: 'Shop', actors: [], lines: [], parts: [{ id: 'search', name: 'Search box', files: ['ui/**'] }] })
  const states = [
    { id: 'explore', label: 'Read the code' },
    { id: 'ui', label: 'Search box', check: 'npm test -- ui', files: ['ui/**'], needs: ['explore'], parts: ['search'] },
    { id: 'api', label: 'Search endpoint', check: 'npm test -- api', files: ['api/*.ts'], needs: ['explore'] },
    { id: 'verify', label: 'Full suite', check: 'npm test', needs: ['api', 'ui'] },
  ]
  await $.tool.call({ tool: 'ExitPlanMode' })
  await plan($, { action: 'define', title: 'Search page', states, loops: [['verify', 'api']] })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  expect(said(await plan($, { action: 'advance', to: 'ui', evidence: 'read it' }))).toMatch(/Moved to ui/)
  const started = said(await plan($, { action: 'brief', to: 'api', brief: 'Add the endpoint.' }))
  expect(started).toMatch(/Started a member agent for api/)
  expect(eng.spawns[0]!.prompt).toMatch(/Search endpoint/)
  expect(eng.spawns[0]!.prompt).not.toMatch(HEADER)
})

// The drawing a plan carries. Claude draws parts, Sentinel merges them into the project's map, checks them against the
// states and saves the file when the plan locks. core.ts holds the rules (the first half of this file runs them
// directly); register.tsx reads and writes the files (the second half goes through the engine). Git is the kit's fake.
import { expect, mock } from 'claude-code/testing'
import { BUILTINS } from '../hooks/builtins'
import { act, emptyRun, lockDraft, revised, summarize, type PlanInput } from '../hooks/core'
import { DESCRIPTION, SCHEMA } from '../hooks/register'
import { formatSystem, parseSystem } from '../hooks/system'
import type { Run, SystemMap } from '../types'
import { ROOT, TOOL, engine, said, test, until } from './kit'

const SYSTEM = `${ROOT}/.sentinel/system.json`
const SHOP = {
  name: 'Shop', actors: [{ id: 'buyers', name: 'Buyers' }], lines: [],
  parts: [
    { id: 'shop', name: 'Shop' },
    { id: 'refunds', parent: 'shop', name: 'Refunds', files: ['src/refund*.ts'] },
    { id: 'guide', parent: 'shop', name: 'Guide', files: ['guide/**'] },
  ],
}
const MAP = JSON.stringify({ version: 1, ...SHOP })
const CLEAN = [
  { id: 'explore', label: 'Read the payments code' },
  { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'], parts: ['refunds'] },
  { id: 'docs', label: 'Guide', check: 'npm test -- guide', files: ['guide/**'], parts: ['guide'] },
  { id: 'verify', label: 'Full suite', check: 'npm test' },
]
const LOOPS = [['verify', 'service']]
const TAX = { id: 'tax', parent: 'shop', name: 'Tax', files: ['src/tax/**'] }
const MAIL = { id: 'mail', parent: 'shop', name: 'Mail', desc: 'Receipts', files: ['src/mail/**'] }
const MAIL_STATE = { id: 'mail', label: 'Receipts by mail', check: 'npm test -- mail', files: ['src/mail/**'], parts: ['mail'] }
const WITH_MAIL = [CLEAN[0]!, CLEAN[1]!, CLEAN[2]!, MAIL_STATE, CLEAN[3]!]

// ---- the rules, on the run ----

const mapOf = (extra: object = {}): SystemMap => {
  const r = parseSystem(JSON.stringify({ version: 1, ...SHOP, ...extra }))
  if (!r.ok) throw new Error(r.error)
  return r.map
}
const signed = (): Run => ({ ...emptyRun(), signedOff: true })
const define = (r: Run, more: object = {}, states: object[] = CLEAN, map: SystemMap | null = mapOf(), exists: string[] = []) =>
  act(r, { action: 'define', title: 'Refunds', loops: [], states, ...(map ? { drawn: { map, exists } } : {}), ...more } as PlanInput, '09:00')
const mapAct = (r: Run, i: object) => act(r, { action: 'map', ...i } as PlanInput, '09:10')
const moreParts = (...p: object[]) => mapOf({ parts: [...SHOP.parts, ...p] })

test('a define with a drawing keeps it in the run, with the map as it stood at the lock', () => {
  const a = define(signed())
  expect(a.ok).toBe(true)
  expect(a.event).toBe('locked')
  expect(a.run.drawing).toEqual({ map: mapOf(), locked: mapOf(), warnings: [], exists: [] })
  expect(a.text).not.toMatch(/notes? for the user/)
})

test('a draft holds the drawing, and the lock makes the locked copy', () => {
  const a = define({ ...signed(), review: true })
  expect(a.event).toBe('drafted')
  expect(a.run.drawing).toBeUndefined()
  expect(a.run.draft!.drawing).toEqual({ map: mapOf(), warnings: [], exists: [] })
  expect(lockDraft(a.run, '09:05').drawing).toEqual({ map: mapOf(), locked: mapOf(), warnings: [], exists: [] })
})

test('what the checks find goes in the reply and a few lines of the log', () => {
  const many = Array.from({ length: 6 }, (_, k) => ({ id: `x${k + 1}`, parent: 'shop', name: `X${k + 1}`, files: [`x${k + 1}/**`] }))
  const a = define(signed(), {}, CLEAN, moreParts(...many))
  expect(a.ok).toBe(true)
  expect(a.run.drawing!.warnings).toHaveLength(6)
  expect(a.text).toMatch(/The map has 6 notes for the user\. None of them stops the lock:/)
  for (const k of [1, 6]) expect(a.text).toContain(`Part x${k} (X${k}): no state builds it`)
  const lines = a.run.log.map(l => l.text).filter(t => t.startsWith('Map · '))
  expect(lines).toEqual([1, 2, 3].map(k => `Map · Part x${k} (X${k}): no state builds it and it has no files yet.`).concat('Map · 3 more'))
  expect(a.run.log.filter(l => l.text.startsWith('Map · ')).every(l => l.tone === 'warn')).toBe(true)
  expect(define(signed(), {}, CLEAN, moreParts(many[0]!)).text).toMatch(/The map has a note for the user/)
})

test('a state that names a part that is not on the map refuses the define and leaves the run', () => {
  const r = signed()
  const a = define(r, {}, [{ ...CLEAN[1]!, parts: ['refundz'] }])
  expect(a.ok).toBe(false)
  expect(a.text).toMatch(/State service names "refundz", which is not on the map/)
  expect(a.run).toBe(r)
})

test('a plan with parts and no map is refused, and one with neither has no drawing', () => {
  const none = define(signed(), {}, CLEAN, null)
  expect(none.ok).toBe(false)
  expect(none.text).toMatch(/names parts, but the plan has no map/)
  const plain = define(signed(), {}, [CLEAN[0]!, CLEAN[3]!], null)
  expect(plain.ok).toBe(true)
  expect(plain.run.drawing).toBeUndefined()
  expect(plain.text).not.toMatch(/map/i)
  expect(summarize(plain.run).system).toBeUndefined()
})

test('a revise keeps the draft\'s drawing, and takes a new one when it is sent', () => {
  const d = define({ ...signed(), review: true })
  const order = CLEAN.map(s => s.id)
  const kept = revised(d.run, { action: 'revise', order } as PlanInput) as PlanInput
  expect(kept.drawn).toEqual({ map: mapOf(), exists: [] })
  const next = mapOf({ lines: [{ from: 'buyers', to: 'refunds', says: 'ask for money back' }] })
  const sent = revised(d.run, { action: 'revise', order, drawn: { map: next, exists: [] } } as PlanInput) as PlanInput
  expect(sent.drawn!.map.lines).toHaveLength(1)
  const again = act(d.run, { action: 'revise', order, drawn: { map: next, exists: [] } } as PlanInput, '09:02')
  expect(again.ok).toBe(true)
  expect(again.run.draft!.drawing!.map.lines).toHaveLength(1)
})

test('the view model says how big the map is, what was found and which outside parts are guesses', () => {
  const queue = { id: 'queue', name: 'Queue', kind: 'outside', evidence: { guess: 'probably a queue' } }
  const a = define(signed(), {}, CLEAN, moreParts(queue))
  expect(summarize(a.run).system).toMatchObject({ name: 'Shop', parts: 4, lines: 0, warnings: [], guessed: ['queue'] })
  const noted = define(signed(), {}, [CLEAN[1]!], moreParts())
  expect(summarize(noted.run).system!.warnings).toEqual(['Part guide (Guide): no state builds it and it has no files yet.'])
})

test('the map action draws more, and says what the checks find of it', () => {
  const locked = define(signed()).run
  const a = mapAct(locked, { drawn: { map: moreParts(TAX), exists: [] } })
  expect(a.ok).toBe(true)
  expect(a.text).toMatch(/Map updated: drew tax\./)
  expect(a.text).toMatch(/Part tax \(Tax\): no state builds it/)
  expect(a.run.drawing!.map).toEqual(moreParts(TAX))
  expect(a.run.drawing!.locked).toEqual(mapOf())
  expect(a.run.drawing!.warnings).toHaveLength(1)
  expect(a.run.audit.at(-1)).toMatchObject({ kind: 'amended', text: 'Map: drew tax' })
  expect(a.run.log.at(-1)!.text).toBe('Map · drew tax')
  // The same drawing again changes nothing.
  const same = mapAct(a.run, { drawn: { map: moreParts(TAX), exists: [] } })
  expect(same.ok).toBe(true)
  expect(same.text).toMatch(/already holds/)
  expect(same.run).toBe(a.run)
  // Lines and people count as changes too.
  const line = mapAct(a.run, { drawn: { map: mapOf({ parts: [...SHOP.parts, TAX], lines: [{ from: 'buyers', to: 'tax', says: 'see the tax' }] }), exists: [] } })
  expect(line.text).toMatch(/Map updated: changed lines or people\./)
})

test('a part Claude drew comes off with a reason; one the user locked stays', () => {
  const added = mapAct(define(signed()).run, { drawn: { map: moreParts(TAX), exists: [] } }).run
  const drop = (more: object, r = added) => mapAct(r, { drawn: { map: moreParts(TAX), exists: [] }, ...more })
  const noWhy = drop({ drop: ['tax'] })
  expect(noWhy.ok).toBe(false)
  expect(noWhy.text).toMatch(/needs "reason"/)
  const signedOff = drop({ drop: ['guide'], reason: 'unused' })
  expect(signedOff.ok).toBe(false)
  expect(signedOff.text).toMatch(/guide is on the map the user locked, so only they can take it off/)
  expect(signedOff.run).toBe(added)
  const unknown = drop({ drop: ['nope'], reason: 'x' })
  expect(unknown.text).toMatch(/No part "nope"/)
  const ok = drop({ drop: ['tax'], reason: 'too small to split' })
  expect(ok.ok).toBe(true)
  expect(ok.text).toMatch(/Map updated: took off tax \(too small to split\)\./)
  expect(ok.run.drawing!.map).toEqual(mapOf())
  expect(ok.run.drawing!.warnings).toEqual([])
  expect(ok.run.audit.at(-1)!.text).toBe('Map: took off tax (too small to split)')
})

test('the map action needs a plan that runs, something to draw, and a map that still fits the states', () => {
  const locked = define(signed()).run
  expect(mapAct(signed(), { drawn: { map: mapOf(), exists: [] } }).text).toMatch(/No plan is locked/)
  const nothing = mapAct(locked, {})
  expect(nothing.ok).toBe(false)
  expect(nothing.text).toMatch(/no map to change/)
  // refunds would become a group while a state builds it.
  const kid = mapAct(locked, { drawn: { map: moreParts({ id: 'kid', parent: 'refunds', name: 'Kid' }), exists: [] } })
  expect(kid.ok).toBe(false)
  expect(kid.text).toMatch(/State service names "refunds", which has parts inside it/)
  expect(kid.run).toBe(locked)
})

test('a plan that locked with no map can draw one while it runs, and take parts off again', () => {
  const plain = define(signed(), {}, [CLEAN[0]!, CLEAN[3]!], null).run
  const a = mapAct(plain, { drawn: { map: moreParts(TAX), exists: [] } })
  expect(a.ok).toBe(true)
  expect(a.run.drawing!.locked).toBeUndefined()
  const gone = mapAct(a.run, { drawn: { map: moreParts(TAX), exists: [] }, drop: ['tax'], reason: 'not needed' })
  expect(gone.ok).toBe(true)
})

// A plan that runs gains states only while the comparison with the approved plan is on.
const ASKED = 'Read the payments code before changing it. Add partial refunds that attach after the capture settles. Write a guide page for the refund rules. Run the full suite before it ships. Add tax lines to the receipts.'
const Q = { explore: 'Read the payments code before changing it.', service: 'Add partial refunds that attach after the capture settles.', docs: 'Write a guide page for the refund rules.', verify: 'Run the full suite before it ships', tax: 'Add tax lines to the receipts.' } as Record<string, string>
const LIB = { weight: 'standard' as const, on: ['quote-the-source'], told: [] }
const QUOTED = CLEAN.map(s => ({ ...s, asked: [Q[s.id]!] }))
const runningWith = (states: object[], map?: SystemMap) =>
  act({ ...signed(), sources: [{ kind: 'approved', text: ASKED, at: '09:00' }] }, { action: 'define', library: LIB, title: 'Refunds', loops: [], states, ...(map ? { drawn: { map, exists: [] } } : {}) } as PlanInput, '09:01').run
const add = (r: Run, state: object) => act(r, { action: 'revise', order: [...CLEAN.map(s => s.id), (state as { id: string }).id], states: [state] } as PlanInput, '09:30')
const TAX_STATE = { id: 'tax', label: 'Tax lines', asked: [Q.tax], files: ['src/tax/**'], check: 'npm test -- tax' }

test('a state added while the plan runs may name only parts that are on its map', () => {
  const r = runningWith(QUOTED, mapOf())
  expect(r.drawing).toBeTruthy()
  const bad = add(r, { ...TAX_STATE, parts: ['taxx'] })
  expect(bad.ok).toBe(false)
  expect(bad.text).toMatch(/State tax names "taxx", which is not on the map/)
  expect(bad.run).toBe(r)
  const group = add(r, { ...TAX_STATE, parts: ['shop'] })
  expect(group.text).toMatch(/"shop", which has parts inside it/)
  const bare = runningWith(CLEAN.map(({ parts: _parts, ...s }) => ({ ...s, asked: [Q[s.id]!] })))
  expect(bare.drawing).toBeUndefined()
  expect(add(bare, { ...TAX_STATE, parts: ['tax'] }).text).toMatch(/has no map/)
  expect(add(bare, TAX_STATE).ok).toBe(true)
})

test('a part a state builds cannot come off the map, even one Claude drew', () => {
  const r = runningWith(QUOTED, mapOf())
  const drawn = mapAct(r, { drawn: { map: moreParts(TAX), exists: [] } }).run
  const added = add(drawn, { ...TAX_STATE, parts: ['tax'] })
  expect(added.ok).toBe(true)
  expect(added.run.plan!.states.at(-1)!.parts).toEqual(['tax'])
  const drop = mapAct(added.run, { drawn: { map: moreParts(TAX), exists: [] }, drop: ['tax'], reason: 'changed my mind' })
  expect(drop.ok).toBe(false)
  expect(drop.text).toMatch(/tax builds a part you are taking off\. A part a state builds stays on the map\./)
})

test('the Library carries the drawing rules, on at standard and thorough', () => {
  const b = BUILTINS.find(x => x.name === 'draw-system')!
  expect(b).toMatchObject({ at: 'draft', kind: 'told', weights: ['standard', 'thorough'] })
  for (const word of [/"system"/, /outside/, /seen/, /said/, /guess/, /"parts"/, /sets every status itself/]) expect(b.text).toMatch(word)
  expect(b.text.split(/\s+/).length).toBeLessThan(160)
  expect(DESCRIPTION.length).toBeLessThanOrEqual(4096)
})

// ---- through the engine ----

const plan = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })
const lock = async ($: any, input: object = {}) => {
  await $.tool.call({ tool: 'ExitPlanMode' })
  return said(await plan($, { action: 'define', title: 'Refunds', states: CLEAN, loops: LOOPS, ...input }))
}
const sentinel = (clock: any, $: any) => async (args: string) => {
  const out = said(await $.command.run({ command: 'sentinel', args }))
  await clock.advance(1)
  return out
}
const savedMap = (eng: ReturnType<typeof engine>): SystemMap => {
  const r = parseSystem(eng.files[SYSTEM] ?? '')
  if (!r.ok) throw new Error(r.error)
  return r.map
}
const ids = (m: SystemMap) => m.parts.map(p => p.id).sort()

test('a drawing locks with the plan, joins the project map and is saved with the commit it was drawn at', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  const out = await lock($, { states: WITH_MAIL, system: { parts: [MAIL], lines: [{ from: 'buyers', to: 'mail', says: 'get a receipt' }] } })
  expect(out).toMatch(/Locked "Refunds"/)
  expect(out).not.toMatch(/notes? for the user/)
  const map = savedMap(eng)
  expect(ids(map)).toEqual(['guide', 'mail', 'refunds', 'shop'])
  expect(map.parts.find(p => p.id === 'mail')).toMatchObject({ parent: 'shop', desc: 'Receipts', files: ['src/mail/**'], drawnAt: 'abc1234' })
  expect(map.parts.find(p => p.id === 'refunds')!.drawnAt).toBeUndefined()
  expect(map.lines).toEqual([{ from: 'buyers', to: 'mail', says: 'get a receipt' }])
  expect(map.actors).toEqual([{ id: 'buyers', name: 'Buyers' }])
  expect(eng.files[SYSTEM]).toMatch(/^\{\n"version": 1,\n"name": "Shop",/)
  // The run holds the map the file holds, which is saved sorted.
  const drawing = eng.memory.run!.drawing!
  expect(drawing).toMatchObject({ warnings: [], exists: ['refunds'] })
  expect(drawing.locked).toEqual(drawing.map)
  expect(parseSystem(formatSystem(drawing.map))).toEqual({ ok: true, map })
})

test('with no map yet the drawing makes one, named if it says a name', async ($: any, on: any) => {
  const eng = engine(on)
  const parts = [{ id: 'refunds', name: 'Refunds', files: ['src/refund*.ts'] }, { id: 'guide', name: 'Guide', files: ['guide/**'] }]
  expect(await lock($, { system: { parts } })).toMatch(/Locked/)
  expect(savedMap(eng).name).toBe('System map')
  expect(ids(savedMap(eng))).toEqual(['guide', 'refunds'])
})

test('a drawing may name the map when the project has none', async ($: any, on: any) => {
  const eng = engine(on)
  await lock($, { system: { name: 'Studio', parts: [{ id: 'refunds', name: 'Refunds', files: ['src/refund*.ts'] }, { id: 'guide', name: 'Guide', files: ['guide/**'] }] } })
  expect(savedMap(eng).name).toBe('Studio')
})

test('a plan that draws nothing and names no part leaves the map alone, and a map the model sends itself counts for nothing', async ($: any, on: any) => {
  const eng = engine(on)
  const plain = [CLEAN[0]!, CLEAN[3]!]
  expect(await lock($, { states: plain, loops: [], drawn: { map: mapOf(), exists: [] } })).toMatch(/Locked/)
  expect(eng.memory.run!.drawing).toBeUndefined()
  expect(eng.files[SYSTEM]).toBeUndefined()
  expect(eng.runs.some(r => r.argv.includes('rev-parse'))).toBe(false)
  expect(said(await plan($, { action: 'status' }))).not.toMatch(/System map/)
})

test('a state that names parts is refused when the only map is one the model sent itself', async ($: any, on: any) => {
  const eng = engine(on)
  const out = await lock($, { drawn: { map: mapOf(), exists: [] } })
  expect(out).toMatch(/names parts, but the plan has no map/)
  expect(eng.memory.run!.plan).toBeNull()
})

test('a project with a map checks every plan against it, and the notes reach the reply, the log and the page', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  const states = [CLEAN[0]!, { id: 'edit', label: 'Edit misc', check: 'npm test -- misc', files: ['src/misc/**'] }, CLEAN[3]!]
  const out = await lock($, { states, loops: [['verify', 'edit']] })
  expect(out).toMatch(/Locked "Refunds"/)
  expect(out).toMatch(/The map has 2 notes for the user\. None of them stops the lock:\n- State edit has files but names no part of the map, so the map cannot show what it builds\.\n- Part guide \(Guide\): no state builds it and it has no files yet\./)
  expect(out).not.toMatch(/State explore/)
  // refunds has files in the project, so nothing is said of it.
  expect(out).not.toMatch(/Part refunds/)
  const run = eng.memory.run!
  expect(run.drawing!.exists).toEqual(['refunds'])
  expect(run.log.map(l => l.text)).toContain('Map · Part guide (Guide): no state builds it and it has no files yet.')
  await until(clock, () => eng.snap().system)
  expect(eng.snap().system).toMatchObject({ name: 'Shop', parts: 3, lines: 0, guessed: [] })
  expect(eng.snap().system.warnings).toHaveLength(2)
})

test('a drawing that breaks the rules of the file is refused, and nothing locks or is saved', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await $.tool.call({ tool: 'ExitPlanMode' })
  const refused = async (system: unknown, re: RegExp) => {
    const out = said(await plan($, { action: 'define', title: 'Refunds', states: CLEAN, loops: LOOPS, system }))
    expect(out).toMatch(/The drawing was refused: /)
    expect(out).toMatch(re)
  }
  await refused({ lines: [{ from: 'refunds', to: 'nowhere', says: 'x' }] }, /"nowhere", which is not on the map/)
  await refused({ parts: [{ id: 'Bad Id', name: 'X' }] }, /not an id/)
  await refused({ parts: 'one' }, /must each be a list/)
  await refused('not json', /could not be read as JSON/)
  await refused([1], /must be an object/)
  expect(eng.memory.run!.plan).toBeNull()
  expect(eng.files[SYSTEM]).toBe(MAP)
})

test('a state that names a group, an outside part or a part that is not there is refused', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await $.tool.call({ tool: 'ExitPlanMode' })
  const named = async (parts: string[], system?: object) => said(await plan($, { action: 'define', title: 'Refunds', states: [{ ...CLEAN[1]!, parts }, CLEAN[3]!], loops: [], system }))
  expect(await named(['refundz'])).toMatch(/State service names "refundz", which is not on the map/)
  expect(await named(['shop'])).toMatch(/"shop", which has parts inside it/)
  const queue = { parts: [{ id: 'queue', name: 'Queue', kind: 'outside', evidence: { said: 'we use one' } }] }
  expect(await named(['queue'], queue)).toMatch(/"queue", which is outside the project/)
  expect(eng.memory.run!.plan).toBeNull()
  expect(await named(['refunds'])).toMatch(/Locked/)
})

test('a citation that does not hold makes the outside part a guess, and one that holds stays seen', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  eng.files[`${ROOT}/docker-compose.yml`] = 'services:\n  cache:\n    image: redis:7'
  eng.files['D:/secret.txt'] = 'x'
  const outside = (id: string, file: string, text: string) => ({ id, name: id, kind: 'outside', evidence: { seen: [{ file, text }] } })
  const parts = [
    outside('queue-ok', 'docker-compose.yml', 'image:  Redis'),
    outside('cache-bad', 'docker-compose.yml', 'image: memcached'),
    outside('gone', 'missing.yml', 'x'),
    outside('escape', '../secret.txt', 'x'),
    outside('abs', '/etc/hosts', 'x'),
  ]
  const out = await lock($, { states: [CLEAN[0]!, CLEAN[3]!], loops: [], system: { parts } })
  expect(out).toMatch(/Locked/)
  expect(out).toMatch(/Sentinel could not find cache-bad, gone, escape, abs where you cited it, so those outside parts are marked as a guess\. The user can confirm or remove them\./)
  const map = savedMap(eng)
  const evidence = (id: string) => map.parts.find(p => p.id === id)!.evidence
  expect(evidence('queue-ok')).toEqual({ seen: [{ file: 'docker-compose.yml', text: 'image:  Redis' }] })
  expect(evidence('cache-bad')).toEqual({ guess: 'docker-compose.yml does not contain "image: memcached".' })
  expect(evidence('gone')).toEqual({ guess: 'Cited missing.yml, which was not found.' })
  expect(evidence('escape')).toEqual({ guess: 'Cited ../secret.txt, which was not found.' })
  expect(evidence('abs')).toEqual({ guess: 'Cited /etc/hosts, which was not found.' })
  expect(eng.reads.some(p => /secret|etc\/hosts/.test(p))).toBe(false)
  await until(clock, () => eng.snap().system)
  expect(eng.snap().system.guessed).toEqual(['cache-bad', 'gone', 'escape', 'abs'])
})

test('a part already on the map is not checked again when a plan draws something else', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = JSON.stringify({ version: 1, name: 'Shop', actors: [], lines: [], parts: [
    ...SHOP.parts,
    { id: 'queue', name: 'Queue', kind: 'outside', evidence: { seen: [{ file: 'docker-compose.yml', text: 'image: redis' }] } },
  ] })
  await lock($, { states: WITH_MAIL, system: { parts: [MAIL] } })
  expect(savedMap(eng).parts.find(p => p.id === 'queue')!.evidence).toEqual({ seen: [{ file: 'docker-compose.yml', text: 'image: redis' }] })
  expect(eng.reads.some(p => p.endsWith('docker-compose.yml'))).toBe(false)
})

test('a draft leaves the file alone until the user locks it, and a revise builds on the draft\'s map', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  const run = sentinel(clock, $)
  eng.files[SYSTEM] = MAP
  await run('lock')
  const order = WITH_MAIL.map(s => s.id)
  expect(said(await plan($, { action: 'define', title: 'Refunds', states: WITH_MAIL, loops: LOOPS, system: { parts: [MAIL] } }))).toMatch(/Draft saved/)
  expect(eng.files[SYSTEM]).toBe(MAP)
  expect(eng.memory.run!.drawing).toBeUndefined()
  expect(ids(eng.memory.run!.draft!.drawing!.map)).toEqual(['guide', 'mail', 'refunds', 'shop'])
  const line = { from: 'buyers', to: 'refunds', says: 'ask for money back' }
  expect(said(await plan($, { action: 'revise', order, system: { lines: [line] } }))).toMatch(/Draft saved/)
  expect(eng.memory.run!.draft!.drawing!.map.lines).toEqual([line])
  expect(ids(eng.memory.run!.draft!.drawing!.map)).toContain('mail')
  // A state the revise sends is held to the same map.
  const bad = said(await plan($, { action: 'revise', order, states: [{ ...CLEAN[1]!, parts: ['refundz'] }] }))
  expect(bad).toMatch(/"refundz", which is not on the map/)
  expect(eng.memory.run!.draft!.plan!.states.find(s => s.id === 'service')!.parts).toEqual(['refunds'])
  expect(eng.files[SYSTEM]).toBe(MAP)
  expect(await run('lock')).toMatch(/Locked "Refunds"/)
  const map = savedMap(eng)
  expect(ids(map)).toContain('mail')
  expect(map.lines).toEqual([line])
  const drawing = eng.memory.run!.drawing!
  expect(drawing).toMatchObject({ warnings: [], exists: ['refunds'] })
  expect(drawing.locked).toEqual(drawing.map)
  expect(parseSystem(formatSystem(drawing.map))).toEqual({ ok: true, map })
})

test('a define sent before the sign-off carries its drawing into the draft', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const eng = engine(on)
  const run = sentinel(clock, $)
  eng.files[SYSTEM] = MAP
  expect(said(await plan($, { action: 'define', title: 'Refunds', states: WITH_MAIL, loops: LOOPS, system: { parts: [MAIL] } }))).toMatch(/No sign-off yet/)
  expect(eng.files[SYSTEM]).toBe(MAP)
  expect(await run('lock')).toMatch(/is the draft now/)
  expect(ids(eng.memory.run!.draft!.drawing!.map)).toContain('mail')
  expect(await run('lock')).toMatch(/Locked "Refunds"/)
  expect(ids(savedMap(eng))).toContain('mail')
})

test('the map action changes the file while the plan runs, and holds to its rules', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  await lock($)
  const added = said(await plan($, { action: 'map', system: { parts: [TAX] } }))
  expect(added).toMatch(/Map updated: drew tax\./)
  expect(added).toMatch(/Part tax \(Tax\): no state builds it/)
  expect(savedMap(eng).parts.find(p => p.id === 'tax')).toMatchObject({ files: ['src/tax/**'], drawnAt: 'abc1234' })
  expect(eng.memory.run!.audit.at(-1)!.text).toBe('Map: drew tax')
  expect(said(await plan($, { action: 'map', drop: ['tax'] }))).toMatch(/needs "reason"/)
  expect(said(await plan($, { action: 'map', drop: ['guide'], reason: 'unused' }))).toMatch(/guide is on the map the user locked/)
  expect(ids(savedMap(eng))).toContain('guide')
  expect(said(await plan($, { action: 'map', drop: ['tax'], reason: 'too small to split' }))).toMatch(/took off tax \(too small to split\)/)
  expect(ids(savedMap(eng))).not.toContain('tax')
  expect(eng.memory.run!.drawing!.locked).toEqual(mapOf())
  expect(said(await plan($, { action: 'map', system: { lines: [{ from: 'buyers', to: 'nowhere', says: 'x' }] } }))).toMatch(/The drawing was refused/)
})

test('how many parts get a look for their files is bounded; the rest count as there', async ($: any, on: any) => {
  const eng = engine(on)
  const many = Array.from({ length: 45 }, (_, k) => ({ id: `p${k + 1}`, name: `P${k + 1}`, files: [`d${k + 1}/**`] }))
  expect(await lock($, { states: [CLEAN[0]!, CLEAN[3]!], loops: [], system: { parts: many } })).toMatch(/Locked/)
  const drawing = eng.memory.run!.drawing!
  expect(drawing.warnings).toHaveLength(40)
  expect(drawing.exists).toEqual(many.slice(40).map(p => p.id))
  expect(eng.runs.filter(r => r.argv.includes('-d')).length).toBe(40)
})

test('a revise that sends a drawing when there is no draft and no plan that runs is refused as any revise is', async ($: any, on: any) => {
  const eng = engine(on)
  await $.tool.call({ tool: 'ExitPlanMode' })
  const out = said(await plan($, { action: 'revise', order: ['explore'], system: { parts: [TAX] } }))
  expect(out).toMatch(/no draft to revise/)
  expect(eng.files[SYSTEM]).toBeUndefined()
})

test('map is refused when no plan is locked', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  expect(said(await plan($, { action: 'map', system: { parts: [TAX] } }))).toMatch(/No plan is locked/)
  expect(eng.files[SYSTEM]).toBe(MAP)
})

test('while a plan runs, revise adds states but cannot redraw the map', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  eng.quoting()
  eng.setApproved({ plan: ASKED, isAgent: false, filePath: `${ROOT}/plan.md` })
  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(said(await plan($, { action: 'define', title: 'Refunds', states: QUOTED, loops: LOOPS }))).toMatch(/Locked "Refunds"/)
  const order = [...CLEAN.map(s => s.id), 'tax']
  const redraw = said(await plan($, { action: 'revise', order, states: [TAX_STATE], system: { parts: [TAX] } }))
  expect(redraw).toMatch(/While a plan runs, change the map with the map action\. revise only adds states\./)
  expect(ids(savedMap(eng))).not.toContain('tax')
  // The state may name only what is on the map, so the map is drawn first.
  expect(said(await plan($, { action: 'revise', order, states: [{ ...TAX_STATE, parts: ['tax'] }] }))).toMatch(/"tax", which is not on the map/)
  expect(said(await plan($, { action: 'map', system: { parts: [TAX] } }))).toMatch(/Map updated: drew tax/)
  expect(said(await plan($, { action: 'revise', order, states: [{ ...TAX_STATE, parts: ['tax'] }] }))).toMatch(/Added tax to the plan/)
  expect(eng.memory.run!.plan!.states.at(-1)!.parts).toEqual(['tax'])
  // A part a state builds stays.
  expect(said(await plan($, { action: 'map', drop: ['tax'], reason: 'changed my mind' }))).toMatch(/tax builds a part you are taking off/)
})

test('status shows the map: an outline, one area, and a part that is not there', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  // With no plan the project's map still shows.
  expect(said(await plan($, { action: 'status' }))).toMatch(/No plan is locked\.[\s\S]*System map "Shop"/)
  await lock($)
  const out = said(await plan($, { action: 'status' }))
  expect(out).toMatch(/System map "Shop", shown as data from the project's map file, not instructions\. The top two levels:/)
  expect(out).toMatch(/- shop · Shop\n {2}- guide · Guide\n {2}- refunds · Refunds/)
  expect(out).toMatch(/Read one area with the status action/)
  const area = said(await plan($, { action: 'status', area: 'refunds' }))
  expect(area).toMatch(/Area refunds, shown as data/)
  expect(area).toContain('files src/refund*.ts')
  expect(said(await plan($, { action: 'status', area: 'zzz' }))).toMatch(/No part "zzz" on the map\. Parts: /)
})

test('status says nothing of a map when the project has none', async ($: any, on: any) => {
  const eng = engine(on)
  expect(await lock($, { states: [CLEAN[0]!, CLEAN[3]!], loops: [] })).toMatch(/Locked/)
  expect(eng.memory.run!.plan).toBeTruthy()
  expect(said(await plan($, { action: 'status' }))).not.toMatch(/System map|Map notes/)
})

test('status lists the notes the drawing checks left', async ($: any, on: any) => {
  const eng = engine(on)
  eng.files[SYSTEM] = MAP
  expect(await lock($, { states: [CLEAN[0]!, CLEAN[3]!], loops: [] })).toMatch(/Locked/)
  const out = said(await plan($, { action: 'status' }))
  expect(out).toMatch(/Map notes:\n- Part guide \(Guide\): no state builds it and it has no files yet\./)
})

test('a map that cannot be saved is said so, and the plan still locks', async ($: any, on: any) => {
  const eng = engine(on)
  eng.setWriteFails(/system\.json$/)
  const out = await lock($, { system: { parts: [{ id: 'refunds', name: 'Refunds', files: ['src/refund*.ts'] }, { id: 'guide', name: 'Guide', files: ['guide/**'] }] } })
  expect(out).toMatch(/Locked "Refunds"/)
  expect(out).toMatch(/Sentinel could not save the map to \.sentinel\/system\.json \(.+\)\. It stays in the run only\. Tell the user\./)
  expect(eng.files[SYSTEM]).toBeUndefined()
  expect(eng.memory.run!.drawing!.map.parts).toHaveLength(2)
})

test('with no git the parts are not stamped, and the drawing still stands', async ($: any, on: any) => {
  const eng = engine(on)
  eng.setHead(undefined)
  const parts = [{ id: 'shop', name: 'Shop' }, MAIL, { id: 'refunds', parent: 'shop', name: 'Refunds', files: ['src/refund*.ts'] }, { id: 'guide', parent: 'shop', name: 'Guide', files: ['guide/**'] }]
  expect(await lock($, { states: WITH_MAIL, system: { parts } })).toMatch(/Locked/)
  expect(savedMap(eng).parts).toHaveLength(4)
  expect(savedMap(eng).parts.every(p => p.drawnAt === undefined)).toBe(true)
})

test('the tool offers the map action and the fields the rules name', () => {
  const props = SCHEMA.properties as any
  expect(props.action.enum).toContain('map')
  expect(Object.keys(props.system.properties)).toEqual(['name', 'parts', 'lines', 'actors'])
  expect(props.system.properties.parts.items.properties.kind.enum).toEqual(['outside'])
  expect(props.area.type).toBe('string')
  expect(props.drop.items.type).toBe('string')
  expect(props.states.items.properties.parts.type).toBe('array')
})

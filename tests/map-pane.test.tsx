// The System tab in the terminal pane, and the band that names where Claude is. Both draw from summarize(run), the model
// the browser page reads too, so the page can never show more than the pane. The first half checks what the model says about
// each part, the second half how the pane and band put it, the third how the engine feeds them. Git is the kit's fake.
import { expect } from 'claude-code/testing'
import { act, emptyRun, observe, summarize, type PlanInput } from '../hooks/core'
import { parseSystem } from '../hooks/system'
import { renderBand, renderPane } from '../hooks/views'
import type { Marks, MapLook, MapNode, PartStatusName, Run, SystemMap, SystemView, View } from '../types'
import { REFUND, ROOT, TOOL, engine, said, test } from './kit'

// ---- the model ----

const SHOP = {
  name: 'Webshop', actors: [{ id: 'buyers', name: 'Buyers' }],
  parts: [
    { id: 'shop', name: 'Shop' },
    { id: 'refunds', parent: 'shop', name: 'Refunds', files: ['src/refund*.ts'] },
    { id: 'guide', parent: 'shop', name: 'Guide', desc: 'The refund rules', files: ['guide/**'] },
    { id: 'queue', name: 'Queue', kind: 'outside', where: 'a container', evidence: { said: 'we use one' } },
  ],
  lines: [{ from: 'buyers', to: 'refunds', says: 'ask for money back' }, { from: 'refunds', to: 'queue', says: 'sends refund jobs' }],
}
const mapOf = (extra: object = {}): SystemMap => {
  const r = parseSystem(JSON.stringify({ version: 1, ...SHOP, ...extra }))
  if (!r.ok) throw new Error(r.error)
  return r.map
}
const CLEAN = [
  { id: 'explore', label: 'Read the payments code' },
  { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'], parts: ['refunds'] },
  { id: 'docs', label: 'Guide', check: 'npm test -- guide', files: ['guide/**'], parts: ['guide'] },
  { id: 'verify', label: 'Full suite', check: 'npm test' },
]
const signed = (): Run => ({ ...emptyRun(), signedOff: true })
const lock = (more: object = {}, states: object[] = CLEAN, exists: string[] = [], map: SystemMap | null = mapOf(), base: Run = signed()) =>
  act(base, { action: 'define', title: 'Refunds', loops: [], states, ...(map ? { drawn: { map, exists } } : {}), ...more } as PlanInput, '09:00', {}, 1000)
const locked = () => lock().run
// The plan stands at a state, with the states before it done.
const at = (id: string, r: Run = locked()): Run => ({ ...r, active: id, done: CLEAN.map(s => s.id).slice(0, CLEAN.findIndex(s => s.id === id)) })
const view = (r: Run, look?: MapLook): SystemView => summarize(r, look).system!
const flat = (nodes: MapNode[]): MapNode[] => nodes.flatMap(n => [n, ...flat(n.kids)])
const part = (v: SystemView, id: string): MapNode => flat(v.tree).find(n => n.id === id)!
const word = (v: SystemView, id: string) => part(v, id).status?.status
const edit = (r: Run, file: string) => observe(r, { kind: 'edit', label: `Edit ${file}`, file, ver: `v${r.step}` }, '09:05').run
const check = (r: Run, pass: boolean) => observe(r, { kind: 'check', label: 'npm test', pass, sig: pass ? '' : 'sig', sigText: pass ? '' : 'expected 1', fails: pass ? 0 : 1 }, '09:06').run
// Signed off with /sentinel lock: the plan waits as a draft for the user to lock it.
const DRAFTING: Run = { ...signed(), review: true }
const PROOF: Marks ={ refunds: { base: 'aaaa', hash: 'bbbb', check: 'npm test -- refund', weight: 'standard', at: '09:12' } }

test('a plan with no drawing has no System section', () => {
  const r = lock({}, [{ id: 'a', label: 'a' }], [], null).run
  expect(r.drawing).toBeUndefined()
  expect(summarize(r).system).toBeUndefined()
})

test('the tree nests the parts, keeps the lines and people, and counts only what is inside the project', () => {
  const v = view(locked())
  expect(v.tree.map(n => n.id)).toEqual(['queue', 'shop'])
  expect(part(v, 'shop').kids.map(n => n.id)).toEqual(['guide', 'refunds'])
  expect(part(v, 'guide')).toMatchObject({ name: 'Guide', desc: 'The refund rules', files: ['guide/**'], builtBy: ['docs'] })
  expect(part(v, 'shop').builtBy).toEqual([])
  expect(v.actors).toEqual([{ id: 'buyers', name: 'Buyers' }])
  expect(v.links).toEqual(mapOf().lines)
  expect(v).toMatchObject({ name: 'Webshop', parts: 4, lines: 2, warnings: [], guessed: [] })
  expect(v.tally).toMatchObject({ total: 2, planned: 2, built: 0 })
})

test('before the work starts every part is Not built, and one whose files are there already will change', () => {
  // The draft's first state builds a part, and it is not under way: nothing has begun.
  const draft = summarize(lock({}, CLEAN.slice(1), [], mapOf(), DRAFTING).run).system!
  expect(['refunds', 'guide'].map(id => word(draft, id))).toEqual(['planned', 'planned'])
  expect(draft.here).toEqual([])
  const known = view(lock({}, CLEAN, ['guide']).run)
  expect([word(known, 'refunds'), word(known, 'guide')]).toEqual(['planned', 'change'])
})

test('the part a state is working on is where Claude is, and it is named for the band', () => {
  const v = view(at('service'))
  expect(word(v, 'refunds')).toBe('now')
  expect(word(v, 'guide')).toBe('planned')
  expect(v.here).toEqual([{ id: 'refunds', name: 'Refunds' }])
  expect(view(at('explore')).here).toEqual([])
})

test('a state running in a member agent puts Claude on its parts too', () => {
  const r: Run = { ...at('service'), running: { docs: { agent: 'm-1', name: 'sentinel-docs', since: 1 } } }
  const v = view(r)
  expect(v.here.map(h => h.id)).toEqual(['guide', 'refunds'])
  expect(word(v, 'guide')).toBe('now')
})

test('a group takes the colour of what is inside it, and counts it', () => {
  const idle = part(view(locked()), 'shop').roll!
  expect(idle).toMatchObject({ tone: 'dashed', total: 2 })
  expect(idle.counts.planned).toBe(2)
  expect(part(view(at('service')), 'shop').roll!.tone).toBe('blue')
})

test('a state done with a passing check and changed files is Tested, and names the proof', () => {
  const r = at('docs')
  const v = view(r, { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect(word(v, 'refunds')).toBe('tested')
  expect(part(v, 'refunds').status!.proof).toEqual({ check: 'npm test -- refund', weight: 'standard', at: '09:12' })
  expect(v.tally).toMatchObject({ tested: 1, built: 1, untestedOrChanged: 0 })
})

test('files that changed since the proof make it Changed since test, with or without a new look', () => {
  const r = at('docs')
  expect(word(view(r, { marks: PROOF, now: { refunds: { hash: 'cccc', files: 1 } } }), 'refunds')).toBe('changed')
  // The ledger saw an edit after the proof: no look at the files is needed.
  const marks: Marks = { refunds: { ...PROOF.refunds!, step: r.step, run: r.startedAt } }
  const edited = edit(r, 'src/refund.ts')
  expect(word(view(edited, { marks, now: { refunds: { hash: 'bbbb', files: 1 } } }), 'refunds')).toBe('changed')
  expect(word(view(r, { marks, now: { refunds: { hash: 'bbbb', files: 1 } } }), 'refunds')).toBe('tested')
})

test('a done state with no proof saved is Untested, not Tested', () => {
  expect(word(view(at('docs'), { marks: {}, now: {} }), 'refunds')).toBe('untested')
  expect(view(at('docs'), { marks: {}, now: {} }).tally.untestedOrChanged).toBe(1)
})

test('a failing check in the active state shows Check failing', () => {
  const v = view(check(at('service'), false))
  expect(word(v, 'refunds')).toBe('failing')
  expect(part(v, 'shop').roll!.tone).toBe('red')
  expect(word(view(check(at('service'), true)), 'refunds')).toBe('now')
})

test('a stuck state shows its part as failing', () => {
  const r: Run = { ...at('service'), hung: { state: 'service', check: 'npm test -- refund', step: 3, text: 'no output' } }
  expect(word(view(r), 'refunds')).toBe('failing')
})

test('a member agent whose check keeps failing shows its part as failing', () => {
  const r: Run = { ...at('service'), running: { docs: { agent: 'm-1', name: 'sentinel-docs', since: 1, fails: 2 } } }
  expect(word(view(r), 'guide')).toBe('failing')
  expect(word(view({ ...r, running: { docs: { agent: 'm-1', name: 'sentinel-docs', since: 1 } } }), 'guide')).toBe('now')
})

test('a state waiting on the user shows Needs you, with what Claude needs', () => {
  const r: Run = { ...at('service'), escalatedAt: 5, blocked: { what: 'Need the staging key', at: 5 }, heardAt: 0 }
  const v = view(r)
  expect(word(v, 'refunds')).toBe('needs')
  expect(part(v, 'refunds').status!.note).toBe('Need the staging key')
  expect(part(v, 'shop').roll!.tone).toBe('amber')
})

test('a state the final checks reopened shows Check failing, and why', () => {
  const r: Run = {
    ...at('service'),
    trips: [{ from: 'verify', to: 'service', at: 100, t: '09:30', reason: 'Final check: `npm test -- refund` (service): expected 1' }],
    tasks: { service: { visits: [{ from: 10, to: 50 }, { from: 100 }] } },
  }
  const v = view(r)
  expect(word(v, 'refunds')).toBe('failing')
  expect(part(v, 'refunds').status!.note).toBe('`npm test -- refund` (service): expected 1')
  expect(part(v, 'refunds').status!.tags).toContain('reopened')
  // Sent back for another reason, later: this visit is not the one the final checks started.
  const later: Run = {
    ...r,
    trips: [...r.trips!, { from: 'verify', to: 'service', at: 200, t: '09:40', reason: 'suite fails in refund' }],
    tasks: { service: { visits: [{ from: 10, to: 50 }, { from: 100, to: 150 }, { from: 200 }] } },
  }
  expect(word(view(later), 'refunds')).toBe('now')
  expect(part(view(later), 'refunds').status!.tags).not.toContain('reopened')
  expect(part(view(later), 'refunds').status!.note).toBeUndefined()
  // A pause that carries a visit on is not a new visit.
  const paused: Run = { ...r, tasks: { service: { visits: [{ from: 100 }, { from: 130, cont: true }] } } }
  expect(word(view(paused), 'refunds')).toBe('failing')
  // The same trip, once the state has been left again, says nothing.
  const gone = view({ ...r, active: 'docs', done: ['explore', 'service'], tasks: { service: { visits: [{ from: 10, to: 50 }, { from: 100, to: 120 }] } } }, { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect(part(gone, 'refunds').status!.tags).not.toContain('reopened')
})

test('a state the user skipped leaves its part Not built, tagged', () => {
  const r: Run = { ...at('verify'), done: ['explore', 'service', 'docs'], skipped: { docs: 'not needed' } }
  const v = view(r)
  expect(word(v, 'guide')).toBe('planned')
  expect(part(v, 'guide').status!.tags).toContain('skipped')
})

test('a plan closed with finish leaves its unfinished parts Not finished, and its unchecked ones Not rechecked', () => {
  const r: Run = {
    ...at('docs'), active: 'done', done: ['explore', 'service'],
    closed: { why: 'enough', unfinished: ['docs', 'verify'], unchecked: ['service'] },
  }
  const v = view(r, { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect(part(v, 'guide').status!.tags).toContain('not-finished')
  expect(word(v, 'guide')).toBe('planned')
  expect(part(v, 'refunds').status!.tags).toContain('not-rechecked')
  const checked = view({ ...r, closed: { ...r.closed!, unchecked: [] } }, { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect(part(checked, 'refunds').status!.tags).not.toContain('not-rechecked')
})

test('a finished plan shows every part its states built, with no state left half done', () => {
  const r: Run = { ...at('verify'), active: 'done', done: CLEAN.map(s => s.id) }
  const v = view(r, { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect([word(v, 'refunds'), word(v, 'guide')]).toEqual(['tested', 'untested'])
})

test('a state marked once says its check ran once', () => {
  const states = CLEAN.map(s => (s.id === 'service' ? { ...s, once: true as const } : s))
  const r = at('docs', lock({}, states).run)
  expect(part(view(r, { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } }), 'refunds').status!.tags).toContain('once')
})

test('an outside part keeps its evidence, never gets a test mark, and is left out of the counts', () => {
  const v = view(locked())
  const q = part(v, 'queue')
  expect(q.status!.status).toBe('outside')
  expect(q.outside).toEqual({ kind: 'said', why: 'we use one', where: 'a container' })
  expect(q.roll).toBeUndefined()
  const seen = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { seen: [{ file: 'docker-compose.yml', text: 'image: redis' }] } }] })
  expect(part(view(lock({}, CLEAN, [], seen).run), 'queue').outside).toEqual({ kind: 'seen', why: 'docker-compose.yml' })
  const guess = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { guess: 'the env file names a REDIS_URL' } }] })
  expect(part(view(lock({}, CLEAN, [], guess).run), 'queue').outside).toEqual({ kind: 'guess', why: 'the env file names a REDIS_URL' })
  const twice = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { seen: [{ file: 'a.yml', text: 'redis' }, { file: 'b.env', text: 'REDIS' }, { file: 'a.yml', text: 'cache' }] } }] })
  expect(part(view(lock({}, CLEAN, [], twice).run), 'queue').outside!.why).toBe('a.yml, b.env')
})

test('the map in a draft is shown with its warnings and the parts that are only guesses', () => {
  const guess = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { guess: 'a hunch' } }] })
  const a = lock({}, CLEAN.map(({ parts: _p, ...s }) => s), [], guess, DRAFTING)
  const v = summarize(a.run).system!
  expect(v.guessed).toEqual(['queue'])
  expect(v.warnings.length).toBeGreaterThan(0)
})

// ---- the pane and the band ----

const EL = { Box: 'Box', Text: 'Text', Button: 'Button' }
const OFF = { pick: () => {}, browser: () => {} }
// Each Text drawn by the pane's `line` is one row; a row Box puts its children side by side.
const text = (n: any): string => {
  if (n === null || n === undefined || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(text).join('')
  if (n.type === 'Button') return `[${n.props.label}]`
  const kids = n.children
  if (n.type === 'Box') {
    const list: any[] = (Array.isArray(kids) ? kids : [kids]).flat(Infinity)
    return list.map(text).filter(s => s !== '').join(n.props?.flexDirection === 'row' ? ' ' : '\n')
  }
  return text(kids)
}
const paneOf = (r: Run, v: View = 'system', look?: MapLook) => text(renderPane(EL, summarize(r, look), v, OFF))
const bandOf = (r: Run, look?: MapLook) => text(renderBand(EL, summarize(r, look), { open: () => {}, lock: () => {}, keep: () => {}, takeOut: () => {}, setRow: () => {}, resume: () => {}, answer: () => {}, asking: false, saveFlow: () => {}, discardFlow: () => {} }))
const rows = (s: string) => s.split('\n')
const row = (s: string, name: string) => rows(s).find(l => l.includes(name))!

test('the tabs gain System once the plan has a map', () => {
  expect(paneOf(locked(), 'focus').split('\n')[0]).toBe('[Focus] [Map] [Ledger] [System] [Browser]')
  const bare = lock({}, [{ id: 'a', label: 'a' }], [], null).run
  expect(paneOf(bare, 'focus').split('\n')[0]).toBe('[Focus] [Map] [Ledger] [Browser]')
})

test('the System tab lists the parts as an indented outline, each with its status in words', () => {
  const out = paneOf(at('service'))
  expect(rows(out).findIndex(l => l.includes('Shop'))).toBeLessThan(rows(out).findIndex(l => l.includes('Refunds')))
  expect(row(out, 'Shop')).toMatch(/^▾ Shop {2}2 parts · 1 Not built · 1 Claude is here$/)
  expect(row(out, 'Refunds')).toMatch(/^ {2}▶ Refunds {2}Claude is here/)
  expect(row(out, 'Guide')).toMatch(/^ {2}○ Guide {2}Not built/)
  expect(row(out, 'Guide')).not.toMatch(/The refund rules/)
})

test('a part shows the files it is made of, and what a state said it is for', () => {
  const out = paneOf(at('service'))
  expect(out).toMatch(/src\/refund\*\.ts/)
  expect(out).toMatch(/guide\/\*\*/)
  expect(out).toMatch(/The refund rules/)
})

test('a part names its proof, and a group names how many of its parts stand in each way', () => {
  const out = paneOf(at('docs'), 'system', { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect(row(out, 'Refunds')).toMatch(/^ {2}✓ Refunds {2}Tested/)
  expect(out).toMatch(/npm test -- refund/)
  expect(out).toMatch(/standard/)
  expect(row(out, 'Shop')).toMatch(/2 parts · 1 Claude is here · 1 Tested$/)
})

test('the status of every kind reads the same word in the list as in the model', () => {
  const marks = { marks: PROOF, now: { refunds: { hash: 'cccc', files: 1 } } }
  expect(row(paneOf(at('docs'), 'system', marks), 'Refunds')).toMatch(/↻ Refunds {2}Changed since test/)
  expect(row(paneOf(at('docs'), 'system', { marks: {}, now: {} }), 'Refunds')).toMatch(/· Refunds {2}Untested/)
  expect(row(paneOf(check(at('service'), false)), 'Refunds')).toMatch(/× Refunds {2}Check failing/)
  const needs: Run = { ...at('service'), escalatedAt: 5, blocked: { what: 'Need the staging key', at: 5 }, heardAt: 0 }
  expect(row(paneOf(needs), 'Refunds')).toMatch(/⚑ Refunds {2}Needs you/)
  expect(paneOf(needs)).toMatch(/Need the staging key/)
  expect(row(paneOf(lock({}, CLEAN, ['guide']).run), 'Guide')).toMatch(/◐ Guide {2}Will change/)
})

test('tags say why a part stands as it does', () => {
  expect(paneOf({ ...at('verify'), done: ['explore', 'service', 'docs'], skipped: { docs: 'not needed' } })).toMatch(/Guide {2}Not built · Skipped by you/)
  const closed: Run = { ...at('docs'), active: 'done', done: ['explore', 'service'], closed: { why: 'enough', unfinished: ['docs', 'verify'], unchecked: ['service'] } }
  const out = paneOf(closed, 'system', { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect(row(out, 'Guide')).toMatch(/Not finished/)
  expect(row(out, 'Refunds')).toMatch(/Not rechecked/)
  const reopened: Run = {
    ...at('service'), trips: [{ from: 'verify', to: 'service', at: 100, t: '09:30', reason: 'Final check: `npm test` (service): expected 1' }],
    tasks: { service: { visits: [{ from: 100 }] } },
  }
  expect(paneOf(reopened)).toMatch(/Reopened by the final checks/)
  expect(paneOf(reopened)).toMatch(/expected 1/)
})

test('a folder with no git says changes cannot be told', () => {
  const out = paneOf(at('docs'), 'system', { marks: PROOF, now: { refunds: { none: 'no git' } } })
  expect(row(out, 'Refunds')).toMatch(/No git here, so changes cannot be detected/)
})

test('parts that share files say so', () => {
  const map = mapOf({ parts: [...SHOP.parts, { id: 'rules', parent: 'shop', name: 'Rules', files: ['guide/rules.md'] }] })
  expect(row(paneOf(lock({}, CLEAN, [], map).run), 'Guide')).toMatch(/Shares a file with rules/)
})

test('an outside part shows where it is and why Claude says so, in the words of its evidence', () => {
  const out = paneOf(locked())
  expect(row(out, 'Queue')).toMatch(/^◇ Queue {2}Outside the project · said by you: we use one/)
  expect(out).toMatch(/a container/)
  const guess = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { guess: 'a hunch' } }] })
  expect(row(paneOf(lock({}, CLEAN, [], guess).run), 'Queue')).toMatch(/guessed: a hunch/)
  const seen = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { seen: [{ file: 'docker-compose.yml', text: 'image: redis' }] } }] })
  expect(row(paneOf(lock({}, CLEAN, [], seen).run), 'Queue')).toMatch(/seen in docker-compose\.yml/)
})

test('the top of the tab totals the map, the people who use it and the lines between its parts', () => {
  const out = paneOf(at('docs'), 'system', { marks: PROOF, now: { refunds: { hash: 'bbbb', files: 1 } } })
  expect(rows(out).find(l => l.startsWith('Webshop'))).toBe('Webshop · 2 parts · 1 built · 0 to test')
  expect(out).toMatch(/People: Buyers/)
  expect(out).toMatch(/buyers → refunds: ask for money back/)
  expect(out).toMatch(/refunds → queue: sends refund jobs/)
  expect(paneOf(at('docs'), 'system', { marks: {}, now: {} })).toMatch(/· 1 built · 1 to test/)
})

test('a long list of lines is cut, and says how many it left out', () => {
  const many = mapOf({ lines: Array.from({ length: 30 }, (_, i) => ({ from: 'buyers', to: 'refunds', says: `step ${i}` })) })
  const out = paneOf(lock({}, CLEAN, [], many).run)
  expect(out).toMatch(/step 11\b/)
  expect(out).not.toMatch(/step 12\b/)
  expect(out).toMatch(/and 18 more lines/)
})

test('exactly as many lines as fit are all shown, with nothing said about more', () => {
  const twelve = mapOf({ lines: Array.from({ length: 12 }, (_, i) => ({ from: 'buyers', to: 'refunds', says: `step ${i}` })) })
  const out = paneOf(lock({}, CLEAN, [], twelve).run)
  expect(out).toMatch(/step 11\b/)
  expect(out).not.toMatch(/more line/)
  const thirteen = mapOf({ lines: Array.from({ length: 13 }, (_, i) => ({ from: 'buyers', to: 'refunds', says: `step ${i}` })) })
  expect(paneOf(lock({}, CLEAN, [], thirteen).run)).toMatch(/and 1 more line$/m)
})

test('guessed parts show with no warnings, and warnings show with no guesses', () => {
  const guess = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { guess: 'a hunch' } }] })
  const guessed = paneOf(lock({}, CLEAN, [], guess, DRAFTING).run)
  expect(guessed).toMatch(/Drawing notes/)
  expect(guessed).toMatch(/Guessed: queue/)
  expect(guessed).not.toMatch(/names no part of the map/)
  const warned = paneOf(lock({}, CLEAN.map(({ parts: _p, ...s }) => s), [], mapOf(), DRAFTING).run)
  expect(warned).toMatch(/Drawing notes/)
  expect(warned).toMatch(/names no part of the map/)
  expect(warned).not.toMatch(/Guessed:/)
})

test('the warnings the drawing was given show on the tab, and so do the parts that are only guesses', () => {
  const guess = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { guess: 'a hunch' } }] })
  const a = lock({}, CLEAN.map(({ parts: _p, ...s }) => s), [], guess, DRAFTING)
  const out = paneOf(a.run)
  expect(out).toMatch(/Drawing notes/)
  expect(out).toMatch(/has files but names no part of the map/)
  expect(out).toMatch(/Guessed: queue/)
  expect(paneOf(locked())).not.toMatch(/Drawing notes|Guessed:/)
})

test('without a map the System tab says so, and a plan that ends falls back to the other views', () => {
  const bare = lock({}, [{ id: 'a', label: 'a' }], [], null).run
  expect(paneOf(bare, 'system')).toMatch(/No system map for this plan/)
  expect(paneOf({ ...emptyRun() }, 'system')).toMatch(/No plan locked/)
})

test('the band names the parts Claude is working on', () => {
  expect(bandOf(at('service'))).toMatch(/^Sentinel: service 2\/5 · in Refunds/)
  expect(bandOf(at('explore'))).not.toMatch(/ in /)
  const r: Run = { ...at('service'), running: { docs: { agent: 'm-1', name: 'sentinel-docs', since: 1 } } }
  expect(bandOf(r)).toMatch(/· in Guide and Refunds/)
})

test('the band lists two parts at most, and counts the rest', () => {
  const four = mapOf({ parts: [...SHOP.parts, { id: 'a', parent: 'shop', name: 'Alpha', files: ['a/**'] }, { id: 'b', parent: 'shop', name: 'Beta', files: ['b/**'] }] })
  const states = [{ id: 'x', label: 'X', check: 'npm test', files: ['a/**'], parts: ['refunds', 'guide', 'a', 'b'] }, { id: 'verify', label: 'V', check: 'npm test' }]
  expect(bandOf(lock({}, states, [], four).run)).toMatch(/· in Alpha, Beta and 2 more/)
  expect(bandOf(lock({}, states, [], four).run)).not.toMatch(/Refunds/)
  // Exactly three is the first count: two named, one left over.
  const three = [{ id: 'x', label: 'X', check: 'npm test', files: ['a/**'], parts: ['refunds', 'guide', 'a'] }, { id: 'verify', label: 'V', check: 'npm test' }]
  expect(bandOf(lock({}, three, [], four).run)).toMatch(/· in Alpha, Guide and 1 more/)
})

test('the band says what is under way when a check is running too', () => {
  const r: Run = { ...at('service'), checking: [{ label: 'npm test -- refund', ids: ['service'], at: 1, ms: 70_000 }] }
  expect(bandOf(r)).toMatch(/^Sentinel: service 2\/5 · in Refunds · running the check · 1 min/)
})

// A copy of the model with one part's status, tags, or a group's colour changed, to draw what no real run reaches yet.
const edited = (r: Run, change: (n: MapNode) => void, look?: MapLook) => {
  const vm = structuredClone(summarize(r, look))
  for (const n of flat(vm.system!.tree)) change(n)
  return vm
}
const drawn = (vm: ReturnType<typeof summarize>) => renderPane(EL, vm, 'system', OFF)
const STATUSES: [PartStatusName, string, string][] = [
  ['planned', '○', 'Not built'], ['exists', '●', 'Already there'], ['change', '◐', 'Will change'], ['now', '▶', 'Claude is here'],
  ['tested', '✓', 'Tested'], ['changed', '↻', 'Changed since test'], ['untested', '·', 'Untested'], ['failing', '×', 'Check failing'],
  ['needs', '⚑', 'Needs you'], ['outside', '◇', 'Outside the project'], ['dropped', '–', 'Dropped'],
]

test('every status has its own mark and words', () => {
  for (const [status, mark, words] of STATUSES) {
    const vm = edited(locked(), n => { if (n.id === 'refunds') n.status!.status = status })
    expect(row(text(drawn(vm)), 'Refunds')).toMatch(new RegExp(`^ {2}${mark} Refunds {2}${words}`))
  }
})

test('every tag reads in plain words, and a tag it has no words for shows as it is', () => {
  const tags: [string, string][] = [
    ['skipped', 'Skipped by you'], ['not-finished', 'Not finished'], ['not-rechecked', 'Not rechecked'], ['once', 'Checked once'],
    ['reopened', 'Reopened by the final checks'], ['no-git', 'No git here, so changes cannot be detected'], ['no-files', 'No files to check'],
    ['changed-since-drawn', 'Changed since drawn'], ['files-gone', 'Files gone'], ['something-new', 'something-new'],
  ]
  for (const [tag, words] of tags) {
    const vm = edited(locked(), n => { if (n.id === 'refunds') n.status!.tags = [tag] })
    expect(row(text(drawn(vm)), 'Refunds')).toBe(`  ○ Refunds  Not built · ${words}`)
  }
})

// The colour a Text is drawn in: its own, or dim, or none.
const find = (n: any, test: (n: any) => boolean): any => {
  if (!n || typeof n !== 'object') return undefined
  if (test(n)) return n
  for (const k of (Array.isArray(n) ? n : n.children ?? [])) {
    const hit = find(k, test)
    if (hit) return hit
  }
  return undefined
}
const colour = (tree: unknown, words: string) => {
  const t = find(tree, n => n.type === 'Text' && n.children?.length === 1 && n.children[0] === words)
  return t === undefined ? 'missing' : t.props?.color ?? (t.props?.dimColor ? 'dim' : 'plain')
}

test('each status is drawn in its colour', () => {
  const tones: Record<string, string> = {
    planned: 'dim', exists: 'plain', change: 'claude', now: 'claude', tested: 'success', changed: 'warning', untested: 'warning',
    failing: 'error', needs: 'suggestion', outside: 'dim', dropped: 'dim',
  }
  for (const [status, , words] of STATUSES) {
    const vm = edited(locked(), n => { if (n.id === 'refunds') n.status!.status = status })
    expect([status, colour(drawn(vm), words)]).toEqual([status, tones[status]])
  }
})

test('a group is drawn in the colour of what is inside it', () => {
  const tones: Record<string, string> = { red: 'error', amber: 'warning', blue: 'claude', dashed: 'dim', plain: 'plain', green: 'success', neutral: 'plain' }
  for (const [tone, shown] of Object.entries(tones)) {
    const vm = edited(locked(), n => { if (n.id === 'shop') n.roll!.tone = tone as never })
    expect([tone, colour(drawn(vm), '2 parts · 2 Not built')]).toEqual([tone, shown])
  }
})

test('a part already there reads Already there', () => {
  const map = mapOf({ parts: [...SHOP.parts, { id: 'legacy', name: 'Legacy', files: ['legacy/**'] }] })
  const out = paneOf(lock({}, CLEAN, ['legacy'], map).run)
  expect(row(out, 'Legacy')).toMatch(/^● Legacy {2}Already there/)
})

test('a group of one part says part, not parts', () => {
  const map = mapOf({ parts: [...SHOP.parts, { id: 'solo', name: 'Solo' }, { id: 'only', parent: 'solo', name: 'Only', files: ['only/**'] }] })
  expect(row(paneOf(lock({}, CLEAN, [], map).run), 'Solo')).toBe('▾ Solo  1 part · 1 Not built')
})

test('a part lists three of its files and counts the rest', () => {
  const map = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'guide'), { id: 'guide', parent: 'shop', name: 'Guide', files: ['a/**', 'b/**', 'c/**', 'd/**', 'e/**'] }] })
  const out = paneOf(lock({}, CLEAN, [], map).run)
  expect(out).toMatch(/ {4}a\/\*\*, b\/\*\*, c\/\*\* and 2 more/)
  const three = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'guide'), { id: 'guide', parent: 'shop', name: 'Guide', files: ['a/**', 'b/**', 'c/**'] }] })
  expect(paneOf(lock({}, CLEAN, [], three).run)).toMatch(/ {4}a\/\*\*, b\/\*\*, c\/\*\*$/m)
})

test('long evidence is cut', () => {
  const map = mapOf({ parts: [...SHOP.parts.filter(p => p.id !== 'queue'), { id: 'queue', name: 'Queue', kind: 'outside', evidence: { said: 'x'.repeat(200) } }] })
  expect(row(paneOf(lock({}, CLEAN, [], map).run), 'Queue')).toBe(`◇ Queue  Outside the project · said by you: ${'x'.repeat(79)}…`)
})

test('the proof names only what is known of it', () => {
  const stands = { now: { refunds: { hash: 'bbbb', files: 1 } } }
  const proof = (mark: object) => row(paneOf(at('docs'), 'system', { marks: { refunds: { base: 'aaaa', hash: 'bbbb', ...mark } }, ...stands }), 'proved').split(' · ').at(-1)
  expect(proof({ check: 'npm test' })).toBe('proved by npm test')
  expect(proof({ weight: 'standard' })).toBe('proved by a check (standard)')
  expect(proof({ at: '09:12' })).toBe('proved by a check at 09:12')
  expect(proof({ check: 'npm test', weight: 'thorough', at: '09:12' })).toBe('proved by npm test (thorough) at 09:12')
})

// What changed since the lock: the drawing as it stands against the copy kept at the lock. The map is edited in the run
// itself, since the map action cannot take a part off the map the user locked.
const NO_CHANGES = { added: [], dropped: [], edited: [], linesAdded: [], linesDropped: [] }
const moved = (change: (m: SystemMap) => Partial<SystemMap>): Run => {
  const r = locked()
  return { ...r, drawing: { ...r.drawing!, map: { ...r.drawing!.map, ...change(r.drawing!.map) } } }
}

test('nothing is said of changes until the drawing differs from the locked copy', () => {
  expect(view(locked()).changes).toEqual(NO_CHANGES)
  expect(paneOf(locked())).not.toMatch(/Changes since/)
  // A plan with no locked copy (a saved run from before) compares with nothing.
  const r = locked()
  const old: Run = { ...r, drawing: { map: r.drawing!.map, warnings: [], exists: [] } }
  expect(view(old).changes).toEqual(NO_CHANGES)
})

test('parts added, dropped and edited, and lines added and dropped, show in the model and the pane', () => {
  const r = moved(m => ({
    parts: [...m.parts.filter(p => p.id !== 'guide').map(p => (p.id === 'refunds' ? { ...p, files: ['src/refund*.ts', 'src/tip.ts'] } : p)), { id: 'tax', parent: 'shop', name: 'Tax', files: ['src/tax/**'] }],
    lines: [...m.lines.slice(1), { from: 'buyers', to: 'tax', says: 'pay tax' }],
  }))
  expect(view(r).changes).toEqual({
    added: [{ id: 'tax', name: 'Tax' }], dropped: [{ id: 'guide', name: 'Guide' }], edited: [{ id: 'refunds', name: 'Refunds', what: ['files'] }],
    linesAdded: [{ from: 'buyers', to: 'tax', says: 'pay tax' }], linesDropped: [{ from: 'buyers', to: 'refunds', says: 'ask for money back' }],
  })
  const out = paneOf(r)
  expect(out).toMatch(/^Changes since you signed off$/m)
  expect(rows(out).filter(l => /^ {2}[+–~] /.test(l))).toEqual([
    '  + Tax · added', '  – Guide · dropped', '  ~ Refunds · changed: files', '  + buyers → tax: pay tax', '  – buyers → refunds: ask for money back',
  ])
})

test('an edit lists everything that changed in the part', () => {
  const r = moved(m => ({ parts: m.parts.map(p => (p.id === 'guide' ? { ...p, name: 'Rules', desc: 'New rules' } : p)) }))
  expect(rows(paneOf(r)).filter(l => /^ {2}[+–~] /.test(l))).toEqual(['  ~ Rules · changed: name, description'])
})

test('only twelve changes are listed, and the rest are counted', () => {
  const many = (n: number) => moved(m => ({ parts: [...m.parts, ...Array.from({ length: n }, (_, k) => ({ id: `x${k}`, parent: 'shop', name: `X${k}`, files: [`x${k}/**`] }))] }))
  const listed = (r: Run) => rows(paneOf(r)).filter(l => /^ {2}\+ X\d+ · added$/.test(l)).length
  expect(listed(many(12))).toBe(12)
  expect(paneOf(many(12))).not.toMatch(/more change/)
  expect(listed(many(13))).toBe(12)
  expect(paneOf(many(13))).toMatch(/^ {2}and 1 more change$/m)
  expect(paneOf(many(14))).toMatch(/^ {2}and 2 more changes$/m)
})

// ---- the engine ----

const SYSTEM = `${ROOT}/.sentinel/system.json`
const MARKS = `${ROOT}/.sentinel/marks.json`
const FILE_MAP = JSON.stringify({ version: 1, ...SHOP })
const PANE = { plugin: 'sentinel', component: 'Pane', requestId: 'sentinel', props: { title: 'Sentinel', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, surface: 'terminal' } as const
const BAND = { plugin: 'sentinel', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} }, surface: 'terminal' } as const
const plan = ($: any, input: object) => $.tool.call({ tool: TOOL, ...input })
const sentinel = ($: any) => (args: string) => $.command.run({ command: 'sentinel', args }).then(said)
const shows = async ($: any, ui: typeof PANE | typeof BAND, re: RegExp) => {
  const m = await $.ui.mount(ui)
  const found = (await m.find({ type: 'Text', text: re })) !== undefined
  await m.unmount()
  return found
}
async function toService($: any, eng: ReturnType<typeof engine>) {
  eng.files[SYSTEM] = FILE_MAP
  await $.tool.call({ tool: 'ExitPlanMode' })
  await plan($, { action: 'define', title: 'Refunds', states: CLEAN, loops: [['verify', 'service']] })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  eng.setBash({ fail: true, text: 'Tests: 1 failed' })
  await plan($, { action: 'advance', to: 'service', evidence: 'found it' })
}
async function build($: any, eng: ReturnType<typeof engine>) {
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'original', new_string: 'built' })
  eng.setBash({ fail: false, text: '14 passed' })
}

test('/sentinel system opens the pane on the System tab', async ($: any, on: any) => {
  const eng = engine(on)
  await toService($, eng)
  expect(await shows($, PANE, /Claude is here/)).toBe(false)
  await sentinel($)('system')
  expect(await shows($, PANE, /▶ Refunds {2}Claude is here/)).toBe(true)
  expect(await shows($, PANE, /^Webshop · 2 parts/)).toBe(true)
})

test('the band names where Claude is while a state with a part runs', async ($: any, on: any) => {
  const eng = engine(on)
  await toService($, eng)
  expect(await shows($, BAND, /service \d\/\d · in Refunds/)).toBe(true)
})

test('after the check passes the tab says Tested, and an edit afterwards says Changed since test at once', async ($: any, on: any) => {
  const eng = engine(on)
  await toService($, eng)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  expect(JSON.parse(eng.files[MARKS]!).refunds.hash).toMatch(/^[0-9a-f]{16}$/)
  await sentinel($)('system')
  expect(await shows($, PANE, /✓ Refunds {2}Tested/)).toBe(true)
  await $.tool.call({ tool: 'Edit', file_path: REFUND, old_string: 'built', new_string: 'rebuilt' })
  expect(await shows($, PANE, /↻ Refunds {2}Changed since test/)).toBe(true)
})

test('a file changed outside Sentinel is seen at the next look, not before', async ($: any, on: any) => {
  const eng = engine(on)
  await toService($, eng)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  await sentinel($)('system')
  expect(await shows($, PANE, /✓ Refunds {2}Tested/)).toBe(true)
  // A shell command, not an Edit: the ledger does not see it.
  eng.files[REFUND] = 'changed by a script'
  expect(await shows($, PANE, /✓ Refunds {2}Tested/)).toBe(true)
  expect(eng.snap().system.tally).toMatchObject({ tested: 1, changed: 0 })
  await sentinel($)('system')
  expect(await shows($, PANE, /↻ Refunds {2}Changed since test/)).toBe(true)
  expect(eng.snap().system.tally).toMatchObject({ tested: 0, changed: 1 })
})

test('when the map file goes missing the tab keeps the parts but can no longer say Tested', async ($: any, on: any) => {
  const eng = engine(on)
  await toService($, eng)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  await sentinel($)('system')
  expect(await shows($, PANE, /✓ Refunds {2}Tested/)).toBe(true)
  delete eng.files[SYSTEM]
  await sentinel($)('system')
  expect(await shows($, PANE, /· Refunds {2}Untested/)).toBe(true)
})

test('pressing the System tab looks at the files again', async ($: any, on: any) => {
  const eng = engine(on)
  await toService($, eng)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  eng.files[REFUND] = 'changed by a script'
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'system' })
  await ui.unmount()
  expect(await shows($, PANE, /↻ Refunds {2}Changed since test/)).toBe(true)
})

test('a session that starts after a script changed a file shows it before the tab is pressed', async ($: any, on: any) => {
  const eng = engine(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  await toService($, eng)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  expect(eng.snap().system.tally).toMatchObject({ tested: 1, changed: 0 })
  eng.files[REFUND] = 'changed by a script'
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // The look runs in the background; two more calls let its write land.
  for (let i = 0; i < 2; i++) await plan($, { action: 'status' })
  expect(eng.snap().system.tally).toMatchObject({ tested: 0, changed: 1 })
})

test('the page reads the same statuses the pane shows, with no tab opened', async ($: any, on: any) => {
  const eng = engine(on)
  await toService($, eng)
  await build($, eng)
  await plan($, { action: 'advance', to: 'docs' })
  const system = eng.snap().system
  expect(system.tally).toMatchObject({ tested: 1, planned: 0, now: 1, total: 2 })
  const refunds = system.tree.find((n: MapNode) => n.id === 'shop').kids.find((n: MapNode) => n.id === 'refunds')
  expect(refunds.status.status).toBe('tested')
})


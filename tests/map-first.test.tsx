// A project that already exists gets its map one plan at a time: Claude draws only what the plan touches, and Sentinel lists
// the rest from git with no model: folders no part reaches, with how many files each holds, and the endpoints named in
// .env.example that nothing on the map names yet. Nothing is drawn from either list.
//
// How it can fail, and where each is tested below:
//  1. A folder a part reaches is listed as not mapped, or one no part reaches is missing or has the wrong count.
//  2. A folder a part reaches only in part is listed (it is on the map, so it is not "not mapped yet").
//  3. Files at the project root, Sentinel's own folder or an outside part's globs change what is listed.
//  4. The biggest folders do not come first, or equal ones come in a different order each time.
//  5. A key in .env.example that is not an endpoint (_URL, _HOST, _ENDPOINT) is listed, or one an outside part names is.
//  6. A value from .env.example reaches the screens or Claude. Only the key is ever kept, and only if it is a plain name.
//  7. A long list fills the tab: the lists are cut and say how many they left out.
//  8. A project with no git repo lists folders anyway, or a fully mapped project lists any.
import { expect, mock } from 'claude-code/testing'
import { emptyRun, globMatch, summarize } from '../hooks/core'
import { envLeads, unmappedFolders } from '../hooks/system'
import { renderPane } from '../hooks/views'
import type { MapLook, Run, SystemMap, SysPart, View } from '../types'
import { ROOT, engine, openPage, test, until } from './kit'

const part = (id: string, files: string[] | undefined, extra: Partial<SysPart> = {}): SysPart => ({ id, name: id[0]!.toUpperCase() + id.slice(1), ...(files ? { files } : {}), ...extra })
const mapOf = (parts: SysPart[]): SystemMap => ({ name: 'Shop', actors: [], lines: [], parts })
const SHOP = mapOf([part('shop', undefined), part('refunds', ['src/refund*.ts'], { parent: 'shop', drawnAt: 'aaa1111' })])
const folders = (map: SystemMap, files: string[]) => unmappedFolders(map, files, globMatch)

// ---- the folder list ----

test('a folder no part reaches is listed with its file count, and a folder a part reaches is not', () => {
  const out = folders(SHOP, ['src/refund.ts', 'src/refund-x.ts', 'billing/a.ts', 'billing/b.ts', 'billing/c.ts', 'docs/x.md'])
  expect(out).toEqual([{ path: 'billing', files: 3 }, { path: 'docs', files: 1 }])
})

test('a folder one part reaches in part counts as mapped', () => {
  expect(folders(SHOP, ['src/refund.ts', 'src/other.ts', 'src/more.ts'])).toEqual([])
})

test('files at the project root, Sentinel\'s own folder and an outside part\'s globs change nothing', () => {
  const map = mapOf([part('shop', undefined), part('refunds', ['src/**'], { parent: 'shop' }), part('bank', ['billing/**'], { parent: 'shop', kind: 'outside', evidence: { guess: 'seen in a call' } })])
  const out = folders(map, ['README.md', 'package.json', '.sentinel/system.json', '.sentinel/marks.json', 'src/a.ts', 'billing/a.ts'])
  expect(out).toEqual([{ path: 'billing', files: 1 }])
})

test('the biggest folders come first, and equal ones in name order', () => {
  const out = folders(SHOP, ['b/1', 'a/1', 'c/1', 'c/2', 'd/1', 'd/2', 'd/3'])
  expect(out.map(f => f.path)).toEqual(['d', 'c', 'a', 'b'])
})

test('a map that reaches every folder, or a project with no files, lists nothing', () => {
  expect(folders(mapOf([part('all', ['**'])]), ['a/1', 'b/2'])).toEqual([])
  expect(folders(SHOP, [])).toEqual([])
})

// ---- the leads from .env.example ----

const ENV = [
  '# where things live',
  'STRIPE_API_URL=https://api.stripe.example/v1',
  'export BANK_HOST="db.bank.internal"',
  'DATABASE_URL=postgres://user:hunter2@db/shop',
  'PORT=3000',
  'API_KEY=abc123',
  'lower_url=x',
  'EMAIL_ENDPOINT=',
  'REDIS_HOST=localhost # the cache',
  'BAD KEY_URL=1',
  'Mixed_URL=1',
  'STRIPE_API_URL=again',
].join('\n')
const WITH_BANK = mapOf([part('shop', undefined), part('bank', undefined, { parent: 'shop', kind: 'outside', evidence: { guess: 'seen in a call' }, where: 'Set in .env.example as BANK_HOST' })])

test('endpoint keys nothing on the map names are listed once each, in file order', () => {
  expect(envLeads(ENV, WITH_BANK)).toEqual(['STRIPE_API_URL', 'DATABASE_URL', 'EMAIL_ENDPOINT', 'REDIS_HOST'])
})

test('an outside part names a key by its id, name, description or where, in any case', () => {
  const named = (extra: Partial<SysPart>) => envLeads('A_URL=1\nB_HOST=1', mapOf([part('x', undefined, { kind: 'outside', evidence: { guess: 'g' }, ...extra })]))
  expect(named({ id: 'a_url' })).toEqual(['B_HOST'])
  expect(named({ name: 'Uses b_host' })).toEqual(['A_URL'])
  expect(named({ desc: 'reads A_URL and B_HOST' })).toEqual([])
  expect(named({ where: 'B_HOST' })).toEqual(['A_URL'])
  // A longer name that ends the same way is not the key.
  expect(named({ name: 'Uses DATA_URL' })).toEqual(['A_URL', 'B_HOST'])
  // A part inside the project does not place a key.
  expect(envLeads('A_URL=1', mapOf([part('a_url', ['a/**'])]))).toEqual(['A_URL'])
})

test('only keys are kept: no value, no comment and no odd name reaches the result', () => {
  const out = JSON.stringify(envLeads(ENV, SHOP))
  for (const secret of ['hunter2', 'postgres', 'stripe.example', 'the cache', 'BAD KEY', 'lower_url']) expect(out).not.toContain(secret)
  expect(envLeads('', SHOP)).toEqual([])
  expect(envLeads('A_URL=1\r\nB_URL=2\r\n', SHOP)).toEqual(['A_URL', 'B_URL'])
})

test('at most twenty keys are kept', () => {
  expect(envLeads(Array.from({ length: 30 }, (_, k) => `K${k}_URL=1`).join('\n'), SHOP)).toHaveLength(20)
})

// ---- in a session ----

const SYSTEM = `${ROOT}/.sentinel/system.json`
const DRAWN = JSON.stringify({ version: 1, name: 'Shop', actors: [], lines: [], parts: SHOP.parts })
async function opened($: any, on: any, eng: ReturnType<typeof engine>, files: Record<string, string> = {}) {
  const clock = mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  for (const [name, body] of Object.entries(files)) eng.files[`${ROOT}/${name}`] = body
  eng.files[SYSTEM] = DRAWN
  eng.setHistory({ since: { aaa1111: [] } })
  await openPage($, clock)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'mcp__sentinel__plan', action: 'status' })
  await until(clock, () => eng.snap().system?.drift)
  await clock.advance(20)
}

test('a project with a partial map shows its other folders and its leads on the System screens', async ($: any, on: any) => {
  const eng = engine(on)
  await opened($, on, eng, { 'billing/a.ts': 'x', 'billing/b.ts': 'x', 'docs/x.md': 'x', '.env.example': ENV })
  const sys = eng.snap().system
  expect(sys.unmapped).toEqual({ rows: [{ path: 'billing', files: 2 }, { path: 'docs', files: 1 }], more: 0 })
  expect(sys.leads).toEqual({ keys: ['STRIPE_API_URL', 'BANK_HOST', 'DATABASE_URL', 'EMAIL_ENDPOINT', 'REDIS_HOST'], more: 0 })
  expect(JSON.stringify(sys)).not.toContain('hunter2')
})

test('a fully mapped project with no .env.example lists neither', async ($: any, on: any) => {
  const eng = engine(on)
  await opened($, on, eng, { 'src/refund.ts': 'x' })
  expect(eng.snap().system.unmapped).toBeUndefined()
  expect(eng.snap().system.leads).toBeUndefined()
})

test('with no git repo no folders are listed, and the leads still are', async ($: any, on: any) => {
  const eng = engine(on)
  eng.setHead(undefined)
  await opened($, on, eng, { 'billing/a.ts': 'x', '.env.example': 'A_URL=1' })
  expect(eng.snap().system.unmapped).toBeUndefined()
  expect(eng.snap().system.leads).toEqual({ keys: ['A_URL'], more: 0 })
})

test('the lists are cut at twelve folders and eight keys, and say how many they left out', () => {
  const unmapped = Array.from({ length: 15 }, (_, k) => ({ path: `f${k}`, files: 20 - k }))
  const leads = Array.from({ length: 11 }, (_, k) => `K${k}_URL`)
  const sys = summarize(emptyRun(), { map: SHOP, now: {}, unmapped, leads }).system!
  expect(sys.unmapped!.rows).toHaveLength(12)
  expect(sys.unmapped!.more).toBe(3)
  expect(sys.leads).toEqual({ keys: leads.slice(0, 8), more: 3 })
})

// ---- the System tab in the terminal ----

const EL = { Box: 'Box', Text: 'Text', Button: 'Button' }
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
const paneOf = (l: MapLook, v: View = 'system', r: Run = emptyRun()) => text(renderPane(EL, summarize(r, l), v, { pick: () => {}, browser: () => {} }))

test('the tab lists folders as not mapped yet, and leads as not placed yet, and says what to do with neither', () => {
  const out = paneOf({ map: SHOP, now: {}, unmapped: [{ path: 'billing', files: 14 }, { path: 'docs', files: 1 }], leads: ['STRIPE_API_URL', 'REDIS_HOST'] })
  const rows = out.split('\n')
  expect(rows).toContain('Not mapped yet')
  expect(rows).toContain('  billing/ · 14 files')
  expect(rows).toContain('  docs/ · 1 file')
  expect(rows).toContain('Not placed yet')
  expect(rows).toContain('  STRIPE_API_URL, REDIS_HOST')
  expect(out).toContain('Each plan adds the folders it touches to the map.')
  expect(out).toContain('From .env.example. Nothing is drawn from them until you or Claude name them.')
})

test('the tab says how many folders and keys it left out, and says nothing when there are none', () => {
  const many = Array.from({ length: 15 }, (_, k) => ({ path: `f${k}`, files: 20 - k }))
  const out = paneOf({ map: SHOP, now: {}, unmapped: many, leads: Array.from({ length: 11 }, (_, k) => `K${k}_URL`) })
  expect(out).toContain('  and 3 more folders')
  expect(out).toContain('K7_URL and 3 more')
  const quiet = paneOf({ map: SHOP, now: {} })
  expect(quiet).not.toContain('Not mapped yet')
  expect(quiet).not.toContain('Not placed yet')
})

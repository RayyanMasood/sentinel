// What each part of the map shows, worked out from the map, the run and the saved proofs. Each test names a way it could go wrong.
//   node --test tests/mapstatus.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rollOf, statusOf, tally } from '../hooks/mapstatus.ts'

const part = (id, extra = {}) => ({ id, name: id, ...extra })
const MAP = {
  name: 'Studio bookings',
  actors: [],
  parts: [
    part('server'), part('pay', { parent: 'server', files: ['src/pay/**'] }), part('hold', { parent: 'server', files: ['src/hold.ts'] }),
    part('site'), part('cal', { parent: 'site', files: ['src/cal/**'] }),
    part('redis', { kind: 'outside', evidence: { said: 'we use it' } }),
  ],
  lines: [],
}
const fp = hash => ({ hash, files: 1 })
const state = (id, parts, where, extra = {}) => ({ id, parts, where, ...extra })
const run = (facts) => statusOf({ map: MAP, states: [], ...facts })
const of = (facts, id) => run(facts)[id]

// ---- one part, one state ----

test('a part no state builds, with nothing to prove it, is Not built', () => {
  assert.equal(of({}, 'pay').status, 'planned')
})

test('an existing part no state builds is Already there', () => {
  assert.equal(of({ existing: ['pay'] }, 'pay').status, 'exists')
})

test('an existing part a state has not started is Will change, and a new one is Not built', () => {
  const states = [state('a', ['pay', 'hold'], 'ahead')]
  assert.equal(of({ states, existing: ['pay'] }, 'pay').status, 'change')
  assert.equal(of({ states, existing: ['pay'] }, 'hold').status, 'planned')
})

test('the part Claude is working on shows Claude is here', () => {
  assert.equal(of({ states: [state('a', ['pay'], 'active')] }, 'pay').status, 'now')
})

test('a done state whose check passed and whose files changed is Tested', () => {
  const f = { states: [state('a', ['pay'], 'done')], marks: { pay: { base: 'h0', hash: 'h1', check: 'npm test', weight: 'standard', at: '09:10' } }, now: { pay: fp('h1') } }
  const p = of(f, 'pay')
  assert.equal(p.status, 'tested')
  assert.deepEqual(p.proof, { check: 'npm test', weight: 'standard', at: '09:10' })
})

test('an edit after the proof makes the part Changed since test', () => {
  const f = { states: [state('a', ['pay'], 'done')], marks: { pay: { base: 'h0', hash: 'h1', check: 'npm test' } }, now: { pay: fp('h2') } }
  assert.equal(of(f, 'pay').status, 'changed')
  assert.equal(of(f, 'pay').proof.check, 'npm test')
})

test('a done state with no check leaves a part it changed Untested', () => {
  const f = { states: [state('a', ['pay'], 'done', { hasCheck: false })], marks: { pay: { base: 'h0' } }, now: { pay: fp('h1') } }
  assert.equal(of(f, 'pay').status, 'untested')
})

test('a part proved in an earlier plan and left alone by this state stays Tested while its files match', () => {
  const states = [state('a', ['pay'], 'done')]
  const marks = { pay: { base: 'h1', hash: 'h1', from: 'h0' } }
  assert.equal(of({ states, marks, now: { pay: fp('h1') }, existing: ['pay'] }, 'pay').status, 'tested')
  assert.equal(of({ states, marks, now: { pay: fp('h2') }, existing: ['pay'] }, 'pay').status, 'changed')
})

test('a proof saved for another state does not make a part Tested when this state has no check', () => {
  const f = { states: [state('a', ['pay'], 'done', { hasCheck: false })], marks: { pay: { base: 'h0', hash: 'h1' } }, now: { pay: fp('h1') } }
  assert.equal(of(f, 'pay').status, 'untested')
})

test('a done state that never touched its part leaves the part as it was', () => {
  const states = [state('a', ['pay', 'hold'], 'done')]
  const marks = { pay: { base: 'h0', hash: 'h0', check: 'npm test' }, hold: { base: 'k0' } }
  const now = { pay: fp('h0'), hold: fp('k0') }
  assert.equal(of({ states, marks, now }, 'pay').status, 'planned')
  assert.equal(of({ states, marks, now }, 'pay').proof, undefined)
  assert.equal(of({ states, marks, now, existing: ['hold'] }, 'hold').status, 'exists')
})

test('a run saved before baselines counts a part with files as touched', () => {
  const f = { states: [state('a', ['pay'], 'done', { hasCheck: false })], now: { pay: fp('h1') } }
  assert.equal(of(f, 'pay').status, 'untested')
})

test('an existing part with a saved proof is Tested while its files match and Changed since test when they do not', () => {
  const marks = { pay: { hash: 'h1' } }
  assert.equal(of({ existing: ['pay'], marks, now: { pay: fp('h1') } }, 'pay').status, 'tested')
  assert.equal(of({ existing: ['pay'], marks, now: { pay: fp('h9') } }, 'pay').status, 'changed')
})

test('with no git the saved proof stands and the part says changes cannot be detected', () => {
  const p = of({ existing: ['pay'], marks: { pay: { hash: 'h1' } }, now: { pay: { none: 'no git' } } }, 'pay')
  assert.equal(p.status, 'tested')
  assert.ok(p.tags.includes('no-git'))
})

// ---- the run's own states ----

test('a skipped state leaves its part dashed and tagged Skipped', () => {
  const p = of({ states: [state('a', ['pay'], 'ahead', { skipped: true })] }, 'pay')
  assert.equal(p.status, 'planned')
  assert.ok(p.tags.includes('skipped'))
})

test('a skipped state on an existing part leaves it Already there', () => {
  assert.equal(of({ states: [state('a', ['pay'], 'ahead', { skipped: true })], existing: ['pay'] }, 'pay').status, 'exists')
})

test('a blocked state shows Needs you with what Claude needs', () => {
  const p = of({ states: [state('a', ['pay'], 'active', { blocked: 'the staging key' })] }, 'pay')
  assert.equal(p.status, 'needs')
  assert.equal(p.note, 'the staging key')
})

test('a failing check shows Check failing, ahead of Claude is here', () => {
  assert.equal(of({ states: [state('a', ['pay'], 'active', { failing: true })] }, 'pay').status, 'failing')
})

test('a state the final checks reopened shows Check failing, tagged and with the reason', () => {
  const p = of({ states: [state('a', ['pay'], 'active', { reopened: 'expected 11, found 12' })] }, 'pay')
  assert.equal(p.status, 'failing')
  assert.ok(p.tags.includes('reopened'))
  assert.equal(p.note, 'expected 11, found 12')
})

test('a final check stopped because another failed changes nothing', () => {
  const marks = { pay: { base: 'h0', hash: 'h1' } }
  const now = { pay: fp('h1') }
  const plain = of({ states: [state('a', ['pay'], 'done')], marks, now }, 'pay')
  const stopped = of({ states: [state('a', ['pay'], 'done', { stopped: true })], marks, now }, 'pay')
  assert.deepEqual(stopped, plain)
})

test('a once state is Tested and says it was checked once', () => {
  const p = of({ states: [state('a', ['pay'], 'done', { once: true })], marks: { pay: { base: 'h0', hash: 'h1', once: true } }, now: { pay: fp('h1') } }, 'pay')
  assert.equal(p.status, 'tested')
  assert.ok(p.tags.includes('once'))
})

test('closing with finish tags what was not finished and what was not rechecked', () => {
  const states = [state('a', ['pay'], 'done'), state('b', ['hold'], 'ahead'), state('c', ['cal'], 'done')]
  const marks = { pay: { base: 'h0', hash: 'h1' }, cal: { base: 'c0', hash: 'c1' } }
  const now = { pay: fp('h1'), cal: fp('c1') }
  const f = { states, marks, now, closed: { ran: ['c'] } }
  assert.ok(of(f, 'hold').tags.includes('not-finished'))
  assert.equal(of(f, 'hold').status, 'planned')
  assert.ok(of(f, 'pay').tags.includes('not-rechecked'))
  assert.ok(!of(f, 'cal').tags.includes('not-rechecked'))
  assert.ok(!of({ ...f, closed: undefined }, 'pay').tags.includes('not-rechecked'))
})

test('a state with no check is never tagged as not rechecked', () => {
  const f = { states: [state('a', ['pay'], 'done', { hasCheck: false })], closed: { ran: [] } }
  assert.ok(!of(f, 'pay').tags.includes('not-rechecked'))
})

test('a failing check shows ahead of a part that needs you', () => {
  const states = [state('a', ['pay'], 'active', { blocked: 'a key' }), state('b', ['pay'], 'active', { failing: true })]
  assert.equal(of({ states }, 'pay').status, 'failing')
})

test('a part built by two states follows the one at work, and a failure beats it', () => {
  const states = [state('a', ['pay'], 'done'), state('b', ['pay'], 'active')]
  assert.equal(of({ states, marks: { pay: { base: 'h0', hash: 'h1' } }, now: { pay: fp('h1') } }, 'pay').status, 'now')
  assert.equal(of({ states: [state('a', ['pay'], 'done', { reopened: 'x' }), state('b', ['pay'], 'active')] }, 'pay').status, 'failing')
})

// ---- the other kinds of part and mark ----

test('parts that share a file change together and say so', () => {
  const map = { ...MAP, parts: [part('r1', { files: ['docs/report.md'] }), part('r2', { files: ['docs/report.md'] }), part('r3', { files: ['docs/other.md'] })] }
  const marks = { r1: { hash: 'a' }, r2: { hash: 'a' }, r3: { hash: 'b' } }
  const now = { r1: fp('z'), r2: fp('z'), r3: fp('b') }
  const out = statusOf({ map, states: [], existing: ['r1', 'r2', 'r3'], marks, now })
  assert.equal(out.r1.status, 'changed')
  assert.equal(out.r2.status, 'changed')
  assert.equal(out.r3.status, 'tested')
  assert.ok(out.r1.tags.includes('shares-file') && out.r2.tags.includes('shares-file'))
  assert.ok(!out.r3.tags.includes('shares-file'))
})

test('a folder shared with a file inside it counts as shared', () => {
  const map = { ...MAP, parts: [part('a', { files: ['src/pay'] }), part('b', { files: ['src/pay/card.ts'] })] }
  const out = statusOf({ map, states: [] })
  assert.ok(out.a.tags.includes('shares-file') && out.b.tags.includes('shares-file'))
  assert.deepEqual(out.a.shares, ['b'])
  assert.deepEqual(out.b.shares, ['a'])
})

test('a glob, a trailing slash and a bare file all meet the folder they sit in', () => {
  const sharedWith = (a, b) => statusOf({ map: { ...MAP, parts: [part('a', { files: [a] }), part('b', { files: [b] })] }, states: [] }).a.tags.includes('shares-file')
  assert.ok(sharedWith('src/pay/**', 'src/pay/card.ts'))
  assert.ok(sharedWith('src/pay/', 'src/pay/card.ts'))
  assert.ok(sharedWith('docs/*.md', 'docs/report.md'))
  assert.ok(sharedWith('**/*.test.ts', 'src/a.ts'), 'a glob with no folder in front may meet anything')
})

test('folders that sit side by side do not share', () => {
  const map = { ...MAP, parts: [part('a', { files: ['src/pay/**'] }), part('b', { files: ['src/payments/**'] }), part('c', { files: ['src/hold.ts'] })] }
  const out = statusOf({ map, states: [] })
  for (const id of ['a', 'b', 'c']) assert.ok(!out[id].tags.includes('shares-file'), id)
})

test('a done state that names a part with no files leaves it Untested and says why', () => {
  const map = { ...MAP, parts: [part('plan')] }
  const p = statusOf({ map, states: [state('a', ['plan'], 'done')] }).plan
  assert.equal(p.status, 'untested')
  assert.ok(p.tags.includes('no-files'))
})

test('an outside part has no status of its own and says what its evidence is', () => {
  const p = of({}, 'redis')
  assert.equal(p.status, 'outside')
  assert.equal(p.evidence, 'said')
})

test('an outside part reports each kind of evidence as itself', () => {
  const map = { ...MAP, parts: [
    part('a', { kind: 'outside', evidence: { seen: [{ file: '.env.example', text: 'REDIS_URL' }] } }),
    part('b', { kind: 'outside', evidence: { said: 'you told me' } }),
    part('c', { kind: 'outside', evidence: { guess: 'a hunch' } }),
  ] }
  const out = statusOf({ map, states: [state('s', ['a', 'b', 'c'], 'active')] })
  assert.deepEqual([out.a.evidence, out.b.evidence, out.c.evidence], ['seen', 'said', 'guess'])
  assert.deepEqual([out.a.status, out.b.status, out.c.status], ['outside', 'outside', 'outside'])
})

test('a dropped part is Dropped', () => {
  assert.equal(of({ dropped: ['pay'], states: [state('a', ['pay'], 'active')] }, 'pay').status, 'dropped')
})

test('drift marks sit beside the status and leave it alone', () => {
  const base = { existing: ['pay'], marks: { pay: { hash: 'h1' } }, now: { pay: fp('h1') } }
  const p = of({ ...base, drift: { pay: 'changed' } }, 'pay')
  assert.equal(p.status, 'tested')
  assert.ok(p.tags.includes('changed-since-drawn'))
  assert.ok(of({ ...base, drift: { pay: 'gone' } }, 'pay').tags.includes('files-gone'))
  assert.ok(!of(base, 'pay').tags.includes('changed-since-drawn'))
})

// ---- groups ----

const groupOf = (statuses, id = 'server') => rollOf(MAP, Object.fromEntries(Object.entries(statuses).map(([k, s]) => [k, { status: s, tags: [] }])), id)
const tone = (a, b) => groupOf({ pay: a, hold: b }).tone

test('a failing part makes its group red, whatever else is there', () => {
  assert.equal(tone('failing', 'now'), 'red')
  assert.equal(tone('failing', 'tested'), 'red')
  assert.equal(tone('failing', 'needs'), 'red')
})

test('a part that needs you makes its group amber, ahead of Claude is here', () => {
  assert.equal(tone('needs', 'now'), 'amber')
})

test('Claude being inside makes the group blue, ahead of the rest', () => {
  assert.equal(tone('now', 'planned'), 'blue')
})

test('all Not built is dashed, all Already there is plain, all Tested is green', () => {
  assert.equal(tone('planned', 'planned'), 'dashed')
  assert.equal(tone('exists', 'exists'), 'plain')
  assert.equal(tone('tested', 'tested'), 'green')
})

test('one Tested part and one Not built part leave the group neutral', () => {
  assert.equal(tone('tested', 'planned'), 'neutral')
  assert.equal(tone('untested', 'tested'), 'neutral')
  assert.equal(tone('exists', 'tested'), 'neutral')
  assert.equal(tone('exists', 'planned'), 'neutral')
})

test('a group counts its own parts and not the parts of the groups beside it', () => {
  const statuses = { pay: { status: 'failing', tags: [] }, hold: { status: 'tested', tags: [] }, cal: { status: 'tested', tags: [] } }
  const site = rollOf(MAP, statuses, 'site')
  assert.equal(site.total, 1)
  assert.equal(site.tone, 'green')
  const server = rollOf(MAP, statuses, 'server')
  assert.equal(server.total, 2)
  assert.equal(server.tone, 'red')
})

test('five Not built and one Tested is neutral, with the counts on the summary', () => {
  const map = { ...MAP, parts: [part('g'), ...Array.from({ length: 6 }, (_, i) => part(`p${i}`, { parent: 'g', files: [`f${i}`] }))] }
  const statuses = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, { status: i === 0 ? 'tested' : 'planned', tags: [] }]))
  const r = rollOf(map, statuses, 'g')
  assert.equal(r.tone, 'neutral')
  assert.equal(r.counts.planned, 5)
  assert.equal(r.counts.tested, 1)
  assert.equal(r.total, 6)
})

test('outside and dropped parts are left out of a group', () => {
  const map = { ...MAP, parts: [part('g'), part('a', { parent: 'g', files: ['a'] }), part('o', { parent: 'g', kind: 'outside', evidence: { said: 'x' } }), part('d', { parent: 'g', files: ['d'] })] }
  const statuses = { a: { status: 'tested', tags: [] }, o: { status: 'outside', tags: [] }, d: { status: 'dropped', tags: [] } }
  const r = rollOf(map, statuses, 'g')
  assert.equal(r.total, 1)
  assert.equal(r.tone, 'green')
})

test('a group with nothing to count is neutral', () => {
  const map = { ...MAP, parts: [part('g'), part('o', { parent: 'g', kind: 'outside', evidence: { said: 'x' } })] }
  const r = rollOf(map, { o: { status: 'outside', tags: [] } }, 'g')
  assert.equal(r.total, 0)
  assert.equal(r.tone, 'neutral')
})

test('groups inside groups count every part below them', () => {
  const map = { ...MAP, parts: [part('top'), part('mid', { parent: 'top' }), part('x', { parent: 'mid', files: ['x'] }), part('y', { parent: 'top', files: ['y'] })] }
  const r = rollOf(map, { x: { status: 'tested', tags: [] }, y: { status: 'failing', tags: [] } }, 'top')
  assert.equal(r.total, 2)
  assert.equal(r.tone, 'red')
})

// ---- the tally ----

test('the tally counts built parts and leaves outside and dropped ones out', () => {
  const t = tally(MAP, { pay: { status: 'tested', tags: [] }, hold: { status: 'changed', tags: [] }, cal: { status: 'planned', tags: [] }, redis: { status: 'outside', tags: [] } })
  assert.equal(t.total, 3)
  assert.equal(t.tested, 1)
  assert.equal(t.changed, 1)
  assert.equal(t.planned, 1)
  assert.equal(t.built, 2)
  assert.equal(t.untestedOrChanged, 1)
})

test('built is what a state changed, and untestedOrChanged is the part of it with no proof that holds', () => {
  const map = { ...MAP, parts: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => part(id, { files: [id] })) }
  const names = ['tested', 'changed', 'untested', 'planned', 'exists', 'failing', 'dropped']
  const t = tally(map, Object.fromEntries(names.map((s, i) => ['abcdefg'[i], { status: s, tags: [] }])))
  assert.equal(t.total, 6)
  assert.equal(t.built, 3)
  assert.equal(t.untestedOrChanged, 2)
})

test('the tally over a whole run counts parts with nothing inside them and not the groups around them', () => {
  const states = [state('a', ['pay'], 'done'), state('b', ['hold'], 'active')]
  const marks = { pay: { base: 'h0', hash: 'h1' } }
  const t = tally(MAP, statusOf({ map: MAP, states, marks, now: { pay: fp('h1') }, existing: ['cal'] }))
  assert.equal(t.total, 3)
  assert.equal(t.tested, 1)
  assert.equal(t.now, 1)
  assert.equal(t.exists, 1)
})

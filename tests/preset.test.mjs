// A preset: its file for Export and Import, and a project's settings moved into it. Each test names a way it could go wrong.
//   node --test tests/preset.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { moveInto, presetFrom, presetName, presetOf, withSwap } from '../hooks/preset.ts'

const ins = (name, at = 'always') => ({ name, at, text: `say ${name}` })
const flow = name => ({ name, states: [{ id: 'a', label: 'do it' }] })
const BUILTINS = ['fast-checks', 'fails-first', 'state-settings']

test('a name is slugged, and the reserved sub-commands, empty names and long names are refused', () => {
  assert.equal(presetName('Game dev'), 'game-dev')
  assert.equal(presetName('  --a__b!!c--  '), 'a-b-c')
  for (const n of ['new', 'Move', 'delete', 'NONE']) assert.equal(presetName(n), undefined)
  assert.equal(presetName('new-2'), 'new-2')
  assert.equal(presetName('!!!'), undefined)
  assert.equal(presetName(''), undefined)
  assert.equal(presetName('a'.repeat(40)), 'a'.repeat(40))
  assert.equal(presetName('a'.repeat(41)), undefined)
})

test('a file that is not an object is refused', () => {
  for (const bad of [null, 'x', 3, [], undefined]) assert.equal(typeof presetOf(bad, 'p'), 'string')
})

test('a key outside the allowed five is refused by name, and name itself is ignored', () => {
  for (const k of ['command', 'env', 'url', 'args']) {
    const r = presetOf({ [k]: 'x' }, 'p')
    assert.equal(typeof r, 'string')
    assert.ok(r.includes(k), r)
  }
  assert.deepEqual(presetOf({ name: 'other', weight: 'light' }, 'p'), { name: 'p', weight: 'light' })
})

test('a bad weight is refused and a good one kept', () => {
  assert.equal(typeof presetOf({ weight: 'heavy' }, 'p'), 'string')
  assert.equal(typeof presetOf({ weight: 3 }, 'p'), 'string')
  assert.equal(presetOf({ weight: 'thorough' }, 'p').weight, 'thorough')
})

test('on takes booleans under well-formed names only', () => {
  assert.deepEqual(presetOf({ on: { 'fast-checks': false, b2: true } }, 'p').on, { 'fast-checks': false, b2: true })
  assert.equal(typeof presetOf({ on: { x: 'yes' } }, 'p'), 'string')
  assert.equal(typeof presetOf({ on: { 'Bad Name': true } }, 'p'), 'string')
  assert.equal(typeof presetOf({ on: [true] }, 'p'), 'string')
  assert.equal(typeof presetOf({ on: 'x' }, 'p'), 'string')
})

test('instructions and flows must be arrays, and the first bad one is refused with its own error', () => {
  assert.equal(typeof presetOf({ instructions: {} }, 'p'), 'string')
  assert.equal(typeof presetOf({ flows: 'x' }, 'p'), 'string')
  const bad = presetOf({ instructions: [ins('ok'), { name: 'Bad Name', at: 'always', text: 't' }, { name: 'worse' }] }, 'p')
  assert.match(bad, /Bad Name/)
  assert.match(presetOf({ flows: [flow('ok'), { name: 'nostates' }] }, 'p'), /nostates/)
  const good = presetOf({ instructions: [ins('one')], flows: [flow('two')] }, 'p')
  assert.deepEqual(good.instructions, [ins('one')])
  assert.deepEqual(good.flows, [flow('two')])
})

test('a name used twice across instructions and flows is refused, one used once is not', () => {
  assert.match(presetOf({ instructions: [ins('x'), ins('x')] }, 'p'), /x/)
  assert.match(presetOf({ flows: [flow('x'), flow('x')] }, 'p'), /x/)
  assert.match(presetOf({ instructions: [ins('x')], flows: [flow('x')] }, 'p'), /x/)
  assert.equal(typeof presetOf({ instructions: [ins('x')], flows: [flow('y')] }, 'p'), 'object')
})

test('mcps are trimmed non-empty strings of at most 100 characters, without case-insensitive repeats', () => {
  assert.deepEqual(presetOf({ mcps: ['  github ', 'Slack'] }, 'p').mcps, ['github', 'Slack'])
  assert.equal(typeof presetOf({ mcps: 'github' }, 'p'), 'string')
  assert.equal(typeof presetOf({ mcps: [3] }, 'p'), 'string')
  assert.equal(typeof presetOf({ mcps: ['  '] }, 'p'), 'string')
  assert.equal(typeof presetOf({ mcps: ['a'.repeat(101)] }, 'p'), 'string')
  assert.equal(typeof presetOf({ mcps: ['a'.repeat(100)] }, 'p'), 'object')
  assert.equal(typeof presetOf({ mcps: ['GitHub', 'github'] }, 'p'), 'string')
})

test('empty parts are dropped from a checked file', () => {
  assert.deepEqual(presetOf({ on: {}, instructions: [], flows: [], mcps: [] }, 'p'), { name: 'p' })
})

test('presetFrom carries only what is present and omits empty parts', () => {
  assert.deepEqual(presetFrom({}, { instructions: [], flows: [] }, 'p'), { name: 'p' })
  assert.deepEqual(presetFrom({ weight: 'light', on: { a: true }, mcps: ['m'] }, { instructions: [ins('i')], flows: [flow('f')] }, 'p'),
    { name: 'p', weight: 'light', on: { a: true }, instructions: [ins('i')], flows: [flow('f')], mcps: ['m'] })
  assert.deepEqual(presetFrom({ on: {}, mcps: [] }, { instructions: [], flows: [] }, 'p'), { name: 'p' })
})

test('a move keeps what the project had above the preset: its weight ends the preset\'s built-in switches, and its switches win', () => {
  const r = moveInto({ weight: 'light', on: { 'fast-checks': false, 'state-settings': true, mine: true } }, { weight: 'thorough', on: { 'fails-first': false, mine: false } }, BUILTINS)
  assert.deepEqual(r, { weight: 'thorough', on: { 'state-settings': true, mine: false, 'fails-first': false } })
})

test('a project with no weight leaves the preset\'s weight and its built-in switches', () => {
  assert.deepEqual(moveInto({ weight: 'light', on: { 'fast-checks': false, a: true } }, { on: { a: false } }, BUILTINS), { weight: 'light', on: { 'fast-checks': false, a: false } })
  assert.deepEqual(moveInto({}, {}, BUILTINS), {})
})

test('a move adds the project\'s MCPs to the preset\'s once, in the preset\'s spelling', () => {
  assert.deepEqual(moveInto({ mcps: ['Unity'] }, { weight: 'light', mcps: ['unity', 'Notion'] }, BUILTINS).mcps, ['Unity', 'Notion'])
  assert.deepEqual(moveInto({}, { mcps: ['Notion'] }, BUILTINS), { mcps: ['Notion'] })
})

test('an import\'s MCPs follow the swap: another name, left out, or kept, with no repeats', () => {
  assert.deepEqual(withSwap(['Unity', 'Notion', 'x'], { Unity: 'unity-editor', Notion: null }), ['unity-editor', 'x'])
  assert.deepEqual(withSwap(['a', 'b'], { b: 'A' }), ['a'])
  assert.deepEqual(withSwap(['a']), ['a'])
})

test('a move never changes what it is given', () => {
  const preset = { weight: 'light', on: { 'fast-checks': false }, mcps: ['m'] }, project = { weight: 'thorough', on: { z: true }, mcps: ['n'] }
  const before = JSON.stringify([preset, project])
  moveInto(preset, project, BUILTINS)
  assert.equal(JSON.stringify([preset, project]), before)
})

// A preset: a project's Library setup in one file, and what using it changes. Each test names a way it could go wrong.
//   node --test tests/preset.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPreset, presetFrom, presetName, presetOf } from '../hooks/preset.ts'

const ins = (name, at = 'always') => ({ name, at, text: `say ${name}` })
const flow = name => ({ name, states: [{ id: 'a', label: 'do it' }] })
const BUILTINS = ['fast-checks', 'fails-first', 'state-settings']
const o = (more = {}) => ({ builtins: BUILTINS, taken: [], ...more })

test('a name is slugged, and the reserved sub-commands, empty names and long names are refused', () => {
  assert.equal(presetName('Game dev'), 'game-dev')
  assert.equal(presetName('  --a__b!!c--  '), 'a-b-c')
  assert.equal(presetName('save'), undefined)
  assert.equal(presetName('Undo'), undefined)
  assert.equal(presetName('delete'), undefined)
  assert.equal(presetName('save-2'), 'save-2')
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

test('a different weight resets hand-flipped built-ins but keeps state-settings and the project\'s own items', () => {
  const r = applyPreset({ weight: 'light', on: { 'fast-checks': false, 'state-settings': true, mine: false }, preset: 'old', mcps: ['m'] }, { name: 'p', weight: 'thorough' }, o())
  assert.equal(r.weightReset, true)
  assert.equal(r.switches.weight, 'thorough')
  assert.deepEqual(r.switches.on, { 'state-settings': true, mine: false })
  assert.deepEqual(r.switches.mcps, ['m'])
  assert.equal(r.switches.preset, 'p')
})

test('the same weight, or none named, leaves the project\'s switches alone', () => {
  const proj = { weight: 'light', on: { 'fast-checks': false } }
  for (const p of [{ name: 'p', weight: 'light' }, { name: 'p' }]) {
    const r = applyPreset(proj, p, o())
    assert.equal(r.weightReset, false)
    assert.equal(r.switches.weight, 'light')
    assert.deepEqual(r.switches.on, { 'fast-checks': false })
  }
  assert.equal(applyPreset({}, { name: 'p', weight: 'light' }, o()).weightReset, true)
})

test('a project with no weight and no preset weight keeps none', () => {
  assert.equal('weight' in applyPreset({}, { name: 'p' }, o()).switches, false)
})

test('the preset\'s on goes over the project\'s, and on is left out when empty', () => {
  const r = applyPreset({ on: { a: true, b: true } }, { name: 'p', on: { b: false, c: true } }, o())
  assert.deepEqual(r.switches.on, { a: true, b: false, c: true })
  assert.equal('on' in applyPreset({}, { name: 'p' }, o()).switches, false)
  assert.equal('on' in applyPreset({ weight: 'light', on: { 'fast-checks': true } }, { name: 'p', weight: 'thorough' }, o()).switches, false)
})

test('items whose name is free are added, and taken ones are kept as the project has them', () => {
  const p = { name: 'p', instructions: [ins('free-i'), ins('own-i')], flows: [flow('free-f'), flow('own-f')] }
  const r = applyPreset({}, p, o({ taken: ['own-i', 'own-f'] }))
  assert.deepEqual(r.add.instructions.map(x => x.name), ['free-i'])
  assert.deepEqual(r.add.flows.map(x => x.name), ['free-f'])
  assert.deepEqual(r.kept.sort(), ['own-f', 'own-i'])
  assert.deepEqual(applyPreset({}, { name: 'p' }, o()).add, { instructions: [], flows: [] })
})

test('mcps keep the project\'s list and spelling, add the preset\'s without repeats, and follow the swap', () => {
  const r = applyPreset({ mcps: ['GitHub'] }, { name: 'p', mcps: ['github', 'slack', 'old', 'gone'] }, o({ swap: { old: 'new', gone: null } }))
  assert.deepEqual(r.switches.mcps, ['GitHub', 'slack', 'new'])
  const r2 = applyPreset({ mcps: ['a'] }, { name: 'p', mcps: ['x'] }, o({ swap: { x: 'A' } }))
  assert.deepEqual(r2.switches.mcps, ['a'])
  assert.equal('mcps' in applyPreset({}, { name: 'p', mcps: ['gone'] }, o({ swap: { gone: null } })).switches, false)
  assert.equal('mcps' in applyPreset({}, { name: 'p' }, o()).switches, false)
})

test('inputs are never mutated', () => {
  const proj = { weight: 'light', on: { 'fast-checks': false }, mcps: ['m'] }
  const p = { name: 'p', weight: 'thorough', on: { z: true }, mcps: ['n'], instructions: [ins('i')] }
  const swap = { n: 'q' }
  const before = JSON.stringify([proj, p, swap])
  applyPreset(proj, p, o({ swap }))
  assert.equal(JSON.stringify([proj, p, swap]), before)
})

test('the project\'s own on is not mutated when the weight stays', () => {
  const proj = { weight: 'light', on: { a: true } }
  applyPreset(proj, { name: 'p', weight: 'light', on: { b: false } }, o())
  assert.deepEqual(proj, { weight: 'light', on: { a: true } })
})

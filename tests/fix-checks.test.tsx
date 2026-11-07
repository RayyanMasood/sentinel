// Claude is told to keep each state's check small at draft time, under every weight, so it hears it before it fixes the
// checks. Told as a state starts, and only under Light, every state of a Standard plan got the whole suite as its check.
//
// How it can fail, and where each is tested below:
//  1. The built-in is told at "start" (or later) instead of "draft", so the checks are already fixed when Claude hears it.
//  2. It is on for Light only, or for two weights of three, so a Standard or Thorough plan never hears it.
//  3. Its kind is "checks", which Sentinel never tells Claude.
//  4. The text no longer says to run the whole suite once, in the last state, so the full run has no home.
//  5. The weights list it, but a weight does not switch it on (libraryOn).
import { expect } from 'claude-code/testing'
import { libraryOn } from '../hooks/core'
import { BUILTINS, WEIGHTS } from '../hooks/builtins'
import { test } from './kit'

const fast = () => BUILTINS.find(b => b.name === 'fast-checks')!

test('fast-checks: told at draft time, as text Claude reads (1, 3)', () => {
  expect(fast()).toBeDefined()
  expect(fast().at).toBe('draft')
  expect(fast().kind).toBe('told')
})

test('fast-checks: on for every weight (2, 5)', () => {
  expect(fast().weights).toEqual(expect.arrayContaining(['light', 'standard', 'thorough']))
  const items = BUILTINS.map(b => ({ name: b.name, weights: b.weights }))
  for (const weight of WEIGHTS) expect(libraryOn(items, { weight }).on).toContain('fast-checks')
})

test('fast-checks: the text keeps the whole suite for the last state (4)', () => {
  const text = fast().text
  expect(text).toMatch(/fastest check/i)
  expect(text).toMatch(/whole suite once/i)
  expect(text).toMatch(/last state/i)
})

// The price of one response and the estimate for a workflow. Each test names a way it could go wrong.
//   node --test tests/workflow-price.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { costOf, estimate, family, perAgent } from '../hooks/usage.ts'

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`)
// 1M of each kind of token makes the arithmetic readable: the cost is the sum of the table's rates.
const million = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }

test('opus-5-5 is priced as the older opus-5 when the shorter id is matched first', () => {
  near(costOf(million, 'claude-opus-5-5'), 4 + 20 + 0.2 + 5)
  near(costOf(million, 'claude-opus-5'), 5 + 25 + 0.5 + 6.25)
})

test('sonnet-5-5 and haiku-5-5 are priced as their older versions', () => {
  near(costOf(million, 'claude-sonnet-5-5'), 2 + 10 + 0.1 + 2.5)
  near(costOf(million, 'claude-sonnet-5'), 2 + 10 + 0.2 + 2.5)
  near(costOf(million, 'claude-haiku-5-5'), 0.1 + 0.5 + 0.01 + 0.125)
  near(costOf(million, 'claude-haiku-4-5'), 1 + 5 + 0.1 + 1.25)
})

test('a suffix or a date after the id stops the match', () => {
  near(costOf(million, 'claude-opus-5-5[1m]'), 4 + 20 + 0.2 + 5)
  near(costOf(million, 'claude-haiku-4-5-20251001'), 1 + 5 + 0.1 + 1.25)
})

test('fable and mythos are priced alike, and a cache write is 1.25 x input rather than free', () => {
  near(costOf(million, 'claude-fable-5-2'), 8 + 40 + 0.2 + 10)
  near(costOf(million, 'mythos'), 8 + 40 + 0.2 + 10)
  near(costOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1e6 }, 'claude-sonnet-5-5'), 2.5)
})

test('one real-sized response adds up each kind of token at its own rate', () => {
  const u = { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 56000, cache_creation_input_tokens: 7800 }
  near(costOf(u, 'claude-opus-5-5'), (1200 * 4 + 3400 * 20 + 56000 * 0.2 + 7800 * 5) / 1e6)
})

test('an unknown model has no price, and is not free', () => {
  assert.equal(costOf(million, 'gpt-9'), undefined)
  assert.equal(costOf(million, ''), undefined)
  assert.equal(costOf(million, undefined), undefined)
})

test('family names the aliases, the full ids and mythos, and says nothing for the unknown', () => {
  for (const [id, want] of [['haiku', 'haiku'], ['sonnet', 'sonnet'], ['opus', 'opus'], ['fable', 'fable'], ['claude-opus-5-5[1m]', 'opus'],
    ['claude-haiku-4-5-20251001', 'haiku'], ['claude-sonnet-5', 'sonnet'], ['claude-fable-5-2', 'fable'], ['mythos', 'fable']]) assert.equal(family(id), want, id)
  assert.equal(family('gpt-9'), undefined)
  assert.equal(family(undefined), undefined)
})

test('perAgent takes an alias or a full id and gives the measured typical and 90th percentile', () => {
  assert.deepEqual(perAgent('opus'), { typical: 2.3, p90: 4.35 })
  assert.deepEqual(perAgent('claude-sonnet-5-5'), { typical: 1.6, p90: 3.1 })
  assert.deepEqual(perAgent('haiku'), { typical: 0.05, p90: 0.06 })
  assert.deepEqual(perAgent('mythos'), { typical: 11.5, p90: 18.5 })
  assert.equal(perAgent('gpt-9'), undefined)
})

test('estimate multiplies the agents by the typical and the 90th percentile, and is undefined for an unknown model', () => {
  const e = estimate({ agents: 8, model: 'sonnet' })
  near(e.usd, 12.8)
  near(e.upTo, 24.8)
  assert.equal(estimate({ agents: 8, model: 'gpt-9' }), undefined)
  near(estimate({ agents: 0, model: 'opus' }).usd, 0)
})

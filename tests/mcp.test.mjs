// Matching the MCP servers a project needs to the ones a session has. Each test names a way it could go wrong.
//   node --test tests/mcp.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcpProblem, mcpStates, serverList } from '../hooks/mcp.ts'

// Tool names as $.tool.list() gave them in a real session on 2026-11-08.
const TOOLS = [
  'Read', 'Bash', 'mcp__sentinel__plan',
  'mcp__claude_ai_Notion__notion-search', 'mcp__claude_ai_Notion__notion-fetch',
  'mcp__claude_ai_Google_Drive__search_files',
  'mcp__plugin_playwright_playwright__browser_click',
  'mcp__plugin_product-management_amplitude-eu__authenticate', 'mcp__plugin_product-management_amplitude-eu__complete_authentication',
  'mcp__google-docs__read', 'mcp__unity__play',
]
const state = (name, tools = TOOLS) => mcpStates([name], tools)[0]

test('a name typed the way /mcp shows it matches the name the tools carry', () => {
  assert.deepEqual(state('unity'), { name: 'unity', state: 'connected', server: 'unity' })
  assert.equal(state('Unity').state, 'connected')
  assert.equal(state('Google Docs').server, 'google-docs')
  assert.equal(state('claude.ai Notion').server, 'claude_ai_Notion')
  assert.equal(state('Notion').server, 'claude_ai_Notion')
  assert.equal(state('google drive').server, 'claude_ai_Google_Drive')
})

test("a plugin's server matches by its own name, the plugin's way of writing it, or both names run together", () => {
  assert.equal(state('playwright').server, 'plugin_playwright_playwright')
  assert.equal(state('plugin:playwright:playwright').server, 'plugin_playwright_playwright')
  assert.equal(state('amplitude-eu').server, 'plugin_product-management_amplitude-eu')
})

test('part of a name matches nothing', () => {
  for (const n of ['note', 'claude', 'claude ai', 'plugin', 'google', 'play', 'unit', '', '  ']) assert.equal(state(n).state, 'missing', n)
})

test('a server that only offers sign-in is not ready, and a real one of the same name wins over it', () => {
  assert.equal(state('amplitude-eu').state, 'sign-in')
  const both = [...TOOLS, 'mcp__amplitude-eu__chart']
  assert.deepEqual(state('amplitude-eu', both), { name: 'amplitude-eu', state: 'connected', server: 'amplitude-eu' })
})

test('a server that failed to connect has no tools, so it is missing, and so is everything when no MCP is up', () => {
  assert.deepEqual(state('maestro'), { name: 'maestro', state: 'missing' })
  assert.equal(state('unity', ['Read', 'Bash']).state, 'missing')
  assert.deepEqual(mcpStates([], TOOLS), [])
})

test('the servers a session has, as the page offers them, without sign-in-only ones marked ready', () => {
  const list = serverList(TOOLS)
  assert.deepEqual(list.find(s => s.server === 'claude_ai_Google_Drive'), { server: 'claude_ai_Google_Drive', name: 'Google Drive', signIn: false })
  assert.deepEqual(list.find(s => s.server === 'plugin_playwright_playwright'), { server: 'plugin_playwright_playwright', name: 'playwright', signIn: false })
  assert.equal(list.find(s => s.server === 'plugin_product-management_amplitude-eu').signIn, true)
  assert.equal(list.find(s => s.server === 'unity').name, 'unity')
  assert.ok(!list.some(s => s.server === 'Read' || s.name === ''))
  // Each name the page offers matches its own server again.
  for (const s of list) assert.equal(state(s.name).server, s.server, s.name)
})

test('what the user reads names each server that is missing or waits on sign-in, and nothing when all are up', () => {
  assert.equal(mcpProblem(mcpStates(['unity', 'notion'], TOOLS)), undefined)
  assert.equal(mcpProblem(mcpStates(['Maestro'], TOOLS)), "Maestro isn't connected in this session.")
  assert.equal(mcpProblem(mcpStates(['Maestro', 'Postgres'], TOOLS)), "Maestro and Postgres aren't connected in this session.")
  assert.equal(mcpProblem(mcpStates(['a', 'b', 'c'], TOOLS)), "a, b and c aren't connected in this session.")
  assert.equal(mcpProblem(mcpStates(['Maestro', 'amplitude-eu', 'unity'], TOOLS)), "Maestro isn't connected in this session, and amplitude-eu needs you to sign in.")
})

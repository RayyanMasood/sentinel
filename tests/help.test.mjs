// /sentinel help and the README's Commands table list the same commands. Each test names a way it could go wrong.
//   node --test tests/help.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { COMMANDS, helpText } from '../hooks/core.ts'

const first = s => s.trim().split(/[\s|]/)[0]
const inHelp = new Set(COMMANDS.flatMap(([, rows]) => rows.map(([use]) => first(use))))
// The first word after /sentinel in each row of the README's Commands table, '' for the bare command.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const table = readme.slice(readme.indexOf('## Commands'), readme.indexOf('\n## ', readme.indexOf('## Commands') + 1))
const inReadme = new Set([...table.matchAll(/^\| `\/sentinel([^`]*)`/gm)].map(m => first(m[1])))

test('a command added to the README but not to help, or the other way round, fails here', () => {
  assert.ok(inReadme.size > 15, 'the README table was read')
  assert.deepEqual([...inHelp].filter(c => !inReadme.has(c)), [], 'in help but not the README')
  assert.deepEqual([...inReadme].filter(c => !inHelp.has(c)), [], 'in the README but not help')
})

test('help shows every command with what it does, and no line is cut short', () => {
  const text = helpText()
  for (const [, rows] of COMMANDS) for (const [use, does] of rows) {
    assert.ok(text.includes(`/sentinel${use ? ` ${use}` : ''}`), use)
    assert.ok(text.includes(does), does)
  }
})

// The engine passes the model only the first 4096 characters of a tool's description, so a line past that is never read.
test('the plan tool\'s description fits the 4096 characters the model is given', () => {
  const src = readFileSync(new URL('../hooks/register.tsx', import.meta.url), 'utf8')
  const text = /export const DESCRIPTION = `([\s\S]*?)`\n/.exec(src)?.[1]
  assert.ok(text, 'the description was read')
  assert.ok(!text.includes('${'), 'the description has no interpolation, so its length here is its length')
  assert.ok(text.length <= 4096, `the description is ${text.length} characters`)
})

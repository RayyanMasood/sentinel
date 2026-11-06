// Runs some of the plugin's test files alone, from a temporary copy, so a state's check takes seconds where the whole suite
// takes minutes. The full suite still runs at the end (claude plugin test .).
//   node tests/only.mjs map-history,map-pane      (file names under tests/, without .test.tsx)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const want = (process.argv[2] ?? '').split(',').map(s => s.trim()).filter(Boolean)
const files = readdirSync(join(root, 'tests'))
const find = w => files.find(f => f === `${w}.test.tsx` || f === `${w}.test.ts`)
const missing = want.filter(w => !find(w))
if (!want.length || missing.length) {
  console.error(missing.length ? `No test file named: ${missing.join(', ')}` : 'Name the test files: node tests/only.mjs map-history,map-pane')
  process.exit(2)
}

const dst = mkdtempSync(join(tmpdir(), 'sentinel-only-'))
mkdirSync(join(dst, 'tests'))
for (const d of ['.claude-plugin', 'hooks', 'types', 'web']) cpSync(join(root, d), join(dst, d), { recursive: true })
if (existsSync(join(root, 'tsconfig.json'))) cpSync(join(root, 'tsconfig.json'), join(dst, 'tsconfig.json'))
for (const f of ['kit.tsx', ...want.map(find)]) cpSync(join(root, 'tests', f), join(dst, 'tests', f))

const r = spawnSync('claude', ['plugin', 'test', dst], { encoding: 'utf8', shell: true })
rmSync(dst, { recursive: true, force: true })
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
// The verdict lines, and the failures with what was expected; the rest of the log is long.
console.log(out.split('\n').filter(l => /^\((pass|fail)\)|^ *\d+ (pass|fail)|Ran \d+ tests|Error|Expected|Received/.test(l)).join('\n'))
process.exit(r.status ?? 1)

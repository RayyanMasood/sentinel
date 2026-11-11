// What Sentinel does on each tool call once its run is as big as a long real plan's (400 calls, about 200 KB): reads and writes
// of the run in the host's state, file writes and their bytes, and Library reads with the dashboard up. It measures; it
// sets no budget yet. Run with `node tests/only.mjs memory-writes`; the numbers print on a "Received" line, which
// only.mjs keeps.
//
// The big run is built with core's own functions and resumed from run.json, as driving 400 calls through the hooks takes
// longer than the kit lets the dashboard's helper live.
// What it can't see: the band redrawing on each write (the kit draws no band), and claude.exe's memory.
import { expect, mock } from 'claude-code/testing'
import type { Run } from '../types'
import { act, emptyRun, observe } from '../hooks/core'
import { HOME, ROOT, engine, openPage, test } from './kit'

// 18 states with task-page text, as a long real plan had.
const pad = (s: string, n: number) => `${s} ${'with the detail a real plan carries, '.repeat(n)}`.trim()
const CHECK = 'cd app && npm test -- --runInBand tests/billing tests/refunds tests/ledger && grep -q "### I-5" ISSUES.md && grep -q "### I-6" ISSUES.md'
const STATES = Array.from({ length: 18 }, (_, i) => {
  const id = `s${String(i + 1).padStart(2, '0')}`
  return {
    id, label: pad(`Work item ${id}`, 1), title: `Work item ${id}`, problem: pad('What is wrong', 8), approach: pad('What I will do', 8),
    check: `${CHECK} # ${id}`, files: ['src/**', 'tests/**', `docs/${id}/**`],
  }
})
// A failing run's output, as a test runner prints it.
const FAILED = Array.from({ length: 40 }, (_, i) => `  ● billing › case ${i} › expected 49.99, received 50.00 at tests/billing.test.ts:${i + 10}`).join('\n')
const PASSED = 'Tests: 212 passed'
const fileOf = (i: number) => `src/area${i % 37}/file${i}.ts`

// A run at the ledger's cap, with the plan text kept as the approved source, as quoting keeps it.
function bigRun(): Run {
  const a = act({ ...emptyRun(), signedOff: true }, { action: 'define', title: 'Phase 3 handoff', states: STATES }, '09:00', {}, Date.now())
  if (!a.ok) throw new Error(a.text)
  let r: Run = { ...a.run, sources: [{ kind: 'approved', at: '09:00', text: pad('# Plan\n', 2600) }] }
  for (let i = 0; i < 400; i++) {
    const o = i % 4 === 0 ? { kind: 'look' as const, label: `Read ${fileOf(i)}`, fp: `r${i}` }
      : i % 4 === 1 ? { kind: 'edit' as const, label: `Edit ${fileOf(i)}`, file: fileOf(i), before: `h${i}`, ver: `v${i}` }
      : i % 4 === 2 ? { kind: 'look' as const, label: `Bash grep -rn "symbol${i}" src | head -20`, fp: `g${i}` }
      : { kind: 'check' as const, label: `${CHECK} # s01`, pass: i % 8 !== 3, sig: i % 8 === 3 ? 'f00d' : '', sigText: '', fails: i % 8 === 3 ? 1 : 0, tail: i % 8 === 3 ? FAILED : PASSED }
    r = observe(r, o, '09:00').run
  }
  return r
}

// One tool call of the mix a working session makes: reads, edits, plain commands and the state's own check.
async function call($: any, eng: ReturnType<typeof engine>, i: number) {
  const file = `${ROOT}/${fileOf(i)}`
  switch (i % 4) {
    case 0: return $.tool.call({ tool: 'Read', file_path: file })
    case 1: return $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: `b${i}` })
    case 2: return $.tool.call({ tool: 'Bash', command: `grep -rn "symbol${i}" src | head -20` })
    default:
      eng.setBash(i % 8 === 3 ? { fail: true, text: FAILED } : { fail: false, text: PASSED })
      return $.tool.call({ tool: 'Bash', command: `${CHECK} # s01` })
  }
}

test('per tool call with a full-sized run and the dashboard up: state reads and writes, file writes and bytes, Library reads', async ($: any, on: any) => {
  const eng = engine(on)
  const clock = mock.clock(on)
  const n = { get: 0, set: 0 }
  on('state.get', { plugin: 'sentinel' }, (_: unknown, e: any, next: any) => (e.key === 'run' && n.get++, next(e)))
  on('state.set', { plugin: 'sentinel' }, (_: unknown, e: any, next: any) => (e.key === 'run' && n.set++, next(e)))
  // The project's Library, so the dashboard has files to read, and the big run left by an earlier session.
  eng.files[`${ROOT}/.sentinel/library.json`] = '{"on":{"break-it-once":true}}\n'
  eng.files[`${ROOT}/.sentinel/flows/review.json`] = JSON.stringify({ name: 'review', description: 'Review a change', states: [{ id: 'review', label: 'Review' }] })
  eng.files[`${ROOT}/.sentinel/instructions/tone.json`] = JSON.stringify({ name: 'tone', at: 'always', text: 'Plain words.' })
  eng.files[`${ROOT}/.sentinel/run.json`] = JSON.stringify({ ...bigRun(), savedAt: Date.now() })

  await openPage($, clock)
  expect(String((await $.command.run({ command: 'sentinel', args: 'resume' })).text)).toMatch(/Resumed "Phase 3 handoff"/)
  await clock.settle()
  expect(eng.memory.run?.calls.length).toBe(400)

  // Each call's counts go in `cur`; a call made with the dashboard up adds them to `sum`. The kit owns fs.write, so each of
  // Sentinel's files counts its own writes. They all exist by now.
  type Counts = { get: number; set: number; library: number; writes: Record<string, { count: number; bytes: number }> }
  const zero = (): Counts => ({ get: 0, set: 0, library: 0, writes: {} })
  let cur = zero()
  const sum = zero()
  const before = new Set(Object.keys(eng.files))
  for (const path of [...before].filter(f => f.startsWith(`${ROOT}/.sentinel/`))) {
    let text = eng.files[path]!
    const name = path.slice(`${ROOT}/.sentinel/`.length)
    Object.defineProperty(eng.files, path, {
      enumerable: true, configurable: true, get: () => text,
      set: (v: string) => {
        text = v
        const w = (cur.writes[name] ??= { count: 0, bytes: 0 })
        w.count++
        w.bytes += v.length
      },
    })
  }
  const isLibrary = (p: string) => /\/\.sentinel\/(library\.json|flows\/|instructions\/|presets\/)/.test(p) || p.startsWith(`${HOME}/.sentinel/`)

  // 100 calls with the dashboard up, each settled before the next, as tool calls in a real session come seconds apart.
  // The kit's helper lives 10 s, so when a call shows it gone (no write to its port's file), the page opens again and
  // that call doesn't count.
  const CALLS = 100
  let measured = 0
  let skipped = 0
  for (let i = 400; measured < CALLS && i < 400 + 3 * CALLS; i++) {
    cur = zero()
    n.get = n.set = 0
    const reads = eng.reads.length
    await call($, eng, i)
    await clock.settle()
    if (!cur.writes['state-41234.js']) {
      skipped++
      await openPage($, clock)
      continue
    }
    measured++
    sum.get += n.get
    sum.set += n.set
    sum.library += eng.reads.slice(reads).filter(isLibrary).length
    for (const [f, w] of Object.entries(cur.writes)) {
      const s = (sum.writes[f] ??= { count: 0, bytes: 0 })
      s.count += w.count
      s.bytes += w.bytes
    }
  }

  const fresh = Object.keys(eng.files).filter(f => !before.has(f) && f.startsWith(`${ROOT}/.sentinel/`))
  const runBytes = eng.files[`${ROOT}/.sentinel/run.json`]?.length ?? 0
  const per = (x: number) => +(x / CALLS).toFixed(2)
  const kb = (x: number) => +(x / CALLS / 1024).toFixed(1)
  const files = Object.fromEntries(Object.entries(sum.writes).map(([f, w]) => [f, { perCall: per(w.count), kbPerCall: kb(w.bytes) }]))
  const numbers = {
    runKb: +(runBytes / 1024).toFixed(1), ledger: eng.memory.run?.calls.length, stateReads: per(sum.get), stateWrites: per(sum.set),
    fileKbPerCall: kb(Object.values(sum.writes).reduce((t, w) => t + w.bytes, 0)), files, libraryReads: per(sum.library), newFiles: fresh, skipped,
  }

  // The run is at full size, 100 calls ran with the dashboard up, and they wrote the run's file.
  expect(numbers.ledger).toBe(400)
  expect(runBytes).toBeGreaterThan(150 * 1024)
  expect(measured).toBe(CALLS)
  expect(sum.writes['run.json']?.count).toBeGreaterThan(0)
  // The numbers, on a line only.mjs keeps.
  console.log(`Received per call: ${JSON.stringify(numbers)}`)
})

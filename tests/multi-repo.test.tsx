// Members and snapshots at a project folder that holds git repositories but isn't one, as D:\Work\Shop holds
// shop-api and shop-web. Run with `node tests/only.mjs multi-repo`.
//
// How this can fail, and where each is tested below:
//  1. A brief runs git at the project folder, so every member is refused with "not a git repository" (as a real run found).
//  2. A member's checkout sits where its files' project paths don't lead, so the guard refuses its own edits.
//  3. The work comes back to the project folder in place of its repository, or with names missing the repository folder,
//     so the state's files are not marked as passed.
//  4. A state whose files span repositories, or sit outside any, gets a worktree anyway, or a refusal that doesn't say why.
//  5. The visit's snapshot is taken at the project folder and fails, so the rerun without the change never runs.
//  6. The rerun's copy has no installed packages, or its check runs where a project-relative check can't find its folder.
//  7. A cleanup deletes through the link to the repository's node_modules and empties it.
//  8. The draft gives no warning that some states can't get a member, so the user finds out mid-run.
//  9. A helper subagent of the main conversation writes the tests, and the rerun skips with "no test files changed".
// 10. Two helpers' first edits come together: no snapshot before them, two through one index, or a failed one blanks a good one.
// A plain repository root makes no extra git calls: the pinned brief and rerun tests in sentinel.test.tsx cover it.
import { expect, mock } from 'claude-code/testing'
import { emptyRun, snapTaken, withSnap, type PlanInput } from '../hooks/core'
import { ROOT, TOOL, engine, said, test } from './kit'

const A = `${ROOT}/shop-api`
const B = `${ROOT}/shop-web`
const PLAN: PlanInput = {
  action: 'define', title: 'Phase 3',
  states: [
    { id: 'explore', label: 'Read the code' },
    { id: 'api', label: 'Backend', check: 'cd shop-api && npm test', files: ['shop-api/src/**', 'shop-api/tests/**'], needs: ['explore'] },
    { id: 'ui', label: 'Frontend', check: 'cd shop-web && npm test', files: ['shop-web/src/**'], needs: ['explore'] },
    { id: 'docs', label: 'Docs in both', check: 'npm run docs', files: ['shop-api/docs/**', 'shop-web/docs/**'], needs: ['explore'] },
    { id: 'tools', label: 'Scripts', check: 'node scripts/check.mjs', files: ['scripts/**'], needs: ['explore'] },
    { id: 'verify', label: 'Both suites', check: 'cd shop-api && npm test && cd ../shop-web && npm test', needs: ['api', 'ui', 'docs', 'tools'] },
  ],
}
const PASS = { fail: false, text: '3 passed' }
const FAIL = { fail: true, text: 'Tests: 1 failed' }
const notes = (r: any) => [said(r), ...(r?.context ?? [])].join('\n')
const git = (eng: ReturnType<typeof engine>, ...words: string[]) => eng.runs.filter(x => x.argv[0] === 'git' && words.every((w, k) => x.argv[k + 1] === w))

// The layout: two repositories with their packages installed, under a folder that is neither.
function twoRepos(on: any) {
  const eng = engine(on)
  eng.setRepos([A, B])
  for (const top of [A, B]) {
    eng.files[`${top}/package.json`] = '{}'
    eng.files[`${top}/node_modules/jest/index.js`] = ''
  }
  return eng
}
async function at($: any, on: any, parallel: boolean, plan = PLAN) {
  const eng = twoRepos(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'sentinel', args: `parallel ${parallel ? 'on' : 'off'}` })
  await clock.advance(1)
  await $.tool.call({ tool: 'ExitPlanMode' })
  const defined = await $.tool.call({ tool: TOOL, ...plan })
  await $.tool.call({ tool: 'Read', file_path: `${A}/src/app.ts` })
  const moved = await $.tool.call({ tool: TOOL, action: 'advance', to: 'api', evidence: 'read it' })
  expect(said(moved)).toMatch(/Moved to api/)
  return { eng, clock, defined }
}
const stopMember = async ($: any, clock: any, agentId: string, answer = 'Done.') => {
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId })
  await clock.settle()
}
const runOf = (eng: ReturnType<typeof engine>) => JSON.parse(eng.files[`${ROOT}/.sentinel/run.json`]!)
// A cleanup: git removes the checkout from its repository, then one node run takes the link to the packages off and
// removes the folders it leaves empty. Nothing in it deletes recursively.
function cleanedUp(eng: ReturnType<typeof engine>, outer: string, repo: string, top: string) {
  const k = eng.runs.findIndex(x => x.argv.join(' ') === `git worktree remove --force ${outer}/${repo}` && x.cwd === top)
  expect(k).toBeGreaterThan(-1)
  const unlink = eng.runs[k + 1]!
  expect(unlink.argv[0]).toBe('node')
  expect(unlink.argv.slice(3)).toEqual([outer, repo])
  const script = unlink.argv[2]!
  expect(script.indexOf('unlinkSync')).toBeGreaterThan(-1)
  expect(script.indexOf('unlinkSync')).toBeLessThan(script.indexOf('rmdirSync'))
  expect(script).not.toMatch(/recursive|rmSync/)
  expect(eng.runs.some(x => x.argv.join(' ').includes(outer) && /recursive|rm -rf|rmSync/.test(x.argv.join(' ')))).toBe(false)
}

// 1, 2
test("a one-repo state's brief starts a member in its repository's checkout, with the repository's packages linked beside it", async ($: any, on: any) => {
  const { eng } = await at($, on, true)
  const started = said(await $.tool.call({ tool: TOOL, action: 'brief', to: 'ui', brief: 'Add the search box.' }))
  expect(started).toMatch(/Started a member agent for ui in \.claude\/worktrees\/sentinel-ui-\w+\//)
  const outer = eng.spawns[0]!.cwd as string
  expect(outer).toMatch(/^D:\/proj\/\.claude\/worktrees\/sentinel-ui-\w+$/)
  // The snapshot is of shop-web, through an index in the project's .sentinel folder.
  const read = git(eng, 'read-tree', 'HEAD')
  expect(read.map(x => x.cwd)).toEqual([B])
  expect(read[0]!.env?.GIT_INDEX_FILE).toMatch(/^D:\/proj\/\.sentinel\/sentinel-ui-\w+\.index$/)
  const [add] = git(eng, 'worktree', 'add')
  expect(add!.argv.slice(1)).toEqual(['worktree', 'add', '--detach', `${outer}/shop-web`, 'snap1'])
  expect(add!.cwd).toBe(B)
  // The repository's node_modules is linked into the outer folder, where git never sees it.
  const link = eng.runs.find(x => x.argv[0] === 'node' && x.argv.includes(`${outer}/node_modules`))
  expect(link?.argv.slice(3)).toEqual([`${B}/node_modules`, `${outer}/node_modules`])
  expect(link!.argv[2]).toMatch(/symlinkSync\(.*'junction'\)|symlinkSync\(.*"junction"\)/)
  expect(eng.spawns[0]!.prompt).toContain(`shop-web repository, checked out at ${outer}/shop-web`)
  // Its edits under the repository's folder pass the guard; another repository's don't.
  const edit = async (file: string) => said(await $.tool.call({ tool: 'Write', file_path: file, content: 'x', agentId: 'm-1' }))
  expect(await edit(`${outer}/shop-web/src/box.tsx`)).toBe('ok')
  expect(await edit(`${outer}/shop-api/src/app.ts`)).toMatch(/outside the files of state ui/)
})

// 3, 7
test('its work is applied in its repository, named with the repository folder, and its checkout goes without touching the packages', async ($: any, on: any) => {
  const { eng, clock } = await at($, on, true)
  await $.tool.call({ tool: TOOL, action: 'brief', to: 'ui', brief: 'Add the search box.' })
  const outer = eng.spawns[0]!.cwd as string
  const inner = `${outer}/shop-web`
  const patch = 'diff --git a/src/box.tsx b/src/box.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/src/box.tsx\n@@ -0,0 +1 @@\n+box\n'
  eng.setPatch(patch)
  eng.setNames('src/box.tsx')
  const before = eng.runs.length
  await stopMember($, clock, 'm-1', 'Added the search box.')
  // The check runs in the outer folder, so a project-relative check finds its folder.
  expect(eng.commands.at(-1)).toBe(`(cd '${outer}' && cd shop-web && npm test); echo "[sentinel] exit $?"`)
  const after = eng.runs.slice(before).filter(x => x.argv[0] === 'git')
  expect(after.filter(x => x.argv[1] === 'add').every(x => x.cwd === inner)).toBe(true)
  expect(after.find(x => x.argv.includes('--binary') && x.argv[1] === 'diff')!.argv.slice(1)).toEqual(['diff', '--cached', '--binary', 'HEAD', '--', ':(glob,icase)src/**'])
  const apply = after.find(x => x.argv[1] === 'apply')!
  expect([apply.cwd, apply.stdin]).toEqual([B, patch])
  cleanedUp(eng, outer, 'shop-web', B)
  expect(eng.submitted.at(-1)).toMatch(/ui is in: its member passed `cd shop-web && npm test` in its worktree\. Sentinel applied its changes to the project: shop-web\/src\/box\.tsx\./)
  expect(runOf(eng).done).toContain('ui')
})

// 4
test("a state whose files span repositories, or sit outside any, can't get a member, and the refusal says why", async ($: any, on: any) => {
  const { eng } = await at($, on, true)
  const docs = said(await $.tool.call({ tool: TOOL, action: 'brief', to: 'docs', brief: 'Write the docs.' }))
  expect(docs).toMatch(/docs can't get a member: its files span shop-api and shop-web\..*main conversation/s)
  const tools = said(await $.tool.call({ tool: TOOL, action: 'brief', to: 'tools', brief: 'Fix the scripts.' }))
  expect(tools).toMatch(/tools can't get a member: its files scripts\/\*\* sit outside any git repository\..*main conversation/s)
  expect(git(eng, 'worktree', 'add')).toHaveLength(0)
  expect(eng.spawns).toHaveLength(0)
})

// 7
test('a member that cannot start leaves no checkout, and its packages link goes before its folder', async ($: any, on: any) => {
  const { eng } = await at($, on, true)
  eng.setSpawnDeny('agents are off')
  expect(said(await $.tool.call({ tool: TOOL, action: 'brief', to: 'ui', brief: 'Add the search box.' }))).toMatch(/couldn't start a member agent for ui: agents are off/)
  const outer = git(eng, 'worktree', 'add')[0]!.argv[4]!.replace(/\/shop-web$/, '')
  cleanedUp(eng, outer, 'shop-web', B)
})

// fails-without-change on, parallel states off, and the main conversation in api with its snapshot taken. In the copy
// the check passes only with the code change in.
async function inApi($: any, on: any) {
  const plan = { ...PLAN, states: PLAN.states.map(s => ({ ...s, needs: undefined })) }
  const eng = twoRepos(on)
  const clock = mock.clock(on)
  eng.files[`${ROOT}/.sentinel/library.json`] = JSON.stringify({ on: { 'fails-without-change': true, 'quote-the-source': false } })
  eng.setBash(cmd => {
    const dir = /cd '([^']+)'/.exec(cmd)?.[1] ?? ''
    if (!dir.includes('/sentinel-wo-')) return PASS
    return eng.files[`${dir}/shop-api/src/refund.ts`] ? PASS : FAIL
  })
  await $.command.run({ command: 'sentinel', args: 'parallel off' })
  await clock.advance(1)
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, ...plan })
  await $.tool.call({ tool: 'Read', file_path: `${A}/src/app.ts` })
  expect(said(await $.tool.call({ tool: TOOL, action: 'advance', to: 'api', evidence: 'read it' }))).toMatch(/Moved to api/)
  return { eng, clock }
}

// 5, 6, 7
test("the visit's snapshot is of the state's repository, and the rerun without the change runs in a linked copy of it", async ($: any, on: any) => {
  const { eng } = await inApi($, on)
  const read = git(eng, 'read-tree', 'HEAD')
  expect(read.map(x => [x.cwd, x.env?.GIT_INDEX_FILE])).toEqual([[A, `${ROOT}/.sentinel/snap.index`]])
  await $.tool.call({ tool: 'Write', file_path: `${A}/src/refund.ts`, content: 'refund v2' })
  await $.tool.call({ tool: 'Write', file_path: `${A}/tests/refund.test.ts`, content: 'test v1' })
  const moved = said(await $.tool.call({ tool: TOOL, action: 'advance', to: 'ui' }))
  expect(moved).toMatch(/failed, as it should\.\nMoved to ui/)
  const [add] = git(eng, 'worktree', 'add')
  const inner = add!.argv[4]!
  const outer = inner.replace(/\/shop-api$/, '')
  expect(outer).toMatch(/^D:\/proj\/\.claude\/worktrees\/sentinel-wo-api-\w+$/)
  expect([add!.cwd, add!.argv[5]]).toEqual([A, 'snap1'])
  expect(eng.runs.some(x => x.argv[0] === 'node' && x.argv.slice(3).join(' ') === `${A}/node_modules ${outer}/node_modules`)).toBe(true)
  expect(eng.files[`${inner}/tests/refund.test.ts`]).toBe('test v1')
  expect(eng.commands.filter(c => c.includes('/sentinel-wo-')).every(c => c.startsWith(`(cd '${outer}' && cd shop-api && npm test)`))).toBe(true)
  cleanedUp(eng, outer, 'shop-api', A)
  const log = runOf(eng).log.map((l: any) => l.text)
  expect(log).toContain('api · check fails without the change')
  expect(log.filter((t: string) => /no snapshot|skipped/.test(t))).toEqual([])
})

// 9
test('tests a helper subagent wrote count for the rerun without the change', async ($: any, on: any) => {
  const { eng } = await inApi($, on)
  eng.setAgents([{ id: 'h-1', status: 'running', description: 'Write the refund tests' }])
  await $.tool.call({ tool: 'Write', file_path: `${A}/src/refund.ts`, content: 'refund v2' })
  expect(said(await $.tool.call({ tool: 'Write', file_path: `${A}/tests/refund.test.ts`, content: 'test v1', agentId: 'h-1' }))).toBe('ok')
  const moved = said(await $.tool.call({ tool: TOOL, action: 'advance', to: 'ui' }))
  expect(moved).toMatch(/failed, as it should\.\nMoved to ui/)
  const inner = git(eng, 'worktree', 'add')[0]!.argv[4]!
  expect(eng.files[`${inner}/tests/refund.test.ts`]).toBe('test v1')
  const run = runOf(eng)
  expect(run.log.map((l: any) => l.text)).toContain('api · check fails without the change')
  // The helper's edit stays out of the calls, so the stuck detector and the health window don't see it.
  expect(run.calls.some((c: any) => c.file === 'shop-api/tests/refund.test.ts')).toBe(false)
})

// 10
test("two helpers' first edits at once leave one good snapshot, taken before either lands", async ($: any, on: any) => {
  const eng = twoRepos(on)
  const clock = mock.clock(on)
  eng.files[`${ROOT}/.sentinel/library.json`] = JSON.stringify({ on: { 'fails-without-change': true, 'quote-the-source': false } })
  // A draft the user locks starts its first visit with no snapshot: it is taken before the first edit, here a helper's.
  await $.command.run({ command: 'sentinel', args: 'lock' })
  await clock.advance(1)
  await $.tool.call({ tool: TOOL, ...PLAN, states: [{ ...PLAN.states[1]!, needs: undefined }] })
  expect(said(await $.command.run({ command: 'sentinel', args: 'lock' }))).toMatch(/Locked "Phase 3" at api/)
  expect(git(eng, 'commit-tree')).toHaveLength(0)
  eng.setAgents([{ id: 'h-1', status: 'running' }, { id: 'h-2', status: 'running' }])
  let held: (string | undefined)[] = ['not taken']
  eng.setDuring('commit-tree', async () => { held = [eng.files[`${A}/src/one.ts`], eng.files[`${A}/tests/one.test.ts`]] })
  const both = await Promise.all([
    $.tool.call({ tool: 'Write', file_path: `${A}/src/one.ts`, content: 'one', agentId: 'h-1' }),
    $.tool.call({ tool: 'Write', file_path: `${A}/tests/one.test.ts`, content: 'test', agentId: 'h-2' }),
  ])
  expect(both.map(said)).toEqual(['ok', 'ok'])
  expect(git(eng, 'commit-tree')).toHaveLength(1)
  expect(held).toEqual([undefined, undefined])
  const r = eng.memory.run!
  expect(r.snap).toMatchObject({ state: 'api', sha: 'snap1' })
  expect(r.log.filter(l => /no snapshot/.test(l.text))).toEqual([])
})

test('a later answer for the same visit leaves its good snapshot alone', () => {
  const r = { ...emptyRun(), active: 'api', enteredAt: 5 }
  const good = withSnap(r, 'snap1')
  const after = snapTaken(good, r, new Error('git read-tree: index.lock exists'), '09:00')
  expect(after.snap?.sha).toBe('snap1')
  expect(after.log).toEqual(good.log)
  // With none yet, a failure is said once and the visit gets no rerun.
  const failed = snapTaken(r, r, new Error('git read-tree: index.lock exists'), '09:00')
  expect(failed.snap?.sha).toBe('')
  expect(failed.log.at(-1)?.text).toBe('api · no snapshot for the rerun without the change: git read-tree: index.lock exists')
  // A run that has moved on to another visit takes nothing.
  expect(snapTaken({ ...r, enteredAt: 9 }, r, 'snap2', '09:00').snap).toBeUndefined()
})

// 8
test("the draft lists the states that can't get a member here, and why", async ($: any, on: any) => {
  const { defined } = await at($, on, true)
  const text = notes(defined)
  expect(text).toMatch(/isn't a git repository/)
  expect(text).toMatch(/docs \(its files span shop-api and shop-web\)/)
  expect(text).toMatch(/tools \(its files scripts\/\*\* sit outside any git repository\)/)
  expect(text).toMatch(/verify \(it lists no files\)/)
  expect(text).not.toMatch(/\bui \(|\bapi \(/)
})

test("with parallel states off, the draft doesn't say which states can't get a member", async ($: any, on: any) => {
  const { defined } = await at($, on, false)
  expect(notes(defined)).not.toMatch(/can't get a member/)
})

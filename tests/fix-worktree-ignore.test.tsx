// git 2.52 exits 1 when an exclude pathspec names a path .gitignore ignores and that path exists, so a project that
// ignores .claude/worktrees/ couldn't start a second member. The snapshot asks git first and excludes only what it doesn't ignore.
import { expect, mock } from 'claude-code/testing'
import { REFUND, TOOL, engine, said, test } from './kit'

const GRAPH = {
  action: 'define', title: 'Search page',
  states: [
    { id: 'explore', label: 'Read the code' },
    { id: 'api', label: 'Search endpoint', check: 'npm test -- api', files: ['api/*.ts'], needs: ['explore'] },
    { id: 'ui', label: 'Search box', check: 'npm test -- ui', files: ['ui/**'], needs: ['explore'] },
    { id: 'verify', label: 'Full suite', check: 'npm test', needs: ['api', 'ui'] },
  ],
}
const EXCLUDE = ':(exclude).claude/worktrees'
async function brief($: any, on: any, ignores: boolean) {
  const eng = engine(on)
  mock.clock(on)
  eng.setIgnores(ignores)
  await $.command.run({ command: 'sentinel', args: 'parallel on' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  await $.tool.call({ tool: TOOL, ...GRAPH })
  await $.tool.call({ tool: 'Read', file_path: REFUND })
  await $.tool.call({ tool: TOOL, action: 'advance', to: 'api', evidence: 'read it' })
  const out = said(await $.tool.call({ tool: TOOL, action: 'brief', to: 'ui', brief: 'Add the search box.' }))
  const add = eng.runs.find((x: any) => x.argv[1] === 'add')!
  return { eng, out, add }
}

test('a project whose .gitignore ignores .claude/worktrees/ gets a member, and the snapshot adds with no exclude', async ($: any, on: any) => {
  const { out, add, eng } = await brief($, on, true)
  expect(out).toMatch(/Started a member agent for ui/)
  expect(add.argv).not.toContain(EXCLUDE)
  // git is asked through the snapshot's own index, before the add.
  const ask = eng.runs.findIndex((x: any) => x.argv[1] === 'check-ignore')
  expect(ask).toBeGreaterThan(-1)
  expect(ask).toBeLessThan(eng.runs.indexOf(add))
  expect(eng.runs[ask].argv.slice(1)).toEqual(['check-ignore', '-q', '.claude/worktrees/'])
})

test('a project that does not ignore .claude/worktrees/ keeps the exclude, so members never snapshot each other', async ($: any, on: any) => {
  const { out, add } = await brief($, on, false)
  expect(out).toMatch(/Started a member agent for ui/)
  expect(add.argv).toContain(EXCLUDE)
})

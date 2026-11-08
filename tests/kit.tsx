// The engine's test double and the helpers every test file shares. sentinel.test.tsx and the map's test files import it.
import { expect, mock, test as kitTest } from 'claude-code/testing'
import type { Run } from '../types'

export const ROOT = 'D:/proj'
export const TOOL = 'mcp__sentinel__plan'
export const REFUND = `${ROOT}/src/refund.ts`

// git's ls-files and hash-object over the in-memory files, which is all the system map's fingerprints ask of git. A file
// shows when it sits under the project root and outside Sentinel's own folder; a hash changes with the file's text.
function fakeGit(files: Record<string, string>, argv: string[], stdin?: string, untracked: string[] = [], deleted: string[] = []): string | undefined {
  if (argv[0] !== 'git') return undefined
  const sub = argv.find(a => a === 'ls-files' || a === 'hash-object')
  if (!sub) return undefined
  const key = (name: string) => `${ROOT}/${name}`
  // The whole project's file list, as the update check asks for it: tracked and new (-co), or only the new ones (-o).
  if (sub === 'ls-files' && !argv.includes('--') && !argv.includes('-d')) {
    const all = Object.keys(files).filter(f => f.startsWith(`${ROOT}/`) && !f.startsWith(`${ROOT}/.sentinel/`)).map(f => f.slice(ROOT.length + 1))
    return (argv.includes('-o') ? untracked : [...all, ...untracked, ...deleted]).join('\n')
  }
  if (sub === 'hash-object') {
    const sum = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, s.length).toString(16)
    return (stdin ?? '').split('\n').filter(Boolean).map(name => sum(files[key(name)] ?? '')).join('\n')
  }
  if (argv.includes('-d')) return deleted.join('\n')
  const matches = (path: string, spec: string) => {
    if (!spec.startsWith(':(glob)')) return path === spec || path.startsWith(`${spec}/`)
    const re = spec.slice(':(glob)'.length).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*')
    return new RegExp(`^${re}$`).test(path)
  }
  const specs = argv.slice(argv.indexOf('--') + 1)
  return Object.keys(files)
    .filter(f => f.startsWith(`${ROOT}/`) && !f.startsWith(`${ROOT}/.sentinel/`))
    .map(f => f.slice(ROOT.length + 1))
    .filter(p => specs.some(s => matches(p, s)))
    .join('\n')
}

// Each hook here stands for the engine beneath the plugin.
export function engine(on: any) {
  const files: Record<string, string> = { [REFUND]: 'original' }
  const submitted: string[] = []
  const commands: string[] = []
  const reads: string[] = []
  // One result for every command, or one per command. `cut` stops before the exit line, as Esc does.
  // wait: the call answers once it settles. background on a check run: still going at the tool's timeout.
  type Bash = { fail: boolean; text: string; quiet?: boolean; background?: boolean | 'huge'; saved?: boolean | 'huge' | 'gone'; cut?: boolean; deny?: string; wait?: Promise<unknown> }
  let shell: Bash | ((command: string) => Bash) = { fail: false, text: 'ok' }
  const outs: Record<string, string> = {}
  let tasks = 0
  let cwd = ROOT
  let quoting = false
  let root = ROOT
  on('session.root', () => ({ value: root }))
  // What the engine reports of the limits and the session's cost.
  // A promise holds the reading back until the test settles it.
  let usage: object | Promise<object> = { rateLimits: [] }
  let usageFails = false
  on('session.usage', async () => {
    if (usageFails) throw new Error('no reading')
    return { value: { startedAt: 0, context: {}, ...(await usage) } }
  })
  on('session.cwd', () => ({ value: cwd }))
  // The tools the model has: an MCP server shows as its tools, mcp__<server>__<tool>.
  let tools: string[] = ['Read', 'Edit', 'Bash']
  on('tool.list', () => ({ value: tools.map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) }))
  const key =(path: string) => path.replace(/\\/g, '/')
  on('fs.read', (_: unknown, e: any) => {
    reads.push(key(e.path))
    // As the real read does for a file that isn't there. Elsewhere a missing file reads as empty.
    if (key(e.path).includes('/missing')) throw new Error(`ENOENT: ${e.path}`)
    // Most tests' plans quote nothing, so the comparison is off by the user's default until a test calls eng.quoting().
    if (!quoting && key(e.path) === `${HOME}/.sentinel/library.json` && !files[key(e.path)]) return { value: '{"on":{"quote-the-source":false}}' }
    return { value: files[key(e.path)] ?? '' }
  })
  // A write to a path matching this fails, as a full disk does.
  let writeFails: RegExp | undefined
  on('fs.write', (_: unknown, e: any) => {
    if (writeFails?.test(key(e.path))) throw new Error('ENOSPC: no space left on device')
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_: unknown, e: any) => ({ value: Object.hasOwn(files, key(e.path)) }))
  // A folder holds what is written under it.
  on('fs.list', (_: unknown, e: any) => {
    const dir = `${key(e.path).replace(/\/$/, '')}/`
    const names = [...new Set(Object.keys(files).filter(f => f.startsWith(dir)).map(f => f.slice(dir.length).split('/')[0]!))]
    return { value: names.map(name => ({ name, kind: Object.hasOwn(files, dir + name) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  // The plugin's store, which a test can read and fill.
  const store: Record<string, unknown> = {}
  on('store.get', (_: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: unknown, e: any) => ((store[e.key] = e.value), { value: undefined }))
  // What the plugin holds in memory, as it last wrote it. A test reads it here, since $.state is the plugin's own.
  const memory: { run?: Run; said?: { messages: { text: string; at: string }[]; wrote: string[] } } = {}
  on('state.set', { plugin: 'sentinel' }, (_: unknown, e: any, next: any) => {
    memory[e.key as 'run' | 'said'] = e.value.value
    return next(e)
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_: unknown, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let dropping: string | undefined
  on('prompt.submit', (_: unknown, e: any) => {
    if (dropping) return { drop: dropping }
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  // `during` runs once, while the next Bash call or git command (by its subcommand, such as 'apply') runs.
  let during: { at: string; run: () => Promise<unknown> } | undefined
  const fire = async (at: string) => {
    const now = during?.at === at ? during : undefined
    if (now) during = undefined
    await now?.run()
  }
  let agents: { id: string; status: string; description?: string; name?: string; parentId?: string }[] = []
  on('agent.list', () => ({ value: agents }))
  // The engine's own band, drawn when Sentinel has nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('tool.call', { tool: ['Edit', 'Write'] }, (_: unknown, e: any) => {
    files[key(e.file_path)] = e.new_string ?? e.content
    return { result: {}, text: 'ok' }
  })
  on('tool.call', { tool: 'NotebookEdit' }, () => ({ result: {}, text: 'ok' }))
  on('tool.call', { tool: ['Read', 'Grep'] }, (_: unknown, e: any) => ({ result: {}, text: `read ${e.file_path ?? e.pattern}` }))
  // Like the real Bash tool: a trailing echo always succeeds, the tool may add a note after the output,
  // and `quiet` is a non-zero exit it reports as success (test, grep).
  on('tool.call', { tool: 'Bash' }, async (_: unknown, e: any) => {
    await fire('Bash')
    commands.push(e.command)
    const bash = typeof shell === 'function' ? shell(e.command) : shell
    if (bash.deny) return { deny: bash.deny }
    if (bash.wait) await bash.wait
    const ok = { stdout: bash.text, stderr: '', interrupted: !!bash.cut }
    // A check run still going at the tool's timeout (`background`) goes on in the background, writing an output file,
    // kept by command in `outs`, where a test adds to it.
    if (e.command.endsWith('echo "[sentinel] exit $?"')) {
      // 'huge': an output file too big to read whole, as the real read refuses over 4 MiB.
      if (bash.background === 'huge') {
        const id = `t${++tasks}`
        outs[`C:/tmp/missing/tasks/${id}.output`] = `${bash.text}\n[sentinel] exit ${bash.fail ? 1 : 0}\n`
        return { result: { ...ok, backgroundTaskId: id }, text: `Command running in background with ID: ${id}. Output is being written to: C:\\tmp\\missing\\tasks\\${id}.output` }
      }
      if (bash.background) {
        const id = `t${++tasks}`
        outs[e.command] = `C:/tmp/tasks/${id}.output`
        files[outs[e.command]!] = bash.text
        return { result: { ...ok, backgroundTaskId: id }, text: `Command running in background with ID: ${id}. Output is being written to: C:\\tmp\\tasks\\${id}.output` }
      }
      // Over 30,000 characters the real tool answers with a preview and saves the whole output, exit line and all, to a
      // file: `saved` 'huge' is one too big to read whole, 'gone' one that can't be read at all.
      if (bash.saved) {
        const path = `C:\\tmp\\${bash.saved === true ? '' : 'missing\\'}tool-results\\r${++tasks}.txt`
        const whole = `${bash.text}\n[sentinel] exit ${bash.fail ? 1 : 0}\n`
        if (bash.saved === true) files[key(path)] = whole
        else if (bash.saved === 'huge') outs[key(path)] = whole
        return { result: { ...ok, stdout: bash.text.slice(0, 200), persistedOutputPath: path, persistedOutputSize: 40_000 }, text: `<persisted-output>\nOutput too large (39.1KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n${bash.text.slice(0, 200)}\n...\n</persisted-output>\nShell cwd was reset to ${ROOT}` }
      }
      return { result: ok, text: bash.cut ? `${bash.text}\nInterrupted` : `${bash.text}\n[sentinel] exit ${bash.fail ? 1 : 0}\nShell cwd was reset to ${ROOT}` }
    }
    // tail of a file too big to read: the real tool saves an answer over 30,000 characters too, so the exit line is lost.
    const tailed = /^tail -c (\d+) '(.+)'$/.exec(e.command)
    const whole = tailed && outs[tailed[2]!]
    if (tailed && whole) {
      return Number(tailed[1]) > 30_000
        ? { result: ok, text: `<persisted-output>\nOutput too large. Full output saved to: C:\\tmp\\tool-results\\t${++tasks}.txt\n</persisted-output>` }
        : { result: ok, text: whole.slice(-Number(tailed[1])) }
    }
    if (bash.background) return { result: { ...ok, backgroundTaskId: 'b1' }, text: 'Command running in background with ID: b1' }
    if (bash.fail && bash.quiet) return { result: { ...ok, returnCodeInterpretation: 'Condition is false' }, text: bash.text }
    return bash.fail ? { isError: true, result: bash.text, text: bash.text } : { result: ok, text: bash.text }
  })
  let approved: object = { plan: 'p', isAgent: false }
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: approved, text: 'approved' }))
  const stops: string[] = []
  on('tool.call', { tool: 'TaskStop' }, (_: unknown, e: any) => (stops.push(e.task_id), { result: {}, text: 'stopped' }))
  // The question dialog answers at once, unless the test holds it open.
  let dialog: ((e?: any) => Promise<unknown>) | undefined
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => (dialog ? dialog(e) : { result: {}, text: 'answered' }))
  // The dashboard's helper: its ready line, then what the test sends from the page, each line in two pieces.
  const pageLines: string[] = []
  let wake = () => {}
  let helperFails = false
  let helperEnv: Record<string, string> | undefined
  on('process.spawn', async function* (_: unknown, e: any) {
    if (helperFails) throw new Error('node not found')
    helperEnv = e.env
    yield { stream: 'stdout', text: `{"port":41234,"token":"${TOKEN}"}\n` }
    for (;;) {
      while (pageLines.length) yield { stream: 'stdout', text: pageLines.shift()! }
      await new Promise<void>(ok => (wake = ok))
    }
  })
  // git for the member worktrees: write-tree and commit-tree print the ids the next steps take.
  // Only core sets a spawned agent's id, so a started member is found in the agent list by its name.
  // A member's staged diff is `patch`.
  const runs: { argv: string[]; cwd?: string; env?: Record<string, string>; stdin?: string }[] = []
  let head: string | undefined = 'abc1234'
  // What git knows of the project's history: the changes since each commit, and the files it does not track yet.
  let history: { since: Record<string, { how: 'A' | 'M' | 'D' | 'R'; path: string; was?: string }[]>; untracked: string[]; deleted: string[] } = { since: {}, untracked: [], deleted: [] }
  let patch = ''
  // What the member changed in all, by name.
  let names = ''
  // How the hub's open command ends. Undefined: it can't run at all.
  let hubExit: number | undefined = 0
  on('process.run', async (_: unknown, e: any) => {
    // Sentinel waits on a check by running sleep. It answers at once here, so Sentinel waits on its clock instead.
    if (e.argv[0] === 'sleep') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    await fire(e.argv[1])
    // Node deleting a flow file.
    if (e.argv[0] === 'node' && /rmSync/.test(e.argv[2])) delete files[key(e.argv[3])]
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd, env: e.init?.env, stdin: e.init?.stdin })
    if (/\/hub\.mjs$/.test(e.argv[1] ?? '')) {
      if (hubExit === undefined) throw new Error('node not found')
      return { value: { exitCode: hubExit, stdout: '', stderr: '' } }
    }
    // The commit the project is at, or no git repo when it is unset.
    if (e.argv[0] === 'git' && e.argv.includes('rev-parse')) return { value: head === undefined ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : { exitCode: 0, stdout: `${head}\n`, stderr: '' } }
    // What changed since a commit, as git diff --name-status -M gives it. A commit not in setHistory is one git does not know.
    if (e.argv[0] === 'git' && e.argv.includes('--name-status')) {
      const list = history.since[e.argv.at(-1)!]
      if (!list) return { value: { exitCode: 128, stdout: '', stderr: `fatal: bad object ${e.argv.at(-1)}` } }
      return { value: { exitCode: 0, stdout: list.map(c => (c.how === 'R' ? `R095\t${c.was}\t${c.path}` : `${c.how}\t${c.path}`)).join('\n'), stderr: '' } }
    }
    const listed = fakeGit(files, e.argv, e.init?.stdin, history.untracked, history.deleted)
    if (listed !== undefined) return { value: { exitCode: 0, stdout: listed, stderr: '' } }
    const out = e.argv[1] === 'write-tree' ? 'tree1' : e.argv[1] === 'commit-tree' ? 'snap1' : e.argv[1] === 'diff' ? (e.argv.includes('--name-only') ? names : patch) : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
  const sent: any[] = []
  let sendDeny: string | undefined
  on('session.send', (_: unknown, e: any) => {
    if (sendDeny) return { isDelivered: false, reason: sendDeny }
    sent.push(e)
    return { isDelivered: true }
  })
  const spawns: any[] = []
  let spawnDeny: string | undefined
  on('agent.spawn', (_: unknown, e: any) => {
    spawns.push(e)
    if (spawnDeny) return { deny: spawnDeny }
    agents = [...agents, { id: `m-${spawns.length}`, status: 'running', description: e.description, name: e.name }]
    return { model: 'm' }
  })
  return {
    files, submitted, commands, reads, runs, spawns, sent, statuses, outs, stops, toasts, memory, store,
    helperEnv: () => helperEnv, setRoot: (d: string) => (root = d), setHub: (code?: number) => (hubExit = code), setHelperFails: (f: boolean) => (helperFails = f),
    setUsage: (u: object | Promise<object>) => (usage = u), setUsageFails: (f: boolean) => (usageFails = f), setTools: (t: string[]) => (tools = t),
    setBash: (b: typeof shell) => (shell = b), setCwd: (d: string) => (cwd = d), setAgents: (a: typeof agents) => (agents = a), setSpawnDeny: (d?: string) => (spawnDeny = d), setPatch: (p: string) => (patch = p), setNames: (n: string) => (names = n),
    setSendDeny: (d?: string) => (sendDeny = d), setDuring: (at: string, run: () => Promise<unknown>) => (during = { at, run }), agents: () => agents,
    setDialog: (d?: (e?: any) => Promise<unknown>) => (dialog = d), setWriteFails: (re?: RegExp) => (writeFails = re), setHead: (h?: string) => (head = h),
    setHistory: (h: Partial<typeof history>) => (history = { since: {}, untracked: [], deleted: [], ...h }),
    setApproved: (a: object) => (approved = a), setDropping: (d?: string) => (dropping = d), quoting: () => (quoting = true),
    // Several messages go out in one piece, as two tabs sending at once can.
    page: (...ms: object[]) => {
      const lines = ms.map(m => JSON.stringify(m) + '\n').join('')
      pageLines.push(lines.slice(0, 5), lines.slice(5))
      wake()
    },
    // What the browser page reads.
    snap: () => {
      const js = files[`${ROOT}/.sentinel/state.js`]
      return js ? JSON.parse(js.slice('window.__sentinel && window.__sentinel('.length, -2)) : {}
    },
  }
}

export const TOKEN = 'a'.repeat(32)
export const HOME = 'C:/Users/me'
// Moves the clock on until the plugin's background work has caught up.
export async function until(clock: any, ok: () => unknown) {
  for (let i = 0; i < 50 && !ok(); i++) await clock.advance(1)
  expect(ok()).toBeTruthy()
}
// Opens the dashboard: its helper starts from a timer, so the clock has to move.
export async function openPage($: any, clock: any) {
  const opening = $.command.run({ command: 'sentinel', args: 'browser' })
  await clock.advance(1)
  return said(await opening)
}

export const said = (r: any): string => String(r?.deny ?? r?.text ?? r?.result ?? '')
// The main conversation's turn ends: the classic Stop, carrying what still runs, then turn.complete.
export async function endTurn($: any, { tasks = [] as object[], reason = 'answer', answer = 'Done for now.' } = {}) {
  await $.classic.Stop({ hook_event_name: 'Stop', session_id: 's', transcript_path: '', cwd: ROOT, stop_hook_active: false, background_tasks: tasks, session_crons: [] })
  await $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't', reason })
}

// Tests on a mock clock can take seconds on a busy machine. The kit's 5 s limit made them fail at random, and only a real hang needs one.
export const test = (name: string, ...rest: any[]) => (rest.length === 2 ? kitTest(name, { timeoutMs: 30_000, ...rest[0] }, rest[1]) : kitTest(name, { timeoutMs: 30_000 }, rest[0]))

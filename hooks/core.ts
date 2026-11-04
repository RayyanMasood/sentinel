// The plan, the ledger and the stuck detector. Pure functions over `Run`:
// no `$` here, so the pane, the browser view and the tests read the same numbers.
import type { Audit, AuditKind, Call, Depth, FlowDef, FlowState, FlowWhen, InstructionAt, InstructionDef, Kind, Lane, LogLine, Member, Plan, PlanInput, Refused, Run, Source, Spend, StateDef, Switches, Task, Tone, Trap, Trip, View, Wait, Weight } from '../types'
import { checkQuote, MIN_WORDS, nearest, sectionOf, spanOf, squash, unquoted, unquotedSections } from './quote.ts'
export type { PlanInput }

export const K = 8 // window of recent calls the detector looks at
export const THETA = 0.25 // stuck at or below this health
export const AUTO_CAP = 2 // auto-continues in a row without a state change
export const VIEWS: readonly View[] = ['focus', 'map', 'ledger']
const MAX_CALLS = 400
// The plain-words fields on a task page, and a reason or outcome, are cut to this many characters.
const MAX_TEXT = 400
const clip = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined)
// A state id can be any word, so only a task's own entry counts (not "constructor" off Object.prototype).
const taskIn = (t: Record<string, Task> | undefined, id?: string | null) => (id && t && Object.hasOwn(t, id) ? t[id] : undefined)
// Ends the task's running visit; an outcome, when given, is what was done there.
function closeVisit(tasks: Record<string, Task> | undefined, id: string, now: number, outcome?: string): Record<string, Task> {
  const own = taskIn(tasks, id) ?? { visits: [] }
  const visits = own.visits.map((v, k) => (k === own.visits.length - 1 && v.to === undefined ? { ...v, to: now } : v))
  return { ...tasks, [id]: { ...own, visits, ...(outcome ? { outcome } : {}) } }
}

export const emptyRun = (): Run => ({
  signedOff: false, plan: null, active: null, enteredAt: 0, step: 0, calls: [], traps: [],
  audit: [], log: [], loops: {}, askToken: 0, breakingOk: false, quiet: false, auto: 0,
})

export const isUnfinished = (r: Run) => !!r.plan && !!r.active && r.active !== 'done'
export const isLive = (r: Run) => isUnfinished(r) && !r.paused
export const stateOf = (r: Run, id = r.active) => r.plan?.states.find(s => s.id === id)
export const visitOf = (r: Run) => r.calls.filter(c => c.step > r.enteredAt)
export const openTrap = (r: Run) => r.traps.find(t => t.end === undefined && t.state === r.active)

// ---- the dependency graph ----

// The states `id` needs: its own list, or else the state listed before it.
export function needsOf(states: StateDef[], id: string): string[] {
  const i = states.findIndex(s => s.id === id)
  return states[i]?.needs ?? (i > 0 ? [states[i - 1]!.id] : [])
}

// Every state `id` builds on, directly or through others.
export function upstream(states: StateDef[], id: string): Set<string> {
  const seen = new Set<string>()
  const todo = [id]
  while (todo.length) {
    for (const n of needsOf(states, todo.pop()!)) {
      if (!seen.has(n)) {
        seen.add(n)
        todo.push(n)
      }
    }
  }
  return seen
}

export function doneOf(r: Run): string[] {
  if (r.done) return r.done
  const ids = r.plan?.states.map(s => s.id) ?? []
  return r.active === 'done' ? ids : ids.slice(0, Math.max(0, ids.indexOf(r.active ?? '')))
}

// ponytail: two globs meet when one matches the other's text, so `*.ts` and `src/*` pass; intersect the regexes if that bites.
const globsMeet = (a: string, b: string) => globMatch(a, b) || globMatch(b, a)

// ---- members (parallel states) ----

// The states whose needs are all done and that nobody works on yet.
// A state that needs the user's OK is left to the main conversation, where the user sees it.
export function readyOf(r: Run): string[] {
  if (!isLive(r)) return []
  const done = doneOf(r)
  const states = r.plan!.states
  return states
    .filter(s => s.id !== r.active && !waitOf(s) && !done.includes(s.id) && !r.running?.[s.id] && needsOf(states, s.id).every(n => done.includes(n)))
    .map(s => s.id)
}

// What the main conversation hears, with parallel states on, about the states beside its own.
export function besideNote(r: Run): string | undefined {
  const ready = readyOf(r)
  const running = Object.keys(r.running ?? {})
  const lines = [
    ready.length ? `Ready to run beside you: ${ready.join(', ')}. Give each one a brief with action "brief" (to, brief): what to do and what to watch for. Sentinel then starts a member agent for it in a worktree of its own.` : '',
    running.length ? `Running in member agents: ${running.join(', ')}.` : '',
  ].filter(Boolean)
  return lines.length ? lines.join('\n') : undefined
}

export function briefRefusal(r: Run, i: PlanInput, parallel: boolean): string | undefined {
  if (!isLive(r)) return 'No plan is running.'
  if (!parallel) return 'Parallel states are off, so you work through the states one at a time. Only the user turns them on, with /sentinel parallel on.'
  const id = (i.to ?? '').trim()
  const st = stateOf(r, id)
  if (!st) return `"${id}" is not one of the states.`
  if (r.running?.[id]) return `${id} already has a member agent.`
  if (waitOf(st)) return `${id} needs the user's OK, so you do it yourself when it comes up.`
  if (!readyOf(r).includes(id)) {
    const done = doneOf(r)
    const open = needsOf(r.plan!.states, id).filter(n => !done.includes(n))
    return id === r.active ? `${id} is your own state.` : open.length ? `${id} is not ready: it needs ${open.join(', ')}, not done yet.` : `${id} is done.`
  }
  // Only an amend can make a ready state share files with a state being worked on.
  const busy = [r.active!, ...Object.keys(r.running ?? {})].find(o => stateOf(r, o)?.files.some(f => st.files.some(g => globsMeet(f, g))))
  if (busy) return `${id} may edit the same files as ${busy}, which is being worked on now. Wait until ${busy} is done, then brief ${id}.`
  if (!i.brief?.trim()) return `brief needs the text for ${id}'s member: what to do and what to watch for.`
  return undefined
}

// Pairs of states that can run at the same time with no state that has a check and builds on both, so nothing tests
// them together. A state that edits no files has nothing to bring together, and a pair with the same check is tested
// together by the final sweep.
export function untested(states: StateDef[]): [string, string][] {
  const up = new Map(states.map(s => [s.id, upstream(states, s.id)]))
  const pairs: [string, string][] = []
  for (const [k, a] of states.entries()) {
    for (const b of states.slice(k + 1)) {
      if (!a.files.length || !b.files.length || up.get(b.id)!.has(a.id) || (a.check && b.check && sameText(a.check, b.check))) continue
      if (!states.some(s => s.check && up.get(s.id)!.has(a.id) && up.get(s.id)!.has(b.id))) pairs.push([a.id, b.id])
    }
  }
  return pairs
}

export function untestedNote(states: StateDef[]): string | undefined {
  const pairs = untested(states)
  if (!pairs.length) return undefined
  const [a, b] = pairs[0]!
  if (pairs.length === 1) return `[sentinel] ${a} and ${b} can run at the same time, and no later state with a check builds on both, so nothing tests them together. Add a state that needs both and checks them together, such as an end-to-end test.`
  const more = pairs.length > 4 ? `, and ${pairs.length - 4} more` : ''
  return `[sentinel] These pairs can run at the same time, and no later state with a check builds on both, so nothing tests them together: ${pairs.slice(0, 4).map(p => p.join(' and ')).join('; ')}${more}. Add a state that needs each pair and checks them together, such as an end-to-end test.`
}

// Before the plan completes, the checks of the done states run again: each command once, apart from the one that
// just passed.
// A skipped state is left out.
export function sweepChecks(r: Run, passed?: string): string[] {
  const done = doneOf(r)
  const checks = r.plan!.states.filter(s => done.includes(s.id) && !r.skipped?.[s.id] && s.check && !(passed && sameText(s.check, passed))).map(s => s.check!)
  return [...new Set(checks)]
}

// A pass of `check` in earlier final checks that still holds: since then no edit, no shell command but a check, and
// nothing outside the ledger. A ledger trimmed past that point can't say, so the check runs again.
export function sweptPass(r: Run, check: string): boolean {
  const p = r.swept?.[check]
  if (!p || p.touches !== (r.touches ?? 0) || (r.calls[0]?.step ?? 0) > p.step + 1) return false
  return !r.calls.some(c => c.step > p.step && !c.denied && (c.kind === 'edit' || (c.kind === 'look' && c.label.startsWith('Bash '))))
}

// The done states the active state fixed in this visit, through edits to their files.
const fixedOf = (r: Run): StateDef[] => [...new Set(visitOf(r).flatMap(c => c.fix ?? []))].flatMap(id => stateOf(r, id) ?? [])

// The checks an advance to `to` runs again first, when it moves forward: those of the done states fixed in this visit,
// apart from the active state's own, which runs anyway.
export function fixChecks(r: Run, to?: string): string[] {
  const st = isLive(r) ? stateOf(r) : undefined
  if (!st || (to ?? '').trim() !== nextOf(r, st)) return []
  const own = st.check
  return [...new Set(fixedOf(r).flatMap(s => (s.check && !(own && sameText(s.check, own)) ? [s.check] : [])))]
}

export const RETRIES = 2 // times a member's failing check goes back to it

// A member's check failed in its worktree. It tries again up to RETRIES times; after that its state is taken off it
// and is ready again. retry: the number of this retry, when there is one.
export function memberFail(r: Run, id: string, t: string, now: number): { run: Run; retry?: number } {
  const m = r.running?.[id]
  if (!m) return { run: r }
  const fails = (m.fails ?? 0) + 1
  if (fails <= RETRIES) {
    return { retry: fails, run: { ...r, running: { ...r.running, [id]: { agent: m.agent, name: m.name, since: m.since, fails } }, log: [...r.log, { t, icon: '×', tone: 'err', text: `${id} · member check failed · retry ${fails}/${RETRIES}` }] } }
  }
  return { run: memberOff(r, id, `${fails} failed checks`, t, now) }
}

// The state is taken off its member, and is ready again for a new brief or for the main conversation.
export const memberOff = (r: Run, id: string, why: string, t: string, now: number): Run =>
  ({ ...offMember(r, id), tasks: closeVisit(r.tasks, id, now), log: [...r.log, { t, icon: '⚠', tone: 'err', text: `${id} · member taken off · ${why}` }] })

// A member's work passed its check and is applied to the project: its state is done.
export function memberIn(r: Run, id: string, outcome: string | undefined, t: string, now: number): Run {
  if (!r.running?.[id]) return r
  return { ...offMember(r, id), done: [...doneOf(r), id], tasks: closeVisit(r.tasks, id, now, clip(outcome)), log: [...r.log, { t, icon: '⇇', tone: 'ok', text: `${id} · member work applied` }] }
}

const offMember = (r: Run, id: string): Run => ({ ...r, running: Object.fromEntries(members(r).filter(([k]) => k !== id)) })

export function startMember(r: Run, id: string, m: Omit<Member, 'since'>, t: string, now: number): Run {
  return {
    ...r,
    running: { ...r.running, [id]: { ...m, since: now } },
    tasks: { ...r.tasks, [id]: { visits: [...(taskIn(r.tasks, id)?.visits ?? []), { from: now, by: 'member' }] } },
    log: [...r.log, { t, icon: '⇉', tone: 'acc', text: `${id} · member started` }],
  }
}

const members = (r: Run) => Object.entries(r.running ?? {})
// The state whose member works in the worktree that holds `file`. Any agent there, a member's helper too, meets that state's scope.
export function memberByFile(r: Run, file: string): string | undefined {
  const name = /^(?:.*\/)?\.claude\/worktrees\/([^/]+)\/./.exec(file.replace(/\\/g, '/'))?.[1]
  return name ? members(r).find(([, m]) => m.name === name)?.[0] : undefined
}
export const memberByAgent = (r: Run, agent?: string) => (agent ? members(r).find(([, m]) => m.agent === agent)?.[0] : undefined)

// ---- tokens ----

// Counted from the sign-off until the plan is complete, whether it runs or is paused.
export const counting = (r: Run) => r.signedOff || !!r.draft || isUnfinished(r)

// A sign-off with nothing under way starts a new count, and the finished plan's sources end with it.
export const freshCount = (r: Run, at: string): Partial<Run> => (counting(r) ? {} : { spend: [], spendFrom: at, sources: undefined, refused: undefined })

// A run rebuilt at the lock keeps the count it had.
const keepCount = (r: Run): Partial<Run> => (r.spend ? { spend: r.spend, spendFrom: r.spendFrom } : {})

type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function addSpend(r: Run, u: Usage, effort: string | undefined, sub: boolean, at: string): Run {
  if (!counting(r)) return r
  const rows = [...(r.spend ?? [])]
  const i = rows.findIndex(x => x.model === u.model && x.effort === effort && x.sub === sub)
  const row: Spend = rows[i] ?? { model: u.model, ...(effort ? { effort } : {}), sub, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const next = {
    ...row, requests: row.requests + 1, input: row.input + u.input_tokens, output: row.output + u.output_tokens,
    cacheRead: row.cacheRead + u.cache_read_input_tokens, cacheWrite: row.cacheWrite + u.cache_creation_input_tokens,
  }
  if (i < 0) rows.push(next)
  else rows[i] = next
  return { ...r, spend: rows, spendFrom: r.spendFrom ?? at }
}

export const tokensOf = (s: Spend) => s.input + s.output + s.cacheRead + s.cacheWrite
// cached: input read back from the prompt cache. uncached: new input, with what was written to the cache.
export const tokenSplit = (S: Spend[]) =>
  S.reduce((a, s) => ({ cached: a.cached + s.cacheRead, uncached: a.uncached + s.input + s.cacheWrite, out: a.out + s.output }), { cached: 0, uncached: 0, out: 0 })

// A prompt the user typed, or a question they answered: what waited on them may go on, and the auto-continue count
// starts again. The user had the floor, so files may have changed.
export const heard = (r: Run, at: number): Run => (isLive(r) ? touched({ ...r, heardAt: at, auto: 0 }) : r)
// When the state was last entered. A resume continues the same entry, so it counts from the visit that entered.
export const enteredAt = (r: Run, id: string) => taskIn(r.tasks, id)?.visits.findLast(v => !v.cont)?.from ?? 0

// ---- the user's OK ----

// The OK a state asks for: before the work (true means that too), or after it.
export const waitOf = (s?: StateDef): Wait | undefined => (s?.wait === 'after' ? 'after' : s?.wait ? 'before' : undefined)
// What the active state asked the user in this visit, if it asked.
export const pendingOf = (r: Run) => {
  const p = r.pending
  return p && p.state === r.active && p.at >= enteredAt(r, p.state) ? p : undefined
}
// The user answered what the active state asked, after it asked: an early "go ahead" doesn't count.
export const answered = (r: Run, kind?: Wait) => {
  if (r.handsFree) return true
  const p = pendingOf(r)
  return !!p && (!kind || p.kind === kind) && (r.heardAt ?? 0) > p.at
}
// Hands-free, from /sentinel hands-free or the dashboard; off takes it back.
export const handsFree = (r: Run, on: boolean, t: string): Run =>
  !isLive(r) || !!r.handsFree === on ? r
    : touched({ ...r, handsFree: on || undefined, log: [...r.log, { t, icon: on ? '✓' : '?', tone: on ? 'ok' : 'ask', text: on ? 'Hands-free: Claude makes the calls that would wait for you' : 'Hands-free off: Claude asks you again' }] })
// What Claude does while the user is hands-free, worded once for every message that says it.
export const HANDS_FREE = 'The user is hands-free and away, so make the calls that would wait for them yourself (a proposal, a review of your own work, a breaking change, a question): pick what you would recommend, record each with decide, and go on. Sentinel lists them for the user to check later.'
// Hands-free, the user is away: Sentinel pushes a stopped turn on a few more times before it gives up.
export const capOf = (r: Run) => (r.handsFree ? 6 : AUTO_CAP)
// Sentinel waits on the user now: a proposal or finished work they haven't answered, or an escalation.
export function waitingOn(r: Run): boolean {
  if (!isLive(r)) return false
  if (pendingOf(r) && !answered(r)) return true
  const e = r.escalatedAt
  return e !== undefined && e >= enteredAt(r, r.active!) && (r.heardAt ?? 0) <= e
}

// A state that asks before it starts takes no edits until the user has answered its proposal.
export function notYet(r: Run): string | undefined {
  const st = isLive(r) ? stateOf(r) : undefined
  if (!st || waitOf(st) !== 'before' || answered(r, 'before')) return undefined
  return pendingOf(r)?.kind === 'before'
    ? `${st.id} waits for the user's answer to your proposal. Stop your turn and wait for them.`
    : `${st.id} asks the user before you start. Call plan with action "propose" and "intent": what you will do there. Then stop your turn; edits open once they answer.`
}
export const shortCount = (n: number) => (n < 1e3 ? String(n) : n < 1e6 ? `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`)

export function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---- paths and scope ----

export function globMatch(glob: string, path: string): boolean {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!/[*?]/.test(g)) {
    const dir = g.replace(/\/$/, '').toLowerCase()
    const p = path.toLowerCase()
    return p === dir || p.startsWith(dir + '/')
  }
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!
    if (ch === '*' && g[i + 1] === '*') {
      i++
      if (g[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i').test(path)
}

// Project-relative path with forward slashes, or undefined when outside the project.
export function relPath(root: string, file: string): string | undefined {
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  // Git Bash spells D:/x as /d/x.
  const f = file.replace(/\\/g, '/').replace(/^\/([a-z])\//i, (m, d: string) => (/^[a-z]:/i.test(r) ? `${d}:/` : m))
  // A worktree agent edits the project's files under .claude/worktrees/<name>/, inside the project or in the main checkout.
  // ponytail: any such path counts as this project's; compare git common dirs if other repos' worktrees get edited from here.
  // The last such folder in the path counts, so a session that itself runs in a worktree maps its members' files too.
  const wt = /^(?:.*\/)?\.claude\/worktrees\/[^/]+\/(.+)$/.exec(f)
  if (wt) return wt[1]
  if (!/^([a-z]:)?\//i.test(f)) return f.replace(/^\.\//, '')
  return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : undefined
}

// A path as the session's list of written files keeps it: absolute, forward slashes, no . or .. parts, lower-cased on
// Windows (a drive letter shows it). A file in a member's worktree counts as the project's, where its work comes back.
export function pathKey(root: string, file: string): string {
  const rel = relPath(root, file)
  const abs = rel === undefined ? file.replace(/\\/g, '/') : `${root.replace(/\\/g, '/').replace(/\/$/, '')}/${rel}`
  const parts: string[] = []
  for (const p of abs.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '.' && (p || !parts.length)) parts.push(p)
  }
  const key = parts.join('/')
  return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key
}

// The model often writes absolute paths. Scope matches project-relative ones, and the views read better with them.
export function relInput(root: string, i: PlanInput): PlanInput {
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prefix = new RegExp(`(${esc(r)}|${esc(r.replace(/^([a-z]):/i, (_, d: string) => `/${d}`))})/`, 'gi')
  const text = (s?: string) => s?.replace(/\\/g, '/').replace(prefix, '')
  const files = (fs?: string[]) => fs?.map(f => relPath(root, f) ?? f)
  return { ...i, source: text(i.source), files: files(i.files), states: i.states?.map(s => ({ ...s, files: files(s.files), ref: text(s.ref) })) }
}

// id: the state whose files count, a member's own when the edit is in its worktree.
export function outOfScope(r: Run, rel: string, root = '', id = r.active): string | undefined {
  const st = stateOf(r, id)
  if (!st || st.files.some(g => globMatch((root && relPath(root, g)) || g, rel))) return undefined
  const allowed = st.files.length ? st.files.join(', ') : 'none: this state edits nothing'
  const fix = id === r.active
    ? `If the plan needs it, call plan with action "amend", the file and a reason; amendments that aren't breaking don't need the user. If a check here failed because of code another state owns, go back along a loop with "advance".`
    : "Only the main conversation can widen a state's files. Stop and say what you need."
  return `${rel} is outside the files of state ${st.id} (${allowed}). ${fix}`
}

// A file of a done state, open to the active state for fixes (from a review, say): the first such state. Not one a
// member works on, nor a skipped one, which has no check to run again. advance runs the fixed state's check.
// ponytail: a done state with a broad glob opens all of it; narrow globs keep fixes narrow.
export function fixOf(r: Run, rel: string, root = ''): string | undefined {
  if (!isLive(r)) return undefined
  const mine = (s?: StateDef) => !!s?.files.some(g => globMatch((root && relPath(root, g)) || g, rel))
  if (Object.keys(r.running ?? {}).some(id => mine(stateOf(r, id)))) return undefined
  const done = doneOf(r)
  return r.plan!.states.find(s => done.includes(s.id) && !r.skipped?.[s.id] && mine(s))?.id
}

// ponytail: path patterns stand in for "breaking"; the model still judges API and data changes itself.
export function breakingKind(file: string): string | undefined {
  if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|pubspec\.yaml)$/i.test(file)) return 'a dependency change'
  if (/(^|\/)(\.github|\.gitlab-ci|\.circleci|\.buildkite)(\/|\.|$)|(^|\/)(Dockerfile|docker-compose[^/]*|Jenkinsfile|vercel\.json|netlify\.toml|fly\.toml)$|(^|\/)\.env/i.test(file)) return 'CI, deploy or secrets config'
  if (/(^|\/)migrations?\//i.test(file)) return 'a schema or data migration'
  if (/(^|\/)(auth|permissions?|rbac|acl)([^/]*\/|[^/]*\.\w+$)/i.test(file)) return 'auth or permissions code'
  return undefined
}

// ---- check output ----

const flat = (s: string) => s.trim().replace(/\s+/g, ' ')
// Claude Code drops a leading `cd <dir> &&` when the shell is already there, so compare without it.
const bare = (s: string) => flat(s).replace(/^cd (?:"[^"]*"|'[^']*'|\S+) ?&& ?/, '')
export const sameCommand = (a: string, b: string) => bare(a) === bare(b)
// The same command as written, its `cd` too.
export const sameText = (a: string, b: string) => a.trim() === b.trim()

const BAD = /fail|error|expected|received|assert|✗|✕|×|panic|exception|traceback/i
const ZERO = /\b0 (failed|failing|errors?|failures?)\b/i
const COUNT = /^\W*(tests?|test files|suites?)?:?\s*\d+\s+(failed|failing|passed)\b/i

const normLine = (line: string) => line
  .replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/g, '')
  .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min)\b/gi, '')
  .replace(/0x[0-9a-f]+/gi, '')
  .replace(/:\d+:\d+\b/g, '')
  .replace(/\S*(\/tmp\/|\\temp\\|\/temp\/)\S*/gi, '')
  .replace(/\(\s*\)/g, '')
  .replace(/\s+/g, ' ')
  .trim()

// A failing run's identity: the failure lines with times, durations, addresses,
// line:col and temp paths removed, so the same failure hashes the same.
export function failSig(output: string): { sig: string; sigText: string; fails: number } {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map(normLine).filter(Boolean)
  const bad = lines.filter(l => BAD.test(l) && !ZERO.test(l))
  const counts = [...output.matchAll(/(\d+)\s+(?:tests?\s+)?(?:failed|failing|failures?|errors?|problems?)\b/gi)].map(m => Number(m[1]))
  return {
    sig: fnv((bad.length ? bad : lines.slice(-20)).join('\n')),
    sigText: (bad.find(l => !COUNT.test(l)) ?? bad[0] ?? lines.at(-1) ?? 'no output').slice(0, 120),
    fails: counts.length ? Math.max(...counts) : Math.max(1, bad.length),
  }
}

// ---- the ledger ----

// fix: the done state an edit fixes. tail: the end of a check's output.
export type Observed =
  | { kind: 'plan' | 'ask' | 'look'; label: string; denied?: boolean; fp?: string }
  | { kind: 'edit'; label: string; file: string; ver?: string; before?: string; denied?: boolean; fix?: string }
  | { kind: 'check'; label: string; pass: boolean; sig: string; sigText: string; fails: number; touches?: number; tail?: string }

// The end of a check's output, which a refusal shows.
export const tailOf = (text: string) => text.replace(/\n?\[sentinel\] exit \d+\s*$/, '').trim().slice(-1500)

const AUDIT_ON: Partial<Record<Kind, [AuditKind, AuditKind]>> = { ask: ['blocked', 'asked'], plan: ['refused', 'refused'], edit: ['refused', 'refused'] }

export function observe(r: Run, o: Observed, t: string): { run: Run; note?: string; trapped?: Trap } {
  if (!isLive(r)) return { run: r }
  const step = r.step + 1
  const state = r.active!
  let visit = visitOf(r)
  const lastCheck = visit.findLast(c => c.kind === 'check')
  const failing = lastCheck !== undefined && !lastCheck.pass
  const c: Call = { step, t, state, kind: o.kind, label: o.label, u: 0, n: 0, S: 0, R: 0, p: 0, H: 1 }
  const audit = [...r.audit]
  const log = [...r.log]
  let lastFail = r.lastFail

  if (o.kind === 'check') {
    if (!o.pass && o.tail) lastFail = { step, text: o.tail }
    Object.assign(c, { pass: o.pass, sig: o.sig, sigText: o.sigText, fails: o.fails })
    // Something touched the project while it ran: the result may be stale already.
    if (o.touches !== undefined && o.touches === (r.touches ?? 0)) c.touches = o.touches
    if (o.pass || !lastCheck || lastCheck.pass) c.u = 1
    else if (lastCheck.sig === o.sig && o.fails >= (lastCheck.fails ?? 0)) {
      c.repeat = true
      c.same = true
      // Edits since the last run were credited on faith; the same failure takes it back.
      visit = visit.map(x => (x.prov && x.step > lastCheck.step ? { ...x, u: 0, prov: undefined, revoked: true } : x))
    } else c.u = 1
    log.push(o.pass
      ? { t, icon: '✓', tone: 'ok', text: 'Check passed' }
      : { t, icon: '×', tone: 'err', text: `Check failed${c.same ? ' again' : ''} · ${o.sigText.slice(0, 60)}` })
  } else if (o.denied) {
    c.denied = true
    if (o.kind === 'edit') c.file = o.file
    const kinds = AUDIT_ON[o.kind]
    if (kinds) audit.push({ step, t, state, kind: kinds[0], text: o.kind === 'edit' ? `Edit refused: ${o.file} is out of scope` : o.kind === 'ask' ? `Question blocked: ${o.label}` : `${o.label} refused` })
  } else if (o.kind === 'edit') {
    c.file = o.file
    if (o.before) c.before = o.before
    if (o.fix) {
      if (!visit.some(x => x.fix === o.fix)) log.push({ t, icon: '+', tone: 'warn', text: `${state} · fixing ${o.fix}` })
      c.fix = o.fix
    }
    if (o.ver === undefined) c.u = 0
    else {
      c.ver = o.ver
      const seen = visit.find(x => x.file === o.file && (x.ver === o.ver || x.before === o.ver))
      if (seen) {
        c.repeat = true
        c.revisitOf = seen.step
      } else {
        c.u = 1
        if (failing) c.prov = true
      }
    }
  } else if (o.kind === 'look') {
    c.fp = o.fp
    if (visit.some(x => x.fp === o.fp)) c.repeat = true
    else c.u = 1
    let reads = 1
    for (let i = visit.length - 1; i >= 0 && visit[i]!.kind === 'look'; i--) reads++
    if (failing && reads > 4) {
      c.u = 0
      c.drift = true
    }
  } else {
    c.u = 1
    if (o.kind === 'ask') audit.push({ step, t, state, kind: 'asked', text: o.label })
  }

  const all = [...visit, c]
  const win = all.slice(-K)
  c.n = win.length
  c.S = 1 - win.reduce((a, x) => a + x.u, 0) / win.length
  c.R = win.filter(x => x.repeat).length / win.length
  const checks = all.filter(x => x.kind === 'check')
  const last = checks.at(-1)
  if (!last) c.p = 0.5
  else if (last.pass) c.p = 0
  else {
    const ref = checks.findLast(x => x.step < win[0]!.step) ?? checks[0]!
    c.p = ref.sig === last.sig ? 1 : 0.5
  }
  c.H = 1 - c.p * Math.max(c.S, c.R)

  let traps = r.traps
  let note: string | undefined
  let trapped: Trap | undefined
  const open = openTrap(r)
  if (!open && c.n >= K && c.H <= THETA) {
    const rev = win.findLast(x => x.revisitOf !== undefined)
    const pattern = rev ? 'cycle' : win.some(x => x.drift) ? 'drift' : 'static'
    trapped = { state, pattern, step, notes: 1, lastNote: step }
    if (rev) Object.assign(trapped, { file: rev.file, ver: rev.ver, revisitOf: rev.revisitOf })
    traps = [...traps, trapped]
    c.trapStart = true
    log.push({ t, icon: '⟲', tone: 'err', text: `Stuck · ${pattern}${rev ? ` on ${rev.file}` : ''}` })
  } else if (open && c.H > THETA) {
    traps = traps.map(x => (x === open ? { ...x, end: step } : x))
    log.push({ t, icon: '✓', tone: 'ok', text: `Released · health ${c.H.toFixed(2)}` })
  } else if (open && step - open.lastNote >= K) {
    trapped = { ...open, notes: open.notes + 1, lastNote: step }
    traps = traps.map(x => (x === open ? trapped! : x))
  }

  const calls = [...r.calls.filter(x => x.step <= r.enteredAt), ...all].slice(-MAX_CALLS)
  const run: Run = { ...r, step, calls, traps, audit, log: log.slice(-60), ...(lastFail ? { lastFail } : {}) }
  if (trapped) note = noteText(run, trapped, c.H)
  return { run, note, trapped }
}

function noteText(r: Run, trap: Trap, H: number): string {
  const st = stateOf(r, trap.state)
  const fails = visitOf(r).filter(x => x.kind === 'check' && !x.pass)
  const last = fails.at(-1)
  const lines = [`[sentinel] Stuck: ${trap.pattern.toUpperCase()} in state ${trap.state} (health ${H.toFixed(2)}).`]
  if (trap.file && trap.ver) lines.push(`${trap.file} is back to ${verLabel(r.calls, trap.file, trap.ver)}, a version it already had at step ${trap.revisitOf}. That version already failed the check.`)
  if (last && st?.check) {
    const same = fails.filter(x => x.sig === last.sig).map(x => x.step)
    lines.push(`Gap: \`${st.check}\` fails "${last.sigText}" on ${same.length} run(s) (steps ${same.join(', ')}).`)
  }
  if (trap.pattern === 'drift') lines.push('You have been reading without changing anything while the check fails. Make the smallest edit that tests your current idea, then run the check.')
  else lines.push("Until the failure changes, don't re-apply versions that already failed. Get new evidence before the next edit: read code you haven't read in this state, or log the value that comes out wrong.")
  if (trap.notes >= 2) lines.push(`This is note ${trap.notes}. If the next attempts don't change the failure, call plan with action "escalate" and kind "stuck".`)
  return lines.join('\n')
}

// v0 is the file as it was before its first edit in the plan; v1, v2... each new content after.
export function verLabel(calls: Call[], file: string, ver?: string): string {
  if (!ver) return '·'
  const seen: string[] = []
  let base = false
  for (const c of calls) {
    if (c.file !== file) continue
    if (!seen.length && c.before) {
      seen.push(c.before)
      base = true
    }
    if (c.ver && !seen.includes(c.ver)) seen.push(c.ver)
  }
  const i = seen.indexOf(ver)
  return i < 0 ? 'v?' : `v${base ? i : i + 1}`
}

// ---- the plan tool ----

export type Acted = { run: Run; text: string; ok: boolean; event?: 'locked' | 'drafted' | 'complete' }
// Results of the checks of states done before the lock, keyed by command.
export type Proofs = Record<string, { pass: boolean; sigText: string }>

// A refusal leaves the run as it was, apart from a define kept for the sign-off.
const refuse = (r: Run, text: string): Acted => ({ run: r, text, ok: false })

// now: the wall clock in ms, for the times on the task pages. typed: the user typed a prompt in this turn, or typed
// /sentinel skip, or pressed Skip on the dashboard; only then may a state be skipped. without: the rerun of the
// active state's check without its code changes, for an advance.
export function act(r: Run, i: PlanInput, t: string, proofs: Proofs = {}, now = Date.now(), typed = false, without?: Without): Acted {
  if (i.action === 'define') return define(r, i, t, proofs, now)
  if (i.action === 'revise') {
    if (addsMidRun(r)) return addStates(r, i, t)
    const whole = revised(r, i)
    if (typeof whole === 'string') return refuse(r, whole)
    const a = define(r, whole, t, proofs, now)
    const kept = [...new Set((r.held?.states ?? []).filter(s => s.flow && !(i.order ?? []).some(id => id.trim() === idOf(s))).map(s => s.flow!.as))]
    return a.ok && kept.length ? { ...a, text: `${a.text}\nKept the flows the user added: ${kept.join(', ')}. Only the user removes them.` } : a
  }
  if (i.action === 'status') return { run: r, text: status(r), ok: true }
  if (!isLive(r)) {
    if (r.paused) return refuse(r, 'The user paused Sentinel. Work as they ask; they resume the plan with /sentinel resume.')
    return refuse(r, r.active === 'done' ? 'The plan is complete. A new plan needs a new sign-off.' : 'No plan is locked.')
  }
  if (i.action === 'advance') return advance(r, i, t, now, proofs, false, without)
  if (i.action === 'propose') return propose(r, i, t, now)
  if (i.action === 'skip') return skip(r, i, t, now, proofs, typed)
  if (i.action === 'amend') return amend(r, i, t)
  if (i.action === 'decide') return decide(r, i, t)
  if (i.action === 'escalate') return escalate(r, i, t, now)
  return refuse(r, `Unknown action "${i.action}". Use define, revise, advance, brief, propose, skip, amend, decide, escalate or status.`)
}

// A state that asks before it starts: what the model will do there goes to the user, who answers in the chat or on
// the dashboard. Proposing again asks again.
function propose(r: Run, i: PlanInput, t: string, now: number): Acted {
  const st = stateOf(r)!
  if (waitOf(st) !== 'before') return refuse(r, `${st.id} doesn't ask the user before it starts, so there is nothing to propose. Work on it, and advance when it's done.`)
  const intent = clip(i.intent, 1500)
  if (!intent) return refuse(r, 'propose needs "intent": what you will do in this state, in plain words.')
  const run: Run = {
    ...r, pending: { state: st.id, at: now, step: r.step + 1, kind: 'before', text: intent },
    audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'asked', text: `Proposed: ${intent}` }],
    log: [...r.log, { t, icon: '?', tone: 'ask', text: `${st.id} · asks for your OK` }],
  }
  if (r.handsFree) {
    return { run: { ...run, audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'decided', text: `Went ahead hands-free: ${intent}` }] }, ok: true,
      text: `The user is hands-free, so go ahead with ${st.id} as proposed. Sentinel lists it for them to check later.` }
  }
  return { run, ok: true, text: `The user sees your proposal above the prompt and on the dashboard. Put it in your reply too, then stop your turn and wait. Edits in ${st.id} open once they answer; if they ask for changes, propose again.` }
}

// The user skips a state: the active one moves on, a later one no longer has to run, and a done one keeps its work. A
// skipped state counts as done for the states that need it. Hands-free, Claude may skip the state it is stuck in.
function skip(r: Run, i: PlanInput, t: string, now: number, proofs: Proofs, typed: boolean): Acted {
  const id = (i.to ?? '').trim()
  if (!typed && !r.handsFree) return refuse(r, 'Only the user skips a state. Call skip in the turn where they ask for it in the chat; they can also type /sentinel skip <state> or press Skip on its task page.')
  const why = typed ? undefined : freeSkip(r, id) ?? (i.reason?.trim() ? undefined : 'skip needs a reason: what you tried, and what is left for the user.')
  if (why) return refuse(r, why)
  const st = stateOf(r, id)
  if (!st) return refuse(r, `"${id}" is not one of the states.`)
  if (r.skipped?.[id]) return refuse(r, `${id} is skipped already.`)
  if (r.running?.[id]) return refuse(r, `A member agent is working on ${id}. Skip it once Sentinel says it is in.`)
  const reason = clip(i.reason) ?? 'The user skipped it.'
  const marked: Run = {
    ...r, skipped: { ...r.skipped, [id]: reason },
    audit: [...r.audit, { step: r.step + 1, t, state: id, kind: 'decided', text: typed ? `Skipped ${id}: ${reason}` : `Skipped ${id} hands-free, for you to finish later: ${reason}` }],
    log: [...r.log, { t, icon: '–', tone: 'dim', text: `${id} · skipped` }],
  }
  if (id !== r.active) {
    const done = doneOf(r)
    const run: Run = { ...marked, done: done.includes(id) ? done : [...done, id] }
    return { run, ok: true, text: `Skipped ${id}. It counts as done for the states that need it.\n${here(run)}` }
  }
  const next = nextOf(marked, st)
  if (next === undefined) return refuse(r, `Every state after ${id} needs work that members are still doing. Skip ${id} once they are in.`)
  const a = advance(marked, { action: 'advance', to: next, outcome: `Skipped: ${reason}` }, t, now, proofs, true)
  return a.ok ? { ...a, text: `Skipped ${id}. ${a.text}` } : a
}

// Hands-free, Claude may skip the state it is in once it has escalated it as stuck, unless a later state builds on it
// (names it in its own needs). The listed order alone is no reason to keep going: Claude judges whether the states
// after it can be built and tested without it. A string says why not.
function freeSkip(r: Run, id: string): string | undefined {
  if (id !== r.active) return 'Hands-free, you may skip only the state you are in.'
  if (!r.audit.some(a => a.kind === 'escalated' && a.state === id && a.step > r.enteredAt && a.text.startsWith('Stuck'))) {
    return `Hands-free, you may skip ${id} only once it is stuck: escalate with kind "stuck" first.`
  }
  const on = builtOn(r, id)
  return on.length ? `${on.join(', ')} ${on.length === 1 ? 'builds' : 'build'} on ${id}, so it can't be skipped. End your turn: the run waits for the user.` : undefined
}
// The unfinished states that name `id` in their own needs.
const builtOn = (r: Run, id: string) => r.plan!.states.filter(s => s.needs?.includes(id) && !doneOf(r).includes(s.id)).map(s => s.id)

// The draft's define with a revise applied: states in the new order, each the one sent or else the draft's own.
// Loops, title, source, start, decisions and depth stay unless sent. A string says why it can't be done.
export function revised(r: Run, i: PlanInput): PlanInput | string {
  const base = r.draft && r.held
  if (!base) return 'There is no draft to revise. Send the whole plan with define.'
  const order = (i.order ?? []).map(id => id.trim())
  if (!order.length) return 'revise needs "order": every state id of the plan, in order.'
  // Flows are the user's: a state of one the new order leaves out goes back in after the state it followed.
  for (const [k, s] of (base.states ?? []).entries()) {
    if (!s.flow || order.includes(idOf(s))) continue
    const prev = (base.states ?? []).slice(0, k).map(idOf).findLast(id => order.includes(id))
    order.splice(prev === undefined ? 0 : order.indexOf(prev) + 1, 0, idOf(s))
  }
  const sent = new Map((i.states ?? []).map(s => [(s.id ?? '').trim(), s]))
  const had = new Map((base.states ?? []).map(s => [(s.id ?? '').trim(), s]))
  const stray = [...sent.keys()].find(id => !order.includes(id))
  if (stray !== undefined) return `"${stray}" is in states but not in order. Add it to order, or leave it out of states.`
  const unknown = order.find(id => !sent.has(id) && !had.has(id))
  if (unknown !== undefined) return `${unknown} is not in the draft. Send it whole in states.`
  const loops = i.loops ?? base.loops
  const cut = loops?.find(l => l.some(id => !order.includes(id)))
  if (cut) return `The loop ${cut.join(' → ')} ends at a state the new order leaves out. Send "loops" as they should be.`
  return {
    ...base, action: 'define', states: order.map(id => sent.get(id) ?? had.get(id)!), loops,
    title: i.title ?? base.title, source: i.source ?? base.source, start: i.start ?? base.start, decisions: i.decisions ?? base.decisions, named: i.named, messages: i.messages,
    ...(i.depth ? { depth: i.depth } : {}),
  }
}

// final: say what the plan's instructions ask before it completes even when the active state isn't the last.
function here(r: Run, final = false): string {
  const skipped = Object.keys(r.skipped ?? {})
  if (r.active === 'done') return `Plan complete.${skipped.length ? ` The user skipped ${skipped.join(', ')}.` : ''} Questions are open again.`
  const st = stateOf(r)
  if (!st) return ''
  return [
    `Active: ${st.id} (${st.label}).`,
    st.check ? `Done when \`${st.check}\` exits 0. advance runs it from the project root.` : 'No check: advance with evidence once you have read what you need.',
    waitOf(st) === 'before' ? 'It asks the user first: call propose with your intent, stop your turn, and start once they answer.'
      : waitOf(st) === 'after' ? 'The user reviews it when it is done: advance tells them, then stop your turn until they answer.' : '',
    `Files you may edit: ${st.files.length ? st.files.join(', ') : 'none in this state'}.`,
    st.ref ? `Details: ${st.ref}` : '',
    askedLine(st),
    // The final instructions come at the lock, and again once this is the last state left.
    toldHere(r, st, final || r.plan!.states.every(s => s.id === st.id || doneOf(r).includes(s.id))),
  ].filter(Boolean).join('\n')
}

// What a state came from, handed back as it starts: Claude rereads what was asked just before doing the work.
export const askedLine = (st: StateDef) =>
  st.asked?.length ? `Asked for: ${st.asked.map(q => `"${q}"`).join(' ')}` : st.added ? `Nothing asked for this; you added it because: ${st.added}` : ''

const MAX_QUOTE_WORDS = 60
const MAX_REFUSED = 30
const shown = (q: string) => clip(q, 240)!
const REFUSALS: Record<Exclude<Refused['why'], 'none'>, (q: string) => string> = {
  missing: q => `"${shown(q)}" isn't in the sources, word for word.`,
  short: q => `"${shown(q)}" is too short to count: quote at least ${MIN_WORDS} words, or a whole message.`,
  excluded: q => `"${shown(q)}" comes from a part of the plan marked out of scope, so it doesn't show this was asked for.`,
  empty: q => `"${shown(q)}" has no words in it.`,
  long: q => `"${shown(q)}" is over ${MAX_QUOTE_WORDS} words. Quote the sentence that asks for this state.`,
}
// A refusal first: the rarer verdict says more than "missing" from every other source does.
const RANK: Record<string, number> = { missing: 0, short: 1, excluded: 2, empty: 3 }

// Each state says where it came from, and Sentinel compares the words itself. A state a flow put in is the user's own, one
// done before the lock has nothing left to prove, and one that is only there for a depth answer goes if they leave it unticked.
// Sets asked or added on `states`. used: the sources to keep, which take a typed message only if a quote needs it.
function proofOf(i: PlanInput, states: StateDef[], at: number, depth: Depth[], kept: Source[], t: string): { used: Source[]; refused: Refused[]; text: string } {
  const typed: Source[] = (i.messages ?? []).map(m => ({ kind: 'message' as const, text: m.text, at: m.at })).reverse()
  const docs = [...kept, ...typed]
  const used = [...kept]
  const refused: Refused[] = []
  const lines: string[] = []
  const exempt = new Set([...states.slice(0, at).map(s => s.id), ...states.filter(s => s.flow).map(s => s.id), ...depth.flatMap(d => d.state ?? [])])
  for (const [k, st] of states.entries()) {
    if (exempt.has(st.id)) continue
    const sent = i.states![k]!
    const asked = Array.isArray(sent.asked) ? sent.asked.filter((q): q is string => typeof q === 'string' && !!q.trim()).map(q => q.trim()) : []
    if (!asked.length) {
      const added = clip(sent.added, 300)
      if (added) states[k] = { ...st, added }
      else {
        refused.push({ state: st.id, why: 'none', t })
        lines.push(`- ${st.id} has neither "asked" nor "added".`)
      }
      continue
    }
    states[k] = { ...st, asked }
    for (const q of asked) {
      let why: Refused['why'] = squash(q).split(' ').length > MAX_QUOTE_WORDS ? 'long' : 'missing'
      const from = why === 'long' ? undefined : docs.find(d => {
        const v = checkQuote(d.text, q)
        if (v !== 'ok' && RANK[v]! > RANK[why]!) why = v
        return v === 'ok'
      })
      if (from) {
        if (!used.includes(from)) used.push(from)
        continue
      }
      // What goes on the record is saved, so its nearest passage comes from what is saved already, never an unused message.
      const near = why === 'missing' ? nearest(kept.map(d => d.text).join('\n'), q) : ''
      const told = why === 'missing' ? nearest(docs.map(d => d.text).join('\n'), q) : ''
      refused.push({ state: st.id, quote: shown(q), why, ...(near ? { nearest: near } : {}), t })
      lines.push(`- ${st.id}: ${REFUSALS[why](q)}${told ? ` Nearest: "${shown(told)}".` : ''}`)
    }
  }
  const text = [
    docs.length ? "Sentinel compared each state's quotes with the sources and refused these:" : 'There is nothing to compare quotes with yet: no approved plan, readable file or typed message.',
    ...lines,
    `Copy the words exactly, capitals too. The plan approved in plan mode, files from before this session and the user's typed messages count. A file you wrote in this session doesn't count until the user approves it in plan mode. If nothing asked for a state, send "added" with your reason, and it shows as your addition. Then send it again.`,
  ].join('\n')
  return { used, refused, text }
}

// The sources a define starts from: what a plan-mode sign-off saved, or a draft's own. A draft made while a plan runs
// takes none of that plan's, which stay on the run until the draft locks.
// ponytail: an approval followed by /sentinel lock while a plan runs loses the approved text, since nothing tells it from
// the running plan's sources; mark the sign-off's sources if that route shows up.
export const keptSources = (r: Run): Source[] | undefined => (!r.review ? r.sources : r.draft ? r.draft.sources : isUnfinished(r) ? undefined : r.sources)

// One state as sent. A string says what is wrong. proofOf sets asked and added; okAt and look are Sentinel's own.
function stateFrom(s: NonNullable<PlanInput['states']>[number]): StateDef | string {
  const id = (s.id ?? '').trim()
  if (!/^[A-Za-z0-9][\w-]*$/.test(id) || id === 'done') return `Bad state id "${id}": use letters, digits, - and _, and not "done".`
  const check = s.check?.trim()
  const ref = s.ref?.trim()
  const group = s.group?.trim()
  const title = clip(s.title, 80)
  const problem = clip(s.problem)
  const approach = clip(s.approach)
  const needs = s.needs && [...new Set(s.needs.map(n => n.trim()).filter(Boolean))]
  if (group && !/^[A-Za-z0-9][\w-]*(\/[A-Za-z0-9][\w-]*)*$/.test(group)) return `Bad group "${group}" on ${id}: use letters, digits, - and _, with / for a group inside a group.`
  if (s.wait !== undefined && ![true, false, 'before', 'after'].includes(s.wait)) return `wait on ${id} is "before" (the user OKs your plan for it first) or "after" (they review the finished work).`
  const wait: Wait | undefined = s.wait === 'after' ? 'after' : s.wait ? 'before' : undefined
  const flow = typeof s.flow?.name === 'string' && typeof s.flow.as === 'string' ? { name: s.flow.name, as: s.flow.as, why: String(s.flow.why ?? '') } : undefined
  return { id, label: s.label?.trim() || id, ...(check ? { check } : {}), files: (s.files ?? []).map(f => f.trim()).filter(Boolean), ...(ref ? { ref } : {}), ...(group ? { group } : {}), ...(title ? { title } : {}), ...(problem ? { problem } : {}), ...(approach ? { approach } : {}), ...(wait ? { wait } : {}), ...(needs ? { needs } : {}), ...(flow ? { flow } : {}) }
}

// What is wrong with these states as a plan. Nothing can run beside a state in `done`, so it can't share files with one.
function statesProblem(states: StateDef[], done: string[] = []): string | undefined {
  const index = (id: string) => states.findIndex(s => s.id === id)
  const twice = states.find((s, k) => index(s.id) < k)
  if (twice) return `State id "${twice.id}" is used twice.`
  for (const s of states) {
    const unknown = s.needs?.find(n => index(n) < 0)
    if (unknown) return `${s.id} needs "${unknown}", which is not one of the states.`
  }
  const circle = states.filter(s => upstream(states, s.id).has(s.id)).map(s => s.id)
  if (circle.length) return `The needs go round in a circle through ${circle.join(', ')}. A state can't wait for itself.`
  for (const [k, s] of states.entries()) {
    const later = s.needs?.find(n => index(n) > k)
    if (later) return `${s.id} needs ${later}, which is listed after it. One at a time, states run in the listed order, so list ${later} before ${s.id}.`
  }
  // Two states where neither needs the other can run at the same time, so they can't share files.
  for (const [k, a] of states.entries()) {
    if (done.includes(a.id)) continue
    for (const b of states.slice(k + 1)) {
      if (done.includes(b.id) || upstream(states, b.id).has(a.id)) continue
      const f = a.files.find(x => b.files.some(y => globsMeet(x, y)))
      if (f) return `${a.id} and ${b.id} can run at the same time (neither needs the other), and both may edit ${f}. Make one need the other, or split the files between them.`
    }
  }
  return undefined
}

function loopsFrom(raw: PlanInput['loops'], states: StateDef[]): [string, string][] | string {
  const loops: [string, string][] = []
  for (const l of raw ?? []) {
    const [from, to] = l
    const known = (id?: string) => states.some(s => s.id === id)
    if (!from || !to || from === to || !known(from) || !known(to)) return `Bad loop ${JSON.stringify(l)}: both ends must be different state ids.`
    loops.push([from, to])
  }
  return loops
}

// A plan that runs can gain a state only while the comparison is on, since that is what shows where the state came from.
export const addsMidRun = (r: Run) => isLive(r) && !r.draft && !!r.library?.on.includes('quote-the-source')

// What a state's globs can reach on the breaking list: the glob itself, or a wide one over a path on it.
// ponytail: src/** can still reach src/auth/x.ts without a stop; check at the edit if that bites.
const BREAKING_SAMPLES = ['package.json', '.github/x.yml', '.env', 'migrations/x.sql', 'auth/x.ts']
const reachOf = (files: string[]) => files.map(f => breakingKind(f) ?? breakingKind(BREAKING_SAMPLES.find(p => globMatch(f, p)) ?? '')).find(Boolean)

const FIXED_MID_RUN = ['title', 'source', 'start', 'decisions', 'depth'] as const

// States added while the plan runs. The rest stays as the user locked it and the work carries on: a state with a quote
// goes in, one Claude added goes in tagged with its reason, and that one stops at its start if it can reach a risky path.
function addStates(r: Run, i: PlanInput, t: string): Acted {
  const had = r.plan!.states
  const ids = had.map(s => s.id)
  const order = (i.order ?? []).map(id => id.trim())
  if (!order.length) return refuse(r, 'revise needs "order": every state id of the plan, in order.')
  const fixed = FIXED_MID_RUN.find(k => i[k] !== undefined)
  if (fixed) return refuse(r, `While a plan runs, revise only adds states, so "${fixed}" can't change.`)
  const sent = i.states ?? []
  const fresh: StateDef[] = []
  for (const s of sent) {
    // A flow's state skips the comparison because it is the user's own, and only the user adds those.
    const st = stateFrom({ ...s, flow: undefined })
    if (typeof st === 'string') return refuse(r, st)
    if (ids.includes(st.id)) return refuse(r, `${st.id} is already in the plan. While a plan runs, revise only adds states; amend changes the active one.`)
    if (!order.includes(st.id)) return refuse(r, `"${st.id}" is in states but not in order. Add it to order, or leave it out of states.`)
    fresh.push(st)
  }
  const unknown = order.find(id => !ids.includes(id) && !fresh.some(s => s.id === id))
  if (unknown !== undefined) return refuse(r, `${unknown} is not in the plan. Send it whole in states.`)
  if (order.filter(id => ids.includes(id)).join() !== ids.join()) return refuse(r, 'While a plan runs, revise only adds states, so order keeps every state of the plan in its place. Only the user skips one.')
  if (!fresh.length) return refuse(r, 'Nothing to add: states has no new state. amend changes the active one.')
  const last = Math.max(...[r.active!, ...Object.keys(r.running ?? {})].map(id => order.indexOf(id)))
  if (fresh.some(s => order.indexOf(s.id) < last)) return refuse(r, 'New states go after the active state and any state a member is working on.')
  const inOrder = () => order.map(id => fresh.find(s => s.id === id) ?? had.find(s => s.id === id)!)
  const problem = statesProblem(inOrder(), doneOf(r))
  if (problem) return refuse(r, problem)
  const more = loopsFrom(i.loops, inOrder())
  if (typeof more === 'string') return refuse(r, more)
  const proof = proofOf({ ...i, states: sent }, fresh, 0, [], r.sources ?? [], t)
  if (proof.refused.length) return refuse({ ...r, refused: [...(r.refused ?? []), ...proof.refused].slice(-MAX_REFUSED) }, proof.text)
  for (const [k, s] of fresh.entries()) {
    const look = s.added ? reachOf(s.files) : undefined
    if (look) fresh[k] = { ...s, wait: 'before', look }
  }
  const was = r.plan!.loops
  const run: Run = {
    ...r, ...(proof.used.length ? { sources: proof.used } : {}),
    plan: { ...r.plan!, states: inOrder(), loops: [...was, ...more.filter(l => !was.some(o => o[0] === l[0] && o[1] === l[1]))] },
    audit: [...r.audit, ...fresh.map(s => ({ step: r.step + 1, t, state: s.id, kind: 'amended' as const, text: s.added ? `Added ${s.id} with nothing asking for it: ${s.added}` : `Added ${s.id}, asked for: "${s.asked![0]}"` }))],
    log: [...r.log, ...fresh.map(s => ({ t, icon: '+', tone: 'dim' as const, text: `Added ${s.id}${s.added ? ' · nothing asked for it' : ''}${s.look ? ' · asks you first' : ''}` }))],
  }
  const looks = fresh.filter(s => s.look).map(s => `${s.id} asks the user before it starts, because it could involve ${s.look}.`)
  return { run, ok: true, text: [`Added ${fresh.map(s => s.id).join(', ')} to the plan: ${order.join(' → ')} → done.`, ...looks, here(run)].join('\n') }
}

function define(r: Run, i: PlanInput, t: string, proofs: Proofs, now: number): Acted {
  if (!r.signedOff) {
    const why = 'No sign-off yet. Sentinel locks a plan only after the user approves it in plan mode or types /sentinel lock.'
    // Between plans the define is kept, so the model needn't write it again after the sign-off.
    // One that starts partway is sent again after the lock, so Sentinel can run the checks before its start.
    return isUnfinished(r) ? refuse(r, why)
      : refuse({ ...r, held: i }, priorChecks(i).length ? why : `${why} Sentinel keeps this define. If the user signs off with /sentinel lock, it becomes the draft they check, and you hear when they lock it.`)
  }
  const states: StateDef[] = []
  for (const s of i.states ?? []) {
    const st = stateFrom(s)
    if (typeof st === 'string') return refuse(r, st)
    states.push(st)
  }
  if (!states.length) return refuse(r, 'A plan needs at least one state.')
  const problem = statesProblem(states)
  if (problem) return refuse(r, problem)
  const loops = loopsFrom(i.loops, states)
  if (typeof loops === 'string') return refuse(r, loops)
  const start = i.start?.trim()
  const at = start ? states.findIndex(s => s.id === start) : 0
  if (at < 0) return refuse(r, `start "${start}" is not one of the states.`)
  // States before start were done before the lock: their check has to pass now, or evidence stands in for one.
  for (let k = 0; k < at; k++) {
    const s = states[k]!
    const given = i.states![k]!.evidence?.trim()
    const proof = s.check ? proofs[s.check] : undefined
    if (s.check && !proof) return refuse(r, `Sentinel couldn't run \`${s.check}\` for ${s.id}.`)
    if (proof && !proof.pass) return refuse(r, `${s.id} is listed as done, but \`${s.check}\` fails now: ${proof.sigText}. Start at ${s.id}, or fix it first.`)
    if (!s.check && !given) return refuse(r, `${s.id} is listed as done but has no check, so it needs evidence: a commit, a test run, or what the user confirmed.`)
    states[k] = { ...s, evidence: [given, s.check && `\`${s.check}\` passed at the lock`].filter(Boolean).join('; ') }
  }
  // The user ticks depth items only on a draft they lock themselves; a plan-mode sign-off locks at once.
  const depth = r.review ? depthOf(i.depth, states) : []
  if (typeof depth === 'string') return refuse(r, depth)
  const kept = [...(keptSources(r) ?? []), ...(i.named ? [i.named] : [])]
  const proof = i.library?.on.includes('quote-the-source') ? proofOf(i, states, at, depth, kept, t) : undefined
  if (proof?.refused.length) return refuse({ ...r, refused: [...(r.refused ?? []), ...proof.refused].slice(-MAX_REFUSED) }, proof.text)
  // A state nothing asked for waits for the user's answer, even on a plan they approved. An answer they gave on this
  // draft stands while the reason stays the same.
  const additions = states.filter(s => s.added).map(s => s.id)
  const drafting = r.review || additions.length > 0
  if (r.review) {
    for (const [k, s] of states.entries()) {
      const was = r.draft?.plan?.states.find(x => x.id === s.id)
      if (s.added && was?.okAt && was.added === s.added) states[k] = { ...s, okAt: was.okAt }
    }
  }
  const audit: Audit[] = []
  for (const d of i.decisions ?? []) {
    const topic = d.topic?.trim()
    const choice = d.choice?.trim()
    if (!topic || !choice) return refuse(r, 'Each decision needs a topic and a choice.')
    audit.push({ step: 0, t, kind: 'decided', text: `${topic} → ${choice}${d.reason?.trim() ? ` (${d.reason.trim()})` : ''}` })
  }
  const source = i.source?.trim()
  const plan: Plan = { title: i.title?.trim() || 'Plan', states, loops, lockedAt: t, ...(source ? { source } : {}) }
  const prior = states.slice(0, at).map(s => s.id)
  const log: LogLine[] = [{ t, icon: '●', tone: 'acc', text: `${drafting ? 'Drafted' : 'Plan locked'} · ${states.length} states, ${loops.length} loop${loops.length === 1 ? '' : 's'}` }]
  if (prior.length) log.push({ t, icon: '✓', tone: 'ok', text: `Done before the lock · ${prior.join(', ')}` })
  const sources = proof?.used ?? kept
  const run: Run = { ...emptyRun(), plan, active: states[at]!.id, audit, log, startedAt: now, tasks: { [states[at]!.id]: { visits: [{ from: now }] } }, ...(i.library ? { library: i.library } : {}), ...(sources.length ? { sources } : {}), ...(r.refused ? { refused: r.refused } : {}), ...keepCount(r), ...(r.flowDraft && !drafting ? { flowDraft: r.flowDraft } : {}) }
  const rail = `${states.map(s => s.id).join(' → ')} → done`
  const before = prior.length ? `\nDone before the lock: ${prior.join(', ')}.` : ''
  if (drafting) {
    const ticks = depth.length ? ` As they lock it they tick the depth answers they want (${depth.map(d => d.id).join(', ')}); a state named by one they leave unticked comes out.` : ''
    const waits = r.review ? '' : `Nothing the user approved asks for ${additions.join(', ')}, so this waits for their answer instead of locking.\n`
    const text = `${waits}Draft saved: ${rail}, starting at ${run.active}.${before}\nThe user checks it in the Sentinel pane and locks it with /sentinel lock, or tells you what to change (then call revise with what changes).${ticks} Stop here and wait for them.`
    return { run: { ...r, review: true, draft: run, held: { ...i, named: undefined, messages: undefined, depth: depth.length ? depth : undefined }, quiet: true }, ok: true, event: 'drafted', text }
  }
  return { run, ok: true, event: 'locked', text: `Locked "${plan.title}": ${rail}.${before}\n${here(run, true)}` }
}

// A draft's depth answers as the model sent them, checked. A string says what is wrong.
const ASKS = ['expert', 'raw', 'methods', 'proof']
function depthOf(raw: PlanInput['depth'], states: StateDef[]): Depth[] | string {
  const out: Depth[] = []
  for (const d of raw ?? []) {
    const id = typeof d?.id === 'string' ? d.id.trim() : ''
    if (!/^[A-Za-z0-9][\w-]*$/.test(id)) return `Bad depth id "${id}": use letters, digits, - and _, so the user can tick it with /sentinel lock <id>.`
    if (out.some(x => x.id.toLowerCase() === id.toLowerCase())) return `Depth id "${id}" is used twice.`
    const text = clip(d.text, 300)
    if (!text) return `Depth item ${id} needs text: the answer the user ticks.`
    if (d.ask !== undefined && !ASKS.includes(d.ask)) return `ask on depth item ${id} is expert, raw, methods or proof.`
    const state = typeof d.state === 'string' ? d.state.trim() : ''
    if (state && !states.some(s => s.id === state)) return `Depth item ${id} names "${state}", which is not one of the states. Send "depth" again as it should be.`
    out.push({ id, text, ...(d.ask ? { ask: d.ask } : {}), ...(state ? { state } : {}) })
  }
  return out
}

// The checks of the states before `start`; define needs their results.
export function priorChecks(i: PlanInput): string[] {
  const states = i.states ?? []
  const at = states.findIndex(s => s.id?.trim() === i.start?.trim())
  return [...new Set(states.slice(0, Math.max(0, at)).flatMap(s => s.check?.trim() || []))]
}

// ---- flows ----

type InState = NonNullable<PlanInput['states']>[number]
const idOf = (s: { id?: string }) => (s.id ?? '').trim()
const FLOW_NAME = /^[a-z0-9][a-z0-9-]*$/
const AT = ['start', 'end', 'before', 'after']
const strings = (v: unknown) => (Array.isArray(v) ? v : []).filter((g): g is string => typeof g === 'string' && !!g.trim()).map(g => g.trim())

// A flow as the user saved it or the model sent it, checked the way define checks a plan. A string says what is wrong.
export function flowOf(raw: unknown): FlowDef | string {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = typeof f.name === 'string' ? f.name.trim() : ''
  if (!FLOW_NAME.test(name)) return `Bad flow name "${name}": use lowercase letters, digits and -.`
  const states: FlowState[] = []
  for (const x of (Array.isArray(f.states) ? f.states : []) as Record<string, unknown>[]) {
    const id = typeof x?.id === 'string' ? x.id.trim() : ''
    if (!/^[A-Za-z0-9][\w-]*$/.test(id) || id === 'done') return `Bad state id "${id}" in ${name}: use letters, digits, - and _.`
    if (states.some(y => y.id === id)) return `State id "${id}" is used twice in ${name}.`
    const label = clip(x.label)
    if (!label) return `${id} in ${name} needs a label: what it does.`
    if (x.wait !== undefined && ![true, false, 'before', 'after'].includes(x.wait as string)) return `wait on ${id} in ${name} is "before" or "after".`
    const files = strings(x.files)
    const check = clip(x.check, 2000)
    const wait = x.wait === 'after' ? 'after' : x.wait ? 'before' : undefined
    const text = Object.fromEntries((['title', 'problem', 'approach'] as const).flatMap(k => (clip(x[k]) ? [[k, clip(x[k])!]] : [])))
    states.push({ id, label, ...(check ? { check } : {}), ...(files.length ? { files } : {}), ...(wait ? { wait } : {}), ...text })
  }
  if (!states.length) return `${name} needs at least one state.`
  const w = f.when as Record<string, unknown> | undefined | null
  if (w && !AT.includes(w.at as string)) return `when.at in ${name} is start, end, before or after.`
  const files = strings(w?.files)
  const when: FlowWhen | undefined = w ? { at: w.at as FlowWhen['at'], ...(files.length && (w.at === 'before' || w.at === 'after') ? { files } : {}) } : undefined
  const description = clip(f.description, 300)
  return { name, ...(description ? { description } : {}), ...(when ? { when } : {}), states }
}

export const ruleText = (w?: FlowWhen) => !w ? 'when you add it'
  : w.at === 'start' || w.at === 'end' ? `at the ${w.at} of every plan` : `${w.at} ${w.files?.length ? `states that edit ${w.files.join(' ')}` : 'every state'}`

// The flow's states with the placeholders filled in from the state it goes beside, or from the whole plan at the start
// or the end. File globs go into a check quoted, one word each.
function filled(f: FlowDef, t: { id?: string; label: string; files: string[] }, title: string): InState[] {
  const put = (x: string, inCheck = false) => x
    .replaceAll('{{state.id}}', t.id ?? (inCheck ? '' : 'the whole plan')).replaceAll('{{state.label}}', t.label).replaceAll('{{plan.title}}', title)
    .replaceAll('{{state.files}}', (inCheck ? t.files.map(g => `'${g.replaceAll("'", "'\\''")}'`) : t.files).join(' '))
  return f.states.map(s => {
    const check = s.check && put(s.check, true).replace(/\s+--\s*$/, '').replace(/ {2,}/g, ' ').trim()
    const files = (s.files ?? []).flatMap(g => (g === '{{state.files}}' ? t.files : [put(g)]))
    const text = Object.fromEntries((['title', 'problem', 'approach'] as const).flatMap(k => (s[k] ? [[k, put(s[k]!)]] : [])))
    return { id: s.id, label: put(s.label), ...(check ? { check } : {}), files, ...(s.wait ? { wait: s.wait } : {}), ...text }
  })
}

export type Where = { at: FlowWhen['at']; state?: string }

// The draft's define with a flow's states put in at `where`. Their ids start with the flow's name (review-tests), or
// with a number for a second copy (review-2-tests); the group and the flow mark keep it too. Where the plan uses needs,
// they are rewired so the flow sits between the same states it sits between in the list. A string says why it can't
// go there.
export function addFlow(held: PlanInput, f: FlowDef, where: Where, why: string): PlanInput | string {
  const states = held.states ?? []
  const ids = states.map(idOf)
  const first = held.start ? Math.max(0, ids.indexOf(held.start.trim())) : 0
  const side = where.at === 'before' || where.at === 'after'
  const k = side ? ids.indexOf((where.state ?? '').trim()) : -1
  if (side && k < 0) return `"${where.state ?? ''}" is not one of the states.`
  const at = where.at === 'start' ? first : where.at === 'end' ? states.length : where.at === 'before' ? k : k + 1
  if (at < first || (where.at === 'after' && k < first)) return `The plan starts at ${ids[first]}. The states before it were done before the lock, so a flow can't go in among them.`
  let n = 1
  const asOf = (m: number) => (m === 1 ? f.name : `${f.name}-${m}`)
  while (f.states.some(s => ids.includes(`${asOf(n)}-${s.id}`))) n++
  const as = asOf(n)
  const target = side ? states[k] : undefined
  const group = target?.group?.trim() ? `${target.group.trim()}/${as}` : as
  const title = held.title?.trim() || 'this plan'
  const add: InState[] = filled(f, target ? { id: ids[k], label: target.label?.trim() || ids[k]!, files: target.files ?? [] } : { label: title, files: [] }, title)
    .map(s => ({ ...s, id: `${as}-${s.id}`, group, flow: { name: f.name, as, why } }))
  let rest = states
  if (states.some(s => s.needs)) {
    const defs = states.map(s => ({ ...s, id: idOf(s), files: s.files ?? [] })) as StateDef[]
    const last = add.at(-1)!.id!
    const x = ids[k] ?? ''
    add[0]!.needs = where.at === 'after' ? [x] : where.at === 'before' ? needsOf(defs, x)
      : where.at === 'end' ? ids.filter(id => !defs.some(s => needsOf(defs, s.id).includes(id))) : []
    rest = states.map((s, j) => {
      const own = needsOf(defs, ids[j]!)
      if (where.at === 'after' && s.needs?.some(m => m.trim() === x)) return { ...s, needs: s.needs.map(m => (m.trim() === x ? last : m)) }
      if (where.at === 'before' && j === k) return { ...s, needs: [last] }
      if (where.at === 'start' && j >= first && own.every(m => ids.indexOf(m) < first)) return { ...s, needs: [...own, last] }
      return s
    })
  }
  // A plan picked up partway starts at the flow when the flow goes in where it started.
  return { ...held, states: [...rest.slice(0, at), ...add, ...rest.slice(at)], ...(held.start && at === first ? { start: add[0]!.id } : {}) }
}

// The draft's define without one flow the user added: `as`, as its group shows it (review, review-2). States that
// needed it need what it needed.
export function dropFlow(held: PlanInput, as: string): PlanInput | string {
  const gone = (held.states ?? []).filter(s => s.flow?.as === as).map(idOf)
  return gone.length ? dropStates(held, gone) : `No flow "${as}" in the draft.`
}

// The draft's define without the states `gone`: states that needed them need what they needed, loops through them
// go, and a start among them moves to the next state kept.
export function dropStates(held: PlanInput, gone: string[]): PlanInput {
  const states = held.states ?? []
  const ids = states.map(idOf)
  const defs = states.map(s => ({ ...s, id: idOf(s), files: s.files ?? [] })) as StateDef[]
  const outside = [...new Set(gone.flatMap(id => needsOf(defs, id)).filter(m => !gone.includes(m)))]
  const kept = states.filter(s => !gone.includes(idOf(s)))
    .map(s => (s.needs?.some(m => gone.includes(m.trim())) ? { ...s, needs: [...new Set(s.needs.flatMap(m => (gone.includes(m.trim()) ? outside : [m])))] } : s))
  const at = held.start ? ids.indexOf(held.start.trim()) : -1
  const start = at >= 0 && gone.includes(ids[at]!) ? states.slice(at).find(s => !gone.includes(idOf(s))) : undefined
  return { ...held, states: kept, ...(held.loops ? { loops: held.loops.filter(l => !l.some(id => gone.includes(id))) } : {}), ...(start ? { start: idOf(start) } : {}) }
}

// A new plan's define with the user's rules applied: each flow with `when` goes in where the rule says. One already in
// (marked, or by its ids when the model sent them back) is left as it is. many: rules that matched over 5 states.
export function withRules(i: PlanInput, flows: FlowDef[]): { input: PlanInput; added: string[]; many: string[] } {
  let input = i
  const added: string[] = []
  const many: string[] = []
  const own = (i.states ?? []).filter(s => !s.flow)
  for (const f of flows) {
    const w = f.when
    if (!w) continue
    const ids = (input.states ?? []).map(idOf)
    if ((input.states ?? []).some(s => s.flow?.name === f.name) || f.states.some(s => ids.includes(`${f.name}-${s.id}`))) continue
    const hits = w.at === 'start' || w.at === 'end' ? [undefined]
      : own.filter(s => !w.files?.length || (s.files ?? []).some(x => w.files!.some(g => globsMeet(x.trim(), g)))).map(idOf)
    if (hits.length > 5) many.push(`${f.name} (${hits.length} states)`)
    for (const id of hits) {
      const next = addFlow(input, f, { at: w.at, state: id }, `Added by your rule: ${ruleText(w)}`)
      if (typeof next === 'string') continue
      input = next
      added.push(id ? `${f.name} ${w.at} ${id}` : `${f.name} at the ${w.at}`)
    }
  }
  return { input, added, many }
}

// ---- the library ----

const MOMENTS: readonly InstructionAt[] = ['draft', 'start', 'close', 'final', 'always']
export const DEFAULT_WEIGHT: Weight = 'standard'

// An instruction as the user saved it or the model sent it. A string says what is wrong.
export function instructionOf(raw: unknown): InstructionDef | string {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = typeof f.name === 'string' ? f.name.trim() : ''
  if (!FLOW_NAME.test(name)) return `Bad instruction name "${name}": use lowercase letters, digits and -.`
  const at = f.at as InstructionAt
  if (!MOMENTS.includes(at)) return `at in ${name} is draft, start, close, final or always.`
  const text = clip(f.text, 2000)
  if (!text) return `${name} needs text: what Sentinel tells Claude.`
  const files = strings(f.files)
  if (files.length && at !== 'start' && at !== 'close') return `files in ${name} apply only when at is start or close.`
  const description = clip(f.description, 300)
  return { name, ...(description ? { description } : {}), at, ...(files.length ? { files } : {}), text }
}

// Which items are on. A built-in lists the weights that turn it on; the user's own items list none and are on unless
// switched off. A project that picks a weight takes the built-ins over: its switches and that weight decide them.
// Otherwise the project's switch counts first, then the user's, then the user's weight (Standard when neither picked
// one). An item that isn't trusted is off.
export function libraryOn(items: readonly { name: string; weights?: readonly Weight[]; trusted?: boolean }[], project: Switches = {}, personal: Switches = {}): { weight: Weight; on: string[] } {
  const weight = project.weight ?? personal.weight ?? DEFAULT_WEIGHT
  const sw = (s: Switches, name: string) => (s.on && Object.hasOwn(s.on, name) ? s.on[name] : undefined)
  const on = items.filter(it => it.trusted !== false && (it.weights
    ? sw(project, it.name) ?? (project.weight ? undefined : sw(personal, it.name)) ?? it.weights.includes(weight)
    : sw(project, it.name) ?? sw(personal, it.name) ?? true))
  return { weight, on: on.map(it => it.name) }
}

// A switches file with a weight picked: the built-ins' switches go, so the weight sets them; the user's items keep theirs.
export function withWeight(s: Switches, weight: Weight, builtins: readonly string[]): Switches {
  const on = Object.fromEntries(Object.entries(s.on ?? {}).filter(([name]) => !builtins.includes(name)))
  return { weight, ...(Object.keys(on).length ? { on } : {}) }
}

// The plan's told instructions for one moment. Start and close are for states that edit files: the instructions
// without files, and those whose files meet the state's.
export function toldFor(r: Run, at: InstructionAt, st?: StateDef): InstructionDef[] {
  const told = (r.library?.told ?? []).filter(x => x.at === at)
  if (at !== 'start' && at !== 'close') return told
  if (!st?.files.length) return []
  return told.filter(x => !x.files?.length || st.files.some(f => x.files!.some(g => globsMeet(f.trim(), g))))
}

const RULES_WIN = "Where the project's own rules (such as CLAUDE.md) differ from these, the project's rules win."
const block = (head: string, xs: InstructionDef[]) => (xs.length ? [head, ...xs.map(x => `- ${x.text}`)].join('\n') : '')

// What the plan's instructions say for `st` as it starts and before it closes, and with `final`, what they say before
// the plan completes. A member hears it for its state too.
export function toldHere(r: Run, st: StateDef, final = false): string {
  const parts = [
    block(`Your instructions for ${st.id}:`, toldFor(r, 'start', st)),
    block(`Before you advance ${st.id}:`, toldFor(r, 'close', st)),
    final ? block('Before the plan completes:', toldFor(r, 'final')) : '',
  ].filter(Boolean)
  return parts.length ? [...parts, RULES_WIN].join('\n') : ''
}

// The system prompt's Library section: the always instructions, and the draft ones while no plan is locked. The
// dashboard previews this text. Empty when neither has any.
export function librarySection(always: InstructionDef[], draft: InstructionDef[]): string {
  const parts = [block('Every turn:', always), block('While you draft a plan:', draft)].filter(Boolean)
  return parts.length ? [...parts, RULES_WIN].join('\n') : ''
}

// The user keeps a state Claude added on the draft. A second answer doesn't move the first one's time.
export function keepAdded(r: Run, id: string, t: string): Run {
  const d = r.draft
  const st = d?.plan?.states.find(s => s.id === id)
  if (!d || !st?.added || st.okAt) return r
  return { ...r, draft: { ...d, plan: { ...d.plan!, states: d.plan!.states.map(s => (s === st ? { ...s, okAt: t } : s)) } } }
}

export function lockDraft(r: Run, t: string, now = Date.now()): Run {
  const d = r.draft!
  // The clock starts at the lock, not at the draft.
  const tasks = Object.fromEntries(Object.entries(d.tasks ?? {}).map(([id, k]) => [id, { ...k, visits: k.visits.map(v => ({ ...v, from: now })) }]))
  // A lock keeps what the user hasn't answered.
  const states = d.plan!.states.map(s => (s.added && !s.okAt ? { ...s, okAt: t } : s))
  return { ...d, plan: { ...d.plan!, lockedAt: t, states }, startedAt: now, tasks, log: [...d.log, { t, icon: '●', tone: 'acc', text: 'Locked by the user' }], ...(r.refused ? { refused: r.refused } : {}), ...keepCount(r), ...(r.flowDraft ? { flowDraft: r.flowDraft } : {}) }
}

// The main conversation's next state: the first in the listed order with no member whose needs are all done once
// `st` is. One at a time that is the first state not done, as the order keeps every need before it.
// undefined: every state left waits for the work of a member.
const nextOf = (r: Run, st: StateDef): string | undefined => {
  const done = [...doneOf(r), st.id]
  const states = r.plan!.states
  const left = states.filter(s => !done.includes(s.id))
  if (!left.length) return 'done'
  return left.find(s => !r.running?.[s.id] && needsOf(states, s.id).every(n => done.includes(n)))?.id
}

// The check advance runs first: the active state's, when `to` is the next state.
export function forwardCheck(r: Run, to?: string): string | undefined {
  const st = isLive(r) ? stateOf(r) : undefined
  return st?.check && (to ?? '').trim() === nextOf(r, st) ? st.check : undefined
}

// The project may have changed where the ledger can't see it.
export const touched = (r: Run): Run => ({ ...r, touches: (r.touches ?? 0) + 1 })

// A run of `check` as written, from the project root, that passed with nothing touched since: running it again tells nothing new.
export const knownPass = (r: Run, c: Call | undefined, check: string) =>
  c?.kind === 'check' && c.pass === true && c.touches === (r.touches ?? 0) && sameText(c.label, check)

// The check of a state the model is starting, run once before any work there: it should fail then.
// Not for states that only read or verify, not on a return along a loop, and not once edits have begun.
export function startCheck(r: Run): string | undefined {
  const st = isLive(r) ? stateOf(r) : undefined
  if (!st?.check || !st.files.length || r.startChecked?.includes(st.id)) return undefined
  if (r.library && !r.library.on.includes('fails-first')) return undefined
  return visitOf(r).some(c => c.kind === 'edit' && !c.denied) ? undefined : st.check
}

// A check that passes before the work can't show the work got done: the model gets a note, and the log says so.
export function recordStart(r: Run, check: string, pass: boolean, t: string): { run: Run; note?: string } {
  const st = stateOf(r)
  if (!st || st.check !== check) return { run: r }
  const run: Run = { ...r, startChecked: [...(r.startChecked ?? []), st.id] }
  if (!pass) return { run }
  return {
    run: { ...run, log: [...run.log, { t, icon: '!', tone: 'warn', text: `${st.id} · check passes before any work` }] },
    note: `[sentinel] \`${check}\` already passes at the start of ${st.id}, before any work there, so it can't show that ${st.id} got done. `
      + `Give ${st.id} a check that fails now and passes once the work is in, such as a test of the new behaviour that you have seen fail, with action "amend" (check, reason). `
      + `If ${st.id} turns out to be done already, advance. If no such check fits, such as a refactor that has to keep the suite passing, record why with "decide" and carry on.`,
  }
}

// ---- fails-without-change ----

// Test files by the usual names. The rerun without the change copies these in and leaves the rest out.
export const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.*', '**/tests/**', '**/test/**', '**/__tests__/**']
export const isTestFile = (rel: string) => TEST_GLOBS.some(g => globMatch(g, rel))

// The visit's snapshot (Run.snap), if it is this visit's.
const snapOf = (r: Run) => (r.snap?.state === r.active && r.snap.enteredAt === r.enteredAt ? r.snap : undefined)
export const withSnap = (r: Run, sha: string): Run => ({ ...r, snap: { state: r.active!, enteredAt: r.enteredAt, sha } })

// The active state needs its snapshot now: fails-without-change is on, the state has a check and files, and this visit
// has no snapshot and no edit yet. A new visit, such as a return along a loop, takes a new one.
export function snapWanted(r: Run): boolean {
  const st = isLive(r) ? stateOf(r) : undefined
  if (!st?.check || !st.files.length || !r.library?.on.includes('fails-without-change') || snapOf(r)) return false
  return !visitOf(r).some(c => c.kind === 'edit' && !c.denied)
}

// What the rerun at a forward advance needs: the visit's snapshot, and the files edited in the visit as tests and code.
// None without a snapshot, or once a decide in this visit says why the check can't fail without the change. A string
// says why it is skipped.
export function rerunOf(r: Run): { sha: string; tests: string[]; code: string[] } | string | undefined {
  const st = stateOf(r)
  const snap = snapOf(r)
  if (!st || !snap?.sha || r.audit.some(a => a.kind === 'decided' && a.state === st.id && a.step > r.enteredAt)) return undefined
  const files = [...new Set(visitOf(r).flatMap(c => (c.kind === 'edit' && !c.denied && c.file ? [c.file] : [])))]
  const tests = files.filter(isTestFile)
  const code = files.filter(f => !isTestFile(f))
  if (!tests.length || !code.length) return `no ${tests.length ? 'code' : 'test'} files changed`
  return { sha: snap.sha, tests, code }
}

// The rerun's answer: the check's result in the copy, with the files it kept and left out, or why it didn't run.
export type Without = { pass: boolean; tests: string[]; code: string[] } | { skipped: string }

// proofs: the results of the checks Sentinel ran first: of the done states fixed in this visit, and the final sweep's
// when `to` is done. skipping: the user skipped the state, so nothing it asks for holds it. without: the rerun of the
// check without the visit's code changes.
function advance(r: Run, i: PlanInput, t: string, now: number, proofs: Proofs = {}, skipping = false, without?: Without): Acted {
  const plan = r.plan!
  const st = stateOf(r)!
  const next = nextOf(r, st)
  const to = (i.to ?? '').trim()
  const isLoop = plan.loops.some(([f, x]) => f === st.id && x === to)
  const evidence = (i.evidence ?? '').trim()
  const outcome = clip(i.outcome)
  // A loop edge that is also the next state is a forward move: it needs the check, and keeps its outcome.
  const back = isLoop && to !== next
  if (to !== next && !isLoop) {
    // A join: what is left needs the work of members that still run.
    if (next === undefined) return refuse(r, `Every state left needs work that members are still doing (${Object.keys(r.running ?? {}).join(', ')}). Stop here. Sentinel checks their work, brings it back and tells you when the next state can start.`)
    const options = [next, ...plan.loops.filter(([f]) => f === st.id).map(([, x]) => x)]
    return refuse(r, `No edge ${st.id} → ${to || '?'}. From ${st.id} you can go to ${options.join(' or ')}.`)
  }
  if (to === next && !skipping) {
    const visit = visitOf(r)
    const ask = notYet(r)
    if (ask) return refuse(r, ask)
    if (st.check) {
      const last = visit.findLast(c => c.kind === 'check')
      if (!last) return refuse(r, `${st.id} is done when \`${st.check}\` exits 0. It hasn't run since you entered ${st.id}.`)
      const out = r.lastFail?.step === last.step ? `\n\n${r.lastFail.text}` : ''
      if (!last.pass) return refuse(r, `The last run of \`${st.check}\` failed: ${last.sigText}. Fix that before moving on.${out}`)
      const edited = visit.find(c => c.kind === 'edit' && c.step > last.step && c.ver !== undefined)
      if (edited) return refuse(r, `${edited.file} changed after the last passing run (step ${last.step}). Run \`${st.check}\` again.`)
    } else {
      if (!evidence) return refuse(r, `${st.id} has no check, so advancing needs evidence: say what you found.`)
      if (!visit.some(c => c.kind === 'look' && c.u === 1)) return refuse(r, `${st.id} has no check, so advancing needs at least one read in this state first.`)
    }
    const broke = fixedOf(r).filter(s => s.check && proofs[s.check]?.pass === false)
    if (broke.length) {
      const why = [...new Set(broke.map(s => s.check!))].map(c => `\`${c}\` (${broke.filter(s => s.check === c).map(s => s.id).join(', ')}): ${proofs[c]!.sigText}`)
      return refuse(r, `You changed files of done states, and their checks fail now:\n${why.join('\n')}\nFix that before moving on.`)
    }
    if (without && 'pass' in without && without.pass) {
      return {
        run: { ...r, log: [...r.log, { t, icon: '!', tone: 'warn', text: `${st.id} · check passes without the change` }] }, ok: false,
        text: `\`${st.check}\` passes in a copy of the project that has ${st.id}'s test changes (${without.tests.join(', ')}) but not its code changes (${without.code.join(', ')}), so it doesn't show the change works. `
          + `Tighten the test so it fails without the change, then advance again. If it can't, such as a refactor that has to keep passing, record why with "decide", then advance again.`,
      }
    }
    // Finished work goes to the user once, and again if it changed after they saw it. Hands-free, it passes and is
    // listed for them to check later.
    const said = clip(outcome ?? evidence, 1500)
    if (waitOf(st) === 'after' && r.handsFree) r = { ...r, audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'decided', text: `Passed its review hands-free${said ? `: ${said}` : ''}` }] }
    else if (waitOf(st) === 'after') {
      const p = pendingOf(r)
      const seen = p?.kind === 'after' && !visit.some(c => c.kind === 'edit' && c.ver !== undefined && c.step > p.step)
      if (!seen || !answered(r, 'after')) {
        if (seen) return refuse(r, `The user hasn't answered your review of ${st.id} yet. Stop your turn and wait for them.`)
        const text = clip(outcome ?? evidence, 1500)
        const run: Run = {
          ...r, pending: { state: st.id, at: now, step: r.step + 1, kind: 'after', ...(text ? { text } : {}) },
          audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'asked', text: `Ready for review${text ? `: ${text}` : ''}` }],
          log: [...r.log, { t, icon: '?', tone: 'ask', text: `${st.id} · ready for your review` }],
        }
        return { run, ok: false, text: `${st.id} is done, and the user reviews it before it moves on. They see your outcome above the prompt and on the dashboard. Say in your reply what was done and what they should check, then stop your turn and wait. Call advance again once they answer.` }
      }
    }
    if (without && 'skipped' in without) r = { ...r, log: [...r.log, { t, icon: '–', tone: 'dim', text: `${st.id} · rerun without the change skipped: ${without.skipped}` }] }
  } else if (to !== next && !evidence) return refuse(r, `Going back along ${st.id} → ${to} needs a reason in evidence.`)
  // A loop to a state listed further on skips the states between, as the listed order did before needs. It can't
  // skip or land on a state a member is still doing.
  const at = (id: string) => plan.states.findIndex(s => s.id === id)
  const skip = back && at(to) > at(st.id)
  const busy = skip ? plan.states.slice(0, at(to) + 1).filter(s => r.running?.[s.id]).map(s => s.id) : []
  if (busy.length) return refuse(r, `The loop to ${to} would skip work that members are still doing (${busy.join(', ')}). Wait until Sentinel says it is in.`)
  if (to === 'done') {
    const failed = plan.states.filter(s => s.id !== st.id && !r.skipped?.[s.id] && s.check && proofs[s.check]?.pass === false)
    if (failed.length) return reopen(r, st, failed, proofs, outcome, t, now)
  }

  const key = `${st.id}>${to}`
  const loops = isLoop ? { ...r.loops, [key]: (r.loops[key] ?? 0) + 1 } : r.loops
  const n = plan.states.length
  const line: LogLine = isLoop
    ? { t, icon: '↺', tone: 'warn', text: `${st.id} → ${to} · loop ${loops[key]}` }
    : to === 'done' ? { t, icon: '■', tone: 'ok', text: `Plan complete · ${n}/${n}` } : { t, icon: '▶', tone: 'ok', text: `${st.id} → ${to}` }
  // Going back reopens the state and every state built on its old result. A member on such a state works from the
  // old result, so it is let go and its answer is ignored.
  // ponytail: the member agent itself runs on until it stops; stop it through the engine if that costs too much.
  const stale = (id: string) => back && !skip && (id === to || upstream(plan.states, id).has(to))
  // A skip may land on a state a member finished: it is open again.
  const done = skip ? [...new Set([...doneOf(r), ...plan.states.slice(0, at(to)).map(s => s.id)])].filter(id => id !== to)
    : back ? doneOf(r).filter(id => !stale(id)) : [...doneOf(r), st.id]
  const running = r.running && Object.fromEntries(Object.entries(r.running).filter(([id]) => !stale(id)))
  // Close the visit that ends here, and those of members let go; keep what was done here, open the next visit.
  let tasks = closeVisit(r.tasks, st.id, now, back ? undefined : outcome)
  for (const id of Object.keys(r.running ?? {}).filter(id => !running?.[id])) tasks = closeVisit(tasks, id, now)
  // Entering a task opens a visit. A task sent back to starts without the outcome of its first pass.
  if (to !== 'done') tasks[to] = { visits: [...(taskIn(tasks, to)?.visits ?? []), { from: now }] }
  const run: Run = {
    ...r, active: to, done, ...(running ? { running } : {}), enteredAt: r.step, loops, lastLoop: isLoop ? key : undefined,
    traps: r.traps.map(x => (x.end === undefined ? { ...x, end: r.step } : x)),
    log: [...r.log, line], auto: 0, askToken: 0, breakingOk: false,
    tasks, ...(to === 'done' ? { endedAt: now } : {}),
    // The reason for a way back was checked above; keep it for the task page of the state returned to.
    ...(back ? { trips: [...(r.trips ?? []), { from: st.id, to, at: now, t, reason: clip(evidence)! }] } : {}),
  }
  return { run, ok: true, event: to === 'done' ? 'complete' : undefined, text: `Moved to ${to}.\n${here(run)}` }
}

// The final sweep found done states whose checks fail now: st is done, and they open again in place of completing.
// What builds on them gets swept again at the next completion, so only they reopen.
function reopen(r: Run, st: StateDef, failed: StateDef[], proofs: Proofs, outcome: string | undefined, t: string, now: number): Acted {
  const ids = failed.map(s => s.id)
  const first = ids[0]!
  const tasks = closeVisit(r.tasks, st.id, now, outcome)
  tasks[first] = { visits: [...(taskIn(tasks, first)?.visits ?? []), { from: now }] }
  const why = [...new Set(failed.map(s => s.check!))].map(c => `\`${c}\` (${failed.filter(s => s.check === c).map(s => s.id).join(', ')}): ${proofs[c]!.sigText}`)
  // Their checks just failed twice, so the start check would only fail a third time.
  const run: Run = {
    ...r, active: first, done: [...doneOf(r), st.id].filter(id => !ids.includes(id)), enteredAt: r.step, lastLoop: undefined,
    traps: r.traps.map(x => (x.end === undefined ? { ...x, end: r.step } : x)),
    log: [...r.log, { t, icon: '↺', tone: 'err', text: `Final check · ${ids.join(', ')} failing · reopened` }],
    trips: [...(r.trips ?? []), { from: st.id, to: first, at: now, t, reason: clip(`Final check: ${why.join('; ')}`)! }],
    startChecked: [...new Set([...(r.startChecked ?? []), ...ids])],
    auto: 0, askToken: 0, breakingOk: false, tasks,
  }
  return {
    run, ok: true,
    text: `${st.id} is done, but the plan is not complete yet. Before finishing, Sentinel ran the checks of the done states again, and these fail now:\n${why.join('\n')}\n`
      + `Later work may have broken them, or they relied on something that changed. Reopened: ${ids.join(', ')}. Moved to ${first}. If a check no longer applies, amend it with a reason.\n${here(run)}`,
  }
}

function amend(r: Run, i: PlanInput, t: string): Acted {
  const st = stateOf(r)!
  const reason = i.reason?.trim()
  if (!reason) return refuse(r, 'amend needs a reason.')
  const files = (i.files ?? []).map(f => f.trim()).filter(Boolean)
  const check = i.check?.trim()
  if (!files.length && !check) return refuse(r, 'amend needs files to add, or a new check.')
  const risky = files.find(f => breakingKind(f))
  if (risky && !r.breakingOk) return refuse(r, `${risky} looks like ${breakingKind(risky)}, which is on the breaking list. Call plan with action "escalate" and kind "breaking", ask the user, then amend.`)
  // A member edits its state's files in its own worktree, and its work comes back over the project's.
  for (const f of files) {
    const owner = Object.keys(r.running ?? {}).find(id => stateOf(r, id)?.files.some(g => globsMeet(f, g)))
    if (owner) return refuse(r, `${f} may be edited by ${owner}, which a member agent is working on now. Wait until Sentinel says ${owner} is in, then amend.`)
  }
  const nextState: StateDef = { ...st, files: [...new Set([...st.files, ...files])], ...(check ? { check } : {}) }
  const plan = { ...r.plan!, states: r.plan!.states.map(s => (s === st ? nextState : s)) }
  const what = [files.length ? `+${files.join(', +')}` : '', check ? `check \`${st.check ?? 'none'}\` → \`${check}\`` : ''].filter(Boolean).join('; ')
  const run: Run = {
    ...r, plan, breakingOk: false, escalatedAt: undefined,
    audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'amended', text: `${st.id}: ${what} (${reason})` }],
    log: [...r.log, { t, icon: '+', tone: 'warn', text: `Amended · ${what}` }],
  }
  return { run, ok: true, text: `Amended ${st.id}: ${what}.\n${here(run)}` }
}

function decide(r: Run, i: PlanInput, t: string): Acted {
  const topic = i.topic?.trim()
  const choice = i.choice?.trim()
  if (!topic || !choice) return refuse(r, 'decide needs a topic and a choice.')
  const text = `${topic} → ${choice}${i.reason?.trim() ? ` (${i.reason.trim()})` : ''}`
  // A choice made after an escalation settles it.
  const run: Run = {
    ...r, escalatedAt: undefined,
    audit: [...r.audit, { step: r.step + 1, t, state: r.active ?? undefined, kind: 'decided', text }],
    log: [...r.log, { t, icon: '◆', tone: 'acc', text: `Decided · ${text}` }],
  }
  return { run, ok: true, text: 'Recorded. Continue with the plan.' }
}

function escalate(r: Run, i: PlanInput, t: string, now: number): Acted {
  const reason = i.reason?.trim()
  if (!reason) return refuse(r, 'escalate needs a reason: which rule, and why.')
  if (i.kind !== 'breaking' && i.kind !== 'stuck') return refuse(r, 'kind must be "breaking" or "stuck".')
  if (i.kind === 'stuck') {
    const notes = Math.max(0, ...r.traps.filter(x => x.state === r.active && x.step > r.enteredAt).map(x => x.notes))
    // Sentinel refusing to move on counts as stuck too.
    const refused = visitOf(r).filter(c => c.kind === 'plan' && c.denied && c.label.startsWith('plan advance')).length
    if (notes < 2 && refused < 3) return refuse(r, `Not yet. A stuck escalation opens after two recovery notes or three refused advances in this state (${notes} notes, ${refused} refused so far).`)
  }
  // Hands-free, nobody answers: Claude makes the call, and the run doesn't wait, unless it is stuck in a state later
  // ones build on.
  const free = !!r.handsFree
  const on = free && i.kind === 'stuck' ? builtOn(r, r.active!) : []
  const waits = !free || on.length > 0
  const run: Run = {
    ...r, askToken: free ? 0 : 1, quiet: waits, breakingOk: i.kind === 'breaking', escalatedAt: waits ? now : undefined,
    audit: [...r.audit, { step: r.step + 1, t, state: r.active ?? undefined, kind: 'escalated', text: `${i.kind === 'breaking' ? 'Breaking' : 'Stuck'}: ${reason}` }],
    log: [...r.log, { t, icon: '⚑', tone: 'acc', text: `Escalated · ${i.kind}` }],
  }
  const text = !free ? 'Logged. You may ask the user one question now (AskUserQuestion). Record the answer with decide, amend the plan if it needs new files, then continue.'
    : i.kind === 'breaking' ? `Logged. ${HANDS_FREE} Amend the plan if the change needs new files.`
    : on.length ? `Logged. ${on.join(', ')} ${on.length === 1 ? 'builds' : 'build'} on ${r.active}, so it can't be skipped, and the user is hands-free. End your turn: the run waits for them.`
    : `Logged. ${HANDS_FREE} If nothing gets the check to pass and the states after ${r.active} can be built and tested without it, skip it with action "skip" (to, reason): Sentinel lists it for the user to finish later. If they can't, end your turn: the run waits for the user.`
  return { run, ok: true, text }
}

function status(r: Run): string {
  const wait = r.draft ? `A draft of "${r.draft.plan!.title}" is waiting for the user to lock it with /sentinel lock.` : undefined
  if (!r.plan) return wait ?? (r.signedOff ? 'Signed off, but no plan is defined yet. Call define.' : 'No plan is locked.')
  const vm = summarize(r)
  const rail = vm.states.map(s => `${SYM[s.status]}${s.id}`).join(' ')
  const lines = [`Plan "${r.plan.title}": ${rail}`, here(r, true)]
  if (r.paused) lines.push('Paused by the user: nothing is enforced until /sentinel resume.')
  if (r.plan.source) lines.push(`The plan is written in ${r.plan.source}.`)
  const decided = r.audit.filter(a => a.kind === 'decided')
  if (decided.length) lines.push('Decisions so far:', ...decided.map(a => `- ${a.text}`))
  if (wait) lines.push(wait)
  if (vm.lastCheck) lines.push(`Last check: ${vm.lastCheck.pass ? 'passed' : `failed (${vm.lastCheck.sigText})`} at step ${vm.lastCheck.step}.`)
  if (vm.health) lines.push(`Health ${vm.health.H.toFixed(2)} (${healthWord(vm.health.H)}).`)
  if (vm.trap) lines.push(`Stuck since step ${vm.trap.step} (${vm.trap.pattern}).`)
  return lines.join('\n')
}

// ---- helper agent lanes ----

// A helper agent's call goes in its lane. A call marks the lane running again: a finished agent that a message woke is back at work.
// Any helper call may change files (a Bash sed, a code generator), so each one counts as a touch.
export function laneCall(r: Run, id: string, name: string, call: { label: string; file?: string }): Run {
  const lanes = r.lanes ?? []
  const own = lanes.find(l => l.id === id)
  const edits = own?.edits ?? []
  const next: Lane = {
    id, name: own?.name ?? name, state: memberByAgent(r, id) ?? r.active ?? '', calls: (own?.calls ?? 0) + 1, last: call.label, running: true,
    edits: call.file && !edits.includes(call.file) ? [...edits, call.file] : edits,
  }
  return touched({ ...r, lanes: own ? lanes.map(l => (l === own ? next : l)) : [...lanes, next] })
}

export const laneDone = (r: Run, id: string): Run =>
  r.lanes?.some(l => l.id === id && l.running) ? { ...r, lanes: r.lanes.map(l => (l.id === id ? { ...l, running: false } : l)) } : r

// ---- auto-continue ----

// busy: background agents, shells or monitors still run. They wake the conversation when done, so it is not pushed
// and the count is kept.
export function autoContinue(r: Run, t: string, busy = false, talking = false): { run: Run; go: boolean } {
  if (!isLive(r)) return { run: r, go: false }
  if (r.quiet) return { run: { ...r, quiet: false }, go: false }
  // The model stopped to wait for the user's answer, for background work that wakes it when done, or after answering
  // what the user just said. Hands-free, the user isn't there to talk to.
  if (waitingOn(r) || busy || (talking && !r.handsFree)) return { run: r, go: false }
  const cap = capOf(r)
  if (r.auto >= cap) return { run: r, go: false }
  const auto = r.auto + 1
  return {
    go: true,
    run: {
      ...r, auto,
      audit: [...r.audit, { step: r.step, t, state: r.active ?? undefined, kind: 'auto', text: `Continued after the turn stopped in ${r.active} (${auto}/${cap})` }],
      log: [...r.log, { t, icon: '↻', tone: 'warn', text: `Auto-continue ${auto}/${cap}` }],
    },
  }
}

// ---- what the views draw ----

// running: a member agent works on the state beside the main conversation.
export type Status = 'done' | 'active' | 'trap' | 'running' | 'todo'
export const SYM: Record<Status, string> = { done: '✓', active: '▶', trap: '⚠', running: '⇉', todo: '○' }
export const healthWord = (h: number) => (h <= THETA ? 'stuck' : h <= 0.5 ? 'watch' : 'ok')
export const healthTone = (h: number): Tone => (h <= THETA ? 'err' : h <= 0.5 ? 'warn' : 'ok')

export type LedgerRow = {
  step: number; label: string; denied: boolean; vers: string[]; chk: string; chkTone: Tone
  u: string; uTone: Tone; H: number; trapStart: boolean; inWindow: boolean
}

export type VM = {
  phase: 'none' | 'draft' | 'live' | 'complete'
  paused: boolean
  source?: string
  signedOff: boolean
  title: string
  lockedAt: string
  step: number
  // from: when the task first started. to: when it last finished. since: when it began running, if it runs now.
  // ms: time in the visits that are over, so a running task adds Date.now() - since. visits: how often it was entered.
  // needs: every state it needs, the one before it when it lists none. waits: those not done yet.
  // skipped: why the user skipped it; it still shows as done.
  states: (StateDef & { asks?: AskFact[]; status: Status; from?: number; to?: number; since?: number; ms?: number; visits?: number; spans?: Span[]; outcome?: string; needs: string[]; waits: string[]; skipped?: string })[]
  // Some state lists its needs, so the views show what each one needs.
  deps: boolean
  loops: { from: string; to: string; count: number; hot: boolean }[]
  active?: StateDef & { pos: number; of: number; status: Status }
  lastCheck?: Call
  health?: { H: number; S: number; R: number; p: number; n: number; from: number; to: number; usum: number; reps: number }
  spark: number[]
  trap?: Trap & { sameRuns: number[]; sigText?: string; verText?: string }
  released?: Trap
  attempts: { n: number; step: number; pass: boolean; sigText: string; fails: number; same: boolean; ver?: string }[]
  mainFile?: string
  next?: { ver: string; repeatOf?: number }
  sigs: string[]
  ledger: { state: string; files: string[]; rows: LedgerRow[] }
  audit: Audit[]
  asked: Audit[]
  counts: Record<AuditKind, number>
  log: LogLine[]
  timeline: { step: number; state: string; kind: Kind; label: string; u: 0 | 1; denied: boolean; revoked: boolean; H: number }[]
  traps: Trap[]
  // The ways back that were taken, latest last, and the wall-clock span of the run.
  trips: Trip[]
  startedAt?: number
  endedAt?: number
  // Tool calls since the running task was entered.
  visitCalls: number
  spend: Spend[]
  spendFrom?: string
  // One lane for each helper agent, kept apart from the main conversation's calls and health.
  lanes: Lane[]
  // What the active state asked the user and is waiting on now: its proposal (before) or its finished work (after).
  waiting?: { kind: Wait; text?: string; at: number }
  // The user answered what the active state asked, so it may go on.
  replied: boolean
  // The user is away: Claude makes the calls that would wait for them.
  handsFree: boolean
  // The final checks under way, before the plan completes.
  sweep?: NonNullable<Run['sweep']>
  // The checks Sentinel runs now.
  checking?: Run['checking']
  flowDraft?: Run['flowDraft']
  // A draft's depth answers, which the user ticks as they lock it.
  depth?: Depth[]
  // Where the states came from, while the plan compares quotes. quoted of of: states with a quote, of those with a quote
  // or Claude's reason, as a flow's state and one done before the lock have neither.
  proof?: { quoted: number; of: number; sources: SourceFact[]; refused: (Refused & { says: string })[] }
}

const base = (f: string) => f.split(/[\\/]/).pop() ?? f

// source: its place in proof.sources. where: in words, for a screen to show.
export type AskFact = { quote: string; source?: number; where?: string }
// A saved source as the screens draw it. marks: character offsets in text. unquoted: its sections no state quotes. gaps: where those sections' headings start.
export type SourceFact = { kind: Source['kind']; name?: string; at: string; origin: string; text: string; marks: { from: number; to: number; state: string }[]; unquoted: string[]; gaps: number[]; quotedBy: number }

// Why a quote was refused, for a screen to put after the quote.
const REFUSED_SAYS: Record<Refused['why'], string> = {
  missing: "wasn't in the sources, word for word", short: 'was too short to count', excluded: 'came from a part of the plan marked out of scope',
  empty: 'had no words in it', long: `was over ${MAX_QUOTE_WORDS} words`, none: 'Claude sent neither a quote nor a reason',
}

const ORIGIN: Record<Source['kind'], (s: Source) => string> = {
  message: s => `You typed it at ${s.at}`,
  file: () => 'A file that was there before this session',
  approved: s => `Claude wrote it and you approved it at ${s.at}`,
}

// Where the plan's states came from. Only a source a quote uses goes out, and the approved plan, which the screens name
// even when nothing quotes it. The pane draws often and the comparison reads each whole source, so a plan works this out once.
// ponytail: sources changing alone keeps the old facts until the plan changes; only a new sign-off while a plan runs does that.
const FACTS = new WeakMap<Plan, { asks: Map<string, AskFact[]>; sources: SourceFact[] }>()
function factsOf(plan: Plan, saved: Source[]) {
  const had = FACTS.get(plan)
  if (had) return had
  const matched = plan.states.flatMap(st => (st.asked ?? []).map(quote => ({ state: st.id, quote, from: saved.find(d => checkQuote(d.text, quote) === 'ok') })))
  const out = saved.filter(s => s.kind === 'approved' || matched.some(m => m.from === s))
  const sources = out.map((s): SourceFact => {
    const mine = matched.filter(m => m.from === s)
    return {
      kind: s.kind, ...(s.name ? { name: base(s.name) } : {}), at: s.at, origin: ORIGIN[s.kind](s), text: s.text,
      marks: mine.flatMap(m => {
        const span = spanOf(s.text, m.quote)
        return span ? [{ from: span[0], to: span[1], state: m.state }] : []
      }),
      unquoted: unquoted(s.text, mine.map(m => m.quote)),
      gaps: unquotedSections(s.text, mine.map(m => m.quote)).map(x => x.at),
      quotedBy: new Set(mine.map(m => m.state)).size,
    }
  })
  const asks = new Map<string, AskFact[]>()
  for (const { state, quote, from } of matched) {
    const where = !from ? '' : from.kind === 'message' ? `Your message at ${from.at}` : [from.name && base(from.name), sectionOf(from.text, quote)].filter(Boolean).join(', ')
    asks.set(state, [...(asks.get(state) ?? []), { quote, ...(from ? { source: out.indexOf(from), where } : {}) }])
  }
  const facts = { asks, sources }
  FACTS.set(plan, facts)
  return facts
}

// The saved copies as text, with the states that quote each line beside it: what /sentinel source prints.
export function sourceText(vm: VM): string {
  const sources = vm.proof?.sources ?? []
  if (!sources.length) return 'Sentinel has no saved source for this plan.'
  const copies = sources.flatMap(s => {
    let at = 0
    const lines = s.text.split('\n').map(raw => {
      const by = [...new Set(s.marks.filter(m => m.from < at + raw.length && m.to > at).map(m => m.state))]
      at += raw.length + 1
      return `  ${raw.trimEnd()}${by.length ? `   <- ${by.join(', ')}` : ''}`
    })
    return [`${s.name ?? (s.kind === 'message' ? 'Your message' : 'The approved plan')}   ${s.origin}`, ...lines, ...(s.unquoted.length ? [`No state quotes: ${s.unquoted.join(', ')}.`] : []), '']
  })
  const added = vm.states.filter(s => s.added).map(s => `${s.id} has no quote. Claude added it because: ${s.added}${s.okAt ? ` You kept it at ${s.okAt}.` : ''}`)
  return [...copies, ...added].join('\n').trimEnd()
}

// The one rule for the active state's clock: it runs while Claude works on the plan, and stops whenever the plan
// waits, on the user, on a pause, or on nothing at all. working: the main conversation is in a turn with no question
// up, or background work it started still runs.
export const clocked = (r: Run, working: boolean, at = Date.now()): Run =>
  isLive(r) && working && !waitingOn(r) ? startClock(r, at) : stopClock(r, at)

// Stopping closes the running stretch; starting again opens a new stretch of the same visit.
export function stopClock(r: Run, at = Date.now()): Run {
  const own = taskIn(r.tasks, r.active)
  const last = own?.visits.at(-1)
  if (!own || !last || last.to !== undefined) return r
  return { ...r, tasks: { ...r.tasks, [r.active!]: { ...own, visits: [...own.visits.slice(0, -1), { ...last, to: Math.max(at, last.from) }] } } }
}

export function startClock(r: Run, at = Date.now()): Run {
  const own = taskIn(r.tasks, r.active)
  const last = own?.visits.at(-1)
  if (!own || !last || last.to === undefined || !isUnfinished(r)) return r
  return { ...r, tasks: { ...r.tasks, [r.active!]: { ...own, visits: [...own.visits, { from: at, cont: true }] } } }
}

// What the views need for a task's clock and outcome.
function timeOf(k?: Task) {
  const last = k?.visits.at(-1)
  if (!k || !last) return k?.outcome ? { outcome: k.outcome } : {}
  return {
    from: k.visits[0]!.from,
    ...(last.to !== undefined ? { to: last.to } : { since: last.from }),
    ms: k.visits.reduce((a, v) => a + (v.to !== undefined ? v.to - v.from : 0), 0),
    visits: k.visits.filter(v => !v.cont).length,
    spans: spansOf(k),
    ...(k.outcome ? { outcome: k.outcome } : {}),
  }
}

// Each stretch of work on a task and who did it: a member agent (`by`), or the main conversation. A stretch after a
// pause carries on the one before it.
type Span = { from: number; to?: number; by?: 'member' }
function spansOf(k: Task): Span[] {
  const out: Span[] = []
  for (const v of k.visits) {
    const to = v.to !== undefined ? { to: v.to } : {}
    if (v.cont && out.length) out[out.length - 1] = { from: out.at(-1)!.from, ...to }
    else out.push({ from: v.from, ...to, ...(v.by ? { by: v.by } : {}) })
  }
  return out
}

// A draft waiting for the user's lock is what the views show, over any plan still running.
export function summarize(top: Run): VM {
  const r = top.draft ?? top
  const plan = r.plan
  const phase: VM['phase'] = top.draft ? 'draft' : !plan ? 'none' : r.active === 'done' ? 'complete' : 'live'
  const trapNow = phase === 'live' ? openTrap(r) : undefined
  // A check Sentinel stopped as stuck shows as stuck too, while its state is active and no check has run since.
  const hung = phase === 'live' && !trapNow && r.hung?.state === r.active ? r.hung : undefined
  const red = !!(trapNow || hung)
  const ids = plan ? [...plan.states.map(s => s.id), 'done'] : []
  const pos = r.active ? ids.indexOf(r.active) : -1
  const done = new Set(doneOf(r))
  const facts = plan && r.library?.on.includes('quote-the-source') ? factsOf(plan, r.sources ?? []) : undefined
  const states = plan
    ? [...plan.states, { id: 'done', label: '', files: [] }].map((s, i) => ({
        ...s,
        ...(facts?.asks.get(s.id) ? { asks: facts.asks.get(s.id) } : {}),
        // A draft has no clock until the user locks it.
        ...(phase === 'draft' ? {} : timeOf(taskIn(r.tasks, s.id))),
        status: (phase === 'complete' || done.has(s.id) ? 'done' : i === pos ? (red ? 'trap' : 'active') : r.running?.[s.id] ? 'running' : 'todo') as Status,
        needs: s.id === 'done' ? [] : needsOf(plan.states, s.id),
        waits: phase === 'complete' || done.has(s.id) || s.id === 'done' ? [] : needsOf(plan.states, s.id).filter(n => !done.has(n)),
        ...(r.skipped?.[s.id] ? { skipped: r.skipped[s.id] } : {}),
      }))
    : []
  const st = phase === 'live' || phase === 'draft' ? stateOf(r) : undefined
  const visit = phase === 'live' ? visitOf(r) : r.calls.slice(-30)
  const cur = phase === 'live' ? visit.at(-1) : undefined

  // the version of each file as of each call
  const running: Record<string, string> = {}
  const versAt = new Map<number, Record<string, string>>()
  for (const c of r.calls) {
    if (c.file && c.before && !running[c.file]) running[c.file] = c.before
    if (c.file && c.ver) running[c.file] = c.ver
    versAt.set(c.step, { ...running })
  }
  const label = (file: string, ver?: string) => verLabel(r.calls, file, ver)

  const edits = visit.filter(c => c.kind === 'edit' && c.ver)
  const byCount = [...new Set(edits.map(c => c.file!))].sort((a, b) => edits.filter(c => c.file === b).length - edits.filter(c => c.file === a).length)
  const mainFile = byCount[0]
  const checks = visit.filter(c => c.kind === 'check')
  const lastCheck = checks.at(-1)
  const attempts = checks.map((c, i) => ({
    n: i + 1, step: c.step, pass: !!c.pass, sigText: c.sigText ?? '', fails: c.fails ?? 0, same: !!c.same,
    ver: mainFile ? label(mainFile, versAt.get(c.step)?.[mainFile]) : undefined,
  }))
  let next: VM['next']
  if (mainFile && lastCheck && !lastCheck.pass && running[mainFile] !== versAt.get(lastCheck.step)?.[mainFile]) {
    const ver = label(mainFile, running[mainFile])
    const prior = attempts.find(a => a.ver === ver)
    next = { ver, repeatOf: prior?.n }
  }

  let health: VM['health']
  if (cur) {
    const win = visit.slice(-K)
    health = { H: cur.H, S: cur.S, R: cur.R, p: cur.p, n: cur.n, from: win[0]!.step, to: cur.step, usum: win.reduce((a, x) => a + x.u, 0), reps: win.filter(x => x.repeat).length }
  }

  let trap: VM['trap']
  if (trapNow) {
    const fails = checks.filter(c => !c.pass)
    const lastFail = fails.at(-1)
    trap = {
      ...trapNow,
      sameRuns: lastFail ? fails.filter(c => c.sig === lastFail.sig).map(c => c.step) : [],
      sigText: lastFail?.sigText,
      verText: trapNow.file ? label(trapNow.file, trapNow.ver) : undefined,
    }
  } else if (hung) {
    trap = { state: hung.state, pattern: 'hung', step: hung.step, notes: 1, lastNote: hung.step, sameRuns: [], sigText: hung.text }
  }
  const released = phase === 'live' ? r.traps.findLast(x => x.state === r.active && x.end !== undefined && x.end > r.enteredAt && r.step - x.end < 3) : undefined

  const files = byCount.slice(0, 3)
  const winFrom = health ? health.from : Infinity
  const rows: LedgerRow[] = visit.map(c => {
    const vers = files.map(f => {
      const v = versAt.get(c.step)?.[f]
      const mark = c.file === f && c.ver ? (c.revisitOf ? '=' : '*') : ''
      return v ? label(f, v) + mark : '·'
    })
    const chk = c.kind === 'check' ? (c.pass ? '✓ Pass' : `× ${c.same ? '=' : c.fails}`) : '·'
    return {
      step: c.step, label: c.kind === 'ask' ? `Ask: ${c.label}` : c.label.replace(/\S*\//g, ''), denied: !!c.denied, vers, chk, chkTone: c.kind !== 'check' ? 'dim' : c.pass ? 'ok' : 'err',
      u: c.revoked ? '1→0' : `${c.u}${c.repeat ? '=' : ''}`, uTone: c.revoked ? 'warn' : c.u ? 'ok' : 'dim',
      H: c.H, trapStart: !!c.trapStart, inWindow: c.step >= winFrom,
    }
  })

  const counts = { refused: 0, blocked: 0, decided: 0, amended: 0, auto: 0, asked: 0, escalated: 0 } as Record<AuditKind, number>
  for (const a of r.audit) counts[a.kind]++
  const asked = phase === 'live' && !top.paused ? pendingOf(r) : undefined

  return {
    phase, paused: !!top.paused, source: plan?.source, signedOff: top.signedOff, title: plan?.title ?? '', lockedAt: plan?.lockedAt ?? '', step: r.step, states,
    loops: (plan?.loops ?? []).map(([from, to]) => ({ from, to, count: r.loops[`${from}>${to}`] ?? 0, hot: r.lastLoop === `${from}>${to}` && r.active === to })),
    active: st ? { ...st, pos: pos + 1, of: ids.length, status: red ? 'trap' : 'active' } : undefined,
    lastCheck, health, spark: r.calls.slice(-24).map(c => c.H), trap, released, attempts, mainFile, next,
    sigs: [...new Set(checks.filter(c => !c.pass).map(c => c.sigText ?? ''))].slice(-2),
    ledger: { state: phase === 'live' ? r.active! : 'last calls', files: files.map(base), rows },
    audit: r.audit.filter(a => a.kind !== 'asked' && a.kind !== 'escalated'),
    asked: r.audit.filter(a => a.kind === 'asked' || a.kind === 'escalated'),
    counts, log: r.log.slice(-8),
    timeline: r.calls.map(c => ({ step: c.step, state: c.state, kind: c.kind, label: c.label, u: c.u, denied: !!c.denied, revoked: !!c.revoked, H: c.H })),
    traps: r.traps,
    trips: (r.trips ?? []).slice(-50), startedAt: phase === 'draft' ? undefined : r.startedAt, endedAt: phase === 'draft' ? undefined : r.endedAt, visitCalls: phase === 'live' ? visit.length : 0,
    spend: top.spend ?? [], spendFrom: top.spendFrom,
    lanes: (top.lanes ?? []).map(l => ({ ...l, name: l.name || l.id })),
    deps: !!plan?.states.some(s => s.needs),
    ...(asked && !answered(r) ? { waiting: { kind: asked.kind, text: asked.text, at: asked.at } } : {}),
    replied: !!asked && answered(r),
    handsFree: !!r.handsFree,
    ...(r.sweep && { sweep: r.sweep }),
    ...(phase === 'live' && r.checking?.length && { checking: r.checking }),
    ...(top.flowDraft && { flowDraft: top.flowDraft }),
    ...(top.draft && top.held?.depth && { depth: top.held.depth }),
    ...(facts && { proof: {
      quoted: plan!.states.filter(s => s.asked?.length).length,
      of: plan!.states.filter(s => s.asked?.length || s.added).length,
      sources: facts.sources,
      refused: (top.refused ?? []).map(x => ({ ...x, says: REFUSED_SAYS[x.why] })),
    } }),
  }
}

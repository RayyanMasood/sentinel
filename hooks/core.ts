// The plan, the ledger and the stuck detector. Pure functions over `Run`:
// no `$` here, so the pane, the browser view and the tests read the same numbers.
import type { Audit, AuditKind, Call, Depth, Drawing, Evidence, FlowDef, FlowState, FlowWhen, Fingerprint, InstructionAt, InstructionDef, Kind, Lane, LogLine, Look, MapChanges, MapLook, MapNode, MapRunState, Marks, Member, OverseerWord, Plan, PlanInput, PlanLibrary, PlanSetting, Point, Refused, Run, SettingRow, Source, Spend, StateDef, Switches, SysTreePart, SystemMap, SystemView, Task, Tone, Trap, Trip, View, Wait, Weight, UsageView, UsageWindow } from '../types'
import { rollOf, statusOf, tally } from './mapstatus.ts'
import { usageView } from './usage.ts'
import { checkQuote, checkSetting, MIN_WORDS, nearest, sectionOf, spanOf, squash, unquoted, unquotedSections } from './quote.ts'
import { changesOf, checkDrawing, dropParts, stateReads, treeOf } from './system.ts'
export type { PlanInput }

export const K = 8 // window of recent calls the detector looks at
export const THETA = 0.25 // stuck at or below this health
export const AUTO_CAP = 2 // auto-continues in a row without a state change
export const VIEWS: readonly View[] = ['focus', 'map', 'ledger', 'system']

// Every /sentinel command, for /sentinel help and the slash menu's hint. README.md's Commands table lists the same, and
// tests/help.test.mjs fails when the two drift apart.
export const COMMANDS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ['See the run', [
    ['', 'open the pane on whatever needs you'],
    ['focus|map|ledger|system', 'open the pane on that view; system also checks the map against git'],
    ['browser', 'open the dashboard in your browser'],
    ['source', 'print the saved copy of what the plan quotes, with each quote marked'],
    ['help', 'list these commands'],
  ]],
  ['The plan', [
    ['lock', 'sign off a plan agreed in chat or already under way; again to lock the draft'],
    ['lock <id> <id>', 'lock the draft with those depth answers ticked'],
    ['add <flow> start|end|before <state>|after <state>', 'add a flow to the draft'],
    ['drop <flow>', 'take a flow out of the draft'],
    ['hands-free|hands-free off', 'let Claude make the calls that would wait for you, or take them back'],
    ['pause|resume', "stop enforcing the plan and keep it; enforce it again, or pick up an earlier session's plan"],
    ['skip <state> [reason]', 'skip a state: Claude leaves it, and its check no longer runs at the end'],
    ['finish [reason]', 'close the plan where it stands, without the final checks'],
    ['reset', 'drop the current plan'],
    ['parallel|parallel on|parallel off', 'say whether parallel states are on, or turn them on or off'],
  ]],
  ['The Library', [
    ['library|flows', 'list the instructions and flows with their switches, and the weight'],
    ['on <name>|off <name>', 'switch an item on or off for this project; add preset or everywhere for the preset in use or every project'],
    ['weight light|standard|thorough', 'pick the weight for this project; add preset or everywhere for the preset in use or every project'],
    ['trust <name>', "turn on an instruction or flow file Sentinel didn't save on this computer"],
    ['flow save project|flow save preset|flow save everywhere|flow discard', 'keep or drop the flow or instruction Claude drafted'],
    ['preset', 'list your presets: settings shared by the projects that use one'],
    ['preset <name>|preset none', "use a preset here, under this project's own settings, or stop using it"],
    ['preset new <name>', 'make an empty preset and use it here'],
    ['preset move <name>', "move this project's own settings into a preset and use it here"],
    ['preset delete <name>', 'delete a preset'],
    ['mcp', 'list the MCP servers needed here, and whether this session has them'],
    ['mcp add <server>|mcp drop <server>', "put a server on this project's list or take it off; add preset or everywhere for the preset in use or every project"],
  ]],
  ['The System map', [
    ['redraw <part>', 'ask Claude to reread a part or an area and redraw it; you answer before anything changes'],
    ['fine <part>', 'clear the Changed since drawn mark until its files change again'],
  ]],
]

// /sentinel help: each command with what it does, a long one with its words on the next line.
export function helpText(): string {
  const W = 38
  const row = ([use, does]: readonly [string, string]) => {
    const cmd = `/sentinel${use ? ` ${use}` : ''}`
    return cmd.length <= W - 2 ?`  ${cmd.padEnd(W)}${does}` : `  ${cmd}\n  ${' '.repeat(W)}${does}`
  }
  return [
    "Sentinel's commands. Type them at the prompt.",
    ...COMMANDS.map(([group, rows]) => `\n${group}\n${rows.map(row).join('\n')}`),
    '\nCommands that change the plan or the Library run only when you type them. Claude can\'t run them.',
  ].join('\n')
}
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
// Opens a visit on a task. A task sent back to starts without the outcome of its first pass, and keeps the files it changed.
function openVisit(tasks: Record<string, Task> | undefined, id: string, visit: Task['visits'][number]): Record<string, Task> {
  const own = taskIn(tasks, id)
  return { ...tasks, [id]: { visits: [...(own?.visits ?? []), visit], ...(own?.edited ? { edited: own.edited } : {}) } }
}
// Adds the files a task changed, each once.
function withEdited(tasks: Record<string, Task> | undefined, id: string, files: string[]): Record<string, Task> {
  const own = taskIn(tasks, id) ?? { visits: [] }
  return files.length ? { ...tasks, [id]: { ...own, edited: [...new Set([...(own.edited ?? []), ...files])] } } : { ...tasks }
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
    ready.length ? `Ready to run beside you: ${ready.join(', ')}. Give each one a brief with action "brief" (to, brief): what to do and what to watch for. Add "agent" and "model" to choose what it runs on. Sentinel then starts a member agent for it in a worktree of its own.` : '',
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
  if (busy) return `${id} may edit the same files as ${busy}, which is ${busy === r.active && waitingOn(r) ? `waiting on the user now. Wait until they answer and ${busy} is done` : `being worked on now. Wait until ${busy} is done`}, then brief ${id}.`
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

// With parallel states on, a plan may run in a line only because nobody set needs. The neighbours that share no files are
// the ones to ask about. One that asks the user first can't go to a member, and one listed as done can't run at all.
export function lineNote(states: StateDef[]): string | undefined {
  if (states.some((s, k) => needsOf(states, s.id).join() !== (k ? states[k - 1]!.id : ''))) return undefined
  const free = (s: StateDef) => s.files.length > 0 && !waitOf(s) && !s.evidence
  const pairs = states.slice(1).flatMap((s, k) => {
    const a = states[k]!
    return free(a) && free(s) && !a.files.some(f => s.files.some(g => globsMeet(f, g))) ? [`${a.id} and ${s.id}`] : []
  })
  if (!pairs.length) return undefined
  const more = pairs.length > 4 ? ` and ${pairs.length - 4} more` : ''
  return `[sentinel] Parallel states are on, but this plan runs in a line. These neighbours share no files: ${pairs.slice(0, 4).join('; ')}${more}. If neither of a pair builds on the other, give them "needs" so they run at the same time. If the line is right, tell the user why.`
}

// Before the plan completes, the checks of the done states run again: each command once, apart from the one that
// just passed.
// A skipped state is left out.
export function sweepChecks(r: Run, passed?: string): string[] {
  const done = doneOf(r)
  const checks = r.plan!.states.filter(s => done.includes(s.id) && !r.skipped?.[s.id] && s.check && !s.once && !(passed && sameText(s.check, passed))).map(s => s.check!)
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
  return [...new Set(fixedOf(r).flatMap(s => (s.check && !s.once && !(own && sameText(s.check, own)) ? [s.check] : [])))]
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
export function memberIn(r: Run, id: string, outcome: string | undefined, t: string, now: number, files: string[] = []): Run {
  if (!r.running?.[id]) return r
  return { ...offMember(r, id), done: [...doneOf(r), id], tasks: withEdited(closeVisit(r.tasks, id, now, clip(outcome)), id, files), log: [...r.log, { t, icon: '⇇', tone: 'ok', text: `${id} · member work applied` }] }
}

const offMember = (r: Run, id: string): Run => ({ ...r, running: Object.fromEntries(members(r).filter(([k]) => k !== id)) })

export function startMember(r: Run, id: string, m: Omit<Member, 'since'>, t: string, now: number): Run {
  return {
    ...r,
    running: { ...r.running, [id]: { ...m, since: now } },
    tasks: openVisit(r.tasks, id, { from: now, by: 'member' }),
    log: [...r.log, { t, icon: '⇉', tone: 'acc', text: `${id} · member started${m.how ? ` · ${m.how}` : ''}` }],
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
export const freshCount = (r: Run, at: string): Partial<Run> => (counting(r) ? {} : { spend: [], spendFrom: at, usage: undefined, sources: undefined, refused: undefined })

// A run rebuilt at the lock keeps the count it had.
const keepCount = (r: Run): Partial<Run> => ({ ...(r.spend ? { spend: r.spend, spendFrom: r.spendFrom } : {}), ...(r.usage ? { usage: r.usage } : {}) })

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

// A reading of the session's cost and the limits. What the cost grew by goes to the plan and to the step running then. The
// cost drops when /clear or a new session starts it over, and what the plan has stays.
// ponytail: a member agent's cost goes to the step active in the main conversation; split it if parallel runs make that misleading.
export function addUsage(r: Run, usd: number, windows: UsageWindow[], price: number | undefined): Run {
  if (!counting(r)) return r
  const u = r.usage
  const grew = !u ? 0 : usd >= u.last ? usd - u.last : usd
  const id = isUnfinished(r) ? r.active! : undefined
  const had = u?.began ?? []
  return {
    ...r,
    usage: {
      usd: (u?.usd ?? 0) + grew, last: usd,
      byState: grew && id ? { ...u!.byState, [id]: (u!.byState[id] ?? 0) + grew } : (u?.byState ?? {}),
      windows: windows.length ? windows : (u?.windows ?? []),
      began: [...had, ...windows.filter(w => !had.some(x => x.kind === w.kind))],
      ...(price ? { perPoint: price } : {}),
    },
  }
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
// The user answered what the active state asked, after it asked: an early "go ahead" doesn't count. A stop that went
// through the question dialog carries `ok`, and only that settles it: the Yes label or the dashboard's Approve. What the
// user types then goes to Claude and leaves the stop closed. A stop saved without `ok` keeps the old rule: any message
// the user typed after it.
export const answered = (r: Run, kind?: Wait) => {
  if (r.handsFree) return true
  const p = pendingOf(r)
  if (!p || (kind && p.kind !== kind)) return false
  return p.ok ?? (r.heardAt ?? 0) > p.at
}
// Hands-free, from /sentinel hands-free or the dashboard; off takes it back.
export const handsFree = (r: Run, on: boolean, t: string): Run =>
  !isLive(r) || !!r.handsFree === on ? r
    : touched({ ...(on ? freeWeights(r, t) : r), handsFree: on || undefined, log: [...r.log, { t, icon: on ? '✓' : '?', tone: on ? 'ok' : 'ask', text: on ? 'Hands-free: Claude makes the calls that would wait for you' : 'Hands-free off: Claude asks you again' }] })
// Hands-free, nobody is there to answer: the lighter weights states asked for go through, and the dashboard lists them.
// They stay when hands-free goes off, like the other calls Claude made.
function freeWeights(r: Run, t: string): Run {
  if (!r.library?.states) return r
  const done = doneOf(r)
  const owed = (s: StateDef) => !!s.weight && weightFor(r, s) !== s.weight && !done.includes(s.id)
  const went = r.plan?.states.filter(owed) ?? []
  return went.length ? {
    ...r,
    plan: { ...r.plan!, states: r.plan!.states.map(s => (owed(s) ? { ...s, weightOk: true as const } : s)) },
    audit: [...r.audit, ...went.map(s => ({ step: r.step + 1, t, state: s.id, kind: 'decided' as const, text: `Went ${s.weight} hands-free: ${s.weightWhy}` }))],
  } : r
}
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

// What the run is blocked on, while the user hasn't replied and Claude hasn't moved on.
export const blockedOn = (r: Run) => (r.blocked && r.blocked.at === r.escalatedAt && waitingOn(r) ? r.blocked : undefined)

// A state that asks before it starts takes no edits until the user has answered its proposal.
export function notYet(r: Run): string | undefined {
  const st = isLive(r) ? stateOf(r) : undefined
  if (!st || waitOf(st) !== 'before' || answered(r, 'before')) return undefined
  return pendingOf(r)?.kind === 'before'
    ? `${st.id} waits for the user's answer to your proposal. Stop your turn and wait for them.`
    : `${st.id} asks the user before you start. Call plan with action "propose" and "intent": what you will do there. Then stop your turn; edits open once they answer.`
}
// A review the user already gave of the active state, still good after a loop back: none of the state's own files has been
// edited since. A state with no files of its own can't show that, so it asks again. elsewhere: the files edited since in
// other states, which the user did not look at. Only what the ledger recorded counts, as with the map's marks.
export function keptReview(r: Run, st: StateDef): { elsewhere: string[] } | undefined {
  const at = r.reviewed?.[st.id]
  if (at === undefined || !st.files.length) return undefined
  const since = r.calls.filter(c => c.kind === 'edit' && !c.denied && c.file !== undefined && c.step > at)
  if (since.some(c => st.files.some(g => globMatch(g, c.file!)))) return undefined
  return { elsewhere: [...new Set(since.map(c => c.file!))] }
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

// A forward-slash path with its . and .. parts resolved. Nothing goes above a root; a relative path keeps the .. that
// climb past its start, so it still reads as leaving.
function dropDots(path: string): string {
  const parts: string[] = []
  for (const p of path.split('/')) {
    const top = parts.at(-1)
    if (p === '.' || (p === '' && parts.length)) continue
    if (p !== '..') parts.push(p)
    else if (top === undefined || top === '..') parts.push(p)
    else if (top !== '' && !/^[a-z]:$/i.test(top)) parts.pop()
  }
  return parts.join('/') + (path.length > 1 && path.endsWith('/') ? '/' : '')
}

// Project-relative path with forward slashes, or undefined when outside the project.
export function relPath(root: string, file: string): string | undefined {
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  // Git Bash spells D:/x as /d/x.
  const f = dropDots(file.replace(/\\/g, '/').replace(/^\/([a-z])\//i, (m, d: string) => (/^[a-z]:/i.test(r) ? `${d}:/` : m)))
  // A worktree agent edits the project's files under .claude/worktrees/<name>/, inside the project or in the main checkout.
  // ponytail: any such path counts as this project's; compare git common dirs if other repos' worktrees get edited from here.
  // The last such folder in the path counts, so a session that itself runs in a worktree maps its members' files too.
  const wt = /^(?:.*\/)?\.claude\/worktrees\/[^/]+\/(.+)$/.exec(f)
  if (wt) return wt[1]
  if (!/^([a-z]:)?\//i.test(f)) return /^\.\.(\/|$)/.test(f) ? undefined : f
  return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : undefined
}

// A path as the session's list of written files keeps it: absolute, forward slashes, no . or .. parts, lower-cased on
// Windows (a drive letter shows it). A file in a member's worktree counts as the project's, where its work comes back.
export function pathKey(root: string, file: string): string {
  const rel = relPath(root, file)
  const r = root.replace(/\\/g, '/').replace(/\/$/, '')
  const f = file.replace(/\\/g, '/')
  const key = dropDots(rel !== undefined ? `${r}/${rel}` : /^([a-z]:)?\//i.test(f) ? f : `${r}/${f}`)
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

// The parts of the system map whose last proof an edit has undone: the part has a proof, and a file in it was edited
// after that proof. Only what the ledger recorded counts, so an edit made by a shell command waits for the next look at
// the files. A proof from an earlier run is older than every edit of this one.
export function editedSince(map: SystemMap, r: Pick<Run, 'calls' | 'startedAt'>, marks: Marks): Set<string> {
  const out = new Set<string>()
  for (const p of map.parts) {
    const m = marks[p.id]
    if (m?.hash === undefined || !p.files?.length) continue
    const after = m.run === r.startedAt && m.step !== undefined ? m.step : -1
    if (r.calls.some(c => c.kind === 'edit' && !c.denied && c.file !== undefined && c.step > after && p.files!.some(g => globMatch(g, c.file!)))) out.add(p.id)
  }
  return out
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
  | { kind: 'check'; label: string; pass: boolean; sig: string; sigText: string; fails: number; touches?: number; tail?: string; ms?: number }

// A read or command's identity: the tool, its input and its output, with times and the like taken out of the output
// (as failSig does), so running the same thing again counts as a repeat.
export function lookPrint(tool: string, input: Record<string, unknown>, text: string): string {
  const { tool: _t, tool_use_id: _id, consent: _c, description: _d, ...rest } = input
  return fnv(`${tool}\n${JSON.stringify(rest, Object.keys(rest).sort())}\n${text.split(/\r?\n/).map(normLine).join('\n')}`)
}

// After this many edits with the check not run while it fails, an edit no longer counts as progress.
const BLIND_EDITS = 6
const editsSince = (calls: Call[], step: number) => calls.filter(x => x.kind === 'edit' && x.ver && !x.denied && x.step > step).length
// The version a file held when a call ran: its last edit before then, or what it was before its first edit.
function verAt(calls: Call[], file: string, step: number): string | undefined {
  const edits = calls.filter(x => x.kind === 'edit' && x.file === file && x.ver && !x.denied)
  return edits.findLast(x => x.step < step)?.ver ?? edits[0]?.before
}
// A version some failing check ran on.
const failedOn = (calls: Call[], file: string, ver: string) => calls.some(x => x.kind === 'check' && !x.pass && verAt(calls, file, x.step) === ver)

// The end of a check's output, which a refusal shows.
// eslint-disable-next-line no-control-regex
export const tailOf = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\n?\[sentinel\] exit \d+\s*$/, '').trim().slice(-1500)
// What a check printed last, to say why it failed.
export const lastLines = (text: string, n = 20) => tailOf(text).split(/\r?\n/).slice(-n).join('\n')

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
    if (o.ms !== undefined) c.ms = o.ms
    // Something touched the project while it ran: the result may be stale already.
    if (o.touches !== undefined && o.touches === (r.touches ?? 0)) c.touches = o.touches
    // A failure seen before in this visit, and no fewer of it, is the same failure, so bouncing between two counts too.
    const seen = o.pass || !lastCheck || lastCheck.pass ? undefined : visit.findLast(x => x.kind === 'check' && !x.pass && x.sig === o.sig)
    if (seen && o.fails >= (seen.fails ?? 0)) {
      c.repeat = true
      c.same = true
      // Edits since the last run were credited on faith; the same failure takes it back.
      visit = visit.map(x => (x.prov && x.step > lastCheck!.step ? { ...x, u: 0, prov: undefined, revoked: true } : x))
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
      // Back to a version a failing check already ran on. One no check saw fail, such as the file before a debug line
      // went in, is new as far as the check knows.
      const seen = failedOn(visit, o.file, o.ver) ? visit.find(x => x.file === o.file && (x.ver === o.ver || x.before === o.ver)) : undefined
      if (seen) {
        c.repeat = true
        c.revisitOf = seen.step
      } else if (failing && editsSince(visit, lastCheck!.step) >= BLIND_EDITS) c.blind = true
      else {
        c.u = 1
        if (failing) c.prov = true
      }
    }
  } else if (o.kind === 'look') {
    // A new read is progress however many come in a row; reading the same thing again is a repeat.
    c.fp = o.fp
    if (visit.some(x => x.fp === o.fp)) c.repeat = true
    else c.u = 1
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
    // The failure was there before the window began: from the checks before it, or the first check when none came before.
    const before = checks.filter(x => x.step < win[0]!.step)
    c.p = (before.length ? before : checks.slice(0, 1)).some(x => !x.pass && x.sig === last.sig) ? 1 : 0.5
  }
  c.H = 1 - c.p * Math.max(c.S, c.R)

  let traps = r.traps
  let note: string | undefined
  let trapped: Trap | undefined
  const open = openTrap(r)
  // The overseer said a mark in this visit was moving: no new one opens until the state is entered again.
  const muted = r.traps.some(x => x.muted && x.state === state && x.step > r.enteredAt)
  if (!open && !muted && c.n >= K && c.H <= THETA) {
    const rev = win.findLast(x => x.revisitOf !== undefined)
    const pattern = rev ? 'cycle' : win.filter(x => x.kind === 'look').length * 2 > win.length ? 'drift' : 'static'
    trapped = { state, pattern, step, notes: 1, lastNote: step }
    if (rev) Object.assign(trapped, { file: rev.file, ver: rev.ver, revisitOf: rev.revisitOf })
    traps = [...traps, trapped]
    c.trapStart = true
    log.push({ t, icon: '⟲', tone: 'err', text: `Stuck · ${pattern}${rev ? ` on ${rev.file}` : ''}` })
  } else if (open && o.kind === 'check' && c.u === 1) {
    // It ends when the check result changes, a pass or a failure not seen before, as the paper's recovery rule has it.
    // Health rising on a few new reads doesn't end it, so it can't open again at note 1.
    traps = traps.map(x => (x === open ? { ...x, end: step } : x))
    log.push({ t, icon: '✓', tone: 'ok', text: `Released · ${o.pass ? 'the check passes' : 'the check fails a new way'}` })
  } else if (open && step - open.lastNote >= K && c.H <= THETA) {
    trapped = { ...open, notes: open.notes + 1, lastNote: step }
    traps = traps.map(x => (x === open ? trapped! : x))
  }

  const calls = [...r.calls.filter(x => x.step <= r.enteredAt), ...all].slice(-MAX_CALLS)
  const run: Run = { ...r, step, calls, traps, audit, log: log.slice(-60), ...(lastFail ? { lastFail } : {}), ...(o.kind === 'edit' && !o.denied ? { tasks: withEdited(r.tasks, state, [o.file]) } : {}) }
  if (trapped) note = noteText(run, trapped, c.H)
  return { run, note, trapped }
}

// The failure a stuck mark is about: the check, what it printed, and the runs in this visit that failed that way.
function gapOf(r: Run, st?: StateDef): string | undefined {
  const fails = visitOf(r).filter(x => x.kind === 'check' && !x.pass)
  const last = fails.at(-1)
  if (!last || !st?.check) return undefined
  const same = fails.filter(x => x.sig === last.sig).map(x => x.step)
  return `\`${st.check}\` fails "${last.sigText}" on ${same.length} run(s) (steps ${same.join(', ')}).`
}

// What each stuck pattern means, in plain words.
const PATTERN_SAYS: Record<Trap['pattern'], string> = {
  cycle: 'a file went back to a version that already failed the check',
  drift: 'reading the same things again without changing anything while the check fails',
  static: 'calls that change nothing while the check fails',
  hung: 'a check that stopped making output',
}

// Note 2 and later only say which note it is: the engine adds that the overseer looks, when one starts.
function noteText(r: Run, trap: Trap, H: number): string {
  const lines = [`[sentinel] Stuck: ${trap.pattern.toUpperCase()} in state ${trap.state} (health ${H.toFixed(2)}).`]
  if (trap.file && trap.ver) lines.push(`${trap.file} is back to ${verLabel(r.calls, trap.file, trap.ver)}, a version it already had at step ${trap.revisitOf}. That version already failed the check.`)
  const gap = gapOf(r, stateOf(r, trap.state))
  if (gap) lines.push(`Gap: ${gap}`)
  const edits = editsSince(visitOf(r), visitOf(r).findLast(x => x.kind === 'check')?.step ?? r.enteredAt)
  if (trap.pattern === 'drift') lines.push('You have been reading the same things again without changing anything while the check fails. Make the smallest edit that tests your current idea, then run the check.')
  else if (edits >= BLIND_EDITS) lines.push(`You have made ${edits} edits since the check last ran. Run the check to see where you stand before the next edit.`)
  else lines.push("Until the failure changes, don't re-apply versions that already failed. Get new evidence before the next edit: read code you haven't read in this state, or log the value that comes out wrong.")
  if (trap.notes >= 2) lines.push(`This is note ${trap.notes}.`)
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

// stop: the call ended at a stop that waits on the user, which Sentinel asks in the dialog (unless they are hands-free).
export type Acted = { run: Run; text: string; ok: boolean; event?: 'locked' | 'drafted' | 'complete'; stop?: Wait }
// Results of the checks of states done before the lock, keyed by command.
export type Proofs = Record<string, { pass: boolean; sigText: string; tail?: string }>
// A failing check's one line, with its last lines under it. Three checks' worth is enough to act on: the final-checks log keeps the rest.
export const withTail = (line: string, proof: Proofs[string] | undefined, i: number) => (proof?.tail && i < 3 ? `${line}\n${proof.tail}` : line)

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
  if (i.action === 'finish') return finish(r, i, t, now, typed)
  if (!isLive(r)) {
    if (r.paused) return refuse(r, 'The user paused Sentinel. Work as they ask; they resume the plan with /sentinel resume.')
    return refuse(r, r.active === 'done' ? 'The plan is complete. A new plan needs a new sign-off.' : 'No plan is locked.')
  }
  if (i.action === 'advance') return advance(r, i, t, now, proofs, false, without)
  if (i.action === 'map') return mapChange(r, i, t)
  if (i.action === 'propose') return propose(r, i, t, now)
  if (i.action === 'skip') return skip(r, i, t, now, proofs, typed)
  if (i.action === 'amend') return amend(r, i, t)
  if (i.action === 'decide') return decide(r, i, t)
  if (i.action === 'escalate') return escalate(r, i, t, now)
  return refuse(r, `Unknown action "${i.action}". Use define, revise, advance, brief, propose, skip, finish, amend, decide, escalate, map or status.`)
}

const closedText = (c: NonNullable<Run['closed']>) => [
  'Plan closed by the user, with no final checks.',
  c.unfinished.length ? `Not finished: ${c.unfinished.join(', ')}.` : '',
  c.unchecked.length ? `Done but not rechecked: ${c.unchecked.join(', ')}.` : '',
  'Questions are open again.',
].filter(Boolean).join(' ')

// The user closes the plan, finished or not, paused or not: nothing runs again, and the plan says what that leaves
// unproven. A state left unfinished counts as skipped. A member working on one is let go, and its answer is ignored.
function finish(r: Run, i: PlanInput, t: string, now: number, typed: boolean): Acted {
  if (!isUnfinished(r)) return refuse(r, r.active === 'done' ? 'The plan is complete. A new plan needs a new sign-off.' : 'No plan is locked.')
  if (!typed) return refuse(r, 'Only the user closes a plan. Call finish in the turn where they ask for it in the chat; they can also type /sentinel finish.')
  const why = clip(i.reason) ?? 'The user closed the plan.'
  const done = doneOf(r)
  const states = r.plan!.states
  const unfinished = states.filter(s => !done.includes(s.id)).map(s => s.id)
  const unchecked = states.filter(s => done.includes(s.id) && s.check && !s.once && !r.skipped?.[s.id]).map(s => s.id)
  let tasks = closeVisit(r.tasks, r.active!, now)
  for (const id of Object.keys(r.running ?? {})) tasks = closeVisit(tasks, id, now)
  const { running: _running, pending: _pending, paused: _paused, hung: _hung, lastLoop: _lastLoop, ...rest } = r
  const closed = { why, unfinished, unchecked }
  const run: Run = {
    ...rest, active: 'done', done: [...done, ...unfinished], closed, enteredAt: r.step, endedAt: now, tasks, auto: 0, askToken: 0, breakingOk: false,
    skipped: { ...r.skipped, ...Object.fromEntries(unfinished.map(id => [id, `Not finished: ${why}`])) },
    traps: r.traps.map(x => (x.end === undefined ? { ...x, end: r.step } : x)),
    audit: [...r.audit, { step: r.step + 1, t, state: r.active!, kind: 'decided', text: `Closed the plan: ${why}` }],
    log: [...r.log, { t, icon: '■', tone: 'warn', text: `Plan closed by the user · ${done.length}/${states.length} done` }],
  }
  return { run, ok: true, event: 'complete', text: closedText(closed) }
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
  return { run, ok: true, stop: 'before', text: `The user sees your proposal above the prompt and on the dashboard. Put it in your reply too, then stop your turn and wait. Edits in ${st.id} open once they answer; if they ask for changes, propose again.` }
}

// ---- the question dialog ----
// Sentinel's own questions go through the engine's dialog: the approval stops, and a part the user signed off on that Claude
// wants to drop. The words are Sentinel's, apart from Claude's reason, which is clipped and quoted. `$.ui.ask` takes labels
// only, so what each answer does goes in the question.

export type StopAsk = { question: string; yes: string; no: string }
// What the user answered: a label, words typed under Other, or nothing (Esc, "Chat about this", or no one to ask).
export type Answer = { how: 'yes' } | { how: 'no' } | { how: 'words'; words: string } | { how: 'none' }

const quoted = (text: string | undefined, max = 300) => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t ? `"${t.length > max ? `${t.slice(0, max).trimEnd()}…` : t}"` : undefined
}
const listOf = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

// The question for the stop the active state waits on.
export function stopAsk(r: Run, kind: Wait): StopAsk | undefined {
  const st = stateOf(r)
  const p = pendingOf(r)
  if (!st || !p || p.kind !== kind) return undefined
  const said = quoted(p.text)
  return kind === 'before'
    ? { question: `Claude is ready to start ${st.label}.${said ? ` It plans to:\n${said}` : ''}\nGo ahead?`, yes: 'Yes, go ahead', no: 'No, hold off' }
    : { question: `${st.label} is finished and ready for your review.${said ? `\nClaude says: ${said}` : ''}\nAccept it?`, yes: 'Yes, accept it', no: 'No, it needs changes' }
}

// What the dialog's reply means. Only the Yes label is a yes, and so is the same text typed under Other, exactly.
export function readAnswer(ask: { yes: string; no: string }, said: string): Answer {
  const t = said.trim()
  return t === ask.yes ? { how: 'yes' } : t === ask.no ? { how: 'no' } : t ? { how: 'words', words: t.slice(0, 500) } : { how: 'none' }
}

// The run once the user answered the stop. Yes opens it. No and words close it and drop the request, so Claude asks again.
// No answer changes nothing: the stop stays closed, and waits.
export function stopSettled(r: Run, a: Answer, t: string, now: number): Run {
  const p = pendingOf(r)
  if (!p || a.how === 'none') return r
  const what = p.kind === 'before' ? 'proposal' : 'work'
  const said = a.how === 'yes' ? `Approved the ${what} in the dialog.` : a.how === 'no' ? `Said no to the ${what} in the dialog.` : `Answered the ${what} in the dialog: ${a.words}`
  const heardR = heard(r, now)
  return {
    ...heardR, pending: a.how === 'yes' ? { ...p, ok: true } : undefined,
    audit: [...heardR.audit, { step: heardR.step, t, state: p.state, kind: 'decided', text: said }],
    log: [...heardR.log, { t, icon: a.how === 'yes' ? '✓' : '?', tone: a.how === 'yes' ? 'ok' : 'ask', text: `${p.state} · ${a.how === 'yes' ? 'approved' : a.how === 'no' ? 'said no' : 'answered'}` }],
  }
}

// What Claude hears of the answer. late: Claude's call has ended already (the answer came from the band), so it is told
// to call again; otherwise the call's own reply carries what follows.
export function stopText(p: NonNullable<Run['pending']>, a: Answer, late = false): string {
  const id = p.state
  const words = a.how === 'words' ? a.words : ''
  if (p.kind === 'before') {
    return a.how === 'yes' ? `The user said yes. Go ahead with ${id}.`
      : a.how === 'no' ? `The user said no to your proposal for ${id}. Don't start it. Ask what they want changed, or propose again once you have changed it.`
      : a.how === 'words' ? `The user answered your proposal for ${id} with: "${words}". That is not a yes, so edits in ${id} stay closed. Answer them, then propose again.`
      : `The user closed the question without answering. Edits in ${id} stay closed. Put your proposal in your reply, then stop your turn and wait. They can answer from the band above the prompt or on the dashboard.`
  }
  return a.how === 'yes' ? `The user accepted ${id}.${late ? ' Call advance again.' : ''}`
    : a.how === 'no' ? `The user says ${id} needs changes. Ask what, make them, then advance again.`
    : a.how === 'words' ? `The user answered your review of ${id} with: "${words}". That is not an acceptance, so ${id} stays in review. Answer them, make any changes, then advance again.`
    : `The user closed the question without answering. ${id} stays in review. Say in your reply what was done and what they should check, then stop your turn and wait. They can answer from the band above the prompt or on the dashboard.`
}

// The parts a map call would take off that the user signed off on and that nothing else holds: a state that builds a part
// keeps it on the map, and so does a missing reason. Those are refused without asking.
export function signedDrops(r: Run, i: PlanInput): string[] {
  const d = r.drawing
  // With no plan running the map call is refused whatever the user answers, so there is nothing to ask.
  if (!isLive(r) || !d?.locked || !r.plan || !clip(i.reason)) return []
  const drop = [...new Set((i.drop ?? []).map(x => String(x).trim()).filter(Boolean))]
  return drop.filter(id => d.locked!.parts.some(p => p.id === id) && d.map.parts.some(p => p.id === id) && !r.plan!.states.some(s => s.parts?.includes(id)))
}
export function dropAsk(r: Run, ids: string[], reason: string): StopAsk {
  const names = ids.map(id => r.drawing?.map.parts.find(p => p.id === id)?.name ?? id)
  const one = ids.length === 1
  return {
    question: `Claude wants to stop building ${listOf(names)}, which you signed off on.\nClaude's reason: ${quoted(reason)}\nIf you say yes, ${one ? 'it comes' : 'they come'} off the map and ${one ? 'shows' : 'show'} under Changes at the finish.\nRemove ${one ? 'it' : 'them'}?`,
    yes: `Yes, remove ${one ? 'it' : 'them'}`, no: `No, keep ${one ? 'it' : 'them'}`,
  }
}
// What Claude hears when the part stays.
export function dropText(ids: string[], a: Answer): string {
  const one = ids.length === 1
  const stay = `${ids.join(', ')} ${one ? 'stays' : 'stay'} on the map. Keep building ${one ? 'it' : 'them'}.`
  return a.how === 'no' ? `The user said no, so ${stay}`
    : a.how === 'words' ? `The user answered with: "${a.words}". ${stay}`
    : `The user closed the question without answering, so ${stay} Tell them in your reply what you wanted to change, and that the Answer button above the prompt asks them again.`
}

// ---- redraw: the user asked for an area to be reread ----

const few = (xs: string[]) => (xs.length > 5 ? `${xs.slice(0, 5).join(', ')} and ${xs.length - 5} more` : listOf(xs))
// A redraw that changes nothing the user can see: the same parts, the same words, the same lines.
export const redrawSame = (c: MapChanges) => !c.added.length && !c.edited.length && !c.dropped.length && !c.linesAdded.length && !c.linesDropped.length
// The question that ends a redraw: what Claude did to the area, and what each answer does.
export function redrawAsk(names: string[], c: MapChanges): StopAsk {
  const area = listOf(names)
  if (redrawSame(c)) return { question: `Claude reread ${area} and found the drawing still right.\nMark it as up to date?`, yes: 'Yes, mark it up to date', no: 'No, leave it' }
  const lines = c.linesAdded.length + c.linesDropped.length
  const did = [
    c.added.length && `adds ${few(c.added.map(x => x.name))}`,
    c.edited.length && `changes ${few(c.edited.map(x => x.name))}`,
    c.dropped.length && `takes off ${few(c.dropped.map(x => x.name))}`,
    lines && `redraws ${lines} ${lines === 1 ? 'line' : 'lines'}`,
  ].filter(Boolean) as string[]
  return { question: `Claude redrew ${area}.\nIt ${listOf(did)}.\nKeep the new drawing? A yes also marks it as drawn today.`, yes: 'Yes, keep it', no: 'No, keep the old one' }
}
// What Claude hears of the answer.
export function redrawText(names: string[], a: Answer, same: boolean): string {
  const area = listOf(names)
  return a.how === 'yes' ? (same ? `The user marked ${area} as up to date.` : `The user kept the new drawing of ${area}. Its marker moved to today.`)
    : a.how === 'no' ? `The user said no, so the old drawing of ${area} stays. Ask what they want changed.`
    : a.how === 'words' ? `The user answered with: "${a.words}". The old drawing of ${area} stays. Answer them, then redraw again if they ask.`
    : `The user closed the question without answering, so the old drawing of ${area} stays. Tell them in your reply what you found, and that the Answer button above the prompt asks them again, so nothing has to be reread.`
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
    // Sent, they replace the draft's list; kept, they lose the steps the new order leaves out.
    ...(i.points ? { points: i.points } : base.points ? { points: dropPoints(base.points, (base.states ?? []).map(idOf).filter(id => !order.includes(id))) } : {}),
    ...(i.drawn ? { drawn: i.drawn } : {}),
    ...(i.library ? { library: i.library } : {}),
  }
}

// final: say what the plan's instructions ask before it completes even when the active state isn't the last.
function here(r: Run, final = false): string {
  const skipped = Object.keys(r.skipped ?? {})
  if (r.closed) return closedText(r.closed)
  const onceOnly = r.plan?.states.filter(s => s.once && !r.skipped?.[s.id]).map(s => s.id) ?? []
  if (r.active === 'done') return `Plan complete.${onceOnly.length ? ` Not run again, marked once: ${onceOnly.join(', ')}.` : ''}${skipped.length ? ` The user skipped ${skipped.join(', ')}.` : ''} Questions are open again.`
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
    mapHere(r, st),
    // The final instructions come at the lock, and again once this is the last state left.
    toldHere(r, st, final || r.plan!.states.every(s => s.id === st.id || doneOf(r).includes(s.id))),
  ].filter(Boolean).join('\n')
}

// The parts a state builds, from the plan's map, for the reply that starts it and for a member's prompt. Nothing when
// the state names no part or the plan has no map.
export const mapHere = (r: Run, st: StateDef): string => (r.drawing ? stateReads(r.drawing.map, st.parts ?? []) : '')

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
  long: q => `"${shown(q)}" is over ${MAX_QUOTE_WORDS} words. Quote the sentence that asks for it.`,
}
// A refusal first: the rarer verdict says more than "missing" from every other source does.
const RANK: Record<string, number> = { missing: 0, short: 1, excluded: 2, empty: 3 }

// Each state says where it came from, and Sentinel compares the words itself. A state a flow put in is the user's own, one
// done before the lock has nothing left to prove, and one that is only there for a depth answer goes if they leave it unticked.
// Sets asked or added on `states`. used: the sources to keep, which take a typed message only if a quote needs it.
function proofOf(i: PlanInput, states: StateDef[], at: number, depth: Depth[], points: Point[], kept: Source[], t: string): { used: Source[]; refused: Refused[]; text: string } {
  const typed: Source[] = (i.messages ?? []).map(m => ({ kind: 'message' as const, text: m.text, at: m.at })).reverse()
  const docs = [...kept, ...typed]
  const used = [...kept]
  const refused: Refused[] = []
  const lines: string[] = []
  const exempt = new Set([...states.slice(0, at).map(s => s.id), ...states.filter(s => s.flow).map(s => s.id), ...depth.flatMap(d => d.state ?? [])])
  // One quote against the sources. A state's, or a point's: owner names it in the refusal.
  const quoted = (q: string, owner: string) => {
    let why: Refused['why'] = squash(q).split(' ').length > MAX_QUOTE_WORDS ? 'long' : 'missing'
    const from = why === 'long' ? undefined : docs.find(d => {
      const v = checkQuote(d.text, q)
      if (v !== 'ok' && RANK[v]! > RANK[why]!) why = v
      return v === 'ok'
    })
    if (from) {
      if (!used.includes(from)) used.push(from)
      return
    }
    // What goes on the record is saved, so its nearest passage comes from what is saved already, never an unused message.
    const near = why === 'missing' ? nearest(kept.map(d => d.text).join('\n'), q) : ''
    const told = why === 'missing' ? nearest(docs.map(d => d.text).join('\n'), q) : ''
    refused.push({ state: owner, quote: shown(q), why, ...(near ? { nearest: near } : {}), t })
    lines.push(`- ${owner}: ${REFUSALS[why](q)}${told ? ` Nearest: "${shown(told)}".` : ''}`)
  }
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
    for (const q of asked) quoted(q, st.id)
  }
  for (const [k, p] of points.entries()) quoted(p.said, `point ${k + 1}`)
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
  // Which parts of the map these are is checked against the map where the drawing is (the link state).
  const parts = Array.isArray(s.parts) ? [...new Set(s.parts.filter((p): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean))] : []
  if (group && !/^[A-Za-z0-9][\w-]*(\/[A-Za-z0-9][\w-]*)*$/.test(group)) return `Bad group "${group}" on ${id}: use letters, digits, - and _, with / for a group inside a group.`
  if (s.wait !== undefined && ![true, false, 'before', 'after'].includes(s.wait)) return `wait on ${id} is "before" (the user OKs your plan for it first) or "after" (they review the finished work).`
  const wait: Wait | undefined = s.wait === 'after' ? 'after' : s.wait ? 'before' : undefined
  if (s.once !== undefined && typeof s.once !== 'boolean') return `"once" on ${id} must be true or false.`
  if (s.once && !check) return `${id} has "once" but no check. "once" means its check runs at its advance and not again at the end.`
  const flow = typeof s.flow?.name === 'string' && typeof s.flow.as === 'string' ? { name: s.flow.name, as: s.flow.as, why: String(s.flow.why ?? '') } : undefined
  return { id, label: s.label?.trim() || id, ...(check ? { check } : {}), ...(s.once ? { once: true as const } : {}), files: (s.files ?? []).map(f => f.trim()).filter(Boolean), ...(parts.length ? { parts } : {}), ...(ref ? { ref } : {}), ...(group ? { group } : {}), ...(title ? { title } : {}), ...(problem ? { problem } : {}), ...(approach ? { approach } : {}), ...(wait ? { wait } : {}), ...(needs ? { needs } : {}), ...(flow ? { flow } : {}), ...(s.weight ? { weight: s.weight } : {}), ...(s.weightWhy ? { weightWhy: s.weightWhy } : {}), ...(s.weightQuote ? { weightQuote: s.weightQuote } : {}), ...(s.weightOk ? { weightOk: true as const } : {}), ...(s.adds?.length ? { adds: s.adds } : {}) }
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

const FIXED_MID_RUN = ['title', 'source', 'start', 'decisions', 'depth', 'points', 'settings'] as const

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
  const unmapped = namesProblem(r.drawing, fresh)
  if (unmapped) return refuse(r, unmapped)
  const more = loopsFrom(i.loops, inOrder())
  if (typeof more === 'string') return refuse(r, more)
  const proof = proofOf({ ...i, states: sent }, fresh, 0, [], [], r.sources ?? [], t)
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
  return { run: r.handsFree ? freeWeights(run, t) : run, ok: true, text: [`Added ${fresh.map(s => s.id).join(', ')} to the plan: ${order.join(' → ')} → done.`, ...looks, here(run)].join('\n') }
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
  const drawing = drawingOf(i, states)
  if (typeof drawing === 'string') return refuse(r, drawing)
  const loops = loopsFrom(i.loops, states)
  if (typeof loops === 'string') return refuse(r, loops)
  const start = i.start?.trim()
  const at = start ? states.findIndex(s => s.id === start) : 0
  if (at < 0) return refuse(r, `start "${start}" is not one of the states.`)
  // States before start were done before the lock: their check has to pass now, or evidence stands in for one.
  for (let k = 0; k < at; k++) {
    const s = states[k]!
    const given = i.states![k]!.evidence?.trim()
    const runs = s.check && !s.once
    const proof = runs ? proofs[s.check!] : undefined
    if (runs && !proof) return refuse(r, `Sentinel couldn't run \`${s.check}\` for ${s.id}.`)
    if (proof && !proof.pass) return refuse(r, `${s.id} is listed as done, but \`${s.check}\` fails now: ${proof.sigText}. Start at ${s.id}, or fix it first.${proof.tail ? `\n${proof.tail}` : ''}`)
    if (!runs && !given) return refuse(r, `${s.id} is listed as done but has ${s.once ? 'a check marked once' : 'no check'}, so it needs evidence: a commit, a test run, or what the user confirmed.`)
    states[k] = { ...s, evidence: [given, runs && `\`${s.check}\` passed at the lock`].filter(Boolean).join('; ') }
  }
  // The user ticks depth items only on a draft they lock themselves; a plan-mode sign-off locks at once.
  const depth = r.review ? depthOf(i.depth, states) : []
  if (typeof depth === 'string') return refuse(r, depth)
  const points = pointsOf(i.points, states)
  if (typeof points === 'string') return refuse(r, points)
  const kept =[...(keptSources(r) ?? []), ...(i.named ? [i.named] : [])]
  const proof = i.library?.on.includes('quote-the-source') ? proofOf(i, states, at, depth, points, kept, t) : undefined
  if (proof?.refused.length) return refuse({ ...r, refused: [...(r.refused ?? []), ...proof.refused].slice(-MAX_REFUSED) }, proof.text)
  // A state nothing asked for waits for the user's answer, even on a plan they approved. An answer they gave on this
  // draft stands while the reason stays the same.
  const additions = states.filter(s => s.added).map(s => s.id)
  if (r.review) {
    for (const [k, s] of states.entries()) {
      const was = r.draft?.plan?.states.find(x => x.id === s.id)
      if (s.added && was?.okAt && was.added === s.added) states[k] = { ...s, okAt: was.okAt }
      if (s.weight && was?.weightOk && was.weight === s.weight && was.weightWhy === s.weightWhy) states[k] = { ...states[k]!, weightOk: true }
    }
  }
  const looser = looserLeft(i.library, states)
  const drafting = r.review || additions.length > 0 || looser.length > 0
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
  if (drawing) log.push(...mapLog(t, drawing))
  const sources = proof?.used ?? kept
  const run: Run = {
    ...emptyRun(), plan, active: states[at]!.id, audit, log, startedAt: now, tasks: { [states[at]!.id]: { visits: [{ from: now }] } }, ...(i.library ? { library: i.library } : {}), ...(sources.length ? { sources } : {}), ...(r.refused ? { refused: r.refused } : {}), ...keepCount(r), ...(r.flowDraft && !drafting ? { flowDraft: r.flowDraft } : {}),
    ...(drawing ? { drawing: drafting ? drawing : { ...drawing, locked: drawing.map } } : {}),
  }
  const rail = `${states.map(s => s.id).join(' → ')} → done`
  const before = (prior.length ? `\nDone before the lock: ${prior.join(', ')}.` : '') + mapNote(drawing)
  if (drafting) {
    const ticks = depth.length ? ` As they lock it they tick the depth answers they want (${depth.map(d => d.id).join(', ')}); a state named by one they leave unticked comes out.` : ''
    const waits = (r.review || !additions.length ? '' : `Nothing the user approved asks for ${additions.join(', ')}, so this waits for their answer instead of locking.\n`)
      + (looser.length ? `Looser than the plan, so these wait for the user's answer: ${looser.join(', ')}. If they lock it without answering, the plan's weight stands.\n` : '')
    const text = `${waits}Draft saved: ${rail}, starting at ${run.active}.${before}\nThe user checks it in the Sentinel pane and locks it with /sentinel lock, or tells you what to change (then call revise with what changes).${ticks} Stop here and wait for them.`
    return { run: { ...r, review: true, draft: run, held: { ...i, named: undefined, messages: undefined, depth: depth.length ? depth : undefined, points: points.length ? points : undefined }, quiet: true }, ok: true, event: 'drafted', text }
  }
  return { run, ok: true, event: 'locked', text: `Locked "${plan.title}": ${rail}.${before}\n${here(run, true)}` }
}

// ---- the system map a plan draws ----

const NO_MAP = 'A state names parts, but the plan has no map. Draw it in "system": parts, lines and people, as an object.'

// The drawing a define carries, checked against its states. A string says why it can't stand. A plan that sends none
// and names no part has none.
function drawingOf(i: PlanInput, states: StateDef[]): Drawing | string | undefined {
  if (!i.drawn) return states.some(s => s.parts?.length) ? NO_MAP : undefined
  const { errors, warnings } = checkDrawing(i.drawn.map, states, new Set(i.drawn.exists))
  return errors.length ? errors.join('\n') : { map: i.drawn.map, warnings, exists: i.drawn.exists }
}

// States added to a plan that runs may name only parts that are on its map.
function namesProblem(d: Drawing | undefined, states: StateDef[]): string | undefined {
  if (!states.some(s => s.parts?.length)) return undefined
  return d ? checkDrawing(d.map, states, new Set(d.exists)).errors.join('\n') || undefined : NO_MAP
}

// What the drawing checks found goes in the run's log (a few lines) and in the reply, since a sign-off in plan mode locks
// without the user seeing a draft.
const MAP_LOG = 3
const mapLog = (t: string, d: Drawing): LogLine[] => [
  ...d.warnings.slice(0, MAP_LOG).map((text): LogLine => ({ t, icon: '!', tone: 'warn', text: `Map · ${text}` })),
  ...(d.warnings.length > MAP_LOG ? [{ t, icon: '!', tone: 'warn', text: `Map · ${d.warnings.length - MAP_LOG} more` } satisfies LogLine] : []),
]
const mapNote = (d?: Drawing) =>
  d?.warnings.length ? `\nThe map has ${d.warnings.length === 1 ? 'a note' : `${d.warnings.length} notes`} for the user. None of them stops the lock:\n${d.warnings.map(w => `- ${w}`).join('\n')}` : ''

// The map changes while the plan runs: parts, lines and people join it, and parts that only Claude drew come off, with a
// reason. A part on the map the user locked stays unless they take it off, and so does a part a state builds.
function mapChange(r: Run, i: PlanInput, t: string): Acted {
  const d = r.drawing
  if (!i.drawn) return refuse(r, 'There is no map to change. Send "system" with the parts, lines or people to draw.')
  const drop = [...new Set((i.drop ?? []).map(x => String(x).trim()).filter(Boolean))]
  const reason = clip(i.reason)
  let map = i.drawn.map
  if (drop.length) {
    if (!reason) return refuse(r, 'Taking a part off the map needs "reason": why it goes.')
    const signed = drop.filter(id => d?.locked?.parts.some(p => p.id === id) && !(i.approved ?? []).includes(id))
    if (signed.length) return refuse(r, `${signed.join(', ')} ${signed.length === 1 ? 'is' : 'are'} on the map the user locked, so only they can take ${signed.length === 1 ? 'it' : 'them'} off. Tell them what is wrong and leave ${signed.length === 1 ? 'it' : 'them'} there.`)
    const built = r.plan!.states.filter(s => s.parts?.some(p => drop.includes(p)))
    if (built.length) return refuse(r, `${built.map(s => s.id).join(', ')} ${built.length === 1 ? 'builds' : 'build'} a part you are taking off. A part a state builds stays on the map.`)
    const dropped = dropParts(map, drop)
    if (!dropped.ok) return refuse(r, dropped.error)
    map = dropped.map
  }
  const { errors, warnings } = checkDrawing(map, r.plan!.states, new Set(i.drawn.exists))
  if (errors.length) return refuse(r, errors.join('\n'))
  if (d && JSON.stringify(d.map) === JSON.stringify(map)) return { run: r, ok: true, text: 'The map already holds that. Nothing changed.' }
  const had = new Map((d?.map.parts ?? []).map(p => [p.id, JSON.stringify(p)]))
  const drew = map.parts.filter(p => had.get(p.id) !== JSON.stringify(p)).map(p => p.id)
  const what = [drew.length ? `drew ${drew.join(', ')}` : drop.length ? '' : 'changed lines or people', drop.length ? `took off ${drop.join(', ')} (${reason})` : ''].filter(Boolean).join('; ')
  const run: Run = {
    ...r, drawing: { map, ...(d?.locked ? { locked: d.locked } : {}), warnings, exists: i.drawn.exists },
    audit: [...r.audit, { step: r.step + 1, t, state: r.active ?? undefined, kind: 'amended', text: `Map: ${what}` }],
    log: [...r.log, { t, icon: '+', tone: 'acc', text: `Map · ${what}` }],
  }
  return { run, ok: true, text: `Map updated: ${what}.${mapNote(run.drawing)}` }
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

// A draft's points as the model sent them, checked. A string says what is wrong. The quotes are compared in proofOf.
function pointsOf(raw: PlanInput['points'], states: StateDef[]): Point[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return 'points is a list: { said, states } for a point the plan delivers, { said, left } for one you left out.'
  const out: Point[] = []
  for (const [k, x] of raw.entries()) {
    const p = (x ?? {}) as Record<string, unknown>
    const n = `Point ${k + 1}`
    const said = typeof p.said === 'string' ? p.said.trim() : ''
    if (!said) return `${n} needs "said": the user's words that ask for it.`
    const ids = Array.isArray(p.states) ? [...new Set(p.states.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(Boolean))] : []
    const left = clip(p.left, 300)
    if (!ids.length === !left) return `${n} ("${shown(said)}") needs "states", the steps that deliver it, or "left", why you left it out. Send one of them.`
    const gone = ids.find(id => !states.some(s => s.id === id))
    if (gone !== undefined) return `${n} names "${gone}", which is not one of the states. Send "points" again as it should be.`
    out.push(left ? { said, left } : { said, states: ids })
  }
  return out
}

// The points without the steps `gone`. One left with no steps shows as left out.
const dropPoints = (points: Point[], gone: string[]): Point[] => points.map(p => {
  if (!('states' in p) || !p.states.some(id => gone.includes(id))) return p
  const states = p.states.filter(id => !gone.includes(id))
  return states.length ? { said: p.said, states } : { said: p.said, left: 'Its steps were taken out.' }
})

// The checks of the states before `start`; define needs their results.
export function priorChecks(i: PlanInput): string[] {
  const states = i.states ?? []
  const at = states.findIndex(s => s.id?.trim() === i.start?.trim())
  return [...new Set(states.slice(0, Math.max(0, at)).flatMap(s => (s.once === true ? [] : s.check?.trim() || [])))]
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
  return { ...held, states: kept, ...(held.points ? { points: dropPoints(held.points, gone) } : {}), ...(held.loops ? { loops: held.loops.filter(l => !l.some(id => gone.includes(id))) } : {}), ...(start ? { start: idOf(start) } : {}) }
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
const isWeight = (w: unknown): w is Weight => w === 'light' || w === 'standard' || w === 'thorough'

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
  const weights = f.weights ?? []
  if (!Array.isArray(weights) || !weights.every(isWeight)) return `weights in ${name} are light, standard or thorough.`
  return { name, ...(description ? { description } : {}), at, ...(files.length ? { files } : {}), text, ...(weights.length ? { weights: weights as Weight[] } : {}) }
}

// The Library's experimental switch. Only the user turns it on. With it off, a plan has one weight for all its states, as
// it always has, and Claude never hears of anything else.
export const STATE_SETTINGS = 'state-settings'
// The built-ins a state's own weight can move. Every other instruction is the plan's.
const WEIGHT_MOVES = ['fast-checks', 'failure-list', 'fails-first', 'break-it-once', 'fails-without-change']
const WEIGHT_RANK: Record<Weight, number> = { light: 0, standard: 1, thorough: 2 }

// own: the user's own instruction, with its own list of weights if any. A file in a built-in's place isn't.
type LibItem = { name: string; weights?: readonly Weight[]; trusted?: boolean; own?: boolean }
const sw = (s: Switches, name: string) => (s.on && Object.hasOwn(s.on, name) ? s.on[name] : undefined)
// An item's switch flipped by hand, if it has one, from the closest place that has one: this project, the preset in
// use, every project. A place that picks a weight takes the built-ins over, so a farther switch no longer counts for
// them. The user's own items keep it, and so does state-settings, which is in no weight.
function handOn(it: LibItem, ...places: Switches[]): boolean | undefined {
  for (const s of places) {
    const v = sw(s, it.name)
    if (v !== undefined) return v
    if (s.weight && it.weights && !it.own && it.name !== STATE_SETTINGS) return undefined
  }
  return undefined
}

// Which items are on. A built-in lists the weights that turn it on; the user's own items list none and are on unless
// switched off. The closest place wins: a switch there, or its weight for the built-ins (Standard when no place picked
// one). An item that isn't trusted is off. preset: the switches of the preset in use, between the other two.
export function libraryOn(items: readonly LibItem[], project: Switches = {}, personal: Switches = {}, preset: Switches = {}): { weight: Weight; on: string[] } {
  const weight = project.weight ?? preset.weight ?? personal.weight ?? DEFAULT_WEIGHT
  const on = items.filter(it => it.trusted !== false && (handOn(it, project, preset, personal) ?? it.weights?.includes(weight) ?? true))
  return { weight, on: on.map(it => it.name) }
}

// The switches flipped by hand that decide an item.
export function handOf(items: readonly LibItem[], project: Switches = {}, personal: Switches = {}, preset: Switches = {}): Record<string, boolean> {
  return Object.fromEntries(items.flatMap(it => {
    const v = handOn(it, project, preset, personal)
    return v === undefined ? [] : [[it.name, v]]
  }))
}

// A switches file with a weight picked: the built-ins' switches go, so the weight sets them; the user's items keep theirs.
// state-settings keeps its switch, since no weight decides it.
export function withWeight(s: Switches, weight: Weight, builtins: readonly string[]): Switches {
  const on = Object.fromEntries(Object.entries(s.on ?? {}).filter(([name]) => !builtins.includes(name) || name === STATE_SETTINGS))
  return { weight, ...(Object.keys(on).length ? { on } : {}) }
}

// What a plan keeps for its states. `on` is the plan's list, which the draft card may have changed: a switch counts as
// the list has it, and an item the list has against its weight counts as flipped by hand.
export function planStates(items: readonly (LibItem & InstructionDef & { kind: string })[], weight: Weight, on: readonly string[], hand: Record<string, boolean>): NonNullable<PlanLibrary['states']> {
  const perState = (x: InstructionDef) => x.at === 'start' || x.at === 'close'
  const moved = items.filter(x => x.weights && (WEIGHT_MOVES.includes(x.name) || (x.own && perState(x))))
  const flipped = [...moved.filter(x => x.weights!.includes(weight) !== on.includes(x.name)), ...items.filter(x => !x.weights && x.trusted !== false && !on.includes(x.name))].map(x => [x.name, on.includes(x.name)])
  // A file's switch the list overrides gives way to the weight, as picking a weight in the Library clears it. flipped has it back if the list is against the weight.
  const stands = Object.keys(hand).filter(n => on.includes(n) === hand[n] || !moved.some(x => x.name === n))
  const allHand = { ...Object.fromEntries(stands.map(n => [n, on.includes(n)])), ...Object.fromEntries(flipped) } as Record<string, boolean>
  const spare = items.filter(x => x.kind === 'told' && perState(x) && x.trusted !== false && !on.includes(x.name) && allHand[x.name] !== false)
  return { hand: allHand, weights: Object.fromEntries(moved.map(x => [x.name, [...x.weights!]])), spare: spare.map(toldEntry) }
}
// An instruction as a plan keeps it.
export const toldEntry = ({ name, description, at, files, text }: InstructionDef): InstructionDef => ({ name, ...(description ? { description } : {}), at, ...(files ? { files } : {}), text })

// The weight a state runs at. A looser one than the plan's holds only once the user asked for it or kept it. It is worked
// out here and not stored, as the plan's weight can change on the draft.
export function weightFor(r: Run, st: StateDef): Weight {
  const plan = r.library?.weight ?? DEFAULT_WEIGHT
  if (!st.weight || !r.library?.states) return plan
  return st.weightOk || WEIGHT_RANK[st.weight] >= WEIGHT_RANK[plan] ? st.weight : plan
}

// Is this instruction on for this state? With the switch off, or in a run saved before it, the plan's list answers.
export function onFor(r: Run, st: StateDef, name: string): boolean {
  const l = r.library
  const s = l?.states
  if (!s) return !!l?.on.includes(name)
  if (Object.hasOwn(s.hand, name)) return s.hand[name]!
  if (st.adds?.some(a => a.name === name)) return true
  return Object.hasOwn(s.weights, name) ? s.weights[name]!.includes(weightFor(r, st)) : l!.on.includes(name)
}

// What still waits for the user: the looser settings Claude decided on. A lock with these unanswered leaves them out.
export function looserLeft(l: PlanLibrary | undefined, states: readonly StateDef[]): string[] {
  const r = { ...emptyRun(), ...(l ? { library: l } : {}) }
  return [
    ...(l?.settings ?? []).filter(s => s.held).map(s => (s.weight ? `plan weight ${s.weight}` : `${s.name} off`)),
    ...states.filter(s => s.weight && weightFor(r, s) !== s.weight).map(s => `${s.id} (${s.weight})`),
  ]
}

const MAX_WHY = 200
// The checks Sentinel runs per state, which can be added to one. Told instructions show by when they fire.
const PER_STATE_CHECKS = ['fails-first', 'fails-without-change']
export const SETTINGS_OFF = "The Library's per-state settings are off, so Sentinel dropped weight, adds and settings from this plan. Only the user turns them on."

// Why these words don't count as the user's, or nothing when they do. Compared with what they typed, not the plan.
function notTyped(typed: readonly string[], quote: string, name: string, short: boolean): string | undefined {
  const verdicts = typed.map(m => checkSetting(m, quote, name, short))
  if (verdicts.includes('ok')) return undefined
  if (verdicts.includes('unnamed')) return `"${shown(quote)}" doesn't name ${name}, so it doesn't show the user asked for it. Quote words that name it, or send your own reason instead: it then waits for them.`
  if (verdicts.includes('short')) return `"${shown(quote)}" is too short to count: quote at least ${MIN_WORDS} words${short ? `, or ${name} and one more word` : ''}, or a whole message.`
  return `"${shown(quote)}" isn't in what the user typed, word for word. Copy their words, or send your own reason instead: a stricter setting then applies and a looser one waits for them.`
}

// With the switch off, what Claude sent for it goes. had: there was something to drop.
export function withoutSettings(i: PlanInput): { input: PlanInput; had: boolean } {
  const fields = ['weight', 'weightWhy', 'weightQuote', 'adds'] as const
  const { settings, ...rest } = i
  const had = settings !== undefined || !!i.states?.some(s => fields.some(k => s[k] !== undefined))
  return { had, input: had ? { ...rest, states: i.states?.map(({ weight: _w, weightWhy: _y, weightQuote: _q, adds: _a, ...s }) => s) } : i }
}

type SentState = NonNullable<PlanInput['states']>[number]

// What a state can add: an instruction that fires per state, on this state's files. Off because of the weight is fine, off by hand isn't.
function addsProblem(s: SentState, id: string, lib: PlanLibrary): string | undefined {
  const can = [...lib.told, ...(lib.states?.spare ?? [])].filter(x => x.at === 'start' || x.at === 'close')
  const files = (s.files ?? []).map(f => f.trim()).filter(Boolean)
  if (!Array.isArray(s.adds)) return `adds on ${id} is a list of { name, why }.`
  for (const a of s.adds) {
    const name = typeof a?.name === 'string' ? a.name.trim() : ''
    if (!name) return `Each addition on ${id} needs a name and a one-line why.`
    if (!clip(a.why, MAX_WHY)) return `${name} on ${id} needs a one-line why.`
    if (lib.states?.hand[name] === false) return `The user switched ${name} off, so ${id} can't add it.`
    const told = can.find(x => x.name === name)
    if (!told && !PER_STATE_CHECKS.includes(name)) return `${name} can't be added to ${id}: a state takes only an instruction that fires per state. These can: ${[...can.map(x => x.name), ...PER_STATE_CHECKS].join(', ')}.`
    if (!files.length) return `${id} edits no files, so no instruction fires there, and it can't add ${name}.`
    if (told?.files?.length && !files.some(f => told.files!.some(g => globsMeet(f, g)))) return `${name} covers ${told.files.join(', ')} and ${id} edits none of that, so it would never fire there.`
  }
  return undefined
}

// The states' weights and additions as sent, with the switch on. A string says what is wrong. weightOk comes from here
// alone, once the user's words hold up: Sentinel drops what the model sends for it.
export function settledStates(i: PlanInput, lib: PlanLibrary, typed: readonly string[]): PlanInput | string {
  const states: SentState[] = []
  for (const s of i.states ?? []) {
    const id = (s.id ?? '').trim()
    const { weight, weightWhy, weightQuote, adds, ...rest } = s
    let out: SentState = rest
    if (weight !== undefined) {
      if (!isWeight(weight)) return `weight on ${id} is light, standard or thorough.`
      const why = clip(weightWhy, MAX_WHY)
      const quote = clip(weightQuote, MAX_WHY)
      if (!why && !quote) return `weight on ${id} needs weightWhy, one line on why, or weightQuote, the user's words.`
      const wrong = quote ? notTyped(typed, quote, weight, WEIGHT_RANK[weight] > WEIGHT_RANK[lib.weight]) : undefined
      if (wrong) return `weight on ${id}: ${wrong}`
      out = { ...out, weight, ...(why ? { weightWhy: why } : {}), ...(quote ? { weightQuote: quote, weightOk: true as const } : {}) }
    }
    if (adds !== undefined) {
      const wrong = addsProblem(s, id, lib)
      if (wrong) return wrong
      // A name sent twice keeps the last reason.
      const byName = new Map(adds.map(a => [a.name.trim(), { name: a.name.trim(), why: clip(a.why, MAX_WHY)! }]))
      out = { ...out, adds: [...byName.values()] }
    }
    states.push(out)
  }
  return { ...i, ...(i.states ? { states } : {}) }
}

const settingKey = (s: PlanSetting) => (s.weight ? '#weight' : s.name!)

// The plan's own settings as sent, on top of what it has. Each carries the user's words or Claude's reason. What is looser
// and only has a reason is held: on the list, out of effect. Reaches this plan only, so the switch files stay as they are.
export function planSettings(lib: PlanLibrary, sent: unknown, items: readonly { name: string; weights?: readonly Weight[]; trusted?: boolean }[], typed: readonly string[]): { weight: Weight; on: string[]; settings: PlanSetting[] } | string {
  if (!Array.isArray(sent)) return '"settings" is a list of { weight } or { name, on }, each with "why" or "quote".'
  const hand = lib.states?.hand ?? {}
  const list = new Map((lib.settings ?? []).map(s => [settingKey(s), s]))
  const had = new Map(list)
  for (const x of sent as PlanSetting[]) {
    const name = typeof x?.name === 'string' ? x.name.trim() : undefined
    const weight = x?.weight
    if (!name && weight === undefined) return 'Each of "settings" names a weight, or an instruction with name and on.'
    if (!name && !isWeight(weight)) return 'A weight in "settings" is light, standard or thorough.'
    if (name === STATE_SETTINGS) return 'Only the user turns state-settings on or off.'
    if (name && !items.some(it => it.name === name && it.trusted !== false)) return `There is no instruction "${name}" to set.`
    if (name && typeof x.on !== 'boolean') return `${name} in "settings" needs "on", true or false.`
    const why = clip(x.why, MAX_WHY)
    const quote = clip(x.quote, MAX_WHY)
    if (!why && !quote) return `${name ?? weight} in "settings" needs "why", one line on why, or "quote", the user's words.`
    const looser = name ? !x.on : WEIGHT_RANK[weight!] < WEIGHT_RANK[lib.weight]
    const wrong = quote ? notTyped(typed, quote, name ?? weight!, !looser) : undefined
    if (wrong) return `${name ?? weight} in "settings": ${wrong}`
    if (name && x.on && hand[name] === false && !quote) return `The user switched ${name} off, so it takes their own words to turn it on for this plan.`
    const held = looser && !quote
    const entry: PlanSetting = { ...(name ? { name, on: x.on! } : { weight: weight! }), ...(why ? { why } : {}), ...(quote ? { quote } : {}), ...(held ? { held: true as const } : {}) }
    list.set(settingKey(entry), entry)
  }
  const settings = [...list.values()]
  return applied(lib, settings.filter(s => JSON.stringify(s) !== JSON.stringify(had.get(settingKey(s)))), settings, items)
}

// The plan's weight and list once these settings take effect, apart from the ones held for the user. settings: the list it keeps.
// Only what just arrived or was just answered takes effect, so a pick on the draft stays. So does anything the list has
// against the plan's weight, which the user flipped.
function applied(lib: PlanLibrary, now: PlanSetting[], settings: PlanSetting[], items: readonly { name: string; weights?: readonly Weight[]; trusted?: boolean }[]): { weight: Weight; on: string[]; settings: PlanSetting[] } {
  const hand = lib.states?.hand ?? {}
  const live = now.filter(s => !s.held)
  let { weight } = lib
  const on = new Set(lib.on)
  for (const s of live.filter(x => x.weight)) {
    weight = s.weight!
    for (const it of items) {
      if (it.weights && it.trusted !== false && !Object.hasOwn(hand, it.name) && it.weights.includes(lib.weight) === on.has(it.name)) void (it.weights.includes(weight) ? on.add(it.name) : on.delete(it.name))
    }
  }
  for (const s of live.filter(x => x.name)) void (s.on ? on.add(s.name!) : on.delete(s.name!))
  return { weight, on: [...on], settings }
}

// The user's answer on a plan setting: Keep puts it in effect, and otherwise it goes.
export function answerSetting(lib: PlanLibrary, key: string, keep: boolean, items: readonly { name: string; weights?: readonly Weight[]; trusted?: boolean }[]) {
  const settings = (lib.settings ?? []).flatMap(s => {
    if (settingKey(s) !== key) return [s]
    const { held: _held, ...rest } = s
    return keep ? [rest] : []
  })
  return applied(lib, keep ? settings.filter(s => settingKey(s) === key) : [], settings, items)
}
// The user's pick on the draft's cards beats a setting it overrules: that one goes, and its row with it. What still waits for them stays.
export const cardSettings = (settings: PlanSetting[] | undefined, weight: Weight, on: readonly string[]) => settings?.filter(s => s.held || (s.weight ? s.weight === weight : !!s.on === on.includes(s.name!)))

// What differs from the plan, for the draft card and the band: the plan's own settings, then the states grouped by what they say.
export function settingRows(r: Run): SettingRow[] {
  const l = r.library
  if (!l?.states) return []
  const rows = new Map<string, SettingRow>()
  const put = (id: string, row: Omit<SettingRow, 'id' | 'states'>, state?: string) => {
    const had = rows.get(id)
    if (had && state) had.states.push(state)
    else if (!had) rows.set(id, { id, ...row, states: state ? [state] : [] })
  }
  const fields = (why?: string, quote?: string) => ({ ...(why ? { why } : {}), ...(quote ? { quote } : {}) })
  for (const s of l.settings ?? []) {
    const key = settingKey(s)
    put(`plan|${key}`, { kind: 'plan', key, ...(s.weight ? { weight: s.weight } : { name: s.name!, on: !!s.on }), ...fields(s.why, s.quote), owed: !!s.held })
  }
  for (const st of r.plan?.states ?? []) {
    if (st.weight && st.weight !== l.weight) {
      const owed = weightFor(r, st) !== st.weight
      const looser = WEIGHT_RANK[st.weight] < WEIGHT_RANK[l.weight]
      const kept = !owed && looser && !st.weightQuote
      put(`weight|${st.weight}|${st.weightWhy ?? ''}|${st.weightQuote ?? ''}|${owed}|${kept}`, { kind: 'weight', weight: st.weight, ...fields(st.weightWhy, st.weightQuote), owed, ...(kept ? { kept: true as const } : {}), ...(looser ? { looser: true as const } : {}) }, st.id)
    }
    for (const a of st.adds ?? []) put(`add|${a.name}|${a.why}`, { kind: 'add', name: a.name, why: a.why, owed: false }, st.id)
  }
  return [...rows.values()]
}

// Keep on a looser state weight, for the whole row. A define stands by it while the setting stays the same.
export const keepWeights = (r: Run, ids: readonly string[]): Run => (r.draft
  ? { ...r, draft: { ...r.draft, plan: { ...r.draft.plan!, states: r.draft.plan!.states.map(s => (ids.includes(s.id) && s.weight ? { ...s, weightOk: true as const } : s)) } } }
  : r)
// Use the plan's weight: the states lose their own.
export const dropWeights = (held: PlanInput, ids: readonly string[]): PlanInput => ({
  ...held, states: held.states?.map(s => {
    if (!ids.includes(idOf(s))) return s
    const { weight: _w, weightWhy: _y, weightQuote: _q, weightOk: _k, ...rest } = s
    return rest
  }),
})
// Remove: the states lose this addition.
export const dropAdd = (held: PlanInput, ids: readonly string[], name: string): PlanInput => ({
  ...held, states: held.states?.map(s => (ids.includes(idOf(s)) && s.adds ? { ...s, adds: s.adds.filter(a => a.name !== name) } : s)),
})

// The plan's told instructions for one moment. Start and close are for states that edit files: the instructions
// without files, and those whose files meet the state's.
export function toldFor(r: Run, at: InstructionAt, st?: StateDef): InstructionDef[] {
  const told = (r.library?.told ?? []).filter(x => x.at === at)
  if (at !== 'start' && at !== 'close') return told
  if (!st?.files.length) return []
  const here = r.library?.states ? [...told, ...r.library.states.spare.filter(x => x.at === at)].filter(x => onFor(r, st, x.name)) : told
  return here.filter(x => !x.files?.length || st.files.some(f => x.files!.some(g => globsMeet(f.trim(), g))))
}

const RULES_WIN = "Where the project's own rules (such as CLAUDE.md) differ from these, the project's rules win."
const MAY_SKIP = 'If one of these doesn\'t fit this state, skip it and record why with "decide", naming it in "skip". If two of them disagree, pick one and record why the same way.'
const MEMBER_SKIPS = "If one of these doesn't fit this state, skip it and say why when you report back, naming it. If two of them disagree, pick one and say why the same way."
// ponytail: rerunOf runs only in the main conversation, so a member's state gets this note in place of the rerun.
export const memberGap = (r: Run, st: StateDef) =>
  (r.library && onFor(r, st, 'fails-without-change') ? "Sentinel won't run your check without your code changes, as fails-without-change does for the main conversation. Make sure your check fails without them, and say so when you report back." : '')
const block = (head: string, xs: InstructionDef[]) => (xs.length ? [head, ...xs.map(x => `- ${x.text}`)].join('\n') : '')

// What the plan's instructions say for `st` as it starts and before it closes, and with `final`, what they say before
// the plan completes. A member hears it for its state too.
export function toldHere(r: Run, st: StateDef, final = false, member = false): string {
  const parts = [
    block(`Your instructions for ${st.id}:`, toldFor(r, 'start', st)),
    block(`Before you advance ${st.id}:`, toldFor(r, 'close', st)),
    final ? block('Before the plan completes:', toldFor(r, 'final')) : '',
  ].filter(Boolean)
  return parts.length ? [...parts, ...(r.library?.states ? [member ? MEMBER_SKIPS : MAY_SKIP] : []), RULES_WIN].join('\n') : ''
}

// The system prompt's Library section: the always instructions, and the draft ones while no plan is locked. The
// dashboard previews this text. Empty when neither has any.
// While a plan is written with parallel states on. It sits with the Library's draft instructions, though the switch, not the Library, decides it.
export const PARALLEL_DRAFT: InstructionDef = {
  name: 'parallel-states', at: 'draft',
  text: 'Parallel states are on in this project. Give each state "needs" for only what it really builds on: a state with no "needs" waits on the one listed before it, so a plan without them runs in a line. States where neither needs the other run at the same time, so their files must not overlap. If the plan has to run in a line, tell the user why.',
}
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
  return { ...d, plan: { ...d.plan!, lockedAt: t, states }, startedAt: now, tasks, log: [...d.log, { t, icon: '●', tone: 'acc', text: 'Locked by the user' }], ...(d.drawing ? { drawing: { ...d.drawing, locked: d.drawing.map } } : {}), ...(r.refused ? { refused: r.refused } : {}), ...keepCount(r), ...(r.flowDraft ? { flowDraft: r.flowDraft } : {}) }
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

// The state a forward advance leaves, with a check or without one. Not a return along a loop.
export function forwardState(r: Run, to?: string): string | undefined {
  const st = isLive(r) ? stateOf(r) : undefined
  return st && (to ?? '').trim() === nextOf(r, st) ? st.id : undefined
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
  if (r.library && !onFor(r, st, 'fails-first')) return undefined
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
  if (!st?.check || !st.files.length || !r.library || !onFor(r, st, 'fails-without-change') || snapOf(r)) return false
  return !visitOf(r).some(c => c.kind === 'edit' && !c.denied)
}

// What the rerun at a forward advance needs: the visit's snapshot, and the files edited in the visit as tests and code.
// None without a snapshot, or once Claude's own decide in this visit has this check as its topic and says why it can't
// fail without the change. A decide about anything else leaves the rerun on, even one whose choice or reason mentions the
// check. An approval the user gave in the dialog or on the page is also a decided entry, and it excuses nothing. A string
// says why it is skipped.
export function rerunOf(r: Run): { sha: string; tests: string[]; code: string[] } | string | undefined {
  const st = stateOf(r)
  const snap = snapOf(r)
  if (!st || !snap?.sha || r.audit.some(a => a.kind === 'decided' && a.by === 'claude' && a.state === st.id && a.step > r.enteredAt && /fails[- ]without[- ]change/i.test(a.text.split(' → ')[0]!))) return undefined
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
  let keptNote: string | undefined
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
    }
    const broke = fixedOf(r).filter(s => s.check && proofs[s.check]?.pass === false)
    if (broke.length) {
      const why = [...new Set(broke.map(s => s.check!))].map((c, k) => withTail(`\`${c}\` (${broke.filter(s => s.check === c).map(s => s.id).join(', ')}): ${proofs[c]!.sigText}`, proofs[c], k))
      return refuse(r, `You changed files of done states, and their checks fail now:\n${why.join('\n')}\nFix that before moving on.`)
    }
    if (without && 'pass' in without && without.pass) {
      return {
        run: { ...r, log: [...r.log, { t, icon: '!', tone: 'warn', text: `${st.id} · check passes without the change` }] }, ok: false,
        text: `\`${st.check}\` passes in a copy of the project that has ${st.id}'s test changes (${without.tests.join(', ')}) but not its code changes (${without.code.join(', ')}), so it doesn't show the change works. `
          + `Tighten the test so it fails without the change, then advance again. If it can't, such as a refactor that has to keep passing, record why with "decide" and the topic "fails-without-change", then advance again.`,
      }
    }
    // Finished work goes to the user once, and again if it changed after they saw it. Hands-free, it passes and is
    // listed for them to check later.
    const said = clip(outcome ?? evidence, 1500)
    if (waitOf(st) === 'after' && r.handsFree) r = { ...r, audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'decided', text: `Passed its review hands-free${said ? `: ${said}` : ''}` }] }
    else if (waitOf(st) === 'after') {
      const p = pendingOf(r)
      const seen = p?.kind === 'after' && !visit.some(c => c.kind === 'edit' && c.ver !== undefined && c.step > p.step)
      // Not asked in this visit, but the user reviewed it in an earlier one and none of its files changed since.
      const kept = p ? undefined : keptReview(r, st)
      if (kept) {
        const some = kept.elsewhere.slice(0, 6).join(', ') + (kept.elsewhere.length > 6 ? ` and ${kept.elsewhere.length - 6} more` : '')
        keptNote = `Your earlier review of ${st.id} stands: none of its files has changed since the user looked.${some ? ` Files edited since, in other states: ${some}.` : ''}`
        r = { ...r, log: [...r.log, { t, icon: '✓', tone: 'ok', text: `${st.id} · earlier review kept` }] }
      } else if (!seen || !answered(r, 'after')) {
        if (seen) return { ...refuse(r, `The user hasn't answered your review of ${st.id} yet. Stop your turn and wait for them.`), stop: 'after' }
        const text = clip(outcome ?? evidence, 1500)
        const run: Run = {
          ...r, pending: { state: st.id, at: now, step: r.step + 1, kind: 'after', ...(text ? { text } : {}) },
          audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'asked', text: `Ready for review${text ? `: ${text}` : ''}` }],
          log: [...r.log, { t, icon: '?', tone: 'ask', text: `${st.id} · ready for your review` }],
        }
        return { run, ok: false, stop: 'after', text: `${st.id} is done, and the user reviews it before it moves on. They see your outcome above the prompt and on the dashboard. Say in your reply what was done and what they should check, then stop your turn and wait. Call advance again once they answer.` }
      } else r = { ...r, reviewed: { ...r.reviewed, [st.id]: r.step } }
    }
    if (without && 'skipped' in without) r = { ...r, log: [...r.log, { t, icon: '–', tone: 'dim', text: `${st.id} · rerun without the change skipped: ${without.skipped}` }] }
    if (without && 'pass' in without) r = { ...r, log: [...r.log, { t, icon: '✓', tone: 'ok', text: `${st.id} · check fails without the change` }] }
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
  const skippedN = Object.keys(r.skipped ?? {}).length
  const line: LogLine = isLoop
    ? { t, icon: '↺', tone: 'warn', text: `${st.id} → ${to} · loop ${loops[key]}` }
    : to === 'done' ? { t, icon: '■', tone: 'ok', text: `Plan complete · ${n - skippedN}/${n}${skippedN ? ` · ${skippedN} skipped` : ''}` } : { t, icon: '▶', tone: 'ok', text: `${st.id} → ${to}` }
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
  // Entering a task opens a visit.
  if (to !== 'done') tasks = openVisit(tasks, to, { from: now })
  const run: Run = {
    ...r, active: to, done, ...(running ? { running } : {}), enteredAt: r.step, loops, lastLoop: isLoop ? key : undefined,
    traps: r.traps.map(x => (x.end === undefined ? { ...x, end: r.step } : x)),
    log: [...r.log, line], auto: 0, askToken: 0, breakingOk: false,
    tasks, ...(to === 'done' ? { endedAt: now } : {}),
    // Moving on: each look at this state answered on its way here, and how long the state then took.
    ...(r.looks && !back ? { looks: r.looks.map(l => (l.state === st.id && l.toAdvanceMin === undefined ? { ...l, toAdvanceMin: Math.max(0, Math.round((now - l.at) / 60_000)) } : l)) } : {}),
    // The reason for a way back was checked above; keep it for the task page of the state returned to.
    ...(back ? { trips: [...(r.trips ?? []), { from: st.id, to, at: now, t, reason: clip(evidence)! }] } : {}),
  }
  return { run, ok: true, event: to === 'done' ? 'complete' : undefined, text: `${keptNote ? `${keptNote}\n` : ''}${without && 'pass' in without ? 'Sentinel ran the check in a copy without your code changes, and it failed, as it should.\n' : ''}Moved to ${to}.\n${here(run)}` }
}

// The final sweep found done states whose checks fail now: st is done, and they open again in place of completing.
// What builds on them gets swept again at the next completion, so only they reopen.
function reopen(r: Run, st: StateDef, failed: StateDef[], proofs: Proofs, outcome: string | undefined, t: string, now: number): Acted {
  const ids = failed.map(s => s.id)
  const first = ids[0]!
  const tasks = openVisit(closeVisit(r.tasks, st.id, now, outcome), first, { from: now })
  const checks = [...new Set(failed.map(s => s.check!))]
  const why = checks.map(c => `\`${c}\` (${failed.filter(s => s.check === c).map(s => s.id).join(', ')}): ${proofs[c]!.sigText}`)
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
    text: `${st.id} is done, but the plan is not complete yet. Before finishing, Sentinel ran the checks of the done states again, and these fail now:\n${why.map((w, k) => withTail(w, proofs[checks[k]!], k)).join('\n')}\n`
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
  if (i.skip !== undefined) return skipFor(r, i, t)
  const topic = i.topic?.trim()
  const choice = i.choice?.trim()
  if (!topic || !choice) return refuse(r, 'decide needs a topic and a choice.')
  const text = `${topic} → ${choice}${i.reason?.trim() ? ` (${i.reason.trim()})` : ''}`
  // A choice made after an escalation settles it.
  const run: Run = {
    ...r, escalatedAt: undefined,
    audit: [...r.audit, { step: r.step + 1, t, state: r.active ?? undefined, kind: 'decided', text, by: 'claude' }],
    log: [...r.log, { t, icon: '◆', tone: 'acc', text: `Decided · ${text}` }],
  }
  return { run, ok: true, text: 'Recorded. Continue with the plan.' }
}

const skipsOf = (r: Run, id: string) => r.audit.flatMap(a => (a.skip && a.state === id ? [a.skip] : []))

// Claude skips an instruction for a state, by name, so the page can show which one and why. Only one the state was told
// can be skipped: the checks Sentinel runs itself aren't told.
function skipFor(r: Run, i: PlanInput, t: string): Acted {
  const name = String(i.skip).trim()
  const id = i.to?.trim() || r.active
  const st = r.plan?.states.find(s => s.id === id)
  if (!st) return refuse(r, `There is no state "${id ?? ''}" to skip ${name} for.`)
  const why = i.reason?.trim()
  if (!why) return refuse(r, `Skipping ${name} needs a one-line why in "reason".`)
  const can = [...new Set([...toldFor(r, 'start', st), ...toldFor(r, 'close', st)].map(x => x.name))]
  if (!can.includes(name)) return refuse(r, `${st.id} wasn't told ${name}, so there is nothing to skip. ${can.length ? `These can: ${can.join(', ')}.` : 'It was told no instruction.'}`)
  const text = `Skipped ${name} for ${st.id}: ${why}`
  return {
    run: {
      ...r, escalatedAt: undefined,
      audit: [...r.audit, { step: r.step + 1, t, state: st.id, kind: 'decided', text, by: 'claude', skip: { name, why: why.slice(0, MAX_WHY) } }],
      log: [...r.log, { t, icon: '◆', tone: 'acc', text: `Decided · ${text}` }],
    },
    ok: true, text: 'Recorded. Continue with the plan.',
  }
}

function escalate(r: Run, i: PlanInput, t: string, now: number): Acted {
  const reason = i.reason?.trim()
  if (!reason) return refuse(r, 'escalate needs a reason: which rule, and why.')
  if (i.kind === 'blocked') {
    return {
      ok: true,
      run: {
        ...r, quiet: true, escalatedAt: now, blocked: { what: reason, at: now },
        audit: [...r.audit, { step: r.step + 1, t, state: r.active ?? undefined, kind: 'escalated', text: `Blocked: ${reason}` }],
        log: [...r.log, { t, icon: '⚑', tone: 'acc', text: 'Blocked · needs you' }],
      },
      text: "Logged. The user sees what you need. End your turn: Sentinel won't push you on, and you go on when they reply. Questions stay held, so put everything they need in the reason.",
    }
  }
  if (i.kind !== 'breaking' && i.kind !== 'stuck') return refuse(r, 'kind must be "breaking", "stuck" or "blocked".')
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
  const rail = vm.states.map(s => `${s.skipped ? '–' : SYM[s.status]}${s.id}`).join(' ')
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
  // How long a check run took, when Sentinel timed it.
  ms?: number
}

export type VM = {
  phase: 'none' | 'draft' | 'live' | 'complete'
  // The plan's weight, with any Library; the settings Claude chose, only with the per-state settings on.
  planWeight?: Weight
  settingRows?: SettingRow[]
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
  // weightNow: what the state runs at, with the Library's per-state settings on. noRerun: a member running it misses Sentinel's rerun.
  states: (StateDef & { weightNow?: Weight; skips?: { name: string; why: string }[]; noRerun?: true; asks?: AskFact[]; status: Status; from?: number; to?: number; since?: number; ms?: number; visits?: number; spans?: Span[]; outcome?: string; edited?: string[]; needs: string[]; waits: string[]; skipped?: string })[]
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
  // Every overseer look, oldest first.
  looks: Look[]
  // The ways back that were taken, latest last, and the wall-clock span of the run.
  trips: Trip[]
  startedAt?: number
  endedAt?: number
  // The user closed the plan with /sentinel finish.
  closed?: Run['closed']
  // Tool calls since the running task was entered.
  visitCalls: number
  spend: Spend[]
  spendFrom?: string
  usage?: UsageView
  // One lane for each helper agent, kept apart from the main conversation's calls and health.
  lanes: Lane[]
  // What the active state asked the user and is waiting on now: its proposal (before) or its finished work (after).
  waiting?: { kind: Wait; text?: string; at: number }
  blocked?: { what: string; at: number }
  // The user answered what the active state asked, so it may go on.
  replied: boolean
  // The user is away: Claude makes the calls that would wait for them.
  handsFree: boolean
  // The final checks under way, before the plan completes.
  sweep?: NonNullable<Run['sweep']>
  // The checks Sentinel runs now.
  checking?: Run['checking']
  flowDraft?: Run['flowDraft']
  // The system map this plan draws: its size, what the drawing checks found, the outside parts that are guesses, and how
  // every part stands (see systemOf).
  system?: SystemView
  // A draft's depth answers, which the user ticks as they lock it.
  depth?: Depth[]
  // What the user asked for, as the draft lists it. Empty when Claude listed none.
  points?: Point[]
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

// ---- when a state has run long ----

// The first mark of a state's working time. Each mark after it is double the one before.
export const FIRST_MARK_MS = 30 * 60_000

export type TimeMark = { state: string; mark: number; ms: number }

// A short length of time, such as a check run's: under 1 s, 42 s, or 3 min.
export const span = (ms: number) => (ms < 1000 ? 'under 1 s' : ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

// 45 min, or 2 h 10 min. It rounds down, so it never reads as more than has passed.
function timeText(ms: number): string {
  const min = Math.floor(ms / 60_000)
  const rest = min % 60
  return min < 60 ? `${min} min` : `${(min - rest) / 60} h${rest ? ` ${rest} min` : ''}`
}

// The time a state has been worked on, across its visits. The clock stops while the plan waits, so a closed stretch
// leaves the wait out.
export function workingMs(r: Run, id: string, now: number): number {
  return (taskIn(r.tasks, id)?.visits ?? []).reduce((sum, v) => sum + (v.to ?? now) - v.from, 0)
}

// The active state has passed a mark that hasn't been said yet. A jump past several gives only the highest.
export function timeDue(r: Run, now: number): TimeMark | undefined {
  if (!isLive(r) || waitingOn(r)) return undefined
  const state = r.active!
  const ms = workingMs(r, state, now)
  if (ms < FIRST_MARK_MS) return undefined
  let mark = FIRST_MARK_MS
  while (mark * 2 <= ms) mark *= 2
  return (r.timeSaid?.[state] ?? 0) >= mark ? undefined : { state, mark, ms }
}

export function timeMarked(r: Run, due: TimeMark, t: string): Run {
  return { ...r, timeSaid: { ...r.timeSaid, [due.state]: due.mark }, log: [...r.log, { t, icon: '!', tone: 'warn', text: `${due.state} · ${timeText(due.ms)} of working time` }] }
}

// Where a state's time went, from what the ledger recorded across its visits. A stretch counts only between two calls
// next to each other in the ledger, so the time another state worked between two visits is left out.
// ponytail: a call's t holds HH:MM with no date, so a stretch includes any wait for the user in it and one over 24 h reads
// short, and the ledger keeps the last 400 calls, so a longer state counts only those. Stamp calls in ms if that misleads.
export function timeFacts(r: Run, id: string): string {
  const own = r.calls.filter(c => c.state === id)
  const checks = own.filter(c => c.kind === 'check')
  const failed = checks.filter(c => !c.pass).length
  // Only runs Sentinel timed: a check sent to the background, or run another way, counts as a read and has no time.
  const timed = checks.filter(c => c.ms !== undefined)
  const took = timed.reduce((a, c) => a + c.ms!, 0)
  const edits = own.filter(c => c.kind === 'edit' && !c.denied)
  const files = new Set(edits.map(c => c.file)).size
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  let longest = 0
  let ended = ''
  r.calls.forEach((c, k) => {
    const before = r.calls[k - 1]
    if (c.state !== id || before?.state !== id) return
    // Across midnight the clock goes back to 00:00.
    const gap = (minutes(c.t) - minutes(before.t) + 1440) % 1440
    if (gap > longest) [longest, ended] = [gap, c.label]
  })
  const many = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`
  return [
    checks.length ? `${many(checks.length, 'check run')}${failed ? `, ${failed} failed` : ''}${timed.length ? `, ${span(took)} in all, about ${span(took / timed.length)} each` : ''}` : '',
    edits.length ? `${many(edits.length, 'edit')} to ${many(files, 'file')}` : '',
    longest ? `longest stretch between calls ${timeText(longest * 60_000)} by the clock, ended by ${ended.replace(/\s+/g, ' ').slice(0, 60)}` : '',
  ].filter(Boolean).join('; ')
}

// What Claude is told at a mark. It goes on working: the note only asks it to look.
export function timeNote(r: Run, due: TimeMark): string {
  const facts = timeFacts(r, due.state)
  return `[sentinel] ${due.state} has taken ${timeText(due.ms)} of working time.${facts ? ` The ledger shows ${facts}.` : ''} This does not stop the run. Look at where the time went: carry on if it is reasonable, speed it up if you can, and fix anything hung or failing. Record what you found with "decide" and the topic "time on ${due.state}", and go on.`
}

// What an overseer starts with: a fresh agent knows nothing of the run but this and what it reads. why: the time mark it
// looks at, or the stuck mark; a stuck look asks only whether it is stuck. others: other agents at work in the session.
export function overseerPrompt(r: Run, why: TimeMark | Trap, diff: string, others: string[]): string {
  const stuck = 'pattern' in why ? why : undefined
  const st = stateOf(r, why.state)
  const facts = timeFacts(r, why.state)
  const line = (c: Call) => `${c.t} ${c.kind}${c.kind === 'check' ? (c.pass ? ' passed' : ' failed') : ''}${c.denied ? ' refused' : ''}: ${c.label}`
  // A stuck look sees the window the detector judged, each call with what the detector made of it.
  const calls = stuck
    ? visitOf(r).slice(-K).map(c => `${line(c)} · ${c.u ? 'progress' : c.repeat ? 'repeat' : 'no progress'}`)
    : r.calls.filter(c => c.state === why.state).slice(-25).map(line)
  const fail = r.lastFail && r.lastFail.step > r.enteredAt ? r.lastFail.text.slice(-2000) : ''
  const part = (name: string, text?: string) => (text ? [`${name}:`, text, ''] : [])
  const gap = stuck && gapOf(r, st)
  const ask = stuck ? [
    `You are Sentinel's overseer. Another Claude conversation is working through a signed-off plan. Sentinel's stuck detector, which judges progress from tool calls alone, marked one state stuck, and it still looked stuck eight calls after the first note. Sentinel asked you to look in from outside and say whether it really is stuck. It keeps working while you look.`,
    '',
    'Read only. Edit nothing, start nothing that keeps running, stop nothing. You may read files and logs and run read-only commands such as git log.',
    '',
    'Decide which of these holds:',
    '- WRONG: it is stuck: failing for the same reason each time, going round the same ideas, or off what the state asked for.',
    '- FINE: it is moving: each attempt teaches it something new, and the detector misread that.',
    '',
    'The first word of your final answer is that word. After it, at most five lines: what you saw and, for WRONG, what the main conversation should try next, naming files and commands. It reads your answer with none of your context. FINE lifts the stuck mark.',
  ] : [
    "You are Sentinel's overseer. Another Claude conversation is working through a signed-off plan, and one state of it has run long. Sentinel asked you to look in from outside, so that conversation isn't judging its own time. It keeps working while you look.",
    '',
    'Read only. Edit nothing, start nothing that keeps running, stop nothing. You may read files and logs and run read-only commands such as git log.',
    '',
    'Decide which of these holds:',
    '- FINE: the time is reasonable for this work and it is moving.',
    '- FASTER: the work is on course, and a specific change would save real time, such as a narrower test run.',
    '- WRONG: something is hung, looping, failing for the same reason each time, or off what the state asked for.',
    '',
    'The first word of your final answer is that word. After it, at most five lines: what you saw, and what the main conversation should do, naming files and commands. The main conversation hears only FASTER and WRONG, and it reads your answer with none of your context.',
  ]
  return [
    ...ask,
    '',
    `Plan: ${r.plan!.title}${r.plan!.source ? ` (written in ${r.plan!.source})` : ''}`,
    `State: ${why.state}${st ? ` (${st.label})` : ''}${st?.ref ? `, details at ${st.ref}` : ''}`,
    ...(st?.problem ? [`What is needed: ${st.problem}`] : []),
    ...(st?.approach ? [`How: ${st.approach}`] : []),
    ...(st?.check ? [`Done when this exits 0: ${st.check}`] : []),
    ...(st?.files?.length ? [`Files it may edit: ${st.files.join(', ')}`] : []),
    ...(stuck
      ? [`Stuck pattern: ${stuck.pattern}, ${PATTERN_SAYS[stuck.pattern]}. Sentinel has sent ${stuck.notes} stuck notes.`, ...(gap ? [`The failure: ${gap}`] : []), ...(facts ? [`The ledger shows ${facts}.`] : [])]
      : [`Working time so far: ${timeText((why as TimeMark).ms)}.${facts ? ` The ledger shows ${facts}.` : ''}`]),
    '',
    ...part(stuck ? `Its last ${calls.length} of ${visitOf(r).length} calls in this state, oldest first, each with what the detector made of it` : 'Its recent calls, oldest first', calls.join('\n')),
    ...part('The last failure in this state', fail),
    ...part('Uncommitted changes (git diff --stat)', diff.trim().slice(0, 3000)),
    ...part('Other agents at work', others.join('\n')),
  ].join('\n').trim()
}

// What an overseer answered, by its first word. An answer with no such word still counts as something to hear, as it may
// report what the word was meant for; a look that was stopped or said nothing has nothing to hear.
export function overseerSays(answer: string): { word: OverseerWord; rest: string } {
  const text = answer.trim()
  if (!text) return { word: 'silent', rest: '' }
  const m = /^\W*(fine|faster|wrong)\b[\s*_:.,-]*/i.exec(text)
  return m ? { word: m[1]!.toLowerCase() as OverseerWord, rest: text.slice(m[0].length) } : { word: 'unclear', rest: text }
}

// The files a task changed. A run kept from before tasks recorded them has what its ledger still holds.
function editedOf(r: Run, id: string) {
  const files = taskIn(r.tasks, id)?.edited ?? [...new Set(r.calls.flatMap(c => (c.state === id && c.kind === 'edit' && !c.denied && c.file ? [c.file] : [])))]
  return files.length ? { edited: files } : {}
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

// ---- the system map as the screens draw it ----

// Why the final checks sent a state back, while that visit is the one under way.
function reopenedWhy(r: Run, id: string): string | undefined {
  const trip = r.trips?.findLast(t => t.to === id && t.reason.startsWith('Final check'))
  return trip && enteredAt(r, id) === trip.at ? trip.reason.replace(/^Final check:\s*/, '') : undefined
}

// The plan's states as the map's status function reads them. A draft has begun nothing. The main conversation's state is
// the one with status active or trap; a state in a member agent is running. A plan closed with finish leaves the states
// it names unfinished, though the run counts as complete.
function mapStates(r: Run, states: VM['states'], phase: VM['phase'], lastCheck: Call | undefined, blocked: VM['blocked']): MapRunState[] {
  const done = new Set(doneOf(r))
  const open = new Set(r.closed?.unfinished ?? [])
  return states.map(s => {
    const mine = s.status === 'active' || s.status === 'trap'
    const finished = (phase === 'complete' || done.has(s.id)) && !open.has(s.id)
    const failing = s.status === 'trap' || (mine && phase === 'live' && lastCheck !== undefined && !lastCheck.pass) || (r.running?.[s.id]?.fails ?? 0) > 0
    const reopened = mine && phase === 'live' ? reopenedWhy(r, s.id) : undefined
    const where: MapRunState['where'] = phase === 'draft' ? 'ahead' : finished ? 'done' : mine || s.status === 'running' ? 'active' : 'ahead'
    return {
      id: s.id, parts: s.parts ?? [], where, hasCheck: !!s.check,
      ...(s.skipped ? { skipped: true } : {}), ...(s.once ? { once: true } : {}), ...(failing ? { failing: true } : {}),
      ...(mine && blocked ? { blocked: blocked.what } : {}), ...(reopened !== undefined ? { reopened } : {}),
    }
  })
}

// An outside part's evidence in one place, for a screen to put in words.
function outsideOf(p: SysTreePart): NonNullable<MapNode['outside']> {
  const e: Evidence | undefined = p.evidence
  const why = e && 'seen' in e ? { kind: 'seen' as const, why: [...new Set(e.seen.map(c => c.file))].join(', ') }
    : e && 'said' in e ? { kind: 'said' as const, why: e.said } : { kind: 'guess' as const, why: e && 'guess' in e ? e.guess : '' }
  return { ...why, ...(p.where ? { where: p.where } : {}) }
}

// How many folders and endpoint keys the screens list before saying how many more there are.
const UNMAPPED_SHOWN = 12, LEADS_SHOWN = 8
// How the map stands, for the screens: every part's status, the groups rolled up, the totals, and where Claude is. look: the
// saved proofs and the files as last seen. An edit the ledger recorded after a proof counts at once, with no new look.
export function systemOf(r: Run, d: Drawing, states: VM['states'], phase: VM['phase'], lastCheck: Call | undefined, blocked: VM['blocked'], look: MapLook): SystemView {
  const map = d.map
  const run = mapStates(r, states, phase, lastCheck, blocked)
  const now: Record<string, Fingerprint> = { ...look.now }
  if (look.marks) for (const id of editedSince(map, r, look.marks)) now[id] = { hash: 'edited since the proof', files: 0 }
  const statuses = statusOf({
    map, states: run, existing: d.exists, marks: look.marks, now, ...(look.drift ? { drift: look.drift.parts } : {}),
    ...(r.closed ? { closed: { ran: run.filter(s => s.where === 'done' && !r.closed!.unchecked.includes(s.id)).map(s => s.id) } } : {}),
  })
  const node = (t: SysTreePart): MapNode => ({
    id: t.id, name: t.name, ...(t.desc ? { desc: t.desc } : {}), ...(t.files?.length ? { files: t.files } : {}),
    ...(t.kind === 'outside' ? { outside: outsideOf(t) } : {}),
    ...(t.kids.length ? { roll: rollOf(map, statuses, t.id) } : { status: statuses[t.id] }),
    builtBy: run.filter(s => s.parts.includes(t.id)).map(s => s.id),
    kids: t.kids.map(node),
  })
  const tree = treeOf(map).map(node)
  const leaves = (ns: MapNode[]): MapNode[] => ns.flatMap(n => (n.kids.length ? leaves(n.kids) : [n]))
  return {
    name: map.name, parts: map.parts.length, lines: map.lines.length, warnings: d.warnings,
    guessed: map.parts.filter(p => p.evidence && 'guess' in p.evidence).map(p => p.id),
    tree, tally: tally(map, statuses), actors: map.actors, links: map.lines,
    here: leaves(tree).filter(n => n.status?.status === 'now').map(n => ({ id: n.id, name: n.name })),
    changes: changesOf(d.locked, map),
    ...(look.drift ? { drift: { count: Object.keys(look.drift.parts).length, why: look.drift.why, loose: look.drift.loose, ...(look.drift.noGit ? { noGit: true } : {}) } } : {}),
    ...(look.unmapped?.length ? { unmapped: { rows: look.unmapped.slice(0, UNMAPPED_SHOWN), more: Math.max(0, look.unmapped.length - UNMAPPED_SHOWN) } } : {}),
    ...(look.leads?.length ? { leads: { keys: look.leads.slice(0, LEADS_SHOWN), more: Math.max(0, look.leads.length - LEADS_SHOWN) } } : {}),
    // Past plans, newest first, with the parts that are still on the map.
    ...(look.plans?.length ? { plans: [...look.plans].reverse().slice(0, 10).map(p => ({ ...p, parts: p.parts.filter(id => map.parts.some(q => q.id === id)) })) } : {}),
  }
}

// A project that has a map and no plan: the map as it stands, with each part with files that exist counted as already there.
const standing = (map: SystemMap, look: MapLook): Drawing => ({
  map, warnings: [],
  exists: map.parts.filter(p => { const fp = look.now?.[p.id]; return !!fp && 'hash' in fp && fp.files > 0 }).map(p => p.id),
})

// A draft waiting for the user's lock is what the views show, over any plan still running.
export function summarize(top: Run, look: MapLook = {}): VM {
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
        ...(phase === 'draft' ? {} : editedOf(r, s.id)),
        status: (phase === 'complete' || done.has(s.id) ? 'done' : i === pos ? (red ? 'trap' : 'active') : r.running?.[s.id] ? 'running' : 'todo') as Status,
        needs: s.id === 'done' ? [] : needsOf(plan.states, s.id),
        waits: phase === 'complete' || done.has(s.id) || s.id === 'done' ? [] : needsOf(plan.states, s.id).filter(n => !done.has(n)),
        ...(r.skipped?.[s.id] ? { skipped: r.skipped[s.id] } : {}),
        ...(s.id !== 'done' && r.library ? { weightNow: weightFor(r, s) } : {}),
        ...(skipsOf(r, s.id).length ? { skips: skipsOf(r, s.id) } : {}),
        ...(s.id !== 'done' && memberGap(r, s) ? { noRerun: true as const } : {}),
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
      H: c.H, trapStart: !!c.trapStart, inWindow: c.step >= winFrom, ...(c.ms !== undefined ? { ms: c.ms } : {}),
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
    looks: r.looks ?? [],
    trips: (r.trips ?? []).slice(-50), startedAt: phase === 'draft' ? undefined : r.startedAt, endedAt: phase === 'draft' ? undefined : r.endedAt, ...(phase === 'complete' && r.closed ? { closed: r.closed } : {}), visitCalls: phase === 'live' ? visit.length : 0,
    spend: top.spend ?? [], spendFrom: top.spendFrom, usage: usageView(top.usage),
    lanes: (top.lanes ?? []).map(l => ({ ...l, name: l.name || l.id })),
    deps: !!plan?.states.some(s => s.needs),
    ...(asked && !answered(r) ? { waiting: { kind: asked.kind, text: asked.text, at: asked.at } } : {}),
    ...(blockedOn(r) ? { blocked: blockedOn(r) } : {}),
    replied: !!asked && answered(r),
    handsFree: !!r.handsFree,
    ...(r.sweep && { sweep: r.sweep }),
    ...(phase === 'live' && r.checking?.length && { checking: r.checking }),
    ...(top.flowDraft && { flowDraft: top.flowDraft }),
    ...((r.drawing || (!plan && look.map)) && { system: systemOf(r, r.drawing ?? standing(look.map!, look), states, phase, lastCheck, blockedOn(r), look) }),
    ...(top.draft && top.held?.depth && { depth: top.held.depth }),
    ...(top.draft && { points: top.held?.points ?? [] }),
    ...(r.library ? { planWeight: r.library.weight } : {}),
    ...(r.library?.states ? { settingRows: settingRows(r) } : {}),
    ...(facts && { proof: {
      quoted: plan!.states.filter(s => s.asked?.length).length,
      of: plan!.states.filter(s => s.asked?.length || s.added).length,
      sources: facts.sources,
      refused: (top.refused ?? []).map(x => ({ ...x, says: REFUSED_SAYS[x.why] })),
    } }),
  }
}

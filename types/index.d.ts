export type View = 'focus' | 'map' | 'ledger' | 'system'

// ref: where the state's details are written. evidence: why a state that was done before the lock counts as done.
// group: a name the views fold the state under, "a/b" for b inside a. It only labels.
// title, problem and approach: plain words for the task page in the browser view. They are shown there only,
// never sent back to the model.
// wait: the state needs the user's OK. 'before' (or true): the model proposes what it will do and edits nothing until
// they answer. 'after': they review the finished work before it moves on. Either way only an answer given after the
// model asked counts, and the views say it needs the user only while it waits for that answer.
// needs: the states this one builds on. Without it, a state needs the one listed before it.
export type Wait = 'before' | 'after'
export type StateDef = {
  id: string; label: string; check?: string; files: string[]; ref?: string; evidence?: string; group?: string
  title?: string; problem?: string; approach?: string; wait?: boolean | Wait; needs?: string[]
  // A check that holds only at this moment, such as one tied to a branch: it runs at this state's advance and never again.
  once?: true
  // The parts of the system map this state builds (ids of parts with nothing inside them).
  parts?: string[]
  // Where the state came from, while quote-the-source is on. asked: the words it quotes, compared with the sources.
  // added: Claude's reason, when nothing asked for it.
  asked?: string[]; added?: string
  // okAt: when the user kept a state Claude added on the draft. look: why Sentinel stops a state Claude added at its start.
  okAt?: string; look?: string
  // With the Library's state-settings switch on. weight: this state's, with weightWhy saying why it differs from the plan.
  // weightQuote: the user's words that asked for it. weightOk: the user asked for it or kept it, which a weight looser than
  // the plan's needs. adds: instructions on top.
  weight?: Weight; weightWhy?: string; weightQuote?: string; weightOk?: true; adds?: { name: string; why: string }[]
  // A state a flow put in the plan: the flow's name, the name of this copy (review, or review-2 for a second one), and
  // why it is there (the user added it, or one of their rules).
  flow?: FlowMark
}
export type FlowMark = { name: string; as: string; why: string }

// A flow: states the user keeps to add before or after any part of a plan. Saved as .sentinel/flows/<name>.json
// (project) or ~/.sentinel/flows/<name>.json (personal). Placeholders such as {{state.id}} fill in where it is added.
// when: a rule that adds it to each new plan, before or after the states that edit `files` (every state without
// them), or at the start or the end.
export type FlowWhen = { at: 'start' | 'end' | 'before' | 'after'; files?: string[] }
export type FlowState = { id: string; label: string; check?: string; files?: string[]; wait?: boolean | Wait; title?: string; problem?: string; approach?: string }
export type FlowDef = { name: string; description?: string; when?: FlowWhen; states: FlowState[] }

// An instruction: text Sentinel hands Claude at one moment. Saved as .sentinel/instructions/<name>.json (project) or
// ~/.sentinel/instructions/<name>.json (personal). at: draft (while Claude drafts a plan), start (when a state that
// edits files starts), close (before such a state closes; told at its start), final (before the plan completes),
// always (every turn). files: for start and close, only the states that edit them.
export type InstructionAt = 'draft' | 'start' | 'close' | 'final' | 'always'
export type InstructionDef = { name: string; description?: string; at: InstructionAt; files?: string[]; text: string; weights?: Weight[] }
// How much testing the built-ins carry. Each built-in says which weights turn it on.
export type Weight = 'light' | 'standard' | 'thorough'
// A switches file: .sentinel/library.json (the project's, committed) or ~/.sentinel/library.json (the user's default).
// on: an item's switch by name, where it differs from its default.
export type Switches = { weight?: Weight; on?: Record<string, boolean> }
// What a plan was locked with: the weight, every item on by name, and the instructions Claude is told.
// states: only with the state-settings switch on, what lets a state differ from the plan. hand: the switches flipped by
// hand, which no weight moves. weights: which weights turn on each instruction a state's weight can move. spare: the told
// instructions off for this plan that a state's weight or addition can bring in.
// settings: what Claude set for this plan, with why or the user's quote. held: looser and waiting for the user, so not in effect.
export type PlanSetting = { weight?: Weight; name?: string; on?: boolean; why?: string; quote?: string; held?: true }
// One row of the draft card's settings: what differs from the plan, for the states it covers. owed: it waits for the user.
// kept: they kept a looser one. id: what an answer names.
export type SettingRow = { id: string; kind: 'plan' | 'weight' | 'add'; states: string[]; key?: string; weight?: Weight; name?: string; on?: boolean; why?: string; quote?: string; owed: boolean; kept?: true; looser?: true }
export type PlanLibrary = { weight: Weight; on: string[]; told: InstructionDef[]; states?: { hand: Record<string, boolean>; weights: Record<string, Weight[]>; spare: InstructionDef[] }; settings?: PlanSetting[] }
// The system map, saved in .sentinel/system.json (committed). A part is flat with a parent id, so one part is one line
// and two people editing different parts merge cleanly.
// drawnAt: the commit the part was last drawn at. An outside part has evidence in place of files.
export type Cite = { file: string; text: string }
export type Evidence = { seen: Cite[] } | { said: string } | { guess: string }
export type SysPart = {
  id: string; name: string; parent?: string; desc?: string; files?: string[]
  kind?: 'outside'; evidence?: Evidence; where?: string; drawnAt?: string
}
export type SysActor = { id: string; name: string; desc?: string }
export type SysLine = { from: string; to: string; says: string }
export type SystemMap = { name: string; actors: SysActor[]; parts: SysPart[]; lines: SysLine[] }
export type SysTreePart = SysPart & { kids: SysTreePart[] }
// A part's files as one hash and a count. none: it has no files to hash, or the folder has no git repo.
export type Fingerprint = { hash: string; files: number } | { none: 'no files' | 'no git' }
// What a part shows (hooks/mapstatus.ts). planned: Not built. exists: Already there. change: Will change. now: Claude is here.
// changed: Changed since test. failing: Check failing. needs: Needs you.
export type PartStatusName = 'planned' | 'exists' | 'change' | 'now' | 'tested' | 'changed' | 'untested' | 'failing' | 'needs' | 'outside' | 'dropped'
// One state of the run as the map needs it. parts: the leaf parts it builds. where: done, being worked on, or not started.
export type MapRunState = {
  id: string; parts: string[]; where: 'done' | 'active' | 'ahead'
  hasCheck?: boolean; skipped?: boolean; once?: boolean; failing?: boolean; blocked?: string; reopened?: string
}
// A part's saved proof (marks.json, kept out of git). base: its fingerprint when the state started, and since: which
// visit that was (state@step). hash: its fingerprint when the check passed, and from: the baseline it was measured against.
// check, weight and at: what proved it and when. step and run: the ledger step of the proof and the run it was in, so
// an edit after it can be told from one before.
// fine: the part's fingerprint when the user said a drift mark was fine; the mark stays away until the files differ from it.
export type PartMark = { base?: string; since?: string; hash?: string; from?: string; check?: string; weight?: string; at?: string; step?: number; run?: number; fine?: string }
// What git says changed in a project since a commit, one file at a time. A: added. M: edited. D: removed. R: renamed from `was`.
export type Change = { how: 'A' | 'M' | 'D' | 'R'; path: string; was?: string }
// What the update check asks of git. git: there is a repo. since: the changes since each commit parts were drawn at (null: git
// does not know the commit). files: every file the project has now, tracked or new.
export type DriftFacts = { git: boolean; since: Record<string, Change[] | null>; files: string[] }
// What the update check found. parts: the leaf parts whose files changed or went. why: one line for each. loose: files added
// since the map was drawn that no part covers. noGit: there is no repo to compare with.
export type Drift = { parts: Record<string, 'changed' | 'gone'>; why: Record<string, string>; loose: string[]; noGit?: true }
export type Marks = Record<string, PartMark>
// A top-level folder no part's files reach, and how many files it holds.
export type Unmapped = { path: string; files: number }
export type StatusInput = {
  map: SystemMap; states: MapRunState[]
  existing?: string[]; dropped?: string[]
  marks?: Record<string, PartMark>; now?: Record<string, Fingerprint>
  closed?: { ran: string[] }; drift?: Record<string, 'changed' | 'gone'>
}
export type PartStatus = {
  status: PartStatusName; tags: string[]; note?: string; shares?: string[]
  proof?: { check?: string; weight?: string; at?: string }; evidence?: 'seen' | 'said' | 'guess'
}
export type MapTone = 'red' | 'amber' | 'blue' | 'dashed' | 'plain' | 'green' | 'neutral'
export type MapCounts = Record<PartStatusName, number>
export type MapRoll = { tone: MapTone; counts: MapCounts; total: number }
export type MapTally = MapCounts & { total: number; built: number; untestedOrChanged: number }
// One part as the screens draw it, with the parts inside it. A part with nothing inside has a status; a group has a roll
// (its colour and counts). builtBy: the states that build it. outside: where it runs and why Claude says it is there.
export type MapNode = {
  id: string; name: string; desc?: string; files?: string[]
  outside?: { kind: 'seen' | 'said' | 'guess'; why: string; where?: string }
  status?: PartStatus; roll?: MapRoll; builtBy: string[]; kids: MapNode[]
}
// The system map as the views show it (summarize). parts and lines count what the drawing holds; tree, tally, actors and
// links are what the System screens draw; here is where Claude is working now.
export type SystemView = {
  name: string; parts: number; lines: number; warnings: string[]; guessed: string[]
  tree: MapNode[]; tally: MapTally; actors: SysActor[]; links: SysLine[]; here: { id: string; name: string }[]
  changes: MapChanges
  drift?: { count: number; why: Record<string, string>; loose: string[]; noGit?: boolean }
  plans?: PlanLine[]
  // Folders no part reaches (Not mapped yet) and .env.example endpoint keys nothing names (Not placed yet), each cut to what shows.
  unmapped?: { rows: Unmapped[]; more: number }
  leads?: { keys: string[]; more: number }
}
// What summarize needs besides the run to say how the parts stand: the saved proofs, and the files as last looked at.
// map: the project's own map, for the screens when no plan has drawn one. drift: what the update check found.
export type MapLook = { marks?: Marks; now?: Record<string, Fingerprint>; map?: SystemMap; drift?: Drift; plans?: PlanLine[]; unmapped?: Unmapped[]; leads?: string[] }
// One finished plan, a line of .sentinel/plans.json: how it ended, when, and the ids of the parts its states built.
export type PlanLine = { title: string; at: string; ended: 'complete' | 'closed'; parts: string[] }
// The map a plan draws, kept in the run. map: the project's map with the plan's drawing merged in, as it stands now.
// locked: as it stood at the lock, so what changed since can be told. warnings: what the drawing checks found; they never
// stop a lock. exists: the ids of the parts nothing builds whose files are in the project, as of the last drawing.
export type Drawing = { map: SystemMap; locked?: SystemMap; warnings: string[]; exists: string[] }
// What differs between the drawing as signed off and as it stands (changesOf). edited: what changed in each part, in words.
export type MapChanges = {
  added: { id: string; name: string }[]; dropped: { id: string; name: string }[]
  edited: { id: string; name: string; what: string[] }[]; linesAdded: SysLine[]; linesDropped: SysLine[]
}
export type LibraryScope = 'built-in' | 'project' | 'personal'
// One instruction as the dashboard shows it. kind: told (Claude reads the text) or checks (Sentinel acts itself).
// runs: the check runs it adds per state; slow: they can take as long as the check. needs: what it depends on.
export type LibraryItem = InstructionDef & {
  scope: LibraryScope; title?: string; kind: 'told' | 'checks'; runs?: number; slow?: boolean; needs?: string
  weights?: Weight[]; on: boolean; trusted: boolean; file?: string; own?: boolean
}
// The Library as the dashboard reads it: the weight in force, both switches files as saved, the instructions, and
// which flows are on (the flows themselves are in `flows`).
export type LibraryView = { weight: Weight; project: Switches; personal: Switches; instructions: LibraryItem[]; flowsOn: Record<string, boolean> }

// What a quote can be compared with. approved: the plan the user approved in plan mode, with their edits (name: its file).
// file: a copy of the file the plan's `source` names, taken once (name: that file's path). message: a typed message.
export type Source = { kind: 'approved' | 'message' | 'file'; text: string; at: string; name?: string }
// A quote Sentinel refused, or a state that sent none (why: none), kept for the record.
export type Refused = { state: string; quote?: string; why: 'missing' | 'short' | 'excluded' | 'empty' | 'long' | 'none'; nearest?: string; t: string }

export type Plan = {
  title: string
  states: StateDef[]
  loops: [string, string][]
  lockedAt: string
  source?: string
}

export type Kind = 'plan' | 'edit' | 'check' | 'look' | 'ask'

// One tool call while a plan runs: what it was, its progress label u, and
// the health the detector computed right after it.
export type Call = {
  step: number
  t: string
  state: string
  kind: Kind
  label: string
  u: 0 | 1
  repeat?: true
  denied?: true
  prov?: true
  revoked?: true
  drift?: true
  trapStart?: true
  fp?: string
  file?: string
  ver?: string
  before?: string
  revisitOf?: number
  pass?: boolean
  sig?: string
  sigText?: string
  fails?: number
  // A check run Sentinel can rely on, its own or the model's run of the check as written from the project root:
  // the run's touch count when it began.
  touches?: number
  same?: true
  // An edit to a file of a state that is done already, made from the active state to fix it: that state's id.
  fix?: string
  n: number
  S: number
  R: number
  p: number
  H: number
}

// The active state's check that Sentinel runs now. ids: the states it is the check of. at: when it started. ms: how long
// it had run when last written, once a minute. quiet: silent past twice its longest quiet stretch before.
export type Checking = { label: string; ids: string[]; at: number; ms: number; quiet?: true }

export type Trap = {
  state: string
  // hung: a check Sentinel stopped as stuck. Only the page's trap carries it; the run's traps never do.
  pattern: 'cycle' | 'drift' | 'static' | 'hung'
  step: number
  end?: number
  notes: number
  lastNote: number
  file?: string
  ver?: string
  revisitOf?: number
}

export type AuditKind = 'refused' | 'blocked' | 'decided' | 'amended' | 'auto' | 'asked' | 'escalated'
// state: the state that was active when it happened; none for what was decided at the lock.
// by: 'claude' marks a choice Claude recorded with decide, which is the only kind that can excuse a rerun.
export type Audit = { step: number; t: string; kind: AuditKind; text: string; state?: string; by?: 'claude' }

export type Tone = 'ok' | 'err' | 'warn' | 'acc' | 'ask' | 'dim'
export type LogLine = { t: string; icon: string; tone: Tone; text: string }

// Tokens the models used, one row per model, effort and loop (the main conversation, or its subagents).
// input is uncached input; cacheRead and cacheWrite are input served from and written to the prompt cache.
// A limit as Claude Code reports it: how much of it the whole account has used.
export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }
// What this plan used, in the session's dollars. last: the session's cost at the last reading. began: each limit when counting began.
export type Usage = { usd: number; last: number; byState: Record<string, number>; windows: UsageWindow[]; began: UsageWindow[]; perPoint?: number }
export type UsageView = {
  windows: { name: string; percent: number; resetsAt?: string; was?: number }[]
  usd: number
  // The share of the week, as words: about 1.4%. Left out with no weekly figure.
  plan?: string
  steps: Record<string, string>
}
// One measurement of what 1% of the week costs: usd spent while the figure moved points.
export type Price = { usd: number; points: number; at: string }
// The last reading of the weekly figure and the session's cost, and where the running measurement started.
export type Watch = { pct: number; usd: number; resetsAt?: string; from?: { pct: number; usd: number } }

export type Spend = { model: string; effort?: string; sub: boolean; requests: number; input: number; output: number; cacheRead: number; cacheWrite: number }

// One helper agent's lane. Its calls stay out of `calls` and the health window. state: the state that was active at
// its last call. edits: the files it changed. last: its latest call. running: it is still working.
export type Lane = { id: string; name: string; state: string; calls: number; edits: string[]; last: string; running: boolean }

// A member agent working on one state: its agent id, the name of its worktree under .claude/worktrees/, how
// often its check has failed there, and its answer while helpers it started still work.
export type Member = { agent: string; name: string; since: number; fails?: number; answer?: string }

// A way back that was taken: when, along which edge, and the reason the model gave.
export type Trip = { from: string; to: string; at: number; t: string; reason: string }

// The times a state was active (ms since the epoch; a visit with no `to` is still running), and what was done there.
// cont: a stretch that carries on a visit after a pause or a closed session. It is not a new visit.
// by: 'member' on a visit a member agent worked, in its own worktree; the main conversation's visits have none.
export type Task = { visits: { from: number; to?: number; cont?: boolean; by?: 'member' }[]; outcome?: string }

// What the model sends to the plan tool.
export type PlanInput = {
  action: string
  title?: string
  // revise: every state id of the plan, in order.
  order?: string[]
  states?: { id?: string; label?: string; check?: string; files?: string[]; parts?: string[]; ref?: string; evidence?: string; asked?: unknown; added?: unknown; once?: unknown; group?: string; title?: string; problem?: string; approach?: string; wait?: boolean | Wait; needs?: string[]; flow?: FlowMark; weight?: Weight; weightWhy?: string; weightQuote?: string; weightOk?: true; adds?: { name: string; why: string }[] }[]
  // define, revise, with the Library's state-settings switch on: the plan's weight and instructions on or off. Sentinel
  // turns it into library.settings; with the switch off it is dropped.
  settings?: unknown
  // flow: the flow the model drafts for the user to save.
  name?: string
  description?: string
  when?: { at?: string; files?: string[] }
  // propose: what the model will do in a state that asks before it starts.
  intent?: string
  brief?: string
  loops?: string[][]
  start?: string
  source?: string
  decisions?: { topic?: string; choice?: string; reason?: string }[]
  to?: string
  evidence?: string
  outcome?: string
  files?: string[]
  check?: string
  reason?: string
  topic?: string
  choice?: string
  kind?: string
  // define: what the plan is locked with. Sentinel sets it; anything the model sends here is dropped.
  library?: PlanLibrary
  // define, revise: the copy of the file `source` names. Sentinel sets it; anything the model sends here is dropped.
  named?: Source
  // define, revise: the session's typed messages, for quotes to be compared with. Sentinel sets it, and it is never kept.
  messages?: { text: string; at: string }[]
  // define: the model's answers to "what would an expert do here", for the user to tick before the lock.
  depth?: Depth[]
  // define, revise, map: the parts, lines and people the plan draws, as an object. Sentinel merges it into the project's map.
  system?: unknown
  // define, revise, map: the map with that drawing merged in, and the ids of the parts nothing builds whose files exist.
  // Sentinel sets it; anything the model sends here is dropped.
  drawn?: { map: SystemMap; exists: string[] }
  // status: a part id, to read that part and what is inside it. map: part ids to take off the map (with a reason).
  area?: string
  drop?: string[]
  // map: the ids of the parts or areas Claude reread and redrew because the user asked. Their marker moves to the commit now.
  redraw?: string[]
  // map: the part ids in `drop` that the user agreed to in the dialog. Sentinel sets it; anything the model sends here is dropped.
  approved?: string[]
  // flow: an instruction's text and moment, in place of states.
  text?: string
  at?: string
}
// An answer the user may tick. ask: the question it answers. state: a state of the draft that is there for it, taken
// out at the lock unless the user ticks it.
export type Depth = { id: string; text: string; ask?: 'expert' | 'raw' | 'methods' | 'proof'; state?: string }

export type Run = {
  signedOff: boolean
  plan: Plan | null
  // The main conversation's state.
  active: string | null
  // The states finished so far. Without it (a run saved before it existed), every state listed before `active`.
  done?: string[]
  // Parallel states: the states that run beside `active`, each in a member agent, by state id.
  running?: Record<string, Member>
  enteredAt: number
  step: number
  calls: Call[]
  traps: Trap[]
  audit: Audit[]
  log: LogLine[]
  loops: Record<string, number>
  lastLoop?: string
  askToken: number
  breakingOk: boolean
  quiet: boolean
  auto: number
  // The user's /sentinel pause: the plan is kept but nothing is enforced or recorded.
  paused?: boolean
  // When the user last typed a prompt or answered a question (ms since the epoch).
  heardAt?: number
  // What waits on the user's answer, asked at `at` (ms) and call `step`: a state's proposal (before) or its finished
  // work (after). `ok` is set once the stop goes through the question dialog: then only the Yes label or the dashboard's
  // Approve settles it (true), and a typed message does not (false). Without `ok`, an answer after `at` settles it.
  pending?: { state: string; at: number; step: number; kind: Wait; text?: string; ok?: boolean }
  // The call step at which the user last approved each finished state's review. A loop back keeps that review for a
  // state whose own files have not been edited since.
  reviewed?: Record<string, number>
  // When the model last escalated (ms). Until the user answers, a stopped turn is not pushed on.
  escalatedAt?: number
  // What a blocked report says the run waits for, outside Sentinel and Claude. It counts while the escalation of the same `at` waits.
  blocked?: { what: string; at: number }
  // Hands-free: the user is away, so the calls that would wait for them (proposals, reviews, breaking changes,
  // questions) are Claude's to make, each recorded for them to check later.
  handsFree?: true
  // States the user skipped, with why. They count as done for the states that need them, and the final check leaves
  // them out.
  skipped?: Record<string, string>
  // The user closed the plan with /sentinel finish: why, the states left unfinished, and the done states whose checks
  // never ran again.
  closed?: { why: string; unfinished: string[]; unchecked: string[] }
  // The output of the last failing check run, cut to its end, for the refusal that names it.
  lastFail?: { step: number; text: string }
  // Signed off with /sentinel lock: define saves `draft` and the user locks it with a second /sentinel lock.
  review?: boolean
  // States whose check Sentinel ran once as they started, to see it fail before the work.
  startChecked?: string[]
  // What this plan's quotes are compared with. A plan-mode sign-off saves the approved plan here before define; a draft
  // holds its own.
  sources?: Source[]
  // What Sentinel refused while this plan was being written.
  refused?: Refused[]
  // The instructions and switches the plan was locked with. A run saved before it existed behaves as Standard did:
  // fails-first on, nothing told.
  library?: PlanLibrary
  // fails-without-change: the project as the active state's visit began, as a commit. state and enteredAt name the
  // visit. An empty sha: the snapshot failed, and the log said so.
  snap?: { state: string; enteredAt: number; sha: string }
  // The define behind a plan that isn't locked yet: one sent before any sign-off, which /sentinel lock drafts as it
  // is, or the one that made the draft, which revise changes.
  held?: PlanInput
  // How many times the project may have changed outside the ledger: a helper agent's call, a member's work brought
  // back, a resume. A check run stands in for advance's own only while this count is the same.
  touches?: number
  // The checks the final checks saw pass, with the ledger step and touch count then: a later try skips them while
  // nothing has changed since.
  swept?: Record<string, { step: number; touches: number }>
  // The final checks under way: the states whose checks run now, and how many of all have passed or failed.
  sweep?: { going: string[]; passed: number; failed: number; total: number }
  // The checks Sentinel runs now, for the status line, the band and the page.
  checking?: Checking[]
  // A check of the active state that Sentinel stopped as stuck. It shows as stuck until a check runs again.
  hung?: { state: string; check: string; step: number; text: string }
  // Wall-clock times (ms since the epoch) from the lock to the finish. A pause or a held question counts.
  startedAt?: number
  endedAt?: number
  tasks?: Record<string, Task>
  // The last working-time mark (ms) said for each state. A run saved before it existed has said none.
  timeSaid?: Record<string, number>
  trips?: Trip[]
  // When .sentinel/run.json was last written. Only the saved file has it.
  savedAt?: number
  // Tokens from the sign-off until the plan is complete, paused or not; spendFrom is when counting began (ISO).
  spend?: Spend[]
  spendFrom?: string
  // What the plan used of the user's limits, counted over the same span.
  usage?: Usage
  // The helper agents that called tools while the plan ran, one lane each.
  lanes?: Lane[]
  draft?: Run
  // A flow or an instruction (it has text, not states) the model drafted for the user to save, and what they asked
  // for, if they asked from the dashboard.
  flowDraft?: (FlowDef | InstructionDef) & { asked?: string }
  // The system map this plan draws.
  drawing?: Drawing
}

declare module 'claude-code' {
  interface PluginState {
    // said: the session's typed messages and the files Claude wrote. Never saved, unlike run.
    // overseers: the agents started to look into a long state, by agent id, with what each answered. They die with the
    // session's process, and so does this.
    sentinel: { run: Shaped<Run>; view: Shaped<View>; said: Shaped<{ messages: { text: string; at: string }[]; wrote: string[] }>; overseers: Shaped<Record<string, { state: string; word?: string }>> }
  }
}

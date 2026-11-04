export type View = 'focus' | 'map' | 'ledger'

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
  // Where the state came from, while quote-the-source is on. asked: the words it quotes, compared with the sources.
  // added: Claude's reason, when nothing asked for it.
  asked?: string[]; added?: string
  // okAt: when the user kept a state Claude added on the draft. look: why Sentinel stops a state Claude added at its start.
  okAt?: string; look?: string
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
export type InstructionDef = { name: string; description?: string; at: InstructionAt; files?: string[]; text: string }
// How much testing the built-ins carry. Each built-in says which weights turn it on.
export type Weight = 'light' | 'standard' | 'thorough'
// A switches file: .sentinel/library.json (the project's, committed) or ~/.sentinel/library.json (the user's default).
// on: an item's switch by name, where it differs from its default.
export type Switches = { weight?: Weight; on?: Record<string, boolean> }
// What a plan was locked with: the weight, every item on by name, and the instructions Claude is told.
export type PlanLibrary = { weight: Weight; on: string[]; told: InstructionDef[] }
export type LibraryScope = 'built-in' | 'project' | 'personal'
// One instruction as the dashboard shows it. kind: told (Claude reads the text) or checks (Sentinel acts itself).
// runs: the check runs it adds per state; slow: they can take as long as the check. needs: what it depends on.
export type LibraryItem = InstructionDef & {
  scope: LibraryScope; title?: string; kind: 'told' | 'checks'; runs?: number; slow?: boolean; needs?: string
  weights?: Weight[]; on: boolean; trusted: boolean; file?: string
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
export type Audit = { step: number; t: string; kind: AuditKind; text: string; state?: string }

export type Tone = 'ok' | 'err' | 'warn' | 'acc' | 'ask' | 'dim'
export type LogLine = { t: string; icon: string; tone: Tone; text: string }

// Tokens the models used, one row per model, effort and loop (the main conversation, or its subagents).
// input is uncached input; cacheRead and cacheWrite are input served from and written to the prompt cache.
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
  states?: { id?: string; label?: string; check?: string; files?: string[]; ref?: string; evidence?: string; asked?: unknown; added?: unknown; group?: string; title?: string; problem?: string; approach?: string; wait?: boolean | Wait; needs?: string[]; flow?: FlowMark }[]
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
  // work (after). An answer after `at` settles it.
  pending?: { state: string; at: number; step: number; kind: Wait; text?: string }
  // When the model last escalated (ms). Until the user answers, a stopped turn is not pushed on.
  escalatedAt?: number
  // Hands-free: the user is away, so the calls that would wait for them (proposals, reviews, breaking changes,
  // questions) are Claude's to make, each recorded for them to check later.
  handsFree?: true
  // States the user skipped, with why. They count as done for the states that need them, and the final check leaves
  // them out.
  skipped?: Record<string, string>
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
  trips?: Trip[]
  // When .sentinel/run.json was last written. Only the saved file has it.
  savedAt?: number
  // Tokens from the sign-off until the plan is complete, paused or not; spendFrom is when counting began (ISO).
  spend?: Spend[]
  spendFrom?: string
  // The helper agents that called tools while the plan ran, one lane each.
  lanes?: Lane[]
  draft?: Run
  // A flow or an instruction (it has text, not states) the model drafted for the user to save, and what they asked
  // for, if they asked from the dashboard.
  flowDraft?: (FlowDef | InstructionDef) & { asked?: string }
}

declare module 'claude-code' {
  interface PluginState {
    // said: the session's typed messages and the files Claude wrote. Never saved, unlike run.
    sentinel: { run: Shaped<Run>; view: Shaped<View>; said: Shaped<{ messages: { text: string; at: string }[]; wrote: string[] }> }
  }
}

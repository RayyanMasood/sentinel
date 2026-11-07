// The Library items Sentinel ships. Read-only: the user switches them on or off, or copies one to edit it. A weight
// turns on the built-ins that list it; sources-first, close-phase and state-settings are in no weight, so they start off.
import type { FlowDef, InstructionDef, Weight } from '../types'
import { STATE_SETTINGS } from './core.ts'

export const WEIGHTS: readonly Weight[] = ['light', 'standard', 'thorough']

// kind: told (Claude reads the text) or checks (Sentinel acts itself; the text says what it does and is never told).
// runs: check runs it adds per state. slow: they take as long as the check does. needs: what it depends on.
export type Builtin = InstructionDef & { title: string; kind: 'told' | 'checks'; weights: Weight[]; runs?: number; slow?: boolean; needs?: string }

export const BUILTINS: readonly Builtin[] = [
  {
    name: 'depth-before-size', title: 'Deeper, not bigger', at: 'draft', kind: 'told', weights: ['standard', 'thorough'],
    text: 'Before you write the plan, answer in a few lines: what would an expert in this field do here that the brief '
      + "doesn't ask for; what is the rawest material to start from (the real failing output, the files, the logs) instead "
      + 'of a summary; which methods and tools would they use; and what, other than you or the user, shows the result is '
      + 'right (name the artifact). Put the answers at the top of the plan as choices the user can take or leave.',
  },
  {
    name: 'draw-system', title: 'Draw the system map', at: 'draft', kind: 'told', weights: ['standard', 'thorough'],
    text: 'Draw the parts of the system this plan builds or changes, and nothing else, in "system" on define: parts (id, name, '
      + 'parent, desc, files), lines (from, to, says) and people (actors). Put a part inside another with "parent". Something '
      + 'outside the project, such as Redis or a service in another repo, is a part with kind "outside" and evidence: seen '
      + '(the file and the text in it), said (what the user told you) or guess. Sentinel checks every seen citation and '
      + 'turns one that fails into a guess. Each state names the parts it builds in "parts": parts with nothing inside them. '
      + 'A state that only reads, or comes from a flow, names none. Sentinel sets every status itself, so do not say what is '
      + 'built or tested.',
  },
  {
    name: 'fast-checks', title: 'Fastest check that proves it', at: 'draft', kind: 'told', weights: ['light', 'standard', 'thorough'],
    text: 'Give each state the fastest check that proves its own work: one test file, a type check or a build. Run the whole suite once, in the last state.',
  },
  {
    name: 'failure-list', title: 'Failure list first', at: 'start', kind: 'told', weights: ['standard', 'thorough'],
    text: 'Before writing logic, write down how it can fail and test each item, with the tests written before the code. '
      + 'Tests written after the code to raise coverage end up restating it.',
  },
  {
    name: 'quote-the-source', title: 'Each state quotes what asked for it', at: 'draft', kind: 'checks', weights: ['light', 'standard', 'thorough'],
    text: "Sentinel compares each state's quote with the plan you approved and the messages you typed, word for word and with no model. A quote that isn't there is refused, and a state nothing asked for shows as Claude's addition.",
  },
  {
    name: 'fails-first', title: 'Check fails before the work', at: 'start', kind: 'checks', runs: 1, weights: ['standard', 'thorough'],
    text: "Sentinel runs the state's check once before any edit. If it already passes, Claude is told the check proves nothing yet and tightens it.",
  },
  {
    name: 'break-it-once', title: 'A test must be able to fail', at: 'close', kind: 'told', weights: ['standard', 'thorough'],
    text: "Break the code each new test targets once and watch the test fail, then put the code back. Report any test you couldn't make fail.",
  },
  {
    name: 'fails-without-change', title: 'Check fails without the change', at: 'close', kind: 'checks', runs: 2, slow: true, weights: ['thorough'],
    text: "Before a state closes, Sentinel reruns its check in a scratch copy that has the state's test changes but not its "
      + 'code changes. If the check still passes there, the advance is refused until the check is tightened or Claude records why with a decide about this check. '
      + "If it fails, Sentinel runs it once more with the code changes in, to tell a real failure from a copy that can't run the check.",
  },
  {
    name: 'prove-end-to-end', title: 'Prove it end to end', at: 'final', kind: 'told', weights: ['thorough'],
    text: 'A feature that crosses parts ends with an end-to-end run that leaves an artifact anyone can rerun and a script can check: '
      + 'the command and its saved output, a rendered image, a log.',
  },
  {
    name: 'measure-before-delete', title: 'Delete tests only after measuring', at: 'always', kind: 'told', weights: ['thorough'],
    needs: 'A mutation-testing tool, such as Stryker or go-mutesting.',
    text: "Delete a test only after a mutation run shows it catches nothing the others don't. Never by reading alone.",
  },
  {
    name: 'sources-first', title: 'Plan from the raw sources', at: 'draft', kind: 'told', weights: [],
    text: 'Plan from the raw sources (the TRD, the design frames, the sprint sheet), not summaries of them. Where they disagree, '
      + 'the TRD decides behaviour and data, the design decides screens, and the sprint sheet decides scope and order. '
      + 'List each conflict at the top of the plan, and ask before departing from the TRD on anything structural.',
  },
  {
    name: STATE_SETTINGS, title: 'Settings per state', at: 'draft', kind: 'told', weights: [],
    text: 'You may set what each state needs, where it differs from the plan. define and revise take these fields though the plan tool\'s schema '
      + 'doesn\'t list them. On a state: weight (light, standard or thorough) with weightWhy, one line on why, or weightQuote, the user\'s words; and '
      + 'adds, a list of { name, why } naming Library instructions that fire per state. On the plan: settings, a list of { weight } or { name, on }, '
      + 'each with why or quote. A quote is compared with what the user typed: for an instruction turned on or a stricter weight, its name and one more '
      + 'word will do; anything looser needs at least 5 words. A stricter setting applies with its reason shown. A looser one with only a reason waits '
      + 'for the user on the draft. Leave alone a state that fits the plan.',
  },
]

// A phase close: check the work against the project's rules, review it with three agents, fix what the user
// accepts, and bring the docs up to date.
export const BUILTIN_FLOWS: readonly (FlowDef & { weights: Weight[] })[] = [
  {
    name: 'close-phase', weights: [], when: { at: 'end' },
    description: 'Close a phase: check it against the project rules, review it with three agents, fix what you accept, update the docs.',
    states: [
      { id: 'principles', label: "Re-read the project's rules and design docs, and list where this plan's changes depart from them", title: 'Check against the project rules' },
      { id: 'audit', label: 'Review the files this plan changed with three agents (simplicity, bugs, project conventions), and list the findings', title: 'Review the changes', wait: 'after' },
      { id: 'fix', label: 'Fix the findings the user accepted', title: 'Fix the accepted findings', files: ['**'] },
      { id: 'docs', label: 'Update the docs this plan made stale', title: 'Update the docs', files: ['**/*.md', 'docs/**'] },
    ],
  },
]

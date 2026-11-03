import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Next, Register, ToolCallResult } from 'claude-code'
import type { Checking, Depth, FlowDef, InstructionAt, InstructionDef, LibraryItem, LibraryScope, LibraryView, PlanLibrary, Run, StateDef, Switches, View, Weight } from '../types'
import { BUILTINS, BUILTIN_FLOWS, WEIGHTS } from './builtins'
import {
  AUTO_CAP, RETRIES, VIEWS, act, addSpend, autoContinue, besideNote, briefRefusal, emptyRun, failSig, fnv, forwardCheck, freshCount, healthWord, heard, isLive, isUnfinished, laneCall, handsFree, capOf, HANDS_FREE, laneDone, lockDraft, memberByAgent, memberByFile, memberFail, memberIn,
  memberOff, knownPass, observe, revised, openTrap, recordStart, sameText, sweepChecks, untestedNote, touched, visitOf, startCheck, clocked, startMember, stopClock, outOfScope, priorChecks, relInput, relPath, sameCommand, stateOf, summarize,
  answered as settled, fixChecks, fixOf, notYet, sweptPass, pendingOf, tailOf, waitOf, waitingOn, addFlow, dropFlow, flowOf, ruleText, withRules, type Acted, type Observed, type PlanInput, type Proofs, type Where,
  instructionOf, libraryOn, withWeight, librarySection, toldHere, dropStates,
  rerunOf, snapWanted, withSnap, type Without,
} from './core'
import { checkLine, renderBand, renderPane, sweepLine } from './views'

type $ = EngineInterface
type Result = ToolCallResult

const TOOL = 'mcp__sentinel__plan'
const PANE = 'sentinel'
const TAG = '[sentinel]'
const run = atom({ plugin: 'sentinel', key: 'run' } as const, emptyRun(), { shape: 'run-1' })
const view = atom({ plugin: 'sentinel', key: 'view' } as const, 'focus' as View, { shape: 'view-1' })

const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])
// Bookkeeping tools: they neither move the work nor stall it.
const NEUTRAL = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'ToolSearch', 'EnterPlanMode'])

const now = () => new Date().toTimeString().slice(0, 5)

// The engine passes the model only the first 4096 characters of a tool's description.
export const DESCRIPTION = `Sentinel holds a signed-off plan as a state machine and keeps you to it.

After the user approves a plan (plan mode, or /sentinel lock), call action "define" before editing anything:
- states, in order. Each has an id, a label, a check command that proves it done (bash, run from the project root; exit 0 means done) and the files it may edit (globs relative to the root). A state that only reads needs no check; one that only verifies lists no files. Write each check so it fails until the work is in: Sentinel runs it when the state starts and tells you if it passes already. Checks run again before the plan completes, so make them safe to repeat.
- A state that hands over several branches or pull requests needs a check that tests them together, such as git merge-tree --write-tree <a> <b> per pair (exit 1 on a conflict); "mergeable" only compares with the base.
- loops: back edges you expect, such as ["verify", "service"] when a failing suite sends you back to fix code.
- source: where the plan is written (file and section), and a "ref" on each state pointing to its details, so they survive compaction.
- group: for more than about 8 states, a group name on each, such as "auth" or "marking/runs". Keep a group's states together.
- title, problem, approach: plain lines for the state's task page, for someone who doesn't read code. Title under 8 words; problem and approach a sentence or two.
- wait: "before" on a state the user OKs before you start (a design, a risky change): there, call "propose" with "intent" (what you will do), then stop your turn; edits open once they answer. "after" on a state they review when done: advance tells them, then stop your turn until they answer.
- needs: the ids of the states a state builds on. Without it, a state needs the one listed before it. List every state after its needs. States where neither needs the other can run at the same time, so their files must not overlap.

If part of the plan is already done, list the whole plan anyway: set "start" to the first unfinished state (Sentinel runs the checks before it and refuses the lock if one fails), give a finished state without a check "evidence" (a commit, a test run, what the user confirmed), and add the "decisions" already made (topic, choice, reason).
After /sentinel lock, define saves a draft the user checks and locks; stop and wait. For changes, call "revise" with "order" (every state id) and "states" holding only the changed or new ones, each whole. States left out of order are dropped; other fields stay unless sent.

While the plan runs:
- "advance" runs the state's check and moves on only when it exits 0. Run the check with Bash as often as you like. Moving forward, give "outcome": what was done, in one or two plain sentences. Going back along a loop needs a reason in "evidence", and reopens that state and the states that need it.
- Edits outside the active state's files are refused. Add files with "amend" (files, reason).
- Don't ask the user about choices that aren't breaking. Pick what the codebase and common practice support, record it with "decide" (topic, choice, reason), and go on.
- Breaking means: a public API or exported signature changes, a schema or data migration the plan didn't include, deleting user data, a new dependency, or auth, permissions, secrets, CI or deploy config. For those, call "escalate" with kind "breaking" and a reason, then ask the user one question.
- You may fix files of done states; advance then runs their checks too.
- Only the user skips a state: when they ask in the chat, call "skip" (to, reason).
- If Sentinel says you are stuck, follow its note. "escalate" with kind "stuck" opens after two notes. "status" shows where you are.
- With parallel states on, Sentinel names the states ready to run beside yours. Give each a "brief" (to, brief): Sentinel starts a member agent in a worktree of the project as it is then, which may edit only that state's files.

When the user asks for a flow (states reused in plans), send action "flow" (name, description, states, when); they save it.`

const LOCK = `${TAG} The user signed off the plan we're working from. Call ${TOOL} with action "define" for it. If part of it is already done, list the finished states too and set "start" to the first unfinished one. Add the decisions already made, where the plan is written ("source"), a "ref" for each state, and a plain title, problem and approach for each state (they read these on its task page). The user checks the draft before it locks, so stop after define.`

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['define', 'revise', 'advance', 'brief', 'propose', 'skip', 'amend', 'decide', 'escalate', 'status', 'flow'] },
    order: { type: 'array', items: { type: 'string' }, description: 'revise: every state id of the plan, in order' },
    title: { type: 'string', description: 'define: the plan name' },
    states: {
      type: 'array',
      description: 'define: the states in order. revise: only the states that change or are new, each sent whole. flow: its states, in order; {{state.id}}, {{state.label}}, {{state.files}} and {{plan.title}} fill in from where the user adds it',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          check: { type: 'string', description: 'shell command; exit 0 means the state is done' },
          files: { type: 'array', items: { type: 'string' }, description: 'globs this state may edit' },
          ref: { type: 'string', description: 'where this state is described (doc section, plan step)' },
          evidence: { type: 'string', description: 'states before start: what shows it is done' },
          group: { type: 'string', description: 'the group this state is shown under; a/b for b inside a' },
          title: { type: 'string', description: 'a plain name for the task page, under 8 words' },
          problem: { type: 'string', description: 'what is wrong or needed, in one or two plain sentences for the task page' },
          approach: { type: 'string', description: 'what you will do about it, in one or two plain sentences for the task page' },
          wait: { type: 'string', enum: ['before', 'after'], description: "the user's OK: before you start the state (you propose first), or after it is done (they review it)" },
          needs: { type: 'array', items: { type: 'string' }, description: 'the ids of the states this one builds on; leave it out to need the state listed before it' },
        },
        required: ['id', 'label'],
      },
    },
    start: { type: 'string', description: 'define: the first unfinished state, when part of the plan is already done' },
    name: { type: 'string', description: 'flow: its name, in lowercase letters, digits and -' },
    description: { type: 'string', description: 'flow: one line on what it is for' },
    when: {
      type: 'object',
      description: 'flow: only when the user wants it added to every new plan by itself: at the start or end, or before or after the states that edit these files (no files: every state)',
      properties: { at: { type: 'string', enum: ['start', 'end', 'before', 'after'] }, files: { type: 'array', items: { type: 'string' } } },
      required: ['at'],
    },
    source: { type: 'string', description: 'define: where the plan is written' },
    decisions: {
      type: 'array',
      description: 'define: decisions already made',
      items: { type: 'object', properties: { topic: { type: 'string' }, choice: { type: 'string' }, reason: { type: 'string' } }, required: ['topic', 'choice'] },
    },
    loops: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 }, description: 'define: [from, to] back edges' },
    to: { type: 'string', description: 'advance: the next state id, a loop target, or "done"; brief: the ready state; skip: the state the user skips' },
    brief: { type: 'string', description: "brief: the member agent's task, what to do and what to watch for" },
    intent: { type: 'string', description: 'propose: what you will do in the state, in plain words for the user' },
    evidence: { type: 'string', description: 'advance: what you found (needed for states without a check and for loops)' },
    outcome: { type: 'string', description: 'advance forward: what was done in the state you leave, in one or two plain sentences, shown on its task page' },
    files: { type: 'array', items: { type: 'string' }, description: 'amend: files to add to the active state. flow, for an instruction at start or close: only the states that edit these globs hear it' },
    text: { type: 'string', description: 'flow: in place of states, an instruction (words Sentinel hands Claude at one moment) for the user to save: its text, a few plain lines' },
    at: {
      type: 'string', enum: ['draft', 'start', 'close', 'final', 'always'],
      description: "flow, with text: the instruction's moment: draft (while a plan is drafted), start (as a state that edits files starts), close (before such a state advances; told at its start), final (before the plan completes), always (every turn)",
    },
    depth: {
      type: 'array',
      description: 'define, for a draft the user locks with /sentinel lock: your answers to what an expert would do here, the rawest material to start from, the methods, and what shows the result is right. The user ticks the ones they want as they lock it; nothing is ticked unless they pick it',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'a short word the user ticks with /sentinel lock <id>' },
          text: { type: 'string', description: 'the answer, one line' },
          ask: { type: 'string', enum: ['expert', 'raw', 'methods', 'proof'], description: 'the question it answers' },
          state: { type: 'string', description: 'a state of this plan that is there only for this answer: Sentinel takes it out unless the user ticks the answer' },
        },
        required: ['id', 'text'],
      },
    },
    check: { type: 'string', description: 'amend: replace the active state check' },
    reason: { type: 'string', description: 'amend, decide, escalate, skip: why' },
    topic: { type: 'string', description: 'decide: what was decided' },
    choice: { type: 'string', description: 'decide: the choice' },
    kind: { type: 'string', enum: ['breaking', 'stuck'], description: 'escalate' },
  },
  required: ['action'],
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'plan', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
    await $.command.register({
      name: 'sentinel',
      description: 'Sentinel plan pane. Args: focus, map, ledger, browser, lock (sign off the agreed plan; then lock the draft, with the ids of the depth answers you tick), pause, resume, skip <state>, hands-free [off], reset, parallel on|off (experimental), library, on|off <name> [personal], weight light|standard|thorough [personal], trust <name>, add <flow> <where>, drop <flow>, flow save project|personal, flow discard',
      argumentHint: '[focus|map|ledger|browser|lock|lock <depth ids>|pause|resume|skip <state>|hands-free|hands-free off|reset|parallel on|parallel off|library|on <name>|off <name>|weight light|weight standard|weight thorough|trust <name>|add <flow> start|end|before <state>|after <state>|drop <flow>|flow save project|flow save personal|flow discard]',
    })
    // Final checks and check runs a lost session left showing are over.
    await change($, r => (r.sweep || r.checking ? { ...r, sweep: undefined, checking: undefined } : r))
    void libraryView($).catch(() => undefined)
    // A new session starts empty; say so when the project holds an unfinished plan.
    void after($).then(async () => {
      const s = (await read($, run)).plan ? undefined : await saved($)
      if (s) $.ui.status(`"${s.plan!.title}" unfinished · /sentinel resume`)
    })
    return next(e)
  })

  // The Library's draft and always instructions reach Claude as one section of the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e)
    const text = await promptSection($)
    return text ? { sections: [...res.sections, { id: 'sentinel:library', text, scope: 'session' as const }] } : res
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sentinel' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    // What changes the plan is the user's alone: typed at the prompt, sent through Remote Control or run headless
    // (claude -p), never run by the model or another plugin. The engine stamps every run's origin; only the test kit
    // leaves it out.
    const by = (e.origin as { kind?: string } | undefined)?.kind
    if (/^(lock|reset|pause|resume|skip|hands-free|approve-all|parallel\s|add\s|drop\s|flow\s|on\s|off\s|weight\s|trust\s)/.test(arg) && by !== undefined && !['composer', 'bridge', 'sdk'].includes(by)) {
      return { text: `Only the user runs /sentinel ${arg.split(/\s/)[0]}, typed at the prompt.` }
    }
    const locking = /^lock(?:\s+(.+))?$/.exec(arg)
    if (locking) {
      const r = await read($, run)
      // The ids after lock tick the draft's depth answers.
      const picked = locking[1]?.split(/\s+/) ?? []
      if (r.draft) return { text: await lockNow($, picked) }
      if (picked.length) return { text: 'There is no draft to lock yet. Tick its depth answers with the /sentinel lock that locks it.' }
      await change($, x => ({ ...x, ...freshCount(x, new Date().toISOString()), signedOff: true, review: true, held: undefined }))
      // A define the model sent before the sign-off becomes the draft as it is. One that starts partway needs the
      // checks of its earlier states run, so the model sends that one again.
      const held = r.held && !priorChecks(r.held).length ? await planCall($, r.held) : undefined
      if (held && held.deny === undefined) {
        const states = (await read($, run)).draft?.plan?.states
        const apart = states && (await parallelOn($)) ? untestedNote(states)?.replace('[sentinel] ', '\n') : undefined
        return { text: `Signed off. The plan the model sent before is the draft now. Review it from the band above the prompt or with /sentinel, then lock it.${apart ?? ''}` }
      }
      const why = held ? `\nThe define you sent before the sign-off was refused: ${held.deny}`
        : r.held ? '\nThe define you sent before the sign-off starts partway, so send it again: Sentinel runs the checks of the states before its start.' : ''
      later($, LOCK + why)
      return { text: 'Signed off. The model drafts the plan next. Review it from the band above the prompt or with /sentinel, then lock it.' }
    }
    if (arg === 'reset') {
      await change($, () => emptyRun())
      await $.fs.write(await runFile($), JSON.stringify(emptyRun())).catch(() => undefined)
      void after($)
      return { text: 'Sentinel plan cleared.' }
    }
    if (arg === 'parallel' || arg.startsWith('parallel ')) return { text: await setParallel($, arg.slice(8).trim()) }
    if (arg === 'pause') return { text: await pause($) }
    // approve-all is the older name.
    const free = /^(hands-free|approve-all)( off)?$/.exec(arg)
    if (free) {
      if (!isLive(await read($, run))) return { text: 'No plan is running.' }
      await setFree($, !free[2])
      return { text: !free[2] ? 'Hands-free: Claude makes the calls that would wait for you, and the dashboard lists them under Decided without asking you. /sentinel hands-free off takes it back.' : 'Hands-free is off. Claude asks you again.' }
    }
    if (arg === 'resume') return { text: await resume($) }
    if (arg === 'browser') return { text: await openBrowser($) }
    if (arg.startsWith('skip ')) return { text: await skipNow($, e.args.trim().slice(5).trim()) }
    // flows is the list's older name.
    if (arg === 'library' || arg === 'flows') return { text: await libraryList($) }
    const sw = /^(on|off)\s+(\S+)(\s+personal)?$/.exec(arg)
    if (sw) return { text: (await switchNow($, sw[2]!, sw[1] === 'on', sw[3] ? 'personal' : 'project')).text }
    const weight = /^weight\s+(\S+)(\s+personal)?$/.exec(arg)
    if (weight) return { text: (await weightNow($, weight[1]!, weight[2] ? 'personal' : 'project')).text }
    const trusting = /^trust\s+(\S+)$/.exec(arg)
    if (trusting) return { text: (await trustNow($, trusting[1]!)).text }
    if (arg.startsWith('add ')) return { text: await addNow($, e.args.trim().slice(4).trim()) }
    if (arg.startsWith('drop ')) {
      const as = e.args.trim().slice(5).trim()
      return { text: await changeDraft($, held => dropFlow(held, as), `Took ${as} out of the draft.`) }
    }
    if (arg.startsWith('flow ')) return { text: await flowCommand($, arg.slice(5).trim()) }
    if ((VIEWS as string[]).includes(arg)) await update($, view, () => arg as View)
    // Bare /sentinel shows what needs you: a draft to check, or a stuck run.
    await openPane($, !arg && needsYou(await read($, run)))
    return { text: 'Sentinel pane open.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = e.props.hasSurvey ? undefined : renderBand($.ui.resolve(e), summarize(await read($, run)), {
      open: focus => void openPane($, focus),
      lock: () => void lockNow($),
      resume: () => void resume($),
      saveFlow: scope => void keepFlow($, scope).then(t => $.ui.toast(`Sentinel: ${t}`)),
      discardFlow: () => void flowCommand($, 'discard').then(t => $.ui.toast(`Sentinel: ${t}`)),
    })
    return band ?? next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    // Sentinel's own check runs stay out of the ledger, as does its stop of a check left in the background. Only those
    // calls: a member's own calls may carry Sentinel's origin too, since Sentinel spawned it.
    if (next.origin.plugin === $.plugin.name && ((tool === 'Bash' && input.description === CHECK) || tool === 'TaskStop')) return next(e)
    if (tool === TOOL) {
      if (e.agentId === undefined) return planCall($, input as unknown as PlanInput, false, next.signal)
      // A subagent reads the plan and never moves it; its call stays out of the ledger.
      if (input.action !== 'status') return { deny: `Only the main conversation moves the plan. A subagent may call ${TOOL} with action "status"; report what you did to the agent that started you.` }
      return { result: act(await read($, run), input as unknown as PlanInput, now()).text }
    }
    if (tool === 'ExitPlanMode') return signOff($, await next(e))
    // ponytail: guards Edit and Write only; a Bash redirect into the file gets through.
    if (EDITS.has(tool) && relPath(await $.session.root(), String(input.file_path ?? input.notebook_path ?? ''))?.toLowerCase() === PARALLEL_FILE) {
      return { deny: "Parallel states are the user's choice. They turn them on or off with /sentinel parallel on or /sentinel parallel off." }
    }
    const r = await read($, run)
    if (!isLive(r) || NEUTRAL.has(tool)) return tool === 'AskUserQuestion' ? (await ask($, e, next))[0] : next(e)
    // Subagents get the scope guard only; their calls would drown the main loop's health window.
    const sub = e.agentId !== undefined

    if (EDITS.has(tool)) {
      const file = String(input.file_path ?? input.notebook_path ?? '')
      const root = await $.session.root()
      const rel = relPath(root, file)
      // Outside the project, but a check may still read it.
      if (rel === undefined) {
        await change($, touched)
        return next(e)
      }
      // A member works on its own state in its own worktree, and so does any helper it starts there.
      const member = memberByFile(r, file)
      const own = sub ? await memberOf($, r, e.agentId!) : undefined
      const scope = own && own !== member
        ? `You work on ${own} in .claude/worktrees/${r.running![own]!.name}/. Edit ${rel} there.`
        : outOfScope(r, rel, root, member ?? r.active)
      // The main conversation may fix a done state's files; advance runs that state's check again.
      // ponytail: its helpers may not, as their calls stay out of the ledger that advance reads.
      const fix = scope && !sub && !member ? fixOf(r, rel, root) : undefined
      const why = (!own && !member && notYet(r)) || (fix ? undefined : scope)
      if (why && sub) {
        await lane($, r, e.agentId!, { label: `${tool} ${rel} (refused)` })
        return { deny: why }
      }
      if (why) return record($, { deny: why }, { kind: 'edit', label: `${tool} ${rel}`, file: rel, denied: true })
      if (sub) {
        const ran = await next(e)
        await lane($, r, e.agentId!, { label: `${tool} ${rel}`, file: ran.isError || ran.deny !== undefined ? undefined : rel })
        return ran
      }
      // A visit the user locked with /sentinel lock has no snapshot yet: it is taken before the first edit.
      await snapStart($)
      // A file already edited in this state: its last version stands for "before", so it is read once, after the edit.
      // ponytail: a Bash change between two edits goes unseen as a version; read before every edit if loops get missed.
      const before = visitOf(r).findLast(c => c.file === rel && c.ver !== undefined)?.ver ?? (await hashOf($, file))
      const ran = await next(e)
      const ok = !ran.isError && ran.deny === undefined
      return record($, ran, { kind: 'edit', label: `${tool} ${rel}`, file: rel, before, ver: ok ? await hashOf($, file) : undefined, ...(fix && { fix }) })
    }

    if (sub) {
      const ran = await next(e)
      // A member's background shell or monitor: its hand-back waits until that is done.
      const task = (ran.result as { backgroundTaskId?: unknown; taskId?: unknown } | undefined)
      const id = tool === 'Bash' ? task?.backgroundTaskId : tool === 'Monitor' ? task?.taskId : undefined
      if (typeof id === 'string' && (await memberOf($, r, e.agentId!))) {
        bgBy.set(id, e.agentId!)
        firstSeen.set(id, Date.now())
      }
      await lane($, r, e.agentId!, { label: tool === 'Bash' ? `Bash ${String(input.command ?? '')}`.slice(0, 80) : lookLabel(tool, input) })
      return ran
    }

    if (tool === 'AskUserQuestion') {
      const questions = input.questions as { question?: string }[] | undefined
      const q = questions?.[0]?.question ?? 'question'
      if (r.handsFree) {
        return record($, { deny: `Sentinel holds this question. ${HANDS_FREE}` }, { kind: 'ask', label: q, denied: true })
      }
      // After an escalation, or in a state that needs the user's OK, the question goes through.
      if (r.askToken > 0 || waitOf(stateOf(r))) {
        await change($, x => ({ ...x, askToken: Math.max(0, x.askToken - 1), quiet: false }))
        const [ran, label] = await ask($, e, next, q)
        return record($, ran, { kind: 'ask', label })
      }
      return record($, {
        deny: `The plan is signed off and no breaking change was declared, so Sentinel holds this question. Pick what the codebase and common practice support, record it with ${TOOL} action "decide", and continue. If this really is breaking (public API, schema, deleting data, new dependency, auth, CI or deploy config), call "escalate" with kind "breaking" first.`,
      }, { kind: 'ask', label: q, denied: true })
    }

    if (tool === 'Bash') {
      const cmd = String(input.command ?? '')
      const check = stateOf(r)?.check
      // The check as written, run from the project root, can stand in for advance's own run. The shell may sit elsewhere.
      const here = check !== undefined && sameText(cmd, check) && dirKey(await $.session.cwd().catch(() => '')) === dirKey(await $.session.root())
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      if (check !== undefined && sameCommand(cmd, check) && !input.run_in_background && !unfinished(ran)) {
        return record($, ran, { kind: 'check', label: cmd, pass: passed(ran), ...failSig(ran.text ?? ''), tail: tailOf(ran.text ?? ''), ...(here && { touches: r.touches ?? 0 }) })
      }
      return record($, ran, { kind: 'look', label: `Bash ${cmd}`.slice(0, 80), fp: fnv(`Bash\n${cmd}\n${ran.text ?? ''}`) })
    }

    const ran = await next(e)
    return record($, ran, { kind: 'look', label: lookLabel(tool, input), fp: fnv(`${tool}\n${stable(input)}\n${ran.text ?? ''}`) })
  }).catch(($, e, next) => next(e))

  // Keep going when the model stops mid-plan, at most AUTO_CAP times without a state change.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turning = true
      backBusy = false
      turns++
      lastTurnAt = turnAt
      turnAt = Date.now()
      void after($)
    }
    return next(e)
  })

  // What is still in flight when a conversation stops: background shells, monitors and agents, and timers that wake
  // it. They answer into it by themselves, so it is not pushed on.
  on('classic.Stop', async ($, e, next) => {
    seen('', e.background_tasks, e.session_crons)
    return next(e)
  })
  on('classic.SubagentStop', async ($, e, next) => {
    seen(e.agent_id, e.background_tasks)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) turning = false
    const done = await next(e)
    // A helper agent's turn ends: its lane is done until another call of it. A member's work gets checked and brought back.
    if (e.agentId !== undefined) {
      await change($, r => laneDone(r, e.agentId!))
      const r = await read($, run)
      const member = memberByAgent(r, e.agentId)
      if (member) void handBack($, member, e.answer).catch(() => undefined)
      else {
        // A helper is in. A member that stopped while its helpers worked gets checked once the last of them is in.
        const parent = await memberOf($, r, e.agentId)
        const answer = parent ? r.running?.[parent]?.answer : undefined
        if (answer !== undefined) void handBack($, parent!, answer, e.agentId).catch(() => undefined)
      }
      void after($)
      return done
    }
    // A hint from the dashboard that no tool result carried starts the next turn, in place of auto-continue. One sent
    // before the user stopped the turn is dropped with it.
    const h = takeHint()
    if (e.reason === 'aborted' || (!h && e.reason !== 'answer')) {
      backBusy = false
      void after($)
      return done
    }
    if (h) {
      tell($, h)
      return done
    }
    // Background agents answer into this conversation by themselves. A failed list counts as none. Other background
    // work holds the push for HOLD_MS at most; past that the push names it, and a check comes once all of it is past.
    const live = flight('')?.tasks ?? []
    const held = holding(live)
    const busy = !!held.length || (await agents($)).some(working)
    backBusy = busy
    void after($)
    if (held.length) {
      const at = turns
      $.clock.after(Math.max(0, Math.max(...held.map(t => firstSeen.get(t.id)! + HOLD_MS)) - Date.now()) + 1000, () => void (async () => {
        if (turns !== at || turning) return
        // Past HOLD_MS a shell or a monitor no longer counts as work: a server or a watcher never ends.
        backBusy = (await agents($)).some(working)
        void after($)
        if (!backBusy) await push($, false, held)
      })().catch(() => undefined))
    }
    await push($, busy, live.filter(t => !held.includes(t)))
    return done
  })

  // Tokens: every model response, the main conversation's and its subagents', while a plan is under way.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    if (res.usage) spent($, res.usage, e.effort, e.agentId !== undefined)
    return res
  })

  // A prompt the person typed answers what waits on them and resets the auto-continue count. In the turn it starts, the
  // model may skip a state they asked to skip. Sentinel's own prompts come from the plugin, so they never count.
  on('prompt.submit', async ($, e, next) => {
    // The notice that one of Sentinel's own check runs ended is Sentinel's; the model never started that run.
    const task = e.origin.kind === 'task-notification' ? /<task-id>([^<]+)<\/task-id>/.exec(e.text)?.[1] : undefined
    if (task && ownTasks.has(task)) return { drop: 'Sentinel read this check run itself' }
    const res = await next(e)
    if (!('drop' in res) && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')) {
      await userSpoke($)
    }
    return res
  })

  on('session.compact', async ($, e, next) => {
    const r = await read($, run)
    const keep = () => `A Sentinel plan is locked ("${r.plan!.title}", active state ${r.active}). Keep that fact. Call ${TOOL} with action "status" to reload the details and decisions.`
    const res = await next(e.agentId !== undefined || !isLive(r) ? e : { ...e, instructions: [e.instructions, keep()].filter(Boolean).join('\n\n') })
    // The summary's own request counts too; the engine doesn't say which model made it.
    if ('usage' in res && res.usage) spent($, { ...res.usage, model: 'compaction' }, undefined, e.agentId !== undefined)
    return res
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const vm = summarize(await read($, run))
    const v = await read($, view)
    return renderPane(el, vm, v, {
      pick: next => void update($, view, () => next),
      browser: () => void openBrowser($),
    })
  })
}

const needsYou = (r: Run) => !!r.draft || (isLive(r) && (!!openTrap(r) || waitingOn(r)))

// When the user last typed a prompt or answered a question, and when the main conversation's last two turns started.
// The user spoke for the turn under way if it was after the one before began: a prompt queued while the model worked
// counts in the turn that takes it up.
let typedAt = 0
// The same moment on the engine's clock, which a test can move: how long ago the user typed.
let typedClock = 0
const clockMs = ($: $) => $.clock.now().catch(() => Date.now())
// The user typed a prompt or answered a question: it answers what waits on them, and holds back the next push.
async function userSpoke($: $) {
  typedAt = Date.now()
  typedClock = await clockMs($)
  await change($, r => heard(r, Date.now()))
}
let turnAt = 0
let lastTurnAt = 0
let turns = 0
const spoke = () => typedAt > 0 && typedAt >= lastTurnAt

// Background work holds a push on, or a member's hand-back, for this long at most: a server or a watcher never ends.
const HOLD_MS = 30 * 60_000
// A turn that ends within TALK_MS of the user's prompt most likely answered it: a question, or being told to stop.
// Pushing on then would talk over them; a long stretch of work after their prompt still gets pushed on.
const TALK_MS = 5 * 60_000
type Flying = { id: string; what: string }
// The background work in flight at each conversation's latest stop ('' for the main one), and when each was first seen.
const inFlight = new Map<string, { at: number; tasks: Flying[] }>()
const firstSeen = new Map<string, number>()
function seen(agent: string, tasks?: { id: string; status: string; description: string }[], crons?: { id: string; prompt?: string }[]) {
  const live: Flying[] = [
    ...(tasks ?? []).filter(t => !['idle', 'completed', 'failed', 'killed'].includes(t.status)).map(t => ({ id: t.id, what: t.description.slice(0, 80) })),
    ...(crons ?? []).map(c => ({ id: `cron:${c.id}`, what: 'a scheduled wake-up' })),
  ]
  for (const t of live) if (!firstSeen.has(t.id)) firstSeen.set(t.id, Date.now())
  inFlight.set(agent, { at: Date.now(), tasks: live })
}
// The Stop input of the conversation that just stopped, taken once. undefined when none came: then only the agent list
// counts.
// ponytail: Stop is taken to come before turn.complete, since a Stop hook may keep the turn going; unverified.
function flight(agent: string) {
  const f = inFlight.get(agent)
  inFlight.delete(agent)
  return f && Date.now() - f.at < 60_000 ? f : undefined
}
// What still holds: the work that has run for less than HOLD_MS.
const holding = (tasks: Flying[]) => tasks.filter(t => Date.now() - (firstSeen.get(t.id) ?? Date.now()) < HOLD_MS)
// A member's background shells and monitors, by task id: its agent.
const bgBy = new Map<string, string>()
// The states whose member's work is being checked and brought back.
const bringing = new Set<string>()

// Pushes a stopped main conversation on, unless it waits for the user or for work that wakes it. long: background
// work that has run past HOLD_MS, named so the model can tell a server from a stuck run.
async function push($: $, busy: boolean, long: Flying[]) {
  let go = false
  let state = ''
  let n = 0
  let free = false
  let cap = AUTO_CAP
  const talking = spoke() && (await clockMs($)) - typedClock < TALK_MS
  await change($, r => {
    const out = autoContinue(r, now(), busy, talking)
    go = out.go
    state = out.run.active ?? ''
    n = out.run.auto
    free = !!out.run.handsFree
    cap = capOf(out.run)
    return out.run
  })
  if (!go) return
  void after($)
  const still = long.length ? ` Background work has run for over ${HOLD_MS / 60_000} minutes: ${long.map(t => t.what).join('; ')}. If it is a server or a watcher, carry on with the plan beside it.` : ''
  const how = free ? `${HANDS_FREE} Continue with the next step.` : 'Unless you need a breaking-change decision (escalate), continue with the next step.'
  tell($, `${TAG} The plan is signed off and not finished (state ${state}). ${how}${still} Auto-continue ${n} of ${cap}.` )
}

// Hands-free on or off. Turned on while the conversation sits waiting, it wakes it.
async function setFree($: $, on: boolean) {
  await change($, x => handsFree(x, on, now()))
  if (on && !turning) later($, FREE)
}
const FREE = `${TAG} ${HANDS_FREE} Continue with the plan.`

// The user's /sentinel skip, or Skip on the dashboard.
async function skipNow($: $, raw: string): Promise<string> {
  const [id = '', ...why] = raw.split(/\s+/)
  if (!isLive(await read($, run))) return 'No plan is running.'
  const ran = await planCall($, { action: 'skip', to: id, reason: why.join(' ') || 'The user skipped it.' }, true)
  if (ran.deny !== undefined) return ran.deny
  $.ui.toast(`Sentinel: ${id} skipped`)
  later($, `${TAG} The user skipped ${id}. Call ${TOOL} with action "status", then continue the work.`)
  return `Skipped ${id}.`
}

async function openPane($: $, focus: boolean) {
  if (focus) await update($, view, () => 'focus' as View)
  await $.ui.open({ id: PANE, title: 'Sentinel' })
}

// Locks the draft with the depth answers the user ticked, by id; none are ticked unless picked. A state that an
// unticked answer names comes out first, unless a ticked one names it too. /sentinel lock, the band's Lock and the
// dashboard's all come here.
async function lockNow($: $, picked: string[] = []): Promise<string> {
  const r = await read($, run)
  const depth = (r.draft && r.held?.depth) || []
  const ticked = (id: string) => picked.some(p => p.toLowerCase() === id.toLowerCase())
  const unknown = picked.filter(p => !depth.some(x => x.id.toLowerCase() === p.toLowerCase()))
  if (r.draft && unknown.length) {
    return depth.length ? `${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not one of the draft's depth answers: ${depth.map(x => x.id).join(', ')}. Nothing was locked.`
      : 'The draft has no depth answers to tick. Lock it with /sentinel lock alone.'
  }
  const chosen = depth.filter(x => ticked(x.id))
  const left = depth.filter(x => !ticked(x.id))
  const gone = [...new Set(left.flatMap(x => (x.state && !chosen.some(c => c.state === x.state) ? [x.state] : [])))]
  if (gone.length) {
    const why = await changeDraft($, held => ({ ...dropStates(held, gone), depth: undefined }), '')
    if (why) return `Sentinel couldn't take out ${gone.join(', ')}: ${why}`
  }
  let d: Run | undefined
  await change($, x => (x.draft ? (d = lockDraft(x, now())) : x))
  if (!d) return 'No draft to lock.'
  void after($)
  const took = gone.length ? `Sentinel took out ${gone.join(', ')}, there only for answers the user left unticked.` : ''
  const picks = [chosen.length ? `The user chose: ${texts(chosen)}.` : '', left.length ? `The user left out: ${texts(left)}.` : '', took].filter(Boolean).join(' ')
  later($, `${TAG} The user checked the draft and locked "${d.plan!.title}". Active state: ${d.active}.${picks ? ` ${picks}` : ''} Call ${TOOL} with action "status" first, then continue the work.`)
  return `Locked "${d.plan!.title}" at ${d.active}.${gone.length ? ` Took out ${gone.join(', ')}, named by answers you left unticked.` : ''}`
}
// The answers in one sentence, each without its closing full stop.
const texts = (xs: Depth[]) => xs.map(x => x.text.replace(/\.+$/, '')).join('; ')

async function pause($: $): Promise<string> {
  const r = await read($, run)
  if (!isLive(r)) return r.paused ? 'Sentinel is already paused.' : 'No plan is running.'
  await change($, x => ({ ...x, paused: true, log: [...x.log, { t: now(), icon: '‖', tone: 'warn' as const, text: 'Paused' }] }))
  return `Paused at ${r.active}. Edits, questions and stopped turns go unchecked until /sentinel resume.`
}

// Resumes a paused plan, or the unfinished plan an earlier session left in .sentinel/run.json.
async function resume($: $): Promise<string> {
  const cur = await read($, run)
  if (isLive(cur)) return 'The plan is already running.'
  const old = isUnfinished(cur) ? undefined : await saved($)
  if (!isUnfinished(cur) && !old) return 'Nothing to resume: no unfinished plan in this session or in .sentinel/run.json.'
  const from = old ? ' from an earlier session' : ''
  let r = cur
  await change($, x => {
    // A run left by a session that closed stopped working when it was last saved. The gap since then is not task time.
    const { savedAt, ...rest } = old ?? x
    // Member agents end with the session that started them: their states are ready again, and their worktrees stay.
    const kept = old ? Object.keys(rest.running ?? {}).reduce((y, id) => memberOff(y, id, 'its session ended', now(), savedAt ?? Date.now()), rest) : rest
    const b = old && savedAt ? stopClock(kept, savedAt) : kept
    // Files may have changed while Sentinel wasn't watching, so no earlier check run stands in for a new one.
    r = touched({ ...b, paused: false, auto: 0, log: [...b.log, { t: now(), icon: '▶', tone: 'ok' as const, text: `Resumed${from}` }] })
    return r
  })
  void $.ui.open({ id: PANE, title: 'Sentinel' })
  later($, `${TAG} The user resumed the plan "${r.plan!.title}"${from} at state ${r.active}. Files may have changed while Sentinel wasn't watching, so call ${TOOL} with action "status" first. Work done in the meantime counts: if ${r.active} is done, advance.`)
  return `Resumed "${r.plan!.title}" at ${r.active}.`
}

// The one way Sentinel tells Claude something: a prompt it reads next. Never throws.
const tell = ($: $, text: string) => void $.prompt.submit({ text }).catch(() => undefined)
// A command holds the turn while it runs, so its prompt for the model goes once it has returned.
const later = ($: $, text: string) => void $.clock.after(0, () => tell($, text))

// The session's agents; a failed list counts as none.
const agents = ($: $) => $.agent.list().catch(() => [])
const working = (a: { status: string }) => a.status === 'pending' || a.status === 'running' || a.status === 'waiting'

const runFile = async ($: $) => `${await $.session.root()}/.sentinel/run.json`

// Parallel states are an experimental switch, off by default. It is saved per project, apart from the plan, so a reset
// or a new plan keeps it. Only /sentinel parallel writes it.
const PARALLEL_FILE = '.sentinel/parallel'
// The last value read, for the browser page's snapshot, which is written after every call. A new session reads it once.
let parallelSeen: boolean | undefined
const parallelOn = async ($: $): Promise<boolean> =>
  (parallelSeen = String(await $.fs.read(`${await $.session.root()}/${PARALLEL_FILE}`).catch(() => '')).trim() === 'on')

async function setParallel($: $, want: string): Promise<string> {
  if (!want) {
    return (await parallelOn($))
      ? 'Parallel states are on (experimental). Turn them off with /sentinel parallel off.'
      : 'Parallel states are off. Turn them on with /sentinel parallel on (experimental).'
  }
  if (want !== 'on' && want !== 'off') return 'Use /sentinel parallel on or /sentinel parallel off.'
  const dir = `${await $.session.root()}/.sentinel`
  await $.fs.write(`${dir}/.gitignore`, IGNORE)
  await $.fs.write(`${dir}/parallel`, want)
  // The browser page draws parallel runs differently, so it gets a fresh snapshot.
  parallelSeen = want === 'on'
  void after($)
  if (want === 'off') return 'Parallel states are off. From now on states run one at a time in the listed order. States already started carry on as they are.'
  const r = await read($, run)
  const states = (r.draft ?? r).plan?.states
  const apart = states && (r.draft || isLive(r)) ? untestedNote(states)?.replace('[sentinel] ', '\n') : undefined
  return `Parallel states are on (experimental). From now on each state starts as soon as the states it needs are done. States already started carry on as they are.${apart ?? ''}`
}

async function saved($: $): Promise<Run | undefined> {
  const r = await $.fs.read(await runFile($)).then(t => JSON.parse(String(t)) as Run).catch(() => undefined)
  return r && isUnfinished(r) ? r : undefined
}

// user: the user asked for this call themselves (/sentinel skip, Skip on the dashboard). signal: aborts when the user
// stops the model's call, which then changes nothing.
async function planCall($: $, raw: PlanInput, user = false, signal?: AbortSignal): Promise<Result> {
  const typed = user || spoke()
  // What a plan is locked with comes from the switches files, never from the model.
  const { library: _library, ...sent } = raw
  let input = relInput(await $.session.root(), sent)
  const label = `plan ${input.action}${input.to ? ` → ${input.to}` : ''}`
  if (input.action === 'brief') return brief($, input, label)
  if (input.action === 'flow') return draftFlow($, input, label)
  // advance runs the check itself, unless the state's last call is a passing run of it that still holds. Plan calls
  // in between change no files.
  const was = await read($, run)
  // A new plan, or a new draft, takes the Library as the switches set it now. A revise keeps the draft's copy. The
  // flows that are on add themselves by their rules.
  const lib = input.action === 'define' ? await libraryNow($).catch(() => undefined) : undefined
  if (lib) input = { ...input, library: planLibrary(lib) }
  const ruled = lib && was.signedOff ? withRules(input, lib.flows.filter(f => lib.on.includes(f.name))) : undefined
  if (ruled) input = ruled.input
  const check = input.action === 'advance' ? forwardCheck(was, input.to) : undefined
  let note: string | undefined
  let slow: string | undefined
  let passing = !!check
  if (check && !knownPass(was, visitOf(was).findLast(c => c.kind !== 'plan'), check)) {
    const ran = await runCheck($, check, { signal })
    if ('deny' in ran) return record($, { deny: `Sentinel couldn't run \`${check}\`: ${ran.deny}` }, { kind: 'plan', label, denied: true })
    if (signal?.aborted) return { deny: STOPPED }
    if (ran.stuck) return record($, { deny: stuckText(check, ran) }, { kind: 'plan', label, denied: true })
    note = await track($, { kind: 'check', label: check, pass: ran.pass, ...failSig(ran.text), tail: tailOf(ran.text), touches: was.touches ?? 0 })
    slow = slowNote(was, check, ran.took)
    passing = ran.pass
  }
  // fails-without-change: a passing check runs again in a copy of the project without the visit's code changes.
  const wo = passing ? rerunOf(was) : undefined
  const without: Without | undefined = typeof wo === 'string' ? { skipped: wo } : wo && (await rerun($, check!, was.active!, wo, signal))
  if (signal?.aborted) return { deny: STOPPED }
  // A plan picked up partway: the checks of the states it starts after have to pass now.
  const proofs: Proofs = {}
  // Done states fixed in this state: their checks run again before it moves on.
  if (input.action === 'advance') {
    for (const c of fixChecks(was, input.to)) {
      const ran = await runCheck($, c)
      if ('deny' in ran) return record($, { deny: `Sentinel couldn't run \`${c}\`: ${ran.deny}` }, { kind: 'plan', label, denied: true })
      if (ran.stuck) return record($, { deny: stuckText(c, ran) }, { kind: 'plan', label, denied: true })
      proofs[c] = { pass: ran.pass, sigText: failSig(ran.text).sigText }
    }
  }
  // An advance (or a skip) that would complete the plan first runs the final checks. One cut short leaves the plan as
  // it is: nothing completes and nothing reopens.
  let late: string[] = []
  if (input.action === 'advance' || input.action === 'skip') {
    const now0 = await read($, run)
    if (act(now0, input, now(), {}, Date.now(), typed, without).event === 'complete') {
      const out = await finalChecks($, sweepChecks(now0, check).filter(c => !proofs[c]), proofs, signal)
      if (out.cut && !signal?.aborted) {
        const fails = Object.entries(proofs).filter(([, p]) => !p.pass).map(([c, p]) => `\`${c}\`: ${p.sigText}`)
        const deny = `The final checks stopped: \`${out.cut}\` ${out.stuck ? `was stopped as stuck: ${out.stuck}.` : 'was cut short before it finished.'} Nothing changed: ${now0.active} stays active and no state reopened.${fails.length ? `\nFailing so far:\n${fails.join('\n')}` : ''}\nAdvance again to finish them. The passes so far hold while nothing changes.`
        return record($, { deny }, { kind: 'plan', label, denied: true })
      }
      late = out.late
    }
  }
  const whole = input.action === 'define' ? input : input.action === 'revise' ? revised(was, input) : undefined
  if (typeof whole === 'object' && was.signedOff) {
    for (const c of priorChecks(whole)) {
      const ran = await runCheck($, c)
      if ('deny' in ran) return { deny: `Sentinel couldn't run \`${c}\`: ${ran.deny}` }
      if (ran.stuck) return { deny: stuckText(c, ran) }
      proofs[c] = { pass: ran.pass, sigText: failSig(ran.text).sigText }
    }
  }
  if (signal?.aborted) return { deny: STOPPED }
  let acted: Acted | undefined
  let fresh = false
  await change($, r => {
    acted = act(r, input, now(), proofs, Date.now(), typed, without)
    fresh = !!acted.run.pending && acted.run.pending !== r.pending
    return acted.run
  })
  const a = acted!
  const p = a.run.pending
  if (fresh && p) $.ui.toast(p.kind === 'before' ? `Sentinel: ${p.state} asks for your OK before it starts` : `Sentinel: ${p.state} is ready for your review`)
  const warn = await atStart($)
  // With parallel states on, the main conversation hears which states can run beside its own.
  const parallel = a.ok && ['define', 'revise', 'advance', 'status'].includes(input.action) && (await parallelOn($))
  const beside = parallel && input.action !== 'revise' ? besideNote(a.run) : undefined
  // A new plan or draft whose parallel states nothing tests together gets a warning, while it can still change.
  const plan = (a.run.draft ?? a.run).plan
  const apart = parallel && (input.action === 'define' || input.action === 'revise') && plan ? untestedNote(plan.states) : undefined
  if (input.action === 'status') return attach(attach({ result: a.text }, warn), beside)
  if (a.event === 'locked') {
    void $.ui.open({ id: PANE, title: 'Sentinel' })
    $.ui.toast(`Sentinel: plan locked, ${stateOf(a.run)?.id} is active`)
  }
  if (a.event === 'drafted') {
    void $.ui.open({ id: PANE, title: 'Sentinel' })
    $.ui.toast('Sentinel: draft ready. Review it from the band above the prompt')
  }
  if (a.event === 'complete') $.ui.toast('Sentinel: plan complete')
  const unrun = a.event === 'complete' && late.length
    ? `Not checked again before the plan completed, still running after ${WAIT_MS / 60_000} minutes, so Sentinel stopped it: ${late.map(c => `\`${c}\``).join(', ')}. Tell the user.`
    : undefined
  const rules = a.ok && ruled?.added.length
    ? `Sentinel added the user's flows by their rules: ${ruled.added.join(', ')}. Their states are part of the plan.${ruled.many.length ? ` Rules that matched many states: ${ruled.many.join(', ')}. Tell the user.` : ''}`
    : undefined
  const offered = a.event === 'drafted' && flowsSeen?.length
    ? `Flows the user can add while checking the draft: ${flowsSeen.map(f => (f.description ? `${f.name} (${f.description})` : f.name)).join('; ')}. If one fits this plan, suggest it and where in your reply; the user adds it.`
    : undefined
  return attach(attach(attach(attach(attach(attach(attach(attach(await record($, a.ok ? { result: a.text } : { deny: a.text }, { kind: 'plan', label, denied: !a.ok }), note), slow), warn), beside), apart), unrun), rules), offered)
}

// ---- the library: flows and instructions ----

type Scope = 'project' | 'personal'
type Kind = 'flow' | 'instruction'
// A flow as the Library holds it: from a file, or built in (no file, always trusted). weights: a built-in's, which a
// file that takes its place keeps.
type Saved = FlowDef & { scope: LibraryScope; file: string; trusted: boolean; weights?: Weight[] }
type SavedIns = InstructionDef & { scope: Scope; file: string; trusted: boolean }
const isScope = (v: unknown): v is Scope => v === 'project' || v === 'personal'
const DIRS = { flow: 'flows', instruction: 'instructions' } as const
const shown = (scope: Scope, rest: string) => `${scope === 'project' ? '' : '~/'}.sentinel/${rest}`
const shownDir = (scope: Scope, kind: Kind = 'flow') => shown(scope, DIRS[kind])
const NO_HOME = 'Sentinel found no home folder (HOME or USERPROFILE) for your personal Library.'
// The flows and instructions on disk as last read, the files that didn't read as one, what the user asked for in the
// dashboard's "Ask Claude for a flow", and the outcome of the dashboard's last save or delete.
let flowsSeen: Saved[] | undefined
let flowBad: string[] = []
let flowAsk: string | undefined
let flowSaid: { at: number; ok: boolean; text: string } | undefined

// The project's .sentinel folder, or the one in the user's home folder.
async function sentinelDir($: $, scope: Scope): Promise<string | undefined> {
  if (scope === 'project') return `${await $.session.root()}/.sentinel`
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  return home ? `${home.replace(/\\/g, '/').replace(/\/$/, '')}/.sentinel` : undefined
}
const itemDir = async ($: $, kind: Kind, scope: Scope) => {
  const dir = await sentinelDir($, scope)
  return dir ? `${dir}/${DIRS[kind]}` : undefined
}

// A rule puts checks in plans that nobody looks at first, and an instruction puts words in front of Claude, so only a
// file Sentinel saved on this computer, unchanged since, is on. A file from a clone, a teammate's commit or the model
// still lists, and a flow can still be added by hand, but it stays off until the user saves it here or types
// /sentinel trust. The store keeps each saved file's item, by path.
const TRUSTED = 'trustedFlows'
async function trust($: $, file: string, item?: object): Promise<void> {
  const t = { ...((await $.store.get(TRUSTED).catch(() => undefined)) as Record<string, string> | undefined) }
  if (item) t[file] = JSON.stringify(item)
  else delete t[file]
  await $.store.set(TRUSTED, t)
}
// An item as its file holds it, without what the Library adds.
const defOf = <T extends { scope: unknown; file: string; trusted: boolean; weights?: unknown }>({ scope: _s, file: _f, trusted: _t, weights: _w, ...def }: T) => def
const nameTaken = (name: string, by: Kind) => `"${name}" is already the name of ${by === 'flow' ? 'a flow' : 'an instruction'}.`

// The flows and instructions on disk, the project's first, then the personal ones. A file's name is its item's name;
// on a clash within a kind the project's wins. A name serves one item across both kinds: a built-in keeps it over a
// file of the other kind, and a flow over an instruction. A file with a built-in's name of its own kind takes the
// built-in's place and keeps its weights.
async function loadLibrary($: $): Promise<{ flows: Saved[]; instructions: SavedIns[] }> {
  const bad: string[] = []
  const t = ((await $.store.get(TRUSTED).catch(() => undefined)) ?? {}) as Record<string, string>
  async function files<T extends { name: string }>(kind: Kind, of: (raw: unknown) => T | string) {
    const out: (T & { scope: Scope; file: string; trusted: boolean })[] = []
    for (const scope of ['project', 'personal'] as const) {
      const dir = await itemDir($, kind, scope)
      for (const e of dir ? await $.fs.list(dir).catch(() => []) : []) {
        if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
        let f: T | string
        try {
          f = of({ ...JSON.parse(String(await $.fs.read(`${dir}/${e.name}`))), name: e.name.slice(0, -5) })
        } catch (err) {
          f = err instanceof Error ? err.message : String(err)
        }
        if (typeof f === 'string') bad.push(`${shown(scope, `${DIRS[kind]}/${e.name}`)}: ${f}`)
        else if (!out.some(x => x.name === f.name)) out.push({ ...f, scope, file: `${dir}/${e.name}`, trusted: t[`${dir}/${e.name}`] === JSON.stringify(f) })
      }
    }
    return out
  }
  const own = (x: { name: string; scope: Scope }, kind: Kind, others: readonly { name: string }[]) =>
    !others.some(o => o.name === x.name) || (bad.push(`${shown(x.scope, `${DIRS[kind]}/${x.name}.json`)}: ${nameTaken(x.name, kind === 'flow' ? 'instruction' : 'flow')}`), false)
  const mine = (await files('flow', flowOf)).filter(f => own(f, 'flow', BUILTINS))
  const instructions = (await files('instruction', instructionOf)).filter(x => own(x, 'instruction', [...mine, ...BUILTIN_FLOWS]))
  const flows: Saved[] = [
    ...mine.map(f => {
      const b = BUILTIN_FLOWS.find(x => x.name === f.name)
      return b ? { ...f, weights: b.weights } : f
    }),
    ...BUILTIN_FLOWS.filter(b => !mine.some(f => f.name === b.name)).map(b => ({ ...b, scope: 'built-in' as const, file: '', trusted: true })),
  ]
  flowBad = bad
  flowsSeen = flows
  return { flows, instructions }
}
const loadFlows = async ($: $) => (await loadLibrary($)).flows

// The instructions as the Library lists them: the built-ins, each replaced by a file of its name, then the user's own.
// The user's are told; one that replaces a built-in keeps its weights.
function insItems(user: SavedIns[]): Omit<LibraryItem, 'on'>[] {
  const mine = ({ file: _file, ...x }: SavedIns, weights?: Weight[]) => ({ ...x, file: shown(x.scope, `instructions/${x.name}.json`), kind: 'told' as const, ...(weights ? { weights } : {}) })
  return [
    ...BUILTINS.map(b => {
      const f = user.find(x => x.name === b.name)
      return f ? mine(f, b.weights) : { ...b, scope: 'built-in' as const, trusted: true }
    }),
    ...user.filter(x => !BUILTINS.some(b => b.name === x.name)).map(x => mine(x)),
  ]
}

// A switches file as saved. A missing or bad one reads as {}, and what in it is neither the weight nor a switch is left out.
async function switches($: $, scope: Scope): Promise<Switches> {
  const dir = await sentinelDir($, scope)
  if (!dir) return {}
  try {
    const s = JSON.parse(String(await $.fs.read(`${dir}/library.json`))) as Record<string, unknown>
    const on = s.on && typeof s.on === 'object' && !Array.isArray(s.on) ? Object.fromEntries(Object.entries(s.on).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean> : {}
    return { ...(WEIGHTS.includes(s.weight as Weight) ? { weight: s.weight as Weight } : {}), ...(Object.keys(on).length ? { on } : {}) }
  } catch {
    return {}
  }
}

async function saveSwitches($: $, scope: Scope, s: Switches): Promise<string | undefined> {
  const dir = await sentinelDir($, scope)
  if (!dir) return NO_HOME
  // The project's switches are committed with the code, so the folder's ignore file lets them through.
  if (scope === 'project') await $.fs.write(`${dir}/.gitignore`, IGNORE)
  await $.fs.write(`${dir}/library.json`, `${JSON.stringify(s, null, 2)}\n`)
  void after($)
}

// The Library as it stands: its flows and instructions, both switches files, the weight in force and what is on.
async function libraryNow($: $) {
  const { flows, instructions } = await loadLibrary($)
  const items = insItems(instructions)
  const project = await switches($, 'project')
  const personal = await switches($, 'personal')
  return { flows, items, project, personal, ...libraryOn([...items, ...flows], project, personal) }
}

// The Library as the dashboard reads it, kept for the snapshot as last read.
let librarySeen: LibraryView | undefined
async function libraryView($: $): Promise<LibraryView> {
  const l = await libraryNow($)
  return (librarySeen = {
    weight: l.weight, project: l.project, personal: l.personal,
    instructions: l.items.map(x => ({ ...x, on: l.on.includes(x.name) })),
    flowsOn: Object.fromEntries(l.flows.map(f => [f.name, l.on.includes(f.name)])),
  })
}

// The system prompt's section. While a plan runs: the always instructions it was locked with. Otherwise no plan is
// locked, so the Library as it is now gives its always and its draft instructions.
// ponytail: reads the Library's files on every render while no plan runs; cache them if that shows.
async function promptSection($: $): Promise<string> {
  const r = await read($, run)
  const running = isUnfinished(r)
  const told = running ? r.library?.told ?? [] : planLibrary(await libraryNow($)).told
  const at = (m: InstructionAt) => told.filter(x => x.at === m)
  return librarySection(at('always'), running ? [] : at('draft'))
}

// What a new plan is locked with: the weight, every item on, and the instructions on that Claude is told.
function planLibrary(l: { weight: Weight; on: string[]; items: Omit<LibraryItem, 'on'>[] }): PlanLibrary {
  const told = l.items.filter(x => x.kind === 'told' && l.on.includes(x.name))
  return { weight: l.weight, on: l.on, told: told.map(({ name, description, at, files, text }) => ({ name, ...(description ? { description } : {}), at, ...(files ? { files } : {}), text })) }
}

// A flow (it has states) or an instruction, saved to the project or the user's own folder, and trusted. A name serves
// one item across both kinds, so a name the other kind has is refused; an item of the same kind is replaced.
async function saveItem($: $, raw: unknown, scope: Scope): Promise<{ ok: boolean; text: string }> {
  const kind: Kind = raw && typeof raw === 'object' && 'text' in raw && !('states' in raw) ? 'instruction' : 'flow'
  const f = kind === 'flow' ? flowOf(raw) : instructionOf(raw)
  if (typeof f === 'string') return { ok: false, text: f }
  const { flows, instructions } = await loadLibrary($)
  if ((kind === 'flow' ? [...BUILTINS, ...instructions] : flows).some(x => x.name === f.name)) {
    return { ok: false, text: `${nameTaken(f.name, kind === 'flow' ? 'instruction' : 'flow')} Flows and instructions need names of their own.` }
  }
  const dir = await itemDir($, kind, scope)
  if (!dir) return { ok: false, text: NO_HOME }
  // Project items are committed with the code, so the folder's ignore file lets them through.
  if (scope === 'project') await $.fs.write(`${await $.session.root()}/.sentinel/.gitignore`, IGNORE)
  await $.fs.write(`${dir}/${f.name}.json`, `${JSON.stringify(f, null, 2)}\n`)
  await trust($, `${dir}/${f.name}.json`, f)
  await loadLibrary($)
  void after($)
  return { ok: true, text: `Saved the ${kind} "${f.name}" to ${shownDir(scope, kind)}/${f.name}.json.` }
}

// $.fs has no delete, so Node does it, as the dashboard needs Node anyway. The path goes in as an argument. A name
// serves one item, so the flow or the instruction of that name goes.
async function deleteItem($: $, name: string, scope: Scope): Promise<{ ok: boolean; text: string }> {
  for (const kind of ['flow', 'instruction'] as const) {
    const dir = await itemDir($, kind, scope)
    const file = `${dir}/${name}.json`
    if (!dir || !/^[a-z0-9][a-z0-9-]*$/.test(name) || !(await $.fs.exists(file).catch(() => false))) continue
    const ok = await $.process.run(['node', '-e', 'require("fs").rmSync(process.argv[1])', file], { timeoutMs: 10_000 }).then(x => x.exitCode === 0, () => false)
    if (ok) await trust($, file)
    await loadLibrary($)
    void after($)
    return ok ? { ok, text: `Deleted the ${kind} "${name}" from ${shownDir(scope, kind)}.` } : { ok, text: `Sentinel couldn't delete ${shownDir(scope, kind)}/${name}.json. Delete it by hand.` }
  }
  return { ok: false, text: `There is no ${scope} flow or instruction "${name}".` }
}

const scopeWords = (scope: Scope) => (scope === 'project' ? 'for this project' : 'in your default')
type Reply = { ok: boolean; text: string }
const no = (text: string): Reply => ({ ok: false, text })
const noItem = (name: string) => no(`There is no instruction or flow "${name}". /sentinel library lists them.`)

// /sentinel on|off <name> [personal]: one item's switch, for this project or as the user's default. null (the
// dashboard's reset) takes the switch out, so the item follows the weight and the other file again.
async function switchNow($: $, name: string, on: boolean | null, scope: Scope): Promise<Reply> {
  const l = await libraryNow($)
  const item = [...l.items, ...l.flows].find(x => x.name === name)
  if (!item) return noItem(name)
  const was = scope === 'project' ? l.project : l.personal
  const { [name]: _gone, ...rest } = was.on ?? {}
  const keep = on === null ? rest : { ...rest, [name]: on }
  const next: Switches = { ...(was.weight ? { weight: was.weight } : {}), ...(Object.keys(keep).length ? { on: keep } : {}) }
  const why = await saveSwitches($, scope, next)
  if (why) return no(why)
  const now = libraryOn([...l.items, ...l.flows], scope === 'project' ? next : l.project, scope === 'personal' ? next : l.personal).on.includes(name)
  if (on === null) return { ok: true, text: `${name} has no switch ${scopeWords(scope)} now, so it is ${now ? 'on' : 'off'}.` }
  const stays = now === on ? '' : item.trusted ? ` This project's switches decide it, so it stays ${now ? 'on' : 'off'}.` : ` It stays off until you trust it: /sentinel trust ${name}.`
  return { ok: true, text: `${name} is ${on ? 'on' : 'off'} ${scopeWords(scope)}.${stays}` }
}

// /sentinel weight light|standard|thorough [personal]. The weight decides that file's built-ins, so their switches go.
async function weightNow($: $, weight: string, scope: Scope): Promise<Reply> {
  if (!(WEIGHTS as readonly string[]).includes(weight)) return no('Use /sentinel weight light, standard or thorough, and personal after it for your default.')
  const l = await libraryNow($)
  const weighted = [...l.items, ...l.flows].filter(x => x.weights).map(x => x.name)
  const why = await saveSwitches($, scope, withWeight(scope === 'project' ? l.project : l.personal, weight as Weight, weighted))
  if (why) return no(why)
  const over = scope === 'personal' && l.project.weight ? ` This project picked ${l.project.weight}, which wins here.` : ''
  return { ok: true, text: `The weight is ${weight} ${scopeWords(scope)}.${over || ' The built-ins follow it; your own items keep their switches.'}` }
}

// /sentinel trust <name> (or flow trust <name>): a file Sentinel didn't save here, trusted as it is now.
async function trustNow($: $, name: string): Promise<Reply> {
  const { flows, instructions } = await loadLibrary($)
  const flow = flows.find(x => x.name === name)
  const found = flow ?? instructions.find(x => x.name === name)
  if (!found && !BUILTINS.some(b => b.name === name)) return noItem(name)
  if (!found || found.scope === 'built-in') return no(`${name} is built in, so there is nothing to trust.`)
  await trust($, found.file, defOf(found))
  const on = (await libraryNow($)).on.includes(name)
  void after($)
  const then = flow && on ? ` It adds itself ${ruleText(flow.when)}.` : ` It is ${on ? 'on' : `off: /sentinel on ${name} turns it on`}.`
  return { ok: true, text: `Trusted ${shownDir(found.scope, flow ? 'flow' : 'instruction')}/${name}.json as it is now.${then}` }
}

// The dashboard's "Also make it this project's default" at the lock: the project's switches set so the Library
// resolves to the plan's copy. Only the switches that differ from what the weight and the user's default give are kept.
async function keepAsProject($: $, pl: PlanLibrary): Promise<string | undefined> {
  const l = await libraryNow($)
  const all = [...l.items, ...l.flows]
  const base = libraryOn(all, { weight: pl.weight }, l.personal).on
  const on = Object.fromEntries(all.filter(x => base.includes(x.name) !== pl.on.includes(x.name)).map(x => [x.name, pl.on.includes(x.name)]))
  return saveSwitches($, 'project', { weight: pl.weight, ...(Object.keys(on).length ? { on } : {}) })
}

// A flow, or an instruction (text and at in place of states), the model drafted: held until the user saves or
// discards it.
async function draftFlow($: $, i: PlanInput, label: string): Promise<Result> {
  const kind: Kind = !i.states?.length && (i.text !== undefined || i.at !== undefined) ? 'instruction' : 'flow'
  const f = kind === 'instruction'
    ? instructionOf({ name: i.name, description: i.description, at: i.at, files: i.files, text: i.text })
    : flowOf({ name: i.name, description: i.description, when: i.when, states: i.states })
  if (typeof f === 'string') return record($, { deny: f }, { kind: 'plan', label, denied: true })
  const lib = await loadLibrary($).catch(() => undefined)
  const taken = ('states' in f ? lib?.flows : insItems(lib?.instructions ?? []))?.find(x => x.name === f.name)
  const asked = flowAsk
  flowAsk = undefined
  await change($, r => ({ ...r, flowDraft: { ...f, ...(asked ? { asked } : {}) } }))
  $.ui.toast(`Sentinel: Claude drafted the ${kind} "${f.name}". Save it from the band above the prompt`)
  const bare = 'states' in f ? f.states.filter(s => !s.check && !s.wait).map(s => s.id) : []
  const dir = DIRS[kind]
  return record($, {
    result: `Sentinel holds the ${kind} "${f.name}" for the user. They save it from the band above the prompt or the dashboard, to the project (.sentinel/${dir}) or their personal ${dir} (~/.sentinel/${dir})${taken ? `, where it replaces the ${taken.scope} ${kind} of that name` : ''}. Show it to them in your reply, then stop and wait.`
      + (bare.length ? ` ${bare.join(', ')} ${bare.length > 1 ? 'have' : 'has'} no check and no wait, so nothing would show ${bare.length > 1 ? 'they are' : 'it is'} done; say so.` : ''),
  }, { kind: 'plan', label })
}

// /sentinel library (or flows): the weight, then each instruction and flow with its switch.
async function libraryList($: $): Promise<string> {
  const v = await libraryView($)
  const mark = (on?: boolean) => (on ? 'on ' : 'off')
  const untrusted = (name: string) => ` Off until you trust it: Sentinel didn't save this file on this computer, or it changed since. Check it, then /sentinel trust ${name}.`
  const short = (t: string) => (t.length > 120 ? `${t.slice(0, 119)}…` : t)
  const from = v.project.weight ? 'set for this project' : v.personal.weight ? 'your default' : "Sentinel's default"
  return [
    `Weight: ${v.weight} (${from}).`,
    'Instructions:',
    ...v.instructions.map(x => `${mark(x.on)} ${x.name} (${x.scope}, ${x.at}): ${x.title ?? x.description ?? short(x.text)}${x.trusted ? '' : untrusted(x.name)}`),
    'Flows:',
    ...(flowsSeen ?? []).map(f => `${mark(v.flowsOn[f.name])} ${f.name} (${f.scope}): ${f.description ? `${f.description} ` : ''}States: ${f.states.map(x => x.id).join(', ')}. Adds itself ${ruleText(f.when)}.`
      + (f.when && !f.trusted ? untrusted(f.name) : '')),
    "Switch one with /sentinel on <name> or /sentinel off <name>, and pick a weight with /sentinel weight light, standard or thorough. Add personal to set your default instead of this project's. Add a flow to a draft with /sentinel add <flow> start, end, before <state> or after <state>.",
  ].join('\n') + (flowBad.length ? `\nNot read: ${flowBad.join('; ')}` : '')
}

// /sentinel add <flow> <where>, and Add here on the dashboard.
async function addNow($: $, raw: string): Promise<string> {
  const [name = '', at = '', state, ...more] = raw.split(/\s+/)
  const side = at === 'before' || at === 'after'
  if (!['start', 'end', 'before', 'after'].includes(at) || side !== !!state || more.length) return 'Use /sentinel add <flow> start, end, before <state> or after <state>.'
  const f = (await loadFlows($)).find(x => x.name === name)
  if (!f) return `There is no flow "${name}". /sentinel flows lists them.`
  const where = side ? `${at} ${state}` : `at the ${at}`
  return changeDraft($, held => addFlow(held, f, { at, state } as Where, `Added by you ${where}`), `Added ${name} ${where}.`)
}

// A change the user makes to the draft, without the model: Sentinel defines it again as it now stands. The checks of
// the states done before the lock passed when it was drafted, so they stand.
async function changeDraft($: $, edit: (held: PlanInput) => PlanInput | string, done: string): Promise<string> {
  const r = await read($, run)
  if (!r.draft || !r.held) return 'There is no draft. Flows go in while you check a draft, before you lock it.'
  const key = draftKey(r)
  const next = edit(r.held)
  if (typeof next === 'string') return next
  const proofs = Object.fromEntries(priorChecks(next).map(c => [c, { pass: true, sigText: '' }]))
  let why = ''
  await change($, x => {
    if (draftKey(x) !== key) return (why = 'The draft changed in the meantime. Try again.'), x
    const a = act(x, { ...next, action: 'define' }, now(), proofs, Date.now())
    if (!a.ok) why = a.text
    return a.ok ? a.run : x
  })
  return why || done
}

// /sentinel flow save project|personal, or discard: what to do with the flow Claude drafted.
async function flowCommand($: $, arg: string): Promise<string> {
  const f = (await read($, run)).flowDraft
  if (arg === 'discard') {
    if (!f) return 'No flow draft to discard.'
    await change($, x => ({ ...x, flowDraft: undefined }))
    return `Discarded the ${'states' in f ? 'flow' : 'instruction'} draft "${f.name}".`
  }
  const name = /^trust (\S+)$/.exec(arg)?.[1]
  if (name) return (await trustNow($, name)).text
  const scope = /^save (project|personal)$/.exec(arg)?.[1]
  if (!isScope(scope)) return 'Use /sentinel flow save project, /sentinel flow save personal, /sentinel flow trust <flow> or /sentinel flow discard.'
  return keepFlow($, scope)
}

async function keepFlow($: $, scope: Scope): Promise<string> {
  const f = (await read($, run)).flowDraft
  if (!f) return 'No flow draft to save. Ask Claude for a flow first.'
  const { asked: _asked, ...flow } = f
  const out = await saveItem($, flow, scope)
  if (out.ok) await change($, x => ({ ...x, flowDraft: undefined }))
  void after($)
  return out.text
}

// The state an agent works on as a member: its own, or its parent's for a helper a member started.
async function memberOf($: $, r: Run, agent: string): Promise<string | undefined> {
  const own = memberByAgent(r, agent)
  if (own || !Object.keys(r.running ?? {}).length) return own
  return memberByAgent(r, (await agents($)).find(a => a.id === agent)?.parentId)
}

// Parallel states: a ready state gets a worktree of the project as it is now, and one member agent working there.
async function brief($: $, i: PlanInput, label: string): Promise<Result> {
  const r = await read($, run)
  const why = briefRefusal(r, i, await parallelOn($))
  if (why) return record($, { deny: why }, { kind: 'plan', label, denied: true })
  const st = stateOf(r, i.to!.trim())!
  const wt = await worktree($, st.id)
  if ('deny' in wt) return record($, { deny: `Sentinel couldn't make a worktree for ${st.id}: ${wt.deny}` }, { kind: 'plan', label, denied: true })
  const spawned = await $.agent.spawn({ prompt: memberPrompt(r, st, wt.path, i.brief!.trim()), description: `member ${st.id}`, name: wt.name, cwd: wt.path })
    .catch((err: unknown) => ({ deny: err instanceof Error ? err.message : String(err), agentId: undefined }))
  // Core sets agentId. A spawn a hook answered carries none, and the list still finds the agent by its name.
  const agent = spawned.agentId ?? (spawned.deny === undefined ? (await agents($)).find(a => a.name === wt.name)?.id : undefined)
  if (!agent) {
    // Nothing was done in it yet, so the worktree goes.
    await $.process.run(['git', 'worktree', 'remove', '--force', wt.path], { cwd: await $.session.root() }).catch(() => undefined)
    const why = spawned.deny ?? 'no agent id'
    const full = /limit|too many|maximum/i.test(why)
    return record($, {
      deny: full
        ? `Sentinel couldn't start a member agent for ${st.id}: as many agents run as the session allows (${why}). Carry on with ${r.active}, and brief ${st.id} again once Sentinel says a member is in.`
        : `Sentinel couldn't start a member agent for ${st.id}: ${why}`,
    }, { kind: 'plan', label, denied: true })
  }
  await change($, x => startMember(x, st.id, { agent, name: wt.name }, now(), Date.now()))
  return record($, { result: `Started a member agent for ${st.id} in .claude/worktrees/${wt.name}/. Its answer comes back when it stops. Carry on with ${r.active}.` }, { kind: 'plan', label })
}

// The project as it is now, untracked files included, checked out under .claude/worktrees/.
async function worktree($: $, id: string): Promise<{ name: string; path: string } | { deny: string }> {
  const root = (await $.session.root()).replace(/\\/g, '/')
  const name = `sentinel-${id}-${Date.now().toString(36)}`
  const path = `${root}/.claude/worktrees/${name}`
  try {
    const commit = await snapTree($, root, name, `Sentinel: the project when ${id} became ready`)
    await git($, root, ['worktree', 'add', '--detach', path, commit])
    return { name, path }
  } catch (err) {
    return { deny: err instanceof Error ? err.message : String(err) }
  }
}

// The project as it is now, untracked files included, as a commit object on no branch. It is made through a separate
// index, .sentinel/<name>.index, so HEAD, the branches and the user's index stay as they are.
// ponytail: a fresh index hashes every file, and each member leaves its index file in .sentinel/; seed it from the real index if big repos get slow.
async function snapTree($: $, root: string, name: string, message: string): Promise<string> {
  const index = { GIT_INDEX_FILE: `${root}/.sentinel/${name}.index` }
  const who = { GIT_AUTHOR_NAME: 'Sentinel', GIT_AUTHOR_EMAIL: 'sentinel@localhost', GIT_COMMITTER_NAME: 'Sentinel', GIT_COMMITTER_EMAIL: 'sentinel@localhost' }
  await git($, root, ['read-tree', 'HEAD'], { env: index })
  await git($, root, ['add', '-A', '--', '.', ':(exclude).claude/worktrees'], { env: index })
  const tree = (await git($, root, ['write-tree'], { env: index })).trim()
  return (await git($, root, ['commit-tree', tree, '-p', 'HEAD', '-m', message], { env: who })).trim()
}

// fails-without-change: the project as the active state's visit begins, before its first edit, for the rerun at
// advance. A snapshot that fails is said once in the log, and that visit gets no rerun.
async function snapStart($: $): Promise<void> {
  const r = await read($, run)
  if (!snapWanted(r)) return
  const root = (await $.session.root()).replace(/\\/g, '/')
  const sha = await snapTree($, root, 'snap', `Sentinel: the project when ${r.active} started`).catch((err: unknown) => new Error(err instanceof Error ? err.message : String(err)))
  await change($, x => (x.active !== r.active || x.enteredAt !== r.enteredAt ? x
    : typeof sha === 'string' ? withSnap(x, sha)
    : withSnap({ ...x, log: [...x.log, { t: now(), icon: '!', tone: 'warn', text: `${r.active} · no snapshot for the rerun without the change: ${sha.message}` }] }, '')))
}

// fails-without-change: the state's check again, in a scratch worktree at the visit's snapshot with the visit's test
// changes copied in and its code changes left out. A fail there may only mean the copy lacks what git doesn't track,
// such as installed packages, so the check runs once more with the code changes copied in too: if it fails then as
// well, the copy can't run it and the rerun is skipped. The worktree goes once the checks have run.
// ponytail: files are copied as text; a binary fixture in a test folder would need git to carry it.
async function rerun($: $, check: string, id: string, w: { sha: string; tests: string[]; code: string[] }, signal?: AbortSignal): Promise<Without> {
  const root = (await $.session.root()).replace(/\\/g, '/')
  const path = `${root}/.claude/worktrees/sentinel-wo-${id}-${Date.now().toString(36)}`
  // The project's version of each file goes into the copy; a file deleted in the project goes from the copy too.
  const copy = async (files: string[]) => {
    for (const f of files) {
      if (await $.fs.exists(`${root}/${f}`)) await $.fs.write(`${path}/${f}`, String(await $.fs.read(`${root}/${f}`)))
      else await git($, path, ['rm', '-q', '--ignore-unmatch', '--', f])
    }
  }
  const run = async () => {
    const ran = await runCheck($, check, { dir: path, signal })
    return 'deny' in ran ? `Sentinel couldn't run the check there: ${ran.deny}` : ran.ended ? ran.pass : "the check didn't finish there"
  }
  try {
    await git($, root, ['worktree', 'add', '--detach', path, w.sha])
    await copy(w.tests)
    const without = await run()
    if (without !== false) return typeof without === 'string' ? { skipped: without } : { pass: true, tests: w.tests, code: w.code }
    await copy(w.code)
    const withIt = await run()
    if (withIt !== true) return { skipped: typeof withIt === 'string' ? withIt : "the check fails in the copy even with the change, so the copy can't run it (it may need files git doesn't track, such as installed packages)" }
    return { pass: false, tests: w.tests, code: w.code }
  } catch (err) {
    return { skipped: `Sentinel couldn't make the copy: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await $.process.run(['git', 'worktree', 'remove', '--force', path], { cwd: root }).catch(() => undefined)
  }
}

// git in `cwd`. A non-zero exit throws with what git said.
async function git($: $, cwd: string, args: string[], init: { env?: Record<string, string>; stdin?: string } = {}): Promise<string> {
  const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: 120_000, ...init })
  if (ran.exitCode !== 0) throw new Error(`git ${args[0]}: ${(ran.stderr || ran.stdout).trim()}`)
  return ran.stdout
}

// A member stopped: its state's check runs in its worktree, and a failure goes back to it, at most RETRIES times.
// A pass brings the state's files back as one staged diff, applied to the project with git apply. Nothing is committed.
// ended: the helper whose turn just ended, which the agent list may still show as working. overdue: the member's
// background work ran past HOLD_MS, so Sentinel no longer waits for it.
async function handBack($: $, id: string, answer: string, ended?: string, overdue = false) {
  const r = await read($, run)
  const m = r.running?.[id]
  const st = stateOf(r, id)
  if (!m || !st) return
  // Helpers the member started still work, or its background shells and monitors still run: its answer waits with the
  // member until the last helper is in, or until the member stops again once its background work wakes it. Background
  // work holds it for HOLD_MS at most; then the work is checked and brought back. The member's list stays until its
  // next stop, since a helper coming in or the timer reads it again.
  const bg = [...bgBy].filter(([, a]) => a === m.agent).map(([t]) => t)
  const held = overdue || !bg.length ? [] : holding((inFlight.get(m.agent)?.tasks ?? []).filter(t => bg.includes(t.id)))
  if (held.length || (await agents($)).some(a => a.parentId === m.agent && a.id !== ended && working(a))) {
    await change($, x => (x.running?.[id]?.agent === m.agent ? { ...x, running: { ...x.running, [id]: { ...x.running[id]!, answer } } } : x))
    if (held.length) {
      $.clock.after(Math.max(0, Math.max(...held.map(t => firstSeen.get(t.id)! + HOLD_MS)) - Date.now()) + 1000, () => void (async () => {
        const kept = (await read($, run)).running?.[id]
        if (kept?.agent !== m.agent || kept.answer === undefined) return
        // Woken by its work and busy again: its next stop brings it back.
        if ((await agents($)).find(a => a.id === m.agent)?.status === 'running') return
        await handBack($, id, kept.answer, undefined, true)
      })().catch(() => undefined))
    }
    return
  }
  // One bring-back at a time: the timer and the member's next stop can both get here.
  if (bringing.has(id)) return
  bringing.add(id)
  try {
    // A loop back can let the member go while its check runs. Its work then stays in its worktree.
    const mine = async () => (await read($, run)).running?.[id]?.agent === m.agent
    const root = (await $.session.root()).replace(/\\/g, '/')
    const path = `${root}/.claude/worktrees/${m.name}`
    // ponytail: fails-without-change doesn't rerun a member's check yet. Its worktree's base is the snapshot to start from.
    if (st.check) {
      const ran = await runCheck($, st.check, { dir: path })
      if (!(await mine())) return
      if ('deny' in ran || !ran.pass) {
        const why = 'deny' in ran ? `Sentinel couldn't run it: ${ran.deny}` : failSig(ran.text).sigText
        let retry: number | undefined
        await change($, x => {
          const out = memberFail(x, id, now(), Date.now())
          retry = out.retry
          return out.run
        })
        if (retry) {
          const tail = 'deny' in ran ? '' : `\n\n${tailOf(ran.text)}`
          const sent = await $.session.send({ to: { agentId: m.agent }, text: `${TAG} \`${st.check}\` fails in your worktree: ${why}${tail}\n\nFix it, then stop again. Retry ${retry} of ${RETRIES}.` })
            .then(x => x.isDelivered, () => false)
          if (sent) return
          await change($, x => memberOff(x, id, 'its agent could not be reached', now(), Date.now()))
          tell($, `${TAG} The member for ${id} has \`${st.check}\` failing (${why}), and Sentinel couldn't reach it to retry. Sentinel took ${id} off it, and its worktree stays at .claude/worktrees/${m.name}/. Brief ${id} again, or take it on yourself when it comes up.` )
        } else {
          tell($, `${TAG} The member for ${id} stopped ${RETRIES + 1} times with \`${st.check}\` failing: ${why}. Sentinel took ${id} off it, and its worktree stays at .claude/worktrees/${m.name}/ for a look. Brief ${id} again with what to change, or take it on yourself when it comes up.` )
        }
        return
      }
    }
    // Only the state's files come back. What else the member changed stays in its worktree, which is kept for a look.
    // Everything is staged, since git add refuses a glob that matches no file; the diff takes the state's files.
    const specs = st.files.map(g => `:(glob,icase)${g}`)
    let files: string[] = []
    let left: string[] = []
    try {
      await git($, path, ['add', '-A'])
      left = (await git($, path, ['diff', '--cached', '--name-only', 'HEAD'])).split('\n').map(f => f.trim()).filter(Boolean)
      if (specs.length) {
        const patch = await git($, path, ['diff', '--cached', '--binary', 'HEAD', '--', ...specs])
        if (!(await mine())) return
        if (patch.trim()) {
          // From here the project may hold the member's work.
          await change($, touched)
          await git($, root, ['apply', '--binary', '-'], { stdin: patch })
        }
        files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map(x => x[1]!)
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      await change($, x => (x.running?.[id]?.agent === m.agent ? memberOff(x, id, 'its work did not apply', now(), Date.now()) : x))
      tell($, `${TAG} The member for ${id} passed its check, but its work did not apply to the project: ${why}. Sentinel took ${id} off it, and its worktree stays at .claude/worktrees/${m.name}/. Brief ${id} again, or take it on yourself when it comes up.` )
      return
    }
    // A loop back can still let the member go while git apply runs. Its work is in the project then, on a reopened state.
    let landed: Run = r
    let late = false
    await change($, x => {
      late = x.running?.[id]?.agent !== m.agent
      // Either way the member's work is in the project now.
      return (landed = touched(late ? x : memberIn(x, id, answer, now(), Date.now())))
    })
    left = left.filter(f => !files.includes(f))
    if (!left.length) await $.process.run(['git', 'worktree', 'remove', '--force', path], { cwd: root }).catch(() => undefined)
    const kept = left.length
      ? `It also changed files outside ${id}'s list, which stay in its worktree at .claude/worktrees/${m.name}/: ${left.slice(0, 20).join(', ')}${left.length > 20 ? ` and ${left.length - 20} more` : ''}. Bring over what the plan needs (amend first), then remove the worktree with \`git worktree remove --force .claude/worktrees/${m.name}\`.`
      : undefined
    void after($)
    if (late) {
      if (files.length || kept) tell($, [files.length ? `${TAG} ${id} was reopened while Sentinel brought back its member's work, and that work reached the project anyway: ${files.join(', ')}. Look at those files before you build on them.` : TAG, kept].filter(Boolean).join(' ') )
      return
    }
    const what = files.length ? `Sentinel applied its changes to the project: ${files.join(', ')}.` : "It changed none of the state's files."
    const beside = (await parallelOn($)) ? besideNote(landed) : undefined
    const long = overdue ? `A background run the member started was still going after ${HOLD_MS / 60_000} minutes, so Sentinel brought its work back without waiting for it.` : undefined
    tell($, [`${TAG} ${id} is in: its member passed${st.check ? ` \`${st.check}\`` : ''} in its worktree. ${what}`, long, kept, beside, 'Continue with the plan.'].filter(Boolean).join('\n') )
  } finally {
    bringing.delete(id)
  }
}

function memberPrompt(r: Run, st: StateDef, path: string, brief: string): string {
  return [
    `You are a member agent of the plan "${r.plan!.title}". You do one state of it: ${st.id} (${st.label}).`,
    `Your brief from the main conversation:\n${brief}`,
    `Work in ${path}. It is a worktree of the project as it was when ${st.id} became ready, apart from the main checkout. Edit files there only, and only these: ${st.files.length ? st.files.join(', ') : 'none, this state edits nothing'}. Sentinel refuses other edits.`,
    st.check ? `${st.id} is done when \`${st.check}\` exits 0, run from ${path}.` : `${st.id} has no check: say what you found.`,
    st.ref ? `Details: ${st.ref}` : '',
    toldHere(r, st),
    'Make no commits and leave the branches alone. You may start helper agents; they meet the same limits. When you are done, stop and say what you did. Sentinel checks your work and brings it back to the project.',
  ].filter(Boolean).join('\n\n')
}

// Before any work in a state its check should fail. One that passes already proves nothing about that state. The run
// stops after START_CAP: one still going then tells nothing, so the state starts with no note. The visit's snapshot for
// fails-without-change is taken first.
async function atStart($: $): Promise<string | undefined> {
  await snapStart($)
  const was = await read($, run)
  const check = startCheck(was)
  if (!check) return undefined
  // The same command just passed with nothing touched since: the answer is known without a run.
  const ran = knownPass(was, was.calls.at(-1), check) ? { pass: true } : await runCheck($, check, { cap: START_CAP })
  let note: string | undefined
  await change($, r => {
    const out = recordStart(r, check, !('deny' in ran) && ran.pass, now())
    note = out.note
    return out.run
  })
  return note
}

// The Bash tool, with its permission check, from the project root (or a member's worktree): the run the model would make.
// The tool reports some non-zero exits as success (test, grep), so the exit code is echoed and read back.
const CHECK = 'Sentinel: run the state check'
// A check runs in the foreground for FG_MS, so a quick one answers the moment it ends. One still going then goes on in
// the background, and Sentinel reads its output file every POLL_MS. One that keeps printing gets WAIT_MS at most; past it
// the run is no result.
const FG_MS = 60_000
const POLL_MS = 10_000
const WAIT_MS = 60 * 60_000
const STOPPED = 'The user stopped this call before it finished. Nothing changed.'
// Whether a quiet check is slow or stuck can't be known for sure, so these limits guess, and a wrong guess costs a
// rerun: a check stopped as stuck never moves the plan. A check is stuck once it has run FIRST_MIN and been silent for
// QUIET_STUCK, or four times its longest quiet stretch in earlier runs of the same command when that is longer. It is
// quiet after QUIET_WARN of silence, or twice that stretch (WARN_FLOOR at least). History only ever gives more time: a
// command that ran from a cache in a second can build for minutes in silence. Output that ends in a prompt and stays
// PROMPT_MS, or four times that stretch, waits on input nobody gives: stuck at once. Sentinel never stops the same check twice in a row: the run after
// a stop goes on to its end (WAIT_MS at most), so a check that is only slow costs one stop, and its end teaches how
// quiet it gets.
const QUIET_WARN = 3 * 60_000
const QUIET_STUCK = 5 * 60_000
const FIRST_MIN = 10 * 60_000
const WARN_FLOOR = 60_000
const PROMPT_MS = 20_000
const PROMPT = /(password|passphrase)[^\n]*:\s*$|\(yes\/no[^)]*\)\?\s*$|\[y\/n\]\s*$|press any key[^\n]*$/i
const EXIT = /\[sentinel\] exit \d+/
// A check over LONG_MS gets the model a note on keeping checks to their state's own tests.
const LONG_MS = 60_000
const START_CAP = 60_000
const span = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)
const lastLine = (text: string) => text.trimEnd().split(/\r?\n/).at(-1)?.trim().slice(0, 160) ?? ''

// How each check ran before in this project, by command: its longest quiet stretch and its longest run, in ms, from
// the runs that ended; and stopped, when Sentinel stopped its last run as stuck. Kept in .sentinel/checks.json, so later
// plans start with it. took is kept for the user to read.
type Seen = Record<string, { gap?: number; took?: number; stopped?: true }>
const seenFile = async ($: $) => `${await $.session.root()}/.sentinel/checks.json`
const history = async ($: $): Promise<Seen> => $.fs.read(await seenFile($)).then(t => JSON.parse(String(t)) as Seen).catch(() => ({}))
// A run that ended clears the stop. Every write reads the file first, so runs at the same time keep each other's.
async function learn($: $, check: string, run: { gap: number; took: number } | 'stopped'): Promise<void> {
  const h = await history($)
  const was = h[check]
  h[check] = run === 'stopped' ? { ...was, stopped: true } : { gap: Math.max(run.gap, was?.gap ?? 0), took: Math.max(run.took, was?.took ?? 0) }
  await $.fs.write(await seenFile($), JSON.stringify(h)).catch(() => undefined)
}

// Why a check still running looks stuck, if it does. silent: since its output last grew; all: since it started.
function stuckWhy(text: string, silent: number, all: number, gap = 0): string | undefined {
  if (silent >= Math.max(PROMPT_MS, 4 * gap) && PROMPT.test(text.trimEnd())) return 'it waits on a prompt nobody can answer'
  if (all < FIRST_MIN || silent < Math.max(QUIET_STUCK, 4 * gap)) return undefined
  return `no output for ${span(silent)}${4 * gap > QUIET_STUCK ? `, where before it went quiet for ${span(gap)} at most` : ''}`
}

const stuckText = (c: string, ran: Ran) =>
  `Sentinel stopped \`${c}\` after ${span(ran.took)}: ${ran.stuck}. Its last output: ${lastLine(ran.text) || 'none'}\nNothing moved. Find out why it hangs, such as a prompt for input or a server it waits on, and fix the check or the code. If it is only slow, advance again: Sentinel never stops the same check twice in a row, so the next run goes on to its end, up to ${WAIT_MS / 60_000} minutes. Tell the user what you find.`

// One note per check, and none for the last state's: the full suite belongs there.
const slowSaid = new Set<string>()
function slowNote(r: Run, check: string, took: number): string | undefined {
  const last = r.plan?.states.at(-1)?.check
  if (took < LONG_MS || slowSaid.has(check) || (last && sameText(last, check))) return undefined
  slowSaid.add(check)
  return `${TAG} \`${check}\` took ${span(took)}. Sentinel runs each state's check at its advance, so slow checks slow the whole plan. `
    + `Keep each state's check to that state's own tests, changing one with action "amend" (check, reason) while its state is active, and leave the full suite to the last state. `
    + 'A check that prints as it goes, such as with a verbose test flag, lets Sentinel tell a slow check from a stuck one.'
}

// A hook's budget runs on through $.clock.sleep, ten seconds in all, and stands still through any other $ call. So
// Sentinel waits on a process that sleeps: sleep, or ping on Windows, which has none. Where neither runs, the clock
// waits, and the budget runs out after ten seconds of it.
async function nap($: $, ms: number): Promise<boolean> {
  const clock = () => $.clock.now().catch(() => Date.now())
  const win = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  const t = await clock()
  const argv = win ? ['ping', '-n', String(Math.round(ms / 1000) + 1), '127.0.0.1'] : ['sleep', String(ms / 1000)]
  await $.process.run(argv, { timeoutMs: ms + 30_000 }).catch(() => undefined)
  const left = ms - ((await clock()) - t)
  return left < ms / 2 ? true : $.clock.sleep(left).then(() => true, () => false)
}

// Sentinel's own check runs, whose notices that they ended stay away from the model.
const ownTasks = new Set<string>()

// The active state's check running now, for the status line, the band and the page. gone: it has ended.
async function showing($: $, c: Checking, gone?: true): Promise<void> {
  const same = (x: Checking) => x.at === c.at && x.label === c.label
  await change($, r => {
    const list = r.checking ?? []
    const next = gone ? list.filter(x => !same(x)) : list.some(same) ? list.map(x => (same(x) ? c : x)) : [...list, c]
    return { ...r, checking: next.length ? next : undefined }
  })
}

type Ran = { pass: boolean; text: string; ended: boolean; took: number; late?: true; stuck?: string }
// ended: false for a run cut short, stopped as stuck, stopped at its cap, or still going after WAIT_MS (late: no
// result). A stuck check of the active state turns the run red until a check runs again; a member's or a capped one
// doesn't.
async function runCheck($: $, check: string, o: { dir?: string; signal?: AbortSignal; cap?: number } = {}): Promise<{ deny: string } | Ran> {
  const quote = (p: string) => p.replace(/\\/g, '/').replace(/'/g, `'\\''`)
  const root = quote(o.dir ?? (await $.session.root()))
  // The engine's clock, which a test can move; the test kit has none unless a test mocks it.
  const clock = () => $.clock.now().catch(() => Date.now())
  const t0 = await clock()
  const ids = (await read($, run)).plan?.states.filter(s => s.check && sameText(s.check, check)).map(s => s.id) ?? []
  let shown: Checking = { label: check, ids, at: t0, ms: 0 }
  if (!o.dir) {
    await change($, r => (r.hung ? { ...r, hung: undefined } : r))
    await showing($, shown)
  }
  try {
    // The subshell keeps the model's shell where it was; the tool may append notes after the echo.
    const ran = await $.tool.call({ tool: 'Bash', command: `(cd '${root}' && ${check}); echo "[sentinel] exit $?"`, timeout: Math.min(o.cap ?? FG_MS, FG_MS), description: CHECK })
      .catch((err: unknown) => ({ deny: err instanceof Error ? err.message : String(err) }) as Result)
    if (ran.deny !== undefined) return { deny: ran.deny }
    const task = (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId
    const file = task ? /written to: (.+?\.output)/.exec(ran.text ?? '')?.[1] : undefined
    const cut = !!(ran.result as { interrupted?: boolean } | undefined)?.interrupted
    if (task) ownTasks.add(task)
    // Without a file to read, the tool's answer is all there is.
    let text = file ? '' : ran.text ?? ''
    let stuck: string | undefined
    let capped = false
    let now = await clock()
    // The longest silence, counted from the first read: what the foreground part printed when is not known.
    let gap = 0
    if (file && !cut) {
      const seen = (await history($))[check]
      let heard = now
      let tailed = -Infinity
      for (let first = true; ; first = false) {
        if (!first && !(await nap($, POLL_MS))) break
        now = await clock()
        // ponytail: over 4 MiB the file can't be read whole, so its end comes from tail, every 30 s at most.
        const out = await $.fs.read(file).then(String, async () => {
          if (now - tailed < 30_000) return undefined
          tailed = now
          return (await $.tool.call({ tool: 'Bash', command: `tail -c 100000 '${quote(file)}'`, description: CHECK }).catch(() => undefined))?.text
        })
        if (out !== undefined && out !== text) {
          if (!first) gap = Math.max(gap, now - heard)
          heard = now
          text = out
        }
        if (EXIT.test(text) || o.signal?.aborted) break
        if (o.cap && now - t0 >= o.cap) {
          capped = true
          break
        }
        if (!seen?.stopped) stuck = stuckWhy(text, now - heard, now - t0, seen?.gap)
        if (stuck || now - t0 >= WAIT_MS) break
        const quiet = now - heard >= Math.max(seen?.gap === undefined ? QUIET_WARN : WARN_FLOOR, 2 * (seen?.gap ?? 0))
        // The page counts the time itself; the status line and the band hear each minute, and when it turns quiet.
        if (!o.dir && (quiet !== !!shown.quiet || Math.floor((now - t0) / 60_000) !== Math.floor(shown.ms / 60_000))) {
          const { quiet: _, ...rest } = shown
          shown = { ...rest, ms: now - t0, ...(quiet && { quiet: true as const }) }
          await showing($, shown)
        }
      }
    }
    const end = [...text.matchAll(/\[sentinel\] exit (\d+)/g)].at(-1)
    if (end) await learn($, check, { gap, took: now - t0 })
    if (stuck) await learn($, check, 'stopped')
    // A run that was stopped, is stuck, reached its cap or is still going after WAIT_MS stops in the background too.
    if (task && !end) void $.tool.call({ tool: 'TaskStop', task_id: task }).catch(() => undefined)
    if (stuck && !o.dir && !o.cap) {
      const why = `${stuck}. Its last output: ${lastLine(text) || 'none'}`
      await change($, r => (r.active && r.active !== 'done' ? { ...r, hung: { state: r.active, check, step: r.step, text: why } } : r))
    }
    return {
      pass: end?.[1] === '0', ended: !!end, took: now - t0, text: end ? text.slice(0, text.lastIndexOf(end[0]) + end[0].length) : text,
      ...(task && !end && !cut && !stuck && !capped && !o.signal?.aborted && { late: true as const }), ...(stuck && { stuck }),
    }
  } finally {
    if (!o.dir) await showing($, shown, true)
  }
}

// Before the plan completes, the done states' checks run again on the project as it is now, LANES at a time, shown on
// the band, the status line and the page. A pass from earlier final checks holds while nothing has changed since. A
// fail runs once more, unless the first run took over SLOW_MS. A refused run counts as no result, and so does a late
// one, which the completion names. One cut short, as by Esc, or stopped as stuck stops them: cut names it, stuck says why.
// ponytail: two at a time, since a test suite like go test already spreads over every core.
const LANES = 2
const SLOW_MS = 2 * 60_000
async function finalChecks($: $, checks: string[], proofs: Proofs, signal?: AbortSignal): Promise<{ cut?: string; stuck?: string; late: string[] }> {
  const base = await read($, run)
  const ids = (c: string) => base.plan!.states.filter(s => s.check && sameText(s.check, c)).map(s => s.id)
  const queue: string[] = []
  for (const c of checks) {
    if (sweptPass(base, c)) proofs[c] = { pass: true, sigText: '' }
    else queue.push(c)
  }
  const late: string[] = []
  let cut: string | undefined
  let stuck: string | undefined
  let over = false
  const show = async (f: (s: NonNullable<Run['sweep']>) => NonNullable<Run['sweep']>) => {
    if (over) return
    await change($, x => (x.sweep ? { ...x, sweep: f(x.sweep) } : x))
  }
  await change($, x => ({ ...x, sweep: { going: [], passed: checks.length - queue.length, failed: 0, total: checks.length } }))
  const lane = async () => {
    for (let c = queue.shift(); c !== undefined && !cut && !signal?.aborted; c = queue.shift()) {
      const who = ids(c)
      await show(s => ({ ...s, going: [...s.going, ...who] }))
      let ran = await runCheck($, c, { signal })
      if (!('deny' in ran) && ran.ended && !ran.pass && !signal?.aborted && ran.took < SLOW_MS) ran = await runCheck($, c, { signal })
      const pass = 'deny' in ran || !ran.ended ? undefined : ran.pass
      await show(s => ({ ...s, going: s.going.filter(g => !who.includes(g)), passed: s.passed + (pass === true ? 1 : 0), failed: s.failed + (pass === false ? 1 : 0) }))
      if ('deny' in ran) continue
      if (!ran.ended) {
        if (ran.late) late.push(c)
        else if (!cut) [cut, stuck] = [c, ran.stuck]
        continue
      }
      proofs[c] = { pass: ran.pass, sigText: failSig(ran.text).sigText }
      if (ran.pass) await change($, x => ({ ...x, swept: { ...x.swept, [c]: { step: base.step, touches: base.touches ?? 0 } } }))
    }
  }
  // Esc ends the wait at once; the runs under way end with it, or stop in the background.
  const stop = new Promise<void>(res => signal?.addEventListener('abort', () => res(), { once: true }))
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(LANES, queue.length) }, lane)), stop])
  } finally {
    over = true
    await change($, x => ({ ...x, sweep: undefined }))
  }
  return { cut, stuck, late }
}

const passed = (ran: Result) =>
  ran.isError !== true && !/^Exit code [1-9]/.test(ran.text ?? '') && !(ran.result as { returnCodeInterpretation?: string } | undefined)?.returnCodeInterpretation
// A run cut short or sent to the background has no result yet, so it counts as a look.
const unfinished = (ran: Result) => {
  const out = ran.result as { interrupted?: boolean; backgroundTaskId?: string } | undefined
  return !!(out?.interrupted || out?.backgroundTaskId)
}
const dirKey = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()

async function signOff($: $, ran: Result): Promise<Result> {
  if (ran.isError || ran.deny !== undefined) return ran
  // The approved plan may differ from a define kept from before, so the model sends it again.
  await change($, r => ({ ...r, ...freshCount(r, new Date().toISOString()), signedOff: true, review: false, held: undefined }))
  const note = `${TAG} The user approved this plan. Before editing anything, call ${TOOL} with action "define": the states in order, each with the check command that proves it done and the files it may edit, a plain title, problem and approach for the user's task page, plus the loops you expect. Then work through it without asking about choices that aren't breaking.`
  return { ...ran, context: [...(ran.context ?? []), note] } as Result
}

// A helper agent's call goes in its lane, outside the ledger and the health window. The lane takes its name from the agent's description.
async function lane($: $, r: Run, id: string, call: { label: string; file?: string }) {
  const name = r.lanes?.find(l => l.id === id)?.name ?? (await agents($)).find(a => a.id === id)?.description ?? ''
  await change($, x => laneCall(x, id, name, call))
}

// Adds the call to the ledger; a recovery note, when the detector raises one, rides on the result.
const record = async ($: $, ran: Result, o: Observed) => attach(attach(ran, await track($, o)), takeHint())

async function track($: $, o: Observed): Promise<string | undefined> {
  let note: string | undefined
  let first = false
  let where = ''
  await change($, r => {
    // Any check run clears one stopped as stuck.
    const out = observe(o.kind === 'check' && r.hung ? { ...r, hung: undefined } : r, o, now())
    note = out.note
    first = out.trapped?.notes === 1
    where = out.trapped ? `${out.trapped.pattern} in ${out.trapped.state}` : ''
    return out.run
  })
  if (first) $.ui.toast(`Sentinel: stuck (${where}). Recovery note sent.`)
  void after($)
  return note
}

function attach(ran: Result, note: string | undefined): Result {
  if (!note) return ran
  if (ran.deny !== undefined) return { deny: `${ran.deny}\n\n${note}` }
  return { ...ran, context: [...(ran.context ?? []), note] } as Result
}

// Never throws: it runs after the response has gone on its way.
function spent($: $, u: Parameters<typeof addSpend>[1], effort: unknown, sub: boolean) {
  void change($, r => addSpend(r, u, effort === undefined ? undefined : String(effort), sub, new Date().toISOString()))
    .then(() => after($)).catch(() => undefined)
}

// .sentinel/ holds Sentinel's run files, kept out of git, and the project's Library (flows, instructions and switches),
// committed with the code.
const IGNORE = '*\n!flows/\n!flows/*.json\n!instructions/\n!instructions/*.json\n!library.json\n'

let writing: Promise<void> = Promise.resolve()
let ignored = false

// Whether the main conversation works now: in a turn with no question of its up, or between turns while background
// work it started runs.
let questionsUp = 0
let backBusy = false
const atWork = () => (turning && questionsUp === 0) || backBusy

// Every change to the run goes through here, so the page, the status line and the task clock always follow it.
async function change($: $, fn: (r: Run) => Run) {
  await update($, run, fn)
  void after($)
}

// Status line, plus the snapshot the browser page polls. This is where the task clock follows its one rule (clocked).
// A write already waiting to start reads the run as it is then, so a second call before it starts adds nothing.
let queued = false
function after($: $): Promise<void> {
  if (queued) return writing
  queued = true
  writing = writing
    .then(async () => {
      queued = false
      await update($, run, x => clocked(x, atWork()))
      const r = await read($, run)
      $.ui.status(statusText(r))
      // With the dashboard up, a question shows there even before there is a plan.
      if (!r.plan && !r.draft && !serving) return
      const dir = `${await $.session.root()}/.sentinel`
      if (!ignored) await $.fs.write(`${dir}/.gitignore`, IGNORE)
      ignored = true
      // ponytail: reads the Library's files on every write while the dashboard is up, so edits made outside Sentinel
      // show; watch the folders if that shows.
      if (serving) await libraryView($).catch(() => undefined)
      await $.fs.write(`${dir}/state.js`, snapshot(r, parallelSeen ?? (await parallelOn($))))
      // Only a plan is saved for /sentinel resume, so a draft never replaces an earlier session's plan.
      if (r.plan) await $.fs.write(`${dir}/run.json`, JSON.stringify({ ...r, sweep: undefined, checking: undefined, savedAt: Date.now() }))
    })
    .catch(() => undefined)
  return writing
}

function snapshot(r: Run, parallel: boolean): string {
  // savedAt lets the page tell a live snapshot from one a closed session left behind. The open question and the last
  // answer come from memory. The page sends the draft's key back with Lock. The token never goes in.
  // Of each member, only what the page draws goes out: its kept answer can be long, and this file is written on every call.
  const members = Object.fromEntries(Object.entries(r.running ?? {}).map(([id, m]) => [id, { agent: m.agent, since: m.since }]))
  const flows = (flowsSeen ?? []).map(({ file: _file, ...f }) => ({ ...f, ...(f.scope === 'built-in' ? {} : { file: `${shownDir(f.scope)}/${f.name}.json` }) }))
  const extra = { savedAt: Date.now(), ask: asking, answered, draftKey: draftKey(r), parallel, members, flows, flowSaid, library: librarySeen, draftLibrary: r.draft?.library }
  return `window.__sentinel && window.__sentinel(${JSON.stringify({ ...summarize(r), ...extra })})\n`
}

function statusText(r: Run): string | undefined {
  // The engine puts the plugin's name in front of this line.
  if (r.draft) return 'draft waiting · /sentinel to review it'
  if (!r.plan) return r.signedOff ? 'signed off' : undefined
  if (r.active === 'done') return 'plan complete'
  if (r.sweep) return `final checks · ${sweepLine(r.sweep)}`
  const st = stateOf(r)
  const ids = r.plan.states.map(s => s.id)
  const last = r.calls.at(-1)
  const trap = openTrap(r)
  const h = last && last.step > r.enteredAt ? ` · H ${last.H.toFixed(2)} ${healthWord(last.H)}` : ''
  const going = r.checking?.at(-1)
  const tail = r.paused ? ' · paused' : trap ? ` · stuck (${trap.pattern})` : r.hung?.state === r.active ? ' · stuck (a check hung)' : going ? ` · ${checkLine(going)}` : h
  return `${st?.id} ${ids.indexOf(st?.id ?? '') + 1}/${ids.length + 1}${tail}`
}

async function openBrowser($: $): Promise<string> {
  await libraryView($).catch(() => undefined)
  const dir = `${await $.session.root()}/.sentinel`
  await $.fs.write(`${dir}/.gitignore`, IGNORE)
  await $.fs.write(`${dir}/state.js`, snapshot(await read($, run), await parallelOn($)))
  // The helper gets 3 s to start, since the wait counts against this hook's own time. Without it the page opens as a file.
  const url = await Promise.race([serve($), $.clock.sleep(3000).then(() => undefined)])
  const file = `${dir}/view.html`
  if (!url) await $.fs.write(file, String(await $.fs.read(`${$.plugin.root}/web/view.html`)))
  const target = url ?? file
  const openers = [['cmd', '/c', 'start', '', url ?? file.replace(/\//g, '\\')], ['open', target], ['xdg-open', target]]
  for (const argv of openers) {
    const ok = await $.process.run(argv, { timeoutMs: 10_000 }).then(x => x.exitCode === 0, () => false)
    if (ok) break
  }
  // The address carries the session's token, and the model reads this reply, so it names no address.
  return url ? 'Opened the dashboard in your browser. You can answer Sentinel there as well.' : `Opened ${file}. Answering from the browser needs Node.js on PATH.`
}

// ---- answers from the dashboard ----

// The dashboard's helper (web/serve.mjs, plain Node) serves the page and passes on what the user sends from it, one JSON
// line each. It starts on the first /sentinel browser, from a timer so it outlives the dispatch that asked for it, and
// ends with the module.
// ponytail: the token rides in the page's address, so it stays in the browser's history; trade it for an HttpOnly
// cookie if the model reading that history becomes a concern.
let served: Promise<string | undefined> | undefined
let serving = false
// The question the page shows (its id comes back with the answer), and the last answer with where it was given.
type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
let asking: { id: string; questions: Question[]; t: string; state?: string } | undefined
let answered: { q: string; ans: string; by: 'chat' | 'browser'; t: string; state?: string } | undefined
const waiting = new Map<string, (answers: unknown) => void>()
let asks = 0
// The page's other messages are handled one at a time, so a doubled one sees the first one's effect.
let inbox: Promise<unknown> = Promise.resolve()
const draftKey = (r: Run) => (r.draft ? fnv(JSON.stringify(r.draft)) : undefined)
// A hint from the page rides on the next tool result while the model works, or starts a turn once it has stopped.
let hint: string | undefined
let turning = false
const takeHint = () => {
  const h = hint
  hint = undefined
  return h
}

function serve($: $): Promise<string | undefined> {
  return (served ??= new Promise(ready => {
    $.clock.after(0, () => void (async () => {
      try {
        const root = await $.session.root()
        const child = $.process.spawn({
          argv: ['node', `${$.plugin.root}/web/serve.mjs`],
          env: { SENTINEL_PAGE: `${$.plugin.root}/web/view.html`, SENTINEL_STATE: `${root}/.sentinel/state.js`, SENTINEL_PORT: String(41000 + (parseInt(fnv(root), 16) % 1000)) },
        })
        // The output comes in pieces, and a line may span two.
        let buf = ''
        for await (const { stream, text } of child) {
          if (stream !== 'stdout') continue
          buf += text
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const m = parse(buf.slice(0, i))
            buf = buf.slice(i + 1)
            if (typeof m?.port === 'number' && /^[0-9a-f]{32}$/.test(String(m.token))) {
              serving = true
              void after($)
              ready(`http://127.0.0.1:${m.port}/?k=${m.token}`)
            } else if (m?.kind === 'ask') waiting.get(String(m.id))?.(m.answers)
            else if (m) inbox = inbox.then(() => fromPage($, m)).catch(() => undefined)
          }
        }
      } catch {
        // No Node on PATH, or the helper failed.
      }
      serving = false
      served = undefined
      ready(undefined)
    })())
  }))
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const m: unknown = JSON.parse(line)
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// What the user sent from the page. It must still fit the run as it stands, so a stale or doubled answer (a second tab,
// a second click, a draft revised since the page showed it) is dropped. A prompt waits for the running turn, so it is
// sent without holding up the messages behind it.
async function fromPage($: $, m: Record<string, unknown>) {
  const text = typeof m.text === 'string' ? m.text.trim().slice(0, 2000) : ''
  const r = await read($, run)
  // The page has no other place for what goes wrong with the draft, so it shows in the terminal.
  const toast = (t: string) => void $.ui.toast(`Sentinel: ${t}`)
  if (m.kind === 'lock' && r.draft && m.draft === draftKey(r)) {
    const pl = r.draft.library
    const out = await lockNow($, Array.isArray(m.picked) ? m.picked.filter((x): x is string => typeof x === 'string') : [])
    if (!out.startsWith('Locked')) return toast(out)
    const why = m.keep === 'project' && pl ? await keepAsProject($, pl) : undefined
    return why ? toast(why) : undefined
  }
  // The plan's copy of the Library, changed from the draft card. Only items that are trusted go on, and what Claude is
  // told comes from the Library as it is now.
  if (m.kind === 'libplan' && r.draft && m.draft === draftKey(r) && WEIGHTS.includes(m.weight as Weight) && Array.isArray(m.on)) {
    const l = await libraryNow($)
    const on = [...l.items, ...l.flows].filter(x => x.trusted && (m.on as unknown[]).includes(x.name)).map(x => x.name)
    const why = await changeDraft($, held => ({ ...held, library: planLibrary({ weight: m.weight as Weight, on, items: l.items }) }), '')
    return why ? toast(why) : undefined
  }
  if (m.kind === 'draft' && r.draft && text) {
    return tell($, `${TAG} The user checked the draft in the dashboard and asks for changes: ${text}\nCall ${TOOL} with action "revise", then stop for their check.`)
  }
  if (m.kind === 'resume' && r.paused) return void (await resume($))
  // Flows: the draft's flows (dropped when the draft changed since the page showed it), and the saved ones.
  const flowReply = (out: { ok: boolean; text: string }) => void ((flowSaid = { at: Date.now(), ...out }), after($))
  if ((m.kind === 'addflow' || m.kind === 'dropflow') && r.draft && m.draft === draftKey(r)) {
    const out = m.kind === 'addflow'
      ? await addNow($, [m.name, m.at, m.state].filter(x => typeof x === 'string' && x).join(' '))
      : await changeDraft($, held => dropFlow(held, String(m.as)), 'Taken out.')
    if (!/^(Added|Taken)/.test(out)) flowReply({ ok: false, text: out })
    return
  }
  // The Library's switches, weight and trust.
  if (m.kind === 'libon' && typeof m.name === 'string' && isScope(m.scope) && (typeof m.on === 'boolean' || m.on === null)) return flowReply(await switchNow($, m.name, m.on, m.scope))
  if (m.kind === 'libweight' && typeof m.weight === 'string' && isScope(m.scope)) return flowReply(await weightNow($, m.weight, m.scope))
  if (m.kind === 'libtrust' && typeof m.name === 'string') return flowReply(await trustNow($, m.name))
  // A flow or an instruction (saveItem tells them apart by shape).
  if (m.kind === 'saveflow' && isScope(m.scope)) {
    const out = await saveItem($, m.flow, m.scope)
    const was = m.was as { name?: unknown; scope?: unknown } | undefined
    const name = (m.flow as { name?: unknown } | undefined)?.name
    // A rename or a move: the old file goes once the new one is in.
    if (out.ok && typeof was?.name === 'string' && isScope(was.scope) && (was.name !== name || was.scope !== m.scope)) await deleteItem($, was.name, was.scope)
    if (out.ok && m.fromDraft === true) await change($, x => ({ ...x, flowDraft: undefined }))
    return flowReply(out)
  }
  if (m.kind === 'delflow' && typeof m.name === 'string' && isScope(m.scope)) return flowReply(await deleteItem($, m.name, m.scope))
  if (m.kind === 'flowdiscard' && r.flowDraft) return flowReply({ ok: true, text: await flowCommand($, 'discard') })
  if (m.kind === 'askflow' && text) {
    flowAsk = text
    return tell($, m.item === 'instruction'
      ? `${TAG} The user asks for an instruction from the dashboard: ${text}\nDraft it with ${TOOL} action "flow": name, description, "at" (draft, start, close, final or always), "text", and "files" only for start or close. Then stop: they check it and save it.`
      : `${TAG} The user asks for a flow from the dashboard: ${text}\nDraft it with ${TOOL} action "flow": name, description, states, and "when" only if they want it added to new plans by itself. Then stop: they check it and save it.`)
  }
  if (m.kind === 'flowchg' && r.flowDraft && text) {
    flowAsk = r.flowDraft.asked
    const kind = 'states' in r.flowDraft ? 'flow' : 'instruction'
    return tell($, `${TAG} The user asks for changes to the ${kind} "${r.flowDraft.name}" from the dashboard: ${text}\nSend the whole ${kind} again with ${TOOL} action "flow", then stop.`)
  }
  // Skip from any task's page.
  if (m.kind === 'skip' && isLive(r) && typeof m.state === 'string') return void (await skipNow($, `${m.state} ${text}`))
  const st = stateOf(r)
  if (!isLive(r) || !st || st.id !== m.state) return
  if (m.kind === 'pause') return void (await pause($))
  if (m.kind === 'ahead' && typeof m.on === 'boolean') return void (await setFree($, m.on))
  if (m.kind === 'hint' && text && (openTrap(r) ?? (r.hung?.state === st.id ? r.hung : undefined))?.step === m.trap) {
    await change($, x => heard(x, Date.now()))
    const h = `${TAG} The user sent a hint from the dashboard about ${st.id}: ${text}`
    if (turning) hint = hint ? `${hint}\n${h}` : h
    else tell($, h)
    return
  }
  // Only what the state asked and the user hasn't answered: a proposal, or finished work.
  const p = pendingOf(r)
  if (!p || settled(r) || !(m.kind === 'approve' || (m.kind === 'changes' && text))) return
  const what = p.kind === 'before' ? 'proposal' : 'work'
  const said = m.kind === 'approve' ? `Approved the ${what} from the dashboard.` : `Asked for changes to the ${what} from the dashboard: ${text}`
  // Asking for changes is no OK: the request is dropped, so the model proposes again, or its next advance asks again.
  await change($, was => {
    const x = m.kind === 'approve' && m.all === true ? handsFree(was, true, now()) : was
    return {
      ...(m.kind === 'approve' ? heard(x, Date.now()) : { ...x, pending: undefined, auto: 0 }),
      audit: [...x.audit, { step: x.step, t: now(), state: st.id, kind: 'decided' as const, text: said }],
      log: [...x.log, { t: now(), icon: m.kind === 'approve' ? '✓' : '?', tone: m.kind === 'approve' ? ('ok' as const) : ('ask' as const), text: `${st.id} · ${m.kind === 'approve' ? 'approved' : 'changes asked'}` }],
    }
  })
  tell($, m.kind === 'approve'
    ? `${TAG} The user approved your ${what} for ${st.id} from the dashboard. ${p.kind === 'before' ? 'Go ahead with it.' : 'Call advance again.'}${m.all === true ? ` ${HANDS_FREE}` : ''}`
    : `${TAG} The user asks for changes to your ${what} for ${st.id} from the dashboard: ${text}${p.kind === 'before' ? '\nPropose again once you have changed it.' : '\nMake them, then advance again.'}`)
}

// An answer of the main conversation's question counts as the user's word, as a typed prompt does.
// ponytail: any answer counts, even to a question about something else; tie it to the question if that misleads.
async function ask($: $, e: Args<'tool.call'>, next: Next<'tool.call'>, q = ''): Promise<[Result, string]> {
  const main = e.agentId === undefined
  if (main) {
    questionsUp++
    void after($)
  }
  const out = await asked($, e, next, q).finally(() => {
    if (!main) return
    questionsUp--
    void after($)
  })
  const answers = (out[0].result as { answers?: Record<string, unknown> } | undefined)?.answers
  if (e.agentId === undefined && answers && Object.values(answers).some(v => typeof v === 'string' && v.trim())) {
    await userSpoke($)
  }
  return out
}

// A question from the main conversation shows on the page too while it's up. The first answer counts: the dialog's, or
// the page's, which closes the dialog. Never throws on its own account, since the hook's catch would ask again.
// Returns the result and the ledger's label, which carries the answer.
async function asked($: $, e: Args<'tool.call'>, next: Next<'tool.call'>, q: string): Promise<[Result, string]> {
  if (!serving || e.agentId !== undefined) return [await next(e), q]
  const sent = (e as unknown as { questions?: Question[] }).questions ?? []
  const questions = sent.map(x => ({ question: x.question, header: x.header, multiSelect: x.multiSelect, options: (x.options ?? []).map(o => ({ label: o.label, description: o.description })) }))
  const id = String(++asks)
  const state = (await read($, run)).active ?? undefined
  const fromPage = new Promise<Record<string, string>>(ok => waiting.set(id, a => {
    const v = answersOf(a, questions)
    if (v) ok(v)
  }))
  asking = { id, questions, t: now(), state }
  void after($)
  const dialog = next(e)
  // Once the page has answered, the dialog closes, and what its call does then doesn't matter.
  dialog.catch(() => undefined)
  try {
    const won = await Promise.race([dialog.then(ran => ({ ran })), fromPage.then(answers => ({ answers }))])
    const by = 'answers' in won ? 'browser' : 'chat'
    const answers = 'answers' in won ? won.answers : (won.ran as { result?: { answers?: Record<string, string> } }).result?.answers
    const said = answers && typeof answers === 'object' ? Object.values(answers).join('; ') : ''
    if (said) answered = { q: questions.length > 1 ? `${questions.length} questions from Claude` : (questions[0]?.question ?? q), ans: said, by, t: now(), state }
    const ran = 'answers' in won ? ({ result: { questions: sent, answers: won.answers } } as Result) : won.ran
    return [ran, said ? `${q} You: ${said}, in the ${by}.` : q]
  } finally {
    waiting.delete(id)
    asking = undefined
    void after($)
  }
}

// The page's answers: one non-empty string for each question, keyed by its text. Anything else is dropped.
function answersOf(a: unknown, questions: Question[]): Record<string, string> | undefined {
  if (!a || typeof a !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const { question } of questions) {
    const v = (a as Record<string, unknown>)[question]
    if (typeof v !== 'string' || !v.trim()) return undefined
    out[question] = v.trim().slice(0, 2000)
  }
  return out
}

async function hashOf($: $, file: string): Promise<string | undefined> {
  return $.fs.read(file).then(text => fnv(String(text)), () => undefined)
}

function lookLabel(tool: string, input: Record<string, unknown>): string {
  const pick = input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.path ?? ''
  const text = String(pick).replace(/\\/g, '/').split('/').slice(-2).join('/')
  return `${tool} ${text}`.trim().slice(0, 80)
}

function stable(input: Record<string, unknown>): string {
  const { tool: _t, tool_use_id: _id, consent: _c, description: _d, ...rest } = input
  return JSON.stringify(rest, Object.keys(rest).sort())
}

# Sentinel

Sentinel is a Claude Code plugin that holds the plan you approved as a state machine and checks Claude's work against it, tool call by tool call. You follow the run in a band above the prompt, a pane, or a live page in your browser.

![Claude works through a plan while the Sentinel dashboard follows each step](docs/media/run.webp)

On a long task, an agent can drift from the plan, edit files nobody agreed to, say a step is done without proving it, or go round in circles. Sentinel catches each of these as it happens and tells Claude what to do instead. Its Library sets how much testing each plan asks for, from quick checks to proof that a test fails without the change. It adds no model calls: every rule is a hook on a tool call. It is a cut-down version of the belief-state idea in "Beyond Memory: Harnessing Long-Horizon Agents with Explicit Belief States" (arXiv 2610.01415).

## How a run goes

You approve a plan in plan mode, or agree on one in the chat and type `/sentinel lock`. Claude declares it as states. Each state names the files it may edit and a check command that exits 0 when the state is done. From then on:

- **Edits stay in scope.** An edit to a file outside the active state's files is refused. Claude can widen the scope with `amend` and a reason, and every amendment is logged.
- **Moving on takes proof.** `advance` runs the state's check from the project root, through the Bash tool and your permission rules, and moves on only when it exits 0. A refusal carries the end of the check's output, so Claude can fix the failure without running the check again to read it. A state without a check needs evidence. While it drafts, Claude is told to give each state the fastest check that proves its own work and to run the whole suite once, in the last state (the `fast-checks` built-in).
- **A check has to be able to fail.** When a state starts, Sentinel runs its check once before any edit. A check that already passes can't show the work got done, so Claude is told to make it stricter. This is the `fails-first` built-in, on at the Standard and Thorough weights (see [Library](#library)).
- **Done means everything still passes.** Before the plan completes, Sentinel runs the checks of the done states again, two at a time, on the project as it is then. A check that fails stops the others and runs once more on its own, in case it tripped over the other one. If it still fails, its state reopens and the plan goes back there, and the remaining checks wait for the next run. If it passes, the stopped checks start over. A check that keeps printing at five times the longest it has taken is stopped as stuck. Each run is written to `.sentinel/final-checks.log`. A check that holds only at one moment, such as one tied to a branch, can set `once`: it runs at its own advance and not again at the end, and the draft shows the mark.
- **Stopping halfway is caught.** When a turn ends with the plan unfinished and nothing waiting on you or on background work, Sentinel tells Claude to continue, at most twice per state.

## Proof each state was asked for

A plan can drift from what you asked for, or pick up work nobody requested. So each state quotes the words that asked for it, and Sentinel compares them itself, with code and no model. The words must match exactly; only spacing and formatting marks are ignored.

- **What counts as a source.** The plan you approved in plan mode, files from before this session, and the messages you typed. A file Claude wrote in this session doesn't count until you approve it in plan mode. `/sentinel lock` doesn't count as approving it, because you see the draft there and not the file's text.
- **A quote that isn't there goes back to Claude.** So does one under 5 words (unless it is your whole message), one over 60, or one from a part of the plan marked out of scope. Claude gets the nearest passage and sends the plan again. You have nothing to do, and the refusal stays on that state's record.
- **A state with nothing to quote shows as Claude's addition, with its reason.** On a draft it waits for you: Keep it or Take it out in the terminal or on the dashboard, and Lock opens once all are answered. `/sentinel lock` keeps any you haven't answered, and a plan-mode sign-off with an addition in it waits as a draft.
- **A state added during the run goes in and finishes.** It stays marked as Claude's addition, and it stops for your OK only if it could involve a dependency change, CI or deploy config, a migration, or auth code.
- **A section nothing quotes gets a note.** A section can be background, so this doesn't stop the plan. Sections named as context, overview, risks and similar get no note.

Sentinel keeps its own copy of each source, so later edits to a file change nothing. Only the messages a quote uses are written to disk or shown on the page. `/sentinel source` prints the saved copy with each quote marked. This is the `quote-the-source` built-in, on at every weight.

## Your OK, or hands-free

![A state waits for approval; the user goes hands-free and Claude makes those calls, each listed for later](docs/media/free.webp)

A state can wait for you. With `wait: "before"` you approve the approach first, as for a design or a risky change: Claude calls `propose` and stops, and its edits there are refused until you answer. With `wait: "after"` you review the finished work, as before a publish. You answer in the chat or on the dashboard. If a later fix sends the plan back along a loop, a finished state you already reviewed keeps your earlier review while none of its own files has been edited since. Sentinel says so in its reply and names the files edited elsewhere. A state with no files of its own, and a review passed hands-free, ask again.

Questions are held too. Claude can ask you something only after it declares a breaking change (a public API, an unplanned migration, deleting data, a new dependency, auth, secrets, CI or deploy), or when the active state waits for you. Everything else it decides itself and records with `decide`. Only Claude's own `decide` can excuse a check from the `fails-without-change` rerun. Your approval of a stop does not.

When the work waits on something outside, such as a locked machine or someone's reply, Claude files a blocked report that names what is needed. It shows as "needs you" on the status line, the band and the dashboard, Sentinel stops telling Claude to continue (hands-free too), and questions stay held. Reply in the chat or press It's ready, go on in the dashboard, and Claude goes on.

When you want to step away, go hands-free: type `/sentinel hands-free`, press Go hands-free in the dashboard, or press Approve and go hands-free on a state that waits for you. Claude then makes the calls that would have waited for you (a proposal, a review of its own work, a breaking change, a question), picks what it would recommend, and goes on. The dashboard lists each one under "Decided without asking you", and each task page shows its own. A state Claude is stuck in can be skipped and left for you, unless a later state builds on it; then the run stops and waits. `/sentinel hands-free off` or Turn off on the dashboard hands the calls back.

## When Claude goes in circles

![Health drops as the same test fails; Sentinel marks the run stuck, sends a note, and the run recovers](docs/media/stuck.webp)

Sentinel labels each tool call by whether it moved the work forward. Over the last 8 calls it works out a health score, `H = 1 − p·max(S, R)`: `S` is the share of calls that made no progress, `R` the share that repeated an earlier call, and `p` how much the last check failure weighs (fully when it is the same failure as before). An edit loses its credit when the next check fails the same way.

At `H ≤ 0.25` the run is stuck. Claude gets a note that names the pattern (cycle, drift or static), the file version it went back to and the failure that keeps coming back, with what to try next. The dashboard turns red and offers a field for your own hint, which reaches Claude with its next tool result, and a Pause button.

## The System map

Beside the plan, Sentinel keeps a picture of the project: its parts, the people who use it and the lines between them. Claude draws it. Sentinel sets what each part shows, and checks it against git.

- **Claude draws, Sentinel sets the status.** In `define`, Claude sends the drawing as `system` and names the parts each state builds as `parts`. A part then shows one of: Not built, Already there, Will change, Claude is here, Untested, Tested, Changed since test, Check failing or Needs you. Claude can't mark its own work: a part is Tested only when its state's check passed and the part's files changed since the state started. A state with no check proves nothing, so a part it builds shows Untested. A part whose files are already in the project when the plan is locked shows Will change until its state starts, and Already there if the state leaves it alone; a part with no files yet shows Not built. A group takes a colour from its parts. Red means a check is failing and amber means something needs you. Blue means Claude is inside, and green means every part is Tested.
- **The lines are Claude's drawing.** Nothing checks them against the code, and the part's panel says so. A drawing with a gap (a state that builds no part, a part nothing builds and no file backs, a part whose state has no check) gets a note on the draft, in the run's log and on the System tab. These notes never stop a lock.
- **Outside parts** are things the code relies on that aren't in the repo, such as a store, a queue or a service. Each shows its evidence: Seen in code (a file and the text in it, which Sentinel finds), Said by you (your quote, compared like a state's) or Guessed (Claude's reason, drawn dotted, and the draft asks you to confirm or remove it). They get no Tested mark and are left out of the counts.
- **Three files in `.sentinel/`.** `system.json` is the map, sorted by id so a merge conflict reads well. Sentinel writes it and never commits it. `marks.json` holds each part's last proof, and `plans.json` has one line per finished plan. The last two stay out of git. A map file that can't be read, such as one with merge conflict markers, is not used and not written over. Sentinel says so at session start, in the status reply and in `/sentinel system`, and the saved marks stay.
- **It stays current without a model.** Each part records the commit it was drawn at. At session start, when the System page opens and while a plan is drafted, Sentinel compares the map with what git says changed since. A part whose files changed shows Changed since drawn, with git's reason, and a draft that names one tells Claude to reread it. Changed since drawn (the picture may be out of date) and Changed since test (the proof is out of date) are separate marks. A part a state built is not marked for the files that state wrote, because the plan drew it for them. The mark comes back if those files change again. With no git repo, the page says nothing could be compared.
- **Redraw this area and It's fine.** Redraw asks Claude to reread the area, and ends with a question in the dialog: keep the new drawing, which also marks it as drawn today, or keep the old one. It's fine clears the mark until the area's files change again, on this machine. Neither happens on its own.
- **A project that already exists** gets its map one plan at a time. Claude draws only the parts the plan touches. Sentinel lists the other top-level folders with their file counts as Not mapped yet, and the endpoint keys in `.env.example` (names ending in `_URL`, `_HOST` or `_ENDPOINT`) that no outside part names as Not placed yet. Only the keys are read, never the values.
- **Approval stops and dropped parts ask in the real dialog.** A state that waits for you, and a part Claude wants to drop, open a question in the terminal. A typed message to Claude doesn't answer it; the page's buttons do, and so do the dialog's options. With no dialog (`claude -p`, or a session that can't show one), a stop passes only through the page's buttons or hands-free, and the reply tells Claude to stop its turn until then.

The System tab on the dashboard shows the map at four levels: Overview, Areas, Parts and Tasks (each part tagged with the tasks that build it). Its views are All, Testing (which parts are proved) and Changes (the drawing against what you signed off), as Boxes or as an Outline on narrow screens. Past plans are listed newest first, and pointing at one lights the parts it built.

## Library

![The user picks the Thorough weight, ticks one of Claude's suggestions on the draft, switches an instruction off for that plan and locks it; Claude then reads its instructions for the first state](docs/media/library.webp)

The Library holds what Sentinel adds to every plan: instructions, which are short texts Sentinel hands Claude at set moments, and flows, which are states that go into the plan itself. Sentinel ships built-ins of both. You switch any item on or off, write your own, and pick a weight that decides how much testing the built-ins ask for.

### Weights

| Weight | For | What the built-ins ask |
| --- | --- | --- |
| Light | quick work where speed matters more than proof | the fastest check that proves each state |
| Standard (default) | most work | a failure list before the code, a check that fails before the work, every new test made to fail once |
| Thorough | work that has to be right | Standard, plus a rerun of each check without the code change, an end-to-end run at the end, and no test deleted without a mutation run |

Thorough is slower: `fails-without-change` runs a state's check up to twice more, in a scratch copy of the project.

### Built-ins

| Name | When | Kind | On at |
| --- | --- | --- | --- |
| `depth-before-size` | while Claude drafts a plan | told | Standard, Thorough |
| `quote-the-source` | while Claude drafts a plan | Sentinel checks | Light, Standard, Thorough |
| `fast-checks` | while Claude drafts a plan | told | Light, Standard, Thorough |
| `failure-list` | as a state starts | told | Standard, Thorough |
| `fails-first` | as a state starts | Sentinel checks | Standard, Thorough |
| `break-it-once` | before a state closes | told | Standard, Thorough |
| `fails-without-change` | before a state closes | Sentinel checks | Thorough |
| `prove-end-to-end` | before the plan completes | told | Thorough |
| `measure-before-delete` | every turn | told | Thorough (needs a mutation-testing tool) |
| `sources-first` | while Claude drafts a plan | told | off; switch it on for projects with a spec and designs |
| `close-phase` (a flow) | at the end of a plan | flow | off |

"Told" means Claude reads the text: start and close texts arrive with the state, final texts at the lock and with the last state, and draft and every-turn texts in the system prompt. "Sentinel checks" means Sentinel acts itself. `quote-the-source` compares each state's quote with its sources (see [Proof each state was asked for](#proof-each-state-was-asked-for)). `fails-first` runs the check once before any edit. `fails-without-change` reruns a passing check in a scratch copy that has the state's test changes but not its code changes, and refuses the advance if it still passes, until Claude tightens the check or records why with `decide`. Every told block ends by saying the project's own rules (such as CLAUDE.md) win where they differ.

`depth-before-size` asks Claude for answers to "what would an expert do here", listed as `depth` on the draft. You tick the ones you want as you lock it, on the dashboard or with `/sentinel lock <id> <id>`. A state that only an unticked answer names comes out.

### Your own instructions

An instruction is a JSON file named after it, in `.sentinel/instructions/` (project, committed) or `~/.sentinel/instructions/` (personal):

```json
{
  "description": "Dashboard changes hold at every width.",
  "at": "start",
  "files": ["web/**"],
  "text": "Check dashboard changes at 390, 860 and 1440 px, in light and dark."
}
```

`at` is `draft`, `start`, `close`, `final` or `always`. `files` limits a `start` or `close` instruction to the states that edit them. Ask Claude for one in the chat or from the dashboard, write one in the dashboard's editor, or copy a built-in and change it; a file with a built-in's name takes its place.

### Switches

`.sentinel/library.json` holds the project's weight and switches and is committed, so a team shares them. `~/.sentinel/library.json` holds your default for every project. For each item the project's switch counts first, then yours, then the weight. Picking a weight clears that file's switches for the built-ins; your own items keep theirs, and they are on unless you switch them off. A flow that is off doesn't add itself by its rule, but you can still add it by hand.

A plan keeps the set it was locked with. While you check a draft, the dashboard's "Instructions for this plan" changes that plan's copy, and "Also make it this project's default" writes it to the project's switches when you lock.

A file Sentinel didn't save on this computer, such as one from a clone, stays off until you read it and type `/sentinel trust <name>` or press Trust on the dashboard.

### Flows

![Claude drafts a flow, the user saves it, then adds it to a draft plan from the list view](docs/media/flows.webp)

A flow is a set of states you define once and add to plans: a review before a publish, a database snapshot before a migration, lint and type checks at the end. Each flow is a JSON file named after it. Project flows live in `.sentinel/flows/` and are committed with the code. Personal flows live in `~/.sentinel/flows/` and work in every project. When both have one of the same name, the project's wins.

```json
{
  "description": "Test the state, then wait for my review.",
  "when": { "at": "after", "files": ["src/**"] },
  "states": [
    { "id": "tests", "label": "Tests pass for {{state.id}}", "check": "npm test -- {{state.files}}" },
    { "id": "look", "label": "You review {{state.label}}", "wait": "after" }
  ]
}
```

States take the same fields as a plan's. Tags fill in from the state the flow goes beside: `{{state.id}}`, `{{state.label}}`, `{{state.files}}` (as quoted globs in a check) and `{{plan.title}}`.

**Getting one.** Ask Claude for a flow in the chat, or press Ask Claude for a flow on the Flows tab of the dashboard's Library page. Sentinel checks it the way it checks a plan and holds it until you choose: Save to project, Save personal or Discard, from the band above the prompt, the Library page or `/sentinel flow save project|personal` and `/sentinel flow discard`. Instructions Claude drafts are kept the same way. You can also write the file by hand, use the dashboard's editor (New flow), or tick tasks of any plan in the List view and press Make a flow of them.

**Adding one.** While you check a draft, `/sentinel add review after api` puts the flow in after the state `api` (`start`, `end` and `before <state>` work too). In the dashboard's List view, press the dashed square where it should go, pick a flow and press Add here. Its states go in as a group named after the flow, with ids of their own (`review-tests`). `/sentinel drop review`, or Remove on the group, takes it out. Only you add and remove flows, and they stay put when Claude revises the draft.

**Rules.** A flow with `when` adds itself to each new plan Claude sends after a sign-off: after or before each state that edits the listed `files`, after or before every state when there are none, or once at the `start` or `end`. A rule adds a flow once per plan, and leaves drafts being revised and locked plans alone. A rule puts shell commands into plans nobody reads first, so it runs only from a flow file Sentinel saved on this computer that hasn't changed since. A flow that came with a clone, or that you or Claude wrote, can be added by hand, but its rule stays off until you read it and type `/sentinel trust <flow>` (or save it from Edit on the Library page).

## Install

Requires Claude Code 2.1.309 or later. At the prompt of a session:

```
/plugin install sentinel --marketplace RayyanMasood/sentinel
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell, `claude plugin install sentinel --marketplace RayyanMasood/sentinel` does the same. In the desktop app, click + next to the prompt box, then Plugins, Add marketplace with `RayyanMasood/sentinel`, then Add plugin.

To run it from a clone, start a session with `claude --plugin-dir <path to sentinel>`, or load it in every session through the `env` block of `~/.claude/settings.json`:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "<path to sentinel>"
}
```

## Commands

| Command | Does |
| --- | --- |
| `/sentinel` | open the pane on whatever needs you |
| `/sentinel focus`, `map`, `ledger`, `system` | open the pane on that view; `system` also checks the map against git |
| `/sentinel redraw <part>` | ask Claude to reread a part or an area and redraw it; you answer a question before anything changes |
| `/sentinel fine <part>` | clear the Changed since drawn mark on a part or an area until its files change again |
| `/sentinel browser` | open the dashboard in your browser |
| `/sentinel lock` | sign off a plan agreed in chat or already under way; again to lock the draft |
| `/sentinel lock <id> <id>` | lock the draft with those depth answers ticked |
| `/sentinel source` | print the saved copy of what the plan quotes, with each quote marked |
| `/sentinel hands-free`, `hands-free off` | let Claude make the calls that would wait for you, or take them back |
| `/sentinel pause`, `resume` | stop enforcing the plan and keep it; enforce it again, or pick up an earlier session's plan, draft or sign-off |
| `/sentinel skip <state> [reason]` | skip a state: Claude leaves it, and its check no longer runs before the plan completes |
| `/sentinel finish [reason]` | close the plan where it stands, without the final checks; the summary lists what never finished and what wasn't checked again |
| `/sentinel reset` | drop the current plan |
| `/sentinel parallel`, `parallel on`, `off` | say whether parallel states are on, or turn them on or off |
| `/sentinel library` (or `flows`) | list the instructions and flows with their switches, and the weight |
| `/sentinel on <name>`, `off <name>` | switch an item on or off for this project; add `personal` for your default |
| `/sentinel weight light`, `standard`, `thorough` | pick the weight for this project; add `personal` for your default |
| `/sentinel trust <name>` | turn on an instruction or flow file Sentinel didn't save (`flow trust` works too) |
| `/sentinel add <flow> start`, `end`, `before <state>`, `after <state>` | add a flow to the draft |
| `/sentinel drop <flow>` | take a flow out of the draft |
| `/sentinel flow save project`, `save personal`, `discard` | keep or drop the flow or instruction Claude drafted |

Commands that change the plan or your Library run only when you type them, send them through Remote Control, or run them headless with `claude -p`. Run by Claude or another plugin, they are refused.

Only you skip a state, with the command, by asking Claude, or with Skip on the state's task page. The one exception is hands-free, as above. A skipped state counts as done for the states that need it. Only you close a plan early too, with the command or by asking Claude.

The plan is saved to `.sentinel/run.json` on every change. A draft, a sign-off and a plan Claude sent before the sign-off go to `.sentinel/draft.json`, so they can't replace an earlier session's plan. A new session starts empty, and the status line says when the project holds any of these; `/sentinel resume` loads it, an unfinished plan first. While paused, nothing is checked or recorded, it is safe to close the session, and on resume Claude is told to read the plan's status first, since files may have changed.

## The dashboard

![The Map of a twelve-state plan; a state's page opens, and groups fold as the run moves on](docs/media/map.webp)

`/sentinel browser` starts a small helper, `web/serve.mjs`, that serves the page on 127.0.0.1 and passes your answers back to the session. It needs Node.js on PATH; without it, the page opens as the file `.sentinel/view.html`, which shows the same view and takes no answers. The helper answers only requests that carry the random token in the page's address, and ends with the session.

- **The header** says what the run is doing and how many states are done, in a colour you can read from across the room, such as red while stuck and green when done.
- **What needs you** sits under it whenever something waits on you, and answers it from the page: a question's options as cards, Approve and Ask for changes for a state, a hint and Pause for a stuck run, Resume, or Lock for a draft. The first answer counts, from the page or the chat. The tab's title and icon change while something waits, and notifications can tell you when the tab is in the background.
- **Plan** draws the machine three ways: a Map that wraps and folds groups to fit, One line, and a List you can copy from, where flows are added.
- **Task pages** open from any state. Asked for comes first: the state's quotes in full and where they came from, or Claude's reason if it added the state. Then why it is needed, the approach, what was done, where it stands and what happened along the way, including any quote Sentinel refused. Claude writes that text in plain words with each state (`title`, `problem`, `approach`, and an `outcome` when it moves on); it is never sent back to Claude.
- **The source page** shows Sentinel's saved copy with each quote marked and the state that quotes it beside it, a note on each section nothing quotes, the messages a quote uses, and what Claude added. Task pages and the draft card link to it.
- **Where the time went** draws every tool call as a bar on its state's row, with health below and stuck stretches shaded.
- **Every call** lists the active state's calls with file versions, check results and the health arithmetic.
- **Now**, beside the plan, has the active state and its check runs, then what was decided without you, what you were asked, the tokens used per model, and the log.
- **Library** has two tabs, Instructions and Flows. Each row has its switch, its moment and what it costs per state; the weight sits above with the extra words and check runs it adds. It holds what Claude drafted, and has an editor for each kind. On a draft, the "Before you lock it" card has the depth answers to tick and the plan's own copy of the switches.
- **System** shows once the project has a map, with or without a plan running. See [The System map](#the-system-map). A banner names the parts that changed since the map was drawn, with Redraw this area and It's fine on each.
- **The draft card** also says how many states quote their source, notes the sections nothing quotes, folds the quotes, and asks about each state Claude added. At the finish, "Claude added along the way" lists those states with your answers.

The pane in the terminal has four views, switched with `f`, `m`, `l` and `s`: Focus (the active state and its check runs), Map (the whole machine, health and log), Ledger (every call with the arithmetic) and System (the project's map, once it has one). `b` opens the dashboard.

## More

### A plan already under way

Type `/sentinel lock` in the middle of the work. Claude defines the whole plan and starts it at the first unfinished state. Sentinel runs the check of each state before that and refuses the plan if one fails; a finished state without a check needs evidence, such as a commit. Claude records decisions already made and where the plan's details live, so they survive compaction. You check the draft in the pane and lock it with a second `/sentinel lock`.

### Groups

Claude can give each state a `group`, such as `auth`, or `marking/runs` for a group inside a group. Groups only label states and fold them in the views; checks, loops and the stuck detector work the same with or without them.

### Parallel states (experimental)

Each state can list the states it `needs`. Without `needs`, a state needs the one before it, so a plan is a straight line. `define` refuses a plan whose needs go round in a circle, or where two states that could run at the same time share files.

Running states at the same time is off by default; only you turn it on, with `/sentinel parallel on`, saved per project. While it is on and no plan is locked, Claude is told to give each state `needs` for only what it builds on. A draft that still comes out as a line gets a note naming the neighbouring states that share no files, and Claude tells you why if the line stays. Then, when a state is done, Claude moves on to the next ready state and can brief the others. For each brief, Sentinel snapshots the project, uncommitted files included, into a git worktree under `.claude/worktrees/` and starts a member agent there, which may edit only its state's files. When the member stops, Sentinel stops any background run it or its helpers left going, after holding up to 30 minutes for the member's own, then runs the state's check in the worktree. If the state's files change during the check, the check runs again, up to 3 runs, so what comes back is what passed; if they change every time, nothing comes back and the worktree stays. A pass applies the diff of the state's files to the project with `git apply`, without committing; a failure goes back to the member, at most twice. The dashboard then shows who works on what, in a lane per agent.

States that run side by side each pass their own check, but nothing tests them together unless the plan does, so Sentinel warns about each pair that no later checked state builds on.

## Limits

- The scope guard covers Edit, Write and NotebookEdit. A shell command that writes files (`cp`, `sed -i`, `>`) gets past it.
- Failure signatures come from the check's output with times, addresses and line numbers stripped. A check whose output changes on every run will look like progress.
- Subagent edits pass the scope guard; their other calls stay out of the health window, and auto-continue acts on the main conversation only.
- The start-of-state check costs one extra run per state. It catches a check that passes before the work, but not one that fails only because its test file doesn't exist yet.
- Edits made outside Claude Code, `/rewind`, and background commands aren't seen, so Sentinel may reuse a pass that is out of date. Ask Claude to run the check again before it advances.
- The final checks run two at a time, so checks that share a port, a database or files they write can trip over each other. A check that changes things, such as a migration, runs again then.
- The final checks end at the first failure, so a second broken check shows up on the next run. A check running beside that failure can't be stopped during its first 60 seconds, so the reply can wait that long for it.
- A check marked `once` proves its state only at its own advance, so later work can break it without anything saying so.
- Plan mode sign-off locks straight away, so a flow goes into such a plan only by its rule. To place one by hand, use `/sentinel lock`.
- Flow rules and `define` compare file globs as text, so two globs that could cover the same file without matching each other, such as `src/*.ts` and `src/a*`, don't count as overlapping.
- Parallel states need a git repository with at least one commit, and snapshotting a large one is slow. Member agents end with the session that started them.
- The quote comparison only shows the words are in the source. It can't tell whether the state does what they say. A five-word quote that leaves out an earlier "not" still passes.
- The stop for a state added during the run reads its file patterns. A broad one such as `src/**` that later reaches a sign-in file doesn't stop. A public API change or deleted data still relies on Claude flagging it with `escalate`.
- A state Claude marks as part of a flow in a `define` skips the comparison. States added during a run can't use that mark.
- A new plan-mode sign-off while a plan runs replaces that plan's saved sources until the new draft locks.
- In `claude -p`, a prompt doesn't count as a typed message, so quotes need a file from before the session or a plan-mode approval. Checks run through the Bash tool as `(cd <root> && <check>); echo ...`, so a narrow allow rule such as `Bash(node:*)` doesn't cover them and `advance` is refused.
- Claude Code only for now. The state machine and detector in `hooks/core.ts` have no engine dependency, so other agents could reuse them.

## Develop

```
claude plugin validate .
claude plugin test .
node --test tests/serve.test.mjs
```

```
.claude-plugin/plugin.json    manifest
hooks/register.tsx            hooks: tool gate, commands, pane, auto-continue, dashboard snapshot
hooks/core.ts                 state machine, detector, view model (no engine calls)
hooks/views.tsx               the band and the pane's views
types/index.d.ts              state contract
web/view.html                 the dashboard
web/serve.mjs                 the dashboard's helper
tests/                        plugin and helper tests
docs/media/src/               the clips in this README
```

The clips play real runs through `hooks/core.ts` and show them on the real dashboard. To make them again, run `node docs/media/src/runs.mjs`, then `npx -y -p playwright@1.64.1 -c "node docs/media/src/render.cjs run free stuck library flows map"` (it needs Chrome and Python with Pillow).

## License

MIT

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
    <img src="docs/media/logo.svg" width="96" height="96" alt="">
  </picture>
</p>

<h1 align="center">Sentinel</h1>

<p align="center">Holds Claude Code to the plan you approved, one tool call at a time.</p>

<p align="center">
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude_Code-plugin-1462c4?style=flat-square&logo=claude&logoColor=white">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-0d7a4a?style=flat-square"></a>
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#how-a-run-goes">How a Run Goes</a> · <a href="#the-dashboard">The Dashboard</a> · <a href="#library">Library</a> · <a href="#commands">Commands</a>
</p>

Sentinel is a Claude Code plugin that holds the plan you approved as a state machine and checks Claude's work against it, tool call by tool call. You follow the run in a band above the prompt, a pane, or a live page in your browser.

![Claude works through a plan while the Sentinel dashboard follows each step](docs/media/run.webp)

On a long task, an agent can drift from the plan, edit files nobody agreed to, say a step is done without proving it, or go round in circles. Sentinel catches each of these as it happens and tells Claude what to do instead. Its Library sets how much testing each plan asks for, from quick checks to proof that a test fails without the change. It adds no model calls: every rule is a hook on a tool call. It is a cut-down version of the belief-state idea in "Beyond Memory: Harnessing Long-Horizon Agents with Explicit Belief States" (arXiv 2610.01415).

## How a Run Goes

You approve a plan in plan mode, or agree on one in the chat and type `/sentinel lock`. Claude declares it as states. Each state names the files it may edit and a check command that exits 0 when the state is done. From then on:

- **Edits stay in scope.** An edit to a file outside the active state's files is refused. Claude can widen the scope with `amend` and a reason, and every amendment is logged.
- **Moving on takes proof.** `advance` runs the state's check from the project root, through the Bash tool and your permission rules, and moves on only when it exits 0. A refusal carries the end of the check's output, so Claude can fix the failure without running the check again to read it. A state without a check needs evidence. While it drafts, Claude is told to give each state the fastest check that proves its own work and to run the whole suite once, in the last state (the `fast-checks` built-in).
- **A check has to be able to fail.** When a state starts, Sentinel runs its check once before any edit. A check that already passes can't show the work got done, so Claude is told to make it stricter. This is the `fails-first` built-in, on at the Standard and Thorough weights (see [Library](#library)).
- **Done means everything still passes.** Before the plan completes, Sentinel runs the checks of the done states again, two at a time, on the project as it is then. A check that fails stops the others and runs once more on its own, in case it tripped over the other one. If it still fails, its state reopens and the plan goes back there, and the remaining checks wait for the next run. If it passes, the stopped checks start over. A check that keeps printing at five times the longest it has taken is stopped as stuck. Each run is written to `.sentinel/final-checks.log`. A check that holds only at one moment, such as one tied to a branch, can set `once`: it runs at its own advance and not again at the end, and the draft shows the mark.
- **Stopping halfway is caught.** When a turn ends with the plan unfinished and nothing waiting on you or on background work, Sentinel tells Claude to continue, at most twice per state.

## Proof Each State Was Asked For

A plan can drift from what you asked for, or pick up work nobody requested. So each state quotes the words that asked for it, and Sentinel compares them itself, with code and no model. The words must match exactly; only spacing and formatting marks are ignored.

- **What counts as a source.** The plan you approved in plan mode, files from before this session, and the messages you typed. A file Claude wrote in this session doesn't count until you approve it in plan mode. `/sentinel lock` doesn't count as approving it, because you see the draft there and not the file's text.
- **A quote that isn't there goes back to Claude.** So does one under 5 words (unless it is your whole message), one over 60, or one from a part of the plan marked out of scope. Claude gets the nearest passage and sends the plan again. You have nothing to do, and the refusal stays on that state's record.
- **A state with nothing to quote shows as Claude's addition, with its reason.** On a draft it waits for you: Keep it or Take it out in the terminal or on the dashboard, and Lock opens once all are answered. `/sentinel lock` keeps any you haven't answered, and a plan-mode sign-off with an addition in it waits as a draft.
- **A state added during the run goes in and finishes.** It stays marked as Claude's addition, and it stops for your OK only if it could involve a dependency change, CI or deploy config, a migration, or auth code.
- **A section nothing quotes gets a note.** A section can be background, so this doesn't stop the plan. Sections named as context, overview, risks and similar get no note.
- **Each point you asked for is listed.** On a draft, Claude lists the points you made as `points`: your words, with the states that deliver each one, or its reason for leaving one out. Sentinel compares each quote as it does a state's, and refuses a state name the plan doesn't have. The draft card shows them under What you asked for, with a point left out in amber, and the band above the prompt counts the ones left out. A draft that lists none says so. A state taken out of the draft takes its points with it, and a point left with no states shows as left out. The list can't change once the plan runs.

Sentinel keeps its own copy of each source, so later edits to a file change nothing. Only the messages a quote uses are written to disk or shown on the page. `/sentinel source` prints the saved copy with each quote marked. This is the `quote-the-source` built-in, on at every weight.

## Your OK, or Hands-Free

![A state waits for approval; the user goes hands-free and Claude makes those calls, each listed for later](docs/media/free.webp)

A state can wait for you. With `wait: "before"` you approve the approach first, as for a design or a risky change: Claude calls `propose` and stops, and its edits there are refused until you answer. With `wait: "after"` you review the finished work, as before a publish. You answer in the chat or on the dashboard. If a later fix sends the plan back along a loop, a finished state you already reviewed keeps your earlier review while none of its own files has been edited since. Sentinel says so in its reply and names the files edited elsewhere. A state with no files of its own, and a review passed hands-free, ask again.

Questions are held too. Claude can ask you something only after it declares a breaking change (a public API, an unplanned migration, deleting data, a new dependency, auth, secrets, CI or deploy), or when the active state waits for you. Everything else it decides itself and records with `decide`. Only a `decide` of Claude's about the check can excuse it from the `fails-without-change` rerun. One about something else does not, and neither does your approval of a stop.

When the work waits on something outside, such as a locked machine or someone's reply, Claude files a blocked report that names what is needed. It shows as "needs you" on the status line, the band and the dashboard, Sentinel stops telling Claude to continue (hands-free too), and questions stay held. Reply in the chat or press It's ready, go on in the dashboard, and Claude goes on.

When you want to step away, go hands-free: type `/sentinel hands-free`, press Go hands-free in the dashboard, press Lock and go hands-free on the draft, or press Approve and go hands-free on a state that waits for you. Claude then makes the calls that would have waited for you (a proposal, a review of its own work, a breaking change, a question), picks what it would recommend, and goes on. The dashboard lists each one under "Decided without asking you", and each task page shows its own. A state Claude is stuck in can be skipped and left for you, unless a later state builds on it; then the run stops and waits. `/sentinel hands-free off` or Turn off on the dashboard hands the calls back.

## When Claude Goes in Circles

![Health drops as the same test fails; Sentinel marks the run stuck, sends a note, and the run recovers](docs/media/stuck.webp)

Sentinel labels each tool call by whether it moved the work forward. A new read or command counts as progress however many come in a row; reading the same thing again is a repeat. Reads and commands are compared without the times in their output. Over the last 8 calls it works out a health score, `H = 1 − p·max(S, R)`: `S` is the share of calls that made no progress, `R` the share that repeated an earlier call, and `p` how much the last check failure weighs (fully when it is the same failure as before). An edit loses its credit when the next check fails the same way. Any failure already seen during the current visit to a state counts as the same failure, so bouncing between two failures shows. Going back to an earlier version of a file counts as a repeat only when a failing check ran on that version. After 6 edits with the check not run while it fails, further edits count as no progress, and the note says to run the check. Each check run Claude starts records how long it took.

At `H ≤ 0.25` the run is stuck. Claude gets a note that names the pattern (cycle, drift or static), the file version it went back to and the failure that keeps coming back, with what to try next. The dashboard turns red and offers a field for your own hint, which reaches Claude with its next tool result, and a Pause button. The stuck mark stays until the check result changes, either a pass or a failure not seen before. While health stays at or below 0.25, a further note comes 8 calls on. The notes don't push Claude to escalate, though Claude can after two of them.

A stuck look is a second opinion on a stuck mark. When a mark is still stuck at its second note, Sentinel starts the same read-only Opus overseer (described below) with one question: is the run really stuck? It answers WRONG or FINE. On WRONG, Claude hears what to try and you get a toast. On FINE, the stuck mark is lifted, no more stuck notes come until Claude enters the state again, and Claude hears so. There is one stuck look per stuck mark. It never starts beside another running look (it starts at the next note instead), and it uses up no time mark. If the overseer is switched off on the Library page, no stuck look starts either.

There are two layers because each covers a weakness of the other. The detector judges every call from tool calls alone and costs nothing, but it can misread honest work, such as a long search that reads many files without changing any. The overseer is a model that reads the code and costs a look, so it runs only where the cheap signal has said stuck twice, or when a state runs long.

A state can also drag on with nothing going in circles, so Sentinel watches the time as well. When a state's working time passes 30 minutes, then 1, 2 and 4 hours, Sentinel starts an overseer: a read-only Opus agent that looks at the evidence from outside while the run goes on. The time note and the overseer's prompt also say how long the check runs took, for example "14 check runs, 41 min in all, about 3 min each". It answers FINE, FASTER or WRONG. FINE goes in the dashboard's log. FASTER and WRONG also reach Claude with its next tool result, or start a turn if Claude has stopped by itself, and you get a toast. Nothing stops the run, and time spent waiting on you doesn't count. If the agent can't start, Claude gets the same facts as a note. It is the `overseer` built-in, on at every weight: switch it off on the Library page or with `/sentinel off overseer`, and the log still notes the time but no agent starts.

A look runs on Opus for several requests. In a small test repo, one took 4,000 to 8,000 tokens of output, 120,000 written to the cache and 280,000 to 460,000 read from it. A state run by a member gets no overseer yet, and an overseer ends with the session that started it. In a terminal you may see one dim line such as `Prompt dropped by a hook: overseer: fine`, which is Sentinel keeping the agent's own report out of the chat. Every look is kept in `.sentinel/run.json` under `looks`: why it started (time or stuck), what it said, and the minutes until the state moved on.

## The System Map

Experimental: the System tab says so too, and has no switch.

Beside the plan, Sentinel keeps a picture of the project: its parts, the people who use it and the lines between them. Claude draws it. Sentinel sets what each part shows, and checks it against git.

- **Claude draws, Sentinel sets the status.** In `define`, Claude sends the drawing as `system` and names the parts each state builds as `parts`. A part then shows one of: Not built, Already there, Will change, Claude is here, Untested, Tested, Changed since test, Check failing or Needs you. Claude can't mark its own work: a part is Tested only when its state's check passed and the part's files changed since the state started. A state with no check proves nothing, so a part it builds shows Untested. A part whose files are already in the project when the plan is locked shows Will change until its state starts, and Already there if the state leaves it alone; a part with no files yet shows Not built. A group takes a colour from its parts. Red means a check is failing and amber means something needs you. Blue means Claude is inside, and green means every part is Tested.
- **The lines are Claude's drawing.** Nothing checks them against the code, and the part's panel says so. A drawing with a gap (a state that builds no part, a part nothing builds and no file backs, a part whose state has no check) gets a note on the draft, in the run's log and on the System tab. These notes never stop a lock.
- **Outside parts** are things the code relies on that aren't in the repo, such as a store, a queue or a service. Each shows its evidence: Seen in code (a file and the text in it, which Sentinel finds), Said by you (your quote, compared like a state's) or Guessed (Claude's reason, drawn dotted, and the draft asks you to confirm or remove it). They get no Tested mark and are left out of the counts.
- **Three files in `.sentinel/`.** `system.json` is the map, sorted by id so a merge conflict reads well. Sentinel writes it and never commits it. `marks.json` holds each part's last proof, and `plans.json` has one line per finished plan. The last two stay out of git. A map file that can't be read, such as one with merge conflict markers, is not used and not written over. Sentinel says so at session start, in the status reply and in `/sentinel system`, and the saved marks stay.
- **It stays current without a model.** Each part records the commit it was drawn at. At session start, when the System page opens and while a plan is drafted, Sentinel compares the map with what git says changed since. A part whose files changed shows Changed since drawn, with git's reason, and a draft that names one tells Claude to reread it. Changed since drawn (the picture may be out of date) and Changed since test (the proof is out of date) are separate marks. A part a state built is not marked for the files that state wrote, because the plan drew it for them. The mark comes back if those files change again. With no git repo, the page says nothing could be compared.
- **Redraw this area and It's fine.** Redraw asks Claude to reread the area, and ends with a question in the dialog: keep the new drawing, which also marks it as drawn today, or keep the old one. It's fine clears the mark until the area's files change again, on this machine. Neither happens on its own.
- **A project that already exists** gets its map one plan at a time. Claude draws only the parts the plan touches. Sentinel lists the other top-level folders with their file counts as Not mapped yet, and the endpoint keys in `.env.example` (names ending in `_URL`, `_HOST` or `_ENDPOINT`) that no outside part names as Not placed yet. Only the keys are read, never the values.
- **Approval stops and dropped parts ask in the real dialog.** A state that waits for you, and a part Claude wants to drop, open a question in the terminal. A typed message to Claude doesn't answer it; the page's buttons do, and so do the dialog's options. Close it with Esc and the band above the prompt keeps an Answer button that asks again, for these and for keeping a redraw. With no dialog (`claude -p`, or a session that can't show one), a stop passes only through the page's buttons or hands-free, and the reply tells Claude to stop its turn until then.

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

### Built-Ins

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
| `overseer` | while a state runs long or stays stuck | Sentinel checks | Light, Standard, Thorough |
| `sources-first` | while Claude drafts a plan | told | off; switch it on for projects with a spec and designs |
| `state-settings` | while Claude drafts a plan | told | off; see [Settings per State](#settings-per-state) |
| `close-phase` (a flow) | at the end of a plan | flow | off |

"Told" means Claude reads the text: start and close texts arrive with the state, final texts at the lock and with the last state, and draft and every-turn texts in the system prompt. "Sentinel checks" means Sentinel acts itself. `quote-the-source` compares each state's quote with its sources (see [Proof Each State Was Asked For](#proof-each-state-was-asked-for)). `fails-first` runs the check once before any edit. `fails-without-change` reruns a passing check in a scratch copy that has the state's test changes but not its code changes, and refuses the advance if it still passes, until Claude tightens the check or records why with `decide`. Every told block ends by saying the project's own rules (such as CLAUDE.md) win where they differ.

`depth-before-size` asks Claude for answers to "what would an expert do here", listed as `depth` on the draft. You tick the ones you want as you lock it, on the dashboard or with `/sentinel lock <id> <id>`. A state that only an unticked answer names comes out.

### Settings per State

Experimental, and off until you turn it on. The switch is the row marked Experimental under the weights on the Library page, for this project, the preset in use or every project. It is there for testing. No weight turns it on, Claude can't, and a plan reads it when it is drafted, so flipping it mid-run changes nothing in a running plan. With it off, Sentinel drops these fields from what Claude sends, says so once, and the plan runs as it did before.

With it on, a plan can differ from its one weight where a state calls for it:

- **A per-state weight:** a state names `weight`, with a reason or your own words. It moves `fast-checks`, `failure-list`, `fails-first`, `break-it-once` and `fails-without-change`, plus your own start and close instructions that list weights. Everything else stays plan-wide, and a switch you flipped by hand beats any weight.
- **An addition:** a state names `adds`, Library instructions that fire per state, each with a reason. Sentinel refuses an unknown name, a plan-wide instruction and one you switched off by hand. One that is off only because of the weight can be added.
- **A skip:** Claude can skip a told instruction that makes no sense for a state with `decide`, naming it in `skip` with a reason (`to` names a member's state). Sentinel refuses a name that isn't told at that state, and lists what can be skipped there. The ones Sentinel checks still run. A skip shows under Decided without asking you, and as −1 on the state's Map card.
- **The plan's own settings:** `settings` sets the plan's weight or turns an instruction on or off, each with a reason or your own words.

A stricter setting applies with its reason shown. A looser one waits for you: the draft card lists what differs, one row for each reason, with Keep and Use Standard, or Remove on an addition, and the band above the prompt asks the same. Hands-free, nobody is there to answer, so a state's lighter weight goes through and shows under Decided without asking you. Lock and go hands-free does the same for the plan's own settings, which don't change once a plan runs. Words you typed count as your answer, once Sentinel has found them in your messages. For anything looser that takes at least 5 words that name it, and a state's row keeps a button to take it back, since Sentinel compares words and not what they mean. If you lock with one unanswered, the plan runs without it. A state added mid-run takes the plan's weight unless it names a stricter one.

Each state's Map card and task page show its weight, its additions and its skips (see [The Dashboard](#the-dashboard)). A member agent running a state doesn't get Sentinel's rerun without its changes, so it is told to check that itself and say so.

### Your Own Instructions

An instruction is a JSON file named after it, in `.sentinel/instructions/` (this project, committed), `~/.sentinel/presets/<name>/instructions/` (a preset) or `~/.sentinel/instructions/` (every project):

```json
{
  "description": "Dashboard changes hold at every width.",
  "at": "start",
  "files": ["web/**"],
  "text": "Check dashboard changes at 390, 860 and 1440 px, in light and dark."
}
```

`at` is `draft`, `start`, `close`, `final` or `always`. `files` limits a `start` or `close` instruction to the states that edit them. `weights` lists the weights that turn it on (`light`, `standard`, `thorough`); with no list it is on at every weight, and it keeps your switches either way. Ask Claude for one in the chat or from the dashboard, write one in the dashboard's editor, or copy a built-in and change it; a file with a built-in's name takes its place.

### Switches

Edit and Write can't touch `.sentinel/library.json`, `~/.sentinel/library.json` or a preset's `library.json`, so Claude changes the switches only through Sentinel, at your word (below). A shell redirect isn't caught, as with `.sentinel/parallel`.

**Changes at your word.** Ask in the chat, such as "turn the overseer off for this project", and Claude makes the change. It sends the plan tool the words you'd type after `/sentinel` (`off overseer`) with a quote of your message, and Sentinel runs the same code the command runs. While no plan runs, Claude is told each item's name and switch, so you can name one as the Library page does. The quote has to be in your last typed message, word for word, and name what it changes. A weight change also needs the word "weight", and no preset needs the preset's name or "preset", so "the standard library" or "none of these" doesn't count. Turning something on needs its name and one more word. A change that can loosen the rules (off, a lighter weight, a weight for the preset or every project, `mcp drop`, or a change of preset) needs five of your words or your whole message. A change for the preset in use or every project needs your words to name that place: the preset's name, "preset", "every project" or "everywhere". A toast says Claude ran the command. The reply ends with the command that undoes it, such as `Undo: /sentinel on overseer`, or says there is none. No command takes a switch or weight out, so a place that had none of its own has no undo, and neither does a weight that cleared that place's switches. While a plan runs, the change counts from the next plan.

Claude can run `on` and `off`, `weight`, `preset <name>` and `preset none`, `preset new` and `move`, `mcp add` and `drop`, and `flow discard`. These stay yours: `trust` and `flow save`, since both let shell commands run; `preset delete`, since it can't be undone; import; and the switch for settings per state. An answer you pick in one of Claude's question dialogs doesn't count as your words, so type the ask.

A weight and switches can sit in three places, and the closest one wins:

1. **This project:** `.sentinel/library.json`, committed, so a team shares it.
2. **The preset in use,** if the project names one (see [Presets](#presets)).
3. **Every project:** `~/.sentinel/library.json`.

For each item the project's switch counts first, then the preset's, then every project's, then the weight. The weight is the closest place's that picks one, and it puts aside the built-in switches farther out. Picking a weight clears that place's own switches for the built-ins; your own items keep theirs, and they are on unless you switch them off. A flow that is off doesn't add itself by its rule, but you can still add it by hand.

On the Library page, Change for picks the place a switch or weight goes to, and says what it reaches, such as "Reaches every project that uses game-dev". Each row says what decided it when that is a place farther out, such as "Off here, from game-dev". The commands take `preset` or `everywhere` at the end for the same.

A plan keeps the set it was locked with. While you check a draft, the dashboard's "Instructions for this plan" changes that plan's copy, and "Also make it this project's default" writes it to the project's switches when you lock.

A file Sentinel didn't save on this computer, such as one from a clone, stays off until you read it and type `/sentinel trust <name>` or press Trust on the dashboard.

### Flows

![Claude drafts a flow, the user saves it, then adds it to a draft plan from the list view](docs/media/flows.webp)

A flow is a set of states you define once and add to plans: a review before a publish, a database snapshot before a migration, lint and type checks at the end. Each flow is a JSON file named after it. Project flows live in `.sentinel/flows/` and are committed with the code. A preset's live in `~/.sentinel/presets/<name>/flows/` and show only in projects that use it. Flows in `~/.sentinel/flows/` work in every project. When two places have one of the same name, the closest wins.

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

**Getting one.** Ask Claude for a flow in the chat, or press Ask Claude for a flow on the Flows tab of the dashboard's Library page. Sentinel checks it the way it checks a plan and holds it until you choose where it goes, or Discard: from the band above the prompt, the Library page's Save to, or `/sentinel flow save project|preset|everywhere` and `/sentinel flow discard`. Instructions Claude drafts are kept the same way. You can also write the file by hand, use the dashboard's editor (New flow), or tick tasks of any plan in the List view and press Make a flow of them.

**Adding one.** While you check a draft, `/sentinel add review after api` puts the flow in after the state `api` (`start`, `end` and `before <state>` work too). In the dashboard's List view, press the dashed square where it should go, pick a flow and press Add here. Its states go in as a group named after the flow, with ids of their own (`review-tests`). `/sentinel drop review`, or Remove on the group, takes it out. Only you add and remove flows, and they stay put when Claude revises the draft.

**Rules.** A flow with `when` adds itself to each new plan Claude sends after a sign-off: after or before each state that edits the listed `files`, after or before every state when there are none, or once at the `start` or `end`. A rule adds a flow once per plan, and leaves drafts being revised and locked plans alone. A rule puts shell commands into plans nobody reads first, so it runs only from a flow file Sentinel saved on this computer that hasn't changed since. A flow that came with a clone, or that you or Claude wrote, can't be added, by hand or by its rule, until you read it and type `/sentinel trust <flow>` (or save it from Edit on the Library page), since its checks are shell commands.

## Presets

A preset is settings that several projects share: a weight, switches, needed MCPs, and instructions and flows of its own. It is a folder, `~/.sentinel/presets/<name>/`, laid out like `.sentinel/`: `library.json`, `instructions/` and `flows/`. A project uses one by naming it as `preset` in its `.sentinel/library.json`. Nothing is copied, so the preset sits between This project and Every project (see [Switches](#switches)), and the project's own settings still win. Sentinel ships none. The commands are in the [Commands](#commands) table.

**Choose.** Press Change (or Choose a preset) on the Library page's Preset line. Each preset shows its weight, switches, what only it has, its MCPs and what using it would turn on or off here. Use it or pick No preset, or type `/sentinel preset <name>` or `preset none`. Either one changes only the one line in `.sentinel/library.json` and leaves nothing behind; choosing the old one again is the undo. A preset's own instructions and flows show only in projects that use it.

**Claude picks a preset.** While no plan runs, Claude is told which presets this computer has, what each one sets and which one this project uses. When it drafts a plan after your sign-off and another preset fits the work better, it names that preset with a one-line reason, such as backend for API work. Sentinel points the project at it, as `/sentinel preset backend` does, and builds the draft on it. The draft card says "Preset: backend, Claude's pick: the plan is API work. Was: none.", the plan's Decided list records it, and a toast gives the command that puts the old preset back. A plan you signed off in plan mode locks at once with no draft card, so there the toast and Decided show the pick. A pick that turns something off or lowers the weight is refused on Claude's reason alone: Claude asks you, then sends it again with your words naming the preset, checked as above. If the plan is refused after the pick, as when a server the preset needs isn't connected, the project goes back to the preset it had. A draft you reset or replace later keeps the project on the picked preset.

**Make one.** New preset (`/sentinel preset new <name>`) starts empty and is used here at once, and Change for moves to it, so what you switch or save next goes into it. Make one from this project (`/sentinel preset move <name>`) moves this project's own weight, switches, needed MCPs, instructions and flows into a preset, new or existing, and then uses it. Where the preset sets the same thing, this project's choice replaces it, so nothing changes here. Sentinel writes the preset first and clears the project after, so a failure leaves a copy behind and never loses anything. While a preset is in use, the button reads "Move this project's settings into game-dev". The moved settings leave `.sentinel/` in the repo, so teammates get them by using the preset.

**Change one.** With game-dev in use, pick game-dev in Change for, or press Change game-dev in its details. A change there reaches every project that uses it.

**Delete.** Delete removes the folder with its own instructions and flows. This project stops naming it; another project that named it finds it missing.

**Not on this computer.** A project can name a preset this computer lacks, such as a teammate's or one you deleted. The Library page and the draft card say "game-dev isn't on this computer, so this project runs on its own settings and Every project's", with Import beside it. The plan still locks.

**Export and import.** Export on the page downloads the preset as one JSON file, and Import on the page reads one back as a folder under the file's name, never over a preset you already have. It asks once about any MCP name this computer lacks: keep it, use one of your servers in its place, or leave it out, and your choice goes into your copy. Sentinel didn't make an imported preset on this computer, so its instructions and flows stay off until you run `/sentinel trust <name>` for each one. Read a flow's check commands on the page first, since checks are shell commands. A preset carries MCP server names only. It never holds how a server starts, its address or its keys, and nothing in it runs on import.

### Needed MCPs

A project lists the MCP servers it relies on as `mcps` in `.sentinel/library.json`, committed with the code. A preset and Every project can list some too, and the three lists add up, since a server needed anywhere is needed. `/sentinel mcp` lists them with their state in this session and where each comes from. `/sentinel mcp add <server>` and `/sentinel mcp drop <server>` change this project's list, and `preset` or `everywhere` at the end changes another's. The Library page has chips for the same: Add and × follow Change for. A plan records the list when it locks, so changing it mid-run doesn't change a running plan.

- A plan doesn't lock while a needed MCP is missing or only offers sign-in. The lock says which one, and to connect it with `/mcp`.
- In a session under 45 seconds old, Sentinel waits up to 15 seconds for a server that is still connecting.
- Each step's start checks again. If a server went missing (say a new session picked the plan up), the run stops on you as Needs you until you reply.
- Names match loosely. Case and the claude.ai or plugin prefix don't matter, so `Notion` matches `claude.ai Notion`.
- Another computer can name a server differently. When you import a preset, the page lets you pick one of your servers in its place or leave it out.

Sentinel can't connect a server for you, because the plugin API has no way to.

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
| `/sentinel help` | list every command with what it does |
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
| `/sentinel on <name>`, `off <name>` | switch an item on or off for this project; add `preset` or `everywhere` for the preset in use or every project |
| `/sentinel weight light`, `standard`, `thorough` | pick the weight for this project; add `preset` or `everywhere` for the preset in use or every project |
| `/sentinel trust <name>` | turn on an instruction or flow file Sentinel didn't save (`flow trust` works too) |
| `/sentinel add <flow> start`, `end`, `before <state>`, `after <state>` | add a flow to the draft |
| `/sentinel drop <flow>` | take a flow out of the draft |
| `/sentinel flow save project`, `save preset`, `save everywhere`, `discard` | keep or drop the flow or instruction Claude drafted |
| `/sentinel preset` | list your presets: settings shared by the projects that use one |
| `/sentinel preset <name>`, `preset none` | use a preset here, under this project's own settings, or stop using it |
| `/sentinel preset new <name>` | make an empty preset and use it here |
| `/sentinel preset move <name>` | move this project's own settings into a preset and use it here |
| `/sentinel preset delete <name>` | delete a preset |
| `/sentinel mcp` | list the MCP servers needed here, and whether this session has them |
| `/sentinel mcp add <server>`, `mcp drop <server>` | put a server on this project's list or take it off; add `preset` or `everywhere` for the preset in use or every project. Plans here won't lock while one is missing |

Commands that change the plan or your Library run only when you type them, send them through Remote Control, or run them headless with `claude -p`. Run by Claude or another plugin, they are refused.

Only you skip a state, with the command, by asking Claude, or with Skip on the state's task page. The one exception is hands-free, as above. A skipped state counts as done for the states that need it. Only you close a plan early too, with the command or by asking Claude.

The plan is saved to `.sentinel/run.json` on every change. A draft, a sign-off and a plan Claude sent before the sign-off go to `.sentinel/draft.json`, so they can't replace an earlier session's plan. A new session starts empty, and the status line says when the project holds any of these; `/sentinel resume` loads it, an unfinished plan first. While paused, nothing is checked or recorded, it is safe to close the session, and on resume Claude is told to read the plan's status first, since files may have changed.

## The Dashboard

![The Map of a twelve-state plan; a state's page opens, and groups fold as the run moves on](docs/media/map.webp)

`/sentinel browser` starts a small helper, `web/serve.mjs`, that serves the page on 127.0.0.1 and passes your answers back to the session. It needs Node.js on PATH; without it, the page opens as the file `.sentinel/view.html`, which shows the same view and takes no answers. The helper answers only requests that carry the random token in the page's address, and ends with the session.

Each session you open this way gets a tab on one page, named after its folder, so all your projects share one browser tab. If the page is open it moves to that session's tab, and if not, Sentinel opens it. A tab shows when its project needs you, and the page's title says so too. There is one bell, on the bar, and its notification comes when a project needs you while you are on another tab or the page is in the background. A tab goes when its session ends. You can close one with its × button, the middle mouse button or the Delete key. The session carries on, and its next `/sentinel browser` brings the tab back.

That page comes from a small background process, `web/hub.mjs`, on port 40999. It holds each session's token in memory and outlives the session that started it, so a new session joins a page that is already open. It exits a minute after there is no session and no page open. If it has gone, an old page says the sessions have ended, and the next `/sentinel browser` opens a new one. If the hub can't start, say because something else holds that port, the session opens its own page.

- **The header** says what the run is doing and how many states are done, in a colour you can read from across the room, such as red while stuck and green when done.
- **What needs you** sits under it whenever something waits on you, and answers it from the page: a question's options as cards, Approve and Ask for changes for a state, a hint and Pause for a stuck run, Resume, or Lock for a draft. The first answer counts, from the page or the chat. The tab's title and icon change while something waits, and notifications can tell you when the tab is in the background.
- **Usage** sits beside Tokens: `Week 52%`, with `5 hours` too when Claude Code reports it, and `This plan $4.20 · about 1.4% of your week`. The cost is at API prices, which a subscription doesn't charge, and it always shows. The share shows once your week has moved by 1% while Sentinel watched, in this session or an earlier one. Hover for when each figure resets and what it was when you signed off. Each state's page says `Used: $0.85 · about 0.6% of your week`. The Map view in the terminal and the finished plan's summary show the same, under the tokens. With an API key there is no weekly figure, so only the cost shows.
- **Plan** draws the machine three ways: a Map that wraps and folds groups to fit, One line, and a List you can copy from, where flows are added. With a Library, each Map card has three small bars for its state's weight (one for Light, three for Thorough), grey at the plan's weight and amber where the state differs, with +1 or −1 in amber when Claude added an instruction there or skipped one. Hover says it in words. The plan bar shows the plan's weight and its own changes, such as `Standard · 1 turned off`, and each task page has the same under Settings for this state.
- **Task pages** open from any state. Asked for comes first: the state's quotes in full and where they came from, or Claude's reason if it added the state. Then why it is needed, the approach, what was done, where it stands and what happened along the way, including any quote Sentinel refused. Claude writes that text in plain words with each state (`title`, `problem`, `approach`, and an `outcome` when it moves on); it is never sent back to Claude.
- **The source page** shows Sentinel's saved copy with each quote marked and the state that quotes it beside it, a note on each section nothing quotes, the messages a quote uses, and what Claude added. Task pages and the draft card link to it.
- **Where the time went** draws every tool call as a bar on its state's row, with health below and stuck stretches shaded.
- **Every call** lists the active state's calls with file versions, check results and the health arithmetic.
- **Now**, beside the plan, has the active state and its check runs, then what was decided without you, what you were asked, the tokens used per model, and the log.
- **Library** has the Preset line on top, with the preset in use, the needed MCPs and the chooser, then Change for and two tabs, Instructions and Flows. Each row has its switch, its moment and what it costs per state; the weight sits above with the extra words and check runs it adds. It holds what Claude drafted, and has an editor for each kind. On a draft, the "Before you lock it" card has the depth answers to tick and the plan's own copy of the switches.
- **System** shows once the project has a map, with or without a plan running. See [The System Map](#the-system-map). A banner names the parts that changed since the map was drawn, with Redraw this area and It's fine on each.
- **The draft card** also says how many states quote their source, notes the sections nothing quotes, lists What you asked for, folds the quotes, and asks about each state Claude added. At the finish, "Claude added along the way" lists those states with your answers.

The pane in the terminal has four views, switched with `f`, `m`, `l` and `s`: Focus (the active state and its check runs), Map (the whole machine, health and log), Ledger (every call with the arithmetic) and System (the project's map, once it has one). `b` opens the dashboard.

## More

### A Plan Already Under Way

Type `/sentinel lock` in the middle of the work. Claude defines the whole plan and starts it at the first unfinished state. Sentinel runs the check of each state before that and refuses the plan if one fails; a finished state without a check needs evidence, such as a commit. Claude records decisions already made and where the plan's details live, so they survive compaction. You check the draft in the pane and lock it with a second `/sentinel lock`.

### Groups

Claude can give each state a `group`, such as `auth`, or `marking/runs` for a group inside a group. Groups only label states and fold them in the views; checks, loops and the stuck detector work the same with or without them.

### Parallel States (Experimental)

Each state can list the states it `needs`. Without `needs`, a state needs the one before it, so a plan is a straight line. `define` refuses a plan whose needs go round in a circle, or where two states that could run at the same time share files.

Running states at the same time is off by default; only you turn it on, with `/sentinel parallel on`, saved per project. While it is on and no plan is locked, Claude is told to give each state `needs` for only what it builds on. A draft that still comes out as a line gets a note naming the neighbouring states that share no files, and Claude tells you why if the line stays. Then, when a state is done, Claude moves on to the next ready state and can brief the others. A brief can name the agent file and model its member runs on, such as `quick-worker` and `sonnet`, and the log says which. With neither, the session decides as it does for any agent. For each brief, Sentinel snapshots the project, uncommitted files included, into a git worktree under `.claude/worktrees/` and starts a member agent there, which may edit only its state's files. When the member stops, Sentinel stops any background run it or its helpers left going, after holding up to 30 minutes for the member's own, then runs the state's check in the worktree. If the state's files change during the check, the check runs again, up to 3 runs, so what comes back is what passed; if they change every time, nothing comes back and the worktree stays. A pass applies the diff of the state's files to the project with `git apply`, without committing; a failure goes back to the member, at most twice. The dashboard then shows who works on what, in a lane per agent.

States that run side by side each pass their own check, but nothing tests them together unless the plan does, so Sentinel warns about each pair that no later checked state builds on.

## Limits

- The weekly figure is Claude Code's own and counts every session on your account. A plan's share of it is an estimate: Sentinel notes what each point of your week cost while it watched, keeps the highest of the last 20, and divides the plan's cost by that. Other sessions running at once only pull that price down, which is why it keeps the highest. Each session keeps its own watch, and a reload doesn't start it over. Until it has a price, the plan shows its cost alone.
- A member agent's cost counts for the state active in the main conversation, so with parallel states on, the shares per state are rough.
- Two `/sentinel browser` commands in the seconds before the page connects open two pages. Both work.
- A page can't reliably bring itself to the front, so with the page open Sentinel moves it to the right tab, and you may have to click over to the browser.
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
node --test tests/serve.test.mjs tests/hub.test.mjs
```

```
.claude-plugin/plugin.json    manifest
hooks/register.tsx            hooks: tool gate, commands, pane, auto-continue, dashboard snapshot
hooks/core.ts                 state machine, detector, view model (no engine calls)
hooks/usage.ts                the usage figures: what 1% of the week costs, and a plan's share
hooks/views.tsx               the band and the pane's views
types/index.d.ts              state contract
web/view.html                 the dashboard
web/serve.mjs                 the dashboard's helper
web/hub.mjs, web/hub.html     the one page with a tab per session
tests/                        plugin and helper tests
docs/media/src/               the clips in this README
```

The clips play real runs through `hooks/core.ts` and show them on the real dashboard. To make them again, run `node docs/media/src/runs.mjs`, then `npx -y -p playwright@1.64.1 -c "node docs/media/src/render.cjs run free stuck library flows map"` (it needs Chrome and Python with Pillow).

## License

Apache License 2.0: see [LICENSE](LICENSE). Copies and changed versions must keep the attribution in [NOTICE](NOTICE).

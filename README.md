# Sentinel

Sentinel is a Claude Code plugin that holds the plan you approved as a state machine and checks Claude's work against it, tool call by tool call. You follow the run in a band above the prompt, a pane, or a live page in your browser.

![Claude works through a plan while the Sentinel dashboard follows each step](docs/media/run.webp)

On a long task, an agent can drift from the plan, edit files nobody agreed to, say a step is done without proving it, or go round in circles. Sentinel catches each of these as it happens and tells Claude what to do instead. It adds no model calls: every rule is a hook on a tool call. It is a cut-down version of the belief-state idea in "Beyond Memory: Harnessing Long-Horizon Agents with Explicit Belief States" (arXiv 2610.01415).

## How a run goes

You approve a plan in plan mode, or agree on one in the chat and type `/sentinel lock`. Claude declares it as states. Each state names the files it may edit and a check command that exits 0 when the state is done. From then on:

- **Edits stay in scope.** An edit to a file outside the active state's files is refused. Claude can widen the scope with `amend` and a reason, and every amendment is logged.
- **Moving on takes proof.** `advance` runs the state's check from the project root, through the Bash tool and your permission rules, and moves on only when it exits 0. A refusal carries the end of the check's output, so Claude can fix the failure without running the check again to read it. A state without a check needs evidence and at least one read.
- **A check has to be able to fail.** When a state starts, Sentinel runs its check once before any edit. A check that already passes can't show the work got done, so Claude is told to make it stricter.
- **Done means everything still passes.** Before the plan completes, Sentinel runs the checks of the done states again, two at a time, on the project as it is then. A check that fails twice reopens its state, and the plan goes back there.
- **Stopping halfway is caught.** When a turn ends with the plan unfinished and nothing waiting on you or on background work, Sentinel tells Claude to continue, at most twice per state.

## Your OK, or hands-free

![A state waits for approval; the user goes hands-free and Claude makes those calls, each listed for later](docs/media/free.webp)

A state can wait for you. With `wait: "before"` you approve the approach first, as for a design or a risky change: Claude calls `propose` and stops, and its edits there are refused until you answer. With `wait: "after"` you review the finished work, as before a publish. You answer in the chat or on the dashboard.

Questions are held too. Claude can ask you something only after it declares a breaking change (a public API, an unplanned migration, deleting data, a new dependency, auth, secrets, CI or deploy), or when the active state waits for you. Everything else it decides itself and records with `decide`.

When you want to step away, go hands-free: type `/sentinel hands-free`, press Go hands-free in the dashboard, or press Approve and go hands-free on a state that waits for you. Claude then makes the calls that would have waited for you (a proposal, a review of its own work, a breaking change, a question), picks what it would recommend, and goes on. The dashboard lists each one under "Decided without asking you", and each task page shows its own. A state Claude is stuck in can be skipped and left for you, unless a later state builds on it; then the run stops and waits. `/sentinel hands-free off` or Turn off on the dashboard hands the calls back.

## When Claude goes in circles

![Health drops as the same test fails; Sentinel marks the run stuck, sends a note, and the run recovers](docs/media/stuck.webp)

Sentinel labels each tool call by whether it moved the work forward. Over the last 8 calls it works out a health score, `H = 1 − p·max(S, R)`: `S` is the share of calls that made no progress, `R` the share that repeated an earlier call, and `p` how much the last check failure weighs (fully when it is the same failure as before). An edit loses its credit when the next check fails the same way.

At `H ≤ 0.25` the run is stuck. Claude gets a note that names the pattern (cycle, drift or static), the file version it went back to and the failure that keeps coming back, with what to try next. The dashboard turns red and offers a field for your own hint, which reaches Claude with its next tool result, and a Pause button.

## Flows

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

**Getting one.** Ask Claude for a flow in the chat, or press Ask Claude for a flow on the dashboard's Flows page. Sentinel checks it the way it checks a plan and holds it until you choose: Save to project, Save personal or Discard, from the band above the prompt, the Flows page or `/sentinel flow save project|personal` and `/sentinel flow discard`. You can also write the file by hand, use the dashboard's editor (New flow), or tick tasks of any plan in the List view and press Make a flow of them.

**Adding one.** While you check a draft, `/sentinel add review after api` puts the flow in after the state `api` (`start`, `end` and `before <state>` work too). In the dashboard's List view, press the dashed square where it should go, pick a flow and press Add here. Its states go in as a group named after the flow, with ids of their own (`review-tests`). `/sentinel drop review`, or Remove on the group, takes it out. Only you add and remove flows, and they stay put when Claude revises the draft.

**Rules.** A flow with `when` adds itself to each new plan Claude sends after a sign-off: after or before each state that edits the listed `files`, after or before every state when there are none, or once at the `start` or `end`. A rule adds a flow once per plan, and leaves drafts being revised and locked plans alone. A rule puts shell commands into plans nobody reads first, so it runs only from a flow file Sentinel saved on this computer that hasn't changed since. A flow that came with a clone, or that you or Claude wrote, can be added by hand, but its rule stays off until you read it and type `/sentinel flow trust <flow>` (or save it from Edit on the Flows page).

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
| `/sentinel focus`, `map`, `ledger` | open the pane on that view |
| `/sentinel browser` | open the dashboard in your browser |
| `/sentinel lock` | sign off a plan agreed in chat or already under way; again to lock the draft |
| `/sentinel hands-free`, `hands-free off` | let Claude make the calls that would wait for you, or take them back |
| `/sentinel pause`, `resume` | stop enforcing the plan and keep it; enforce it again, or pick up an earlier session's plan |
| `/sentinel skip <state> [reason]` | skip a state: Claude leaves it, and its check no longer runs before the plan completes |
| `/sentinel reset` | drop the current plan |
| `/sentinel parallel`, `parallel on`, `off` | say whether parallel states are on, or turn them on or off |
| `/sentinel flows` | list your saved flows |
| `/sentinel add <flow> start`, `end`, `before <state>`, `after <state>` | add a flow to the draft |
| `/sentinel drop <flow>` | take a flow out of the draft |
| `/sentinel flow save project`, `save personal`, `discard` | keep or drop the flow Claude drafted |
| `/sentinel flow trust <flow>` | turn on the rule of a flow file Sentinel didn't save |

Commands that change the plan or your flows run only when you type them, send them through Remote Control, or run them headless with `claude -p`. Run by Claude or another plugin, they are refused.

Only you skip a state, with the command, by asking Claude, or with Skip on the state's task page. The one exception is hands-free, as above. A skipped state counts as done for the states that need it.

The plan is saved to `.sentinel/run.json` on every change. A new session starts with no plan, and the status line says when the project has an unfinished one; `/sentinel resume` loads it. While paused, nothing is checked or recorded, and on resume Claude is told to read the plan's status first, since files may have changed.

## The dashboard

![The Map of a twelve-state plan; a state's page opens, and groups fold as the run moves on](docs/media/map.webp)

`/sentinel browser` starts a small helper, `web/serve.mjs`, that serves the page on 127.0.0.1 and passes your answers back to the session. It needs Node.js on PATH; without it, the page opens as the file `.sentinel/view.html`, which shows the same view and takes no answers. The helper answers only requests that carry the random token in the page's address, and ends with the session.

- **The header** says what the run is doing and how many states are done, in a colour you can read from across the room, such as red while stuck and green when done.
- **What needs you** sits under it whenever something waits on you, and answers it from the page: a question's options as cards, Approve and Ask for changes for a state, a hint and Pause for a stuck run, Resume, or Lock for a draft. The first answer counts, from the page or the chat. The tab's title and icon change while something waits, and notifications can tell you when the tab is in the background.
- **Plan** draws the machine three ways: a Map that wraps and folds groups to fit, One line, and a List you can copy from, where flows are added.
- **Task pages** open from any state: why it is needed, the approach, what was done, where it stands and what happened along the way. Claude writes that text in plain words with each state (`title`, `problem`, `approach`, and an `outcome` when it moves on); it is never sent back to Claude.
- **Where the time went** draws every tool call as a bar on its state's row, with health below and stuck stretches shaded.
- **Every call** lists the active state's calls with file versions, check results and the health arithmetic.
- **Now**, beside the plan, has the active state and its check runs, then what was decided without you, what you were asked, the tokens used per model, and the log.
- **Flows** lists your saved flows, holds a flow Claude drafted, and has the editor.

The pane in the terminal has three views, switched with `f`, `m` and `l`: Focus (the active state and its check runs), Map (the whole machine, health and log) and Ledger (every call with the arithmetic). `b` opens the dashboard.

## More

### A plan already under way

Type `/sentinel lock` in the middle of the work. Claude defines the whole plan and starts it at the first unfinished state. Sentinel runs the check of each state before that and refuses the plan if one fails; a finished state without a check needs evidence, such as a commit. Claude records decisions already made and where the plan's details live, so they survive compaction. You check the draft in the pane and lock it with a second `/sentinel lock`.

### Groups

Claude can give each state a `group`, such as `auth`, or `marking/runs` for a group inside a group. Groups only label states and fold them in the views; checks, loops and the stuck detector work the same with or without them.

### Parallel states (experimental)

Each state can list the states it `needs`. Without `needs`, a state needs the one before it, so a plan is a straight line. `define` refuses a plan whose needs go round in a circle, or where two states that could run at the same time share files.

Running states at the same time is off by default; only you turn it on, with `/sentinel parallel on`, saved per project. Then, when a state is done, Claude moves on to the next ready state and can brief the others. For each brief, Sentinel snapshots the project, uncommitted files included, into a git worktree under `.claude/worktrees/` and starts a member agent there, which may edit only its state's files. When the member stops, Sentinel runs the state's check in the worktree. A pass applies the diff of the state's files to the project with `git apply`, without committing; a failure goes back to the member, at most twice. The dashboard then shows who works on what, in a lane per agent.

States that run side by side each pass their own check, but nothing tests them together unless the plan does, so Sentinel warns about each pair that no later checked state builds on.

## Limits

- The scope guard covers Edit, Write and NotebookEdit. A shell command that writes files (`cp`, `sed -i`, `>`) gets past it.
- Failure signatures come from the check's output with times, addresses and line numbers stripped. A check whose output changes on every run will look like progress.
- Subagent edits pass the scope guard; their other calls stay out of the health window, and auto-continue acts on the main conversation only.
- The start-of-state check costs one extra run per state. It catches a check that passes before the work, but not one that fails only because its test file doesn't exist yet.
- Edits made outside Claude Code, `/rewind`, and background commands aren't seen, so Sentinel may reuse a pass that is out of date. Ask Claude to run the check again before it advances.
- The final checks run two at a time, so checks that share a port, a database or files they write can trip over each other. A check that changes things, such as a migration, runs again then.
- Plan mode sign-off locks straight away, so a flow goes into such a plan only by its rule. To place one by hand, use `/sentinel lock`.
- Flow rules and `define` compare file globs as text, so two globs that could cover the same file without matching each other, such as `src/*.ts` and `src/a*`, don't count as overlapping.
- Parallel states need a git repository with at least one commit, and snapshotting a large one is slow. Member agents end with the session that started them.
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

The clips play real runs through `hooks/core.ts` and show them on the real dashboard. To make them again, run `node docs/media/src/runs.mjs`, then `npx -y -p playwright@1.64.1 -c "node docs/media/src/render.cjs run free stuck flows map"` (it needs Chrome and Python with Pillow).

## License

MIT

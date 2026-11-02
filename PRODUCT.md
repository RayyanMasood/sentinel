# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
The person who signed off a plan and let Claude Code run it. The owner directs AI coding and is not a programmer. During a run they keep the dashboard in a full-window browser tab and switch to it now and then for a few seconds; they rarely watch it continuously. Each glance has to answer two questions first: does the run need me (stuck, holding a question), and how far along is it.

## Product Purpose
Sentinel is a Claude Code plugin that holds a signed-off plan as a state machine and keeps the model to it. The browser dashboard shows where the run is, what Sentinel decided without asking, what it asked, and why it thinks the run is stuck when it does. Success: the owner knows from one glance whether to step in, and can read why in plain words when they do.

## Positioning
Sentinel enforces the plan. Each state has a check command that must pass before the model moves on and a list of files it may edit; edits outside that list are refused. A detector scores the last 8 tool calls and calls the run stuck when health drops to 0.25 or below. Non-breaking choices are decided and logged instead of asked.

## Operating Context
- The model calls `define` with the plan's states (id, label, check, files, optional `group`, `title`, `problem`, `approach`, `wait`, `needs`) and allowed loops; `revise` changes a waiting draft; `advance` takes an optional `outcome`; with parallel states on, `brief` starts a member agent on a ready state; the user locks it in plan mode or with `/sentinel lock`.
- `/sentinel browser` starts a small helper (`web/serve.mjs`, plain Node) that serves the page and `.sentinel/state.js` on 127.0.0.1 behind a per-session token, and passes the answers sent from the page to the plugin. The page re-reads state.js every second. Without Node on PATH the page opens as a file, `.sentinel/view.html`, and answers go in the chat.
- The terminal has its own pane with Focus, Map and Ledger views; the browser view is the roomier companion.

## Capabilities and Constraints
- The page is one self-contained HTML file with inline CSS and a single inline script, which the helper's content security policy allows by its hash; only web fonts may load from outside.
- Data comes from the view model built by `summarize()` in `hooks/core.ts`: phase (none, draft, live, complete), paused, states with status, loops, health, trap, attempts, audit, asked, ledger, log, timeline. For task pages each state also carries `from`, `to`, `since`, `ms`, `visits` and `outcome`, and the view model has `trips` (the ways back taken, with the model's reason), `startedAt`, `endedAt` and `visitCalls`; audit entries carry the `state` they happened in. Times are wall clock in milliseconds and include time spent waiting on the user, but not a pause or a closed session: `pause` closes the running visit and `resume` opens a continuation of it (`cont: true`, not counted in `visits`). Resuming a plan saved by an earlier session ends its open visit at `savedAt`, the time run.json was last written. The run total is the tasks added up. The page adds the time since `since` itself, once a second, so state.js does not change while a task runs. State.js also carries `savedAt`, the time it was written. Two minutes after that time the page stops counting a running task, so a closed session stops ticking and the clock catches up on the next write.
- The task text is shown in the browser only and is never echoed back to the model. Every field is optional, and the page falls back to the state label when text is missing.
- Plans range from 3 states to 30 or more, optionally grouped and nested ("a/b").
- Kept from the 2026-10-24 rebuild by the owner's choice: the trail in the header, the plan as Map, One line or List, the rail fused with the timeline, the side panel, plain words over codes and symbols, the run on one scrolling page.

## Brand Commitments
Name: Sentinel. The logo is the four-node mark drawn in `web/view.html`, used in the header and as the tab icon. Palette and type are fixed in DESIGN.md.

## Evidence on Hand
Sample runs come from the real core through a script kept outside the repo: a 22-state grouped plan, the same run stuck in a cycle, a flat plan, nested groups, a finished small plan, a draft, and no plan. No user data exists to show; nothing may be invented as real.

## Product Principles
- Answer "does it need me?" before anything else, then "how far along?".
- Plain words for a non-programmer; numbers and arithmetic stay available but out of the way.
- Colour carries state the owner must notice; nothing on the page should look alarming when the run is fine.
- The page stays a thin view of the plugin's data; it never adds logic the terminal pane lacks.

## Accessibility & Inclusion
Readable by someone who doesn't read code: sentences over symbols, words beside every colour, keyboard-operable controls, reduced motion respected.

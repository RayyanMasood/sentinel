// The demo for the Sentinel video: one plan, "Team invites", played through Sentinel's own logic (hooks/core.ts) on a
// fixed clock. Claude drafts it on a preset it picked, two helpers work beside it, a step gets stuck, the overseer says
// so, and the run goes back along its loop. Writes data/demo.json for demo.html: node docs/media/src/demo.mjs
// Any move Sentinel would refuse stops the script, and the checks at the end stop it if a chapter lost what it shows.
import { writeFileSync } from 'node:fs'
import { act, addSpend, addUsage, besideNote, briefRefusal, emptyRun, fnv, HANDS_FREE, handsFree, healthWord, heard, laneCall, laneDone, libraryOn, lockDraft, memberIn, observe, outOfScope, planStates, recordStart, startMember, summarize, sweepChecks } from '../../../hooks/core.ts'
import { BUILTIN_FLOWS, BUILTINS } from '../../../hooks/builtins.ts'
import { mergeDrawing } from '../../../hooks/system.ts'

const MIN = 60_000
let now = new Date(2026, 10, 9, 9, 40).getTime()
const t = () => new Date(now).toTimeString().slice(0, 5)
const wait = min => (now += min * MIN)

// ponytail: band, library, planLib and page are copied from runs.mjs, which writes every clip's data when imported.
// Move them to a shared module if a third script needs them.
function band(vm) {
  const a = vm.active, f = vm.flowDraft
  if (vm.phase === 'draft') return `Sentinel draft "${vm.title}": ${vm.states.length - 1} states, starts at ${a.id}. Check it, then lock it.`
  if ((!a || vm.phase !== 'live') && f) return `Sentinel: Claude drafted the flow "${f.name}" (${f.states.length} state${f.states.length === 1 ? '' : 's'}). Save it?`
  if (!a || vm.phase !== 'live') return ''
  const s = vm.sweep, c = vm.checking?.at(-1), hl = vm.health
  if (vm.paused) return `Sentinel is paused at ${a.id}.`
  if (vm.trap) return `Sentinel: stuck (${vm.trap.pattern}) in ${a.id}.`
  if (vm.waiting) return vm.waiting.kind === 'before' ? `Sentinel: ${a.id} asks for your OK before it starts.` : `Sentinel: ${a.id} is ready for your review.`
  if (s) return `Sentinel: final checks · ${s.passed} of ${s.total} passed${s.going.length ? ` · running ${s.going.join(', ')}` : ''}`
  if (c) return `Sentinel: ${a.id} ${a.pos}/${a.of} · running the check · ${c.ms < MIN ? 'under a minute' : `${Math.floor(c.ms / MIN)} min`}`
  return `Sentinel: ${a.id} ${a.pos}/${a.of}${hl ? ` · H ${hl.H.toFixed(2)} ${healthWord(hl.H)}` : ''}`
}

// The project's own instruction, which only reaches states that touch the page's files.
const OWN = [{ name: 'page-width', description: 'Pages work on a phone', at: 'start', files: ['src/ui/**'], text: 'Every page works at 360px wide. Look at it at that width before you advance.', scope: 'project', file: '.sentinel/instructions/page-width.json' }]
const BUILT_FLOWS = BUILTIN_FLOWS.map(f => ({ ...f, scope: 'built-in', trusted: true }))
// The two presets on this computer. full-stack adds the end-to-end proof; quick lightens everything.
const FULL = { weight: 'standard', on: { 'prove-end-to-end': true } }
const PRESETS = [
  { name: 'full-stack', trusted: true, file: '~/.sentinel/presets/full-stack', raw: FULL, weight: 'standard', on: FULL.on, instructions: [], flows: [], mcps: [{ name: 'playwright', state: 'connected', server: 'playwright', scope: 'preset' }], preview: { turnsOn: ['prove-end-to-end'], turnsOff: [] } },
  { name: 'quick', trusted: true, file: '~/.sentinel/presets/quick', raw: { weight: 'light' }, weight: 'light', on: {}, instructions: [], flows: [], mcps: [], preview: { turnsOn: [], turnsOff: ['failure-list', 'fails-first', 'break-it-once'] } },
]
function library(project = {}, preset) {
  const items = [...BUILTINS.map(b => ({ ...b, scope: 'built-in', trusted: true })), ...OWN.map(i => ({ kind: 'told', trusted: true, ...i }))]
  const { weight, on } = libraryOn([...items, ...BUILT_FLOWS], project, {}, preset ? FULL : {})
  return {
    library: {
      weight, project: { ...project, ...(preset ? { preset } : {}) }, personal: {}, instructions: items.map(i => ({ ...i, on: on.includes(i.name) })),
      flowsOn: Object.fromEntries(BUILT_FLOWS.map(f => [f.name, on.includes(f.name)])), presets: PRESETS,
      mcps: preset ? [{ name: 'playwright', state: 'connected', server: 'playwright', scope: 'preset' }] : [], servers: [{ server: 'playwright', name: 'playwright', signIn: false }],
      ...(preset ? { using: { name: preset, ...FULL } } : {}),
    },
    flows: BUILT_FLOWS,
  }
}
// What the plan locks with (register.tsx, planLibrary), with the per-state settings the experimental switch keeps.
function planLib({ library: l }) {
  const on = [...l.instructions.filter(i => i.on).map(i => i.name), ...Object.keys(l.flowsOn).filter(n => l.flowsOn[n])]
  const told = l.instructions.filter(i => i.kind === 'told' && on.includes(i.name)).map(({ name, description, at, files, text }) => ({ name, ...(description ? { description } : {}), at, ...(files ? { files } : {}), text }))
  return { weight: l.weight, on, told, states: planStates(l.instructions, l.weight, on, {}) }
}

const ok = out => {
  if (out.ok === false) throw new Error(out.text)
  return out
}

// ---- the plan ----

const ASK = 'Let admins invite teammates by email. Each invite link works once and expires after 7 days. Add an end-to-end test for the whole path, and document how invites work.'
const drawing = mergeDrawing(undefined, {
  name: 'Team app',
  actors: [{ id: 'admin', name: 'Team admin' }, { id: 'invitee', name: 'Invitee' }],
  parts: [
    { id: 'backend', name: 'Backend', desc: 'The API and the database' },
    { id: 'invites-table', name: 'Invites table', parent: 'backend', desc: 'Who was invited, with a token and an expiry', files: ['db/migrations/0042_invites.sql'] },
    { id: 'invites-api', name: 'Invites API', parent: 'backend', desc: 'Sends invites and accepts them from the link', files: ['src/api/invites/*.ts'] },
    { id: 'members', name: 'Team members', parent: 'backend', desc: 'Adds a person to a team', files: ['src/api/teams/members.ts'] },
    { id: 'frontend', name: 'Frontend', desc: 'What admins and invitees see' },
    { id: 'invite-form', name: 'Invite form', parent: 'frontend', desc: 'Where an admin types an email', files: ['src/ui/InviteForm.tsx'] },
    { id: 'invite-email', name: 'Invite email', parent: 'frontend', desc: 'The email with the one-time link', files: ['src/emails/invite.tsx'] },
    { id: 'invites-e2e', name: 'End-to-end test', desc: 'Invite, accept, and check the team', files: ['e2e/invites.spec.ts'] },
    { id: 'invite-docs', name: 'Admin guide page', desc: 'How invites work, their limits and expiry', files: ['docs/invites.md'] },
    { id: 'mailer', name: 'Mail service', kind: 'outside', evidence: { guess: 'config/mail.ts names a Postmark key' }, where: 'Postmark' },
  ],
  lines: [
    { from: 'admin', to: 'invite-form', says: 'types an email' },
    { from: 'invite-form', to: 'invites-api', says: 'POST /teams/:id/invites' },
    { from: 'invites-api', to: 'invites-table', says: 'stores the invite and its token' },
    { from: 'invites-api', to: 'invite-email', says: 'renders the email' },
    { from: 'invite-email', to: 'mailer', says: 'sends it' },
    { from: 'invitee', to: 'invites-api', says: 'opens the link' },
    { from: 'invites-api', to: 'members', says: 'adds the member' },
  ],
})
if (!drawing.ok) throw new Error(drawing.error)

const S = {
  explore: { id: 'explore', label: 'Read the teams code', added: 'Invites have to fit how teams add members today.', title: 'Find how teams add members', problem: 'The invite has to end in the same place an admin adds someone by hand.', approach: 'Read the members endpoint and the team page.' },
  table: { id: 'table', label: 'Invites table', needs: ['explore'], asked: ['Let admins invite teammates by email'], check: 'npm test -- db/invites', files: ['db/migrations/0042_invites.sql'], parts: ['invites-table'], title: 'Store invites', problem: 'Nothing records who was invited to a team.', approach: 'An invites table with a token, the team and an expiry date.' },
  api: { id: 'api', label: 'Send and accept invites', needs: ['table'], asked: ['Each invite link works once and expires after 7 days'], check: 'npm test -- invites', files: ['src/api/invites/*.ts'], parts: ['invites-api'], title: 'Invite, then join from the link', problem: 'Only an admin can add people today, by hand.', approach: 'One endpoint stores the invite and sends the email; the link checks the token once, then adds the member.' },
  form: { id: 'form', label: 'Invite form', needs: ['explore'], asked: ['Let admins invite teammates by email'], check: 'npm test -- InviteForm', files: ['src/ui/InviteForm.tsx'], parts: ['invite-form'], title: 'Invite from the team page', problem: 'There is nowhere to type an email.', approach: 'A form on the team page, with errors inline.' },
  email: { id: 'email', label: 'Invite email', needs: ['explore'], asked: ['Let admins invite teammates by email'], check: 'npm test -- emails/invite', files: ['src/emails/invite.tsx'], parts: ['invite-email'], title: 'A clear invite email', problem: 'The invite has to say who sent it and to which team.', approach: 'A short email with one button.' },
  e2e: { id: 'e2e', label: 'End-to-end', needs: ['api', 'form', 'email'], asked: ['Add an end-to-end test for the whole path'], check: 'npm run e2e -- invites', files: ['e2e/invites.spec.ts'], parts: ['invites-e2e'], title: 'The whole path works', problem: 'Each part passes alone, but nothing tests the path from email to team.', approach: 'A browser test that invites, accepts the link twice, and checks the team.' },
  docs: { id: 'docs', label: 'Document invites', needs: ['e2e'], wait: 'before', weight: 'light', weightWhy: 'A docs page has no test that could fail first.', asked: ['and document how invites work'], files: ['docs/invites.md'], parts: ['invite-docs'], title: 'Explain invites to admins', problem: 'Admins need to know the expiry and that a link works once.', approach: 'A page in the admin guide.' },
}
const PICK = { name: 'full-stack', why: 'the plan touches the database, the API and the page.' }
const PLAN = {
  action: 'define', title: 'Team invites',
  messages: [{ kind: 'message', text: ASK, at: '09:40' }],
  states: Object.values(S),
  loops: [['e2e', 'api']],
  points: [
    { said: 'Let admins invite teammates by email', states: ['table', 'api', 'form', 'email'] },
    { said: 'Each invite link works once and expires after 7 days', states: ['api'] },
    { said: 'Add an end-to-end test for the whole path', states: ['e2e'] },
    { said: 'and document how invites work', states: ['docs'] },
  ],
  decisions: [{ topic: 'Preset', choice: 'full-stack', reason: PICK.why.replace(/\.$/, '') }],
  drawn: { map: drawing.map, exists: ['members'] },
}

// ---- the run ----

const moments = {}, said = {}
const LIB = library({}, 'full-stack')
let marks = {}
// What the page gets (runs.mjs page), plus the helpers at work and the parts' proofs for the System tab.
const keep = (name, r, extra = {}, lib = LIB) => {
  const members = Object.fromEntries(Object.entries(r.running ?? {}).map(([id, m]) => [id, { agent: m.agent, since: m.since }]))
  const vm = { ...summarize(r, { marks }), savedAt: now, parallel: true, members, ...lib, ...(r.draft ? { draftKey: fnv(JSON.stringify(r.draft)), draftLibrary: r.draft.library } : {}), ...extra }
  moments[name] = { now, vm, band: band(vm) }
}
const go = (r, i, proofs = {}) => ok(act(r, i, t(), proofs, now))
const edit = (r, file, ver = 'v1') => observe(r, { kind: 'edit', label: `Edit ${file}`, file, ver }, t()).run
const look = (r, file, fp) => observe(r, { kind: 'look', label: `Read ${file}`, fp }, t()).run
const pass = (r, check) => observe(r, { kind: 'check', label: check, pass: true, sig: '', sigText: '', fails: 0 }, t()).run
const proof = check => ({ [check]: { pass: true, sigText: '' } })
// The session's cost as Claude Code reports it, and the week's limit. One percent of the week is worth $1.90 here.
const WEEK = [{ kind: 'seven_day', percentUsed: 38, resetsAt: '2026-11-13T09:00:00Z' }, { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-11-09T13:00:00Z' }]
let usd = 0
const spend = (r, more, tokens) => {
  usd += more
  const week = WEEK.map(w => (w.kind === 'seven_day' ? { ...w, percentUsed: w.percentUsed + Math.round(usd / 1.9) } : w))
  r = addUsage(r, usd, week, 1.9)
  return addSpend(r, { model: 'claude-opus-5-5', input_tokens: tokens / 20, output_tokens: tokens / 10, cache_read_input_tokens: tokens * 0.6, cache_creation_input_tokens: tokens / 4 }, 'high', false, new Date(now).toISOString())
}
// A part is proved when its state's check passed after its files changed (marks.json, as the plugin keeps it).
const prove = (part, check) => (marks = { ...marks, [part]: { base: 'a0', hash: fnv(part), from: 'a0', check, weight: 'standard', at: t(), step: r.step, run: r.startedAt } })

// 1. The draft, on the preset Claude picked.
const library0 = { ...planLib(LIB), preset: PICK }
let out = ok(act({ ...emptyRun(), signedOff: true, review: true }, { ...PLAN, library: library0 }, t(), {}, now))
let draft = spend(out.run, 0.6, 40_000)
said.drafted = out.text
said.pick = `Sentinel: Claude picked the preset ${PICK.name} for this plan. Undo: /sentinel preset none`
keep('draft', draft)
wait(1)
// You keep the step Claude added and the lighter weight it asked for on docs (the draft card's Keep buttons).
const kept = s => (s.id === 'explore' ? { ...s, okAt: t() } : s.id === 'docs' ? { ...s, weightOk: true } : s)
draft = { ...draft, draft: { ...draft.draft, plan: { ...draft.draft.plan, states: draft.draft.plan.states.map(kept) } } }
keep('kept', draft)
wait(1)

// 2. Locked.
let r = lockDraft(draft, t(), now)
said.locked = `Locked "${r.plan.title}" at ${r.active}.`
keep('locked', r)
wait(3)
r = look(r, 'src/api/teams/members.ts', 'm1')
wait(2)
r = look(r, 'src/ui/TeamPage.tsx', 't1')
keep('explore', r)
wait(1)

// 3. table: its check runs before the work and has to fail.
out = go(r, { action: 'advance', to: 'table', evidence: 'Members join through addMember() in src/api/teams/members.ts; the team page lists them.' })
r = recordStart(out.run, S.table.check, false, t()).run
r = spend(r, 1.4, 90_000)
said.table = [out.text, besideNote(r)].filter(Boolean).join('\n')
keep('table', r)
wait(1)

// 4. Two helpers start beside Claude, each in its own copy of the project.
const brief = (id, agent, text) => {
  const why = briefRefusal(r, { action: 'brief', to: id, brief: text }, true)
  if (why) throw new Error(why)
  r = startMember(r, id, { agent, name: `sentinel-${id}-${agent}` }, t(), now)
  said[`brief-${id}`] = `Started a member agent for ${id} in .claude/worktrees/sentinel-${id}-${agent}/. Its answer comes back when it stops. Carry on with ${r.active}.`
}
const lane = (agent, label, file) => (r = laneCall(r, agent, '', { label, ...(file ? { file } : {}) }))
brief('form', 'a1f3', 'InviteForm.tsx on the team page: an email field, errors inline. Test that a bad email shows its error.')
lane('a1f3', 'Read src/ui/TeamPage.tsx')
brief('email', 'b7c2', 'src/emails/invite.tsx: who sent it, which team, one button with the link. Test the rendered text.')
lane('b7c2', 'Read src/emails/welcome.tsx')
keep('briefed', r)
wait(3)
lane('a1f3', 'Write src/ui/InviteForm.tsx', 'src/ui/InviteForm.tsx')
lane('b7c2', 'Write src/emails/invite.tsx', 'src/emails/invite.tsx')
r = edit(r, S.table.files[0])
keep('table-work', r)
wait(2)
r = pass(r, S.table.check)
prove('invites-table', S.table.check)
out = go(r, { action: 'advance', to: 'api', outcome: 'An invites table with a token, the team and an expiry date.' }, proof(S.table.check))
r = recordStart(out.run, S.api.check, false, t()).run
r = spend(r, 1.1, 70_000)
said.api = [out.text, besideNote(r)].filter(Boolean).join('\n')
keep('api', r)
wait(2)

// The form's helper comes back: its check passed in its copy, and its file comes in.
lane('a1f3', 'Bash npm test -- InviteForm')
r = laneDone(memberIn(r, 'form', 'An invite form on the team page, with inline errors.', t(), now, S.form.files), 'a1f3')
prove('invite-form', S.form.check)
said.formIn = [`[sentinel] form is in: its member passed \`${S.form.check}\` in its worktree. Sentinel applied its changes to the project: ${S.form.files[0]}.`, 'Continue with the plan.'].join('\n')
keep('form-in', r)
wait(2)

// 5. Edits stay in scope: members.ts isn't api's file until Claude says why.
r = edit(r, 'src/api/invites/create.ts')
wait(2)
said.refused = outOfScope(r, 'src/api/teams/members.ts')
r = observe(r, { kind: 'edit', label: 'Edit src/api/teams/members.ts', file: 'src/api/teams/members.ts', denied: true }, t()).run
keep('refused', r)
wait(1)
out = go(r, { action: 'amend', files: ['src/api/teams/members.ts'], reason: 'Accepting an invite adds the member through addMember().' })
r = out.run
said.amended = out.text
keep('amended', r)
wait(2)
r = edit(r, 'src/api/teams/members.ts')
r = edit(r, 'src/api/invites/accept.ts')
lane('b7c2', 'Bash npm test -- emails/invite')
r = laneDone(memberIn(r, 'email', 'The invite email names the sender and the team, with one button.', t(), now, S.email.files), 'b7c2')
prove('invite-email', S.email.check)
said.emailIn = [`[sentinel] email is in: its member passed \`${S.email.check}\` in its worktree. Sentinel applied its changes to the project: ${S.email.files[0]}.`, 'Continue with the plan.'].join('\n')
keep('email-in', r)
wait(2)

// 6. Moving on takes proof: the check fails, so the advance is refused.
keep('checking', { ...r, checking: [{ label: S.api.check, ids: ['api'], at: now, ms: 20_000 }] })
r = observe(r, { kind: 'check', label: S.api.check, pass: false, sig: 'x1', sigText: 'expected 410, received 200 · an expired invite was accepted', fails: 1, tail: 'Tests: 1 failed, 14 passed' }, t()).run
out = act(r, { action: 'advance', to: 'e2e' }, t(), {}, now)
if (out.ok !== false) throw new Error('the advance should be refused')
said.failed = out.text
r = observe(r, { kind: 'plan', label: 'plan advance → e2e', denied: true }, t()).run
keep('failed', r)
wait(2)
r = edit(r, 'src/api/invites/accept.ts', 'v2')
r = pass(r, S.api.check)
prove('invites-api', S.api.check)
out = go(r, { action: 'advance', to: 'e2e', outcome: 'Invites are sent and accepted; an expired link answers 410.' }, proof(S.api.check))
r = recordStart(out.run, S.e2e.check, false, t()).run
r = spend(r, 1.8, 120_000)
said.e2e = out.text
keep('e2e', r)

// 7. Going in circles: the same failure while the test flips between two versions.
const fail = { kind: 'check', label: S.e2e.check, pass: false, sig: 'e1', sigText: 'expected 200, received 404 · POST /invites/accept, second click', fails: 1 }
const flip = ver => ({ kind: 'edit', label: 'Edit e2e/invites.spec.ts', file: 'e2e/invites.spec.ts', ver })
for (const o of [flip('a'), fail, flip('b'), fail, flip('a'), fail, flip('b'), fail]) {
  wait(2)
  const seen = observe(r, o, t())
  r = seen.run
  if (seen.note && !said.stuck) said.stuck = seen.note
}
if (!r.traps.some(x => x.end === undefined)) throw new Error('e2e should be marked stuck')
r = spend(r, 2.2, 150_000)
keep('stuck', r)
wait(1)
// The overseer, a read-only Opus agent, answers at the stuck mark's second note (register.tsx, overseerAnswered).
const trap = r.traps.find(x => x.end === undefined)
const answer = 'The test is right and the code is wrong. accept marks the token used before addMember() runs, and addMember() throws for a second team, so the retry finds a used token and answers 404. Go back to api and mark the token used only after the member is added. Run npm test -- invites, then the e2e.'
r = {
  ...r,
  looks: [...(r.looks ?? []), { state: 'e2e', why: 'stuck', trap: trap.step, at: now, word: 'wrong', line: answer }],
  log: [...r.log, { t: t(), icon: '!', tone: 'warn', text: `e2e · overseer: wrong · ${answer.slice(0, 140)}` }],
}
said.overseer = `[sentinel] Sentinel's overseer, a read-only agent, looked at the stuck mark on e2e and says it is stuck:\n${answer}\nThis does not stop the run. Try what it says. Record what you found with "decide" and the topic "stuck on e2e", and go on.`
said.overseerToast = 'Sentinel: the overseer found something on e2e'
keep('overseer', r)
wait(1)

// 8. Back along the loop: api reopens, and e2e with it, as e2e needs api. form and email stay done.
out = go(r, { action: 'advance', to: 'api', evidence: 'The overseer is right: accept marks the token used before addMember() runs, so a failed add leaves a used token. The fix is in api.' })
r = out.run
said.loop = out.text
keep('loop', r)
wait(3)
r = edit(r, 'src/api/invites/accept.ts', 'v3')
wait(1)
r = pass(r, S.api.check)
prove('invites-api', S.api.check)
out = go(r, { action: 'advance', to: 'e2e', outcome: 'The token is marked used only after the member is added.' }, proof(S.api.check))
r = out.run
said.again = out.text
keep('again', r)
wait(2)
r = pass(r, S.e2e.check)
prove('invites-e2e', S.e2e.check)
out = go(r, { action: 'advance', to: 'docs', outcome: 'Invite, accept, a second click on a used link, and an expired link all behave.' }, proof(S.e2e.check))
r = spend(out.run, 1.3, 80_000)
said.docs = out.text
keep('docs', r)
wait(1)

// 9. docs waits for your OK. You approve and go hands-free; Claude's calls from then on are listed.
out = go(r, { action: 'propose', intent: 'A page in the admin guide: how to invite, the 7-day expiry, and that each link works once.' })
r = out.run
said.proposed = out.text
keep('asks', r)
wait(2)
r = heard(handsFree(r, true, t()), now)
r = { ...r, log: [...r.log, { t: t(), icon: '✓', tone: 'ok', text: 'docs · approved from the dashboard' }] }
said.approved = `[sentinel] The user approved your proposal for docs from the dashboard. Go ahead with it. ${HANDS_FREE}`
keep('free', r)
wait(2)
out = go(r, { action: 'decide', topic: 'Where the page goes', choice: 'docs/invites.md, linked from the admin guide index', reason: 'admins already look there for team settings' })
r = edit(out.run, 'docs/invites.md')
said.decided = out.text
keep('decided', r)
wait(2)

// 10. Final checks: every check runs again before the plan completes.
const checks = sweepChecks(r)
keep('final', { ...r, sweep: { going: checks.slice(2), passed: 2, failed: 0, total: checks.length } })
wait(1)
const proofs = Object.fromEntries(checks.map(c => [c, { pass: true, sigText: '' }]))
out = go(r, { action: 'advance', to: 'done', evidence: 'docs/invites.md covers inviting, the expiry and one-time links.', outcome: 'An admin guide page on invites.' }, proofs)
r = spend(out.run, 0.4, 20_000)
said.done = out.text
keep('done', r)

// 11. The Library, after the plan. You ask in the chat, and Claude runs the command with your words.
keep('library', r)
said.libAsk = 'turn fails-without-change on for this project, I want the stricter check here'
said.libReply = 'fails-without-change is on for this project. Undo: /sentinel off fails-without-change'
said.libToast = 'Sentinel: Claude ran /sentinel on fails-without-change, as you asked'
const after = library({ on: { 'fails-without-change': true } }, 'full-stack')
keep('library-on', r, { flowSaid: { at: now, ok: true, text: said.libReply } }, after)

// 12. The System tab, with each part green where a check proved it.
keep('system', r, {}, after)

// ---- what each chapter needs, so a story change can't quietly drop it ----
const need = (cond, what) => {
  if (!cond) throw new Error(`demo: ${what}`)
}
const D = name => moments[name].vm
need(D('draft').draftLibrary?.preset?.name === 'full-stack', 'the draft lost the preset pick')
need(D('draft').points?.length === 4, 'the draft lost the points you asked for')
need(D('draft').settingRows?.some(x => x.states.includes('docs')), 'the draft lost the lighter step')
need(D('locked').states.filter(s => s.needs?.length).length >= 5, 'the plan lost its side-by-side steps')
need(Object.keys(D('briefed').members).length === 2, 'both helpers should be at work')
need(['form', 'email'].every(id => D('email-in').states.find(s => s.id === id)?.status === 'done'), 'both helpers should be in')
need(D('failed').states.find(s => s.id === 'api')?.status !== 'done', 'the refused advance moved on')
need(D('stuck').trap, 'e2e should show as stuck')
need(D('overseer').looks.some(l => l.state === 'e2e' && l.word === 'wrong' && l.line?.includes('marks the token used')), "the overseer's answer is missing")
need(D('loop').active?.id === 'api' && D('loop').loops.find(l => l.from === 'e2e' && l.to === 'api')?.count === 1, 'the way back should be taken once')
need(['form', 'email'].every(id => D('loop').states.find(s => s.id === id)?.status === 'done'), 'the loop should leave form and email done')
need(D('asks').waiting && D('free').states, 'docs should wait for your OK')
need(D('final').sweep, 'the final checks are missing')
need(D('done').phase === 'complete', `the plan should complete (phase ${D('done').phase})`)
need(D('done').usage?.windows?.length, 'the usage figures are missing')
need(D('system').system?.tally?.tested === 5, 'the System map should show the five proved parts')

writeFileSync(new URL('./data/demo.json', import.meta.url), JSON.stringify({ moments, said, ask: ASK }))
console.log(`wrote data/demo.json: ${Object.keys(moments).length} moments`)

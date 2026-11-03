// Plays the runs the README clips show through Sentinel's own logic (hooks/core.ts) and saves, for each moment a clip
// needs, what the dashboard receives and what Sentinel says: node docs/media/src/runs.mjs. Node runs the TypeScript as is.
import { writeFileSync } from 'node:fs'
import { act, addFlow, besideNote, briefRefusal, emptyRun, flowOf, fnv, HANDS_FREE, handsFree, healthWord, heard, laneCall, laneDone, libraryOn, lockDraft, memberIn, observe, outOfScope, recordStart, startMember, summarize } from '../../../hooks/core.ts'
import { BUILTIN_FLOWS, BUILTINS } from '../../../hooks/builtins.ts'

const MIN = 60_000
// A fixed morning, so the clips show the same times on every render.
let now = new Date(2026, 10, 3, 9, 12).getTime()
const t = () => new Date(now).toTimeString().slice(0, 5)
const wait = min => (now += min * MIN)

// The line Sentinel shows above the prompt, as hooks/views.tsx words it (renderBand, for the cases these runs reach).
function band(vm) {
  const a = vm.active, f = vm.flowDraft
  if (vm.phase === 'draft') return `Sentinel draft "${vm.title}": ${vm.states.length - 1} states, starts at ${a.id}. Check it, then lock it.`
  if ((!a || vm.phase !== 'live') && f) return `Sentinel: Claude drafted the flow "${f.name}" (${f.states.length} state${f.states.length === 1 ? '' : 's'}). Save it?`
  if (!a || vm.phase !== 'live') return ''
  const s = vm.sweep, c = vm.checking?.at(-1), hl = vm.health
  if (vm.paused) return `Sentinel is paused at ${a.id}.`
  if (vm.trap) return `Sentinel: stuck (${vm.trap.pattern}) in ${a.id}.`
  if (vm.waiting) return vm.waiting.kind === 'before' ? `Sentinel: ${a.id} asks for your OK before it starts. Reply in the chat.` : `Sentinel: ${a.id} is ready for your review. Reply in the chat.`
  if (s) return `Sentinel: final checks · ${s.passed} of ${s.total} passed${s.going.length ? ` · running ${s.going.join(', ')}` : ''}`
  if (c) return `Sentinel: ${a.id} ${a.pos}/${a.of} · running the check · ${c.ms < MIN ? 'under a minute' : `${Math.floor(c.ms / MIN)} min`}`
  return `Sentinel: ${a.id} ${a.pos}/${a.of}${hl ? ` · H ${hl.H.toFixed(2)} ${healthWord(hl.H)}` : ''}`
}

// The Library as the plugin's snapshot carries it (register.tsx, libraryView): the built-ins and the project's own
// instructions with their switches worked out from the two switches files, and the flows, built-in ones without a file.
const BUILT_FLOWS = BUILTIN_FLOWS.map(f => ({ ...f, scope: 'built-in', trusted: true }))
function library(project = {}, personal = {}, own = [], flows = BUILT_FLOWS) {
  const items = [...BUILTINS.map(b => ({ ...b, scope: 'built-in', trusted: true })), ...own.map(i => ({ kind: 'told', trusted: true, ...i }))]
  const { weight, on } = libraryOn([...items, ...flows], project, personal)
  return {
    library: { weight, project, personal, instructions: items.map(i => ({ ...i, on: on.includes(i.name) })), flowsOn: Object.fromEntries(flows.map(f => [f.name, on.includes(f.name)])) },
    flows,
  }
}
// What a plan is locked with (register.tsx, planLibrary): the weight, every item on, and the instructions Claude is told.
function planLib({ library: l }, off = []) {
  const on = [...l.instructions.filter(i => i.on).map(i => i.name), ...Object.keys(l.flowsOn).filter(n => l.flowsOn[n])].filter(n => !off.includes(n))
  const told = l.instructions.filter(i => i.kind === 'told' && on.includes(i.name)).map(({ name, description, at, files, text }) => ({ name, ...(description ? { description } : {}), at, ...(files ? { files } : {}), text }))
  return { weight: l.weight, on, told }
}

// What the page gets: the view model, plus the fields the plugin adds when it writes the page (register.tsx).
const page = (r, lib = library()) => ({ ...summarize(r), savedAt: now, parallel: false, members: {}, ...lib, ...(r.draft ? { draftKey: fnv(JSON.stringify(r.draft)), draftLibrary: r.draft.library } : {}) })
const ok = out => {
  if (out.ok === false) throw new Error(out.text)
  return out
}

function partialRefunds() {
  const moments = {}, said = {}
  const keep = (name, r) => {
    const vm = page(r)
    moments[name] = { now, vm, band: band(vm) }
  }
  let r = { ...emptyRun(), signedOff: true }
  const plan = {
    action: 'define', title: 'Partial refunds',
    states: [
      { id: 'explore', label: 'Read payments code', title: 'Find where refunds attach', problem: 'Refunds are all or nothing today.', approach: 'Read the payments service and its ledger.' },
      { id: 'service', label: 'RefundService', check: 'npm test -- refund', files: ['src/refund*.ts'], title: 'Refund part of a payment', problem: 'A refund always returns the whole amount.', approach: 'Add an amount to RefundService and record each part in the ledger.' },
      { id: 'verify', label: 'Full suite', check: 'npm test', title: 'Nothing else broke', problem: 'Refunds touch billing code other features use.', approach: 'Run the whole suite.' },
    ],
  }
  let out = ok(act(r, plan, t(), {}, now))
  r = out.run
  said.locked = out.text
  keep('locked', r)
  wait(3)
  r = observe(r, { kind: 'look', label: 'Read src/payments/capture.ts', fp: 'a' }, t()).run
  wait(2)
  r = observe(r, { kind: 'look', label: 'Read src/billing/ledger.ts', fp: 'b' }, t()).run
  wait(1)
  out = ok(act(r, { action: 'advance', to: 'service', evidence: 'Refunds attach after capture; the ledger books each one.' }, t(), {}, now))
  said.service = out.text
  // Entering service, Sentinel runs its check once: it has to fail before the work.
  r = recordStart(out.run, 'npm test -- refund', false, t()).run
  keep('service', r)
  wait(4)
  r = observe(r, { kind: 'edit', label: 'Edit src/refund.ts', file: 'src/refund.ts', ver: 'v1' }, t()).run
  keep('working', r)
  wait(2)
  said.refused = outOfScope(r, 'src/billing/ledger.ts')
  r = observe(r, { kind: 'edit', label: 'Edit src/billing/ledger.ts', file: 'src/billing/ledger.ts', denied: true }, t()).run
  keep('refused', r)
  wait(1)
  out = ok(act(r, { action: 'amend', files: ['src/billing/ledger.ts'], reason: 'Each part of a refund is booked in the ledger.' }, t(), {}, now))
  r = out.run
  said.amended = out.text
  keep('amended', r)
  wait(2)
  r = observe(r, { kind: 'edit', label: 'Edit src/billing/ledger.ts', file: 'src/billing/ledger.ts', ver: 'v1' }, t()).run
  keep('edited', r)
  wait(1)
  keep('checking', { ...r, checking: [{ label: 'npm test -- refund', ids: ['service'], at: now, ms: 20_000 }] })
  r = observe(r, { kind: 'check', label: 'npm test -- refund', pass: false, sig: 'f1', sigText: 'expected 49.99, received 50.00', fails: 1, tail: 'Tests: 1 failed, 11 passed' }, t()).run
  out = act(r, { action: 'advance', to: 'verify' }, t(), {}, now)
  if (out.ok !== false) throw new Error('the advance should be refused')
  said.failed = out.text
  r = observe(r, { kind: 'plan', label: 'plan advance → verify', denied: true }, t()).run
  keep('failed', r)
  wait(2)
  r = observe(r, { kind: 'edit', label: 'Edit src/refund.ts', file: 'src/refund.ts', ver: 'v2' }, t()).run
  keep('fixed', r)
  wait(1)
  keep('checking2', { ...r, checking: [{ label: 'npm test -- refund', ids: ['service'], at: now, ms: 20_000 }] })
  r = observe(r, { kind: 'check', label: 'npm test -- refund', pass: true, sig: '', sigText: '', fails: 0 }, t()).run
  out = ok(act(r, { action: 'advance', to: 'verify', outcome: 'RefundService takes an amount, and the ledger books each part.' }, t(), { 'npm test -- refund': { pass: true, sigText: '' } }, now))
  r = out.run
  said.verify = out.text
  keep('verify', r)
  wait(3)
  r = observe(r, { kind: 'check', label: 'npm test', pass: true, sig: '', sigText: '', fails: 0 }, t()).run
  keep('final', { ...r, sweep: { going: ['service', 'verify'], passed: 0, failed: 0, total: 2 } })
  wait(1)
  const proofs = { 'npm test': { pass: true, sigText: '' }, 'npm test -- refund': { pass: true, sigText: '' } }
  out = ok(act(r, { action: 'advance', to: 'done', outcome: 'The whole suite passes.' }, t(), proofs, now))
  said.done = out.text
  keep('done', out.run)
  return { moments, said }
}

// The user approves the first proposal and goes hands-free; the run then makes its own calls and lists them.
function csvExport() {
  const moments = {}, said = {}
  const keep = (name, r) => {
    const vm = page(r)
    moments[name] = { now, vm, band: band(vm) }
  }
  const go = (r, i, proofs = {}) => ok(act(r, i, t(), proofs, now))
  const pass = (r, check) => observe(r, { kind: 'check', label: check, pass: true, sig: '', sigText: '', fails: 0 }, t()).run
  const edit = (r, file, ver = 'v1') => observe(r, { kind: 'edit', label: `Edit ${file}`, file, ver }, t()).run
  let r = { ...emptyRun(), signedOff: true }
  let out = go(r, {
    action: 'define', title: 'CSV export for reports',
    states: [
      { id: 'columns', label: 'Agree the columns', wait: 'before', title: 'Agree what a row holds', problem: 'Nobody has said which fields an export carries.', approach: 'Propose the columns and their order.' },
      { id: 'api', label: 'Export endpoint', check: 'npm test -- export', files: ['src/api/export*.ts'], title: 'Stream reports as CSV', problem: 'Reports only come back as JSON.', approach: 'Add an endpoint that streams one row per report.' },
      { id: 'button', label: 'Download button', check: 'npm test -- ui', files: ['src/ui/Export*.tsx'], wait: 'after', title: 'Download from the reports page', problem: 'The export has no way in from the page.', approach: 'Add a button that calls the endpoint.' },
      { id: 'docs', label: 'API docs', wait: 'before', files: ['docs/api.md'], title: 'Document the endpoint', problem: 'The API docs do not mention exports.', approach: 'Add the endpoint and its columns to the docs.' },
    ],
  })
  r = out.run
  said.locked = out.text
  keep('locked', r)
  wait(1)
  out = go(r, { action: 'propose', intent: 'One row per report: date, report, owner, total. UTF-8 with a header row.' })
  r = out.run
  said.proposed = out.text
  keep('asks', r)
  wait(2)
  // The dashboard's "Approve and go hands-free" (register.tsx): hands-free on, and the answer heard.
  r = heard(handsFree(r, true, t()), now)
  r = { ...r, log: [...r.log, { t: t(), icon: '✓', tone: 'ok', text: 'columns · approved from the dashboard' }] }
  // What Sentinel then tells Claude in the chat (register.tsx, the dashboard's answer).
  said.approved = `[sentinel] The user approved your proposal for columns from the dashboard. Go ahead with it. ${HANDS_FREE}`
  keep('free', r)
  wait(2)
  r = observe(r, { kind: 'look', label: 'Read src/reports/model.ts', fp: 'c' }, t()).run
  wait(1)
  out = go(r, { action: 'advance', to: 'api', evidence: 'The columns are agreed: date, report, owner, total.' })
  r = out.run
  keep('api', r)
  wait(6)
  r = edit(r, 'src/api/export.ts')
  wait(3)
  out = go(r, { action: 'decide', topic: 'Export route', choice: 'GET /reports/export streams the file', reason: 'large exports stay out of memory' })
  r = out.run
  said.decided = out.text
  keep('decided', r)
  wait(4)
  r = pass(r, 'npm test -- export')
  out = go(r, { action: 'advance', to: 'button', outcome: 'GET /reports/export streams one row per report.' }, { 'npm test -- export': { pass: true, sigText: '' } })
  r = out.run
  keep('button', r)
  wait(7)
  r = edit(r, 'src/ui/ExportButton.tsx')
  wait(2)
  r = pass(r, 'npm test -- ui')
  out = go(r, { action: 'advance', to: 'docs', outcome: 'The reports page has a Download CSV button.' }, { 'npm test -- ui': { pass: true, sigText: '' } })
  r = out.run
  said.reviewed = out.text
  keep('reviewed', r)
  wait(2)
  out = go(r, { action: 'propose', intent: 'Add GET /reports/export and its four columns to docs/api.md.' })
  r = out.run
  said.ahead = out.text
  keep('ahead', r)
  wait(4)
  r = observe(r, { kind: 'look', label: 'Read docs/api.md', fp: 'd' }, t()).run
  r = edit(r, 'docs/api.md')
  wait(1)
  const proofs = { 'npm test -- export': { pass: true, sigText: '' }, 'npm test -- ui': { pass: true, sigText: '' } }
  out = go(r, { action: 'advance', to: 'done', evidence: 'docs/api.md documents the endpoint.', outcome: 'The API docs cover the export.' }, proofs)
  said.done = out.text
  keep('done', out.run)
  return { moments, said }
}

// Claude flips a file between two versions while the same test fails; Sentinel calls it stuck, sends its note, and the
// run recovers once Claude reads something new.
function webhookRetry() {
  const moments = {}, said = {}
  const keep = (name, r) => {
    const vm = page(r)
    moments[name] = { now, vm, band: band(vm) }
  }
  let r = { ...emptyRun(), signedOff: true }
  let out = ok(act(r, {
    action: 'define', title: 'Retry failed webhooks',
    states: [
      { id: 'retry', label: 'Retry with backoff', check: 'npm test -- webhook', files: ['src/webhooks/*.ts'], title: 'Retry a failed delivery', problem: 'A failed webhook is dropped after one try.', approach: 'Retry three times with growing gaps.' },
      { id: 'verify', label: 'Full suite', check: 'npm test', title: 'Nothing else broke', problem: 'The queue is shared with email.', approach: 'Run the whole suite.' },
    ],
  }, t(), {}, now))
  said.locked = out.text
  r = recordStart(out.run, 'npm test -- webhook', false, t()).run
  const fail = { kind: 'check', label: 'npm test -- webhook', pass: false, sig: 's1', sigText: 'expected 3 attempts, received 4', fails: 1 }
  const edit = ver => ({ kind: 'edit', label: 'Edit src/webhooks/retry.ts', file: 'src/webhooks/retry.ts', ver })
  const steps = [edit('a'), fail, edit('b'), fail, edit('a'), fail, edit('b'), fail]
  steps.forEach((o, i) => {
    wait(2)
    const seen = observe(r, o, t())
    r = seen.run
    if (seen.note) said.note = seen.note
    keep(`c${i + 1}`, r)
  })
  wait(1)
  r = observe(r, { kind: 'look', label: 'Read src/webhooks/schedule.ts', fp: 'e' }, t()).run
  keep('read', r)
  wait(2)
  r = observe(r, edit('c'), t()).run
  keep('edit', r)
  wait(1)
  r = observe(r, { kind: 'check', label: 'npm test -- webhook', pass: true, sig: '', sigText: '', fails: 0 }, t()).run
  keep('passed', r)
  return { moments, said }
}

// Claude drafts a flow and the user saves it; then, checking the next plan's draft, the user adds it after a state.
function reviewFlow() {
  const moments = {}, said = {}
  const changelog = { name: 'changelog', description: 'Note the change for the next release', scope: 'personal', file: '~/.sentinel/flows/changelog.json', trusted: true, states: [{ id: 'note', label: 'Add a CHANGELOG entry', files: ['CHANGELOG.md'] }] }
  const review = flowOf({
    name: 'review', description: 'Lint, then a review you sign off',
    states: [
      { id: 'lint', label: 'Lint the change', check: 'npm run lint', title: 'The change passes lint', problem: 'Style slips in under pressure.', approach: 'Run the linter and fix what it finds.' },
      { id: 'read', label: 'Review the diff', wait: 'after', title: 'You read the change', problem: 'Some mistakes only a reader catches.', approach: 'Walk you through the diff and wait for your OK.' },
    ],
  })
  if (typeof review === 'string') throw new Error(review)
  const saved = { ...review, scope: 'project', file: '.sentinel/flows/review.json', trusted: true }
  // The user's flows list first, then the built-in ones, as the plugin loads them.
  const keep = (name, r, flows, extra = {}) => {
    const vm = { ...page(r, library({}, {}, [], [...flows, ...BUILT_FLOWS])), ...extra }
    moments[name] = { now, vm, band: band(vm) }
  }
  keep('before', emptyRun(), [changelog])
  keep('drafted', { ...emptyRun(), flowDraft: review }, [changelog])
  wait(1)
  said.saved = `Saved the flow "review" to .sentinel/flows/review.json.`
  keep('saved', emptyRun(), [saved, changelog], { flowSaid: { at: now, ok: true, text: said.saved } })
  wait(3)
  const plan = {
    action: 'define', title: 'Webhook signatures',
    states: [
      { id: 'sign', label: 'Sign each delivery', check: 'npm test -- sign', files: ['src/webhooks/sign.ts'], title: 'Sign outgoing webhooks', problem: 'Receivers cannot tell a real delivery from a forged one.', approach: 'Add an HMAC header to each delivery.' },
      { id: 'api', label: 'Expose the secret', check: 'npm test -- settings', files: ['src/api/settings.ts'], title: 'Let users see their secret', problem: 'Receivers need the secret to check the header.', approach: 'Show it on the settings endpoint.' },
      { id: 'docs', label: 'Document it', files: ['docs/webhooks.md'], title: 'Explain how to verify', problem: 'Receivers need the steps.', approach: 'Add a section with an example.' },
    ],
  }
  // After /sentinel lock the run is signed off for review, and a define becomes the draft the user checks. The plugin
  // gives each new draft the Library as it stands.
  const draft = input => {
    const out = act({ ...emptyRun(), signedOff: true, review: true }, { ...input, library: planLib(library()) }, '', {}, now)
    if (!out.run.draft) throw new Error(`no draft: ${out.text}`)
    return out.run
  }
  keep('plan', draft(plan), [saved, changelog])
  wait(1)
  const added = addFlow(plan, review, { at: 'after', state: 'api' }, 'Added by you after api')
  if (typeof added === 'string') throw new Error(added)
  said.added = 'Added review after api.'
  keep('added', draft(added), [saved, changelog])
  return { moments, said }
}

// A larger plan in four groups, for the Map: the run works through api into ui, and a done state's page opens.
function teamInvites() {
  const moments = {}, said = {}
  const keep = (name, r) => {
    const vm = page(r)
    moments[name] = { now, vm, band: band(vm) }
  }
  const st = (group, id, label, check, file, title, problem, approach) => ({ id, label, group, check, files: [file], title, problem, approach })
  const plan = {
    action: 'define', title: 'Team invites', loops: [['e2e', 'accept']],
    states: [
      st('schema', 'table', 'Invites table', 'npm test -- db/invites', 'db/migrations/0042_invites.sql', 'Store invites', 'Nothing records who was invited to a team.', 'Add an invites table with a token and an expiry date.'),
      st('schema', 'down', 'Migration rolls back', 'npm run db:roundtrip', 'db/down/0042_invites.sql', 'Undo the table cleanly', 'A migration that only goes forward is hard to undo in production.', 'Write the down migration and run both ways.'),
      st('api', 'create', 'Send an invite', 'npm test -- invites/create', 'src/api/invites/create.ts', 'Invite someone by email', 'Only an admin can add people today, by hand.', 'Add an endpoint that stores the invite and sends the email.'),
      st('api', 'accept', 'Accept an invite', 'npm test -- invites/accept', 'src/api/invites/accept.ts', 'Join from the link', 'The link in the email has to add the person to the team.', 'Check the token, then add the member.'),
      st('api', 'expire', 'Expire old invites', 'npm test -- invites/expire', 'src/jobs/expire.ts', 'Old links stop working', 'An invite link should not work forever.', 'A nightly job expires invites older than 7 days.'),
      st('api', 'limit', 'Limit sends', 'npm test -- invites/limit', 'src/api/invites/limit.ts', 'No invite floods', 'One account could send thousands of emails.', 'Allow 50 invites a day per team.'),
      st('ui', 'form', 'Invite form', 'npm test -- InviteForm', 'src/ui/InviteForm.tsx', 'Invite from the team page', 'There is nowhere to type an email.', 'A form on the team page, with errors inline.'),
      st('ui', 'pending', 'Pending invites', 'npm test -- PendingList', 'src/ui/PendingList.tsx', 'See who has not joined', 'Admins cannot tell who still has to accept.', 'List pending invites with resend and cancel.'),
      st('ui', 'email', 'Invite email', 'npm test -- emails/invite', 'src/emails/invite.tsx', 'A clear email', 'The invite has to say who sent it and to which team.', 'A short email with one button.'),
      st('release', 'e2e', 'End-to-end', 'npm run e2e -- invites', 'e2e/invites.spec.ts', 'The whole path works', 'Each part passes alone, but nothing tests the path from email to team.', 'A browser test that invites, accepts and checks the team.'),
      st('release', 'flag', 'Behind a flag', 'npm test -- flags', 'src/flags.ts', 'Turn it on slowly', 'A problem should not reach every team at once.', 'Ship it behind a flag, off by default.'),
      st('release', 'docs', 'Document invites', 'npm run docs:check', 'docs/invites.md', 'Explain invites', 'Admins need to know the limits and the expiry.', 'Add a page to the admin guide.'),
    ],
  }
  const by = Object.fromEntries(plan.states.map(s => [s.id, s]))
  let out = ok(act({ ...emptyRun(), signedOff: true }, plan, t(), {}, now))
  said.locked = out.text
  let r = recordStart(out.run, by.table.check, false, t()).run
  const edit = (id, ver = 'v1') => {
    wait(2)
    r = observe(r, { kind: 'edit', label: `Edit ${by[id].files[0]}`, file: by[id].files[0], ver }, t()).run
  }
  const pass = (id, next, outcome) => {
    wait(1)
    r = observe(r, { kind: 'check', label: by[id].check, pass: true, sig: '', sigText: '', fails: 0 }, t()).run
    out = ok(act(r, { action: 'advance', to: next, outcome }, t(), { [by[id].check]: { pass: true, sigText: '' } }, now))
    r = recordStart(out.run, by[next].check, false, t()).run
    said[next] = out.text
  }
  edit('table'); pass('table', 'down', 'An invites table with a token, the team and an expiry date.')
  edit('down'); pass('down', 'create', 'The migration runs forward and back on a copy of the database.')
  edit('create'); edit('create', 'v2'); pass('create', 'accept', 'POST /teams/:id/invites stores the invite and sends the email.')
  edit('accept')
  wait(1)
  r = ok(act(r, { action: 'decide', topic: 'Expired link', choice: 'Answer 410 with a way to ask for a new invite', reason: 'A plain error leaves the person stuck.' }, t(), {}, now)).run
  wait(1)
  r = ok(act(r, { action: 'amend', files: ['src/api/teams/members.ts'], reason: 'Accepting an invite adds the member to the team.' }, t(), {}, now)).run
  wait(1)
  r = observe(r, { kind: 'edit', label: 'Edit src/api/teams/members.ts', file: 'src/api/teams/members.ts', ver: 'v1' }, t()).run
  pass('accept', 'expire', 'The link checks the token, adds the member, and answers 410 once it has expired.')
  keep('expire', r)
  edit('expire'); keep('expire-edit', r)
  pass('expire', 'limit', 'A nightly job expires invites after 7 days.'); keep('limit', r)
  edit('limit'); keep('limit-edit', r)
  pass('limit', 'form', 'Each team can send 50 invites a day; the 51st gets a 429.'); keep('form', r)
  edit('form'); keep('form-edit', r)
  return { moments, said }
}

// Parallel states: two states that only need explore go to member agents, each in a worktree of its own, while Claude
// works on index. A member's work comes back once its check passes there. The plugin's side of this (the worktree,
// the agent, the check run) is in hooks/register.tsx, brief and handBack; here the agents are named and their calls given.
function orderSearch() {
  const moments = {}, said = {}
  // The page gets each member's agent and start, as the plugin's snapshot writes them.
  const keep = (name, r) => {
    const members = Object.fromEntries(Object.entries(r.running ?? {}).map(([id, m]) => [id, { agent: m.agent, since: m.since }]))
    const vm = { ...page(r), parallel: true, members }
    moments[name] = { now, vm, band: band(vm) }
  }
  const st = (id, label, needs, check, file, title, problem, approach) => ({ id, label, needs, check, files: [file], title, problem, approach })
  const plan = {
    action: 'define', title: 'Order search',
    states: [
      { id: 'explore', label: 'Read the orders code', title: 'Find where orders are listed', problem: 'Finding an order means scrolling the whole list.', approach: 'Read the orders query, its route and the page.' },
      st('index', 'Search index', ['explore'], 'npm test -- orders/index', 'db/migrations/0051_order_search.sql', 'Make search fast', 'A search over every order would scan the whole table.', 'Add a text index on the customer, email and order number.'),
      st('api', 'Search endpoint', ['index'], 'npm test -- orders/search', 'src/api/orders/search.ts', 'Search from the API', 'Nothing answers a search today.', 'GET /orders/search with a query and filters, paged.'),
      st('filters', 'Filter chips', ['explore'], 'npm test -- OrderFilters', 'src/ui/OrderFilters.tsx', 'Narrow the list', 'Staff can only sort the list, not narrow it.', 'Chips for status, date and total, kept in the URL.'),
      st('empty', 'Empty and error states', ['explore'], 'npm test -- OrderEmpty', 'src/ui/OrderEmpty.tsx', 'Say when nothing matches', 'A search with no results shows a blank page.', 'A short message with a way to clear the filters.'),
      st('page', 'Search on the orders page', ['api', 'filters', 'empty'], 'npm test -- OrderSearch', 'src/ui/OrderSearch.tsx', 'Put it together', 'The parts have to work as one search box.', 'Wire the box, the chips and the states to the endpoint.'),
    ],
  }
  const by = Object.fromEntries(plan.states.map(s => [s.id, s]))
  let out = ok(act({ ...emptyRun(), signedOff: true }, plan, t(), {}, now))
  let r = out.run
  said.locked = out.text
  wait(2)
  r = observe(r, { kind: 'look', label: 'Read src/db/orders.ts', fp: 'a' }, t()).run
  wait(2)
  r = observe(r, { kind: 'look', label: 'Read src/ui/OrderList.tsx', fp: 'b' }, t()).run
  wait(1)
  out = ok(act(r, { action: 'advance', to: 'index', evidence: 'Orders come from listOrders() in src/db/orders.ts; the page is src/ui/OrderList.tsx.' }, t(), {}, now))
  r = recordStart(out.run, by.index.check, false, t()).run
  // With parallel states on, the plugin adds the states that can run beside Claude's own.
  said.index = [out.text, besideNote(r)].join('\n')
  keep('index', r)
  // brief: the refusals the plugin checks first, then a member in its worktree.
  const brief = (id, agent, text) => {
    const why = briefRefusal(r, { action: 'brief', to: id, brief: text }, true)
    if (why) throw new Error(why)
    const name = `sentinel-${id}-${agent}`
    r = startMember(r, id, { agent, name }, t(), now)
    said[id] = `Started a member agent for ${id} in .claude/worktrees/${name}/. Its answer comes back when it stops. Carry on with ${r.active}.`
  }
  const lane = (agent, label, file) => (r = laneCall(r, agent, '', { label, ...(file ? { file } : {}) }))
  wait(1)
  brief('filters', 'm1k2', 'Chips for status, date and total in OrderFilters.tsx, kept in the URL. Test that a chip narrows the list.')
  lane('m1k2', 'Read src/ui/OrderList.tsx')
  keep('one', r)
  brief('empty', 'm3p8', 'OrderEmpty.tsx: a message when nothing matches, with a button that clears the filters.')
  lane('m3p8', 'Read src/ui/OrderList.tsx')
  keep('briefed', r)
  wait(3)
  lane('m1k2', 'Write src/ui/OrderFilters.tsx', 'src/ui/OrderFilters.tsx')
  lane('m3p8', 'Write src/ui/OrderEmpty.tsx', 'src/ui/OrderEmpty.tsx')
  r = observe(r, { kind: 'edit', label: `Edit ${by.index.files[0]}`, file: by.index.files[0], ver: 'v1' }, t()).run
  keep('work', r)
  wait(2)
  lane('m1k2', 'Bash npm test -- OrderFilters')
  r = observe(r, { kind: 'check', label: by.index.check, pass: true, sig: '', sigText: '', fails: 0 }, t()).run
  out = ok(act(r, { action: 'advance', to: 'api', outcome: 'A text index on customer, email and order number.' }, t(), { [by.index.check]: { pass: true, sigText: '' } }, now))
  r = recordStart(out.run, by.api.check, false, t()).run
  said.api = [out.text, besideNote(r)].join('\n')
  keep('api', r)
  // The filters member stops. Its check passed in its worktree, so its file comes back and its state is done.
  wait(2)
  r = laneDone(memberIn(r, 'filters', 'Chips for status, date and total, kept in the URL.', t(), now), 'm1k2')
  said.filtersIn = [`[sentinel] filters is in: its member passed \`${by.filters.check}\` in its worktree. Sentinel applied its changes to the project: ${by.filters.files[0]}.`, besideNote(r), 'Continue with the plan.'].filter(Boolean).join('\n')
  keep('filters-in', r)
  wait(2)
  lane('m3p8', 'Bash npm test -- OrderEmpty')
  r = observe(r, { kind: 'edit', label: `Edit ${by.api.files[0]}`, file: by.api.files[0], ver: 'v1' }, t()).run
  keep('api-edit', r)
  wait(1)
  r = laneDone(memberIn(r, 'empty', 'A message when nothing matches, with a button that clears the filters.', t(), now), 'm3p8')
  said.emptyIn = [`[sentinel] empty is in: its member passed \`${by.empty.check}\` in its worktree. Sentinel applied its changes to the project: ${by.empty.files[0]}.`, besideNote(r), 'Continue with the plan.'].filter(Boolean).join('\n')
  keep('empty-in', r)
  return { moments, said }
}

// The Library: the user picks Thorough on the dashboard, then checks a draft. They tick one of Claude's answers beyond the
// brief, switch one instruction off for this plan only, and lock it. Claude then hears the instructions for its first state.
function rateLimits() {
  const moments = {}, said = {}
  const own = [{ name: 'api-errors', description: 'Errors a person can act on', at: 'start', files: ['src/api/**'], text: 'Every error the API returns carries a code and one sentence that says what to do next.', scope: 'project', file: '.sentinel/instructions/api-errors.json' }]
  const keep = (name, r, lib, extra = {}) => {
    const vm = { ...page(r, lib), ...extra }
    moments[name] = { now, vm, band: band(vm) }
  }
  const standard = library({}, {}, own)
  const thorough = library({ weight: 'thorough' }, {}, own)
  keep('standard', emptyRun(), standard)
  wait(1)
  said.weight = 'The weight is thorough for this project. The built-ins follow it; your own items keep their switches.'
  keep('thorough', emptyRun(), thorough, { flowSaid: { at: now, ok: true, text: said.weight } })
  wait(2)
  const plan = {
    action: 'define', title: 'Rate limits',
    states: [
      { id: 'limiter', label: 'Limit each key', check: 'npm test -- limit', files: ['src/api/limit.ts', 'tests/limit.test.ts'], title: 'Hold each key to 60 a minute', problem: 'One client can flood the API and slow it for everyone.', approach: 'A token bucket per API key, answering 429 with a Retry-After header.' },
      { id: 'load', label: 'Load test', check: 'npm run load -- limit', files: ['tests/load/limit.js'], title: 'Show the limit holds under load', problem: 'A limiter can pass its tests and still leak under real traffic.', approach: 'Send 5,000 requests a minute from 20 keys and count what gets through.' },
      { id: 'docs', label: 'Document the limits', files: ['docs/api.md'], title: 'Tell clients the limits', problem: 'Clients need to know the limit and what a 429 means.', approach: 'Add a section with the headers and an example.' },
    ],
    depth: [
      { id: 'load', ask: 'proof', text: 'A load test at 5,000 requests a minute shows the limit holds', state: 'load' },
      { id: 'raw', ask: 'raw', text: "Start from last week's spike of 429s in the gateway logs" },
    ],
  }
  const draft = l => {
    const out = act({ ...emptyRun(), signedOff: true, review: true }, { ...plan, library: l }, '', {}, now)
    if (!out.run.draft) throw new Error(`no draft: ${out.text}`)
    return out.run
  }
  keep('draft', draft(planLib(thorough)), thorough)
  wait(1)
  // The draft card's switch changes the plan's copy only (register.tsx, libplan).
  const copy = draft(planLib(thorough, ['measure-before-delete']))
  keep('copy', copy, thorough)
  wait(1)
  // Locked with "load" ticked, so its state stays (register.tsx, lockNow). Entering limiter, the check has to fail first.
  const run = recordStart(lockDraft(copy, t(), now), 'npm test -- limit', false, t()).run
  said.locked = `Locked "${run.plan.title}" at ${run.active}.`
  said.status = ok(act(run, { action: 'status' }, t(), {}, now)).text
  keep('locked', run, thorough)
  return { moments, said }
}

const write = (name, data) => {
  writeFileSync(new URL(`./data/${name}.json`, import.meta.url), JSON.stringify(data))
  console.log(`wrote data/${name}.json`)
}
write('run', partialRefunds())
write('free', csvExport())
write('stuck', webhookRetry())
write('flows', reviewFlow())
write('map', teamInvites())
write('parallel', orderSearch())
write('library', rateLimits())

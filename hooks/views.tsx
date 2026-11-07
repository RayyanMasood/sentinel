// The pane's three views. Each draws from summarize(run), the same model the browser page reads.
import { K, SYM, VIEWS, healthTone, healthWord, ruleText, shortCount, tokenSplit, tokensOf, type Status, type VM } from './core'
import type { InstructionAt, MapNode, MapRoll, MapTone, PartStatusName, Tone, View } from '../types'

// The surface's element table, from $.ui.resolve(e).
type Els = { Box: any; Text: any; Button: any }
type Part = string | false | undefined | [string, Tone?, boolean?]
type Loop = VM['loops'][number]

export type PaneActions = { pick: (v: View) => void; browser: () => void }
// asking: Sentinel's question is open in the dialog now. answer asks it again, after Esc.
export type BandActions = { open: (focus: boolean) => void; lock: () => void; keep: (state: string) => void; takeOut: (state: string) => void; setRow: (row: string, keep: boolean) => void; resume: () => void; answer: () => void; closed?: string; answerClosed?: () => void; asking: boolean; system?: () => void; saveFlow: (scope: 'project' | 'personal') => void; discardFlow: () => void }

// The band above the prompt: what needs you, or where the plan stands, with the buttons to act on it.
// No hotkeys: a bare digit in an empty prompt would press them while you start a message.
export function renderBand(el: Els, vm: VM, on: BandActions) {
  const { Box, Text, Button } = el
  const a = vm.active
  const f = vm.flowDraft
  const live = !!a && vm.phase !== 'none' && vm.phase !== 'complete'
  // With nothing running, the update check's finding: parts whose files changed since the map was drawn.
  const drifted = vm.system?.drift?.count ?? 0
  // A question of Claude's that the user closed with Esc. The old state stands, so it waits behind what needs them in the plan.
  const closed: [string, Tone, [string, string, () => void][]] | undefined = on.closed && !on.asking ? [`Sentinel: ${on.closed} You closed this question.`, 'warn', [['answer', 'Answer', on.answerClosed!]]] : undefined
  if (!live && !f && !drifted && !closed) return undefined
  const hl = vm.health
  // The parts of the system map Claude is working on, two at most.
  const here = vm.system?.here.map(p => p.name) ?? []
  const inside = here.length ? ` · in ${here.length > 2 ? `${here.slice(0, 2).join(', ')} and ${here.length - 2} more` : and(here)}` : ''
  // What Claude added waits for an answer, one at a time, before the draft asks to be locked.
  const added = vm.phase === 'draft' ? vm.states.find(s => s.added && !s.okAt) : undefined
  // So does a setting looser than the plan. A lock with it unanswered keeps the plan's weight.
  const loose = vm.phase === 'draft' ? vm.settingRows?.find(x => x.owed) : undefined
  type Band = [string, Tone, [string, string, () => void][]]
  // A flow or an instruction Claude drafted waits behind what needs you in the plan, and ahead of where it stands.
  const flow: Band | undefined = f && [`Sentinel: Claude drafted ${'states' in f ? `the flow "${f.name}" (${count(f.states.length, 'state')})` : `the instruction "${f.name}"`}. Save it?`, 'ask',
    [['fproj', 'Save to project', () => on.saveFlow('project')], ['fpers', 'Save personal', () => on.saveFlow('personal')], ['fdrop', 'Discard', on.discardFlow]]]
  const drift: Band | undefined = drifted && !live && !f ? [`Sentinel: ${count(drifted, 'part')} changed since the map was drawn.`, 'warn', [['system', 'System', on.system ?? (() => on.open(false))]]] : undefined
  const [text, tone, buttons]: Band = closed && (!a || !live) ? closed : drift ? drift : !a || !live ? flow!
    : added ? [`Sentinel: Claude added ${added.id}, and nothing asks for it. "${added.added}"`, 'warn', [['keep', 'Keep it', () => on.keep(added.id)], ['takeout', 'Take it out', () => on.takeOut(added.id)]]]
    : loose ? [`Sentinel: Claude asks for ${loose.kind === 'plan' ? (loose.weight ? `this plan on ${loose.weight}` : `${loose.name} off for this plan`) : `${loose.states.join(', ')} on ${loose.weight}`}, looser than the plan. "${loose.why ?? ''}"`, 'warn', [['keep', 'Keep it', () => on.setRow(loose.id, true)], ['takeout', loose.weight ? `Use ${vm.planWeight}` : 'Leave it on', () => on.setRow(loose.id, false)]]]
    : vm.phase === 'draft' ? [`Sentinel draft "${vm.title}": ${vm.states.length - 1} states, starts at ${a.id}. Check it, then lock it.`, 'warn', [['review', 'Review', () => on.open(true)], ['lock', 'Lock', on.lock]]]
    : vm.paused ? [`Sentinel is paused at ${a.id}.`, 'warn', [['resume', 'Resume', on.resume], ['open', 'Open', () => on.open(false)]]]
    : vm.blocked ? [`Sentinel: needs you on ${a.id}. ${vm.blocked.what}`, 'warn', [['open', 'Open', () => on.open(true)]]]
    : vm.trap ? [`Sentinel: stuck (${vm.trap.pattern}) in ${a.id}.`, 'err', [['open', 'Open', () => on.open(true)]]]
    : vm.waiting && on.asking ? [`Sentinel: ${a.id} is asking for your ${vm.waiting.kind === 'before' ? 'OK' : 'review'} in the question box.`, 'warn', [['open', 'Open', () => on.open(true)]]]
    : vm.waiting ? [vm.waiting.kind === 'before' ? `Sentinel: ${a.id} asks for your OK before it starts.` : `Sentinel: ${a.id} is ready for your review.`, 'warn', [['answer', 'Answer', on.answer], ['open', 'Open', () => on.open(true)]]]
    : closed ? closed
    : flow ? flow
    : vm.sweep ? [`Sentinel: final checks · ${sweepLine(vm.sweep)}`, 'acc', [['open', 'Open', () => on.open(false)]]]
    : vm.checking?.length ? [`Sentinel: ${a.id} ${a.pos}/${a.of}${inside} · ${checkLine(vm.checking.at(-1)!)}`, vm.checking.at(-1)!.quiet ? 'warn' : 'dim', [['open', 'Open', () => on.open(false)]]]
    : [`Sentinel: ${a.id} ${a.pos}/${a.of}${inside}${hl ? ` · H ${hl.H.toFixed(2)} ${healthWord(hl.H)}` : ''}`, 'dim', [['open', 'Open', () => on.open(false)]]]
  return (
    <Box flexDirection="row" gap={1}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end" {...(tone === 'dim' ? { dimColor: true } : { color: COLOR[tone] })}>{text}</Text>
      </Box>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {buttons.map(([key, label, press]) => <Button key={key} label={label} onPress={press} />)}
      </Box>
    </Box>
  )
}

// The final checks so far: "14 of 20 passed · 1 failing · running pc-gate, pake-ui".
export const sweepLine = (s: NonNullable<VM['sweep']>) =>
  `${s.passed} of ${s.total} passed${s.failed ? ` · ${s.failed} failing` : ''}${s.going.length ? ` · running ${s.going.join(', ')}` : ''}`

// The check running now: "running the check · 3 min · quieter than usual".
export const checkLine = (c: NonNullable<VM['checking']>[number]) =>
  `running the check · ${c.ms < 60_000 ? 'under a minute' : `${Math.floor(c.ms / 60_000)} min`}${c.quiet ? ' · quieter than usual' : ''}`

// A list inside a sentence: "a and b", "a, b and c".
const and = (xs: string[]) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const COLOR: Record<Exclude<Tone, 'dim'>, string> = { ok: 'success', err: 'error', warn: 'warning', acc: 'claude', ask: 'suggestion' }
const NAMES: Record<View, string> = { focus: 'Focus', map: 'Map', ledger: 'Ledger', system: 'System' }
// How each part reads on the System tab: its mark, its words and its colour. Group colours follow the page's.
const PART: Record<PartStatusName, [string, string, Tone?]> = {
  planned: ['○', 'Not built', 'dim'], exists: ['●', 'Already there'], change: ['◐', 'Will change', 'acc'], now: ['▶', 'Claude is here', 'acc'],
  tested: ['✓', 'Tested', 'ok'], changed: ['↻', 'Changed since test', 'warn'], untested: ['·', 'Untested', 'warn'], failing: ['×', 'Check failing', 'err'],
  needs: ['⚑', 'Needs you', 'ask'], outside: ['◇', 'Outside the project', 'dim'], dropped: ['–', 'Dropped', 'dim'],
}
const ROLL_TONE: Record<MapTone, Tone | undefined> = { red: 'err', amber: 'warn', blue: 'acc', dashed: 'dim', plain: undefined, green: 'ok', neutral: undefined }
const TAG: Record<string, string> = {
  skipped: 'Skipped by you', 'not-finished': 'Not finished', 'not-rechecked': 'Not rechecked', once: 'Checked once', reopened: 'Reopened by the final checks',
  'no-git': 'No git here, so changes cannot be detected', 'no-files': 'No files to check', 'changed-since-drawn': 'Changed since drawn', 'files-gone': 'Files gone',
}
const EVIDENCE = { seen: 'seen in ', said: 'said by you: ', guess: 'guessed: ' }
const LINES_SHOWN = 12
const FILES_SHOWN = 3
const LOOSE_SHOWN = 5
const PLANS_SHOWN = 5
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// "3 Nov 2026", in UTC so every machine reads a plan's day the same way.
const dayOf = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at.slice(0, 10) : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
// "a, b, c and 2 more": the first few of a list, and how many it left out.
const clipList = (xs: string[], n: number) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '))
const clipped = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// "2 parts · 1 Not built · 1 Claude is here": how many of a group's parts stand each way, in the order a part goes through.
const rollText = (roll: MapRoll) =>
  [`${roll.total} part${roll.total === 1 ? '' : 's'}`, ...(Object.keys(PART) as PartStatusName[]).filter(k => k !== 'outside' && k !== 'dropped' && roll.counts[k]).map(k => `${roll.counts[k]} ${PART[k][1]}`)].join(' · ')
const MOMENT: Record<InstructionAt, string> = {
  draft: 'while Claude drafts a plan', start: 'as a state that edits its files starts', close: 'before such a state advances, told at its start',
  final: 'before the plan completes', always: 'every turn',
}
const STATUS_TONE: Record<Status, Tone> = { done: 'ok', active: 'acc', trap: 'warn', running: 'acc', todo: 'dim' }
const AUDIT_ICON: Record<string, [string, Tone]> = {
  refused: ['×', 'err'], blocked: ['⊘', 'warn'], decided: ['◆', 'acc'], amended: ['+', 'warn'],
  auto: ['↻', 'warn'], asked: ['?', 'ask'], escalated: ['⚑', 'acc'],
}
const BARS = '▁▂▃▄▅▆▇█'
const base = (f: string) => f.split('/').pop() ?? f
const symOf = (s: { id: string; status: Status }) => (s.id === 'done' ? (s.status === 'done' ? '■' : '□') : SYM[s.status])

export function renderPane(el: Els, vm: VM, view: View, on: PaneActions) {
  const { Box, Text, Button } = el
  const style = (tone?: Tone, bold?: boolean) => ({
    ...(tone === 'dim' ? { dimColor: true } : tone ? { color: COLOR[tone] } : {}),
    ...(bold ? { bold: true } : {}),
  })
  const line = (...parts: Part[]) => (
    <Text wrap="truncate-end">
      {parts
        .filter((p): p is Exclude<Part, false | undefined> => p !== false && p !== undefined && p !== '')
        .map(p => (typeof p === 'string' ? p : <Text {...style(p[1], p[2])}>{p[0]}</Text>))}
    </Text>
  )
  const gap = () => <Text> </Text>
  const spread = (left: unknown, right: unknown) => (
    <Box flexDirection="row" justifyContent="space-between">
      {left}
      {right}
    </Box>
  )
  const spark = (n: number): Part[] => vm.spark.slice(-n).map(h => [BARS[Math.min(7, Math.floor(Math.max(0, h) * 7.999))]!, healthTone(h)])
  const rail = () => line(...vm.states.flatMap((s, i): Part[] => [i ? ' ' : '', [symOf(s) + s.id, STATUS_TONE[s.status], s.status === 'active' || s.status === 'trap']]))
  const total = vm.spend.reduce((a, s) => a + tokensOf(s), 0)
  const split = tokenSplit(vm.spend)
  const parts = `${shortCount(split.cached)} cached in · ${shortCount(split.uncached)} uncached in · ${shortCount(split.out)} out`
  const models = [...new Set(vm.spend.map(s => s.model))].join(', ')
  // A row of its own under the tokens, as they already fill their line.
  const usageRows = (label: string) => vm.usage
    ? [line([label, 'dim'], [...vm.usage.windows.map(w => `${w.name === 'Week' ? 'week' : w.name} ${w.percent}%`), ...(vm.usage.plan ? [`this plan ${vm.usage.plan}`] : [])].join(' · '))]
    : []

  const auditRows = (all: boolean) => {
    const rows = []
    const handled = vm.audit.length
    rows.push(line(['handled without asking you', 'dim'], [`  ${handled}`, 'dim']))
    if (!handled) rows.push(line([' nothing yet', 'dim']))
    for (const a of all ? vm.audit : vm.audit.slice(-4)) {
      const [icon, tone] = AUDIT_ICON[a.kind] ?? ['·', 'dim']
      rows.push(line([` ${icon} `, tone], [`s${a.step}`.padEnd(5), 'dim'], a.text))
    }
    for (const a of vm.asked) rows.push(line([a.kind === 'asked' ? ' ? ' : ' ⚑ ', a.kind === 'asked' ? 'ask' : 'acc'], [`s${a.step}`.padEnd(5), 'dim'], a.kind === 'asked' ? `asked you: ${a.text}` : `escalated ${a.text}`))
    return rows
  }

  // Helper agents, one line each (running or done, its state, calls and edits) and its last call beneath. Apart from the health numbers.
  const laneRows = () => vm.lanes.length ? [
    line(['helper agents', 'dim'], [`  ${vm.lanes.filter(l => l.running).length} running`, 'dim']),
    ...vm.lanes.slice(-6).flatMap(l => [
      line([l.running ? ' ▶ ' : ' ✓ ', l.running ? 'acc' : 'ok'], [l.name.slice(0, 20).padEnd(21), undefined, true], [l.state.padEnd(12), 'dim'], [`${count(l.calls, 'call')} · ${count(l.edits.length, 'edit')}`]),
      line([`     ${l.last}`, 'dim']),
    ]),
    gap(),
  ] : []

  const none = () => [
    line(['No plan locked.', undefined, true]),
    vm.signedOff
      ? line(['Signed off. Waiting for the model to define the plan.', 'acc'])
      : line(['Approve a plan in plan mode, or agree on one in chat', 'dim']),
    vm.signedOff ? gap() : line(['and type /sentinel lock.', 'dim']),
  ]

  const focus = () => {
    const a = vm.active!
    const beside = vm.states.filter(s => s.status === 'running').map(s => s.id)
    const rows = [
      spread(line(vm.paused ? ['PAUSED  ', 'warn'] : ['NOW  ', 'dim'], [a.id, a.status === 'trap' ? 'warn' : 'acc', true]), line([`${a.pos} of ${a.of} · step ${vm.step}`, 'dim'])),
      line(a.label),
      rail(),
      gap(),
      ...askedRows(vm.states.find(s => s.id === a.id)),
      ...(vm.blocked ? [field('needs you', vm.blocked.what, 'warn')] : []),
      ...(vm.waiting ? [field('waits', vm.waiting.kind === 'before' ? 'for your OK on its proposal' : 'for your review', 'warn')]
        : a.wait && !vm.replied ? [field('asks', a.wait === 'after' ? 'for your review once it is done' : 'for your OK before it starts', 'dim')] : []),
      field('check', a.check ? `${a.check} passes` : 'evidence and a first read (no check)'),
      field('files', a.files.length ? a.files.join(', ') : 'none in this state', a.files.length ? undefined : 'dim'),
      ...(a.ref ? [field('see', a.ref, 'dim')] : []),
      ...(beside.length ? [field('beside', `${and(beside)} ${beside.length > 1 ? 'run' : 'runs'} in member agents`, 'acc')] : []),
      gap(),
    ]
    const t = vm.trap
    if (t) {
      const inner = [spread(line([`STUCK · ${t.pattern}`, 'warn', true]), line([`H ${(vm.health?.H ?? 0).toFixed(2)}`, 'err']))]
      if (t.file) inner.push(<Text wrap="wrap">{`${t.file} is back to ${t.verText}, a version it had at step ${t.revisitOf}.`}</Text>)
      if (t.sigText) inner.push(<Text wrap="wrap">{`Same failure on ${t.sameRuns.length} runs: ${t.sigText}`}</Text>)
      inner.push(<Text dimColor wrap="wrap">{`Recovery note ${t.notes} sent to the model at step ${t.lastNote}.`}</Text>)
      rows.push(<Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>{inner}</Box>)
    } else {
      const h = vm.health
      rows.push(line(['health     ', 'dim'], ...spark(16), h ? `  ${h.H.toFixed(2)} ` : ['  new state, no calls yet', 'dim'], h ? [healthWord(h.H), healthTone(h.H)] : undefined))
      if (vm.released) rows.push(line([`           released at step ${vm.released.end} (stuck from step ${vm.released.step})`, 'ok']))
    }
    rows.push(gap())
    if (a.check) {
      rows.push(line(['attempts', 'dim'], ['  each run of the check in this state', 'dim']))
      if (!vm.attempts.length) rows.push(line([' none yet', 'dim']))
      for (const at of vm.attempts) {
        rows.push(line(
          [` #${at.n}  `, 'dim'], [`s${at.step}`.padEnd(5), 'dim'],
          at.pass ? ['✓ pass'.padEnd(16), 'ok'] : [`× ${at.same ? 'same' : `${at.fails} failing`}`.padEnd(16), 'err'],
          vm.mainFile && at.ver ? `${base(vm.mainFile)} ${at.ver}` : '',
        ))
      }
      if (vm.next && vm.mainFile) rows.push(line([' next     ', 'dim'], ''.padEnd(16), `${base(vm.mainFile)} ${vm.next.ver}`, vm.next.repeatOf ? [`  = #${vm.next.repeatOf} (failed)`, 'warn'] : ''))
      for (const s of vm.sigs) rows.push(line([` ${s}`, 'dim']))
    } else {
      const reads = vm.ledger.rows.filter(r => r.u.startsWith('1')).length
      rows.push(line(['progress  ', 'dim'], `${reads} new reads in this state`))
    }
    rows.push(gap())
    rows.push(...laneRows(), ...auditRows(false))
    return rows
  }

  // Text that wraps inside its box instead of running off the pane's edge.
  const para = (text: string, tone?: Tone, bold?: boolean) => <Text wrap="wrap" {...style(tone, bold)}>{text}</Text>
  // A labelled value under a state: the label in its own column, the value wrapping beside it.
  const field = (label: string, value: string, tone?: Tone) => (
    <Box flexDirection="row" paddingLeft={4}>
      <Box width={7} flexShrink={0}>{line([label, 'dim'])}</Box>
      <Box flexShrink={1}>{para(value, tone)}</Box>
    </Box>
  )
  // Where a running state came from: its quotes in full, or why Claude added it, and any quote Sentinel refused for it.
  const askedRows = (s?: VM['states'][number]) => {
    const p = vm.proof
    if (!p || !s) return []
    const asks = s.asks ?? []
    return [
      ...(s.added ? [
        field('asked', `Nothing asked for this. Claude's reason: ${s.added}`),
        ...(s.okAt ? [field('', `You kept it on the draft at ${s.okAt}.`, 'dim')] : []),
        ...(s.look ? [field('', `It asks you first, because it could involve ${s.look}.`, 'dim')] : []),
      ] : []),
      ...asks.flatMap(q => [
        field('asked', `"${q.quote}"`),
        ...(q.source !== undefined ? [field('', [p.sources[q.source]!.kind === 'message' ? '' : q.where, p.sources[q.source]!.origin].filter(Boolean).join('. ') + '.', 'dim')] : []),
      ]),
      ...(asks.some(q => q.source !== undefined) ? [field('', 'Sentinel found these exact words in its saved copy.', 'dim')] : []),
      ...p.refused.filter(x => x.state === s.id).map(x => field('tried', x.quote ? `"${x.quote}" ${x.says}.` : `${x.says}.`, 'dim')),
    ]
  }
  // What the draft's quotes come to: where they came from, the count, and the sections none of them falls in.
  const proofRows = () => {
    const p = vm.proof
    if (!p?.of) return []
    const from = p.sources[0]
    return [
      ...(from ? [para(`From ${from.name ?? 'your message'}. ${from.origin}. /sentinel source shows the saved copy.`, 'dim')] : []),
      para(`${p.quoted} of ${p.of} states quote what you approved or typed, word for word.`, 'dim'),
      ...p.sources.filter(s => s.unquoted.length).map(s => {
        const many = s.unquoted.length > 1
        return para(`${and(s.unquoted)} ${many ? 'are' : 'is'} in ${s.name ?? 'your plan'}, but no state quotes ${many ? 'them' : 'it'}.`, 'warn')
      }),
    ]
  }
  // A quote as the draft lists it: the start of the first, and how many more.
  const quoteStart = (asks: NonNullable<VM['states'][number]['asks']>) => {
    const q = asks[0]!.quote
    return `"${q.length > 60 ? `${q.slice(0, 59).trimEnd()}…` : q}"${asks.length > 1 ? ` and ${asks.length - 1} more` : ''}`
  }
  // A state's line: symbol and id, then its label wrapping under itself. An addition still to answer shows ! for its symbol.
  const head = (s: VM['states'][number]) => (
    <Box flexDirection="row">
      <Box flexShrink={0}>{line(s.added && !s.okAt ? ['! ', 'warn'] : [`${symOf(s)} `, STATUS_TONE[s.status]], [`${s.id}  `, s.status === 'active' ? 'acc' : undefined, true])}</Box>
      <Box flexShrink={1}>{para(s.label, s.status === 'todo' ? 'dim' : undefined)}</Box>
    </Box>
  )

  // The plan the model drafted after /sentinel lock, for the user to check before it binds.
  const review = () => {
    const states = vm.states.filter(s => s.id !== 'done')
    const done = states.filter(s => s.status === 'done')
    const todo = states.filter(s => s.status !== 'done')
    const rows = [
      line(['DRAFT', 'warn', true], ['  not locked yet', 'dim']),
      para(vm.title, undefined, true),
      para(`${states.length} states, starts at ${vm.active?.id ?? '?'}${vm.source ? ` · from ${vm.source}` : ''}`, 'dim'),
      ...proofRows(),
      gap(),
      para('Lock it with Lock above the prompt, or /sentinel lock. To change it, tell the model.', 'dim'),
      para('Add a saved flow with /sentinel add <flow> after <state> (or start, end, before <state>), and take one out with /sentinel drop <flow>. /sentinel flows lists them.', 'dim'),
    ]
    if (done.length) {
      rows.push(gap(), line(['Done before the lock', undefined, true]))
      for (const s of done) rows.push(head(s), field('proof', s.evidence ?? ''), ...(s.ref ? [field('see', s.ref, 'dim')] : []))
    }
    rows.push(gap(), line(['To do', undefined, true]))
    for (const s of todo) {
      rows.push(
        head(s),
        ...(s.added ? [field('added', `${s.okAt ? `You kept it at ${s.okAt}.` : 'Nothing asked for this.'} Claude's reason: ${s.added}`, s.okAt ? 'dim' : 'warn')] : []),
        ...(s.asks?.length ? [field('asked', quoteStart(s.asks), 'dim')] : []),
        field('check', s.check ?? 'none (evidence and a read)', s.check ? undefined : 'dim'),
        ...(s.once ? [field('once', 'runs at its advance, not again at the end', 'warn')] : []),
        field('files', s.files.length ? s.files.join(', ') : 'none', s.files.length ? undefined : 'dim'),
        ...(s.ref ? [field('see', s.ref, 'dim')] : []),
        ...(s.flow ? [field('flow', `${s.flow.as}. ${s.flow.why}`, 'dim')] : []),
      )
    }
    if (vm.depth?.length) {
      rows.push(gap(), line(['Deeper, not bigger', undefined, true]), para('Tick the answers you want as you lock it: /sentinel lock <id> <id>. A state named by one you leave unticked comes out.', 'dim'))
      for (const d of vm.depth) rows.push(<Box flexDirection="row"><Box flexShrink={0}>{line([`${d.id}  `, 'acc', true])}</Box><Box flexShrink={1}>{para(d.state ? `${d.text} (keeps ${d.state})` : d.text)}</Box></Box>)
    }
    if (vm.loops.length) rows.push(gap(), line(['Loops', undefined, true]), para(vm.loops.map(l => `${l.from} → ${l.to}`).join(', ')))
    const decided = vm.audit.filter(a => a.kind === 'decided')
    if (decided.length) {
      rows.push(gap(), line(['Decided before the lock', undefined, true]))
      for (const a of decided) rows.push(<Box flexDirection="row"><Box flexShrink={0}>{line(['◆ ', 'acc'])}</Box><Box flexShrink={1}>{para(a.text)}</Box></Box>)
    }
    return rows
  }

  const summary = () => {
    const c = vm.counts
    const tr = vm.traps
    const loopText = vm.loops.filter(l => l.count).map(l => `${l.from} → ${l.to} ×${l.count}`).join(', ')
    const added = vm.states.filter(s => s.added)
    const skipped = vm.states.filter(s => s.skipped)
    const stat = (label: string, value: string | number, detail: string, tone?: Tone) =>
      line([label.padEnd(11), 'dim'], [String(value).padEnd(4), tone, true], [detail, 'dim'])
    const box = [
      ...(skipped.length ? [stat('skipped', skipped.length, skipped.map(s => s.id).join(', '), 'warn')] : []),
      ...(vm.closed?.unchecked.length ? [stat('unchecked', vm.closed.unchecked.length, `${vm.closed.unchecked.join(', ')}: done, checks not run again`, 'warn')] : []),
      stat('loops', vm.loops.reduce((a, l) => a + l.count, 0), loopText),
      stat('stuck', tr.length, tr.map(x => `${x.state} s${x.step}–${x.end ?? '?'} (${x.pattern})`).join(', '), tr.length ? 'warn' : undefined),
      stat('asked you', c.asked, vm.asked.filter(a => a.kind === 'asked').map(a => a.text).join('; '), 'ask'),
      stat('decided', c.decided, 'choices made without asking'),
      stat('amended', c.amended, 'scope or check changes'),
      stat('refused', c.refused + c.blocked, `${c.refused} actions, ${c.blocked} held questions`),
      stat('auto', c.auto, 'continued after a mid-plan stop'),
      stat('tokens', shortCount(total), `${parts} · ${models || 'none counted'}`),
      ...usageRows('usage'.padEnd(11)),
    ]
    return [
      spread(line(vm.closed ? ['CLOSED BY YOU', 'warn', true] : ['COMPLETE', 'ok', true]), line([`${vm.step} steps`, 'dim'])),
      line(vm.title),
      rail(),
      gap(),
      <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX={1}>{box}</Box>,
      gap(),
      line(['review these', 'dim'], ['  decisions made without you', 'dim']),
      ...auditRows(true).slice(1),
      ...(added.length ? [gap(), line(['Claude added along the way', 'dim']), ...added.map(s => para(` ${s.id}: ${s.added}${s.okAt ? ` You kept it at ${s.okAt}.` : ''}`))] : []),
    ]
  }

  const graph = () => {
    const rows: { type: 'node' | 'check' | 'files' | 'spine'; s: VM['states'][number] }[] = []
    const at: Record<string, number> = {}
    vm.states.forEach((s, i) => {
      at[s.id] = rows.length
      rows.push({ type: 'node', s })
      if (s.status === 'active' || s.status === 'trap') {
        if (s.check) rows.push({ type: 'check', s })
        if (s.files.length) rows.push({ type: 'files', s })
      }
      if (i < vm.states.length - 1) rows.push({ type: 'spine', s })
    })
    const edges = vm.loops
      .map(l => ({ s: at[l.from]!, d: at[l.to]!, l }))
      .filter(e => e.s > e.d)
      .sort((a, b) => b.s - b.d - (a.s - a.d))
    const W = edges.length ? edges.length + 1 : 0
    const toneOf = (l?: Loop): Tone | undefined => (!l ? undefined : l.hot ? 'acc' : l.count ? 'warn' : 'dim')
    const idw = Math.max(...vm.states.map(s => s.id.length)) + 2
    return rows.map((rw, r) => {
      const g = Array.from({ length: W }, (): { ch: string; l?: Loop } => ({ ch: ' ' }))
      edges.forEach((ed, k) => {
        if (r > ed.d && r < ed.s) g[k] = { ch: '│', l: ed.l }
      })
      edges.forEach((ed, k) => {
        if (r === ed.d) {
          g[k] = { ch: '┌', l: ed.l }
          for (let j = k + 1; j < W - 1; j++) g[j] = g[j]!.ch === '│' ? { ch: '┼', l: g[j]!.l } : { ch: '─', l: ed.l }
          g[W - 1] = { ch: '▶', l: ed.l }
        } else if (r === ed.s) {
          const first = edges.findIndex(x => x.s === r)
          g[k] = { ch: k === first ? '└' : '┴', l: ed.l }
          for (let j = k + 1; j < W; j++) if (g[j]!.ch === ' ') g[j] = { ch: '─', l: ed.l }
        }
      })
      const parts: Part[] = g.map(c => [c.ch, toneOf(c.l)])
      if (W) parts.push(' ')
      const s = rw.s
      const tone = STATUS_TONE[s.status]
      if (rw.type === 'node') {
        parts.push([symOf(s), tone], ' ', [s.id.padEnd(idw), tone, s.status === 'active' || s.status === 'trap'], [s.label, s.status === 'todo' ? 'dim' : undefined])
        // What it needs, and what of that is not done yet.
        if (vm.deps && s.needs.length) parts.push([`  needs ${and(s.needs)}`, 'dim'], s.status === 'todo' && s.waits.length ? [` · waits for ${and(s.waits)}`, 'warn'] : '')
      }
      else if (rw.type === 'spine') parts.push(['│', s.status === 'done' ? 'ok' : 'dim'])
      else if (rw.type === 'check') {
        const lc = vm.lastCheck
        parts.push(['│', 'dim'], ['   check  ', 'dim'], `${s.check}  `, lc ? (lc.pass ? ['✓ pass', 'ok'] : [`× ${lc.fails} failing`, 'err']) : ['· not run', 'dim'])
      } else parts.push(['│', 'dim'], ['   files  ', 'dim'], s.files.join(', '))
      return line(...parts)
    })
  }

  const map = () => {
    const pos = vm.active ? vm.active.pos : vm.states.length
    const h = vm.health
    const c = vm.counts
    const count = (n: number, label: string): Part => [`${label} ${n}`, n ? undefined : 'dim']
    return [
      spread(line([vm.title, undefined, true]), line([`step ${vm.step}`, 'dim'])),
      line([`signed off ${vm.lockedAt} · state ${pos} of ${vm.states.length} · ${vm.phase === 'complete' ? 'complete' : vm.phase === 'draft' ? 'draft, not locked' : vm.paused ? 'paused' : 'locked'}`, 'dim']),
      gap(),
      ...graph(),
      gap(),
      line(['health  ', 'dim'], ...spark(24), h ? `  ${h.H.toFixed(2)} ` : ['  —', 'dim'], h ? [healthWord(h.H), healthTone(h.H)] : undefined),
      h ? line([`        S ${h.S.toFixed(2)}  R ${h.R.toFixed(2)}  p ${h.p.toFixed(2)}  · ${h.n} of K ${K}`, 'dim']) : gap(),
      gap(),
      line(count(c.asked, 'asked'), ['  ·  ', 'dim'], count(c.blocked, 'blocked'), ['  ·  ', 'dim'], count(c.decided, 'decided'), ['  ·  ', 'dim'], count(c.amended, 'amended'), ['  ·  ', 'dim'], count(c.auto, 'auto')),
      line(['tokens  ', 'dim'], shortCount(total), [`  ${parts} · ${models || 'none yet'}`, 'dim']),
      ...usageRows('usage   '),
      gap(),
      ...laneRows(),
      line(['log', 'dim']),
      ...vm.log.slice(-6).map(l => line([` ${l.t} `, 'dim'], [`${l.icon} `, l.tone], l.text)),
    ]
  }

  const ledger = () => {
    const L = vm.ledger
    const fw = 9
    const rows = [
      spread(line([`ledger · ${L.state}`, undefined, true]), line([`step ${vm.step}`, 'dim'])),
      line(['every call in this visit; ▌ marks the window of the last 8', 'dim']),
      gap(),
      line(['  step call                  ', 'dim'], ...L.files.map((f): Part => [f.replace(/\.\w+$/, '').slice(0, fw - 1).padEnd(fw), 'dim']), ['check    u    H', 'dim']),
    ]
    for (const r of L.rows) {
      rows.push(line(
        [r.inWindow ? '▌' : ' ', 'acc'],
        [String(r.step).padStart(5) + '  ', 'dim'],
        [(r.label.length > 21 ? r.label.slice(0, 20) + '…' : r.label).padEnd(22), r.denied ? 'err' : undefined],
        ...r.vers.map((v): Part => [v.padEnd(fw), v === '·' ? 'dim' : undefined]),
        [r.chk.padEnd(9), r.chkTone],
        [r.u.padEnd(5), r.uTone],
        [r.H.toFixed(2), healthTone(r.H)],
        r.trapStart ? [' ⟲', 'err'] : '',
      ))
    }
    if (!L.rows.length) rows.push(line([' no calls yet in this state', 'dim']))
    rows.push(gap(), line(['* new version   = repeat of something seen   1→0 credit revoked', 'dim']))
    const h = vm.health
    if (h) {
      const why = h.p === 1 ? 'same failure at both ends of the window' : h.p === 0 ? 'check passing' : 'check not run, or failing differently'
      rows.push(
        gap(),
        line(['window  ', 'dim'], `steps ${h.from}–${h.to} (${h.n} calls)`),
        line(`S = 1 − ${h.usum}/${h.n} = ${h.S.toFixed(2)}`, ['     progress credited', 'dim']),
        line(`R = ${h.reps}/${h.n} = ${h.R.toFixed(2)}`, ['         repeats', 'dim']),
        line(`p = ${h.p.toFixed(2)}`, [`              ${why}`, 'dim']),
        line([`H = 1 − p·max(S,R) = ${h.H.toFixed(2)}  `, undefined, true], [healthWord(h.H) + (h.n < K ? ' (window not full, cannot trip)' : ''), healthTone(h.H)]),
      )
    }
    return rows
  }

  // A flow or an instruction Claude drafted, shown above any view until the user saves or discards it.
  const flowRows = () => {
    const f = vm.flowDraft
    if (!f) return []
    const save = para('Save it with the buttons above the prompt, or /sentinel flow save project, /sentinel flow save personal or /sentinel flow discard.', 'dim')
    if (!('states' in f)) {
      return [
        line(['INSTRUCTION DRAFT', 'ask', true], [`  ${f.name}`, undefined, true], ['  not saved yet', 'dim']),
        ...(f.description ? [para(f.description, 'dim')] : []),
        field('told', MOMENT[f.at]),
        ...(f.files?.length ? [field('files', f.files.join(', '))] : []),
        para(f.text),
        save,
        gap(),
      ]
    }
    return [
      line(['FLOW DRAFT', 'ask', true], [`  ${f.name}`, undefined, true], ['  not saved yet', 'dim']),
      ...(f.description ? [para(f.description, 'dim')] : []),
      ...f.states.flatMap(s => [
        line(['○ ', 'dim'], [`${s.id}  `, undefined, true], s.label),
        field(s.wait ? 'waits' : 'check', s.wait ? `${s.wait === 'after' ? 'for your review when it is done' : 'for your OK before it starts'}${s.check ? ` and ${s.check}` : ''}` : s.check ?? 'none', s.wait || s.check ? undefined : 'warn'),
        ...(s.files?.length ? [field('files', s.files.join(', '))] : []),
      ]),
      field('adds', ruleText(f.when)),
      save,
      gap(),
    ]
  }

  // The map as an indented list: each group with how its parts stand, each part with its status in words, its files and its
  // proof, then the lines between parts and what the drawing's checks found.
  const system = () => {
    const s = vm.system
    if (!s) return [line(['No system map for this plan.', undefined, true]), line(['Claude draws one with a plan that covers more than one part.', 'dim'])]
    const t = s.tally
    const dr = s.drift
    const rows: unknown[] = [
      line([s.name, undefined, true], [` · ${count(t.total, 'part')} · ${t.built} built · ${t.untestedOrChanged} to test`, 'dim']),
      ...(s.actors.length ? [line(['People: ', 'dim'], s.actors.map(a => a.name).join(', '))] : []),
      ...(dr?.count ? [line(['↻ ', 'warn'], [`${count(dr.count, 'part')} changed since the map was drawn.`, 'warn']), line(['  Claude rereads one: /sentinel redraw <part>', 'dim']), line(['  Mark one as fine: /sentinel fine <part>', 'dim'])] : []),
      ...(dr?.noGit ? [line(["No git here, so Sentinel can't tell what changed since the map was drawn.", 'dim'])] : []),
      gap(),
    ]
    const walk = (n: MapNode, depth: number) => {
      const pad = '  '.repeat(depth)
      if (n.roll) {
        const tone = ROLL_TONE[n.roll.tone]
        rows.push(line(pad, ['▾ ', tone], [n.name, undefined, true], '  ', [rollText(n.roll), tone]))
        for (const k of n.kids) walk(k, depth + 1)
        return
      }
      const st = n.status!
      const [mark, word, tone] = PART[st.status]
      const tags = st.tags.map(tag => (tag === 'shares-file' ? `Shares a file with ${(st.shares ?? []).join(', ')}` : TAG[tag] ?? tag))
      const why = n.outside && ` · ${EVIDENCE[n.outside.kind]}${clipped(n.outside.why, 80)}`
      rows.push(line(pad, [`${mark} `, tone], [n.name, undefined, true], '  ', [word, tone], why && [why, 'dim'], ...tags.map((tag): Part => [` · ${tag}`, 'dim'])))
      const files = n.files && (n.files.length > FILES_SHOWN ? `${n.files.slice(0, FILES_SHOWN).join(', ')} and ${n.files.length - FILES_SHOWN} more` : n.files.join(', '))
      const p = st.proof
      const proof = p && `proved by ${p.check ?? 'a check'}${p.weight ? ` (${p.weight})` : ''}${p.at ? ` at ${p.at}` : ''}`
      const detail = [n.outside?.where, n.desc, files, proof].filter(Boolean).join(' · ')
      if (detail) rows.push(line([`${pad}    ${detail}`, 'dim']))
      if (dr?.why[n.id]) rows.push(line([`${pad}    ${dr.why[n.id]}`, 'warn']))
      if (st.note) rows.push(line([`${pad}    ${st.note}`, tone]))
    }
    for (const n of s.tree) walk(n, 0)
    if (s.links.length) {
      const more = s.links.length - LINES_SHOWN
      rows.push(gap(), line(['Lines', 'dim']), ...s.links.slice(0, LINES_SHOWN).map(l => line(`  ${l.from} → ${l.to}: ${l.says}`)))
      if (more > 0) rows.push(line([`  and ${more} more ${more === 1 ? 'line' : 'lines'}`, 'dim']))
    }
    const c = s.changes
    const changed: Part[][] = [
      ...c.added.map((p): Part[] => [`  + ${p.name}`, [' · added', 'dim']]),
      ...c.dropped.map((p): Part[] => [`  – ${p.name}`, [' · dropped', 'dim']]),
      ...c.edited.map((p): Part[] => [`  ~ ${p.name}`, [` · changed: ${p.what.join(', ')}`, 'dim']]),
      ...c.linesAdded.map((l): Part[] => [`  + ${l.from} → ${l.to}: ${l.says}`]),
      ...c.linesDropped.map((l): Part[] => [`  – ${l.from} → ${l.to}: ${l.says}`]),
    ]
    if (changed.length) {
      const left = changed.length - LINES_SHOWN
      rows.push(gap(), line(['Changes since you signed off', 'dim']), ...changed.slice(0, LINES_SHOWN).map(p => line(...p)))
      if (left > 0) rows.push(line([`  and ${left} more ${left === 1 ? 'change' : 'changes'}`, 'dim']))
    }
    if (s.warnings.length || s.guessed.length) {
      rows.push(gap(), line(['Drawing notes', 'warn', true]), ...s.warnings.map(w => para(`  ${w}`, 'dim')))
      if (s.guessed.length) rows.push(line(['  Guessed: ', 'warn'], s.guessed.join(', '), [' · the draft asks you to confirm or remove them', 'dim']))
    }
    if (dr?.loose.length) rows.push(gap(), line(['Files in no part', 'dim']), line(`  ${clipList(dr.loose, LOOSE_SHOWN)}`))
    if (s.unmapped) {
      const more = s.unmapped.more
      rows.push(gap(), line(['Not mapped yet', 'dim']), ...s.unmapped.rows.map(f => line(`  ${f.path}/ · ${count(f.files, 'file')}`)))
      if (more) rows.push(line([`  and ${more} more ${more === 1 ? 'folder' : 'folders'}`, 'dim']))
      rows.push(line(['  Each plan adds the folders it touches to the map.', 'dim']))
    }
    if (s.leads) {
      rows.push(gap(), line(['Not placed yet', 'dim']), line(`  ${s.leads.keys.join(', ')}${s.leads.more ? ` and ${s.leads.more} more` : ''}`))
      rows.push(line(['  From .env.example. Nothing is drawn from them until you or Claude name them.', 'dim']))
    }
    if (s.plans?.length) {
      const names = new Map<string, string>()
      const collect = (ns: MapNode[]) => ns.forEach(n => (names.set(n.id, n.name), collect(n.kids)))
      collect(s.tree)
      const left = s.plans.length - PLANS_SHOWN
      rows.push(gap(), line(['Past plans', 'dim']), ...s.plans.slice(0, PLANS_SHOWN).map(p => {
        const built = p.parts.map(id => names.get(id) ?? id).join(', ')
        return line(`  ${p.title}`, [` · ${p.ended === 'complete' ? 'finished' : 'closed early'} ${dayOf(p.at)}${built ? ` · built ${built}` : ''}`, 'dim'])
      }))
      if (left > 0) rows.push(line([`  and ${left} more`, 'dim']))
    }
    return rows
  }

  const tabs = (
    <Box flexDirection="row" gap={1}>
      {VIEWS.filter(v => v !== 'system' || vm.system).map(v => (
        <Button key={v} label={NAMES[v]} hotkey={v[0]} variant={v === view ? 'primary' : 'secondary'} onPress={() => on.pick(v)} />
      ))}
      <Button key="browser" label="Browser" hotkey="b" onPress={() => on.browser()} />
    </Box>
  )
  // With no plan locked the project's own map still shows on the System tab.
  const body = vm.phase === 'none' ? (view === 'system' && vm.system ? system() : none())
    : view === 'map' ? map() : view === 'ledger' ? ledger() : view === 'system' ? system()
    : vm.phase === 'draft' ? review() : vm.phase === 'complete' ? summary() : focus()
  return (
    <Box flexDirection="column">
      {tabs}
      {gap()}
      {flowRows()}
      {body}
    </Box>
  )
}

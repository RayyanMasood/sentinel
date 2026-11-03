// The pane's three views. Each draws from summarize(run), the same model the browser page reads.
import { K, SYM, VIEWS, healthTone, healthWord, ruleText, shortCount, tokenSplit, tokensOf, type Status, type VM } from './core'
import type { InstructionAt, Tone, View } from '../types'

// The surface's element table, from $.ui.resolve(e).
type Els = { Box: any; Text: any; Button: any }
type Part = string | false | undefined | [string, Tone?, boolean?]
type Loop = VM['loops'][number]

export type PaneActions = { pick: (v: View) => void; browser: () => void }
export type BandActions = { open: (focus: boolean) => void; lock: () => void; resume: () => void; saveFlow: (scope: 'project' | 'personal') => void; discardFlow: () => void }

// The band above the prompt: what needs you, or where the plan stands, with the buttons to act on it.
// No hotkeys: a bare digit in an empty prompt would press them while you start a message.
export function renderBand(el: Els, vm: VM, on: BandActions) {
  const { Box, Text, Button } = el
  const a = vm.active
  const f = vm.flowDraft
  const live = !!a && vm.phase !== 'none' && vm.phase !== 'complete'
  if (!live && !f) return undefined
  const hl = vm.health
  type Band = [string, Tone, [string, string, () => void][]]
  // A flow or an instruction Claude drafted waits behind what needs you in the plan, and ahead of where it stands.
  const flow: Band | undefined = f && [`Sentinel: Claude drafted ${'states' in f ? `the flow "${f.name}" (${count(f.states.length, 'state')})` : `the instruction "${f.name}"`}. Save it?`, 'ask',
    [['fproj', 'Save to project', () => on.saveFlow('project')], ['fpers', 'Save personal', () => on.saveFlow('personal')], ['fdrop', 'Discard', on.discardFlow]]]
  const [text, tone, buttons]: Band = !a || !live ? flow!
    : vm.phase === 'draft' ? [`Sentinel draft "${vm.title}": ${vm.states.length - 1} states, starts at ${a.id}. Check it, then lock it.`, 'warn', [['review', 'Review', () => on.open(true)], ['lock', 'Lock', on.lock]]]
    : vm.paused ? [`Sentinel is paused at ${a.id}.`, 'warn', [['resume', 'Resume', on.resume], ['open', 'Open', () => on.open(false)]]]
    : vm.trap ? [`Sentinel: stuck (${vm.trap.pattern}) in ${a.id}.`, 'err', [['open', 'Open', () => on.open(true)]]]
    : vm.waiting ? [vm.waiting.kind === 'before' ? `Sentinel: ${a.id} asks for your OK before it starts. Reply in the chat.` : `Sentinel: ${a.id} is ready for your review. Reply in the chat.`, 'warn', [['open', 'Open', () => on.open(true)]]]
    : flow ? flow
    : vm.sweep ? [`Sentinel: final checks · ${sweepLine(vm.sweep)}`, 'acc', [['open', 'Open', () => on.open(false)]]]
    : vm.checking?.length ? [`Sentinel: ${a.id} ${a.pos}/${a.of} · ${checkLine(vm.checking.at(-1)!)}`, vm.checking.at(-1)!.quiet ? 'warn' : 'dim', [['open', 'Open', () => on.open(false)]]]
    : [`Sentinel: ${a.id} ${a.pos}/${a.of}${hl ? ` · H ${hl.H.toFixed(2)} ${healthWord(hl.H)}` : ''}`, 'dim', [['open', 'Open', () => on.open(false)]]]
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
const NAMES: Record<View, string> = { focus: 'Focus', map: 'Map', ledger: 'Ledger' }
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
      ...(vm.waiting ? [field('waits', vm.waiting.kind === 'before' ? 'for your OK on its proposal, in the chat' : 'for your review, in the chat', 'warn')]
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
  // A state's line: symbol and id, then its label wrapping under itself.
  const head = (s: VM['states'][number]) => (
    <Box flexDirection="row">
      <Box flexShrink={0}>{line([`${symOf(s)} `, STATUS_TONE[s.status]], [`${s.id}  `, s.status === 'active' ? 'acc' : undefined, true])}</Box>
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
        field('check', s.check ?? 'none (evidence and a read)', s.check ? undefined : 'dim'),
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
    const stat = (label: string, value: string | number, detail: string, tone?: Tone) =>
      line([label.padEnd(11), 'dim'], [String(value).padEnd(4), tone, true], [detail, 'dim'])
    const box = [
      stat('loops', vm.loops.reduce((a, l) => a + l.count, 0), loopText),
      stat('stuck', tr.length, tr.map(x => `${x.state} s${x.step}–${x.end ?? '?'} (${x.pattern})`).join(', '), tr.length ? 'warn' : undefined),
      stat('asked you', c.asked, vm.asked.filter(a => a.kind === 'asked').map(a => a.text).join('; '), 'ask'),
      stat('decided', c.decided, 'choices made without asking'),
      stat('amended', c.amended, 'scope or check changes'),
      stat('refused', c.refused + c.blocked, `${c.refused} actions, ${c.blocked} held questions`),
      stat('auto', c.auto, 'continued after a mid-plan stop'),
      stat('tokens', shortCount(total), `${parts} · ${models || 'none counted'}`),
    ]
    return [
      spread(line(['COMPLETE', 'ok', true]), line([`${vm.step} steps`, 'dim'])),
      line(vm.title),
      rail(),
      gap(),
      <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX={1}>{box}</Box>,
      gap(),
      line(['review these', 'dim'], ['  decisions made without you', 'dim']),
      ...auditRows(true).slice(1),
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

  const tabs = (
    <Box flexDirection="row" gap={1}>
      {VIEWS.map(v => (
        <Button key={v} label={NAMES[v]} hotkey={v[0]} variant={v === view ? 'primary' : 'secondary'} onPress={() => on.pick(v)} />
      ))}
      <Button key="browser" label="Browser" hotkey="b" onPress={() => on.browser()} />
    </Box>
  )
  const body = vm.phase === 'none' ? none()
    : view === 'map' ? map() : view === 'ledger' ? ledger()
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

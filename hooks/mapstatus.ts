// What each part of the map shows, worked out from the map, what the run knows and the proofs saved so far. Plain values
// in and out (no files, no git, no clock), so node tests every row in about a second.
import type { Fingerprint, MapCounts, MapRoll, MapTally, MapTone, PartMark, PartStatus, PartStatusName, StatusInput, SysPart, SystemMap } from '../types'

const NAMES: PartStatusName[] = ['planned', 'exists', 'change', 'now', 'tested', 'changed', 'untested', 'failing', 'needs', 'outside', 'dropped']
const GLOB = /[*?[]/

// A part's folder or file up to the first glob, for telling whether two parts' files can meet.
const lead = (g: string) => {
  const segs = g.replace(/\/+$/, '').split('/')
  const at = segs.findIndex(s => GLOB.test(s))
  return (at < 0 ? segs : segs.slice(0, at)).join('/')
}
const meets = (a: string, b: string) => a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

// For each part, the other parts whose files overlap its own. An edit to such a file changes all of them.
// ponytail: compares leads pairwise and a glob with no folder in front meets everything. Fine at the 400-part cap; an
// index by first folder would be the upgrade.
function sharing(parts: SysPart[]): Map<string, string[]> {
  const leads = parts.map(p => [p.id, p.kind === 'outside' ? [] : [...new Set((p.files ?? []).map(lead))]] as const)
  const out = new Map<string, string[]>()
  for (const [id, mine] of leads) {
    const hits = leads.filter(([other, theirs]) => other !== id && mine.some(a => theirs.some(b => meets(a, b)))).map(([other]) => other)
    if (hits.length) out.set(id, hits)
  }
  return out
}

// A fingerprint still matches the proof, or cannot be told apart from it (no git, or not looked at yet).
const kept = (hash: string, now?: Fingerprint) => !now || !('hash' in now) || now.hash === hash

export function statusOf(input: StatusInput): Record<string, PartStatus> {
  const { map, states } = input
  const existing = new Set(input.existing)
  const dropped = new Set(input.dropped)
  const ran = input.closed && new Set(input.closed.ran)
  const shared = sharing(map.parts)
  const out: Record<string, PartStatus> = {}
  for (const part of map.parts) {
    const id = part.id
    const mark: PartMark | undefined = input.marks?.[id]
    const now = input.now?.[id]
    const mine = states.filter(s => s.parts.includes(id))
    const live = mine.filter(s => !s.skipped)
    const tags: string[] = []
    const result = (status: PartStatusName, extra: Partial<PartStatus> = {}): PartStatus => ({ status, tags, ...extra })

    if (dropped.has(id)) { out[id] = result('dropped'); continue }
    if (part.kind === 'outside') {
      const e = part.evidence
      out[id] = result('outside', { evidence: e && 'seen' in e ? 'seen' : e && 'said' in e ? 'said' : 'guess' })
      continue
    }

    if (mine.some(s => s.skipped)) tags.push('skipped')
    if (input.closed) {
      if (live.some(s => s.where !== 'done')) tags.push('not-finished')
      if (live.some(s => s.where === 'done' && s.hasCheck !== false && !ran!.has(s.id))) tags.push('not-rechecked')
    }
    if (live.some(s => s.where === 'done' && s.once)) tags.push('once')
    const sharers = shared.get(id)
    if (sharers) tags.push('shares-file')
    if (now && 'none' in now && now.none === 'no git') tags.push('no-git')
    const drift = input.drift?.[id]
    if (drift === 'changed') tags.push('changed-since-drawn')
    if (drift === 'gone') tags.push('files-gone')
    const extra: Partial<PartStatus> = sharers ? { shares: sharers } : {}
    const proof = mark && (mark.check || mark.weight || mark.at) ? { check: mark.check, weight: mark.weight, at: mark.at } : undefined
    const base = existing.has(id) ? 'exists' : 'planned'
    // A proof counts only if the files changed between the baseline it was measured against and the check passing. `from`
    // is that baseline, kept when a later state moves `base` on.
    const proved = mark?.hash !== undefined && mark.hash !== (mark.from ?? mark.base)

    const failing = live.find(s => s.failing || s.reopened !== undefined)
    const needs = live.find(s => s.blocked !== undefined)
    const done = live.filter(s => s.where === 'done')
    let status: PartStatusName
    let note: string | undefined
    if (failing) {
      status = 'failing'
      note = failing.reopened
      if (failing.reopened !== undefined) tags.push('reopened')
    } else if (needs) {
      status = 'needs'
      note = needs.blocked
    } else if (live.some(s => s.where === 'active')) {
      status = 'now'
    } else if (done.length && (mark?.base === undefined || (!!now && 'hash' in now && now.hash !== mark.base))) {
      // A done state changed this part. With no baseline saved (older runs), Sentinel cannot tell, so it counts as changed.
      if (!part.files?.length) tags.push('no-files')
      status = !done.some(s => s.hasCheck !== false) || !proved ? 'untested' : kept(mark!.hash!, now) ? 'tested' : 'changed'
    } else if (live.some(s => s.where === 'ahead')) {
      status = existing.has(id) ? 'change' : 'planned'
    } else {
      status = proved ? (kept(mark!.hash!, now) ? 'tested' : 'changed') : base
    }
    out[id] = result(status, { ...extra, ...(note !== undefined ? { note } : {}), ...(proof && (status === 'tested' || status === 'changed') ? { proof } : {}) })
  }
  return out
}

const zero = () => Object.fromEntries(NAMES.map(n => [n, 0])) as MapCounts

// The parts that are counted: ones with nothing inside them, not outside the project, not dropped.
function counted(map: SystemMap, statuses: Record<string, PartStatus>, under?: string): SysPart[] {
  const kids = new Map<string | undefined, SysPart[]>()
  for (const p of map.parts) kids.set(p.parent, [...(kids.get(p.parent) ?? []), p])
  const leaves = (p: SysPart): SysPart[] => (kids.get(p.id) ?? []).flatMap(leaves).concat(kids.has(p.id) ? [] : [p])
  const roots = under === undefined ? (kids.get(undefined) ?? []) : map.parts.filter(p => p.id === under)
  return roots.flatMap(leaves).filter(p => {
    const s = statuses[p.id]
    return !!s && s.status !== 'dropped' && s.status !== 'outside'
  })
}

function count(parts: SysPart[], statuses: Record<string, PartStatus>): MapCounts {
  const c = zero()
  for (const p of parts) c[statuses[p.id]!.status]++
  return c
}

// The colour a group shows. The first line that holds wins: something failing, something waiting on you, Claude inside,
// then what all of its parts have in common. A mix is neutral.
const toneOf = (c: MapCounts, total: number): MapTone =>
  c.failing ? 'red' : c.needs ? 'amber' : c.now ? 'blue'
    : !total ? 'neutral' : c.planned === total ? 'dashed' : c.exists === total ? 'plain' : c.tested === total ? 'green' : 'neutral'

export function rollOf(map: SystemMap, statuses: Record<string, PartStatus>, id: string): MapRoll {
  const parts = counted(map, statuses, id)
  const counts = count(parts, statuses)
  return { tone: toneOf(counts, parts.length), counts, total: parts.length }
}

// One line for the whole map. built: parts a state changed. untestedOrChanged: of those, the ones with no proof that still holds.
export function tally(map: SystemMap, statuses: Record<string, PartStatus>): MapTally {
  const parts = counted(map, statuses)
  const c = count(parts, statuses)
  return { ...c, total: parts.length, built: c.tested + c.changed + c.untested, untestedOrChanged: c.changed + c.untested }
}

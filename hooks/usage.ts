// What a plan and its steps used of the user's limits. Claude Code reports each limit's percentage for the whole account
// and a running cost for this session. The limits' size isn't published, so the price of 1% of the week comes from the
// user's own use: the dollars this session spent while the figure moved. Plain values in and out, as in mapstatus.ts.
import type { Price, Usage, UsageView, Watch } from '../types'

export const WEEKLY = 'seven_day'
const NAMES: [string, string][] = [[WEEKLY, 'Week'], ['five_hour', '5 hours']]
// How far the figure moves in one measurement, and how many measurements are kept. One point is exact, as a measurement
// runs from one tick of the figure to the next.
const POINTS = 1
const KEPT = 20
const HOUR = 3_600_000

// The reset time can wobble from one reading to the next, so only a real move means a new window.
const sameWindow = (a?: string, b?: string) => a === b || Math.abs(Date.parse(a ?? '') - Date.parse(b ?? '')) < HOUR

// One reading of the weekly figure and the session's cost. A measurement starts and ends when the figure ticks over, so
// rounding can't skew it. A new window, or the session's cost starting over, ends it with no price.
export function watch(w: Watch | undefined, pct: number, usd: number, resetsAt: string | undefined, at: string): { watch: Watch; price?: Price } {
  if (!w || pct < w.pct || usd < w.usd || !sameWindow(w.resetsAt, resetsAt)) return { watch: { pct, usd, resetsAt } }
  if (pct === w.pct) return { watch: { ...w, usd, resetsAt } }
  const from = w.from ?? { pct, usd }
  const points = Number((pct - from.pct).toFixed(1))
  if (points < POINTS) return { watch: { pct, usd, resetsAt, from } }
  const spent = usd - from.usd
  // A session that sat idle while others moved the figure spent nothing, which says nothing about the price.
  return { watch: { pct, usd, resetsAt, from: { pct, usd } }, ...(spent > 0 ? { price: { usd: spent, points, at } } : {}) }
}

export const keptPrices = (list: Price[], p: Price) => [...list, p].slice(-KEPT)

// Sessions running at once move the figure faster for the same cost, so they only ever pull the price down. The highest is
// the closest to the true one. ponytail: a user who always runs several sessions never sees the true price, so shares read
// high; the kept list shows how steady it is.
export const perPoint = (list: Price[]) => (list.length ? Math.max(...list.map(p => p.usd / p.points)) : undefined)

const isPrice = (p: any): p is Price => !!p && typeof p === 'object' && Number.isFinite(p.usd) && p.usd > 0 && Number.isFinite(p.points) && p.points > 0
export const parsePrices = (x: unknown): Price[] => (Array.isArray(x) ? x.filter(isPrice) : [])

// The share of the week, once the price of 1% is known.
export function shareOf(usd: number, price: number | undefined): string | undefined {
  if (!price) return undefined
  const share = usd / price
  return share < 0.1 ? 'under 0.1%' : `about ${Number(share.toFixed(1))}%`
}

const money = (usd: number) => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

// What one model response and one workflow cost. Dollars per million tokens: input, output, cache read. A cache write costs
// 1.25 x input. A model matches when its id contains the key, so a longer id goes before the shorter one it contains
// ('opus-5-5' before 'opus-5'), and a suffix such as "[1m]" or a date does not matter.
const RATES: [string, [number, number, number]][] = [
  ['fable-5-2', [8, 40, 0.2]], ['mythos', [8, 40, 0.2]],
  ['opus-5-5', [4, 20, 0.2]], ['sonnet-5-5', [2, 10, 0.1]], ['haiku-5-5', [0.1, 0.5, 0.01]],
  ['opus-5', [5, 25, 0.5]], ['sonnet-5', [2, 10, 0.2]], ['haiku-4-5', [1, 5, 0.1]],
]
type Tokens = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'

// Full ids and the bare aliases both land here. 'mythos' is the fable family.
export const family = (model: string | undefined): Family | undefined => {
  const m = model?.toLowerCase() ?? ''
  return m.includes('mythos') ? 'fable' : (['haiku', 'sonnet', 'opus', 'fable'] as const).find(f => m.includes(f))
}

// Dollars for one response. Undefined for a model not in the table: 0 would read as free.
// For workflow agents only: they write the cache on the 5-minute tier (1.25 x input), as the 23 Nov probe's transcripts
// showed. The main conversation writes on the 1-hour tier (2 x) and the engine's usage doesn't say which, so this
// undercounts it by up to 30%.
export function costOf(u: Tokens, model: string | undefined): number | undefined {
  const m = model?.toLowerCase() ?? ''
  const rate = RATES.find(([key]) => m.includes(key))?.[1]
  if (!rate) return undefined
  const [input, output, read] = rate
  return (u.input_tokens * input + u.output_tokens * output + u.cache_read_input_tokens * read + u.cache_creation_input_tokens * input * 1.25) / 1e6
}

// Dollars per agent, typical and 90th percentile, measured on 23 Nov 2026 over 401 of the user's subagents.
// ponytail: fixed as measured. Learning them from finished runs is the upgrade; until then they drift from the user's real use.
const PER_AGENT: Record<Family, { typical: number; p90: number }> = {
  opus: { typical: 2.3, p90: 4.35 }, sonnet: { typical: 1.6, p90: 3.1 }, haiku: { typical: 0.05, p90: 0.06 }, fable: { typical: 11.5, p90: 18.5 },
}
export const perAgent = (model: string | undefined) => { const f = family(model); return f && PER_AGENT[f] }

// A workflow's cost before it runs: usd is the typical figure, upTo the 90th percentile.
export function estimate({ agents, model }: { agents: number; model: string | undefined }): { usd: number; upTo: number } | undefined {
  const p = perAgent(model)
  return p && { usd: agents * p.typical, upTo: agents * p.p90 }
}

// What the page and the terminal show: the cost always, and the share of the week with a weekly figure and a price.
export function usageView(u: Usage | undefined): UsageView | undefined {
  if (!u) return undefined
  const windows = NAMES.flatMap(([kind, name]) => {
    const w = u.windows.find(x => x.kind === kind)
    if (!w) return []
    const began = u.began.find(x => x.kind === kind)
    const was = began && sameWindow(began.resetsAt, w.resetsAt) ? began.percentUsed : undefined
    return [{ name, percent: w.percentUsed, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), ...(was === undefined ? {} : { was }) }]
  })
  const price = u.windows.some(w => w.kind === WEEKLY) ? u.perPoint : undefined
  const cost = (usd: number) => { const share = shareOf(usd, price); return { cost: money(usd), ...(share ? { share } : {}) } }
  return { windows, plan: cost(u.usd), steps: Object.fromEntries(Object.entries(u.byState).map(([id, usd]) => [id, cost(usd)])) }
}

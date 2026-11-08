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

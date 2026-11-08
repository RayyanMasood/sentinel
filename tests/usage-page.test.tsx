// The usage figures in the terminal. The Run page and the step pages are proven in a real browser, in page.check.mjs.
//
// How it can fail, and where each is tested below:
//  1. A run with no figures grows an empty row.
//  2. The running plan's view leaves a figure out.
//  3. A 5-hour figure only shows when it is reported, and a share only with a weekly figure and a price.
//  4. The finished plan's summary loses them.
//  5. The cost is left out until there is a share.
import { expect } from 'claude-code/testing'
import { emptyRun, summarize } from '../hooks/core'
import { renderPane } from '../hooks/views'
import type { Run, Usage } from '../types'
import { test } from './kit'

const EL = { Box: 'Box', Text: 'Text', Button: 'Button' }
const OFF = { pick: () => {}, browser: () => {} }
const text = (n: any): string => {
  if (n === null || n === undefined || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(text).join('')
  if (n.type === 'Button') return `[${n.props.label}]`
  const kids = n.children
  if (n.type === 'Box') {
    const list: any[] = (Array.isArray(kids) ? kids : [kids]).flat(Infinity)
    return list.map(text).filter(s => s !== '').join(n.props?.flexDirection === 'row' ? ' ' : '\n')
  }
  return text(kids)
}
const WEEK = { kind: 'seven_day', percentUsed: 52, resetsAt: '2026-11-09T22:00:00.000Z' }
const FIVE = { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-11-07T15:00:00.000Z' }
const USAGE: Usage = { usd: 7, last: 7, byState: { a: 7 }, windows: [WEEK], began: [WEEK], perPoint: 5 }
const STATES = [{ id: 'a', label: 'A', files: ['src/a.ts'] }, { id: 'b', label: 'B', files: ['src/b.ts'] }]
const live = (usage?: Usage): Run => ({ ...emptyRun(), plan: { title: 'T', lockedAt: '10:00', states: STATES }, active: 'a', ...(usage ? { usage } : {}) } as Run)
const done = (usage?: Usage): Run => ({ ...live(usage), active: 'done', done: ['a', 'b'] } as Run)
// A running plan shows tokens on its Map view, and a finished one in its summary.
const pane = (r: Run) => text(renderPane(EL, summarize(r), 'map', OFF))
const summary = (r: Run) => text(renderPane(EL, summarize(r), 'focus', OFF))
const row = (s: string, word: string) => s.split('\n').find(l => l.startsWith(word)) ?? ''

test('a run with no figures has no usage row, and one with only a cost shows the cost', () => {
  expect(pane(live())).not.toMatch(/usage|week /i)
  expect(summary(done())).not.toMatch(/usage|week /i)
  expect(row(pane(live({ ...USAGE, windows: [], began: [] })), 'usage')).toMatch(/usage\s+this plan \$7\.00$/)
})

test('a running plan shows the week and its share, under the tokens', () => {
  const s = pane(live(USAGE))
  expect(row(s, 'usage')).toContain('week 52% · this plan $7.00, about 1.4%')
  const lines = s.split('\n')
  expect(lines.findIndex(l => l.startsWith('usage'))).toBe(lines.findIndex(l => l.startsWith('tokens')) + 1)
})

test('until there is a price the cost shows alone', () => {
  expect(row(pane(live({ ...USAGE, perPoint: undefined })), 'usage')).toMatch(/this plan \$7\.00$/)
})

test('the 5-hour figure shows when it is reported', () => {
  expect(row(pane(live({ ...USAGE, windows: [WEEK, FIVE] })), 'usage')).toContain('week 52% · 5 hours 23% · this plan $7.00, about 1.4%')
})

test('with no weekly figure there is no share to show', () => {
  expect(row(pane(live({ ...USAGE, windows: [FIVE], began: [FIVE] })), 'usage')).toMatch(/usage\s+5 hours 23% · this plan \$7\.00$/)
})

test('a finished plan\'s summary keeps them', () => {
  const s = summary(done(USAGE))
  expect(s).toMatch(/^usage\s+week 52% · this plan \$7\.00, about 1\.4%/m)
})

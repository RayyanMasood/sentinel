// Tries the quote comparison on real plans, to find the honest quotes it would refuse and the changed ones it would let through.
//   node tests/quote.replay.mjs        reads ~/.claude/plans (or PLANS=<dir>) and a small made-up plan, so anyone can run it
// Real plans can hold client names, so this prints counts only. A failing line is shown with its letters and digits masked.
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { checkQuote, sectionsOf, squash, unquoted } from '../hooks/quote.ts'

const FIXTURE = `# Studio bookings

## Context
The studio takes bookings by phone and wants that to stop.

## Bookings
- Members can **hold a seat** for ten minutes before paying for it.
1. Staff see the \`class_roster\` on a schedule screen each morning.

See [the booking rules](https://example.com/rules) for what happens at the door of the studio.

| Part | What it does |
|---|---|
| Waitlist | Holds people in line when a class is full today |

## Payments
Charge the card at checkout, and “refund it” on cancel — within two working days.

## Not in this plan
- Add a loyalty points scheme for the most regular members.
`

const dir = process.env.PLANS ?? join(homedir(), '.claude', 'plans')
let files = []
try { files = readdirSync(dir).filter(f => f.endsWith('.md')) } catch { /* no plans folder: the fixture still runs */ }
const docs = [FIXTURE, ...files.map(f => readFileSync(join(dir, f), 'utf8'))]

const mask = s => s.replace(/\p{L}/gu, 'x').replace(/\p{N}/gu, '9').slice(0, 110)
const plain = t => t.replace(/[*_`]/g, '').replace(/\s+/g, ' ')
// Is this really in the plan as whole words, judged without the code under test?
const inPlan = (flat, q) => {
  const w = plain(q)
  for (let at = flat.indexOf(w); at >= 0; at = flat.indexOf(w, at + 1)) {
    if (!/[\p{L}\p{N}]/u.test(flat[at - 1] ?? '') && !/[\p{L}\p{N}]/u.test(flat[at + w.length] ?? '')) return true
  }
  return false
}
const wordCount = t => squash(t).split(' ').filter(Boolean).length
const MIN_FOR_FORM = 6

const tally = {}
const note = (form, good, line) => {
  const t = (tally[form] ??= { good: 0, all: 0, bad: [] })
  t.all++
  if (good) t.good++
  else if (t.bad.length < 4) t.bad.push(mask(line))
}

// The form Claude would really send, for a line as written.
const honest = {
  exact: s => s,
  'marks stripped': s => s.replace(/[*_`]/g, ''),
  'list marker dropped': s => s.replace(/^\s*(?:[-*+>]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''),
  'link text only': s => /\[[^\]]+\]\([^)]+\)/.test(s) ? s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') : null,
  // A real wrap can't start a line with a list marker: Markdown would read that as a new item.
  'wrapped across lines': s => s.trim().split(/\s+/).map((w, i) => (i && i % 4 === 0 && !/^(?:[-*+>]|\d+[.)])$/.test(w) ? `\n  ${w}` : w)).join(' '),
  'plain quotes and dashes': s => /[“”‘’–—…]/.test(s) ? s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s*[–—]\s*/g, ' - ').replace(/…/g, '...') : null,
}
// Each changes the words. A form that really is in the plan anyway isn't a change, so it doesn't count.
const midWord = s => {
  const w = s.trim().split(/\s+/)
  const at = w.findIndex((x, i) => i >= w.length >> 1 && /^[\p{L}\p{N}]{4,}$/u.test(x))
  return at < 0 ? null : [w, at]
}
const changed = {
  'one word swapped': s => { const m = midWord(s); if (!m) return null; const w = [...m[0]]; w[m[1]] = 'zebra'; return w.join(' ') },
  'one word dropped': s => { const m = midWord(s); if (!m) return null; const w = [...m[0]]; w.splice(m[1], 1); return w.join(' ') },
  'a feature added': s => `${s.trim().replace(/[.!?:;,]+$/, '')} and export it to a zebra report`,
  'cut inside a word': s => { const t = s.trim(); return /^[\p{L}\p{N}]{4}/u.test(t) ? t.slice(2) : null },
}

let sentences = 0
let outside = 0
let sections = 0
let flagged = 0
let noSections = 0
for (const doc of docs) {
  const secs = sectionsOf(doc)
  sections += secs.length
  flagged += unquoted(doc, []).length
  if (!secs.length) noSections++

  const flat = plain(doc)
  let fence = false
  for (const raw of doc.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue }
    if (fence || !raw.trim() || /^\s*#/.test(raw)) continue
    if (/^\s*\|/.test(raw)) {
      for (const cell of raw.split('|').map(c => c.trim())) {
        if (wordCount(cell) < MIN_FOR_FORM) continue
        const v = checkQuote(doc, cell)
        if (v === 'excluded') outside++
        else note('table cell', v === 'ok', cell)
      }
      continue
    }
    for (const s of raw.split(/(?<=[.!?])\s+/)) {
      if (wordCount(s) < MIN_FOR_FORM) continue
      sentences++
      if (checkQuote(doc, s) === 'excluded') { outside++; continue }
      for (const [form, make] of Object.entries(honest)) {
        const q = make(s)
        if (q !== null) note(form, checkQuote(doc, q) === 'ok', q)
      }
      for (const [form, make] of Object.entries(changed)) {
        const q = make(s)
        if (q !== null && !inPlan(flat, q)) note(form, checkQuote(doc, q) === 'missing', q)
      }
    }
  }
}

const row = (form, fails) => {
  const t = tally[form]
  if (!t) return console.log(`  ${form.padEnd(26)} none in these plans`)
  console.log(`  ${form.padEnd(26)} ${t.good}/${t.all}`)
  if (t.good < t.all) { fails.push(form); for (const b of t.bad) console.log(`    ${b}`) }
}
console.log(`${docs.length} plans (${files.length} real, 1 made up), ${sentences} sentences, ${outside} in a section marked out of scope`)
const fails = []
console.log('Honest quotes that must pass:')
for (const form of [...Object.keys(honest), 'table cell']) row(form, fails)
console.log('Changed quotes that must be refused:')
for (const form of Object.keys(changed)) row(form, fails)
console.log(`Sections: ${sections} across the plans, ${flagged} left in the "nothing quotes this" note if no state quoted anything, ${noSections} plans with none`)
if (fails.length) { console.error(`Below the bar: ${fails.join(', ')}`); process.exit(1) }

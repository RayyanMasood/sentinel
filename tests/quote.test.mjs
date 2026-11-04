// The comparison behind "proof it was asked for". Each test names a way it could go wrong.
//   node --test tests/quote.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkQuote, nearest, sectionOf, sectionsOf, spanOf, squash, unquoted } from '../hooks/quote.ts'

const PLAN = `# Studio bookings

## Bookings
- Members can **hold a seat** for ten minutes before paying.
- [x] Cancelling a booking frees the seat for the next person.
1. Staff see the \`class_roster\` on a schedule screen.

See [the booking rules](https://example.com/rules) for what happens at the door.

| Part | What it does |
|---|---|
| Waitlist | Holds people in line when a class is full |

## Payments
Charge the card at checkout, and “refund it” on cancel — within two days.

## Not in this plan
- Add a loyalty points scheme for regular members.
`

const ok = (doc, q) => assert.equal(checkQuote(doc, q), 'ok', q)

test('an exact sentence passes', () => ok(PLAN, 'Staff see the `class_roster` on a schedule screen.'))
test('bold, italic and code marks do not matter', () => {
  ok(PLAN, 'Members can hold a seat for ten minutes before paying.')
  ok(PLAN, 'Staff see the class_roster on a schedule screen.')
  ok('Send the *weekly* report to _every_ member of staff.', 'Send the weekly report to every member of staff.')
  ok('Send ~~the~~ report\\* to every\u200b member of staff.', 'Send the report to every member of staff.')
})
test('list, number, checkbox and quote markers do not matter', () => {
  ok(PLAN, '- Members can hold a seat for ten minutes')
  ok(PLAN, 'Cancelling a booking frees the seat for the next person.')
  ok('> - Keep the old export until the new one ships', 'Keep the old export until the new one ships')
  ok('1) Keep the old export until the new one ships', 'Keep the old export until the new one ships')
  ok('- Keep the old export\n- Until the new one ships', '- Keep the old export\n- Until the new one')
  ok('- [x] Keep the old\n- [ ] export until it ships', 'Keep the old export until it ships')
  assert.equal(squash('> - [x] Keep it'), 'Keep it')
  assert.equal(squash('1) Keep it'), 'Keep it')
})
test('a sentence wrapped across lines passes', () => {
  ok('Keep the old export\nrunning until the\r\nnew one ships.', 'Keep the old export running until the new one ships.')
  ok(PLAN, 'Members can hold a seat\n  for ten minutes')
})
test('a link counts as its words', () => {
  ok(PLAN, 'See the booking rules for what happens at the door.')
  ok(PLAN, 'See [the booking rules](https://example.com/rules) for what happens')
  ok('Show ![the seat map](map.png) on every booking page.', 'Show the seat map on every booking page.')
})
test('a table cell passes, and so do neighbouring cells', () => {
  ok(PLAN, 'Holds people in line when a class is full')
  ok(PLAN, 'Waitlist Holds people in line when a class')
})
test('curly quotes and long dashes match the plain ones', () => {
  ok(PLAN, 'and "refund it" on cancel - within two days.')
  ok('Don’t charge twice for the same class.', "Don't charge twice for the same class.")
  ok('Run the import first—then the nightly report.', 'Run the import first - then the nightly report.')
  ok('Wait for it… then send the mail out.', 'Wait for it... then send the mail out.')
})

test('a changed word is refused', () => assert.equal(checkQuote(PLAN, 'Members can hold a seat for twenty minutes before paying.'), 'missing'))
test('a dropped word is refused', () => assert.equal(checkQuote(PLAN, 'Members can hold seat for ten minutes before paying.'), 'missing'))
test('an added feature is refused', () => assert.equal(checkQuote(PLAN, 'Members can hold a seat for ten minutes and export it to PDF.'), 'missing'))
test('different capitals are refused', () => assert.equal(checkQuote(PLAN, 'members can hold a seat for ten minutes'), 'missing'))
test('a quote cannot end or start inside a longer word', () => {
  assert.equal(checkQuote('We will pay by card on the nextday run.', 'pay by card on the next'), 'missing')
  assert.equal(checkQuote('We will repay by card on the next run.', 'pay by card on the next'), 'missing')
  ok('We will repay by card on the next run.', 'repay by card on the next')
  ok('Stop, and pay by card on the next run.', 'pay by card on the next')
  ok('We repay by card on the next run, then pay by card on the next day.', 'pay by card on the next')
})
test('punctuation beside a quote is not part of a word', () => ok('(Pay by card on the next run.)', 'Pay by card on the next run'))

test('under five words is refused', () => {
  assert.equal(checkQuote(PLAN, 'Charge the card'), 'short')
  assert.equal(checkQuote(PLAN, 'Charge the card at'), 'short')
})
test('five words is enough', () => ok(PLAN, 'Charge the card at checkout'))
test('nothing to compare is refused', () => {
  assert.equal(checkQuote(PLAN, ''), 'empty')
  assert.equal(checkQuote(PLAN, '   \n '), 'empty')
  assert.equal(checkQuote(PLAN, '** `` _'), 'empty')
})
test('a short message passes when quoted whole', () => {
  ok('Fix the typo', 'Fix the typo')
  ok('Fix it', 'Fix it')
  assert.equal(checkQuote('Fix the typo on the pricing page', 'Fix the typo'), 'short')
})
test('a bare yes proves nothing, even whole', () => {
  for (const m of ['yes', 'Yes!', 'ok', 'go ahead', 'do it', 'yeah, looks good', 'Sounds good, thanks.', 'yes please', 'Yes, that looks good to me.', 'yes - do it']) assert.equal(checkQuote(m, m), 'short', m)
})
test('an empty source holds nothing', () => assert.equal(checkQuote('', 'Charge the card at checkout'), 'missing'))

test('words from a section marked out of scope are not proof', () => {
  assert.equal(checkQuote(PLAN, 'Add a loyalty points scheme for regular members.'), 'excluded')
  assert.equal(checkQuote('## Out of scope\nAdd a loyalty points scheme now.', 'Add a loyalty points scheme now.'), 'excluded')
  assert.equal(checkQuote('## Non-goals\nAdd a loyalty points scheme now.', 'Add a loyalty points scheme now.'), 'excluded')
  for (const h of ['Left for later', 'Named, not built', 'Deferred']) assert.equal(checkQuote(`## ${h}\nAdd a loyalty points scheme now.`, 'Add a loyalty points scheme now.'), 'excluded', h)
  assert.equal(checkQuote('## Bookings\nA real ask here.\n### Out of scope\nAdd a loyalty points scheme now.\n## Next\nMore.', 'Add a loyalty points scheme now.'), 'excluded')
})
test('the same words elsewhere still count', () => {
  ok('## Bookings\nA real ask here.\n### Out of scope\nNot this one please.\n## Next\nThe words that still count here.', 'The words that still count here.')
  ok(`${PLAN}\n## Rewards\nAdd a loyalty points scheme for regular members.`, 'Add a loyalty points scheme for regular members.')
})

test('sections are found, and their headings read plainly', () => {
  assert.deepEqual(sectionsOf(PLAN).map(s => s.name), ['Bookings', 'Payments', 'Not in this plan'])
  assert.deepEqual(sectionsOf('## The **big** `one`\r\ntext\r\n## Two\r\nmore').map(s => s.name), ['The big one', 'Two'])
})
test('a heading inside a code fence is not a section', () => {
  assert.deepEqual(sectionsOf('## One\n```sh\n## not a heading\n```\n## Two\ntext').map(s => s.name), ['One', 'Two'])
})
test('a plan without second-level headings still has sections', () => {
  assert.deepEqual(sectionsOf('# Title\ntext\n### Alpha\nmore\n### Beta\nmore').map(s => s.name), ['Alpha', 'Beta'])
  assert.deepEqual(sectionsOf('Just one paragraph with no headings at all.'), [])
  assert.deepEqual(sectionsOf('# Only\ntext\n### One\nmore').map(s => s.name), [])
  assert.deepEqual(sectionsOf('# First\ntext\n# Second\nmore').map(s => s.name), ['First', 'Second'])
})
test('a quote knows its section', () => {
  assert.equal(sectionOf(PLAN, 'Charge the card at checkout'), 'Payments')
  assert.equal(sectionOf(PLAN, 'Members can hold a seat for ten minutes'), 'Bookings')
  assert.equal(sectionOf(PLAN, 'Words that are not in the plan'), undefined)
  assert.equal(sectionOf(PLAN, '  '), undefined)
  assert.equal(sectionOf('## A\nFirst part here.\n### Sub\nStill inside section A.\n## B\nOther.', 'Still inside section A.'), 'A')
})

test('sections nothing quotes are listed', () => {
  assert.deepEqual(unquoted(PLAN, ['Charge the card at checkout']), ['Bookings'])
  assert.deepEqual(unquoted(PLAN, ['Charge the card at checkout', 'Members can hold a seat for ten minutes']), [])
})
test('background sections are left out of that list', () => {
  const doc = '## Context\nWhy we do this.\n## Verification\nRun it.\n## Files\nA list.\n## Risks\nSome.\n## Not in this plan\nMore.\n## Exports\nA real ask.'
  assert.deepEqual(unquoted(doc, []), ['Exports'])
})

test('the nearest passage is the real sentence, as written', () => {
  assert.equal(nearest(PLAN, 'Charge the card at checkout and refund it the same day'), 'Charge the card at checkout, and “refund it” on cancel — within two days.')
  assert.equal(nearest(PLAN, 'hold a seat for twenty minutes'), '- Members can **hold a seat** for ten minutes before paying.')
})
test('the nearest passage is one sentence, and never a heading', () => {
  assert.equal(nearest('## Refund the card today\nOther words. Refund the card later.', 'Refund the card today'), 'Refund the card later.')
  assert.equal(nearest('Refund the card. Refund the card today.', 'Refund the card today'), 'Refund the card today.')
  assert.equal(nearest('Refund the card now. Refund the card then.', 'Refund the card'), 'Refund the card now.')
})
test('nothing near gives nothing', () => {
  assert.equal(nearest('', 'anything at all here'), '')
  assert.equal(nearest(PLAN, 'zebra quantum'), '')
})
test('squash keeps words in order and leaves them whole', () => {
  assert.equal(squash('  - **One**  two\n\n`three`  '), 'One two three')
  assert.equal(squash('well-known'), 'well-known')
  assert.equal(squash('|---|:--|\n'), '')
  assert.equal(squash('|---|---|\r\nword'), 'word')
})

// Marking a quote in the saved copy.
const marked = (doc, q) => { const s = spanOf(doc, q); return s && doc.slice(s[0], s[1]) }
test('a quote typed as written marks exactly its words', () => {
  assert.equal(marked('Intro line.\nMembers pay by card at checkout today, and more.', 'Members pay by card at checkout'), 'Members pay by card at checkout')
  assert.equal(marked('Today members pay by card at checkout and go.', '  members pay by card at checkout  '), 'members pay by card at checkout')
})
test('a quote that marks get in the way of marks its whole line', () => {
  assert.equal(marked('Other line.\n  **Members** pay by card at checkout today.  \nLast.', 'Members pay by card at checkout'), '**Members** pay by card at checkout today.')
  assert.equal(marked('| a | Members pay by card at checkout |\n| b | c |', 'a Members pay by card at checkout'), '| a | Members pay by card at checkout |')
})
test('a quote wrapped across lines marks those lines and no others', () => {
  assert.equal(marked('Before.\nMembers pay by card\nat checkout today.\nAfter.', 'Members pay by card at checkout'), 'Members pay by card\nat checkout today.')
  assert.equal(marked('Before.\r\nMembers pay by card\r\nat checkout today.\r\nAfter.', 'Members pay by card at checkout'), 'Members pay by card\r\nat checkout today.')
})
test('a first word that shows up early does not start the mark', () => {
  assert.equal(marked('Members are welcome.\nSome filler words here.\nMembers pay by **card** at checkout.', 'Members pay by card at checkout'), 'Members pay by **card** at checkout.')
})
test('words that are not there, or nothing at all, mark nothing', () => {
  assert.equal(spanOf('Members pay by card.', 'Members pay by cash at checkout'), undefined)
  assert.equal(spanOf('Members pay by card.', '   '), undefined)
  assert.equal(spanOf('Members pay by **card**', 'Members pay by card undefined'), undefined)
  assert.equal(spanOf('Members pay by card\nand more\nand more\nand more', 'Members pay by card and more and more and more and a lot more'), undefined)
})

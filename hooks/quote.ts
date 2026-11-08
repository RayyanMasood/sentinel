// The comparison behind "proof it was asked for": do a state's quoted words really appear in what the user typed or approved?
// Code only, no model. Words must match exactly, capitals included. Only spacing and formatting marks are ignored.

export const MIN_WORDS = 5
export type Verdict = 'ok' | 'empty' | 'missing' | 'short' | 'excluded'
export type Section = { name: string; depth: number; at: number; body: string }

// The text as words: markdown marks, list markers, table pipes, link targets and typographic variants are gone.
export const squash = (t: string): string => t
  .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^(?:[ \t]*(?:#+|[-*+>]|\d+[.)]|\[[ xX]\])[ \t]+)+/gm, '')
  .replace(/[“”„‟]/g, '"')
  .replace(/[‘’‚‛]/g, "'")
  .replace(/[–—―−]/g, '-')
  .replace(/…/g, '...')
  .replace(/[*_`~\\\u200b]/g, '')
  .replace(/\|/g, ' ')
  .replace(/\s*-\s*/g, '-')
  .replace(/\s+/g, ' ')
  .trim()

const WORD = /[\p{L}\p{N}]/u
const isWord = (c?: string) => !!c && WORD.test(c)

// Holds the words whole: "pay by card" is not in "repay by card".
function holds(doc: string, w: string): boolean {
  for (let at = doc.indexOf(w); at >= 0; at = doc.indexOf(w, at + 1)) {
    const cutsBefore = isWord(doc[at - 1]) && isWord(w[0])
    const cutsAfter = isWord(doc[at + w.length]) && isWord(w[w.length - 1])
    if (!cutsBefore && !cutsAfter) return true
  }
  return false
}

// Every heading outside a code fence, with its text up to the next heading at its depth or shallower.
function blocks(doc: string): Section[] {
  const found: { name: string; depth: number; at: number }[] = []
  let fence = false
  let pos = 0
  for (const raw of doc.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence
    else if (!fence) {
      const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*\r?$/.exec(raw)
      if (m) found.push({ name: squash(m[2]!), depth: m[1]!.length, at: pos })
    }
    pos += raw.length + 1
  }
  return found.map((h, i) => {
    const next = found.slice(i + 1).find(o => o.depth <= h.depth)
    return { name: h.name, depth: h.depth, at: h.at, body: doc.slice(h.at, next?.at ?? doc.length) }
  })
}

// The plan's sections: second-level headings, or else the shallowest level that appears at least twice.
export function sectionsOf(doc: string): Section[] {
  const all = blocks(doc)
  const count = (d: number) => all.filter(b => b.depth === d).length
  const level = count(2) ? 2 : [1, 3, 4, 5, 6].find(d => count(d) >= 2)
  return level ? all.filter(b => b.depth === level) : []
}

// ponytail: reads the heading only, so a "Not in this plan:" line under another heading still counts as asked for.
const EXCLUDED = /\b(not in (this|the) (plan|scope|phase)|out of scope|non-?goals?|left for later|not built|deferred)\b/i
const BACKGROUND = /\b(context|background|overview|summary|verification|approach|execution|files|risks)\b/i

// Words that agree with something without saying what. A quote made only of these proves nothing.
// ponytail: a fixed list, so "yes, ship the lot" passes as a whole message. Extend it if a real plan gets through.
const ASSENT = new Set(('yes yeah yep yup ok okay sure fine good great nice perfect right correct agreed lgtm '
  + 'looks look sounds seems go ahead do it that this is all so far to me i think please thanks thank you and').split(' '))
const bare = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

export function checkQuote(doc: string, quote: string): Verdict {
  const w = squash(quote)
  if (!w) return 'empty'
  const whole = squash(doc)
  if (!holds(whole, w)) return 'missing'
  const kept = blocks(doc).filter(b => EXCLUDED.test(b.name)).reduce((d, b) => d.replace(b.body, ''), doc)
  if (!holds(squash(kept), w)) return 'excluded'
  if (w.split(/[ -]/).every(x => !bare(x) || ASSENT.has(bare(x)))) return 'short'
  return w.split(' ').length >= MIN_WORDS || w === whole ? 'ok' : 'short'
}

// A quote for one setting. short: what it sets and one more word will do, which suits an instruction turned on or a
// stricter weight. Anything looser keeps the 5-word rule, as "go light" sits inside "don't go light on this", and has to
// name what it loosens, as any five words the user typed would otherwise unlock it.
// ponytail: compares words, not meaning, so "don't go light on this" counts; the draft shows it with a button to undo it.
export function checkSetting(doc: string, quote: string, name: string, short: boolean): Verdict | 'unnamed' {
  const v = checkQuote(doc, quote)
  const named = namesIn(quote, name)
  if (v === 'short' && short) return named && wordsOf(quote).length > wordsOf(name).length ? 'ok' : 'short'
  return v === 'ok' && !short && !named ? 'unnamed' : v
}

const wordsOf = (t: string) => squash(t).split(/[ -]/).map(bare).filter(Boolean)
// The quote has the name's words together and in order, whatever the case, dashes or marks around them.
export function namesIn(quote: string, name: string): boolean {
  const said = wordsOf(quote)
  const want = wordsOf(name)
  return want.length > 0 && said.some((_, k) => want.every((w, j) => said[k + j] === w))
}

export const sectionOf = (doc: string, quote: string): string | undefined => {
  const w = squash(quote)
  return w ? sectionsOf(doc).find(s => holds(squash(s.body), w))?.name : undefined
}

// Where a quote sits in the text as written, so a screen can mark it: the words themselves when the text has them as
// typed, or the whole lines they run across when marks or wrapping get in the way.
export function spanOf(doc: string, quote: string): [number, number] | undefined {
  const w = squash(quote)
  if (!w) return undefined
  const typed = quote.trim()
  const at = doc.indexOf(typed)
  if (at >= 0) return [at, at + typed.length]
  const lines = doc.split('\n')
  const first = w.split(' ')[0]!
  let from = 0
  for (const [i, line] of lines.entries()) {
    const own = squash(line)
    if (own.includes(first)) {
      for (let j = i + 1, text = line; ; text += `\n${lines[j++]}`) {
        const got = squash(text)
        if (holds(got, w) && got.indexOf(w) < own.length) return [from + text.length - text.trimStart().length, from + text.trimEnd().length]
        if (j >= lines.length || got.length > own.length + w.length) break
      }
    }
    from += line.length + 1
  }
  return undefined
}

// Sections that look like asks and that no quote falls in. Only ever a note: a section can be background under any name.
export const unquotedSections = (doc: string, quotes: string[]): Section[] => {
  const ws = quotes.map(squash).filter(Boolean)
  return sectionsOf(doc)
    .filter(s => !EXCLUDED.test(s.name) && !BACKGROUND.test(s.name) && !ws.some(w => holds(squash(s.body), w)))
}
export const unquoted = (doc: string, quotes: string[]): string[] => unquotedSections(doc, quotes).map(s => s.name)

// The sentence closest to a refused quote, as written, so Claude can copy it or see the plan never said it.
export function nearest(doc: string, quote: string): string {
  const want = new Set(squash(quote).split(' ').map(bare).filter(Boolean))
  let best = ''
  let most = 0
  for (const line of doc.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    for (const sentence of line.trim().split(/(?<=[.!?])\s+/)) {
      const n = new Set(sentence.split(/\s+/).map(bare).filter(w => want.has(w))).size
      if (n > most) { most = n; best = sentence }
    }
  }
  return best
}

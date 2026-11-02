// A clip is drawn from one clock: scene.seek(t) draws the frame at t seconds, so render.cjs can step through it frame by
// frame. Opened in a browser over http (the dashboard has to come from the same server), the clip plays and loops.

const RENDER = new URLSearchParams(location.search).has('render')
// ?portrait lays the stage out at 1080 × 1350, for the feed cut in linkedin.html.
const PORTRAIT = new URLSearchParams(location.search).has('portrait')
if (PORTRAIT) document.documentElement.classList.add('portrait')
const clamp = x => Math.min(1, Math.max(0, x))
const out3 = x => 1 - Math.pow(1 - x, 3)
const inOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
// How far a change that starts at `at` and takes `dur` seconds has got by t.
const prog = (t, at, dur = 0.35, ease = out3) => ease(clamp((t - at) / dur))
const lerp = (a, b, k) => a + (b - a) * k
const $ = id => document.getElementById(id)
const el = (tag, cls, html) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}
// The last cue at or before t, from a list of [at, ...]; the first one before any.
const cue = (t, cues) => cues.reduce((v, c) => (c[0] <= t ? c : v), cues[0])
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
// Sound cues, [t, name], gathered as the helpers below are set up; a scene hands them on as scene.sounds, and sfx.py
// makes the sounds when a clip is encoded with audio (the MP4 feed cut).
const SFX = []
const sfx = (t, name) => { if (t >= 0) SFX.push([Math.round(t * 1000) / 1000, name]) }

// Claude Code: the transcript, Sentinel's line above the prompt, and the prompt.
// rows: { at, cls, html, done?: [t, 'ok' | 'no'] }; a tool call's dot stays grey until it is done.
function terminal(win, rows, { typed, band, toast }) {
  const box = win.querySelector('.lines'), view = win.querySelector('.view')
  const els = rows.map(r => box.appendChild(el('div', r.cls, r.html)))
  const bandEl = win.querySelector('.band'), txt = bandEl.querySelector('.txt')
  const prompt = win.querySelector('.prompt'), toastEl = win.querySelector('.toast')
  // Its sounds: keys as the prompt types (no faster than a quick typist), Enter, a tick as a check run or plan call
  // finishes and a lower one for anything refused or failed, an alert as the run goes stuck, and a pop for a toast.
  // Reads and edits that go through make no sound.
  const [from, to, sent, words] = typed
  let key = -1
  for (let i = 1; i <= words.length; i++) {
    const at = from + (to - from) * (i - 0.5) / words.length
    if (at - key >= 0.07) { sfx(at, words[i - 1] === ' ' ? 'space' : 'key'); key = at }
  }
  if (words) sfx(sent, 'enter')
  const alerts = band.filter((c, i) => c[2] === 'err' && band[i - 1]?.[2] !== 'err').map(c => c[0])
  alerts.forEach(a => sfx(a, 'alert'))
  const near = t => alerts.some(a => Math.abs(a - t) < 0.3)
  const quiet = r => r.done[1] === 'ok' && /^<b>(Read|Update|Write|Edit)</.test(r.html)
  rows.forEach(r => r.done && !quiet(r) && !(r.done[1] === 'no' && near(r.done[0])) && sfx(r.done[0], r.done[1] === 'ok' ? 'tick' : 'deny'))
  if (toast && !near(toast[0])) sfx(toast[0], 'toast')
  return t => {
    // A toast under the prompt, for the time it shows.
    if (toastEl) toastEl.style.opacity = toast ? prog(t, toast[0], 0.25) * (1 - prog(t, toast[1], 0.3)) : 0
    let last = -1
    els.forEach((e, i) => {
      const r = rows[i], k = prog(t, r.at, 0.25)
      e.style.display = t >= r.at ? '' : 'none'
      e.style.opacity = k
      e.style.transform = `translateY(${(1 - k) * 4}px)`
      if (r.done) e.classList.toggle(r.done[1], t >= r.done[0])
      // A call still running blinks its dot.
      if (r.done) e.classList.toggle('wait', t < r.done[0] && Math.floor(t * 3) % 2 === 0)
      if (t >= r.at) last = i
    })
    // Keep the newest line in sight. Like a terminal, the transcript jumps up a line at a time.
    const off = last < 0 ? 0 : Math.max(0, els[last].offsetTop + els[last].offsetHeight + 28 - view.clientHeight)
    box.style.transform = `translateY(${-off}px)`
    const [, text = '', tone = '', btns = ['Open']] = cue(t, band)
    bandEl.style.visibility = text ? 'visible' : 'hidden'
    bandEl.className = 'band ' + tone
    txt.textContent = text
    const names = btns.join('|')
    if (bandEl.dataset.btns !== names) {
      bandEl.querySelectorAll('.btn').forEach(b => b.remove())
      btns.forEach(n => bandEl.append(el('span', 'btn', esc(n))))
      bandEl.dataset.btns = names
    }
    // The prompt types its text, then sends it.
    const n = t < from ? 0 : t >= sent ? 0 : Math.round(words.length * clamp((t - from) / (to - from)))
    prompt.innerHTML = esc(words.slice(0, n)) + (t < sent && Math.floor(t * 2.4) % 2 === 0 ? '<i class="caret"></i>' : t < sent ? '<i class="caret" style="opacity:0"></i>' : '')
    return { btn: bandEl.querySelector('.btn') }
  }
}

// The real dashboard, web/view.html, in an iframe: fed the moments runs.mjs saved, its clocks held to each moment's time,
// and seen through a camera. Its timers are stopped so nothing moves except what the clip moves.
function dashboard(screen, moments, { width = 760, height = 3000, view = 'line' } = {}) {
  try {
    localStorage.setItem('sentinel.view', view)
    localStorage.setItem('sentinel.theme', 'light')
  } catch {}
  const frame = el('iframe')
  frame.style.width = width + 'px'
  frame.style.height = height + 'px'
  screen.prepend(frame)
  let fw, shown, fake = 0, at = ''
  const seen = new Map()
  const ready = new Promise(res => {
    frame.onload = async () => {
      fw = frame.contentWindow
      const last = fw.setInterval(() => {}, 1e9)
      for (let i = 0; i <= last; i++) fw.clearInterval(i)
      fw.Date.now = () => fake
      await fw.document.fonts.ready
      res()
    }
  })
  frame.src = '/web/view.html?k=demo'
  const scale = () => screen.clientWidth / width
  return {
    ready,
    doc: () => fw.document,
    scale,
    // Shows a moment; the page only redraws when it changes.
    show(name, t) {
      if (name !== shown) {
        const m = moments[name]
        fake = m.now + 20_000
        fw.__sentinel(m.vm)
        fw.eval('changedAt = lastAt = Date.now(); freshness(); typeof tick === "function" && tick()')
        shown = name
      }
      // The page's own animations (a spinner, a pulse) follow the clip's clock, so each render comes out the same.
      if (RENDER) for (const a of fw.document.getAnimations()) {
        if (!seen.has(a)) seen.set(a, t)
        a.pause()
        a.currentTime = (t - seen.get(a)) * 1000
      }
    },
    // The camera: y is the page's top edge in view, zoom on top of the fit to the screen's width.
    look(y, zoom = 1, x = 0) {
      const s = scale() * zoom
      frame.style.transform = `translate(${-x * s}px, ${-y * s}px) scale(${s})`
      return { s, x, y }
    },
    // Switches the page between Run ('') and Flows ('#flows'), as its own links do.
    route(hash) {
      if (hash === at) return
      fw.history.replaceState(null, '', hash || fw.location.pathname + fw.location.search)
      fw.route()
      at = hash
    },
    // Runs code inside the page, for what only its own script can reach.
    eval: code => fw.eval(code),
    // A box on the page, where the camera puts it on the stage.
    place(b, cam) {
      const r = screen.getBoundingClientRect()
      return { x: r.left + (b.x - cam.x) * cam.s, y: r.top + (b.y - cam.y) * cam.s, w: b.w * cam.s, h: b.h * cam.s }
    },
    // The visible height in page pixels, and how far down the page can go.
    span: (zoom = 1) => screen.clientHeight / (scale() * zoom),
    bottom: () => fw.document.documentElement.scrollHeight,
  }
}

// The smallest element of a page whose text starts with `text`.
const textEl = (doc, text) => [...doc.body.querySelectorAll('*')].filter(e => e.textContent.trim().startsWith(text)).sort((a, b) => a.textContent.length - b.textContent.length)[0]

// The box around some elements of the page, in page pixels. A hidden element has none.
function box(...els) {
  const rs = els.filter(Boolean).map(e => e.getBoundingClientRect()).filter(r => r.width || r.height)
  if (!rs.length) return null
  const x = Math.min(...rs.map(r => r.left)), y = Math.min(...rs.map(r => r.top))
  return { x, y, w: Math.max(...rs.map(r => r.right)) - x, h: Math.max(...rs.map(r => r.bottom)) - y }
}

// A ring that draws itself around a box on the screen, holds, and fades.
function ringer(svg) {
  const pool = [], heard = new Set()
  return (t, rings, cam) => {
    // Each ring sounds as it starts to draw.
    for (const r of rings) if (!heard.has(r)) { heard.add(r); sfx(r.at, 'ring-' + r.tone) }
    rings.forEach((r, i) => {
      let g = pool[i]
      if (!g) {
        g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        g.innerHTML = '<rect class="glow" rx="9" fill="none" stroke-width="7"></rect><rect class="line" rx="7" fill="none" stroke-width="2.25" pathLength="1" stroke-dasharray="1 1"></rect>'
        svg.append(g)
        pool[i] = g
      }
      const on = t >= r.at && t < r.at + r.hold + 0.5
      g.style.display = on ? '' : 'none'
      if (!on) return
      const b = r.box()
      if (!b) return (g.style.display = 'none')
      const pad = r.pad ?? 6
      const x = (b.x - cam.x - pad) * cam.s, y = (b.y - cam.y - pad) * cam.s, w = (b.w + pad * 2) * cam.s, h = (b.h + pad * 2) * cam.s
      const color = { red: '#c42b1f', blue: '#1a9fff', green: '#0d7a4a' }[r.tone]
      const fade = 1 - prog(t, r.at + r.hold, 0.5)
      for (const rect of g.children) {
        rect.setAttribute('x', x)
        rect.setAttribute('y', y)
        rect.setAttribute('width', w)
        rect.setAttribute('height', h)
        rect.setAttribute('stroke', color)
      }
      g.children[0].style.opacity = 0.16 * prog(t, r.at + 0.25, 0.4) * fade
      g.children[1].style.strokeDashoffset = 1 - prog(t, r.at, 0.55, inOut)
      g.children[1].style.opacity = fade
    })
  }
}

// Captions along the bottom, one per step, with a tick for each that fills while it runs.
function captions(root, list, end) {
  const caps = list.map(([, text], i) => root.appendChild(el('div', 'cap', `<span>${text}</span>`)))
  const ticks = root.appendChild(el('div', 'ticks', list.map(() => '<i></i>').join(''))).children
  return t => {
    list.forEach(([at], i) => {
      const next = list[i + 1]?.[0] ?? end
      const k = prog(t, at + 0.08, 0.4), gone = prog(t, next - 0.05, 0.3)
      caps[i].style.opacity = k * (1 - gone)
      caps[i].style.transform = `translateY(${(1 - k) * 12 - gone * 12}px)`
      ticks[i].className = t >= at && t < next ? 'on' : ''
      ticks[i].style.setProperty('--k', clamp((t - at) / (next - at)))
    })
  }
}

// The pointer: it glides to each target in turn and presses where a click falls. moves: { at, to: () => [x, y] | null },
// clicks: times. A target that isn't there yet keeps the last place it had.
// away: [from, to] stretches when it is off the stage.
function pointer(el, ripple, moves, clicks, { from = [1100, 700], hide = Infinity, away = [] } = {}) {
  const seen = moves.map(() => null)
  clicks.forEach(c => sfx(c, 'click'))
  const where = i => {
    if (i < 0) return from
    const p = moves[i].to()
    if (p) seen[i] = p
    return seen[i] ?? where(i - 1)
  }
  return t => {
    let i = -1
    while (i + 1 < moves.length && moves[i + 1].at <= t) i++
    const p = i < 0 ? from : (() => { const a = where(i - 1), b = where(i), k = prog(t, moves[i].at, 0.75, inOut); return [lerp(a[0], b[0], k), lerp(a[1], b[1], k)] })()
    const gone = away.reduce((k, [a, b]) => k * (t < b ? 1 - prog(t, a, 0.25) : prog(t, b, 0.25)), 1)
    el.style.opacity = moves.length ? prog(t, moves[0].at, 0.2) * (1 - prog(t, hide, 0.25)) * gone : 0
    el.style.transform = `translate(${p[0]}px, ${p[1]}px)`
    const c = clicks.findLast(c => c <= t), k = c === undefined ? 1 : prog(t, c, 0.5)
    Object.assign(ripple.style, { left: p[0] + 'px', top: p[1] + 'px', opacity: k < 1 ? 0.9 * (1 - k) : 0, transform: `scale(${0.4 + k})` })
  }
}

// The scene registers itself here; the page plays it unless render.cjs drives it.
function play(scene) {
  scene.sounds ??= SFX
  window.scene = scene
  if (RENDER) return
  Promise.all([document.fonts.ready, scene.ready]).then(() => {
    const t0 = performance.now()
    const tick = now => {
      scene.seek(((now - t0) / 1000) % scene.duration)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

// One Sentinel page with a tab per session. Each session keeps its own helper (serve.mjs) and page, and this serves the page
// that shows them in frames, on one port. `node hub.mjs open` starts it if need be and hands it the session named in
// SENTINEL_TAB_PORT, SENTINEL_TAB_TOKEN and SENTINEL_TAB_NAME. Plain Node, no packages.
//
// Whoever holds a session's token can answer Sentinel's questions, so tokens stay in this process's memory, and its own
// token goes only to the browser. No file holds them, as Claude can read files.
// ponytail: Claude could still catch a token by holding this port before the hub starts, or read the address from the
// browser's history, as it already can today; move to a cookie and a checked hub if that becomes a concern.
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, get, request } from 'node:http'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const { SENTINEL_HUB_OPENER: OPENER, SENTINEL_TAB_PORT, SENTINEL_TAB_TOKEN, SENTINEL_TAB_NAME, ...kept } = process.env
const PORT = Number(kept.SENTINEL_HUB_PORT) || 40999
// How often sessions are checked, and how long after the last session the hub stays.
const CHECK = Number(kept.SENTINEL_HUB_CHECK_MS) || 5000
const IDLE = Number(kept.SENTINEL_HUB_IDLE_MS) || 3_600_000
const MAX = 4096

const sleep = ms => new Promise(ok => setTimeout(ok, ms))

// ---- the open command ----

const post = body => new Promise(done => {
  const req = request({ host: '127.0.0.1', port: PORT, path: '/open', method: 'POST', timeout: 1000, headers: { 'content-type': 'application/json', 'x-sentinel-hub': '1', 'content-length': Buffer.byteLength(body) } }, res => {
    res.resume()
    done(res.statusCode)
  })
  req.on('error', () => done(0))
  req.on('timeout', () => req.destroy())
  req.end(body)
})

async function open() {
  const body = JSON.stringify({ port: Number(SENTINEL_TAB_PORT), token: SENTINEL_TAB_TOKEN, name: SENTINEL_TAB_NAME })
  let code = await post(body)
  if (!code) {
    // It has to outlive the session, and a fixed folder keeps it from holding the session's folder open.
    spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', windowsHide: true, cwd: tmpdir(), env: { ...kept, ...(OPENER ? { SENTINEL_HUB_OPENER: OPENER } : {}) } }).unref()
    for (let i = 0; i < 40 && !code; i++) {
      await sleep(100)
      code = await post(body)
    }
  }
  process.exit(code === 204 ? 0 : 1)
}

// ---- the hub ----

function hub() {
  const token = randomBytes(16).toString('hex')
  const html = readFileSync(new URL('./hub.html', import.meta.url), 'utf8')
  // As in serve.mjs: only the page's own script runs, hashed with its line ends turned to LF.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  const csp = `default-src 'self'; script-src 'sha256-${createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64')}'; ` +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-src http://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  const address = `127.0.0.1:${PORT}`
  const tabs = new Map()
  // The page switches to the tab named here when n moves on.
  const focus = { id: 0, n: 0 }
  // The pages open now, each holding a connection that gets the list whenever it changes. Timers slow to about once a minute
  // in a background tab, so a page that asked every second would look closed, and a second one would open.
  const pages = new Set()
  const list = () => `data: ${JSON.stringify({ tabs: [...tabs.values()].map(t => ({ id: t.port, name: t.name, url: `http://127.0.0.1:${t.port}/?k=${t.token}` })), focus })}\n\n`
  const tell = () => { for (const p of pages) p.write(list()) }
  let emptySince = Date.now()

  const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  const end = (res, code) => { res.writeHead(code); res.end() }

  function openBrowser(url) {
    const openers = OPENER ? [[...JSON.parse(OPENER), url]] : [['cmd', '/c', 'start', '', url], ['open', url], ['xdg-open', url]]
    const next = i => {
      if (i < openers.length) execFile(openers[i][0], openers[i].slice(1), { windowsHide: true, timeout: 10_000 }, err => { if (err) next(i + 1) })
    }
    next(0)
  }

  async function register(req, res) {
    if (req.headers['x-sentinel-hub'] !== '1') return end(res, 403)
    const parts = []
    let size = 0
    for await (const c of req) if ((size += c.length) <= MAX) parts.push(c)
    if (size > MAX) return end(res, 413)
    let t
    try { t = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { return end(res, 400) }
    const ok = t && Number.isInteger(t.port) && t.port >= 1024 && t.port <= 65535 && /^[0-9a-f]{32}$/.test(String(t.token)) && typeof t.name === 'string' && t.name.trim()
    if (!ok) return end(res, 400)
    const had = tabs.get(t.port)
    tabs.set(t.port, { port: t.port, token: t.token, name: t.name.trim().slice(0, 80), fails: had ? had.fails : 0 })
    if (pages.size) {
      focus.id = t.port
      focus.n++
    } else openBrowser(`http://${address}/?k=${token}#${t.port}`)
    tell()
    end(res, 204)
  }

  async function handle(req, res) {
    if (req.headers.host !== address) return end(res, 403)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname === '/open') return register(req, res)
    if (req.method !== 'GET' || !same(url.searchParams.get('k'), token)) return end(res, 403)
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    if (url.pathname === '/') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp })
      return res.end(html)
    }
    if (url.pathname !== '/tabs') return end(res, 404)
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' })
    res.write(list())
    pages.add(res)
    res.on('close', () => pages.delete(res))
  }

  // A session is there if its helper knows its token. A snapshot not written yet is a 404, which still counts.
  // Each check has its own connection, so a kept one can't answer for a helper that has stopped listening.
  const alive = t => new Promise(done => {
    const req = get({ agent: false, host: '127.0.0.1', port: t.port, path: `/state.js?k=${t.token}`, timeout: 2000 }, res => {
      res.resume()
      done(res.statusCode !== 403)
    })
    req.on('error', () => done(false))
    req.on('timeout', () => req.destroy())
  })
  const check = async () => {
    const had = tabs.size
    await Promise.all([...tabs.values()].map(async t => {
      t.fails = (await alive(t)) ? 0 : t.fails + 1
      if (t.fails >= 2) tabs.delete(t.port)
    }))
    if (tabs.size !== had) tell()
    if (tabs.size) emptySince = Date.now()
    else if (Date.now() - emptySince >= IDLE) process.exit(0)
    setTimeout(check, CHECK)
  }

  const server = createServer((req, res) => void handle(req, res).catch(() => (res.headersSent ? res.destroy() : end(res, 400))))
  // Another hub already has the port, and that one stays.
  server.once('error', () => process.exit(0))
  server.listen(PORT, '127.0.0.1', () => void check())
}

if (process.argv[2] === 'open') void open()
else hub()

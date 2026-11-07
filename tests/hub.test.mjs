// The hub: one page with a tab per session. Real processes and real HTTP. Run with: node --test tests/hub.test.mjs
//
// How it can fail, and where each is tested below:
//  1. The page or the tab list, which holds every session's token, is open to anyone who asks.
//  2. A web page tricks the browser into registering a tab or reading the list (another host, no custom header).
//  3. A bad registration is taken, or breaks the hub.
//  4. The browser opens every time, never, or with a session's token in its address. An open page that has gone quiet in the
//     background still counts, and a closed one does not.
//  5. A tab stays after its session has gone, or goes while the session is alive.
//  6. Two hubs at once fight over the port, or the second one takes over the first one's tabs.
//  7. The hub never exits, or exits with a session still open.
//  8. The open command leaves no hub, prints a token, or says it worked when it did not.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as run } from 'node:test'
import { fileURLToPath } from 'node:url'

// A test that hangs fails, as a real one holding a connection open would otherwise wait for ever.
const test = (name, fn) => run(name, { timeout: 30_000 }, fn)

const HUB = fileURLToPath(new URL('../web/hub.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'sentinel-hub-'))
const OPENER = join(dir, 'opener.mjs')
// Writes down the address it was given, and any session token the hub kept in its environment.
writeFileSync(OPENER, "import { appendFileSync } from 'node:fs'\nappendFileSync(process.argv[2], process.argv[3] + '\\n')\nappendFileSync(process.argv[2] + '.token', process.env.SENTINEL_TAB_TOKEN ?? '')\n")
const TOKEN = 'a'.repeat(32)

const sleep = ms => new Promise(ok => setTimeout(ok, ms))
const until = async (ok, what = 'it', ms = 5000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await ok()
    if (v) return v
    if (Date.now() > end) assert.fail(`${what} did not happen`)
    await sleep(25)
  }
}
const send = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
    let text = ''
    res.on('data', c => (text += c))
    res.on('end', () => ok({ status: res.statusCode, text, headers: res.headers }))
  })
  req.on('error', fail)
  req.end(body)
})
// A page: holds the hub's list open and keeps what it is sent.
const page = (port, k) => new Promise((ok, fail) => {
  const got = []
  const req = request({ host: '127.0.0.1', port, path: `/tabs?k=${k}`, agent: false }, res => {
    let text = ''
    res.on('data', c => {
      text += c
      for (let i = text.indexOf('\n\n'); i >= 0; i = text.indexOf('\n\n')) {
        got.push(JSON.parse(text.slice('data: '.length, i)))
        text = text.slice(i + 2)
      }
    })
    ok({ status: res.statusCode, type: res.headers['content-type'], got, latest: () => got.at(-1), close: () => req.destroy() })
  })
  req.on('error', e => { if (!req.destroyed) fail(e) })
  req.end()
})
const listening = async port => send(port, '/').then(() => true, () => false)
const freePort = () => new Promise(ok => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => ok(port))
  })
})
// A session's helper: answers its snapshot with the status given, until it is closed.
const session = (t, status = 200) => new Promise(ok => {
  const s = createServer((_, res) => { res.writeHead(s.status); res.end('x') }).listen(0, '127.0.0.1', () => {
    s.status = status
    t.after(() => s.close())
    ok(s)
  })
})
const envFor = (port, log, extra = {}) => ({
  ...process.env, SENTINEL_HUB_PORT: String(port), SENTINEL_HUB_OPENER: JSON.stringify([process.execPath, OPENER, log]),
  SENTINEL_HUB_CHECK_MS: '60', ...extra,
})
// A hub of its own, and what it opened in the browser.
async function hub(t, extra) {
  const port = await freePort()
  const log = join(dir, `opened-${port}.log`)
  const child = spawn(process.execPath, [HUB], { env: envFor(port, log, extra), stdio: 'ignore' })
  const gone = new Promise(ok => child.once('exit', ok))
  t.after(() => child.kill())
  await until(() => listening(port), 'the hub listening')
  const opened = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  const open = (tab, headers = { 'x-sentinel-hub': '1' }) => send(port, '/open', { method: 'POST', headers, body: JSON.stringify(tab) })
  // The hub's token, from the address it opened in the browser. Registering a tab is what makes it open one.
  const key = async s => {
    if (!opened().length) await open({ port: s.address().port, token: TOKEN, name: 'first' })
    const url = new URL((await until(() => opened()[0], 'the browser opening')))
    return url.searchParams.get('k')
  }
  // The list as a page gets it on arrival. It leaves at once, so this does not count as a page open.
  const tabs = async k => {
    const p = await page(port, k)
    await until(() => p.latest(), 'the list')
    p.close()
    await sleep(40)
    return p.latest()
  }
  return { port, child, gone, opened, open, key, tabs, log }
}

test('with no token there is no page and no tab list', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  for (const path of ['/', '/tabs', `/?k=${'b'.repeat(32)}`, `/tabs?k=${'b'.repeat(32)}`, `/?k=${encodeURIComponent('é'.repeat(32))}`]) assert.equal((await send(h.port, path)).status, 403, path)
  assert.equal((await send(h.port, `/?k=${k}`)).status, 200)
  const p = await page(h.port, k)
  assert.equal(p.status, 200)
  assert.equal(p.type, 'text/event-stream')
  p.close()
  assert.equal((await send(h.port, `/other?k=${k}`)).status, 404)
})

test('another host name is refused, even with the token, and for a registration', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const evil = { host: `evil.example:${h.port}` }
  assert.equal((await send(h.port, `/?k=${k}`, { headers: evil })).status, 403)
  assert.equal((await send(h.port, `/tabs?k=${k}`, { headers: evil })).status, 403)
  assert.equal((await send(h.port, '/open', { method: 'POST', headers: { ...evil, 'x-sentinel-hub': '1' }, body: JSON.stringify({ port: s.address().port, token: TOKEN, name: 'x' }) })).status, 403)
})

test('a registration needs the header a web page cannot send, and adds nothing without it', async t => {
  const h = await hub(t)
  const s = await session(t)
  const other = await session(t)
  const k = await h.key(s)
  assert.equal((await h.open({ port: other.address().port, token: TOKEN, name: 'x' }, {})).status, 403)
  assert.deepEqual((await h.tabs(k)).tabs.map(x => x.id), [s.address().port])
})

test('a bad registration is refused and the hub stays up', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const good = { port: s.address().port, token: TOKEN, name: 'x' }
  for (const bad of [{ ...good, port: 80 }, { ...good, port: 'x' }, { ...good, port: 70000 }, { ...good, port: String(good.port) }, { ...good, port: 1024.5 }, { ...good, token: 'short' }, { ...good, token: 'z'.repeat(32) }, { ...good, name: 7 }, { ...good, name: '' }, [1]]) {
    assert.equal((await h.open(bad)).status, 400, JSON.stringify(bad))
  }
  const post = body => send(h.port, '/open', { method: 'POST', headers: { 'x-sentinel-hub': '1' }, body })
  assert.equal((await post('not json')).status, 400)
  assert.equal((await post(JSON.stringify({ ...good, name: 'x'.repeat(10_000) }))).status, 413)
  assert.deepEqual((await h.tabs(k)).tabs.map(x => x.name), ['first'])
})

test('the first registration opens the browser on the hub, with no session token in the address', async t => {
  const h = await hub(t)
  const s = await session(t)
  assert.equal((await h.open({ port: s.address().port, token: TOKEN, name: 'shop' })).status, 204)
  const url = new URL(await until(() => h.opened()[0], 'the browser opening'))
  assert.equal(url.host, `127.0.0.1:${h.port}`)
  assert.match(url.searchParams.get('k'), /^[0-9a-f]{32}$/)
  assert.notEqual(url.searchParams.get('k'), TOKEN)
  assert.equal(url.hash, `#${s.address().port}`)
  assert.ok(!url.href.includes(TOKEN))
})

test('the tab list names each session and how to frame it', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const [tab] = (await h.tabs(k)).tabs
  const at = s.address().port
  assert.deepEqual(tab, { id: at, name: 'first', url: `http://127.0.0.1:${at}/?k=${TOKEN}` })
})

test('with the page open a new session adds a tab and the page switches to it, with no new browser tab', async t => {
  const h = await hub(t)
  const s = await session(t)
  const two = await session(t)
  const k = await h.key(s)
  const p = await page(h.port, k)
  await until(() => p.latest(), 'the list')
  t.after(() => p.close())
  const before = p.latest().focus
  // Long past any once-a-second check: a page in the background goes quiet, and still counts as open.
  await sleep(1200)
  await h.open({ port: two.address().port, token: TOKEN, name: 'second' })
  await until(() => p.latest().tabs.length === 2, 'the page hearing of the new tab')
  const now = p.latest()
  assert.deepEqual(now.tabs.map(x => x.name), ['first', 'second'])
  assert.equal(now.focus.id, two.address().port)
  assert.ok(now.focus.n > before.n)
  await sleep(100)
  assert.equal(h.opened().length, 1)
})

test('with the page closed, opening again opens the browser again', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const p = await page(h.port, k)
  await until(() => p.latest(), 'the list')
  p.close()
  await sleep(100)
  await h.open({ port: s.address().port, token: TOKEN, name: 'first' })
  await until(() => h.opened().length === 2, 'a second browser tab')
})

test('opening again from the same session updates its tab', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  await h.open({ port: s.address().port, token: 'c'.repeat(32), name: 'renamed' })
  const { tabs } = await h.tabs(k)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].name, 'renamed')
  assert.ok(tabs[0].url.endsWith('c'.repeat(32)))
})

test('a tab goes when its session has gone, or the port now holds another session', async t => {
  const h = await hub(t)
  const s = await session(t)
  const two = await session(t)
  const three = await session(t)
  const k = await h.key(s)
  await h.open({ port: two.address().port, token: TOKEN, name: 'second' })
  await h.open({ port: three.address().port, token: TOKEN, name: 'third' })
  // An open page hears of it without asking.
  const p = await page(h.port, k)
  await until(() => p.latest()?.tabs.length === 3, 'the three tabs')
  t.after(() => p.close())
  await new Promise(ok => two.close(ok))
  three.status = 403
  await until(() => p.latest().tabs.length === 1, 'the tabs going')
  assert.deepEqual(p.latest().tabs.map(x => x.name), ['first'])
})

test('a live session stays, even before its snapshot exists', async t => {
  const h = await hub(t)
  const s = await session(t, 404)
  const k = await h.key(s)
  await sleep(300)
  assert.equal((await h.tabs(k)).tabs.length, 1)
})

test('a check under way when a session registers again does not drop its new tab', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  // One check refused, the next one held open, and the ones after it answered.
  let checks = 0, release
  s.removeAllListeners('request')
  s.on('request', (_, res) => {
    const n = ++checks
    if (n === 2) release = () => { res.writeHead(403); res.end('x') }
    else { res.writeHead(n === 1 ? 403 : 200); res.end('x') }
  })
  await until(() => release, 'a check held open')
  await h.open({ port: s.address().port, token: TOKEN, name: 'again' })
  release()
  await until(() => checks >= 5, 'more checks')
  assert.deepEqual((await h.tabs(k)).tabs.map(x => x.name), ['again'])
})

test('each check has its own connection, so none keeps a stopped session answering', async t => {
  const h = await hub(t)
  const s = await session(t)
  const sockets = new Set()
  s.on('connection', c => sockets.add(c))
  await h.key(s)
  await until(() => sockets.size >= 3, 'three separate connections')
})

test('one failed check does not drop a tab', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  // One check refused, the ones after it answered.
  let checks = 0
  s.removeAllListeners('request')
  s.on('request', (_, res) => { res.writeHead(checks++ ? 200 : 403); res.end('x') })
  await until(() => checks >= 4, 'more checks')
  assert.equal((await h.tabs(k)).tabs.length, 1)
})

test('a second hub exits quietly and the first keeps its tabs', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const second = spawn(process.execPath, [HUB], { env: envFor(h.port, h.log), stdio: 'ignore' })
  const code = await new Promise(ok => second.once('exit', ok))
  assert.equal(code, 0)
  assert.equal((await h.tabs(k)).tabs.length, 1)
})

test('closing a tab takes it off the list, and only the page can do it', async t => {
  const h = await hub(t)
  const s = await session(t), two = await session(t)
  const k = await h.key(s)
  await h.open({ port: two.address().port, token: TOKEN, name: 'second' })
  const open = await page(h.port, k)
  t.after(() => open.close())
  await until(() => open.latest()?.tabs.length === 2, 'both tabs')
  const id = s.address().port
  for (const path of [`/close?id=${id}`, `/close?k=${'b'.repeat(32)}&id=${id}`]) assert.equal((await send(h.port, path, { method: 'POST' })).status, 403)
  assert.equal((await send(h.port, `/close?k=${k}&id=${id}`)).status, 404)
  assert.equal((await send(h.port, `/close?k=${k}&id=${id}`, { method: 'POST', headers: { host: `evil.example:${h.port}` } })).status, 403)
  assert.equal(open.latest().tabs.length, 2)
  assert.equal((await send(h.port, `/close?k=${k}&id=${id}`, { method: 'POST' })).status, 204)
  await until(() => open.latest().tabs.length === 1, 'the open page hearing of it')
  assert.deepEqual(open.latest().tabs.map(x => x.name), ['second'])
  assert.equal((await send(h.port, `/close?k=${k}&id=1`, { method: 'POST' })).status, 204)
})

test('a closed tab comes back when its session opens again, and the page moves to it', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const open = await page(h.port, k)
  t.after(() => open.close())
  await until(() => open.latest()?.tabs.length === 1, 'the tab')
  const id = s.address().port
  await send(h.port, `/close?k=${k}&id=${id}`, { method: 'POST' })
  await until(() => open.latest().tabs.length === 0, 'the tab closing')
  assert.equal((await h.open({ port: id, token: TOKEN, name: 'first' })).status, 204)
  await until(() => open.latest().tabs.length === 1, 'the tab coming back')
  assert.equal(open.latest().focus.id, id)
  assert.equal(h.opened().length, 1)
})

test('with the page closed too, opening again opens the browser', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const id = s.address().port
  await send(h.port, `/close?k=${k}&id=${id}`, { method: 'POST' })
  assert.equal((await h.tabs(k)).tabs.length, 0)
  await h.open({ port: id, token: TOKEN, name: 'first' })
  await until(() => h.opened().length === 2, 'the browser opening again')
  assert.equal((await h.tabs(k)).tabs.length, 1)
})

test('with the last session gone the hub stays while the page is open, and exits soon after it closes', async t => {
  const h = await hub(t, { SENTINEL_HUB_IDLE_MS: '300' })
  const s = await session(t)
  const k = await h.key(s)
  const open = await page(h.port, k)
  t.after(() => open.close())
  await new Promise(ok => s.close(ok))
  await until(() => open.latest()?.tabs.length === 0, 'the tab going')
  await sleep(700)
  assert.equal(h.child.exitCode, null)
  open.close()
  assert.equal(await Promise.race([h.gone, sleep(4000).then(() => 'still up')]), 0)
})

test('the hub stays a minute with nothing open, so it is gone long before an hour', () => {
  assert.match(readFileSync(HUB, 'utf8'), /SENTINEL_HUB_IDLE_MS\) \|\| 60_000/)
})

test('with no sessions the hub exits once idle, and not while a session is open', async t => {
  const h = await hub(t, { SENTINEL_HUB_IDLE_MS: '500' })
  const s = await session(t)
  await h.key(s)
  await sleep(800)
  assert.equal(h.child.exitCode, null)
  await new Promise(ok => s.close(ok))
  assert.equal(await Promise.race([h.gone, sleep(4000).then(() => 'still up')]), 0)
})

test('the page may run only its own script, and can frame only local sessions', async t => {
  const h = await hub(t)
  const s = await session(t)
  const k = await h.key(s)
  const { headers, text } = await send(h.port, `/?k=${k}`)
  const csp = headers['content-security-policy']
  const script = /<script>([\s\S]*?)<\/script>/.exec(text)[1].replace(/\r\n?/g, '\n')
  assert.ok(csp.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`), csp)
  assert.ok(csp.includes('frame-src http://127.0.0.1:*'), csp)
  assert.ok(csp.includes("frame-ancestors 'none'"), csp)
  assert.equal(headers['cache-control'], 'no-store')
})

// ---- the open command ----

const openCommand = (port, log, tab, extra = {}) => new Promise(ok => {
  const child = spawn(process.execPath, [HUB, 'open'], {
    env: { ...envFor(port, log, extra), SENTINEL_TAB_PORT: String(tab.port), SENTINEL_TAB_TOKEN: tab.token, SENTINEL_TAB_NAME: tab.name },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', c => (out += c))
  child.stderr.on('data', c => (out += c))
  child.once('close', code => ok({ code, out }))
})

test('the open command starts a hub when there is none, reuses it after, and prints nothing', async t => {
  const port = await freePort()
  const log = join(dir, `opened-${port}.log`)
  const s = await session(t)
  const two = await session(t)
  const IDLE = { SENTINEL_HUB_IDLE_MS: '300' }
  const one = await openCommand(port, log, { port: s.address().port, token: TOKEN, name: 'first' }, IDLE)
  assert.deepEqual(one, { code: 0, out: '' })
  const url = new URL(await until(() => existsSync(log) && readFileSync(log, 'utf8').split('\n')[0], 'the browser opening'))
  // The hub keeps tokens in its memory, and the first session's stays out of its environment too.
  assert.equal(await until(() => existsSync(`${log}.token`) && `[${readFileSync(`${log}.token`, 'utf8')}]`, 'the opener finishing'), '[]')
  const k = url.searchParams.get('k')
  // The hub stays up after the command has gone. Keeping a page open stops a second browser tab.
  const open = await page(port, k)
  await until(() => open.latest(), 'the list')
  t.after(() => open.close())
  assert.deepEqual(open.latest().tabs.map(x => x.name), ['first'])
  assert.deepEqual(await openCommand(port, log, { port: two.address().port, token: TOKEN, name: 'second' }, IDLE), { code: 0, out: '' })
  await until(() => open.latest().tabs.length === 2, 'the second tab')
  assert.deepEqual(open.latest().tabs.map(x => x.name), ['first', 'second'])
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 1)
  // With both sessions gone and the page closed it exits by itself, so nothing is left running.
  await new Promise(ok => s.close(ok))
  await new Promise(ok => two.close(ok))
  open.close()
  await until(async () => !(await listening(port)), 'the hub exiting', 8000)
})

test('the open command fails when something else holds the port', async t => {
  const taken = createServer((_, res) => { res.writeHead(404); res.end() }).listen(0, '127.0.0.1')
  await new Promise(ok => taken.once('listening', ok))
  t.after(() => taken.close())
  const s = await session(t)
  const log = join(dir, 'taken.log')
  const r = await openCommand(taken.address().port, log, { port: s.address().port, token: TOKEN, name: 'x' })
  assert.equal(r.code, 1)
  assert.equal(r.out, '')
  assert.equal(existsSync(log), false)
})

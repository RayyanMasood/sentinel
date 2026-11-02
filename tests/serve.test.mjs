// The dashboard server's trust checks. Run with: node --test tests/serve.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'sentinel-serve-'))
writeFileSync(join(dir, 'view.html'), '<p>page</p><script>go()</script>')
writeFileSync(join(dir, 'state.js'), 'window.__sentinel && window.__sentinel({})\n')

const start = (env = {}) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../web/serve.mjs', import.meta.url))], {
    env: { ...process.env, SENTINEL_PAGE: join(dir, 'view.html'), SENTINEL_STATE: join(dir, 'state.js'), ...env },
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  return { child, lines, ready: lines.next().then(l => JSON.parse(l.value)) }
}
let child, lines, port, token
before(async () => {
  const s = start()
  ;({ child, lines } = s)
  ;({ port, token } = await s.ready)
})
after(() => child.kill())

// A body given as an array goes in pieces, with no content-length.
const send = (path, { method = 'GET', headers = {}, body, at = port } = {}) => new Promise((ok, fail) => {
  const req = request({ host: '127.0.0.1', port: at, path, method, headers: { host: `127.0.0.1:${at}`, ...headers } }, res => {
    let text = ''
    res.on('data', c => (text += c))
    res.on('end', () => ok({ status: res.statusCode, text, headers: res.headers }))
  })
  req.on('error', fail)
  for (const piece of Array.isArray(body) ? body : []) req.write(piece)
  req.end(Array.isArray(body) ? undefined : body)
})

test('the page and the snapshot need the token', async () => {
  assert.equal((await send('/')).status, 403)
  assert.equal((await send('/state.js?k=wrong')).status, 403)
  assert.equal((await send(`/?k=${token}`)).text, '<p>page</p><script>go()</script>')
  assert.match((await send(`/state.js?t=1&k=${token}`)).text, /__sentinel/)
})

test('another host name is refused, even with the token', async () => {
  assert.equal((await send(`/?k=${token}`, { headers: { host: `evil.example:${port}` } })).status, 403)
})

test('a token of the right length in other characters is refused, and the server stays up', async () => {
  assert.equal((await send(`/?k=${encodeURIComponent('é'.repeat(32))}`)).status, 403)
  assert.equal((await send(`/?k=${token}`)).status, 200)
})

test('an answer needs the token header and comes out on stdout as one line', async () => {
  const answer = { kind: 'hint', text: 'try \\n' }
  assert.equal((await send(`/answer?k=${token}`, { method: 'POST', body: JSON.stringify(answer) })).status, 403)
  assert.equal((await send('/answer', { method: 'POST', headers: { 'x-sentinel-token': token }, body: JSON.stringify(answer) })).status, 204)
  assert.deepEqual(JSON.parse((await lines.next()).value), answer)
})

test('a body that is not a JSON object, or too big, is refused', async () => {
  const post = body => send('/answer', { method: 'POST', headers: { 'x-sentinel-token': token }, body })
  assert.equal((await post('[1]')).status, 400)
  assert.equal((await post('not json')).status, 400)
  assert.equal((await post(JSON.stringify({ text: 'x'.repeat(70_000) }))).status, 413)
  assert.equal((await post(['{"text":"', 'x'.repeat(40_000), 'x'.repeat(40_000), '"}'])).status, 413)
})

test('the page may run only its own inline script', async () => {
  const { headers } = await send(`/?k=${token}`)
  const hash = createHash('sha256').update('go()').digest('base64')
  assert.ok(headers['content-security-policy'].includes(`script-src 'self' 'sha256-${hash}';`))
})

test('a page checked out with CRLF line ends gets the hash the browser computes', async () => {
  writeFileSync(join(dir, 'crlf.html'), '<p>page</p><script>a()\r\nb()</script>\r\n')
  const s = start({ SENTINEL_PAGE: join(dir, 'crlf.html') })
  const { port: at, token: k } = await s.ready
  const { headers } = await send(`/?k=${k}`, { at })
  s.child.kill()
  assert.ok(headers['content-security-policy'].includes(`'sha256-${createHash('sha256').update('a()\nb()').digest('base64')}'`))
})

test("a second session on the project's port takes another one", async () => {
  const two = start({ SENTINEL_PORT: String(port) })
  const { port: other } = await two.ready
  two.child.kill()
  assert.notEqual(other, port)
})

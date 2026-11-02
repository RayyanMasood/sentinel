// Sentinel's dashboard server. It serves the page and the plan snapshot on 127.0.0.1, and passes what the user sends
// from the page to the plugin as one JSON line each on stdout. Every request must carry this session's token.
// The first line on stdout is {"port", "token"}. Plain Node, no packages.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const { SENTINEL_PAGE: PAGE, SENTINEL_STATE: STATE, SENTINEL_PORT: PORT } = process.env
const token = randomBytes(16).toString('hex')
const MAX = 64 * 1024
// Set once listening. A request naming any other host (a DNS rebinding page) is refused.
let host = ''

const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const end = (res, code) => { res.writeHead(code); res.end() }
const FILES = { '/': [() => PAGE, 'text/html; charset=utf-8'], '/state.js': [() => STATE, 'text/javascript; charset=utf-8'] }
// The page shows text the model wrote, and what it sends becomes a prompt, so only its own inline script may run. The
// browser hashes the script with its line ends turned to LF, so the hash here does too.
const csp = html => `default-src 'self'; script-src 'self' ${[...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64')}'`).join(' ')}; ` +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const server = createServer((req, res) => void handle(req, res).catch(() => (res.headersSent ? res.destroy() : end(res, 400))))

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // The page sends the token in a header, which a page from another origin can't do without a preflight this server
  // never answers. GETs carry it in the query, since a script tag can't send headers.
  const key = req.method === 'POST' ? req.headers['x-sentinel-token'] : url.searchParams.get('k')
  if (req.headers.host !== host || !same(key, token)) return end(res, 403)
  const file = req.method === 'GET' && FILES[url.pathname]
  if (file) {
    const body = await readFile(file[0]()).catch(() => null)
    if (!body) return end(res, 404)
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(url.pathname === '/' && { 'content-security-policy': csp(body) }) })
    return res.end(body)
  }
  if (req.method !== 'POST' || url.pathname !== '/answer') return end(res, 404)
  if (Number(req.headers['content-length']) > MAX) { req.resume(); return end(res, 413) }
  // A body sent without a length is read to its end, keeping only what fits, so the 413 reaches the client.
  const parts = []
  let size = 0
  for await (const c of req) if ((size += c.length) <= MAX) parts.push(c)
  if (size > MAX) return end(res, 413)
  let body
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { return end(res, 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return end(res, 400)
  process.stdout.write(JSON.stringify(body) + '\n')
  end(res, 204)
}

// The project's own port keeps the page's address, and so its notification permission, from one session to the next.
// Another session on the same project already has it, so this one takes any free port.
server.once('error', () => server.listen(0, '127.0.0.1'))
server.listen(Number(PORT) || 0, '127.0.0.1')
server.once('listening', () => {
  server.removeAllListeners('error')
  const { port } = server.address()
  host = `127.0.0.1:${port}`
  process.stdout.write(JSON.stringify({ port, token }) + '\n')
})

// The plugin's module unload ends this process. A parent that went away without one ends it too.
const parent = process.ppid
setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 5000)

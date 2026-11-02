// Renders the README clips into docs/media/<scene>.webp. Playwright comes through npx, so it isn't a dependency:
//
//   npx -y -p playwright@1.64.1 -c "node docs/media/src/render.cjs run"
//
// Each scene page draws any moment on request (scene.seek in stage.js). This serves the repository, so a scene can load
// the real dashboard from web/view.html, steps through the scene at FPS, saves the frames to a temp folder, and encode.py
// packs them into an animated WebP. Needs Python with Pillow.
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { execFileSync } = require('child_process')

const bin = process.env.PATH.split(path.delimiter).find(p => p.includes('_npx') && p.endsWith('.bin'))
const { chromium } = require(bin ? path.join(bin, '..', 'playwright') : 'playwright')
const ROOT = path.join(__dirname, '..', '..', '..')
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const ok = file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()
  res.writeHead(ok ? 200 : 404, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  ok ? fs.createReadStream(file).pipe(res) : res.end()
})

;(async () => {
  const names = process.argv.slice(2)
  if (!names.length) throw new Error('Name the scenes to render, such as: run')
  // The installed Chrome, so nothing has to be downloaded; Playwright's own build otherwise.
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch())
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 } })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  for (const name of names) {
    await page.goto(`http://127.0.0.1:${server.address().port}/docs/media/src/${name}.html?render`)
    await page.waitForFunction(() => window.scene)
    await page.evaluate(() => Promise.all([document.fonts.ready, window.scene.ready]))
    // A scene can ask for its own size, frame rate and file type: linkedin.html is 1080 × 1350 at 30 fps, as MP4.
    const { duration, size = [1200, 675], fps: FPS = 20, ext = 'webp', sounds = [] } = await page.evaluate(() => JSON.parse(JSON.stringify(window.scene)))
    await page.setViewportSize({ width: size[0], height: size[1] })
    // FRAMES=<folder> keeps the frames there, for trying encoder settings.
    const dir = process.env.FRAMES ? path.join(process.env.FRAMES, name) : fs.mkdtempSync(path.join(os.tmpdir(), `clip-${name}-`))
    fs.mkdirSync(dir, { recursive: true })
    const n = Math.round(duration * FPS)
    for (let i = 0; i < n; i++) {
      await page.evaluate(t => window.scene.seek(t), i / FPS)
      await page.screenshot({ path: path.join(dir, `${String(i).padStart(5, '0')}.png`) })
    }
    // The sound cues go with the frames; encode.py lays them on an MP4's audio track.
    fs.writeFileSync(path.join(dir, 'sounds.json'), JSON.stringify(sounds))
    const out = path.join(__dirname, '..', `${name}.${ext}`)
    execFileSync('python', [path.join(__dirname, 'encode.py'), dir, out, String(FPS)], { stdio: 'inherit' })
    if (!process.env.FRAMES) fs.rmSync(dir, { recursive: true, force: true })
  }
  await browser.close()
  server.close()
})().catch(err => {
  console.error(err.message)
  process.exit(1)
})

// E2E suite — Playwright-core (same launch mechanics as og.ts) against the
// generated static output, plus a shell-level test of the daily-cron commit
// guard. Numeric expectations are computed Node-side from the committed data
// files, never hardcoded.
//
// Prereq: npm run generate       Run: npm run test:e2e

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import type { Fuse, Stats, VideoRecord } from '../types/index'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, '.vercel/output/static')

const videos = JSON.parse(readFileSync(join(ROOT, 'data/videos.json'), 'utf8')) as VideoRecord[]
const stats = JSON.parse(readFileSync(join(ROOT, 'data/stats.json'), 'utf8')) as Stats
const fuses = JSON.parse(readFileSync(join(ROOT, 'data/fuses.json'), 'utf8')) as Record<string, Fuse>

// ── tiny static server over the generated output ──────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain', '.ico': 'image/x-icon',
}
function serve(): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!)
    const candidates = [join(OUT, path), join(OUT, path, 'index.html'), join(OUT, '404.html')]
    for (const file of candidates) {
      if (existsSync(file) && extname(file)) {
        res.writeHead(file.endsWith('404.html') ? 404 : 200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        })
        res.end(readFileSync(file))
        return
      }
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => server.close() })
    })
  })
}

// ── micro test harness ────────────────────────────────────────────────────────
let passed = 0
const failures: string[] = []
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`  ✖ ${name}\n    ${(err as Error).message.split('\n')[0]}`)
  }
}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/** result-count waits out the client-side videos.json fetch ('…' while pending) */
async function resultCount(page: Page): Promise<number> {
  // string-form predicates: they run in the browser, and the pipeline tsconfig
  // deliberately has no DOM lib
  await page.waitForFunction(
    `(() => { const el = document.querySelector('[data-testid="result-count"]'); return el !== null && /^[\\d,]+$/.test((el.textContent || '').trim()) })()`,
    undefined,
    { timeout: 30_000 },
  )
  const text = await page.textContent('[data-testid="result-count"]')
  return Number(text!.replace(/,/g, ''))
}

// ── suite ─────────────────────────────────────────────────────────────────────
async function run(browser: Browser, base: string): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 960 } })
  const page = await ctx.newPage()

  // (a) fuse-filter count matches a Node-side count from videos.json
  const orMatch = (v: VideoRecord, ids: string[]) => v.teams.some((t) => t.fuse && ids.includes(t.fuse))
  const freestyleN = videos.filter((v) => orMatch(v, ['freestyle'])).length
  await test(`fuse filter: ?fuse=freestyle shows ${freestyleN} replays (from videos.json)`, async () => {
    await page.goto(`${base}/?fuse=freestyle`)
    const shown = await resultCount(page)
    expect(shown === freestyleN, `result-count ${shown} ≠ expected ${freestyleN}`)
  })

  // (a2) OR semantics across two selected fuses
  const pairN = videos.filter((v) => orMatch(v, ['juggernaut', '2x-assist'])).length
  await test(`fuse filter: juggernaut+2x-assist OR-match ${pairN} replays`, async () => {
    await page.goto(`${base}/?fuse=juggernaut,2x-assist`)
    const shown = await resultCount(page)
    expect(shown === pairN, `result-count ${shown} ≠ expected ${pairN}`)
  })

  // (a3) regression (2026-07-03 report): the rarest fuse's UI count must equal
  // the Node-computed count — guards over-matching and null-fuse leaks
  const jugN = videos.filter((v) => orMatch(v, ['juggernaut'])).length
  await test(`fuse filter: ?fuse=juggernaut shows ${jugN} replays (from videos.json)`, async () => {
    await page.goto(`${base}/?fuse=juggernaut`)
    const shown = await resultCount(page)
    expect(shown === jugN, `result-count ${shown} ≠ expected ${jugN}`)
  })

  // (b) deep-link round-trips: URL → chips, chip clicks → URL
  await test('fuse deep-link round-trips (URL ⇄ chip state)', async () => {
    await page.goto(`${base}/?fuse=juggernaut,2x-assist`)
    await page.waitForSelector('[data-testid="fuse-chip-juggernaut"]')
    for (const [id, want] of [['juggernaut', 'true'], ['2x-assist', 'true'], ['freestyle', 'false']] as const) {
      const got = await page.getAttribute(`[data-testid="fuse-chip-${id}"]`, 'aria-pressed')
      expect(got === want, `chip ${id} aria-pressed=${got}, want ${want}`)
    }
    await page.click('[data-testid="fuse-chip-2x-assist"]') // deselect
    await page.waitForFunction(`new URL(location.href).searchParams.get('fuse') === 'juggernaut'`)
    await page.click('[data-testid="fuse-chip-freestyle"]') // add
    await page.waitForFunction(
      `new URL(location.href).searchParams.get('fuse') === 'juggernaut,freestyle'`,
    )
  })

  // (c) modal: per-side fuses on an ordered record…
  const ordered = videos.find(
    (v) => v.teams.length === 2 && v.teams[0]!.fuse && v.teams[1]!.fuse && !v.fusesUnordered,
  )!
  const unordered = videos.find(
    (v) => v.fusesUnordered && v.teams.length === 2 && (v.teams[0]!.fuse || v.teams[1]!.fuse),
  )!
  await test(`modal: ordered record ${ordered.id} shows per-side fuse tags`, async () => {
    await page.goto(`${base}/?v=${ordered.id}`)
    await page.waitForSelector('[data-testid="team-fuse-a"]', { timeout: 30_000 })
    const a = norm(await page.textContent('[data-testid="team-fuse-a"]'))
    const b = norm(await page.textContent('[data-testid="team-fuse-b"]'))
    expect(a === norm(fuses[ordered.teams[0]!.fuse!]!.name), `left tag "${a}"`)
    expect(b === norm(fuses[ordered.teams[1]!.fuse!]!.name), `right tag "${b}"`)
    expect((await page.$('[data-testid="fuses-unordered"]')) === null, 'unordered row must be absent')
  })

  // …and the side-agnostic treatment on a fusesUnordered record
  await test(`modal: unordered record ${unordered.id} shows combined fuse row`, async () => {
    await page.goto(`${base}/?v=${unordered.id}`)
    await page.waitForSelector('[data-testid="fuses-unordered"]', { timeout: 30_000 })
    const row = norm(await page.textContent('[data-testid="fuses-unordered"]'))
    for (const t of unordered.teams) {
      if (t.fuse) expect(row.includes(norm(fuses[t.fuse]!.name)), `row "${row}" missing ${t.fuse}`)
    }
    expect((await page.$('[data-testid="team-fuse-a"]')) === null, 'per-side tag A must be absent')
    expect((await page.$('[data-testid="team-fuse-b"]')) === null, 'per-side tag B must be absent')
  })

  // (d) stats panels render the real top values…
  const usageRanked = Object.entries(stats.fuseUsage).sort((x, y) => y[1] - x[1])
  const [topId, topN] = usageRanked[0]!
  await test(`stats: fuse usage panel ranks ${topId} first at ${topN.toLocaleString('en-US')}`, async () => {
    await page.goto(`${base}/stats`)
    await page.waitForSelector('[data-testid="fuse-usage-bars"]')
    // counts animate up when the panel scrolls into view — jump there, then
    // wait for the count-up to land on the real value
    await page.evaluate(`document.querySelector('[data-testid="fuse-usage-bars"]').scrollIntoView()`)
    await page.waitForFunction(
      `(document.querySelector('[data-testid="fuse-usage-bars"] > div:first-child')?.textContent ?? '').includes('${topN.toLocaleString('en-US')}')`,
      undefined,
      { timeout: 15_000 },
    )
    const firstRow = norm(await page.textContent('[data-testid="fuse-usage-bars"] > div:first-child'))
    expect(firstRow.includes(norm(fuses[topId]!.name)), `first row "${firstRow}"`)
    expect(firstRow.includes(topN.toLocaleString('en-US')), `first row missing count ${topN}`)
    const cards = await page.$$('[data-testid="fuse-era-shift"] > div')
    expect(cards.length === Object.keys(stats.fuseBySeason).length, `${cards.length} era cards`)
    const s1 = stats.fuseBySeason['1']!
    const s1Total = Object.values(s1).reduce((a, b) => a + b, 0)
    const s1Top = Object.entries(s1).sort((x, y) => y[1] - x[1])[0]!
    const s1Share = `${Math.round((s1Top[1] / s1Total) * 100)}%`
    const s1Card = norm(await page.textContent('[data-testid="fuse-era-shift"] > div:nth-child(3)'))
    expect(s1Card.startsWith('s1'), `card 3 is "${s1Card.slice(0, 12)}…", want S1`)
    expect(s1Card.includes(norm(fuses[s1Top[0]]!.name)) && s1Card.includes(s1Share),
      `S1 card missing ${s1Top[0]} @ ${s1Share}`)
  })

  // …and the numbers are prerendered into the HTML (no-JS check on the file)
  await test('stats: fuse numbers are prerendered in /stats/index.html', () => {
    const html = readFileSync(join(OUT, 'stats/index.html'), 'utf8')
    expect(html.includes(topN.toLocaleString('en-US')), `static HTML missing ${topN}`)
    expect(html.includes(fuses[topId]!.name), `static HTML missing ${fuses[topId]!.name}`)
  })

  // (g) synergy-matrix hover tooltip: canonical names + count on a top cell AND
  // its transpose (sorted-key lookup), diagonal shows "same champion", a true
  // zero pair shows "never paired", and click-to-filter still deep-links
  const champs = JSON.parse(readFileSync(join(ROOT, 'data/champions.json'), 'utf8')) as Record<
    string, { name: string }
  >
  const champIds = Object.keys(champs)
  const [topPairKey, topPairN] = Object.entries(stats.pairingUsage).sort((x, y) => y[1] - x[1])[0]!
  const zeroPairKey = (() => {
    for (let i = 0; i < champIds.length; i++)
      for (let j = i + 1; j < champIds.length; j++) {
        const k = [champIds[i]!, champIds[j]!].sort().join('|')
        if (!stats.pairingUsage[k]) return k
      }
    return null
  })()
  await test(`stats: synergy tooltip (${topPairKey} = ${topPairN} on both mirror cells)`, async () => {
    await page.goto(`${base}/stats`)
    await page.waitForSelector('[data-testid="synergy-matrix"]')
    const names = topPairKey.split('|').map((id) => champs[id]!.name)
    const cells = await page.$$(`[data-testid="synergy-matrix"] [data-pair="${topPairKey}"]`)
    expect(cells.length === 2, `expected 2 mirrored cells for ${topPairKey}, got ${cells.length}`)
    // settle scroll first: the tooltip intentionally hides on scroll events,
    // and hover() auto-scrolls the matrix into view
    await cells[0]!.scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    for (const cell of cells) {
      await page.mouse.move(0, 0)
      await cell.hover()
      await page.waitForSelector('[data-testid="synergy-tip"]')
      const txt = norm(await page.textContent('[data-testid="synergy-tip"]'))
      for (const n of names) expect(txt.includes(norm(n)), `tip "${txt}" missing name ${n}`)
      expect(txt.includes(topPairN.toLocaleString('en-US')), `tip "${txt}" missing count ${topPairN}`)
      await page.mouse.move(0, 0)
      await page.waitForFunction(`!document.querySelector('[data-testid="synergy-tip"]')`)
    }
    await page.mouse.move(0, 0)
    await page.hover(`[data-diag="${champIds[0]}"]`)
    const diag = norm(await page.textContent('[data-testid="synergy-tip"]'))
    expect(diag.includes('same champion') && !diag.includes('appearances'), `diagonal tip "${diag}"`)
    if (zeroPairKey) {
      await page.mouse.move(0, 0)
      await page.hover(`[data-testid="synergy-matrix"] [data-pair="${zeroPairKey}"]`)
      const zero = norm(await page.textContent('[data-testid="synergy-tip"]'))
      expect(zero.includes('never paired'), `zero-pair tip "${zero}"`)
    }
    await page.click(`[data-testid="synergy-matrix"] [data-pair="${topPairKey}"]`)
    await page.waitForFunction(`new URL(location.href).searchParams.get('side') === '1'`)
    const c = String(await page.evaluate(`new URL(location.href).searchParams.get('c')`))
    expect(c.split(',').sort().join('|') === topPairKey, `click filter c=${c}`)
  })

  // (e) the coverage-honesty line shows the real detected/total counts
  await test(`coverage line: ${stats.totals.withFuse.toLocaleString('en-US')} of ${stats.totals.videos.toLocaleString('en-US')}`, async () => {
    await page.goto(`${base}/`)
    await page.waitForSelector('[data-testid="fuse-coverage"]')
    const line = await page.textContent('[data-testid="fuse-coverage"]')
    expect(line!.includes(stats.totals.withFuse.toLocaleString('en-US')), `line "${line}"`)
    expect(line!.includes(stats.totals.videos.toLocaleString('en-US')), `line "${line}"`)
  })

  // (h) SEO: canonical/OG on the deployed domain, valid JSON-LD (no
  // VideoObject anywhere), sitemap/robots hygiene, crawlable internal anchors
  const envFile = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : ''
  const site = (
    process.env.NUXT_PUBLIC_SITE_URL ??
    envFile.match(/^NUXT_PUBLIC_SITE_URL=(.+)$/m)?.[1] ??
    'https://2xko-replay-database.vercel.app'
  ).trim().replace(/\/$/, '')
  const html = (p: string) => readFileSync(join(OUT, p), 'utf8')
  const ld = (doc: string): Record<string, unknown>[] =>
    [...doc.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) =>
      JSON.parse(m[1]!),
    )
  const champId = champIds[0]!
  const playerId = Object.keys(stats.playerCharacters ?? {})[0]!
  await test(`SEO: canonicals/OG on ${site}, JSON-LD valid, sitemap/robots, real anchors`, () => {
    const home = html('index.html')
    expect(home.includes(`<link rel="canonical" href="${site}/">`), 'home canonical')
    expect(home.includes(`content="${site}/og-default.png"`), 'home og:image absolute')
    const homeLd = ld(home)
    const websiteNode = homeLd.find((n) => n['@type'] === 'WebSite') as Record<string, any> | undefined
    expect(!!homeLd.find((n) => n['@type'] === 'Organization'), 'Organization node')
    expect(
      websiteNode?.potentialAction?.target?.urlTemplate === `${site}/?q={search_term_string}`,
      'SearchAction target',
    )
    const champ = html(`champions/${champId}/index.html`)
    expect(champ.includes(`<link rel="canonical" href="${site}/champions/${champId}">`), 'champ canonical')
    expect(champ.includes('/img/champions/'), 'champ og:image uses splash art')
    const champLd = ld(champ)
    const crumbs = champLd.find((n) => n['@type'] === 'BreadcrumbList') as Record<string, any> | undefined
    expect(crumbs?.itemListElement?.length === 3, 'champ breadcrumb depth')
    expect(crumbs?.itemListElement?.[2]?.item === `${site}/champions/${champId}`, 'champ breadcrumb leaf')
    expect(!!champLd.find((n) => n['@type'] === 'CollectionPage'), 'champ CollectionPage')
    expect(champ.includes('<a href="/players/'), 'champ → player entity anchors (pilots)')
    expect(/<a[^>]+href="\/\?c=/.test(champ), 'champ pairing deep-links are real anchors')
    const player = html(`players/${playerId}/index.html`)
    const pLd = ld(player)
    const pCrumbs = pLd.find((n) => n['@type'] === 'BreadcrumbList') as Record<string, any> | undefined
    expect(pCrumbs?.itemListElement?.[1]?.item === `${site}/players`, 'player breadcrumbs')
    expect(player.includes('<a href="/champions/'), 'player → champion entity anchor')
    for (const [route, doc] of [['/', home], [`/champions/${champId}`, champ], [`/players/${playerId}`, player], ['/stats', html('stats/index.html')]] as const) {
      expect(!doc.includes('VideoObject'), `unexpected VideoObject on ${route}`)
    }
    const sm = html('sitemap.xml')
    expect(
      sm.includes(`<loc>${site}/</loc>`) &&
        sm.includes(`<loc>${site}/champions/${champId}</loc>`) &&
        sm.includes(`<loc>${site}/players/${playerId}</loc>`) &&
        sm.includes(`<loc>${site}/stats</loc>`),
      'sitemap host + core/entity routes',
    )
    expect(!sm.includes('/health'), 'sitemap excludes /health')
    const robots = html('robots.txt')
    expect(robots.includes('Disallow: /health') && robots.includes(`Sitemap: ${site}/sitemap.xml`), 'robots.txt')
    expect(html('health/index.html').includes('name="robots" content="noindex"'), '/health noindex')
  })

  await ctx.close()
}

// (f) the daily-cron guard: timestamp-only report.md diff must not commit
function testCronGuard(): Promise<void> {
  return test('cron guard: timestamp-only run skips, real change commits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-guard-'))
    const sh = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' }).toString()
    const wf = readFileSync(join(ROOT, '.github/workflows/data-refresh.yml'), 'utf8').split('\n')
    const start = wf.findIndex((l) => l.includes('git config user.name'))
    const guard = wf.slice(start)
      .filter((l) => l.startsWith('          ')).map((l) => l.slice(10))
      .filter((l) => l.trim() !== 'git push') // scratch repo has no remote
      .join('\n') // the literal "Commit if changed" block, minus indentation
    expect(guard.includes('git restore --staged --worktree data/report.md'), 'workflow guard missing')
    try {
      sh('git init -q . && git config user.email t@t && git config user.name t && mkdir data')
      const seed = (n: number, ts: string) => {
        writeFileSync(join(dir, 'data/videos.json'), JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))))
        writeFileSync(join(dir, 'data/stats.json'), '{}')
        writeFileSync(join(dir, 'data/players.json'), '{}')
        writeFileSync(join(dir, 'data/report.md'), `# R\n\n_Generated ${ts}._\n\ntotal: ${n}\n`)
      }
      seed(1, '2026-07-03T01:00:00.000Z')
      sh('git add -A && git commit -qm seed')
      writeFileSync(join(dir, 'guard.sh'), `set -e\n${guard}\n`)
      seed(1, '2026-07-03T02:00:00.000Z') // timestamp-only
      const a = sh('bash guard.sh')
      expect(a.includes('No data changes'), `case A output: ${a.trim()}`)
      expect(sh('git rev-list --count HEAD').trim() === '1', 'case A must not commit')
      seed(2, '2026-07-03T03:00:00.000Z') // real change
      sh('bash guard.sh')
      expect(sh('git rev-list --count HEAD').trim() === '2', 'case B must commit')
      expect(sh('git show --stat --format= HEAD').includes('report.md'), 'case B ships report.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

// ── main ──────────────────────────────────────────────────────────────────────
if (!existsSync(join(OUT, 'index.html'))) {
  console.error('✖ no generated output — run `npm run generate` first')
  process.exit(1)
}
console.log('e2e suite (static output + cron guard):')
const { base, close } = await serve()
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  await run(browser, base)
  await testCronGuard()
} finally {
  await browser.close()
  close()
}
console.log(`\n${passed}/${passed + failures.length} passed${failures.length ? ` — FAILED: ${failures.join(' · ')}` : ' 🎯'}`)
process.exit(failures.length ? 1 : 0)

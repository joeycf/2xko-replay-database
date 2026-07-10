// Phase 7: fuse detection from early video frames (LOCAL ONLY — never in CI).
//
// Reads each team's fuse off the persistent match-HUD pill (top-left/right)
// via fixed-region dHash against committed templates. Orientation: `left`/
// `right` in data/fuses-detected.json mean teams[0]/teams[1] IN TITLE ORDER —
// when the two fuses differ, champion nameplates are matched (row-searched)
// to decide whether the in-game sides are swapped vs the title.
//
//   npm run data:fuses -- [--validate] [--limit N] [--ids a,b] [--force] [--clean]
//                         [--promote-lows]
//
// Statuses: "ok" (confident, ordered) · "ok-unordered" (both fuses confident,
// side attribution ambiguous) · "low" (best guess kept, not merged) · "none".
//
// --promote-lows re-reads every un-overridden "low" record from cached frames
// (no downloads, detection thresholds untouched) and auto-promotes a side into
// data/overrides.json only when the pill is plainly legible: dist ≤ 6, margin
// to the runner-up class ≥ 15, struct within the backlog ceiling. Everything
// else stays null. Writes cache/fuse/review/promotions.md for review.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp, { type OverlayOptions } from 'sharp'
import type { FuseOrientItem, VideoRecord } from '../types/index'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'cache/fuse')
const RAW = join(CACHE, 'raw')
const FRAMES = join(CACHE, 'frames')
const REVIEW = join(CACHE, 'review')
const OUT = join(ROOT, 'data/fuses-detected.json')

// ── decision thresholds (validated against data/fuse-validation.json) ────────
const ACCEPT_DIST = 75 // dist = (1 - winning hue-vote share) × 100; ≤75 → share ≥ 0.25
const ACCEPT_MARGIN = 5 // min structural (wide-dHash) gap to the runner-up candidate
const CAND_SHARE = 0.12 // hue-vote share needed to even be a candidate class
const HBAR_HUE = 172 // health-bar teal — negative class: frames won by it are rejected
const Y_SCAN = [-0.006, 0, 0.008, 0.016] // pill drift tolerance (restreams + theater juggernaut)
const MIN_SAT_FRAC = 0.10 // pill present: saturated fraction floor (dark occlusions sit below)
const MAX_SAT_FRAC = 0.75 // ceiling: full-screen effect flashes saturate nearly everything
const NONE_SAT = 0.05 // no frame reaches this saturation → "none" (no HUD at all)
const STRUCT_MAX = 30 // wide dHash (256-bit → /4 scale) structural sanity ceiling
const ORIENT_MARGIN = 8 // min H1-vs-H2 gap for confident side orientation
// full-crop color-flash backstop: a super/fire wash saturates far more of the
// pill window (0.48–0.58 measured) than any real pill (≤0.23) while voting a
// single class near-unanimously — skip those frames outright
const FLASH_SAT = 0.45
const FLASH_SHARE = 0.85

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(f)
const opt = (f: string): string | undefined => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const VALIDATE = has('--validate')
const FORCE = has('--force')
const LIMIT = Number(opt('--limit') ?? 0)
const ONLY_IDS = opt('--ids')?.split(',').filter(Boolean)
const [SLEEP_MIN, SLEEP_MAX] = (opt('--sleep') ?? '1-3').split('-').map(Number) as [number, number]
// YouTube bot-check bypass (2026-07-10: this host's IP is flagged; every
// player client gets "Sign in to confirm you're not a bot"). Pass a
// Netscape-format export of your youtube.com session:
//   npm run data:fuses -- --cookies ~/yt-cookies.txt
// (--cookies-from-browser <spec> also forwarded, but on WSL2 it can't decrypt
// a Windows browser profile — the cookies.txt export is the reliable path.)
const COOKIES_FILE = opt('--cookies')
const COOKIES_BROWSER = opt('--cookies-from-browser')
const COOKIE_ARGS = COOKIES_FILE
  ? ['--cookies', COOKIES_FILE]
  : COOKIES_BROWSER
    ? ['--cookies-from-browser', COOKIES_BROWSER]
    : []

if (has('--clean')) {
  rmSync(CACHE, { recursive: true, force: true })
  console.log('✓ purged cache/fuse')
  process.exit(0)
}

if (!process.env.SSL_CERT_FILE && existsSync('/etc/ssl/certs/ca-certificates.crt')) {
  process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt' // static ffmpeg TLS
}

// ── data ──────────────────────────────────────────────────────────────────────
// manual (hand-authored) records are excluded: tournament VODs have no fixed
// HUD timing to CV-detect, and their fuses stay null by convention
const videos = (JSON.parse(readFileSync(join(ROOT, 'data/videos.json'), 'utf8')) as VideoRecord[])
  .filter((v) => v.parseConfidence !== 'manual')
const regions = JSON.parse(readFileSync(join(ROOT, 'data/fuse-regions.json'), 'utf8')) as {
  default: { left: number[]; right: number[] }
}
const byId = new Map(videos.map((v) => [v.id, v]))
const eraOf = (v: VideoRecord) => (v.season === null ? 'beta' : `s${v.season}`)

// name rows are searched vertically — base rects, y is the search anchor
const NAME_X = { left: 0.118, right: 0.767 }
const NAME_W = 0.115
const NAME_H = 0.028
const NAME_Y_STEPS = [0.068, 0.073, 0.078, 0.083, 0.088, 0.093, 0.098, 0.103, 0.108, 0.113, 0.118, 0.123]

// ── dHash ─────────────────────────────────────────────────────────────────────
async function dHash(input: Buffer | string): Promise<bigint> {
  const raw = await sharp(input).greyscale().normalise().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
  let bits = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (raw[y * 9 + x + 1]! > raw[y * 9 + x]! ? 1n : 0n)
    }
  }
  return bits
}
function hamming(a: bigint, b: bigint): number {
  let x = a ^ b
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

/** Wide-aspect dHash (33×8 → 256 bits) — keeps banner text structure. */
async function wideHash(input: Buffer | string): Promise<bigint> {
  const raw = await sharp(input).greyscale().normalise().resize(33, 8, { fit: 'fill' }).raw().toBuffer()
  let bits = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 32; x++) {
      bits = (bits << 1n) | (raw[y * 33 + x + 1]! > raw[y * 33 + x]! ? 1n : 0n)
    }
  }
  return bits
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Saturation-weighted mean hue — used only on clean template crops. */
async function templateHue(input: Buffer | string): Promise<number> {
  const { data, info } = await sharp(input).resize(64, 16, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  let vx = 0, vy = 0
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * info.channels]! / 255
    const g = data[i * info.channels + 1]! / 255
    const b = data[i * info.channels + 2]! / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
    const sat = max === 0 ? 0 : d / max
    if (sat < 0.35 || max < 0.30) continue
    let h = 0
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    const rad = (h * Math.PI) / 180
    vx += Math.cos(rad) * sat
    vy += Math.sin(rad) * sat
  }
  return ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360
}

/**
 * Per-pixel hue VOTING against class hue centers (mean-hue averaging breaks on
 * crops that mix the pill with health-bar teal or red-state bleed — votes
 * don't). Returns each class's saturation-weighted vote share.
 */
async function classifyHue(
  input: Buffer | string,
  classes: { id: string; hue: number }[],
): Promise<{ shares: Map<string, number>; satFrac: number }> {
  const { data, info } = await sharp(input).resize(64, 16, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  const votes = new Map<string, number>(classes.map((c) => [c.id, 0]))
  let totalWeight = 0, saturated = 0
  const px = info.width * info.height
  for (let i = 0; i < px; i++) {
    const r = data[i * info.channels]! / 255
    const g = data[i * info.channels + 1]! / 255
    const b = data[i * info.channels + 2]! / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
    const sat = max === 0 ? 0 : d / max
    if (sat < 0.35 || max < 0.30) continue
    saturated++
    let h = 0
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    let bestClass: string | null = null
    let bestD = 22 // vote only within ±22° of a class center
    for (const c of classes) {
      const cd = hueDist(h, c.hue)
      if (cd < bestD) { bestD = cd; bestClass = c.id }
    }
    totalWeight += sat
    if (bestClass) votes.set(bestClass, (votes.get(bestClass) ?? 0) + sat)
  }
  const shares = new Map<string, number>()
  for (const [id, v] of votes) shares.set(id, totalWeight > 0 ? v / totalWeight : 0)
  return { shares, satFrac: saturated / px }
}

// ── templates ─────────────────────────────────────────────────────────────────
interface PillTemplate {
  fuse: string
  hue: number
  wide: bigint
  name: string
}
async function loadPillTemplates(): Promise<PillTemplate[]> {
  const dir = join(ROOT, 'assets/fuse-templates')
  const out: PillTemplate[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const fuse = f.replace('.png', '').replace(/-(restream|broadcast)$/, '')
    const p = join(dir, f)
    out.push({ fuse, hue: await templateHue(p), wide: await wideHash(p), name: f })
  }
  return out
}
async function loadNameTemplates(): Promise<Map<string, bigint>> {
  const dir = join(ROOT, 'assets/name-templates')
  const out = new Map<string, bigint>()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    out.set(f.replace('.png', ''), await dHash(join(dir, f))) // "<champ>-<side>"
  }
  return out
}

// ── fetch + frames ────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function rawPath(id: string): string | null {
  if (!existsSync(RAW)) return null
  const f = readdirSync(RAW).find((f) => f.startsWith(`${id}.`))
  return f ? join(RAW, f) : null
}
async function ensureFrames(id: string): Promise<string[] | null> {
  const dir = join(FRAMES, id)
  if (existsSync(join(dir, '01.png'))) {
    return readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => join(dir, f))
  }
  let raw = rawPath(id)
  if (!raw) {
    mkdirSync(RAW, { recursive: true })
    const r = spawnSync(
      'yt-dlp',
      [...COOKIE_ARGS, '--quiet', '--no-warnings', '--download-sections', '*0-12', '-f', 'bv*[height<=720]/bv*',
        '-o', join(RAW, '%(id)s.%(ext)s'), `https://www.youtube.com/watch?v=${id}`],
      { stdio: ['ignore', 'ignore', 'pipe'], env: process.env, timeout: 180_000 },
    )
    // pace EVERY attempt, failures included — the 07-02 backlog followed each
    // failed download with the next request instantly, feeding the throttle
    // spiral that produced the "unavailable" pile in the first place
    await sleep((SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN)) * 1000)
    if (r.status !== 0) {
      const err = String(r.stderr ?? '').slice(0, 300)
      if (/confirm you.re not a bot|sign in/i.test(err)) {
        console.error(
          COOKIE_ARGS.length
            ? '\n✖ YouTube bot-check hit despite cookies — session expired? Re-export youtube.com cookies and retry.'
            : '\n✖ YouTube bot-check hit — export youtube.com cookies (Netscape format) and retry with:\n  npm run data:fuses -- --cookies <cookies.txt>',
        )
        process.exit(2)
      }
      return null
    }
    raw = rawPath(id)
    if (!raw) return null
  }
  mkdirSync(dir, { recursive: true })
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw, '-vf', 'fps=1', join(dir, '%02d.png')], {
      env: process.env, timeout: 120_000,
    })
  } catch {
    return null
  }
  return readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => join(dir, f))
}

// ── detection ─────────────────────────────────────────────────────────────────
interface SideRead {
  fuse: string | null
  dist: number // hue distance in degrees (999 = no saturated pill in any frame)
  margin: number // hue-degree gap to runner-up fuse
  struct: number // wide-dHash distance to the winning fuse template
  satFrac: number
  frame: string
  crop?: Buffer
}
async function cropRect(frame: string, rect: number[], meta: { width: number; height: number }): Promise<Buffer> {
  return sharp(frame).extract({
    left: Math.round(rect[0]! * meta.width),
    top: Math.round(rect[1]! * meta.height),
    width: Math.round(rect[2]! * meta.width),
    height: Math.round(rect[3]! * meta.height),
  }).png().toBuffer()
}

async function readSide(frames: string[], side: 'left' | 'right', pills: PillTemplate[]): Promise<SideRead> {
  const rect = regions.default[side]
  // EVERY template contributes a hue vote-center (pill hue varies by capture
  // style — broadcast DD is bluer than theater DD); votes merge per fuse id
  const classes: { id: string; hue: number }[] = pills.map((t) => ({ id: t.fuse, hue: t.hue }))
  classes.push({ id: '__hbar', hue: HBAR_HUE })

  let maxSat = 0
  interface Verdict { fuse: string; dist: number; margin: number; struct: number; satFrac: number; frame: string; crop: Buffer }
  const jobs: Promise<Verdict | null>[] = []
  for (const frame of frames) {
    for (const dy of Y_SCAN) {
      jobs.push((async (): Promise<Verdict | null> => {
        const meta = (await sharp(frame).metadata()) as { width: number; height: number }
        const crop = await cropRect(frame, [rect[0]!, rect[1]! + dy, rect[2]!, rect[3]!], meta)
        const { shares, satFrac } = await classifyHue(crop, classes)
        maxSat = Math.max(maxSat, satFrac)
        if (satFrac < MIN_SAT_FRAC || satFrac > MAX_SAT_FRAC) return null
        const ranked = [...shares.entries()].filter(([id]) => id !== '__hbar').sort((a, b) => b[1] - a[1])
        if ((shares.get('__hbar') ?? 0) > (ranked[0]?.[1] ?? 0)) return null // health-bar dominated
        const candidates = ranked.filter(([, share]) => share >= CAND_SHARE)
        if (candidates.length === 0) return null
        if (satFrac > FLASH_SAT && (ranked[0]?.[1] ?? 0) > FLASH_SHARE) return null // color-flash wash
        const wh = await wideHash(crop)
        const structFor = (fuse: string) => {
          let st = 64
          for (const t of pills) if (t.fuse === fuse) st = Math.min(st, hamming(wh, t.wide) / 4)
          return st
        }
        const scored = candidates
          .map(([fuse, share]) => ({ fuse, share, struct: structFor(fuse) }))
          .sort((a, b) => a.struct - b.struct)
        const best = scored[0]!
        return {
          fuse: best.fuse,
          dist: Math.round((1 - best.share) * 100),
          margin: scored[1] ? Math.round(scored[1].struct - best.struct) : 64,
          struct: Math.round(best.struct),
          satFrac, frame, crop,
        }
      })())
    }
  }
  const verdicts = (await Promise.all(jobs)).filter((v): v is Verdict => v !== null)
  if (verdicts.length === 0) return { fuse: null, dist: 999, margin: 0, struct: 64, satFrac: maxSat, frame: '' }
  const sane = verdicts.filter((v) => v.dist <= ACCEPT_DIST && v.struct <= STRUCT_MAX)
  const pool = sane.length ? sane : verdicts
  // composite quality: structure dominates (real pills hash tight against
  // their template), margin capped so vacuous single-candidate 64s can't
  // outrank honest multi-candidate reads from cleaner frames
  const quality = (v: (typeof pool)[number]) => v.struct * 2 + v.dist * 0.5 - Math.min(v.margin, 30)
  // majority vote across FRAMES, not best single crop: a 1–2 frame red
  // super-flash reads as juggernaut with near-perfect confidence, so the
  // best-quality crop must not decide alone — the honest frames outnumber it.
  // vote among STRONG verdicts when ≥2 frames have them: flash frames are
  // strong but few (outvoted by honest strong frames), persistent dim washes
  // (e.g. Blitzcrank lightning tinting the pill cyan for half the clip) are
  // many but weak (excluded from the strong electorate entirely)
  const byFrame = new Map<string, Verdict>()
  for (const v of pool) {
    const cur = byFrame.get(v.frame)
    if (!cur || quality(v) < quality(cur)) byFrame.set(v.frame, v)
  }
  const strong = [...byFrame.values()].filter((v) => v.dist <= 25 && v.struct <= 15)
  const voters = strong.length >= 2 ? strong : [...byFrame.values()]
  const tally = new Map<string, { frames: number; qSum: number; best: Verdict }>()
  for (const v of voters) {
    const t = tally.get(v.fuse)
    if (!t) tally.set(v.fuse, { frames: 1, qSum: quality(v), best: v })
    else {
      t.frames++
      t.qSum += quality(v)
      if (quality(v) < quality(t.best)) t.best = v
    }
  }
  const winner = [...tally.values()].sort(
    (a, b) => b.frames - a.frames || a.qSum / a.frames - b.qSum / b.frames,
  )[0]!
  const w = winner.best
  return { fuse: w.fuse, dist: w.dist, margin: w.margin, struct: w.struct, satFrac: w.satFrac, frame: w.frame, crop: w.crop }
}

/** Row-paired nameplate match: score a champ set against one screen side. */
async function nameScore(
  frames: string[], side: 'left' | 'right', champs: string[], names: Map<string, bigint>,
): Promise<number | null> {
  const hashes = champs.map((c) => names.get(`${c}-${side}`)).filter((h): h is bigint => h !== undefined)
  if (hashes.length !== champs.length || hashes.length === 0) return null // require full template coverage
  const sample = [frames[Math.floor(frames.length / 2)]!, frames[2] ?? frames[0]!, frames[frames.length - 1]!]
  const ROW_GAP = 0.0295
  let best = Infinity
  for (const frame of sample) {
    const meta = (await sharp(frame).metadata()) as { width: number; height: number }
    const scores = await Promise.all(NAME_Y_STEPS.map(async (y) => {
      if (hashes.length === 1) {
        const [a, b] = await Promise.all([
          dHash(await cropRect(frame, [NAME_X[side], y, NAME_W, NAME_H], meta)),
          dHash(await cropRect(frame, [NAME_X[side], y + ROW_GAP, NAME_W, NAME_H], meta)),
        ])
        return Math.min(hamming(a, hashes[0]!), hamming(b, hashes[0]!))
      }
      const [rowA, rowB] = await Promise.all([
        dHash(await cropRect(frame, [NAME_X[side], y, NAME_W, NAME_H], meta)),
        dHash(await cropRect(frame, [NAME_X[side], y + ROW_GAP, NAME_W, NAME_H], meta)),
      ])
      return Math.min(
        (hamming(rowA, hashes[0]!) + hamming(rowB, hashes[1]!)) / 2,
        (hamming(rowA, hashes[1]!) + hamming(rowB, hashes[0]!)) / 2,
      )
    }))
    best = Math.min(best, ...scores)
  }
  return best === Infinity ? null : best
}

/** true → title order matches screen order; false → swapped; null → ambiguous */
async function orient(
  frames: string[], video: VideoRecord, names: Map<string, bigint>,
): Promise<boolean | null> {
  if (video.teams.length !== 2) return null
  const a = video.teams[0]!.characters
  const b = video.teams[1]!.characters
  if (a.length === 0 || b.length === 0) return null
  // only champions unique to one team carry orientation signal (shared champs
  // match both sides and let player-name pixel noise decide — observed flips)
  const discA = a.filter((c) => !b.includes(c))
  const discB = b.filter((c) => !a.includes(c))
  if (discA.length === 0 && discB.length === 0) return null // mirror comp
  const [aL, bR, bL, aR] = await Promise.all([
    discA.length ? nameScore(frames, 'left', discA, names) : Promise.resolve(0),
    discB.length ? nameScore(frames, 'right', discB, names) : Promise.resolve(0),
    discB.length ? nameScore(frames, 'left', discB, names) : Promise.resolve(0),
    discA.length ? nameScore(frames, 'right', discA, names) : Promise.resolve(0),
  ])
  if (aL === null || bR === null || bL === null || aR === null) return null
  const h1 = aL + bR // title order == screen order
  const h2 = bL + aR // swapped
  if (Math.abs(h1 - h2) < ORIENT_MARGIN) return null
  return h1 < h2
}

interface Detection {
  left: string | null
  right: string | null
  score: { left: number; right: number }
  status: 'ok' | 'ok-unordered' | 'low' | 'none'
  era: string
  detectedAt: string
}

async function detect(
  id: string, pills: PillTemplate[], names: Map<string, bigint>,
): Promise<{ det: Detection; reads: { left: SideRead; right: SideRead } } | null> {
  const video = byId.get(id)
  if (!video) return null
  const frames = await ensureFrames(id)
  if (!frames || frames.length === 0) return null
  const [L, R] = await Promise.all([readSide(frames, 'left', pills), readSide(frames, 'right', pills)])
  // rare-class evidence floor: juggernaut is ~1% of real picks but the sole
  // warm hue class, so red-lit stages funnel weak false votes into it — a
  // weak juggernaut read is far more likely wash than pill (audited 2026-07-03)
  const conf = (s: SideRead) =>
    s.fuse !== null && s.dist <= ACCEPT_DIST && s.margin >= ACCEPT_MARGIN && s.struct <= STRUCT_MAX &&
    (s.fuse !== 'juggernaut' || s.dist <= 30)

  let det: Detection = {
    left: L.fuse, right: R.fuse,
    score: { left: L.dist, right: R.dist },
    status: 'low', era: eraOf(video), detectedAt: new Date().toISOString().slice(0, 10),
  }
  if (conf(L) && conf(R)) {
    if (L.fuse === R.fuse) det.status = 'ok'
    else {
      const sameOrder = await orient(frames, video, names)
      if (sameOrder === null) det.status = 'ok-unordered'
      else {
        det.status = 'ok'
        if (!sameOrder) det = { ...det, left: R.fuse, right: L.fuse, score: { left: R.dist, right: L.dist } }
      }
    }
  } else if (L.satFrac < NONE_SAT && R.satFrac < NONE_SAT) {
    det.status = 'none' // no saturated pill anywhere — HUD never on screen
  }
  return { det, reads: { left: L, right: R } }
}

// ── validation mode ───────────────────────────────────────────────────────────
async function runValidation(pills: PillTemplate[], names: Map<string, bigint>): Promise<void> {
  const labels = JSON.parse(readFileSync(join(ROOT, 'data/fuse-validation.json'), 'utf8')) as Record<
    string, { left: string; right: string }
  >
  const ids = Object.keys(labels)
  const fuseIds = [...new Set(Object.values(labels).flatMap((l) => [l.left, l.right]))]
  const confusion: Record<string, Record<string, number>> = {}
  const bump = (want: string, got: string) => {
    ;(confusion[want] ??= {})
    confusion[want]![got] = (confusion[want]![got] ?? 0) + 1
  }
  const distsCorrect: number[] = []
  const margins: number[] = []
  const disagreements: { id: string; side: string; want: string; got: string | null; dist: number; frame: string; crop?: Buffer }[] = []
  let okOrdered = 0, okUnordered = 0, lowN = 0, noneN = 0, orientWrong = 0
  const scoreDump: Record<string, unknown> = {}

  for (const id of ids) {
    const r = await detect(id, pills, names)
    if (!r) { console.log(`  ! ${id}: no frames`); continue }
    const { det, reads } = r
    const want = labels[id]!
    if (det.status === 'ok') okOrdered++
    else if (det.status === 'ok-unordered') okUnordered++
    else if (det.status === 'low') lowN++
    else noneN++

    // side-level scoring for confident statuses; low/none counted separately
    if (det.status === 'ok' || det.status === 'ok-unordered') {
      const pairs: [string, string | null, SideRead][] =
        det.status === 'ok-unordered'
          ? // unordered: compare as multiset
            (() => {
              const wantSet = [want.left, want.right].sort().join('|')
              const gotSet = [det.left, det.right].sort().join('|')
              if (wantSet === gotSet) { bump(want.left, want.left); bump(want.right, want.right); return [] }
              return [['left', det.left, reads.left], ['right', det.right, reads.right]] as [string, string | null, SideRead][]
            })()
          : [['left', det.left, reads.left], ['right', det.right, reads.right]]
      for (const [side, got, read] of pairs) {
        const w = side === 'left' ? want.left : want.right
        if (got === w) {
          bump(w, got!)
          distsCorrect.push(read.dist)
          margins.push(read.margin)
        } else {
          bump(w, got ?? '(null)')
          if (det.status === 'ok' && [want.left, want.right].sort().join() === [det.left, det.right].sort().join()) orientWrong++
          disagreements.push({ id, side, want: w, got, dist: read.dist, frame: read.frame, crop: read.crop })
        }
      }
    } else {
      disagreements.push(
        { id, side: 'left', want: want.left, got: reads.left.fuse, dist: reads.left.dist, frame: reads.left.frame, crop: reads.left.crop },
        { id, side: 'right', want: want.right, got: reads.right.fuse, dist: reads.right.dist, frame: reads.right.frame, crop: reads.right.crop },
      )
    }
    process.stdout.write('.')
    scoreDump[id] = {
      status: det.status,
      left: { fuse: reads.left.fuse, d: reads.left.dist, m: reads.left.margin, st: reads.left.struct, sat: Number(reads.left.satFrac.toFixed(3)) },
      right: { fuse: reads.right.fuse, d: reads.right.dist, m: reads.right.margin, st: reads.right.struct, sat: Number(reads.right.satFrac.toFixed(3)) },
      want: labels[id],
    }
  }
  mkdirSync(REVIEW, { recursive: true })
  writeFileSync(join(REVIEW, 'validation-scores.json'), JSON.stringify(scoreDump, null, 1))
  console.log('\n')

  // report
  console.log(`statuses: ok=${okOrdered}  ok-unordered=${okUnordered}  low=${lowN}  none=${noneN}`)
  console.log(`correct-read dist: min=${Math.min(...distsCorrect)} avg=${(distsCorrect.reduce((a, b) => a + b, 0) / distsCorrect.length).toFixed(1)} max=${Math.max(...distsCorrect)}`)
  console.log(`margins: min=${Math.min(...margins)} avg=${(margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(1)}`)
  const histo = (xs: number[]) => {
    const h: Record<string, number> = {}
    for (const x of xs) { const b = `${Math.floor(x / 4) * 4}-${Math.floor(x / 4) * 4 + 3}`; h[b] = (h[b] ?? 0) + 1 }
    return Object.entries(h).sort((a, b) => Number(a[0].split('-')[0]) - Number(b[0].split('-')[0])).map(([k, v]) => `${k}:${v}`).join('  ')
  }
  console.log(`dist histogram (correct): ${histo(distsCorrect)}`)
  console.log(`margin histogram:         ${histo(margins)}`)
  console.log('\nconfusion matrix (rows = truth, cols = detected):')
  const cols = [...fuseIds, '(null)']
  console.log('  ' + ''.padEnd(13) + cols.map((c) => c.slice(0, 10).padStart(11)).join(''))
  for (const f of fuseIds) {
    const row = confusion[f] ?? {}
    console.log('  ' + f.padEnd(13) + cols.map((c) => String(row[c] ?? 0).padStart(11)).join(''))
  }
  if (orientWrong) console.log(`\n⚠ orientation errors (right fuses, wrong sides): ${orientWrong}`)

  if (disagreements.length) {
    mkdirSync(REVIEW, { recursive: true })
    let y = 0
    const parts: OverlayOptions[] = []
    for (const d of disagreements) {
      if (!d.crop) continue
      const buf = await sharp(d.crop).resize(420).png().toBuffer()
      const m = await sharp(buf).metadata()
      parts.push({ input: buf, left: 0, top: y })
      parts.push({
        input: { text: { text: `<span foreground="#FF2E88" background="#000000"> ${d.id} ${d.side} · want ${d.want} · got ${d.got ?? '∅'} d${d.dist} </span>`, rgba: true, dpi: 110 } },
        left: 430, top: y + 8,
      })
      y += (m.height ?? 40) + 8
    }
    if (y > 0) {
      await sharp({ create: { width: 1100, height: y, channels: 4, background: '#0A0B0F' } })
        .composite(parts).png().toFile(join(REVIEW, 'validation-disagreements.png'))
      console.log(`\n${disagreements.length} disagreement side-reads → cache/fuse/review/validation-disagreements.png (adjudicate before tuning)`)
    }
  } else {
    console.log('\nno disagreements 🎯')
  }
}

// ── backlog mode ──────────────────────────────────────────────────────────────
async function runBacklog(pills: PillTemplate[], names: Map<string, bigint>): Promise<void> {
  const detected: Record<string, Detection> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
  // attempt log (id → ISO dates): a failed download leaves no other trace, so
  // this is what lets fuse-gaps.ts tell "attempted, failed" from "never tried"
  const ATTEMPTS = join(CACHE, 'attempted.json')
  const attempted: Record<string, string[]> = existsSync(ATTEMPTS) ? JSON.parse(readFileSync(ATTEMPTS, 'utf8')) : {}
  const logAttempt = (id: string) => {
    const day = new Date().toISOString().slice(0, 10)
    if (attempted[id]?.at(-1) !== day) (attempted[id] ??= []).push(day)
  }
  let ids = ONLY_IDS ?? videos.map((v) => v.id).filter((id) => FORCE || !detected[id])
  if (LIMIT > 0) ids = ids.slice(0, LIMIT)
  console.log(`processing ${ids.length} video(s) — incremental, resumable`)
  const t0 = Date.now()
  let done = 0
  const unmatched: { id: string; side: string; crop: Buffer; dist: number }[] = []

  for (const id of ids) {
    // a corrupt cached file (e.g. zero-byte PNGs after a hard reboot) must not
    // kill the whole run: purge this id's frames and retry once from raw; if
    // that also throws, purge raw too so the next run re-downloads it fresh
    let r: Awaited<ReturnType<typeof detect>> = null
    try {
      r = await detect(id, pills, names)
    } catch {
      rmSync(join(FRAMES, id), { recursive: true, force: true })
      try {
        r = await detect(id, pills, names)
      } catch (e) {
        const raw = rawPath(id)
        if (raw) rmSync(raw, { force: true })
        rmSync(join(FRAMES, id), { recursive: true, force: true })
        console.error(`\n! ${id}: unreadable even after re-extract (${(e as Error).message.slice(0, 80)}) — cache purged for next run`)
      }
    }
    done++
    logAttempt(id)
    if (r) {
      detected[id] = r.det
      if (r.det.status === 'low' || r.det.status === 'none') {
        for (const side of ['left', 'right'] as const) {
          const read = r.reads[side]
          if (read.crop && !(read.dist <= ACCEPT_DIST && read.margin >= ACCEPT_MARGIN)) unmatched.push({ id, side, crop: read.crop, dist: read.dist })
        }
      }
    }
    if (done % 10 === 0 || done === ids.length) {
      writeFileSync(OUT, JSON.stringify(detected, null, 1) + '\n')
      writeFileSync(ATTEMPTS, JSON.stringify(attempted, null, 1) + '\n')
      const rate = done / ((Date.now() - t0) / 1000)
      const eta = Math.round((ids.length - done) / rate / 60)
      process.stdout.write(`\r${done}/${ids.length}  (${rate.toFixed(2)}/s · eta ${eta}m)   `)
    }
  }
  writeFileSync(OUT, JSON.stringify(detected, null, 1) + '\n')
  writeFileSync(ATTEMPTS, JSON.stringify(attempted, null, 1) + '\n')
  console.log(`\n✓ wrote data/fuses-detected.json (${Object.keys(detected).length} records)`)

  // review sheet for low/none + unmatched-pill montage (Sidekick/Teamfight hunt)
  const lows = Object.entries(detected).filter(([, d]) => d.status === 'low' || d.status === 'none')
  if (lows.length) {
    const lines = lows.map(([id, d]) =>
      `| ${id} | ${d.status} | ${d.left ?? '∅'} (${d.score.left}) | ${d.right ?? '∅'} (${d.score.right}) | ${d.era} | cache/fuse/frames/${id}/ |`)
    mkdirSync(REVIEW, { recursive: true })
    writeFileSync(join(REVIEW, 'low-review.md'),
      `# Fuse review sheet — ${lows.length} low/none\n\n| video | status | left guess (dist) | right guess (dist) | era | frames |\n|---|---|---|---|---|---|\n${lines.join('\n')}\n`)
    console.log(`review sheet: cache/fuse/review/low-review.md (${lows.length} records)`)
  }
  if (unmatched.length) {
    mkdirSync(REVIEW, { recursive: true })
    const cols = 6
    const cell = 300
    const rows = Math.ceil(unmatched.length / cols)
    const parts: OverlayOptions[] = []
    for (const [i, u] of unmatched.entries()) {
      const buf = await sharp(u.crop).resize(cell - 10).png().toBuffer()
      parts.push({ input: buf, left: (i % cols) * cell, top: Math.floor(i / cols) * 60 })
    }
    await sharp({ create: { width: cols * cell, height: rows * 60, channels: 4, background: '#0A0B0F' } })
      .composite(parts).png().toFile(join(REVIEW, 'unmatched-pills.png'))
    console.log(`unmatched-pill montage: cache/fuse/review/unmatched-pills.png (${unmatched.length} crops — scan for Sidekick/Teamfight clusters)`)
  }
}

// ── promote-lows mode ─────────────────────────────────────────────────────────
// Clears the unambiguous slice of the "low" pile. A record is low when at
// least one side missed conf() at backlog time — but the OTHER side is often a
// perfect read, and per-side promotion doesn't need both. The bar here is far
// stricter than conf() (dist ≤ 6 vs ≤ 75, margin ≥ 15 vs ≥ 5) so only
// plainly-legible pills qualify; attribution to title order reuses orient(),
// and a side that can't be confidently read AND attributed stays null.
const PROMOTE_DIST = 6
const PROMOTE_MARGIN = 15

async function runPromoteLows(pills: PillTemplate[], names: Map<string, bigint>): Promise<void> {
  const detected: Record<string, Detection> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
  const ovPath = join(ROOT, 'data/overrides.json')
  const overrides = JSON.parse(readFileSync(ovPath, 'utf8')) as Record<string, Partial<VideoRecord>>

  // montage row numbers from the current gap report, for cross-checking crops
  const gapsPath = join(REVIEW, 'fuse-gaps.json')
  const montageNo = new Map<string, number>()
  if (existsSync(gapsPath)) {
    const gaps = JSON.parse(readFileSync(gapsPath, 'utf8')) as { items: { id: string; bucket: string }[] }
    gaps.items.filter((i) => i.bucket === 'low' || i.bucket === 'none').forEach((i, idx) => montageNo.set(i.id, idx + 1))
  }
  const tag = (id: string) => (montageNo.has(id) ? `#${String(montageNo.get(id)).padStart(3, '0')}` : '—')

  const lows = Object.entries(detected).filter(
    ([id, d]) => d.status === 'low' && !overrides[id] && byId.get(id)?.teams.length === 2,
  )
  console.log(`re-reading ${lows.length} low record(s) from cached frames (bar: dist ≤ ${PROMOTE_DIST} · margin ≥ ${PROMOTE_MARGIN} · struct ≤ ${STRUCT_MAX})`)

  interface Row {
    id: string
    outcome: 'both' | 'single' | 'unordered' | 'blocked-orientation' | 'ambiguous'
    detail: string
  }
  const rows: Row[] = []
  const orientQueue: FuseOrientItem[] = []
  let promotedSides = 0

  for (const [id, d] of lows) {
    const dir = join(FRAMES, id)
    if (!existsSync(join(dir, '01.png'))) {
      rows.push({ id, outcome: 'ambiguous', detail: 'no cached frames — skipped (never re-read)' })
      continue
    }
    const video = byId.get(id)!
    const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => join(dir, f))
    const [L, R] = await Promise.all([readSide(frames, 'left', pills), readSide(frames, 'right', pills)])
    const clear = (s: SideRead) =>
      s.fuse !== null && s.dist <= PROMOTE_DIST && s.margin >= PROMOTE_MARGIN && s.struct <= STRUCT_MAX
    const fmt = (s: SideRead) => `${s.fuse ?? '∅'} d${s.dist} m${s.margin} st${s.struct}`
    const stored = `stored: ${d.left ?? '∅'}(${d.score.left})/${d.right ?? '∅'}(${d.score.right})`
    const okL = clear(L)
    const okR = clear(R)

    if (!okL && !okR) {
      rows.push({ id, outcome: 'ambiguous', detail: `L ${fmt(L)} · R ${fmt(R)} · ${stored}` })
      continue
    }

    // map screen sides onto title-ordered teams: symmetric promotions need no
    // orientation; everything else asks the nameplates
    let sameOrder: boolean | null = okL && okR && L.fuse === R.fuse ? true : await orient(frames, video, names)
    let unordered = false
    if (sameOrder === null) {
      if (okL && okR) {
        unordered = true // pair known, sides not — same contract as ok-unordered
        sameOrder = true
      } else {
        // hand-adjudication queue for /dev/fuse-orient: the fuse identity is
        // settled here, only the owning title-team is not — never guess it
        const s = okL ? L : R
        orientQueue.push({
          id,
          montage: montageNo.get(id) ?? null,
          screenSide: okL ? 'left' : 'right',
          fuse: s.fuse!,
          dist: s.dist,
          margin: s.margin,
          struct: s.struct,
          frames: frames.length,
        })
        rows.push({
          id,
          outcome: 'blocked-orientation',
          detail: `${okL ? 'L' : 'R'} reads ${fmt(okL ? L : R)} but nameplates can't attribute it · ${stored}`,
        })
        continue
      }
    }
    const [team0Read, team1Read] = sameOrder ? [L, R] : [R, L]
    const [team0Ok, team1Ok] = sameOrder ? [okL, okR] : [okR, okL]
    overrides[id] = {
      teams: video.teams.map((t, i) => ({
        ...t,
        fuse: (i === 0 ? team0Ok : team1Ok) ? (i === 0 ? team0Read : team1Read).fuse : null,
      })),
      fusesUnordered: unordered,
    }
    promotedSides += (okL ? 1 : 0) + (okR ? 1 : 0)
    rows.push({
      id,
      outcome: unordered ? 'unordered' : okL && okR ? 'both' : 'single',
      detail:
        `teams[0]=${team0Ok ? fmt(team0Read) : 'null'} · teams[1]=${team1Ok ? fmt(team1Read) : 'null'}` +
        `${unordered ? ' · UNORDERED PAIR' : ''} · ${stored}`,
    })
  }

  writeFileSync(ovPath, JSON.stringify(overrides, null, 2) + '\n')

  const promotedRows = rows.filter((r) => r.outcome === 'both' || r.outcome === 'single' || r.outcome === 'unordered')
  const lines = [
    `# Low-confidence auto-promotions — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Bar: dist ≤ ${PROMOTE_DIST} · margin ≥ ${PROMOTE_MARGIN} · struct ≤ ${STRUCT_MAX}; re-read from cached frames, attribution via nameplates.`,
    `${promotedRows.length} of ${lows.length} videos promoted (${promotedSides} sides); the rest stay unidentified.`,
    '',
    '| montage | video | outcome | reads |',
    '|---|---|---|---|',
    ...rows
      .sort((a, b) => (montageNo.get(a.id) ?? 999) - (montageNo.get(b.id) ?? 999))
      .map((r) => `| ${tag(r.id)} | \`${r.id}\` | ${r.outcome} | ${r.detail} |`),
    '',
  ]
  mkdirSync(REVIEW, { recursive: true })
  writeFileSync(join(REVIEW, 'promotions.md'), lines.join('\n'))
  writeFileSync(
    join(REVIEW, 'orient-queue.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), items: orientQueue }, null, 1) + '\n',
  )

  for (const r of promotedRows) console.log(`  ${tag(r.id)} ${r.id}  ${r.outcome.padEnd(9)} ${r.detail}`)
  const count = (o: Row['outcome']) => rows.filter((r) => r.outcome === o).length
  console.log(
    `\n✓ promoted ${promotedRows.length}/${lows.length} videos (${promotedSides} sides): ` +
      `${count('both')} both-sides · ${count('single')} single-side · ${count('unordered')} unordered pairs; ` +
      `${count('blocked-orientation')} blocked on orientation · ${count('ambiguous')} ambiguous`,
  )
  console.log('✓ wrote data/overrides.json + cache/fuse/review/promotions.md')
  console.log(`✓ orientation queue: cache/fuse/review/orient-queue.json (${orientQueue.length} — adjudicate at /dev/fuse-orient)`)
}

// ── main ──────────────────────────────────────────────────────────────────────
const pills = await loadPillTemplates()
const names = await loadNameTemplates()
console.log(`templates: ${pills.length} pill · ${names.size} nameplate`)
if (VALIDATE) await runValidation(pills, names)
else if (has('--promote-lows')) await runPromoteLows(pills, names)
else await runBacklog(pills, names)

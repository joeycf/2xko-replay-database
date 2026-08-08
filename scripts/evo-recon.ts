// Evo recon — the STOP checkpoint before any corpus-scale download.
//
// Answers four questions that nothing in the repo can answer from cached data,
// because 2XKO has never framed a broadcast VOD: every one of the 5,415 cached
// videos is a direct game feed (fuses.ts excludes manual records at :93, and all
// 30 tournament records are manual).
//
//   a  do FOUR champion identities survive the broadcast overlay as text?
//   b  is the game feed at native framing, or scaled/offset by the overlay?
//   c  how often is the title's player order NOT the screen order?
//   d  how many Evo entrants already have a player page?
//
// Writes only under cache/evo (gitignored). Downloads at most the four picks.
//
// Run: npx tsx scripts/evo-recon.ts            # frame + measure
//      npx tsx scripts/evo-recon.ts --measure  # measure cached frames only
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { CACHE, framesOf, pruneClips, reconPlan } from './hud-frames';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(CACHE, 'recon');

const measureOnly = process.argv.includes('--measure');

// ── the picks ────────────────────────────────────────────────────────────────
// Chosen for overlay spread and for the shapes that break assumptions, not for
// convenience: two events (two overlay skins, one of them Japanese), the longest
// and the shortest set, a duo-vs-solo side, the corpus's only 3-champion union,
// and the one video that has no record yet.
const PICKS = [
  { id: 'zxRvkDeYL8w', why: 'Evo 2026 Grand Final — duo vs solo, the 3-champion union, 2526s' },
  {
    id: 'QWjpY279YCs',
    why: 'Evo Japan 2026 Grand Final — 2nd overlay skin, JP localization, 1020s',
  },
  { id: 'jEWF1k9zyPk', why: 'Evo 2026 Duo Duel — no record yet, longest at 3069s, 2v2 players' },
  { id: 'LeLxCI1Dbmk', why: 'Evo Japan 2026 Losers QF — shortest set, 388s' },
];

// ── native reference, measured off cache/fuse/frames this session ────────────
// The health bar's OUTER edges are the landmark: damage eats a bar from the
// inside, so the outer pair is fixed HUD geometry. Span is not usable (0.2852 to
// 0.3336 across 16 sides — depletion low, teal bleed high), and neither is y
// (0.0722 to 0.0958), which is why dy comes from the pill fit instead.
const NATIVE = { lOuter: 0.118, rOuter: 0.882, hudWidth: 0.7649, tol: 0.0031 };

const HBAR_HUE = 172; // fuses.ts:39
const regions = JSON.parse(readFileSync(join(DATA, 'fuse-regions.json'), 'utf8')) as {
  default: Record<string, number[]>;
};

const hueOf = (r: number, g: number, b: number): number | null => {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return null;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};
const hueDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const median = (xs: number[]): number | null =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null;

/** Longest contiguous teal run in one row of one HALF of the frame.
 *
 *  PER HALF, not whole-width: a whole-width scan bridges the two bars across the
 *  screen centre through the gap tolerance and reports a phantom bar whose span
 *  lands inside the plausible band, so no acceptance test can reject it. */
function longestRun(
  raw: Buffer,
  W: number,
  y: number,
  x0: number,
  x1: number,
): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  let last = -1;
  for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 3;
    const r = raw[i]! / 255;
    const g = raw[i + 1]! / 255;
    const b = raw[i + 2]! / 255;
    const max = Math.max(r, g, b);
    const sat = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
    const h = hueOf(r, g, b);
    const hit = h !== null && hueDist(h, HBAR_HUE) <= 12 && sat >= 0.45 && max >= 0.3;
    if (hit) {
      if (start === -1 || x - last > 6) {
        if (start !== -1 && (!best || last - start > best[1] - best[0])) best = [start, last];
        start = x;
      }
      last = x;
    }
  }
  if (start !== -1 && (!best || last - start > best[1] - best[0])) best = [start, last];
  return best;
}

interface BarRead {
  lOuter: number;
  rOuter: number;
  hudWidth: number;
  y: number;
}

async function readBars(file: string): Promise<BarRead | null> {
  const img = sharp(file);
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return null;
  const raw = await img.removeAlpha().raw().toBuffer();
  const halves: Record<string, { x0: number; x1: number; y: number } | null> = { L: null, R: null };
  for (const [side, from, to] of [
    ['L', 0, Math.floor(W / 2)],
    ['R', Math.floor(W / 2), W],
  ] as const) {
    let bestRow: { x0: number; x1: number; y: number; len: number } | null = null;
    for (let y = Math.round(0.03 * H); y < Math.round(0.2 * H); y++) {
      const run = longestRun(raw, W, y, from, to);
      if (!run) continue;
      const len = run[1] - run[0];
      if (len < 0.2 * W) continue;
      if (!bestRow || len > bestRow.len) bestRow = { x0: run[0], x1: run[1], y, len };
    }
    halves[side] = bestRow;
  }
  if (!halves.L || !halves.R) return null;
  return {
    lOuter: halves.L.x0 / W,
    rOuter: halves.R.x1 / W,
    hudWidth: (halves.R.x1 - halves.L.x0) / W,
    y: (halves.L.y + halves.R.y) / 2 / H,
  };
}

/** A labelled contact sheet: one row per sampled second, the HUD band on the
 *  left and its measurements on the right.
 *
 *  Band height 0.20, not fuse-hud.get.ts's 0.145 — that is enough for the two
 *  nameplate rows at native framing, but this is the file that has to survive an
 *  overlay whose offset is the very thing being measured, and the extra strip
 *  carries the BREAK meters and round score, which are the visible cue that a
 *  frame sits on a game boundary (and so near a VS screen).
 *
 *  Rows with NO teal bar are the VS-screen / replay / crowd candidates — those
 *  are what a human actually scans for question (a), so they are marked. */
async function contactSheet(
  id: string,
  files: string[],
  bars: (BarRead | null)[],
): Promise<string> {
  const WIDTH = 900;
  const rows: OverlayOptions[] = [];
  let y = 0;
  for (const [i, f] of files.entries()) {
    const meta = await sharp(f).metadata();
    const band = await sharp(f)
      .extract({
        left: 0,
        top: 0,
        width: meta.width ?? 1280,
        height: Math.round((meta.height ?? 720) * 0.2),
      })
      .resize({ width: WIDTH })
      .png()
      .toBuffer();
    const bm = await sharp(band).metadata();
    const sec = Number(basename(f, '.png'));
    const b = bars[i];
    const label = b
      ? `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}  ` +
        `hud ${b.hudWidth.toFixed(4)}  L ${b.lOuter.toFixed(4)}  y ${b.y.toFixed(4)}`
      : `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}  ` +
        `NO BAR — vs/replay/crowd candidate`;
    const text = await sharp({
      text: {
        text: `<span foreground="${b ? '#7FF7E0' : '#FF2E88'}" background="#000000">${label}</span>`,
        rgba: true,
        dpi: 110,
      },
    })
      .png()
      .toBuffer();
    rows.push({ input: band, top: y, left: 0 });
    rows.push({ input: text, top: y + 4, left: WIDTH + 8 });
    y += (bm.height ?? 40) + 6;
  }
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${id}-sheet.png`);
  await sharp({
    create: { width: WIDTH + 460, height: Math.max(y, 40), channels: 3, background: '#0A0B0F' },
  })
    .composite(rows)
    .png()
    .toFile(path);
  return path;
}

/** Side-by-side pill crops: 2XKO's shipped fuse-regions.json rect as-is, and the
 *  same rect pushed through this video's measured (scale, dx).
 *
 *  If the pill is legible in either, the existing fuse detector has a chance on
 *  broadcast footage and step 3 is worth building; if neither lands it, the fuse
 *  column on Evo records stays null and the VODs route to /dev/fuse-review. */
async function pillSheet(
  id: string,
  files: string[],
  bars: (BarRead | null)[],
  scale: number,
  dx: number,
): Promise<string> {
  // an IN-MATCH frame — a pill only exists where the HUD does
  const i = bars.findIndex((b) => b !== null);
  const file = files[i === -1 ? Math.floor(files.length / 2) : i]!;
  const meta = await sharp(file).metadata();
  const W = meta.width ?? 1280;
  const H = meta.height ?? 720;
  const parts: OverlayOptions[] = [];
  let y = 0;
  for (const side of ['left', 'right']) {
    const r = regions.default[side]!;
    for (const [tag, rect] of [
      ['native', r],
      ['fitted', [r[0]! * scale + dx, r[1]! * scale, r[2]! * scale, r[3]! * scale]],
    ] as const) {
      const crop = await sharp(file)
        .extract({
          left: Math.max(0, Math.round(rect[0]! * W)),
          top: Math.max(0, Math.round(rect[1]! * H)),
          width: Math.round(rect[2]! * W),
          height: Math.round(rect[3]! * H),
        })
        .resize({ height: 56 })
        .png()
        .toBuffer();
      const cm = await sharp(crop).metadata();
      const lbl = await sharp({
        text: {
          text: `<span foreground="#7FF7E0" background="#000000"> ${side} ${tag} </span>`,
          rgba: true,
          dpi: 96,
        },
      })
        .png()
        .toBuffer();
      parts.push({ input: crop, left: 0, top: y });
      parts.push({ input: lbl, left: (cm.width ?? 200) + 10, top: y + 16 });
      y += 62;
    }
  }
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${id}-pills.png`);
  await sharp({ create: { width: 900, height: y, channels: 3, background: '#0A0B0F' } })
    .composite(parts)
    .png()
    .toFile(path);
  return path;
}

// ── run ──────────────────────────────────────────────────────────────────────
const videos = JSON.parse(readFileSync(join(DATA, 'videos.json'), 'utf8')) as {
  id: string;
  title: string;
  durationSec: number;
}[];
const byId = new Map(videos.map((v) => [v.id, v]));

// jEWF1k9zyPk has no record yet — its duration comes from the enumeration.
const DURATIONS: Record<string, number> = { jEWF1k9zyPk: 3069 };

console.log('── Evo recon ────────────────────────────────────────────────');
for (const p of PICKS) {
  const dur = byId.get(p.id)?.durationSec ?? DURATIONS[p.id] ?? 0;
  console.log(`  ${p.id}  ${String(dur).padStart(5)}s  ${p.why}`);
}
console.log('');

const summary: Record<string, unknown>[] = [];

for (const p of PICKS) {
  const dur = byId.get(p.id)?.durationSec ?? DURATIONS[p.id] ?? 0;
  if (!dur) {
    console.log(`  ! ${p.id}: no duration, skipped`);
    continue;
  }
  if (!measureOnly) {
    console.log(`── framing ${p.id} (${dur}s) ─────────────────────────────`);
    await reconPlan(p.id, dur);
    pruneClips(p.id);
  }
  const files = framesOf(p.id);
  if (!files.length) {
    console.log(`  ! ${p.id}: no frames`);
    continue;
  }
  const bars: (BarRead | null)[] = [];
  for (const f of files) bars.push(await readBars(f));
  const withBar = bars.filter((b): b is BarRead => b !== null);
  const hud = median(withBar.map((b) => b.hudWidth));
  const lo = median(withBar.map((b) => b.lOuter));
  const scale = hud === null ? null : hud / NATIVE.hudWidth;
  const dx = hud === null || lo === null ? null : lo - NATIVE.lOuter * (hud / NATIVE.hudWidth);
  const sheet = await contactSheet(p.id, files, bars);
  // (b), second half: do 2XKO's OWN pill rects still land on the pill once the
  // measured transform is applied? Rendered rather than scored — a detector run
  // is step 3's job, and this is the artifact that decides whether it is worth one.
  const pills =
    scale === null || dx === null ? null : await pillSheet(p.id, files, bars, scale, dx);

  summary.push({
    id: p.id,
    durationSec: dur,
    frames: files.length,
    framesWithBar: withBar.length,
    hudWidth: hud,
    lOuter: lo,
    scale,
    dx,
    sheet,
    pills,
  });
  console.log(
    `  ${p.id}: ${files.length} frames, ${withBar.length} with a HUD bar` +
      (hud === null
        ? ' — NO BAR ANYWHERE'
        : `  hudWidth ${hud.toFixed(4)} (native ${NATIVE.hudWidth})  ` +
          `scale ${scale!.toFixed(4)}  dx ${dx!.toFixed(4)}`),
  );
  console.log(`     sheet → ${sheet}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'recon.json'), JSON.stringify({ native: NATIVE, summary }, null, 2) + '\n');
console.log(`\n✔ recon.json → ${join(OUT, 'recon.json')}`);
console.log('  Next: eyeball the sheets, then answer (a)-(d) at the checkpoint.');

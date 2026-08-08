// The fuse-pill detection core, extracted from scripts/fuses.ts so a second
// caller can use it.
//
// WHY IT HAD TO MOVE. fuses.ts exports nothing, parses process.argv at module
// scope, can process.exit during import, and builds its record index from
// data/videos.json filtered to `parseConfidence !== 'manual'` — so importing it
// runs the whole backlog and, worse, no tournament record is even in its
// universe. Every function here is a VERBATIM move; fuses.ts now imports them,
// so there is exactly one implementation and `--validate` scores the same code
// the new caller runs.
//
// The one signature change is `readSide(..., rect)`. It used to read
// `regions.default[side]` off module scope, which is correct for the direct game
// feed and wrong for broadcast footage: the Evo overlay insets the game feed by a
// per-VIDEO amount (measured scale 0.9632-0.9999, dx -0.0024..+0.0251), so the
// caller has to be able to hand in a transformed rect. Passing the default
// reproduces the old behaviour exactly.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── decision thresholds (validated against data/fuse-validation.json) ────────
export const ACCEPT_DIST = 75; // dist = (1 - winning hue-vote share) × 100; ≤75 → share ≥ 0.25
export const ACCEPT_MARGIN = 5; // min structural (wide-dHash) gap to the runner-up candidate
export const CAND_SHARE = 0.12; // hue-vote share needed to even be a candidate class
export const HBAR_HUE = 172; // health-bar teal — negative class: frames won by it are rejected
export const Y_SCAN = [-0.006, 0, 0.008, 0.016]; // pill drift tolerance (restreams + theater juggernaut)
export const MIN_SAT_FRAC = 0.1; // pill present: saturated fraction floor (dark occlusions sit below)
export const MAX_SAT_FRAC = 0.75; // ceiling: full-screen effect flashes saturate nearly everything
export const NONE_SAT = 0.05; // no frame reaches this saturation → "none" (no HUD at all)
export const STRUCT_MAX = 30; // wide dHash (256-bit → /4 scale) structural sanity ceiling
export const ORIENT_MARGIN = 8; // min H1-vs-H2 gap for confident side orientation
// full-crop color-flash backstop: a super/fire wash saturates far more of the
// pill window (0.48–0.58 measured) than any real pill (≤0.23) while voting a
// single class near-unanimously — skip those frames outright
export const FLASH_SAT = 0.45;
export const FLASH_SHARE = 0.85;

// ── dHash ─────────────────────────────────────────────────────────────────────
export async function dHash(input: Buffer | string): Promise<bigint> {
  const raw = await sharp(input)
    .greyscale()
    .normalise()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (raw[y * 9 + x + 1]! > raw[y * 9 + x]! ? 1n : 0n);
    }
  }
  return bits;
}
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Wide-aspect dHash (33×8 → 256 bits) — keeps banner text structure. */
export async function wideHash(input: Buffer | string): Promise<bigint> {
  const raw = await sharp(input)
    .greyscale()
    .normalise()
    .resize(33, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 32; x++) {
      bits = (bits << 1n) | (raw[y * 33 + x + 1]! > raw[y * 33 + x]! ? 1n : 0n);
    }
  }
  return bits;
}

export const hueDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Saturation-weighted mean hue — used only on clean template crops. */
export async function templateHue(input: Buffer | string): Promise<number> {
  const { data, info } = await sharp(input)
    .resize(64, 16, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let vx = 0,
    vy = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * info.channels]! / 255;
    const g = data[i * info.channels + 1]! / 255;
    const b = data[i * info.channels + 2]! / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    const sat = max === 0 ? 0 : d / max;
    if (sat < 0.35 || max < 0.3) continue;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const rad = (h * Math.PI) / 180;
    vx += Math.cos(rad) * sat;
    vy += Math.sin(rad) * sat;
  }
  return ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
}

/**
 * Per-pixel hue VOTING against class hue centers (mean-hue averaging breaks on
 * crops that mix the pill with health-bar teal or red-state bleed — votes
 * don't). Returns each class's saturation-weighted vote share.
 */
export async function classifyHue(
  input: Buffer | string,
  classes: { id: string; hue: number }[],
): Promise<{ shares: Map<string, number>; satFrac: number }> {
  const { data, info } = await sharp(input)
    .resize(64, 16, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const votes = new Map<string, number>(classes.map((c) => [c.id, 0]));
  let totalWeight = 0,
    saturated = 0;
  const px = info.width * info.height;
  for (let i = 0; i < px; i++) {
    const r = data[i * info.channels]! / 255;
    const g = data[i * info.channels + 1]! / 255;
    const b = data[i * info.channels + 2]! / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    const sat = max === 0 ? 0 : d / max;
    if (sat < 0.35 || max < 0.3) continue;
    saturated++;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    let bestClass: string | null = null;
    let bestD = 22; // vote only within ±22° of a class center
    for (const c of classes) {
      const cd = hueDist(h, c.hue);
      if (cd < bestD) {
        bestD = cd;
        bestClass = c.id;
      }
    }
    totalWeight += sat;
    if (bestClass) votes.set(bestClass, (votes.get(bestClass) ?? 0) + sat);
  }
  const shares = new Map<string, number>();
  for (const [id, v] of votes) shares.set(id, totalWeight > 0 ? v / totalWeight : 0);
  return { shares, satFrac: saturated / px };
}

// ── templates ─────────────────────────────────────────────────────────────────
export interface PillTemplate {
  fuse: string;
  hue: number;
  wide: bigint;
  name: string;
}
/** Load the pill templates.
 *
 *  "-evo" templates are EXCLUDED BY DEFAULT, and that is the whole point of the
 *  flag. The Evo overlay redraws the pill rather than scaling it, so a
 *  direct-feed template hashes against it at struct 26-30 with a ceiling of 30 —
 *  legible to a human, structurally unrecognised. Templating a new capture style
 *  from its own frames is how this detector has always absorbed one (see README).
 *
 *  WHY THEY ARE NOT SIMPLY ADDED TO THE SHARED SET, even though doing so measures
 *  BETTER. With the two Evo templates in, the direct-feed detector scored 11
 *  disagreements against data/fuse-validation.json rather than 14, and promoted
 *  two `low` reads — but it also produced one NEW error, a teamfight side reading
 *  as 2x-assist. Two things make that a bad trade to take here:
 *
 *  1. The detector's published 98.75% is a property of a SPECIFIC TEMPLATE
 *     CONFIGURATION, not of the algorithm. Widening the set does not improve that
 *     number, it INVALIDATES it — whatever the new set scores, the figure in the
 *     README no longer describes what is running.
 *  2. The regression is fabrication-class — a confident wrong id on validated
 *     ground truth — and it would have been bought with promotions. Those are not
 *     commensurable: a promotion recovers a read a human can still fix from the
 *     review queue, while a fabrication ships a false fuse that nothing flags.
 *
 *  So the net win is available, but it is taken DELIBERATELY or not at all: a
 *  re-validation session that runs the widened set over the full corpus,
 *  adjudicates every disagreement, and publishes a new figure. Never as a side
 *  effect of tournament work. Until then the Evo caller opts in and every other
 *  caller sees exactly the template set the published number was measured on. */
export async function loadPillTemplates(includeEvo = false): Promise<PillTemplate[]> {
  const dir = join(ROOT, 'assets/fuse-templates');
  const out: PillTemplate[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .filter((f) => includeEvo || !/-evo\.png$/.test(f));
  for (const f of files) {
    const fuse = f.replace('.png', '').replace(/-(restream|broadcast|evo)$/, '');
    const p = join(dir, f);
    out.push({ fuse, hue: await templateHue(p), wide: await wideHash(p), name: f });
  }
  return out;
}

// ── detection ─────────────────────────────────────────────────────────────────
export interface SideRead {
  fuse: string | null;
  dist: number; // hue distance in degrees (999 = no saturated pill in any frame)
  margin: number; // hue-degree gap to runner-up fuse
  struct: number; // wide-dHash distance to the winning fuse template
  satFrac: number;
  frame: string;
  crop?: Buffer;
}

export async function cropRect(
  frame: string,
  rect: number[],
  meta: { width: number; height: number },
): Promise<Buffer> {
  return sharp(frame)
    .extract({
      left: Math.round(rect[0]! * meta.width),
      top: Math.round(rect[1]! * meta.height),
      width: Math.round(rect[2]! * meta.width),
      height: Math.round(rect[3]! * meta.height),
    })
    .png()
    .toBuffer();
}

export async function readSide(
  frames: string[],
  side: 'left' | 'right',
  pills: PillTemplate[],
  rect: number[],
): Promise<SideRead> {
  // EVERY template contributes a hue vote-center (pill hue varies by capture
  // style — broadcast DD is bluer than theater DD); votes merge per fuse id
  const classes: { id: string; hue: number }[] = pills.map((t) => ({ id: t.fuse, hue: t.hue }));
  classes.push({ id: '__hbar', hue: HBAR_HUE });

  let maxSat = 0;
  interface Verdict {
    fuse: string;
    dist: number;
    margin: number;
    struct: number;
    satFrac: number;
    frame: string;
    crop: Buffer;
  }
  const jobs: Promise<Verdict | null>[] = [];
  for (const frame of frames) {
    for (const dy of Y_SCAN) {
      jobs.push(
        (async (): Promise<Verdict | null> => {
          const meta = (await sharp(frame).metadata()) as { width: number; height: number };
          const crop = await cropRect(frame, [rect[0]!, rect[1]! + dy, rect[2]!, rect[3]!], meta);
          const { shares, satFrac } = await classifyHue(crop, classes);
          maxSat = Math.max(maxSat, satFrac);
          if (satFrac < MIN_SAT_FRAC || satFrac > MAX_SAT_FRAC) return null;
          const ranked = [...shares.entries()]
            .filter(([id]) => id !== '__hbar')
            .sort((a, b) => b[1] - a[1]);
          if ((shares.get('__hbar') ?? 0) > (ranked[0]?.[1] ?? 0)) return null; // health-bar dominated
          const candidates = ranked.filter(([, share]) => share >= CAND_SHARE);
          if (candidates.length === 0) return null;
          if (satFrac > FLASH_SAT && (ranked[0]?.[1] ?? 0) > FLASH_SHARE) return null; // color-flash wash
          const wh = await wideHash(crop);
          const structFor = (fuse: string) => {
            let st = 64;
            for (const t of pills) if (t.fuse === fuse) st = Math.min(st, hamming(wh, t.wide) / 4);
            return st;
          };
          const scored = candidates
            .map(([fuse, share]) => ({ fuse, share, struct: structFor(fuse) }))
            .sort((a, b) => a.struct - b.struct);
          const best = scored[0]!;
          return {
            fuse: best.fuse,
            dist: Math.round((1 - best.share) * 100),
            margin: scored[1] ? Math.round(scored[1].struct - best.struct) : 64,
            struct: Math.round(best.struct),
            satFrac,
            frame,
            crop,
          };
        })(),
      );
    }
  }
  const verdicts = (await Promise.all(jobs)).filter((v): v is Verdict => v !== null);
  if (verdicts.length === 0)
    return { fuse: null, dist: 999, margin: 0, struct: 64, satFrac: maxSat, frame: '' };
  const sane = verdicts.filter((v) => v.dist <= ACCEPT_DIST && v.struct <= STRUCT_MAX);
  const pool = sane.length ? sane : verdicts;
  // composite quality: structure dominates (real pills hash tight against
  // their template), margin capped so vacuous single-candidate 64s can't
  // outrank honest multi-candidate reads from cleaner frames
  const quality = (v: (typeof pool)[number]) =>
    v.struct * 2 + v.dist * 0.5 - Math.min(v.margin, 30);
  // majority vote across FRAMES, not best single crop: a 1–2 frame red
  // super-flash reads as juggernaut with near-perfect confidence, so the
  // best-quality crop must not decide alone — the honest frames outnumber it.
  // vote among STRONG verdicts when ≥2 frames have them: flash frames are
  // strong but few (outvoted by honest strong frames), persistent dim washes
  // (e.g. Blitzcrank lightning tinting the pill cyan for half the clip) are
  // many but weak (excluded from the strong electorate entirely)
  const byFrame = new Map<string, Verdict>();
  for (const v of pool) {
    const cur = byFrame.get(v.frame);
    if (!cur || quality(v) < quality(cur)) byFrame.set(v.frame, v);
  }
  const strong = [...byFrame.values()].filter((v) => v.dist <= 25 && v.struct <= 15);
  const voters = strong.length >= 2 ? strong : [...byFrame.values()];
  const tally = new Map<string, { frames: number; qSum: number; best: Verdict }>();
  for (const v of voters) {
    const t = tally.get(v.fuse);
    if (!t) tally.set(v.fuse, { frames: 1, qSum: quality(v), best: v });
    else {
      t.frames++;
      t.qSum += quality(v);
      if (quality(v) < quality(t.best)) t.best = v;
    }
  }
  const winner = [...tally.values()].sort(
    (a, b) => b.frames - a.frames || a.qSum / a.frames - b.qSum / b.frames,
  )[0]!;
  const w = winner.best;
  return {
    fuse: w.fuse,
    dist: w.dist,
    margin: w.margin,
    struct: w.struct,
    satFrac: w.satFrac,
    frame: w.frame,
    crop: w.crop,
  };
}

/** The acceptance predicate — a read is only a verdict if it clears all four. */
export const confident = (s: SideRead): boolean =>
  s.fuse !== null &&
  s.dist <= ACCEPT_DIST &&
  s.margin >= ACCEPT_MARGIN &&
  s.struct <= STRUCT_MAX &&
  (s.fuse !== 'juggernaut' || s.dist <= 30);

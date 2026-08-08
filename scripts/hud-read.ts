// Read the four champion identities off a 2XKO tournament broadcast frame.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT A PORT OF THE SIBLINGS' hud-read.ts
//
// Tekken and SF6 read ONE character per side and fold a SEQUENTIAL union (a set
// is several games, and a player may counter-pick between them). 2XKO is a TAG
// fighter: a side's baseline read is a PAIR that is on screen simultaneously, in
// two stacked nameplate rows. A union of three or more therefore means THE DUO
// CHANGED between games, not that a single pilot switched. That difference runs
// all the way through the fold, so foldSide here is a re-derivation rather than
// a port. What does port unchanged is the shape of the evidence: blank-neutral
// contiguity, MIN_RUN, the coverage term, min-over-members, first-appearance
// ordering, and the prudence constant AUTO_ACCEPT.
//
// TWO THINGS THE RECON MEASURED THAT NO SIBLING FACED
//
// 1. LOCALIZATION. Evo Japan renders the nameplates in KATAKANA (ヤスオ / エコー
//    versus ケイトリン / ヴァイ) while Evo Las Vegas renders them in Latin caps.
//    That splits the corpus almost exactly in half. This is SF6's VEGA problem —
//    the one Tekken explicitly checked for and did not have — and an A-Z
//    whitelist would have produced a clean-looking zero on half the records with
//    no obvious cause. Both scripts live in data/characters.json's alias table,
//    so the roster is one vocabulary and the radius cap below is computed over
//    both at once.
//
// 2. THE BROADCAST HUD IS A REDRAWN LAYOUT, NOT A SCALED ONE. fuses.ts's
//    nameplate geometry (NAME_X 0.118/0.767, NAME_W 0.115) does not transfer:
//    the broadcast HUD is inset, the boxes are narrower because the player
//    handle moved to the banner, and the champion sits OUTERMOST on both sides.
//    REGIONS below were measured off broadcast frames by ink extent and then
//    grid-swept on read rate. Porting the native rects would have clipped the
//    champion on every frame — the same failure SF6's crop produced on Tekken
//    footage (0/60).
//
// AND THE FRAMING MOVES PER VIDEO. Measured across four recon VODs the game feed
// sits at scale 0.9632-0.9999 with dx -0.0024..+0.0251 — 47px and 35px at 720p,
// against a ~150px nameplate. So a fixed crop is not enough: normalizeFraming
// recovers the transform per video from the health bar, whose OUTER edges are
// fixed HUD geometry (damage eats a bar from the inside).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import { CACHE } from './hud-frames';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

// ── geometry ─────────────────────────────────────────────────────────────────

/** Nameplate boxes as frame fractions, at NATIVE broadcast framing (scale 1).
 *
 *  Measured, not inherited: ink-extent scan over in-match frames from four VODs
 *  across two events, then a read-rate grid sweep. The sweep sat on a plateau
 *  (several neighbours within 4 points) rather than a knife edge, which is what
 *  makes a fixed box viable once framing is normalized.
 *
 *  The champion is OUTERMOST on both sides — "JINX P2" on the left, "P1 AHRI" on
 *  the right — so the boxes run outward from the health bar, and the P-tag rides
 *  along inboard. The tag is short and matches no alias, so it costs nothing. */
/** THE BOX HAS TO COVER BOTH EVENTS, AND THE NAME IS ISOLATED INSIDE IT.
 *
 *  The two events anchor the nameplate differently: Latin names end near 0.885,
 *  katakana names run out to about 0.958 (more glyphs, all full-width). A box cut
 *  to the Latin plate clips every Japanese name; a box cut to the Japanese plate
 *  leaves the champion portrait inside the Latin crop, and portrait art survives
 *  thresholding as speckle that tesseract then reads INSTEAD of the name — with
 *  the right box at 0.925 the AHRI plate returned "F-.- A" and "DAMHERS" in every
 *  page-segmentation mode while the legible glyphs sat untouched beside it.
 *
 *  Narrowing the box cannot satisfy both. So the box is generous enough for
 *  katakana and prep() isolates the name inside it by COLUMN INK PROFILE, which
 *  separates a text line from a detached blob of art regardless of which event
 *  produced the frame. That is SF6's Capcom hexagon and Tekken's portrait lesson
 *  restated — a glyph-shaped blob at a fixed offset lands in every read as noise —
 *  but solved by segmentation rather than by a crop that only fits one skin.
 *
 *  MEASURED SPANS, both events, in BROADCAST frame fractions:
 *    left   latin 0.118-0.233   katakana 0.069-0.155
 *    right  latin 0.815-0.903   katakana 0.780-0.959
 *  so each box is the union of its two, and the ink profile does the rest. */
export const REGIONS = {
  left: { x: 0.064, w: 0.175 },
  right: { xEnd: 0.966, w: 0.192 },
} as const;
export const ROW_Y0 = 0.0725;
export const ROW_GAP = 0.029;
export const ROW_H = 0.032;

/** The broadcast banner, where the player handles live.
 *
 *  Latin on BOTH events — "M8O HIKARI" / "EG SUPERNOON" / "DFM IKOAN" — which is
 *  why side resolution is separable from champion identity and survives the
 *  katakana split untouched. Handles carry org prefixes and a "//" between duo
 *  partners; scoreHandle absorbs both by scoring over the best window. */
export const BANNER = {
  left: [0.16, 0.0, 0.28, 0.045],
  right: [0.56, 0.0, 0.28, 0.045],
} as const;

/** Four luminance thresholds for the character rows.
 *
 *  An ensemble because the glyphs are near-white over animated splash art, so the
 *  separating threshold moves with the background: no single value read every
 *  plate, but every plate was read by at least one. Tesseract's own confidence is
 *  deliberately NOT the signal (SF6 measured it returning 0 on a correct read and
 *  95 on a wrong one) — agreement plus edit distance is.
 *
 *  140 is excluded on measurement, not taste: at that level the plate floods to
 *  one continuous bright run and prep's negate hands tesseract a black rectangle. */
const THRESHOLDS = [170, 195, 215, 235];
/** Fewer passes for the banner: flat broadcast chrome on a solid fill, not glyphs
 *  over splash art. 0 means normalise instead of threshold. */
const HANDLE_THRESHOLDS = [0, 150, 190];
const UPSCALE = 4;
/** Target ink height after trimming, in px. Tesseract's comfort zone is roughly
 *  30-100px of letter; below that it starts reading glyphs as punctuation. */
const GLYPH_H = 72;

/** A member needs a run of at least this many CONSECUTIVE reading frames. */
const MIN_RUN = 2;
/** Sides at or above this auto-resolve; below it a human confirms. Deliberately
 *  the same 0.90 both siblings carry, so the three pipelines stay comparable
 *  rather than each holding a differently-derived number meaning the same thing.
 *  It is a prudence margin for footage nobody has checked, not a filter tuned
 *  against observed mistakes. */
export const AUTO_ACCEPT = 0.9;
/** Below this, re-sample densely and fold again before judging. */
export const RESAMPLE_BELOW = 0.6;

// ── framing normalization ────────────────────────────────────────────────────

const HBAR_HUE = 172; // fuses.ts:39 — the health bar's teal, already a known class
/** Native reference, measured off eight cached direct-feed videos.
 *
 *  hudWidth (the two bars' OUTER edges) is the landmark because damage eats a bar
 *  from the INSIDE, so the outer pair is fixed geometry: measured spread 0.0031
 *  across eight videos, versus 0.0484 for a single bar's span. `y` is deliberately
 *  not used — it ranged 0.0722-0.1208 natively, five times any usable tolerance. */
const NATIVE = { lOuter: 0.118, hudWidth: 0.7649 };

export interface Framing {
  scale: number;
  dx: number;
  /** frames that carried a usable bar — the sample this estimate rests on */
  frames: number;
}

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
 *  PER HALF, never whole-width: a whole-width scan bridges the two bars across
 *  the screen centre through the gap tolerance and reports a phantom bar whose
 *  span lands inside the plausible band, so no acceptance test can reject it. */
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
    if (h !== null && hueDist(h, HBAR_HUE) <= 12 && sat >= 0.45 && max >= 0.3) {
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

/** Both health-bar outer edges on one frame, or null when the HUD is not up.
 *
 *  Doubles as the IN-MATCH TEST, and that is most of its value. A tournament VOD
 *  is mostly not gameplay — walk-ons, crowd cuts, replays, player cams, casters —
 *  and the recon measured only about a quarter of sampled frames carrying a HUD.
 *  Reading nameplates on a frame with no HUD is not a miss, it is a category
 *  error, and scoring it as one hides the reader's real behaviour. */
export async function readBar(file: string): Promise<{ lOuter: number; rOuter: number } | null> {
  const img = sharp(file);
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return null;
  const raw = await img.removeAlpha().raw().toBuffer();
  const edge: Record<string, number | null> = { L: null, R: null };
  for (const [side, from, to] of [
    ['L', 0, Math.floor(W / 2)],
    ['R', Math.floor(W / 2), W],
  ] as const) {
    let bestRow: { x0: number; x1: number; len: number } | null = null;
    for (let y = Math.round(0.03 * H); y < Math.round(0.2 * H); y++) {
      const run = longestRun(raw, W, y, from, to);
      if (!run) continue;
      const len = run[1] - run[0];
      if (len < 0.2 * W) continue;
      if (!bestRow || len > bestRow.len) bestRow = { x0: run[0], x1: run[1], len };
    }
    edge[side] = bestRow ? (side === 'L' ? bestRow.x0 / W : bestRow.x1 / W) : null;
  }
  return edge.L !== null && edge.R !== null ? { lOuter: edge.L, rOuter: edge.R } : null;
}

/** Recover this video's (scale, dx) from the health bars.
 *
 *  Feed it EVERY frame, not a slice: the estimate is a median over the frames
 *  that carry a bar, and on a VOD whose first two minutes are walk-ons a leading
 *  slice can contain none at all. Measured instability on a 3-6 frame sample was
 *  dx +/-0.028 (36px at 720p) — larger than the tolerance it exists to correct. */
export async function normalizeFraming(files: string[]): Promise<Framing> {
  const hud: number[] = [];
  const lo: number[] = [];
  for (const file of files) {
    const b = await readBar(file);
    if (!b) continue;
    hud.push(b.rOuter - b.lOuter);
    lo.push(b.lOuter);
  }
  const h = median(hud);
  const l = median(lo);
  if (h === null || l === null) return { scale: 1, dx: 0, frames: 0 };
  const scale = h / NATIVE.hudWidth;
  return { scale, dx: l - NATIVE.lOuter * scale, frames: hud.length };
}

/** Apply a framing to a nameplate slot. */
/** Place one nameplate slot on a frame.
 *
 *  TRANSLATE, DO NOT SCALE THE POSITION — the nameplates do not follow the health
 *  bar's affine. `scale` is recovered from the bar, which is inset by the overlay;
 *  the name plates sit OUTSIDE that span, further toward the frame edge, so
 *  mapping them through the bar's transform pulls them inward and clips exactly
 *  the outermost glyphs that carry the champion. Measured: with the scale applied,
 *  the right box ended at 0.9479 while the katakana names ran to 0.9586, and a
 *  video that had read 100% of its HUD frames dropped to zero.
 *
 *  So the boxes above are stated in BROADCAST coordinates and only the horizontal
 *  offset is applied. What remains is a ~3.7% scale spread across videos, which on
 *  a box this wide is under 0.007 of a frame — inside what the ink profile absorbs.
 *  The rows keep the scale, since vertical position does track the HUD. */
export function slotRect(side: 'left' | 'right', row: 0 | 1, f: Framing): number[] {
  const y = (ROW_Y0 + row * ROW_GAP) * f.scale;
  const w = REGIONS[side].w;
  const x = side === 'left' ? REGIONS.left.x + f.dx : REGIONS.right.xEnd + f.dx - w;
  return [x, y, w, ROW_H * f.scale];
}

// ── roster + matching ────────────────────────────────────────────────────────

/** Optimal String Alignment — Damerau without unrestricted transposes. The same
 *  measure parse.ts and player-dupes.ts already use. */
export function osa(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}

export interface Alias {
  alias: string;
  id: string;
  /** Largest edit budget at which this alias is still uniquely decodable:
   *  floor((d(alias, nearest OTHER champion's alias) - 1) / 2). */
  radius: number;
}
export interface Roster {
  aliases: Alias[];
  ids: Set<string>;
}

/** Load the roster and compute each alias's decoding radius from the table itself.
 *
 *  ON THIS ROSTER THE RADIUS IS LOAD-BEARING, AND ONLY BECAUSE OF KATAKANA. In
 *  Latin the cap binds below the length scale on exactly one alias (warwick), and
 *  the three exact-only entries (vi, ww, yas) are already exact-only by length —
 *  it would be close to decorative. Adding the katakana forms changes that: アーリ
 *  (Ahri) and アカリ (Akali) sit at distance ONE, so a single OCR slip turns one
 *  into the other, and those two champions appear on the same side in the corpus
 *  (Hikari played both in QWjpY279YCs). The radius drives both to exact-only.
 *  9 of 35 aliases end up exact-match-only. */
export async function loadRoster(): Promise<Roster> {
  const chars = JSON.parse(readFileSync(join(DATA, 'characters.json'), 'utf8')) as {
    id: string;
    name: string;
    extra?: { aliases?: string[] };
  }[];
  const flat = chars.flatMap((c) =>
    (c.extra?.aliases ?? [c.name.toLowerCase()]).map((alias) => ({
      alias: alias.toLowerCase(),
      id: c.id,
    })),
  );
  const aliases: Alias[] = flat.map(({ alias, id }) => {
    let nearest = Infinity;
    for (const o of flat) {
      if (o.id === id) continue; // same champion's own aliases cannot collide
      const d = osa(alias, o.alias);
      if (d < nearest) nearest = d;
    }
    return { alias, id, radius: Math.max(0, Math.floor((nearest - 1) / 2)) };
  });
  // longest first so "blitzcrank" wins over "blitz" on a whole-string containment
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  return { aliases, ids: new Set(chars.map((c) => c.id)) };
}

export interface Match {
  id: string;
  dist: number;
}

/** Resolve one OCR string to a champion, or to nothing.
 *
 *  The budget is the MINIMUM of a length scale and the alias's own roster-derived
 *  radius. Length scaling alone guards the noise-magnet problem short names have;
 *  the radius guards collisions the length cannot see — アーリ/アカリ are three
 *  characters each and one edit apart, so a purely length-scaled budget of 0 would
 *  happen to be right, while ケイトリン at five characters would get 1 and could
 *  still drift. Deriving it from the table is what makes that not a coincidence.
 *
 *  An ambiguous read — two different champions equally close — returns null. An
 *  ambiguous read is worse than no read. */
export function matchRead(raw: string, roster: Roster): Match | null {
  // keep katakana, the prolonged-sound mark, ASCII letters and separators
  const text = raw
    .toLowerCase()
    .replace(/[^a-z0-9.\-ぁ-ゖァ-ヺー ]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (text.length < 2) return null;

  // exact containment first, longest alias wins
  for (const { alias, id } of roster.aliases) {
    if (text.includes(alias.replace(/\s+/g, ''))) return { id, dist: 0 };
  }

  let best: Match | null = null;
  let runnerUp = Infinity;
  for (const { alias, id, radius } of roster.aliases) {
    // SCORED OVER THE BEST WINDOW, not the whole string — the same shape
    // scoreHandle uses on the banner, and for the same reason. The plate carries
    // a "P1"/"P4" slot tag beside the champion and the crop keeps a sliver of the
    // plate edge, so a whole-string distance charges the alias for junk that was
    // never part of the name: AHRI arrives as "AAHR", "MHERI", "DAMHERS", each of
    // which is 2+ edits from `ahri` as a whole and 1 edit as a window.
    //
    // Windowing is only safe BECAUSE of the radius cap. A short alias inside a
    // long noisy string has many windows to get lucky in — `vi` would find a
    // near-match in almost any read. Its radius is 0, so it must appear exactly
    // or not at all, and the promiscuous case is precisely the one the cap kills.
    // The budget is scaled by the ALIAS length now, since the window is sized to
    // the alias rather than to whatever tesseract returned.
    const lengthBudget = alias.length <= 3 ? 0 : alias.length <= 6 ? 1 : alias.length <= 9 ? 2 : 3;
    const budget = Math.min(lengthBudget, radius);
    let d = Infinity;
    for (let i = 0; i <= Math.max(0, text.length - alias.length); i++) {
      for (const w of [alias.length, alias.length + 1, alias.length + 2]) {
        const cand = osa(text.slice(i, i + w), alias);
        if (cand < d) d = cand;
      }
    }
    if (d > budget) continue;
    if (d < (best?.dist ?? Infinity)) {
      if (best && best.id !== id) runnerUp = best.dist;
      best = { id, dist: d };
    } else if (d < runnerUp && best && id !== best.id) {
      runnerUp = d;
    }
  }
  if (!best) return null;
  if (runnerUp === best.dist) return null;
  return best;
}

// ── OCR ──────────────────────────────────────────────────────────────────────

/** Crop, upscale and tone one region for tesseract.
 *
 *  Character rows are threshold + NEGATE (near-white glyphs over animated splash
 *  art become black-on-white); banner plates are normalise + no negate. That
 *  combination is what the read-rate sweep was measured with, so it is a
 *  parameter rather than a cleanup. */
export async function prep(
  file: string,
  region: readonly number[],
  threshold: number,
  plate = false,
): Promise<Buffer> {
  const meta = await sharp(file).metadata();
  const W = meta.width ?? 1280;
  const H = meta.height ?? 720;
  // CLAMP TO THE FRAME. The boxes are wide enough to hold either event's
  // nameplate and then shifted by the video's measured offset, so a large
  // positive dx can push the right box's far edge past 1.0 — sharp answers that
  // with "extract_area: bad extract area" and takes the whole run down. Clamping
  // costs the sliver that fell outside, which was never frame in the first place.
  const left = Math.min(W - 1, Math.max(0, Math.round(region[0]! * W)));
  const top = Math.min(H - 1, Math.max(0, Math.round(region[1]! * H)));
  const width = Math.max(1, Math.min(W - left, Math.round(region[2]! * W)));
  const height = Math.max(1, Math.min(H - top, Math.round(region[3]! * H)));
  const base = sharp(file)
    .extract({ left, top, width, height })
    .resize({ width: width * UPSCALE, kernel: 'lanczos3' })
    .greyscale();
  const toned = threshold > 0 ? base.threshold(threshold) : base.normalise();
  const out = plate ? toned : toned.negate();
  const buf = await out.png().toBuffer();
  if (plate) return buf;
  // INK-TRIM, then pad. After threshold+negate the glyphs are black on white, so
  // trimming the white border reduces the crop to the text itself.
  //
  // It has to be a ROUND TRIP through a buffer: sharp's trim() analyses the image
  // it loaded, not the result of the pipeline chained ahead of it, so
  // `.negate().trim()` silently trims against the pre-negate borders and returns
  // the frame unchanged. That was worth finding — a champion name occupying a
  // quarter of a 7:1 strip reads as nothing at all under pageseg 7, which is
  // exactly how AHRI and VI were failing while rendering perfectly legibly.
  //
  // Then normalise the GLYPH HEIGHT. Trimming alone left AHRI at 195x40 — about
  // 24px of actual letter — and tesseract reads that as punctuation ("-.-").
  // UPSCALE is applied to the raw crop, before we know how much of it is ink, so
  // a short name in a wide box ends up small however generous that factor is.
  // Resizing after the trim is what makes the glyph size independent of the
  // name's length. The 8px white pad is the quiet zone tesseract wants; a glyph
  // flush against the edge reads worse than one with margin.
  const band = await isolateName(buf);
  if (!band) return buf; // no ink — a blank plate; let the matcher reject it
  return await sharp(band)
    .resize({ height: GLYPH_H, fit: 'inside', kernel: 'lanczos3' })
    .extend({ top: 8, bottom: 8, left: 8, right: 8, background: '#ffffff' })
    .png()
    .toBuffer();
}

/** Isolate the champion name inside a thresholded plate crop by COLUMN INK PROFILE.
 *
 *  sharp's trim() is a bounding box, so one speck of portrait art at the far edge
 *  keeps the whole width and the name stays a quarter of a 7:1 strip. A profile
 *  instead finds every contiguous run of inked columns (tolerating inter-letter
 *  gaps) and keeps the WIDEST — a champion name is one long run, detached art is
 *  a shorter one. That is what lets a single generous box serve both the Latin
 *  and katakana skins, whose names end 0.07 of a frame apart.
 *
 *  Rows are trimmed the same way afterwards, so the result is the text and only
 *  the text, at a predictable aspect for the height normalization that follows. */
async function isolateName(png: Buffer): Promise<Buffer | null> {
  const img = sharp(png);
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return null;
  const raw = await img.greyscale().raw().toBuffer();
  // post-negate the glyphs are DARK on white
  const inkCol = new Array<number>(W).fill(0);
  const inkRow = new Array<number>(H).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (raw[y * W + x]! < 128) {
        inkCol[x]!++;
        inkRow[y]!++;
      }
    }
  }
  const GAP = Math.max(6, Math.round(W * 0.02)); // inter-letter spacing at 4x upscale
  const runs: [number, number][] = [];
  let start = -1;
  let last = -1;
  for (let x = 0; x < W; x++) {
    if (inkCol[x]! > 0) {
      if (start === -1 || x - last > GAP) {
        if (start !== -1) runs.push([start, last]);
        start = x;
      }
      last = x;
    }
  }
  if (start !== -1) runs.push([start, last]);
  if (!runs.length) return null;
  const [x0, x1] = runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0]!;
  if (x1 - x0 < 12) return null; // a speck, not a name
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++)
    if (inkRow[y]! > 0) {
      if (y0 === -1) y0 = y;
      y1 = y;
    }
  if (y0 === -1 || y1 - y0 < 4) return null;
  return await sharp(png)
    .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
    .png()
    .toBuffer();
}

export interface Workers {
  eng: Worker;
  jpn: Worker;
  banner: Worker;
}

/** Three workers, and none of them share a configuration.
 *
 *  eng and jpn are separate because a combined "eng+jpn" traineddata load lets
 *  each language's shapes bid on the other's glyphs, and half this corpus is
 *  each. The banner worker carries NO whitelist: handles are "Jake'n'bake",
 *  "M8O HIKARI", "SonicFox // INZEM", and a letters-only whitelist mangles all
 *  three — while side resolution scores against exactly those strings. */
export async function makeWorkers(): Promise<Workers> {
  const mk = async (lang: string, whitelist?: string): Promise<Worker> => {
    const w = await createWorker(lang, undefined, {
      logger: () => {},
      errorHandler: () => {},
      // keeps the ~20MB traineddata out of the process cwd (the repo root)
      cachePath: CACHE,
    });
    await w.setParameters({
      ...(whitelist ? { tessedit_char_whitelist: whitelist } : {}),
      tessedit_pageseg_mode: '7' as never, // single text line
      debug_file: '/dev/null', // silences the per-call stats dump on every blank crop
    });
    return w;
  };
  return {
    // no digits: 0 of 15 champion ids and 0 of 35 aliases contain one
    eng: await mk('eng', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ.- '),
    jpn: await mk('jpn'),
    banner: await mk('eng'),
  };
}

export interface SlotRead {
  side: 'left' | 'right';
  row: 0 | 1;
  id: string | null;
  votes: number;
  of: number;
  dist: number;
  /** every raw OCR string, kept so a wrong read is diagnosable — a missing alias
   *  looks nothing like a bad crop */
  raw: string[];
}

/** Read one nameplate slot: thresholds x scripts, plurality wins.
 *
 *  `langs` exists for cost, and the cost is not marginal. Four thresholds x two
 *  scripts x two rows x two sides is 32 OCR calls per frame, and a first pass over
 *  49 HUD frames took 13 MINUTES for one video — four hours for the corpus. An
 *  event renders its nameplates in ONE script, so once a probe has established
 *  which, half of every subsequent call is known-dead work. */
export async function readSlot(
  w: Workers,
  roster: Roster,
  file: string,
  side: 'left' | 'right',
  row: 0 | 1,
  framing: Framing,
  langs: ('eng' | 'jpn')[] = ['eng', 'jpn'],
): Promise<SlotRead> {
  const rect = slotRect(side, row, framing);
  const raw: string[] = [];
  const tally = new Map<string, { votes: number; dist: number }>();
  for (const th of THRESHOLDS) {
    const png = await prep(file, rect, th);
    for (const lang of langs) {
      const text = (await w[lang].recognize(png)).data.text.replace(/\s+/g, ' ').trim();
      raw.push(text);
      const m = matchRead(text, roster);
      if (!m) continue;
      const cur = tally.get(m.id);
      if (cur) {
        cur.votes++;
        cur.dist = Math.min(cur.dist, m.dist);
      } else tally.set(m.id, { votes: 1, dist: m.dist });
    }
    // A threshold that produced an agreeing majority has settled the slot; the
    // remaining passes exist to rescue a background this one could not separate.
    if (tally.size === 1 && [...tally.values()][0]!.votes >= 2) break;
  }
  let id: string | null = null;
  let votes = 0;
  let dist = 99;
  for (const [k, v] of tally) {
    if (v.votes > votes || (v.votes === votes && v.dist < dist)) {
      id = k;
      votes = v.votes;
      dist = v.dist;
    }
  }
  return { side, row, id, votes, of: THRESHOLDS.length * 2, dist, raw };
}

// ── the fold ─────────────────────────────────────────────────────────────────

export interface Member {
  char: string;
  frames: number;
  run: number;
  firstAt: number;
  dist: number;
  confidence: number;
}
export interface SideResult {
  /** every champion this side fielded, first-appearance order. A pair is the
   *  baseline; three or more means the DUO CHANGED between games of the set. */
  characters: string[];
  confidence: number;
  members: Member[];
  /** reads too thin to be evidence, kept so they stay visible rather than vanish */
  dropped: { char: string; frames: number }[];
  /** per-frame duos that actually co-occurred, in order. This is what makes
   *  segment-aware TRUE pairings derivable later: a union of [a,b,c] does not say
   *  which two were on screen together, and naive C(n,2) over it would fabricate a
   *  pairing that never played. Persisted rather than discarded. */
  segments: [string, string][];
  read: number;
  sampled: number;
  shaky: boolean;
}

/** Fold one side's per-frame slot reads into its champion union.
 *
 *  THE FOLD UNIT IS THE DUO, NOT THE CHARACTER — that is the whole divergence
 *  from the siblings. A frame contributes evidence when BOTH its slots read,
 *  because a 2XKO side is a pair and a half-read frame cannot say whether the
 *  other slot changed or merely failed. Verified support: 0 of 10,868 sides in
 *  the shipped catalogue repeats a champion, so two slots reading the same id is
 *  a read error and the frame is discarded rather than counted twice.
 *
 *  A BLANK FRAME IS NEUTRAL — absence of evidence, not evidence of absence — so
 *  it must not break a run. Tournament VODs cut to crowd shots, replays and
 *  player cams constantly; the recon measured only ~25% of sampled frames
 *  carrying a HUD at all. Counting those as breaks would split one real segment
 *  into two rejected fragments. Runs are therefore measured over the subsequence
 *  of frames that read a full duo.
 *
 *    member_c = min(1, run_c / MIN_RUN) x (1 - meanDist_c / 3)
 *    coverage = min(1, duoLegibleFrames / 4)
 *    side     = min over members x coverage
 *
 *  min over members, not mean: a union is only as trustworthy as its weakest
 *  champion. */
export function foldSide(
  reads: { row0: string | null; row1: string | null; d0: number; d1: number }[],
): SideResult {
  const tally = new Map<string, { frames: number; dist: number[]; firstAt: number; run: number }>();
  const segments: [string, string][] = [];
  let prev: string | null = null;
  let runLen = 0;
  let legible = 0;

  for (const [i, r] of reads.entries()) {
    if (!r.row0 || !r.row1) continue; // need the whole duo
    if (r.row0 === r.row1) continue; // a side never repeats a champion — read error
    legible++;
    const duo: [string, string] = [r.row0, r.row1];
    segments.push(duo);
    const key = [...duo].sort().join('|');
    runLen = key === prev ? runLen + 1 : 1;
    prev = key;
    for (const [j, c] of duo.entries()) {
      const t = tally.get(c) ?? { frames: 0, dist: [], firstAt: i, run: 0 };
      t.frames++;
      t.dist.push(j === 0 ? r.d0 : r.d1);
      t.run = Math.max(t.run, runLen);
      tally.set(c, t);
    }
  }

  const coverage = Math.min(1, legible / 4);
  const all = [...tally.entries()]
    .map(([char, t]) => {
      const dist = t.dist.reduce((a, b) => a + b, 0) / t.dist.length;
      return {
        char,
        frames: t.frames,
        run: t.run,
        firstAt: t.firstAt,
        dist: Number(dist.toFixed(2)),
        confidence: Number((Math.min(1, t.run / MIN_RUN) * Math.max(0, 1 - dist / 3)).toFixed(3)),
      };
    })
    .sort((a, b) => a.firstAt - b.firstAt);

  const members = all.filter((m) => m.run >= MIN_RUN);
  const dropped = all
    .filter((m) => m.run < MIN_RUN)
    .map((m) => ({ char: m.char, frames: m.frames }));
  const base = members.length
    ? Number((Math.min(...members.map((m) => m.confidence)) * coverage).toFixed(3))
    : 0;

  return {
    characters: members.map((m) => m.char),
    confidence: dropped.length ? Number((base / 2).toFixed(3)) : base,
    members,
    dropped,
    segments,
    read: legible,
    sampled: reads.length,
    shaky: dropped.length > 0,
  };
}

// ── side resolution ──────────────────────────────────────────────────────────

/** Score how well `text` contains `handle`; 0 is a clean hit, 99 is nothing.
 *
 *  Scored over the best WINDOW rather than the whole string, because the banner
 *  carries an org tag, a country code and a score around the handle and a
 *  whole-string distance would drown the signal in them. */
export function scoreHandle(text: string, handle: string): number {
  const t = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const h = handle.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!t || !h) return 99;
  if (t.includes(h)) return 0;
  let best = 99;
  for (let i = 0; i <= Math.max(0, t.length - h.length); i++) {
    for (const w of [h.length, h.length + 1, h.length + 2]) {
      const d = osa(t.slice(i, i + w), h);
      if (d < best) best = d;
    }
  }
  return best;
}

export interface SideResolution {
  /** true when candidates[0] is the side on the LEFT of the screen */
  leftIsFirst: boolean;
  /** signed vote margin across frames; 0 means the footage could not say */
  votes: number;
  decided: boolean;
}

/** Decide which titled side occupies the LEFT of the screen.
 *
 *  WHY THIS EXISTS. foldSide reads champions by SCREEN position and the title
 *  supplies players in TITLE order. Pairing them assumes the title names the left
 *  side first — and it does not always: of the four recon VODs, jEWF1k9zyPk is
 *  reversed ("Myth and Apologyman vs Jake'n'bake and Yohosie" has Jake'n'bake on
 *  the left). The siblings measured this at 37.7% (Tekken) and 12.8% (SF6); n=4
 *  is far too small to call a rate here, which is exactly why it must be read
 *  rather than assumed. Pairing positionally produces records where every
 *  champion is right and every player is wrong, and no confidence signal catches
 *  it because the champion reads are perfect.
 *
 *  A SIDE MAY CARRY TWO HANDLES. 2XKO has duo queue — "SonicFox // INZEM" — so a
 *  candidate is a LIST, not a string, and the score is the min over its members.
 *  The siblings' [string, string] signature cannot express that.
 *
 *  Returns decided=false rather than guessing. The caller must treat that as "not
 *  resolvable", never as a default. */
export async function resolveSide(
  w: Workers,
  frames: string[],
  candidates: [string[], string[]],
  framing: Framing,
): Promise<SideResolution> {
  const shift = (r: readonly number[]): number[] => [
    r[0]! * framing.scale + framing.dx,
    r[1]!,
    r[2]! * framing.scale,
    r[3]!,
  ];
  let votes = 0;
  for (const f of frames) {
    let first = 0; // total distance if candidates[0] is on the LEFT
    let second = 0;
    let read = false;
    for (const th of HANDLE_THRESHOLDS) {
      for (const side of ['left', 'right'] as const) {
        const png = await prep(f, shift(BANNER[side]), th, true);
        const text = (await w.banner.recognize(png)).data.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const self = side === 'left' ? 0 : 1;
        const other = side === 'left' ? 1 : 0;
        // a side is a LIST of handles; the best-matching member speaks for it
        const dSelf = Math.min(...candidates[self]!.map((h) => scoreHandle(text, h)));
        const dOther = Math.min(...candidates[other]!.map((h) => scoreHandle(text, h)));
        // a plate matching neither candidate is chrome, not evidence
        if (Math.min(dSelf, dOther) > 3) continue;
        read = true;
        first += dSelf;
        second += dOther;
      }
    }
    if (!read || first === second) continue;
    votes += first < second ? 1 : -1;
  }
  return { leftIsFirst: votes > 0, votes, decided: votes !== 0 };
}

/** Every cached frame for an id, timestamp order. */
export function framesOf(id: string): string[] {
  const dir = join(CACHE, 'frames', id);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// Read champions off tournament footage for the Evo corpus.
//
// LOCAL ONLY, NEVER IN CI. It downloads one-second video windows, and datacenter
// IPs are routinely blocked — 2XKO learned that the hard way and its daily Action
// never runs yt-dlp either. The cron queues; this resolves; a human arbitrates.
//
// THE CORPUS SPLITS BY SCRIPT, AND THE TWO HALVES DO NOT PERFORM THE SAME.
// Evo Japan renders the nameplates in katakana and tesseract's jpn model reads
// them at 75-100% of HUD-bearing frames. Evo Las Vegas renders them in 2XKO's
// Latin display face, and that face defeats OCR: a perfectly clean, 195x40,
// human-legible AHRI returns "V-V.JI". Measured against four thresholds, four
// page-segmentation modes, whitelist on and off, ink-trim, glyph-height
// normalization, six shear angles and the VS screen at three times the size.
// TEEMO reads; AHRI never does. It is specific letterforms, not preprocessing.
//
// So this deliberately does NOT try to auto-resolve everything. A side that
// clears the gate is recorded; a side that does not is left for the review
// surface with its partial reads attached, which is more useful than a blank
// form and much more useful than a confident guess. Reporting counts the two
// populations separately, because one number over both would hide the split.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE, grabWindow, pruneClips, samplePlan } from './hud-frames';
import {
  AUTO_ACCEPT,
  RESAMPLE_BELOW,
  foldSide,
  framesOf,
  loadRoster,
  makeWorkers,
  normalizeFraming,
  readBar,
  readSlot,
  resolveSide,
  type Framing,
  type SideResult,
  type Workers,
} from './hud-read';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(CACHE, 'extracted.json');

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const onlyIds = flag('--ids')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const limit = Number(flag('--limit') ?? 0);
const nFrames = Number(flag('--frames') ?? 30);
const dry = argv.includes('--dry');
/** Print each video's champions as it resolves. OFF by default: while the hand
 *  labels are still the holdout, a progress line that names the answer is how a
 *  blind measurement stops being blind. Tekken leaked 19 of 63 predictions into
 *  its build log exactly this way and had to report two populations forever. */
const reveal = argv.includes('--reveal');

/** Cap on frames actually OCR'd. The fold needs a run of 2 and saturates its
 *  coverage term at 4 legible frames, so beyond ~16 every extra frame is cost
 *  without evidence. */
const READ_CAP = 16;

export interface Extraction {
  id: string;
  title: string;
  /** the two sides, SCREEN order (left first) */
  left: SideResult;
  right: SideResult;
  framing: Framing;
  /** HUD-bearing frames / frames sampled */
  hudFrames: number;
  sampled: number;
  side: { leftIsFirst: boolean; votes: number; decided: boolean };
  confidence: number;
  resolved: boolean;
  resampled: boolean;
  extractedAt: string;
}

// ── work list ────────────────────────────────────────────────────────────────
// The corpus is every Evo entry in manual-videos.json — including the ones whose
// `characters` are still [] behind a todo marker, which is the documented state
// for "authored but unread" and exactly what this script exists to fill in.
const manual = JSON.parse(readFileSync(join(DATA, 'manual-videos.json'), 'utf8')) as {
  videos: {
    id: string;
    title: string;
    tournament?: string;
    durationSec?: number;
    teams: { players: string[] }[];
  }[];
};

let work = manual.videos
  .filter((v) => /Evo/i.test(v.tournament ?? ''))
  .map((v) => ({
    id: v.id,
    title: v.title,
    durationSec: v.durationSec ?? 0,
    handles: [v.teams[0]!.players, v.teams[1]!.players] as [string[], string[]],
  }));
if (onlyIds) work = work.filter((w) => onlyIds.includes(w.id));
if (limit > 0) work = work.slice(0, limit);

if (!work.length) {
  console.log('nothing to do');
  process.exit(0);
}

// resumable: always load, --ids included. `--ids a,b` must never mean "forget the
// rest" — the file is rewritten whole from this map after every video.
const done = new Map<string, Extraction>();
if (existsSync(OUT)) {
  for (const e of JSON.parse(readFileSync(OUT, 'utf8')) as Extraction[]) done.set(e.id, e);
}

console.log(`── extract: ${work.length} video(s), ${nFrames} frames each ───────────────`);
if (!reveal) console.log('   (champion reads suppressed — pass --reveal after labelling)');

const roster = await loadRoster();
const w: Workers = await makeWorkers();

let resolved = 0;
let deferred = 0;

for (const [i, item] of work.entries()) {
  const t0 = Date.now();
  // Resumable in the useful sense: an id already extracted is SKIPPED, not
  // redone. Loading the file without this preserved old results while paying for
  // them again on every re-run — which on a corpus this slow is most of the run.
  if (done.has(item.id) && !argv.includes('--force')) {
    const prev = done.get(item.id)!;
    console.log(
      `  [${i + 1}/${work.length}] ${item.id}  cached → ${prev.resolved ? 'RESOLVE' : 'review'}`,
    );
    if (prev.resolved) resolved++;
    else deferred++;
    continue;
  }
  await grabWindows(item.id, item.durationSec, nFrames);

  let frames = framesOf(item.id);
  let framing = await normalizeFraming(frames);
  let hud = await hudFrames(frames);
  const langs = await detectScript(hud, framing);
  let { left, right } = await readBoth(hud, framing, langs);
  let resampled = false;

  // A THIN read is not a verdict — pull more frames before judging it. But a
  // BLOCKED read is not a thin one, and telling them apart is worth ~17 minutes a
  // video: on the Latin half every set scores 0.00 because the display face
  // defeats OCR, and re-sampling doubled the frames and re-read all of them to
  // arrive at 0.00 again. Coverage is the signal that separates the two cases —
  // few duo-legible frames means look harder, while plenty of legible frames and
  // still no read means the reader is beaten and more of the same will not help.
  // `read` counts DUO-LEGIBLE frames, which is 0 exactly when the reader failed —
  // so it cannot tell "too few frames" from "plenty of frames, beaten reader".
  // The honest measure of evidence available is how many frames had a HUD up at
  // all: with a dozen of those and still nothing, more of the same will not help.
  const thin = hud.length < 12;
  if (Math.min(left.confidence, right.confidence) < RESAMPLE_BELOW && thin) {
    await grabWindows(item.id, item.durationSec, Math.round(nFrames * 2));
    frames = framesOf(item.id);
    framing = await normalizeFraming(frames);
    hud = await hudFrames(frames);
    ({ left, right } = await readBoth(hud, framing, langs));
    resampled = true;
  }

  const side = await resolveSide(w, hud.slice(0, 12), item.handles, framing);
  pruneClips(item.id);

  const confidence = Math.min(left.confidence, right.confidence);
  const ok =
    left.characters.length > 0 &&
    right.characters.length > 0 &&
    confidence >= AUTO_ACCEPT &&
    side.decided;
  if (ok) resolved++;
  else deferred++;

  done.set(item.id, {
    id: item.id,
    title: item.title,
    left,
    right,
    framing,
    hudFrames: hud.length,
    sampled: frames.length,
    side,
    confidence,
    resolved: ok,
    resampled,
    extractedAt: new Date().toISOString().slice(0, 10),
  });
  // flushed after EVERY video so the run is resumable
  mkdirSync(CACHE, { recursive: true });
  if (!dry) writeFileSync(OUT, JSON.stringify([...done.values()], null, 1) + '\n');

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const show = reveal
    ? `  ${left.characters.join('+') || '—'} vs ${right.characters.join('+') || '—'}`
    : '';
  console.log(
    `  [${i + 1}/${work.length}] ${item.id}  hud ${hud.length}/${frames.length}  conf ${confidence.toFixed(2)}  ` +
      `${langs.join('+')}  side ${side.decided ? (side.leftIsFirst ? 'title-order' : 'REVERSED') : 'UNDECIDED'}` +
      `${resampled ? ' (re-sampled)' : ''} → ${ok ? 'RESOLVE' : 'review'}  ${secs}s${show}`,
  );
}

await w.eng.terminate();
await w.jpn.terminate();
await w.banner.terminate();

console.log(`\n✔ ${resolved} resolved · ${deferred} for review → ${OUT}`);
console.log('  Next: npx tsx scripts/extract-score.ts');

// ── helpers ──────────────────────────────────────────────────────────────────

/** One 1-second window per sampled second. Cheap and additive: grabWindow is
 *  cache-hit idempotent, so a denser second pass only fetches what is new. */
async function grabWindows(id: string, durationSec: number, n: number): Promise<void> {
  for (const s of samplePlan(durationSec, n)) await grabWindow(id, s, 1, 1);
}

/** Frames whose HUD is actually up. This is the in-match test, and skipping it is
 *  what made the first measurements look like reader failures: a tournament VOD is
 *  mostly walk-ons, crowd, replays and caster desk, and only 10-32% of uniformly
 *  sampled frames carry a HUD at all. */
async function hudFrames(files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) if (await readBar(f)) out.push(f);
  return out;
}

/** Which script does this event render its nameplates in?
 *
 *  Probed from the footage rather than inferred from the title. "Evo Japan" in a
 *  title is a strong hint and would probably work, but the broadcast is the thing
 *  that decides, and a hint that is right today is a silent zero the first time an
 *  event localizes differently. Two frames settle it. */
async function detectScript(hud: string[], framing: Framing): Promise<('eng' | 'jpn')[]> {
  const score = { eng: 0, jpn: 0 };
  for (const f of hud.slice(0, 3)) {
    for (const s of ['left', 'right'] as const) {
      for (const row of [0, 1] as const) {
        for (const lang of ['eng', 'jpn'] as const) {
          const r = await readSlot(w, roster, f, s, row, framing, [lang]);
          if (r.id) score[lang]++;
        }
      }
    }
  }
  if (score.eng === 0 && score.jpn === 0) return ['eng', 'jpn']; // undecided — pay for both
  return score.jpn > score.eng ? ['jpn'] : ['eng'];
}

async function readBoth(
  hud: string[],
  framing: Framing,
  langs: ('eng' | 'jpn')[],
): Promise<{ left: SideResult; right: SideResult }> {
  const per: Record<
    string,
    { row0: string | null; row1: string | null; d0: number; d1: number }[]
  > = {
    left: [],
    right: [],
  };
  const step = Math.max(1, Math.ceil(hud.length / READ_CAP));
  for (const f of hud.filter((_, i) => i % step === 0).slice(0, READ_CAP)) {
    for (const s of ['left', 'right'] as const) {
      const a = await readSlot(w, roster, f, s, 0, framing, langs);
      const b = await readSlot(w, roster, f, s, 1, framing, langs);
      per[s]!.push({
        row0: a.id,
        row1: b.id,
        d0: a.dist === 99 ? 3 : a.dist,
        d1: b.dist === 99 ? 3 : b.dist,
      });
    }
  }
  return { left: foldSide(per.left!), right: foldSide(per.right!) };
}

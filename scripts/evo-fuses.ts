// Detect fuses on tournament broadcast footage.
//
// 2XKO records carry fuse data and `?fuse=` is the game's public contract, so an
// Evo record with a null fuse column is a second-class record. This closes that
// gap where the footage supports it.
//
// WHY IT IS NOT `npm run data:fuses`. That backlog is unusable here twice over:
// it filters manual records out of its universe entirely (fuses.ts), and it
// fetches ONLY the first 12 seconds of a video, which on a tournament VOD is a
// walk-on or a caster desk. The frame windows are disjoint by construction — the
// shortest Evo set is 361 s and its first sampled second is 29 — so "share the
// frame cache" was never satisfiable. What IS shared is the DETECTOR:
// scripts/fuse-detect.ts holds the one implementation, and `data:fuses --validate`
// scores exactly the code this runs.
//
// THE PILL RECTS ARE TRANSFORMED PER VIDEO. data/fuse-regions.json is normalized
// against the direct game feed; the Evo overlay insets the feed by a per-VIDEO
// amount (measured scale 0.9632-0.9999, dx -0.0024..+0.0251 — 47px and 35px at
// 720p). normalizeFraming recovers that from the health bar, whose OUTER edges
// are fixed HUD geometry, and the rect is pushed through it. Rendered crops
// confirmed the pill lands legibly under this transform on both event skins.
//
// A read that does not clear `confident` stays NULL. Forty invented fuse values
// are a worse product than forty honest nulls, and the review surface exists.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confident, loadPillTemplates, readSide } from './fuse-detect';
import { framesOf, normalizeFraming, readBar, type Framing } from './hud-read';
import type { FuseDetection, ManualVideosFile } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(DATA, 'fuses-detected.json');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const onlyIds = flag('--ids')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const regions = JSON.parse(readFileSync(join(DATA, 'fuse-regions.json'), 'utf8')) as {
  default: Record<string, number[]>;
};

/** Push a normalized rect through this video's measured framing. */
const shift = (rect: number[], f: Framing): number[] => [
  rect[0]! * f.scale + f.dx,
  rect[1]! * f.scale,
  rect[2]! * f.scale,
  rect[3]! * f.scale,
];

const manual = JSON.parse(
  readFileSync(join(DATA, 'manual-videos.json'), 'utf8'),
) as ManualVideosFile;
let work = (manual.videos ?? [])
  .filter((v) => /Evo/i.test(v.tournament ?? ''))
  .map((v) => v.id)
  .filter((id) => framesOf(id).length > 0);
if (onlyIds) work = work.filter((id) => onlyIds.includes(id));

if (!work.length) {
  console.log('no Evo videos with cached frames — run `npm run data:extract` first');
  process.exit(0);
}

const detected: Record<string, FuseDetection> = existsSync(OUT)
  ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, FuseDetection>)
  : {};

const pills = await loadPillTemplates(true);

// COVERAGE GATE. A template set that is missing a fuse cannot decline to guess
// it — every class competes, so a pill whose own template is absent is forced
// into the nearest one that is present. Measured: with only direct-feed
// templates the Evo pills read freestyle/freestyle as double-down and
// 2x-assist/2x-assist as double-down, one of them CONFIDENTLY. Detecting into an
// incomplete set is not partial coverage, it is fabrication, so this refuses.
const activeFuses = Object.entries(
  JSON.parse(readFileSync(join(DATA, 'fuses.json'), 'utf8')) as Record<
    string,
    { active?: boolean }
  >,
)
  .filter(([, f]) => f.active)
  .map(([id]) => id);
const evoCovered = new Set(
  pills.filter((p) => /-evo$/.test(p.name.replace('.png', ''))).map((p) => p.fuse),
);
const missing = activeFuses.filter((f) => !evoCovered.has(f));

console.log(`── evo fuses: ${work.length} video(s), ${pills.length} pill templates ──`);
console.log(`   evo-style templates: ${[...evoCovered].sort().join(', ') || 'none'}`);
if (missing.length) {
  console.log(`   ✖ missing evo templates for: ${missing.join(', ')}`);
  console.log('     Detection is DISABLED until the set is complete — an absent class');
  console.log('     cannot abstain, it gets absorbed by its nearest neighbour. Cut the');
  console.log('     missing ones from frames where that pill is confirmed by eye and');
  console.log('     save as assets/fuse-templates/<fuse>-evo.png, then re-run.');
}

const today = new Date().toISOString().slice(0, 10);
let ok = 0;
let low = 0;
let none = 0;

for (const [i, id] of work.entries()) {
  const all = framesOf(id);
  // Only frames whose HUD is up can carry a pill. On this corpus that is
  // 10-32% of sampled frames — the rest are walk-ons, crowd and replays, and
  // scoring a pill against them manufactures noise rather than misses.
  const hud: string[] = [];
  for (const f of all) if (await readBar(f)) hud.push(f);
  if (!hud.length) {
    none++;
    console.log(`  [${i + 1}/${work.length}] ${id}  no HUD frames → skipped`);
    continue;
  }
  const framing = await normalizeFraming(all);
  // cap the frame set: readSide fans out frames x Y_SCAN crops, and past ~12
  // frames the vote has long since settled
  const sample = hud
    .filter((_, n) => n % Math.max(1, Math.ceil(hud.length / 12)) === 0)
    .slice(0, 12);

  const left = await readSide(sample, 'left', pills, shift(regions.default.left!, framing));
  const right = await readSide(sample, 'right', pills, shift(regions.default.right!, framing));

  const bothConfident = confident(left) && confident(right);
  const status: FuseDetection['status'] = bothConfident ? 'ok' : 'low';
  if (bothConfident) ok++;
  else low++;

  // Screen order, and it stays screen order. The extractor's side resolution is
  // what maps screen to title order, and it is not always the identity — so a
  // detection written as if it were would be a silent mis-attribution of exactly
  // the kind the champion path already had to fix.
  detected[id] = {
    left: bothConfident ? left.fuse : null,
    right: bothConfident ? right.fuse : null,
    score: { left: left.dist, right: right.dist },
    status: bothConfident ? 'ok-unordered' : 'low',
    era: 's1',
    detectedAt: today,
  } as FuseDetection;

  console.log(
    `  [${i + 1}/${work.length}] ${id}  hud ${hud.length}/${all.length}  ` +
      `L ${left.fuse ?? '—'}(d${left.dist} m${left.margin} s${left.struct})  ` +
      `R ${right.fuse ?? '—'}(d${right.dist} m${right.margin} s${right.struct})  → ${status}`,
  );
}

const blocked = missing.length > 0;
if (!dry && !blocked) writeFileSync(OUT, JSON.stringify(detected, null, 1) + '\n');
console.log(
  `\n✔ ${ok} confident · ${low} low · ${none} no-HUD` +
    (blocked
      ? '  (NOTHING WRITTEN — evo template set incomplete)'
      : dry
        ? '  (dry — nothing written)'
        : ''),
);
console.log('  Detections are SCREEN order (status ok-unordered) — the champion');
console.log('  extractor owns screen→title mapping. Next: npm run data:parse');

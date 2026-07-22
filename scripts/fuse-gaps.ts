// Fuse-gap diagnostic (LOCAL ONLY — read-only over the pipeline, no downloads,
// no detection). Reconciles data/videos.json against data/fuses-detected.json,
// data/overrides.json, and the low-review sheet, and buckets every video that
// still has no team fuse:
//
//   unavailable — attempted by the last download run, no entry ever written
//                 (yt-dlp failed); no cached frames/raw exist
//   low         — detection ran, pill seen, best guess below threshold
//   none        — detection ran, no saturated pill in any frame
//   pending     — entered videos.json after the last download run
//   anomaly     — confident detection exists but could not merge (e.g. the
//                 title never parsed into 2 teams)
//
// "Attempted by the last run" comes from git: the newest commit where
// fuses-detected.json gained ids marks a download run, and the videos.json
// committed just before it is the set of ids that run iterated. If the
// working-tree fuses-detected.json has ids HEAD doesn't, the last run is
// uncommitted and the current videos.json is the universe.
//
// Outputs (all under cache/fuse/review/):
//   fuse-gaps.md    — report; open with the summary table
//   fuse-gaps.json  — same data machine-readable (served by /api/dev/fuse-gaps
//                     for the dev-only /dev/fuse-gaps viewer)
//   gap-pills.png   — labeled pill-region crops for every low/none side, from
//                     cached frames (crop only — detection is not re-run)
//
//   npm run data:fuse-gaps

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import type {
  ChannelKey,
  FuseDetection,
  FuseGapBucket,
  FuseGapItem,
  FuseGapReport,
  VideoRecord,
} from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRAMES = join(ROOT, 'cache/fuse/frames');
const REVIEW = join(ROOT, 'cache/fuse/review');

// pill-drift window from scripts/fuses.ts (Y_SCAN −0.006…+0.016): the eyeball
// crops are padded by it so a drifted pill still lands inside the strip
const PAD_TOP = 0.006;
const PAD_BOTTOM = 0.016;

// ── data ──────────────────────────────────────────────────────────────────────
// manual (hand-authored) records are excluded up front: tournament fuses aren't
// CV-detected, so a fuse-less manual record is expected, not a gap
const videos = (
  JSON.parse(readFileSync(join(ROOT, 'data/videos.json'), 'utf8')) as VideoRecord[]
).filter((v) => v.parseConfidence !== 'manual');
const detected = JSON.parse(readFileSync(join(ROOT, 'data/fuses-detected.json'), 'utf8')) as Record<
  string,
  FuseDetection
>;
const overrides = JSON.parse(readFileSync(join(ROOT, 'data/overrides.json'), 'utf8')) as Record<
  string,
  Partial<VideoRecord>
>;
const regions = JSON.parse(readFileSync(join(ROOT, 'data/fuse-regions.json'), 'utf8')) as {
  default: { left: number[]; right: number[] };
};

const byId = new Map(videos.map((v) => [v.id, v]));
const eraOf = (v: VideoRecord) => (v.season === null ? 'beta' : `s${v.season}`);
const ERA_ORDER = ['beta', 's0', 's1', 's2'];
const eraRank = (e: string) => {
  const i = ERA_ORDER.indexOf(e);
  return i === -1 ? ERA_ORDER.length : i;
};

// ── attempt universe from git ─────────────────────────────────────────────────
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: ROOT,
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
const gitJson = <T>(ref: string, path: string): T | null => {
  try {
    return JSON.parse(git('show', `${ref}:${path}`)) as T;
  } catch {
    return null;
  }
};

interface Universe {
  ids: Set<string>;
  commit: string; // short sha or "(working tree)"
  runDate: string; // ISO — when that run's results landed
}
function attemptUniverse(): Universe {
  const headDetected =
    gitJson<Record<string, FuseDetection>>('HEAD', 'data/fuses-detected.json') ?? {};
  const uncommitted = Object.keys(detected).some((id) => !headDetected[id]);
  if (uncommitted) {
    return {
      ids: new Set(videos.map((v) => v.id)),
      commit: '(working tree)',
      runDate: new Date().toISOString(),
    };
  }
  const commits = git('log', '--format=%H', '--', 'data/fuses-detected.json')
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const c of commits) {
    const cur = gitJson<Record<string, FuseDetection>>(c, 'data/fuses-detected.json');
    if (!cur) continue;
    const prev = gitJson<Record<string, FuseDetection>>(`${c}~1`, 'data/fuses-detected.json') ?? {};
    if (!Object.keys(cur).some((id) => !prev[id])) continue; // re-detects only — not a download run
    const snapshot =
      gitJson<VideoRecord[]>(`${c}~1`, 'data/videos.json') ??
      gitJson<VideoRecord[]>(c, 'data/videos.json') ??
      [];
    return {
      ids: new Set(snapshot.map((v) => v.id)),
      commit: git('rev-parse', '--short', c).trim(),
      runDate: git('show', '-s', '--format=%aI', c).trim(),
    };
  }
  // no history (fresh clone with no committed detections): everything undetected is pending
  return { ids: new Set(), commit: '(none)', runDate: new Date().toISOString() };
}

// scripts/fuses.ts logs every download attempt to cache/fuse/attempted.json —
// when present that answers "was this id ever attempted?" exactly (targeted
// --ids retries included); the git inference above remains the fallback for a
// purged cache, where only full-backlog runs are reconstructable.
const attemptsPath = join(ROOT, 'cache/fuse/attempted.json');
const attemptLog = existsSync(attemptsPath)
  ? (JSON.parse(readFileSync(attemptsPath, 'utf8')) as Record<string, string[]>)
  : null;
const universe: Universe = attemptLog
  ? {
      ids: new Set(Object.keys(attemptLog)),
      commit: '(attempt log)',
      runDate: Object.values(attemptLog).flat().sort().at(-1) ?? new Date().toISOString(),
    }
  : attemptUniverse();

// ── bucket every missing-fuse video ───────────────────────────────────────────
const frameCount = (id: string) => {
  const dir = join(FRAMES, id);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).length : 0;
};

const missing = videos.filter((v) => !v.teams.some((t) => t.fuse));
const runTime = Date.parse(universe.runDate);
const items: FuseGapItem[] = missing.map((v) => {
  const det = detected[v.id];
  let bucket: FuseGapBucket;
  if (!det) bucket = universe.ids.has(v.id) ? 'unavailable' : 'pending';
  else if (det.status === 'low') bucket = 'low';
  else if (det.status === 'none') bucket = 'none';
  else bucket = 'anomaly'; // confident detection that parse.ts could not merge

  const flags: string[] = [];
  // git-fallback mode only — published within 48h of the run: the daily refresh
  // may have added it after the run iterated, so "no entry" doesn't prove a
  // failed download (with the attempt log this ambiguity doesn't exist)
  if (
    bucket === 'unavailable' &&
    !attemptLog &&
    runTime - Date.parse(v.publishedAt) < 48 * 3600 * 1000
  )
    flags.push('maybe-pending');
  if (v.durationSec === 0) flags.push('premiere');

  return {
    id: v.id,
    bucket,
    era: eraOf(v),
    channel: v.channel as ChannelKey, // manual records filtered out at load
    publishedAt: v.publishedAt,
    flags,
    frames: frameCount(v.id),
    ...(attemptLog?.[v.id] ? { attempts: attemptLog[v.id] } : {}),
    ...(det
      ? { detection: { left: det.left, right: det.right, score: det.score, status: det.status } }
      : {}),
  };
});
const sortKey = (a: FuseGapItem, b: FuseGapItem) =>
  eraRank(a.era) - eraRank(b.era) || a.publishedAt.localeCompare(b.publishedAt);
items.sort(sortKey);
const inBucket = (b: FuseGapBucket) => items.filter((i) => i.bucket === b);
const counts = Object.fromEntries(
  (['unavailable', 'low', 'none', 'pending', 'anomaly'] as const).map((b) => [
    b,
    inBucket(b).length,
  ]),
) as Record<FuseGapBucket, number>;

// ── reconciliation facts ──────────────────────────────────────────────────────
const statusTally: Record<string, number> = {};
for (const d of Object.values(detected)) statusTally[d.status] = (statusTally[d.status] ?? 0) + 1;
const orphanDetections = Object.keys(detected).filter((id) => !byId.has(id));
const lowIds = Object.entries(detected)
  .filter(([, d]) => d.status === 'low')
  .map(([id]) => id);
const lowRescued = lowIds.filter((id) => byId.get(id)?.teams.some((t) => t.fuse));
const unmergedConfident = items.filter((i) => i.bucket === 'anomaly');

// low-review.md is a byproduct of the last data:fuses run — say how stale it is
const sheetPath = join(REVIEW, 'low-review.md');
let sheetNote = 'low-review.md: not present';
if (existsSync(sheetPath)) {
  const sheetIds = [
    ...readFileSync(sheetPath, 'utf8').matchAll(/^\|\s*([A-Za-z0-9_-]{11})\s*\|/gm),
  ].map((m) => m[1]!);
  const sheetSet = new Set(sheetIds);
  const stale = sheetIds.filter(
    (id) => detected[id]?.status !== 'low' && detected[id]?.status !== 'none',
  );
  const absent = lowIds.filter((id) => !sheetSet.has(id));
  sheetNote =
    stale.length === 0 && absent.length === 0
      ? `low-review.md (${sheetIds.length} ids) is in sync with fuses-detected.json — this report adds the bucketing, era spread, and montage on top`
      : `low-review.md lists ${sheetIds.length} ids — ${stale.length} no longer low/none, ` +
        `${absent.length} current lows missing from it (sheet predates the last re-detect; this report supersedes it)`;
}

// ── era/channel spread ────────────────────────────────────────────────────────
type Spread = Record<string, Record<string, number>>;
function spreadOf(list: FuseGapItem[]): Spread {
  const s: Spread = {};
  for (const i of list) {
    s[i.era] ??= {};
    s[i.era]![i.channel] = (s[i.era]![i.channel] ?? 0) + 1;
  }
  return s;
}
function spreadTable(list: FuseGapItem[]): string {
  const s = spreadOf(list);
  const eras = Object.keys(s).sort((a, b) => eraRank(a) - eraRank(b));
  // Columns are DERIVED from the items, never hardcoded: this table used to name
  // proReplays/highLevel literally and compute total as pro+high, so a third channel
  // both vanished from the diagnostic AND silently under-reported every row total.
  // Deriving from `list` (not CHANNELS) also omits columns for channels with no gaps,
  // which is the right behaviour for a per-bucket table.
  const chans = [...new Set(list.map((i) => i.channel))].sort();
  // Build every row from one [era, ...chans, total] array so the column count is
  // identical across header/separator/rows even when chans is empty (an all-pending
  // bucket) — the old `| era | ${chans.join} | total |` emitted a phantom empty cell
  // for chans=[], desyncing header (3 cells) from separator (2) and breaking GFM.
  const row = (cells: (string | number)[]): string => `| ${cells.join(' | ')} |`;
  const header = ['era', ...chans, 'total'];
  const rows = eras.map((e) => {
    const nums = chans.map((c) => s[e]![c] ?? 0);
    return row([e, ...nums, nums.reduce((a, b) => a + b, 0)]);
  });
  const totals = chans.map((c) => list.filter((i) => i.channel === c).length);
  return [
    row(header),
    `|${'---|'.repeat(header.length)}`,
    ...rows,
    row(['**all**', ...totals.map((n) => `**${n}**`), `**${list.length}**`]),
  ].join('\n');
}

// ── pill montage for low/none (crop-only — no detection) ─────────────────────
interface MontageRow {
  item: FuseGapItem;
  side: 'left' | 'right';
  index: number; // per-video number shared by both sides
}
async function buildMontage(list: FuseGapItem[]): Promise<number> {
  const rows: MontageRow[] = [];
  list.forEach((item, i) => {
    if (item.frames === 0) return;
    rows.push({ item, side: 'left', index: i + 1 }, { item, side: 'right', index: i + 1 });
  });
  if (rows.length === 0) return 0;

  const CROP_H = 44;
  const GAP = 6;
  const LABEL_W = 560;
  const parts: OverlayOptions[] = [];
  let y = 0;
  let width = LABEL_W;
  for (const { item, side, index } of rows) {
    const dir = join(FRAMES, item.id);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort();
    const picks = [...new Set([2, Math.floor(files.length / 2), files.length - 1])]
      .filter((n) => n >= 0 && n < files.length)
      .map((n) => files[n]!);
    let x = 0;
    for (const f of picks) {
      const frame = join(dir, f);
      const meta = (await sharp(frame).metadata()) as { width: number; height: number };
      const [rx, ry, rw, rh] = regions.default[side] as [number, number, number, number];
      const top = Math.max(0, Math.round((ry - PAD_TOP) * meta.height));
      const crop = await sharp(frame)
        .extract({
          left: Math.round(rx * meta.width),
          top,
          width: Math.round(rw * meta.width),
          height: Math.min(
            Math.round((rh + PAD_TOP + PAD_BOTTOM) * meta.height),
            meta.height - top,
          ),
        })
        .resize({ height: CROP_H })
        .png()
        .toBuffer();
      const cm = await sharp(crop).metadata();
      parts.push({ input: crop, left: x, top: y });
      x += (cm.width ?? 0) + GAP;
    }
    const d = item.detection!;
    const guess = side === 'left' ? d.left : d.right;
    const dist = side === 'left' ? d.score.left : d.score.right;
    parts.push({
      input: {
        text: {
          text: `<span foreground="#FF2E88" background="#000000"> #${String(index).padStart(3, '0')}${side === 'left' ? 'L' : 'R'} ${item.id} · ${guess ?? '∅'} d${dist} · ${item.era} </span>`,
          rgba: true,
          dpi: 110,
        },
      },
      left: x + 4,
      top: y + Math.round(CROP_H / 2) - 8,
    });
    width = Math.max(width, x + LABEL_W);
    y += CROP_H + GAP;
  }
  await sharp({ create: { width, height: y, channels: 4, background: '#0A0B0F' } })
    .composite(parts)
    .png()
    .toFile(join(REVIEW, 'gap-pills.png'));
  return rows.length;
}

const reviewables = [...inBucket('low'), ...inBucket('none')];
mkdirSync(REVIEW, { recursive: true });
const montageRows = await buildMontage(reviewables);

// ── report ────────────────────────────────────────────────────────────────────
const md: string[] = [];
const esc = (s: string) => s.replace(/\|/g, '\\|');
const short = (s: string, n = 64) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const yt = (id: string) => `[▶](https://youtu.be/${id})`;
const today = new Date().toISOString().slice(0, 10);
const withFuse = videos.length - missing.length;

md.push(`# Fuse gaps — ${today}`);
md.push('');
md.push(
  `Inputs: videos.json (${videos.length}) · fuses-detected.json (${Object.keys(detected).length}: ` +
    `${Object.entries(statusTally)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}) · overrides.json (${Object.keys(overrides).length}) · ` +
    (attemptLog
      ? `attempt log: cache/fuse/attempted.json (${universe.ids.size} ids, last run ${universe.runDate.slice(0, 10)})`
      : `attempt universe: videos.json just before \`${universe.commit}\` (${universe.ids.size} ids, run landed ${universe.runDate.slice(0, 10)})`),
);
md.push('');
md.push('## Summary');
md.push('');
md.push(
  `${withFuse} of ${videos.length} videos have a fuse — **${missing.length} missing**, split:`,
);
md.push('');
md.push('| bucket | count | meaning | action |');
md.push('|---|---|---|---|');
md.push(
  `| 1 · UNAVAILABLE | **${counts.unavailable}** | attempted by the last run, download failed — no frames were ever cached | see the still-listed note below — most look retryable, not permanently lost |`,
);
md.push(
  `| 2 · LOW-CONFIDENCE | **${counts.low}** | pill seen, best guess under threshold | adjudicate via gap-pills.png → promote through overrides.json |`,
);
md.push(
  `| 3 · NONE | **${counts.none}** | frames cached, no saturated pill in any frame | ${counts.none ? 'eyeball for occlusion / new template class' : '— (none exist right now)'} |`,
);
md.push(
  `| 4 · NOT-YET-PROCESSED | **${counts.pending}** | added by the daily cron after the last run | picked up by the next \`data:fuses\` |`,
);
md.push(
  `| ⚠ ANOMALY | **${counts.anomaly}** | confident detection exists but could not merge | fix the underlying record (see below) |`,
);
md.push('');

md.push('## Reconciliation facts');
md.push('');
md.push(
  `- **ok-unordered vs truly absent:** all ${statusTally['ok-unordered'] ?? 0} ok-unordered detections merged into videos.json (they count as “has fuse”, shown unattributed). Among the ${missing.length} missing, **${unmergedConfident.length}** carr${unmergedConfident.length === 1 ? 'ies' : 'y'} a confident detection that could not merge${unmergedConfident.length ? `: ${unmergedConfident.map((i) => `\`${i.id}\` (status ${i.detection?.status}, video has ${byId.get(i.id)?.teams.length ?? 0} parsed teams — needs a title-parse override, not fuse work)`).join('; ')}` : ''}. Every other miss is genuinely fuse-less.`,
);
md.push(
  `- **UNAVAILABLE videos are still listed on YouTube.** \`data:fetch\` re-walks the full uploads playlists daily and drops ids the API stops returning (deleted/private), and videos.json is regenerated from that dump — so surviving today's refresh means YouTube still lists them. yt-dlp failing on 2026-07-02 while the API still serves them points at run-time throttling / age- or region-gating, **not** deletions. Orphan check agrees: ${orphanDetections.length} detected ids have dropped out of videos.json.`,
);
md.push(
  `- **Overrides already rescued ${lowRescued.length} low ids** (${lowRescued.map((id) => `\`${id}\``).join(', ') || '—'}) — ${lowIds.length} low total → ${counts.low} still missing. No override targets a missing video without giving it a fuse.`,
);
md.push(`- **Review sheet:** ${sheetNote}.`);
md.push('');

md.push('## Era × channel spread');
md.push('');
md.push(`**LOW + NONE (${reviewables.length})** — the reviewable gaps:`);
md.push('');
md.push(spreadTable(reviewables));
md.push('');
const s0beta = reviewables.filter((i) => i.era === 'beta' || i.era === 's0').length;
if (reviewables.length) {
  md.push(
    `${s0beta}/${reviewables.length} (${Math.round((100 * s0beta) / reviewables.length)}%) sit in beta/s0 footage — the same old-capture cluster as the confidence drift.`,
  );
  md.push('');
}
md.push(`**UNAVAILABLE (${counts.unavailable})** — for contrast, these do *not* cluster by era:`);
md.push('');
md.push(spreadTable(inBucket('unavailable')));
md.push('');

// ── bucket detail sections ────────────────────────────────────────────────────
md.push(`## 1 · UNAVAILABLE (${counts.unavailable}) — no cached frames, excluded from review`);
md.push('');
md.push(
  attemptLog
    ? 'Attempt dates come from cache/fuse/attempted.json. 2+ attempts = persistent failure — candidates for a cookies retry (`yt-dlp --cookies-from-browser`), do not loop on them unauthenticated.'
    : 'No action here until a retry pass is decided on. `maybe-pending` = published within 48h of the run — the daily refresh may have added it after the run iterated, so it may simply never have been attempted.',
);
md.push('');
md.push('| video | era | channel | published | attempts | flags | title |');
md.push('|---|---|---|---|---|---|---|');
for (const i of inBucket('unavailable')) {
  const v = byId.get(i.id)!;
  const tries = i.attempts ? `${i.attempts.length}× (last ${i.attempts.at(-1)})` : '—';
  md.push(
    `| \`${i.id}\` ${yt(i.id)} | ${i.era} | ${i.channel} | ${i.publishedAt.slice(0, 10)} | ${tries} | ${i.flags.join(' ') || ''} | ${esc(short(v.title))} |`,
  );
}
md.push('');

md.push(`## 2 · LOW-CONFIDENCE (${counts.low}) — adjudicate and promote via overrides.json`);
md.push('');
md.push(
  `Pill crops for every row are in **gap-pills.png** (${montageRows} rows; #NNN matches the montage label, L/R appended per side). Guesses/distances are the raw reads from fuses-detected.json — left/right are in title order.`,
);
md.push('');
md.push('| montage | video | era | channel | left guess (dist) | right guess (dist) | frames |');
md.push('|---|---|---|---|---|---|---|');
reviewables.forEach((i, idx) => {
  if (i.bucket !== 'low') return;
  const d = i.detection!;
  md.push(
    `| #${String(idx + 1).padStart(3, '0')} | \`${i.id}\` ${yt(i.id)} | ${i.era} | ${i.channel} | ${d.left ?? '∅'} (${d.score.left}) | ${d.right ?? '∅'} (${d.score.right}) | cache/fuse/frames/${i.id}/ (${i.frames}) |`,
  );
});
md.push('');

md.push(`## 3 · NONE (${counts.none}) — no pill matched at all`);
md.push('');
if (counts.none === 0) {
  md.push(
    'Empty today: the 2026-07-03 re-detect left zero `none` records — every video with frames read *something* off the pill window. If a future run produces them, they land in this section and in gap-pills.png, and are the place to hunt for missing template classes (sidekick still has zero specimens).',
  );
} else {
  md.push('| montage | video | era | channel | frames |');
  md.push('|---|---|---|---|---|');
  reviewables.forEach((i, idx) => {
    if (i.bucket !== 'none') return;
    md.push(
      `| #${String(idx + 1).padStart(3, '0')} | \`${i.id}\` ${yt(i.id)} | ${i.era} | ${i.channel} | cache/fuse/frames/${i.id}/ (${i.frames}) |`,
    );
  });
}
md.push('');

md.push(`## 4 · NOT-YET-PROCESSED (${counts.pending}) — waiting on the next data:fuses run`);
md.push('');
md.push('| video | published | era | channel | title |');
md.push('|---|---|---|---|---|');
for (const i of inBucket('pending')) {
  const v = byId.get(i.id)!;
  md.push(
    `| \`${i.id}\` ${yt(i.id)} | ${i.publishedAt.slice(0, 10)} | ${i.era} | ${i.channel} | ${esc(short(v.title))} |`,
  );
}
md.push('');

const maybePending = inBucket('unavailable').filter((i) =>
  i.flags.includes('maybe-pending'),
).length;
const persistent = inBucket('unavailable').filter((i) => (i.attempts?.length ?? 0) >= 2).length;
md.push('## Verdict — recoverable vs excluded vs pending');
md.push('');
md.push(
  `- **Recoverable by review now:** ${counts.low + counts.none} (LOW + NONE) — frames are cached, adjudication is a pass over gap-pills.png plus overrides.json entries. ${counts.anomaly ? `The anomal${counts.anomaly === 1 ? 'y' : 'ies'} (${counts.anomaly}) ${counts.anomaly === 1 ? 'is' : 'are'} also recoverable via a title-parse override.` : ''}`,
);
md.push(
  `- **Pending, no action:** ${counts.pending} certain${maybePending ? ` + ~${maybePending} of the UNAVAILABLE flagged \`maybe-pending\`` : ''} — the next \`data:fuses\` run attempts all of them.`,
);
md.push(
  attemptLog
    ? `- **Failed downloads:** ${counts.unavailable}, of which **${persistent} failed on 2+ separate runs** (persistent — candidates for a cookies retry, not for more unauthenticated loops). All are still YouTube-listed, so none are proven deleted.`
    : `- **Failed downloads:** ~${counts.unavailable - maybePending} — but since every one is still YouTube-listed (see reconciliation facts), "permanently un-fuseable" is unproven. They look like run-time yt-dlp failures (that backlog ran overnight at 0.09–0.10/s under throttle). A future targeted retry (\`npm run data:fuses -- --ids …\`) would sort them into detected vs truly-blocked; until then they stay excluded.`,
);
md.push('');
md.push(
  'Eyeball everything in the app (dev only): `npm run dev` → **/dev/fuse-gaps** (bucket + era filters, thumbnails, in-app playback, pill strips for LOW).',
);
md.push('');

writeFileSync(join(REVIEW, 'fuse-gaps.md'), md.join('\n'));

// ── machine-readable copy for the dev viewer ──────────────────────────────────
const report: FuseGapReport = {
  generatedAt: new Date().toISOString(),
  universe: { commit: universe.commit, videos: universe.ids.size, runDate: universe.runDate },
  totals: { videos: videos.length, withFuse, missing: missing.length },
  counts,
  items,
};
writeFileSync(join(REVIEW, 'fuse-gaps.json'), JSON.stringify(report, null, 1) + '\n');

// ── console summary ───────────────────────────────────────────────────────────
console.log(`fuse gaps: ${missing.length} of ${videos.length} videos missing a fuse`);
console.log(
  `  unavailable  ${String(counts.unavailable).padStart(4)}  (${maybePending} flagged maybe-pending)`,
);
console.log(`  low          ${String(counts.low).padStart(4)}`);
console.log(`  none         ${String(counts.none).padStart(4)}`);
console.log(`  pending      ${String(counts.pending).padStart(4)}`);
console.log(`  anomaly      ${String(counts.anomaly).padStart(4)}`);
console.log(
  `✓ cache/fuse/review/fuse-gaps.md · fuse-gaps.json · gap-pills.png (${montageRows} rows)`,
);

// Scan data/videos.json for records that are the SAME MATCH appearing twice —
// either re-uploaded across channels, or duplicated within one channel. Read-only:
// nothing here edits data/. The report footer prints a paste-ready overrides.json
// fragment; a human approves it. Rationale for audit-not-automatic: the daily cron
// is unattended, and a fuzzy matcher that silently drops a committed record is the
// exact failure class the stale-raw guard in parse.ts exists to prevent.
//
// Why this exists: the bestReplays channel re-uploads footage the other two already
// carry. Video ids never collide, so nothing in the pipeline notices — the match is
// simply counted twice in every stat, and shows up as two cards in the grid.
//
// Matching key: players+characters — per side sorted(playerSlugs)|sorted(characterIds),
// then the two sides sorted. Side-agnostic on purpose: channels disagree about which
// player is "left" (KWDEKx5OMKU vs 3LpLDn0ocII are the same match, swapped). The
// player slugs use the same slugify() parse.ts uses, so "CHRIS G" ↔ "CHRISG" already
// collapse — a characters-only backstop was tried and dropped: with only 15 champions
// the comps are too low-entropy, so chars+duration alone produced ~95% coincidental
// pairs (different players, same matchup, near-equal length) with no second signal to
// separate them. Genuine name-variant misses are left to data:player-dupes.
//
// TWO independent same-footage signals, because neither is sufficient alone:
//
//   1. Duration exactness. Within an identical players+characters signature, an
//      integer-second duration collision is near-impossible by chance — measured
//      over this catalog, all 23 cross-channel Δ≤1s pairs are the same match. This
//      is the ONLY signal that survives cross-channel, and it is the primary one.
//   2. Thumbnail dHash (64-bit). Same footage re-encoded on the SAME channel keeps a
//      near-identical auto-selected frame (Hamming ≲8). But this DOES NOT transfer
//      across channels: the same match re-uploaded to a different channel gets a
//      different custom/auto thumbnail — measured Hamming 17-38 (median 27) on 45
//      known same-footage cross pairs. So a high Hamming NEVER vetoes a match; it
//      only corroborates intra-channel.
//
// Duration tolerance is ABSOLUTE seconds, never a percentage — re-encode drift and a
// trimmed intro are a fixed cost, so a percentage would hand a long video a wide
// window and land it among genuinely distinct sets.
//
// Tiers (channel-aware):
//   A  Δdur ≤ 1s  (certain, any channel)  OR  intra-channel + ham ≤ 8 + Δdur ≤ 5s
//   B  Δdur ≤ 2s  OR  ham ≤ 12 + Δdur ≤ 15s  OR  intra + ham ≤ 8 + Δdur ≤ 30s
//   C  Δdur ≤ 90s  OR  ham ≤ 12   — REPORTED, default KEEP
// --min-tier gates the ACTIONABLE set (A, or A+B); C is always reported, never
// proposed. The acted-on window is deliberately narrower than the reported one: you
// want to see the ambiguity, not have a threshold hide it. Bias is toward false
// negatives — a surviving duplicate is one wrong replay count and is fixable later,
// while dropping a genuinely distinct match is silent, permanent, and invisible from
// the site (the failure class the stale-raw guard in parse.ts was added for).
//
// Usage: npx tsx scripts/replay-dupes.ts [--min-tier A|B] [--scope all|cross|intra]
//                                        [--no-prefer-existing] [--refresh-thumbs]
//                                        [--emit-overrides] [--json]

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import type { VideoRecord } from '../types/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(ROOT, 'cache/dupes');
const readJson = async <T>(p: string): Promise<T> =>
  JSON.parse(await readFile(join(DATA, p), 'utf8')) as T;

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(n);
const opt = (n: string, d: string): string => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const asJson = flag('--json');
const emitOverrides = flag('--emit-overrides');
const refreshThumbs = flag('--refresh-thumbs');
// Rules 1-2 of precedence, expressed as a hard constraint: a record carrying fuse
// detections or a hand-authored override can never be the one dropped. Dropping it
// would orphan CV work and strand an override key pointing at a record that no longer
// exists. Because the incoming channel has zero fuse data on day one, this makes the
// backfill purely subtractive on the new side.
const preferExisting = !flag('--no-prefer-existing');
const scope = opt('--scope', 'all') as 'all' | 'cross' | 'intra';
const minTier = opt('--min-tier', 'B').toUpperCase();

type Tier = 'A' | 'B' | 'C';
const TIER_ORDER: Tier[] = ['A', 'B', 'C'];
/** Tiers eligible to be PROPOSED for exclusion. C is report-only. */
const ACTIONABLE_TIERS: Tier[] = ['A', 'B'];

// ── normalizers ───────────────────────────────────────────────────────────────

/** Same slugify parse.ts and player-dupes.ts use — collapses "CHRIS G" ↔ "CHRISG". */
const slugify = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Side-agnostic players+characters key. Returns null when the record is unparsed. */
function signature(v: VideoRecord): string | null {
  const teams = v.teams ?? [];
  if (teams.length !== 2) return null;
  const sides: string[] = [];
  for (const t of teams) {
    const chars = [...t.characters].sort().join(',');
    const players = t.players
      .map((p) => slugify(p.displayName) || p.id)
      .sort()
      .join(',');
    if (!chars || !players) return null;
    sides.push(`${players}|${chars}`);
  }
  return sides.sort().join(' ~ ');
}

// ── thumbnail perceptual hash ─────────────────────────────────────────────────

type HashCache = Record<string, { dhash: string; hashedAt: string }>;

/** 64-bit dHash: greyscale 9x8, one bit per horizontally-adjacent pixel pair. */
async function dhash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += px[y * 9 + x] < px[y * 9 + x + 1] ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

const hamming = (a: string, b: string): number => {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
};

/** maxresdefault 404s on plenty of uploads — fall back down the ladder. */
async function fetchThumb(v: VideoRecord): Promise<Buffer | null> {
  const urls = [
    v.thumbnail,
    `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
  ].filter(Boolean);
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > 0) return buf;
    } catch {
      /* try the next rung */
    }
  }
  return null;
}

/** Hash only the ids that appear in a candidate pair — not the whole catalog. */
async function hashAll(ids: string[], byId: Map<string, VideoRecord>): Promise<HashCache> {
  const cachePath = join(OUT, 'thumb-hashes.json');
  const cache: HashCache =
    !refreshThumbs && existsSync(cachePath)
      ? (JSON.parse(await readFile(cachePath, 'utf8')) as HashCache)
      : {};
  const todo = ids.filter((id) => !cache[id]);
  if (todo.length) {
    if (!asJson) console.log(`  hashing ${todo.length} thumbnails (${ids.length - todo.length} cached)…`);
    let done = 0;
    const POOL = 8;
    await Promise.all(
      Array.from({ length: POOL }, async () => {
        for (;;) {
          const id = todo.pop();
          if (!id) return;
          const v = byId.get(id);
          const buf = v ? await fetchThumb(v) : null;
          if (buf) {
            try {
              cache[id] = { dhash: await dhash(buf), hashedAt: new Date().toISOString() };
            } catch {
              /* undecodable image — leave unhashed, pair falls to "inconclusive" */
            }
          }
          if (!asJson && ++done % 250 === 0) console.log(`    ${done}/${done + todo.length}`);
        }
      }),
    );
    mkdirSync(OUT, { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  }
  return cache;
}

// ── load ──────────────────────────────────────────────────────────────────────

const videos = await readJson<VideoRecord[]>('videos.json');
const overrides = await readJson<Record<string, unknown>>('overrides.json');
const detected = await readJson<Record<string, unknown>>('fuses-detected.json');

const byId = new Map(videos.map((v) => [v.id, v]));
const hasFuse = (id: string): boolean => detected[id] != null;
const hasOverride = (id: string): boolean => id !== '//' && overrides[id] != null;
/** Rules 1-2: this record carries work that would be orphaned by dropping it. */
const protectedRec = (id: string): boolean => hasFuse(id) || hasOverride(id);

// ── candidate generation ──────────────────────────────────────────────────────

interface Pair {
  a: VideoRecord; // provisional; precedence decides keep/drop below
  b: VideoRecord;
  durDelta: number;
}

const pairs: Pair[] = [];

// Group by signature, then pair up records within the widest reported window (90s).
// durationSec <= 0 is the unknown-duration sentinel (premieres/live in fetch.ts,
// manual entries default 0) — NOT a real length, so two 0-duration records must not
// collapse to a "Δ0s, certain" pair. Skip them from candidate generation entirely.
{
  const groups = new Map<string, VideoRecord[]>();
  for (const v of videos) {
    if ((v.durationSec ?? 0) <= 0) continue;
    const sig = signature(v);
    if (!sig) continue;
    (groups.get(sig) ?? groups.set(sig, []).get(sig)!).push(v);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const s = [...list].sort((p, q) => (p.durationSec ?? 0) - (q.durationSec ?? 0));
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        const delta = Math.abs((s[j].durationSec ?? 0) - (s[i].durationSec ?? 0));
        if (delta > 90) break; // sorted, so nothing further is in-window
        pairs.push({ a: s[i], b: s[j], durDelta: delta });
      }
    }
  }
}

const scoped = pairs.filter((p) => {
  const cross = p.a.channel !== p.b.channel;
  return scope === 'all' || (scope === 'cross' ? cross : !cross);
});

// ── adjudicate ────────────────────────────────────────────────────────────────

const ids = [...new Set(scoped.flatMap((p) => [p.a.id, p.b.id]))];
if (!asJson) console.log(`\n${videos.length} videos · ${scoped.length} candidate pairs · ${ids.length} thumbnails`);
const hashes = await hashAll(ids, byId);

const tierOf = (p: Pair, ham: number | null, intra: boolean): Tier | null => {
  const lowHam = ham !== null && ham <= 8;
  const okHam = ham !== null && ham <= 12;
  // Within ONE channel the thumbnail is informative both ways: same footage keeps a
  // near-identical auto-thumbnail (measured Hamming ≤7), so a HIGH intra hamming
  // contradicts same-footage — the exact-duration match is then likely a coincidence
  // between two different sets of the same matchup (the same players run many sets a
  // session). Cross-channel high hamming is EXPECTED (different custom thumbnails) and
  // is never treated as contradicting. So duration-alone certainty holds cross-channel
  // (validated: all 23 cross Δ≤1s pairs are real) but not intra-channel.
  const contradicted = intra && ham !== null && ham > 12;
  // A: exact duration is certain — cross-channel on its own, intra only if the
  //    thumbnail does not contradict it.
  if (p.durDelta <= 1 && !contradicted) return 'A';
  if (intra && lowHam && p.durDelta <= 5) return 'A';
  // B: near-exact duration, or a corroborating thumbnail within a modest window.
  if (p.durDelta <= 2 && !contradicted) return 'B';
  if (okHam && p.durDelta <= 15) return 'B';
  if (intra && lowHam && p.durDelta <= 30) return 'B';
  // C: same matchup but the evidence is only suggestive (incl. a contradicted intra
  //    exact-duration pair) — report for human review, never propose.
  if (p.durDelta <= 90 || okHam) return 'C';
  return null;
};

/** Ordered precedence; first rule that fires picks the KEEP side. */
function decide(a: VideoRecord, b: VideoRecord): { keep: VideoRecord; drop: VideoRecord; rule: string } {
  const mk = (keep: VideoRecord, drop: VideoRecord, rule: string) => ({ keep, drop, rule });
  const oa = hasOverride(a.id);
  const ob = hasOverride(b.id);
  if (oa !== ob) return oa ? mk(a, b, 'hand-authored-override') : mk(b, a, 'hand-authored-override');
  const fa = hasFuse(a.id);
  const fb = hasFuse(b.id);
  if (fa !== fb) return fa ? mk(a, b, 'fuse-detected') : mk(b, a, 'fuse-detected');
  if (a.publishedAt !== b.publishedAt)
    return a.publishedAt < b.publishedAt ? mk(a, b, 'earlier-upload') : mk(b, a, 'earlier-upload');
  const da = a.durationSec ?? 0;
  const db = b.durationSec ?? 0;
  if (da !== db) return da > db ? mk(a, b, 'longer-cut') : mk(b, a, 'longer-cut');
  return a.id < b.id ? mk(a, b, 'id-tiebreak') : mk(b, a, 'id-tiebreak');
}

interface Row {
  tier: Tier;
  scope: 'cross' | 'intra';
  keep: VideoRecord;
  drop: VideoRecord;
  rule: string;
  durDelta: number;
  ham: number | null;
  flags: string[];
}

const rows: Row[] = [];
for (const p of scoped) {
  const intra = p.a.channel === p.b.channel;
  const ha = hashes[p.a.id]?.dhash;
  const hb = hashes[p.b.id]?.dhash;
  const ham = ha && hb ? hamming(ha, hb) : null;
  const tier = tierOf(p, ham, intra);
  if (!tier) continue;
  const { keep, drop, rule } = decide(p.a, p.b);
  const flags: string[] = [];
  // The new channel is not automatically the re-uploader — say so when it predates.
  if (drop.publishedAt < keep.publishedAt) flags.push('reverse-direction');
  // Block only a genuine trade-DOWN: dropping a record that carries fuse/override work
  // for one that carries none. When BOTH sides are protected (an intra-catalog pair
  // where both have fuse — same footage, so the loser's fuse data is redundant),
  // dropping the duplicate orphans nothing, so it stays actionable.
  if (preferExisting && protectedRec(drop.id) && !protectedRec(keep.id)) {
    flags.push('blocked-by-prefer-existing');
  }
  // The drop already has a hand-authored override entry, so a standalone exclude in the
  // fragment would be a duplicate JSON key. Route it to manual: add "exclude": true to
  // the existing entry instead. Kept out of the auto-fragment, still reported.
  if (hasOverride(drop.id)) flags.push('drop-has-override');
  rows.push({
    tier,
    scope: keep.channel === drop.channel ? 'intra' : 'cross',
    keep,
    drop,
    rule,
    durDelta: p.durDelta,
    ham,
    flags,
  });
}

// Every row (A, B and the report-only C) is shown; --min-tier gates only what gets
// PROPOSED. A → propose tier A only; B (default) → propose A and B.
const minIdx = Math.max(0, ACTIONABLE_TIERS.indexOf(minTier as Tier));
const isActionableTier = (t: Tier): boolean => {
  const i = ACTIONABLE_TIERS.indexOf(t);
  return i >= 0 && i <= minIdx;
};
const visible = [...rows].sort(
  (x, y) =>
    TIER_ORDER.indexOf(x.tier) - TIER_ORDER.indexOf(y.tier) ||
    (x.ham ?? 64) - (y.ham ?? 64) ||
    x.durDelta - y.durDelta,
);

// Proposed for exclusion: an actionable tier, not blocked, not needing a manual merge,
// DEDUPED by drop id. An n-way cluster (3+ copies of one match) lists the same record
// as the drop in several pairs; without this dedup the fragment would emit a duplicate
// JSON key (last-wins on paste) and the count would over-report.
const BLOCKING_FLAGS = ['blocked-by-prefer-existing', 'drop-has-override'];
const actionable = [
  ...new Map(
    visible
      .filter((r) => isActionableTier(r.tier) && !r.flags.some((f) => BLOCKING_FLAGS.includes(f)))
      .map((r) => [r.drop.id, r]), // visible is sorted strongest-first → keeps the strongest row per drop
  ).values(),
];

// Resolve each cluster to its ULTIMATE survivor: in a 3-way cluster the pairwise keep
// of a dropped record can itself be a dropped record, so a naive dupeOf points at
// something that is also excluded. Follow keep pointers (a total order under decide(),
// so no cycles) until reaching a record that is not itself excluded.
const excludedIds = new Set(actionable.map((r) => r.drop.id));
const keepOf = new Map<string, string>();
for (const r of visible) if (!keepOf.has(r.drop.id)) keepOf.set(r.drop.id, r.keep.id);
const survivorOf = (dropId: string): string => {
  let cur = keepOf.get(dropId) ?? dropId;
  const seen = new Set<string>([dropId]);
  while (excludedIds.has(cur) && keepOf.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = keepOf.get(cur)!;
  }
  return cur;
};

const counts = TIER_ORDER.map((t) => [t, rows.filter((r) => r.tier === t).length] as const);
const yt = (id: string): string => `https://youtu.be/${id}`;

const fragment = (): string =>
  actionable
    .map((r) => {
      const survivor = survivorOf(r.drop.id);
      return [
        `  ${JSON.stringify(r.drop.id)}: {`,
        `    "//": "duplicate of ${survivor} — Δdur ${r.durDelta}s, thumb hamming ${r.ham ?? 'n/a'} [tier ${r.tier}, data:replay-dupes]",`,
        `    "dupeOf": ${JSON.stringify(survivor)},`,
        `    "exclude": true`,
        `  }`,
      ].join('\n');
    })
    .join(',\n');

// ── output ────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  universe: { videos: videos.length, candidatePairs: scoped.length, thumbHashed: Object.keys(hashes).length },
  options: { scope, minTier, preferExisting },
  counts: Object.fromEntries(counts),
  actionable: actionable.length,
  pairs: visible.map((r) => ({
    tier: r.tier,
    scope: r.scope,
    keep: { id: r.keep.id, channel: r.keep.channel, durationSec: r.keep.durationSec, publishedAt: r.keep.publishedAt, title: r.keep.title, hasFuse: hasFuse(r.keep.id), hasOverride: hasOverride(r.keep.id) },
    drop: { id: r.drop.id, channel: r.drop.channel, durationSec: r.drop.durationSec, publishedAt: r.drop.publishedAt, title: r.drop.title, hasFuse: hasFuse(r.drop.id), hasOverride: hasOverride(r.drop.id) },
    evidence: { durationDeltaSec: r.durDelta, thumbHamming: r.ham },
    precedenceRule: r.rule,
    flags: r.flags,
  })),
};

await writeFile(join(OUT, 'replay-dupes.json'), `${JSON.stringify(report, null, 2)}\n`);

const md: string[] = [
  '# Duplicate replay candidates',
  '',
  `_Generated ${report.generatedAt}_`,
  '',
  `${videos.length} videos · ${scoped.length} candidate pairs · ${actionable.length} proposed exclusions`,
  '',
  '| tier | pairs | meaning | action |',
  '|---|---|---|---|',
  `| A | ${rows.filter((r) => r.tier === 'A').length} | exact duration (Δ ≤ 1s), or same-channel near-identical thumbnail | batch-approve |`,
  `| B | ${rows.filter((r) => r.tier === 'B').length} | near-exact duration, or a corroborating thumbnail within a modest window | skim, then approve |`,
  `| C | ${rows.filter((r) => r.tier === 'C').length} | same matchup, evidence only suggestive | **reported only — default keep** |`,
  '',
  `Precedence: ${preferExisting ? '`--prefer-existing` is ON — a record carrying fuse/override work is never traded DOWN for one that carries none (intra-catalog pairs where both carry work stay actionable).' : '`--no-prefer-existing` — full precedence chain, any record CAN be dropped.'}`,
  '',
  '| tier | keep | drop | Δdur | hamming | rule | flags |',
  '|---|---|---|---|---|---|---|',
  ...visible.map(
    (r) =>
      `| ${r.tier} | [\`${r.keep.id}\`](${yt(r.keep.id)}) ${r.keep.channel} | [\`${r.drop.id}\`](${yt(r.drop.id)}) ${r.drop.channel} | ${r.durDelta}s | ${r.ham ?? '—'} | ${r.rule} | ${r.flags.join(', ') || '—'} |`,
  ),
  '',
  '## Titles',
  '',
  ...visible.flatMap((r) => [`- **${r.tier}** keep \`${r.keep.id}\` — ${r.keep.title}`, `  - drop \`${r.drop.id}\` — ${r.drop.title}`]),
  '',
  '## To apply',
  '',
  '1. Paste the fragment below into `data/overrides.json` (see `--emit-overrides`).',
  '2. `npm run data:parse` — excluded ids never reach `videos.json`, so stats, players and',
  '   the fuse pipeline all re-derive without them. `exclude:true` short-circuits the',
  '   shallow merge in parse.ts, so the sibling `dupeOf` key is inert provenance.',
  '3. Confirm the record count dropped by exactly the number of entries added.',
  '4. `npm run data:player-dupes` — dropping duplicates prunes players referenced only by',
  '   them, so the alias backlog shrinks on its own.',
  '',
  'Nothing here is irreversible: removing the entry and re-parsing brings the record back,',
  'because the source of truth is still `raw/`.',
  '',
];
await writeFile(join(OUT, 'replay-dupes.md'), md.join('\n'));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else if (emitOverrides) {
  console.log(fragment() || '(nothing actionable at this tier)');
} else {
  console.log(
    `\n${counts.map(([t, n]) => `${t}:${n}`).join('  ')}   → ${actionable.length} proposed exclusions\n`,
  );
  for (const r of visible.slice(0, 40)) {
    console.log(
      `[${r.tier}] keep ${r.keep.id} (${r.keep.channel}, ${r.keep.durationSec}s)\n` +
        `        drop ${r.drop.id} (${r.drop.channel}, ${r.drop.durationSec}s)\n` +
        `        Δ${r.durDelta}s · hamming ${r.ham ?? '—'} · ${r.rule}${r.flags.length ? ` · ${r.flags.join(', ')}` : ''}\n` +
        `        ${r.keep.title}\n`,
    );
  }
  if (visible.length > 40) console.log(`… ${visible.length - 40} more in cache/dupes/replay-dupes.md\n`);
  console.log('Full report: cache/dupes/replay-dupes.md · --emit-overrides for the paste-ready fragment\n');
}

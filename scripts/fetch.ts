// Stage 1: fetch every upload from both channels via the YouTube Data API v3,
// dump raw metadata to raw/<channel>.json, and print a reconnaissance report.
//
// Run: npm run data:fetch   (tsx --env-file=.env scripts/fetch.ts)

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, type ChannelConfig } from './channels';
import { aheadOfDump, newestUpload } from './freshness';
import {
  apiGet,
  fetchVideoMetadata,
  listAllUploadIds,
  requireApiKey,
  type ChannelsResponse,
} from './youtube';
import type {
  ChannelKey,
  DepartedEvidence,
  Fuse,
  RawVideoRecord,
  VideoRecord,
} from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'raw');

// ── API key (never hardcode; read from env, fail loudly if missing) ──────────
// The client itself lives in ./youtube — scripts/fetch-theater.ts needs the same
// one, and this file cannot be imported (it calls main() at module load).
requireApiKey('data:fetch');

// ── small utils ──────────────────────────────────────────────────────────────
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const pct = (n: number, total: number) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));

// 1. Resolve a channel's uploads playlist id.
async function resolveUploadsPlaylist(ch: ChannelConfig): Promise<string> {
  // Only a YouTube channel has one. An index source is skipped before this is
  // reached (see main), so arriving here without `resolve` is a config bug.
  if (!ch.resolve) {
    throw new Error(
      `Channel "${ch.key}" has no \`resolve\` — an index source must be fetched by its own script, not data:fetch.`,
    );
  }
  const params: Record<string, string> = { part: 'contentDetails' };
  if (ch.resolve.by === 'id') params.id = ch.resolve.value;
  else params.forHandle = ch.resolve.value;

  const data = await apiGet<ChannelsResponse>('channels', params);
  const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) {
    throw new Error(
      `Could not resolve uploads playlist for "${ch.key}" via ${JSON.stringify(ch.resolve)} ` +
        `(response returned ${data.items?.length ?? 0} channel item(s)).`,
    );
  }
  return uploads;
}

// ── reconnaissance ────────────────────────────────────────────────────────────
const SEASON_RE = /Season\s*(\d+)/i;
const PATCH_RE = /Patch\s*:/i;
// Approximate structural heuristic for the recon console — NOT an exact mirror of
// parse.ts (that would mean running the parser). It approximates the real failure
// modes: parse strips the FIRST ▰ (prefix) and LAST ▰ (suffix), so a valid title has
// a "(chars) vs (chars)" core that is itself ▰-free, with at most one leading and one
// trailing ▰-segment. A third ▰ (a mid-title accolade like "▰ Rank 1 NA ▰"), or
// trailing text after the second parens ("… vs B (x-y) 5 Matches ▰ …"), or a non-▰
// separator (🔥) is a genuine failure and is flagged. 2XKO is intentionally NOT
// required — a title parses on its structure, whether 2XKO sits in the lead or the
// branding. Console-only; report.md is the authoritative low-confidence record.
const EXPECTED_SHAPE = /^[^▰]*(?:▰\s*)?[^▰]*?\([^)]*\)\s+vs\s+[^▰]*?\([^)]*\)\s*(?:▰[^▰]*)?$/i;

// Build one matcher for any fuse name/alias from data/fuses.json.
async function loadFuseMatcher(): Promise<RegExp> {
  const raw = await readFile(join(ROOT, 'data', 'fuses.json'), 'utf8');
  const fuses = JSON.parse(raw) as Record<string, Fuse>;
  const terms = new Set<string>();
  for (const f of Object.values(fuses)) {
    terms.add(f.name.toLowerCase());
    for (const a of f.aliases) terms.add(a.toLowerCase());
  }
  const alts = [...terms]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`\\b(?:${alts})\\b`, 'i');
}

// Description lines that carry season/patch/fuse signal (for format eyeballing).
function metaLines(desc: string, fuseRe: RegExp): string[] {
  return desc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && (SEASON_RE.test(l) || PATCH_RE.test(l) || fuseRe.test(l)));
}

function runRecon(channelKey: ChannelKey, records: RawVideoRecord[], fuseRe: RegExp): void {
  const ch = CHANNELS[channelKey];
  const total = records.length;

  console.log(`\n${'═'.repeat(72)}`);
  console.log(` ${ch.name}   ·   key: ${ch.key}`);
  console.log('═'.repeat(72));
  console.log(`Total videos: ${total}`);

  // First 25 raw titles.
  console.log(`\n── First 25 raw titles ──`);
  records.slice(0, 25).forEach((r, i) => console.log(` ${String(i + 1).padStart(2)}. ${r.title}`));
  if (total === 0) console.log('  (none)');

  // Metadata coverage across ALL descriptions.
  let seasonN = 0;
  let patchN = 0;
  let fuseN = 0;
  for (const r of records) {
    if (SEASON_RE.test(r.description)) seasonN++;
    if (PATCH_RE.test(r.description)) patchN++;
    if (fuseRe.test(r.description)) fuseN++;
  }
  console.log(`\n── Metadata coverage (across all ${total} descriptions) ──`);
  console.log(`  Season  /Season\\s*(\\d+)/i : ${seasonN}/${total}  (${pct(seasonN, total)}%)`);
  console.log(`  Patch:  label present     : ${patchN}/${total}  (${pct(patchN, total)}%)`);
  console.log(`  Fuse    name/alias present: ${fuseN}/${total}  (${pct(fuseN, total)}%)`);

  // 3 example description snippets showing those formats.
  console.log(`\n── Example description snippets (season / patch / fuse formatting) ──`);
  const withMeta = records.filter((r) => metaLines(r.description, fuseRe).length > 0);
  const examples = (withMeta.length > 0 ? withMeta : records).slice(0, 3);
  if (examples.length === 0) {
    console.log('  (no descriptions available)');
  } else {
    for (const r of examples) {
      console.log(`  • [${r.id}] "${truncate(r.title, 68)}"`);
      const lines = metaLines(r.description, fuseRe);
      if (lines.length > 0) {
        for (const l of lines.slice(0, 6)) console.log(`      ┆ ${truncate(l, 108)}`);
      } else {
        console.log(
          `      ┆ ${truncate(r.description.replace(/\s+/g, ' ').trim(), 160) || '(empty description)'}`,
        );
      }
    }
  }

  // Titles that don't match the expected shape.
  console.log(`\n── Titles NOT matching expected shape  (2XKO ▰ …(…) vs …(…) ▰ …) ──`);
  const offShape = records.filter((r) => !EXPECTED_SHAPE.test(r.title.replace(/\s+/g, ' ').trim()));
  if (offShape.length === 0) {
    console.log(`  (none — all ${total} titles match)`);
  } else {
    console.log(`  ${offShape.length}/${total} do not match:`);
    for (const r of offShape) console.log(`  ✗ [${r.id}] ${r.title}`);
  }
}

// ── departures: the one case the stale-raw guard cannot judge from data ──────
// A channel that deletes its NEWEST upload and posts nothing after it leaves a
// fresh dump looking exactly like a stale one (scripts/freshness.ts). So this
// asks YouTube about the committed records newer than the dump — aheadOfDump,
// the guard's own selection — and records the ones that can no longer reach
// the dump. On an ordinary morning there are none, so it makes no call. One
// videos.list call covers 50 ids.
//
// "Can no longer reach the dump" is wider than "no longer public" here, because
// the channel's game-marker gate runs before raw/ is written: a public upload
// retitled out of the marker is dropped exactly as a deleted one is. So the
// check takes that channel's own marker test, and only a record that is public
// AND still carries the marker counts as live (and keeps the guard firing).
interface StatusResponse {
  items: {
    id: string;
    status: { privacyStatus: string };
    snippet: { title: string; description: string };
  }[];
}

async function confirmDepartures(
  key: ChannelKey,
  dump: RawVideoRecord[],
  committed: VideoRecord[],
  carriesMarker: (r: Pick<RawVideoRecord, 'title' | 'description'>) => boolean,
): Promise<DepartedEvidence> {
  const ahead = aheadOfDump(key, dump, committed).map((v) => v.id);
  const ids: string[] = [];
  for (let i = 0; i < ahead.length; i += 50) {
    const batch = ahead.slice(i, i + 50);
    const res = await apiGet<StatusResponse>('videos', {
      part: 'snippet,status',
      id: batch.join(','),
      maxResults: '50',
    });
    const live = new Set(
      res.items
        .filter((v) => v.status.privacyStatus === 'public' && carriesMarker(v.snippet))
        .map((v) => v.id),
    );
    ids.push(...batch.filter((x) => !live.has(x)));
  }
  return {
    channel: key,
    newestInDump: newestUpload(dump),
    checkedAt: new Date().toISOString(),
    ids,
  };
}

/** The committed catalogue, for the departure check only. Absent or unreadable
 *  is treated as empty: no check runs, no departure is recorded, and the guard
 *  stays strict. */
async function readCommitted(): Promise<VideoRecord[]> {
  try {
    const v = JSON.parse(await readFile(join(ROOT, 'data', 'videos.json'), 'utf8')) as unknown;
    return Array.isArray(v) ? (v as VideoRecord[]) : [];
  } catch {
    return [];
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  const fuseRe = await loadFuseMatcher();
  const committed = await readCommitted();

  const byChannel = new Map<ChannelKey, RawVideoRecord[]>();

  for (const ch of Object.values(CHANNELS)) {
    if (ch.frozen) {
      // No enumeration, no raw dump. parse.ts carries this channel's committed
      // records forward instead; re-fetching would only re-observe the collapse.
      console.log(`\n⏸ Skipping "${ch.key}" — frozen ${ch.frozen.since}: ${ch.frozen.reason}`);
      continue;
    }
    if (ch.index) {
      // An index source has no uploads playlist, so there is nothing for this
      // command to walk. It is fetched daily too, since 2026-09-02 — by
      // `data:theater`, in its OWN cron step, placed after this one and allowed
      // to fail so a bad morning upstream cannot cost the channel dumps already
      // in hand. parse.ts carries its committed records on any run that has no
      // dump.
      console.log(`\n⏸ Skipping "${ch.key}" — index source, pulled by \`npm run data:theater\``);
      continue;
    }
    console.log(`\n▶ Fetching "${ch.key}" (${ch.name})…`);
    const uploads = await resolveUploadsPlaylist(ch);
    console.log(`  uploads playlist: ${uploads}`);
    const ids = await listAllUploadIds(uploads);
    console.log(`  enumerated ${ids.length} upload video id(s)`);
    const all = await fetchVideoMetadata(ids, ch.key);
    console.log(`  fetched metadata for ${all.length} video(s)`);
    // A multi-game channel is gated HERE rather than at parse, so raw/<key>.json
    // stays a dump of THIS GAME's uploads. Evo publishes every game it runs, and
    // without the marker ~2,750 Street Fighter, Tekken and Guilty Gear records
    // enter the 2XKO corpus and have to be rejected one at a time forever.
    //
    // SCOPE IS PER CHANNEL because the two failure modes are opposite. A replay
    // channel that rebrands keeps its 2XKO boilerplate in the description while
    // the title switches game, so it can only be judged on the title; Evo's 2XKO
    // clips are titled with bare commentary quotes and can only be identified
    // from the description. scripts/channels.ts carries the measurement for each.
    //
    // Over-gating does not go quiet. The drop happens before raw/ is written and
    // parse.ts's channel-collapse guard compares the committed videos.json
    // against raw/, so a pattern that started rejecting real uploads at scale
    // stops the next build instead of publishing the loss.
    const signal = ch.gameSignal;
    const carriesMarker = (r: Pick<RawVideoRecord, 'title' | 'description'>): boolean =>
      signal === undefined ||
      signal.pattern.test(r.title) ||
      (signal.scope === 'title-or-description' && signal.pattern.test(r.description));
    const records = all.filter(carriesMarker);
    if (signal) {
      const dropped = all.filter((r) => !carriesMarker(r));
      const where = signal.scope === 'title' ? 'the title' : 'title or description';
      console.log(
        `  ${records.length}/${all.length} carry the ${ch.name} game marker in ${where} ` +
          `(${dropped.length} other-game upload(s) dropped)`,
      );
      // raw/ is gitignored and refetched daily, so a rejection leaves no trace in
      // any tracked file — this log is the only record that a specific upload was
      // refused, and the daily Action's log is where it will be read. Name them,
      // capped: Evo drops ~2,700 a run and a wall of Tekken titles would bury the
      // one that mattered.
      for (const r of dropped.slice(0, 10))
        console.log(`      ✗ [${r.id}] ${truncate(r.title, 96)}`);
      if (dropped.length > 10) console.log(`      … ${dropped.length - 10} more`);
    }
    const outPath = join(RAW_DIR, `${ch.key}.json`);
    // Asked BEFORE anything is written, so a check that throws leaves the
    // previous dump and its departure file together, untouched. The old file
    // still goes before the new dump lands, so the two are never from different
    // fetches; parse.ts checks the binding as well.
    const departed = await confirmDepartures(ch.key, records, committed, carriesMarker);
    const departedPath = join(RAW_DIR, `${ch.key}.departed.json`);
    await rm(departedPath, { force: true });
    await writeFile(outPath, JSON.stringify(records, null, 2) + '\n', 'utf8');
    console.log(`  → wrote raw/${ch.key}.json`);
    await writeFile(departedPath, JSON.stringify(departed, null, 2) + '\n', 'utf8');
    if (departed.ids.length)
      console.log(
        `  ↘ ${departed.ids.length} committed upload(s) newer than this dump are gone from ` +
          `YouTube or lost the game marker: ${departed.ids.join(', ')}. parse prunes them.`,
      );
    byChannel.set(ch.key, records);
  }

  console.log(`\n\n${'█'.repeat(72)}`);
  console.log(`  RECONNAISSANCE`);
  console.log('█'.repeat(72));
  for (const ch of Object.values(CHANNELS)) {
    if (ch.frozen || ch.index) continue; // no dump here, so nothing to reconnoitre
    runRecon(ch.key, byChannel.get(ch.key) ?? [], fuseRe);
  }

  const grandTotal = [...byChannel.values()].reduce((n, r) => n + r.length, 0);
  console.log(
    `\n✔ Stage 1 complete — ${grandTotal} videos across ${byChannel.size} channels. Raw dumps in raw/.`,
  );
  console.log(
    '  Review the recon above, then confirm delimiters + coverage before Stage 2 (parser).',
  );
}

main().catch((err) => {
  console.error(
    `\n✖ Fetch failed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});

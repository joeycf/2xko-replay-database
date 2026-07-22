// Stage 1: fetch every upload from both channels via the YouTube Data API v3,
// dump raw metadata to raw/<channel>.json, and print a reconnaissance report.
//
// Run: npm run data:fetch   (tsx --env-file=.env scripts/fetch.ts)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, type ChannelConfig } from './channels';
import type { ChannelKey, Fuse, RawVideoRecord } from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'raw');
const API_BASE = 'https://www.googleapis.com/youtube/v3';

// ── API key (never hardcode; read from env, fail loudly if missing) ──────────
const rawKey = process.env.YT_API_KEY;
if (!rawKey) {
  console.error(
    [
      '✖ Missing YT_API_KEY.',
      '  Create a .env file in the project root containing:',
      '    YT_API_KEY=your_key_here',
      '  (see .env.example). data:fetch loads it via `tsx --env-file=.env`.',
    ].join('\n'),
  );
  process.exit(1);
}
const API_KEY: string = rawKey;

// ── small utils ──────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const pct = (n: number, total: number) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));

// ── YouTube API GET with retry on 5xx / 429, fail loudly on other 4xx ────────
async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>,
  retries = 5,
): Promise<T> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', API_KEY);

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `  ⚠ network error on ${endpoint} (attempt ${attempt}/${retries}); retrying in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }

    if (res.ok) return (await res.json()) as T;

    const body = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `  ⚠ HTTP ${res.status} on ${endpoint} ${JSON.stringify(params)} (attempt ${attempt}/${retries}); retrying in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }
    // Non-retryable 4xx or out of retries → fail loudly with the API's error body.
    // (The key is never included: it is only ever set on the URL, not in `params`.)
    throw new Error(
      `YouTube API error: HTTP ${res.status} on ${endpoint} ${JSON.stringify(params)}\n${body}`,
    );
  }
  throw new Error(`Exhausted retries for ${endpoint}`);
}

// ── minimal shapes of the API responses we consume ───────────────────────────
type Thumbnails = Record<string, { url?: string } | undefined>;
interface ChannelsResponse {
  items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
}
interface PlaylistItemsResponse {
  items?: Array<{ contentDetails?: { videoId?: string } }>;
  nextPageToken?: string;
}
interface VideoItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: Thumbnails;
  };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
}
interface VideosResponse {
  items?: VideoItem[];
}

// 1. Resolve a channel's uploads playlist id.
async function resolveUploadsPlaylist(ch: ChannelConfig): Promise<string> {
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

// 2. Page through the uploads playlist collecting every videoId.
async function listAllUploadIds(playlistId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = { part: 'contentDetails', maxResults: '50', playlistId };
    if (pageToken) params.pageToken = pageToken;
    const data = await apiGet<PlaylistItemsResponse>('playlistItems', params);
    for (const item of data.items ?? []) {
      const vid = item.contentDetails?.videoId;
      if (vid) ids.push(vid);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

// 3. Fetch full metadata in batches of 50, preserving uploads order.
async function fetchVideoMetadata(ids: string[], channel: ChannelKey): Promise<RawVideoRecord[]> {
  const byId = new Map<string, RawVideoRecord>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet<VideosResponse>('videos', {
      part: 'snippet,contentDetails,statistics',
      id: batch.join(','),
    });
    for (const item of data.items ?? []) byId.set(item.id, toRawRecord(item, channel));
  }
  // Keep uploads-playlist order; silently drop any ids the API didn't return
  // (e.g. deleted / private videos).
  return ids.map((id) => byId.get(id)).filter((r): r is RawVideoRecord => r != null);
}

function toRawRecord(item: VideoItem, channel: ChannelKey): RawVideoRecord {
  const sn = item.snippet ?? {};
  return {
    id: item.id,
    channel,
    title: sn.title ?? '',
    description: sn.description ?? '',
    publishedAt: sn.publishedAt ?? '',
    thumbnail: pickThumbnail(sn.thumbnails, item.id),
    durationSec: parseIsoDuration(item.contentDetails?.duration),
    viewCount: Number(item.statistics?.viewCount ?? 0),
  };
}

// Highest-res thumbnail: maxres → standard → high → medium → default → fallback.
function pickThumbnail(thumbs: Thumbnails | undefined, videoId: string): string {
  for (const key of ['maxres', 'standard', 'high', 'medium', 'default'] as const) {
    const url = thumbs?.[key]?.url;
    if (url) return url;
  }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ISO-8601 duration (e.g. "PT7M1S") → seconds.
function parseIsoDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return 0;
  const [, h, min, s] = m;
  return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
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

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  const fuseRe = await loadFuseMatcher();

  const byChannel = new Map<ChannelKey, RawVideoRecord[]>();

  for (const ch of Object.values(CHANNELS)) {
    console.log(`\n▶ Fetching "${ch.key}" (${ch.name})…`);
    const uploads = await resolveUploadsPlaylist(ch);
    console.log(`  uploads playlist: ${uploads}`);
    const ids = await listAllUploadIds(uploads);
    console.log(`  enumerated ${ids.length} upload video id(s)`);
    const records = await fetchVideoMetadata(ids, ch.key);
    console.log(`  fetched metadata for ${records.length} video(s)`);
    const outPath = join(RAW_DIR, `${ch.key}.json`);
    await writeFile(outPath, JSON.stringify(records, null, 2) + '\n', 'utf8');
    console.log(`  → wrote raw/${ch.key}.json`);
    byChannel.set(ch.key, records);
  }

  console.log(`\n\n${'█'.repeat(72)}`);
  console.log(`  RECONNAISSANCE`);
  console.log('█'.repeat(72));
  for (const ch of Object.values(CHANNELS)) runRecon(ch.key, byChannel.get(ch.key) ?? [], fuseRe);

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

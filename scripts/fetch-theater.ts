// Stage 1 for the INDEX source: pull Replay Theater's tagged 2XKO tournament
// matches, join each to the YouTube metadata of the VOD it points into, and dump
// the result to raw/replayTheater.json.
//
// Run: npm run data:theater
//
// WHY THIS IS A SEPARATE COMMAND, and not part of data:fetch. data:fetch runs in
// the daily cron. A third party's uptime and goodwill should not become a cron
// dependency on day one of an integration, and committed records survive source
// loss anyway (the frozen-channel lesson). So this is LOCAL-FIRST: run by hand,
// on a cadence a human chooses, and parse.ts carries the committed records
// forward on every run that finds no dump — which is every cron run. Folding it
// into the cron is a later, separate decision.
//
// WHAT IT IS NOT. Replay Theater hosts no video. It is an index: a match is a
// (videoId, startSeconds) pair plus players, champions and an event tag. So a
// record here is a SEGMENT — ~16 of them share one three-hour VOD — and its id
// is `${videoId}@${startSeconds}`. See scripts/channels.ts.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS } from './channels';
import { fetchVideoMetadataWithUploader, requireApiKey } from './youtube';
import type { TheaterRawRecord } from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'raw');
const OUT = join(RAW_DIR, 'replayTheater.json');
const PARTIAL = join(RAW_DIR, '.replayTheater.partial.json');

const CH = CHANNELS.replayTheater;
const INDEX = CH.index!;

const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh');
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const MAX_PAGES = Number(opt('--max-pages') ?? Infinity);

requireApiKey('data:theater');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (n: number, total: number) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));

// ── the index API ────────────────────────────────────────────────────────────

/** One entry exactly as the catalogue publishes it. Everything is nullable:
 *  this is someone else's schema and we do not get to assume. */
interface TheaterEntry {
  id?: number;
  game?: string | null;
  video_link?: string | null;
  tag?: string | null;
  upload_date?: string | null;
  p1_name?: string | null;
  p2_name?: string | null;
  p1_char?: string | null;
  p1_char2?: string | null;
  p1_char3?: string | null;
  p1_char4?: string | null;
  p2_char?: string | null;
  p2_char2?: string | null;
  p2_char3?: string | null;
  p2_char4?: string | null;
}
interface TheaterPage {
  matches?: TheaterEntry[];
  total_count?: number | string;
}

async function getPage(page: number, retries = 4): Promise<TheaterPage> {
  const url = `${INDEX.endpoint}?game=${encodeURIComponent(INDEX.game)}&page=${page}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          // Identify the client. This is a fellow fan project, not a target.
          'user-agent': 'replay-database/2xko (+https://github.com/joeycf) data:theater',
        },
      });
      if (res.ok) return (await res.json()) as TheaterPage;
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status} (not retryable)\n${await res.text().catch(() => '')}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= retries || msg.includes('not retryable')) {
        throw new Error(`Replay Theater page ${page} failed: ${msg}`, { cause: err });
      }
      const wait = Math.min(1500 * 2 ** (attempt - 1), 10_000);
      console.warn(
        `  ⚠ page ${page} (attempt ${attempt}/${retries}): ${msg}; retrying in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  throw new Error(`Exhausted retries for page ${page}`);
}

// ── video link → (videoId, startSeconds) ─────────────────────────────────────
//
// THE LINKS ARE CONCATENATED, NOT BUILT. Replay Theater's own submission form
// does `video_link = base + "&t=" + t + "s"` regardless of what `base` looks
// like, so a youtu.be submission produces `https://youtu.be/<id>&t=554s` — a
// PATH with no query string at all. 463 of the 899 tagged entries are that
// shape. A URL-parsing extractor reads the id as "iBrqrEwPuR4&t=554s" and a
// lenient one would happily build a record around it, so this matches the id
// shape explicitly and refuses anything else rather than guessing.
const VIDEO_ID =
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:live|shorts|embed)\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
const START = /[?&]t=(\d+)s?/;

function parseLink(link: string): { videoId: string; startSeconds: number } | null {
  const id = VIDEO_ID.exec(link ?? '');
  if (!id) return null;
  const t = START.exec(link);
  return { videoId: id[1], startSeconds: t ? Number(t[1]) : 0 };
}

// ── chapters, derived from the description ───────────────────────────────────
//
// The Data API does not return chapters; YouTube itself derives them from the
// description, and so do we. The rule YouTube applies: timestamped lines, at
// least three of them, the first at 0:00. We only need the LABEL for a given
// offset, so a looser read is fine — but the "first must be 0:00" test is kept,
// because a description that merely mentions a time is not a chapter list.
const CHAPTER_LINE =
  /^\s*(?:\[|\()?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\]|\))?\s*[-–—:|]?\s*(.+?)\s*$/;

interface Chapter {
  start: number;
  title: string;
}

function chaptersOf(description: string): Chapter[] {
  const out: Chapter[] = [];
  for (const line of (description ?? '').split('\n')) {
    const m = CHAPTER_LINE.exec(line);
    if (!m) continue;
    const [, a, b, c, title] = m;
    const start = c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
    if (title.trim()) out.push({ start, title: title.trim() });
  }
  if (out.length < 3 || out[0].start !== 0) return [];
  return out.sort((x, y) => x.start - y.start);
}

// Bracket vocabulary, ordered longest-first so "losers quarter-final" wins over
// "final". Only these produce a `round`: a chapter titled "Player vs Player"
// names no round and must not be mistaken for one.
const ROUND_RE =
  /\b(grand\s*finals?|winners?\s*finals?|losers?\s*finals?|winners?\s*semi-?finals?|losers?\s*semi-?finals?|winners?\s*quarter-?finals?|losers?\s*quarter-?finals?|winners?\s*round\s*\d+|losers?\s*round\s*\d+|winners?\s*semis?|losers?\s*semis?|winners?\s*quarters?|losers?\s*quarters?|semi-?finals?|quarter-?finals?|top\s*\d+|round\s*\d+|pools?|finals?)\b/i;

/** Title-case the matched round so records read consistently regardless of how
 *  a given uploader capitalised their chapter. */
function roundAt(chapters: Chapter[], t: number): string | undefined {
  let hit: Chapter | undefined;
  for (const c of chapters) {
    if (c.start <= t) hit = c;
    else break;
  }
  if (!hit) return undefined;
  const m = ROUND_RE.exec(hit.title);
  if (!m) return undefined;
  return m[0]
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });

  // Resume: a partial pull is keyed by Replay Theater's own entry id, so a
  // re-run after an interruption re-fetches only the pages it never saw and the
  // overlap merges rather than duplicating. --fresh discards it.
  const byTheaterId = new Map<number, TheaterEntry>();
  let seenPages = new Set<number>();
  if (!FRESH && existsSync(PARTIAL)) {
    try {
      const prev = JSON.parse(await readFile(PARTIAL, 'utf8')) as {
        pages: number[];
        entries: TheaterEntry[];
      };
      for (const e of prev.entries) if (e.id != null) byTheaterId.set(e.id, e);
      seenPages = new Set(prev.pages);
      console.log(
        `  ↻ resuming: ${byTheaterId.size} entr(ies) from ${seenPages.size} cached page(s)`,
      );
    } catch {
      console.warn('  ⚠ unreadable partial cache — starting fresh');
    }
  }

  console.log(`\n▶ Pulling the Replay Theater index (${INDEX.endpoint}, game=${INDEX.game})…`);
  const first = await getPage(1);
  const total = Number(first.total_count ?? 0);
  const pages = Math.min(Math.ceil(total / INDEX.pageSize), MAX_PAGES);
  console.log(`  catalogue reports ${total} match(es) → ${pages} page(s) of ${INDEX.pageSize}`);
  for (const e of first.matches ?? []) if (e.id != null) byTheaterId.set(e.id, e);
  seenPages.add(1);

  for (let p = 2; p <= pages; p++) {
    if (seenPages.has(p)) continue;
    await sleep(INDEX.pacingMs);
    const data = await getPage(p);
    for (const e of data.matches ?? []) if (e.id != null) byTheaterId.set(e.id, e);
    seenPages.add(p);
    if (p % 10 === 0 || p === pages) {
      console.log(`  … page ${p}/${pages} (${byTheaterId.size} unique entries)`);
      await writeFile(
        PARTIAL,
        JSON.stringify({ pages: [...seenPages], entries: [...byTheaterId.values()] }),
        'utf8',
      );
    }
  }
  const catalogue = [...byTheaterId.values()];
  console.log(`  pulled ${catalogue.length} unique entr(ies)`);

  // ── the game gate, PER ENTRY ────────────────────────────────────────────────
  // `?game=2xko` is a query someone else answers. This repo has already been
  // burned once by trusting a filter it did not control (the ▰-pollution
  // incident), and an index is a strictly weaker guarantee than a channel: a
  // mistagged submission would arrive looking exactly like a real one. Every
  // entry states its own game, so check that instead of the query.
  const WANT_GAME = '2XKO';
  const wrongGame = catalogue.filter((e) => (e.game ?? '').trim().toUpperCase() !== WANT_GAME);
  const rightGame = catalogue.filter((e) => (e.game ?? '').trim().toUpperCase() === WANT_GAME);
  if (wrongGame.length) {
    console.log(`  ⚠ ${wrongGame.length} entr(ies) rejected — entry.game is not ${WANT_GAME}:`);
    for (const e of wrongGame.slice(0, 10)) {
      console.log(`      #${e.id} game=${JSON.stringify(e.game)} ${e.video_link ?? ''}`);
    }
    if (wrongGame.length > 10) console.log(`      … ${wrongGame.length - 10} more`);
  }

  // ── scope: tagged tournament matches only ───────────────────────────────────
  // The untagged remainder is online ranked play. This repo already carries
  // three channels of that; what it has none of is tournament sets.
  const tagged = rightGame.filter((e) => (e.tag ?? '').trim() !== '');
  console.log(
    `  ${tagged.length} tagged tournament match(es); ${rightGame.length - tagged.length} untagged (out of scope)`,
  );

  // ── links ───────────────────────────────────────────────────────────────────
  const linked: Array<{ e: TheaterEntry; videoId: string; startSeconds: number }> = [];
  const unparseable: TheaterEntry[] = [];
  for (const e of tagged) {
    const got = parseLink(e.video_link ?? '');
    if (!got) unparseable.push(e);
    else linked.push({ e, ...got });
  }
  if (unparseable.length) {
    console.error(`\n✖ ${unparseable.length} tagged entr(ies) have no extractable YouTube id:`);
    for (const e of unparseable.slice(0, 10)) {
      console.error(`    #${e.id} ${JSON.stringify(e.video_link)}`);
    }
    console.error('  Refusing rather than guessing — an id is not something to approximate.');
    process.exit(1);
  }

  // A (videoId, startSeconds) collision would mean two records competing for one
  // id. There are none today across the whole 3,547-entry catalogue; assert it
  // rather than discover it as a silently-dropped record downstream.
  const seen = new Map<string, TheaterEntry>();
  for (const l of linked) {
    const key = `${l.videoId}@${l.startSeconds}`;
    const prev = seen.get(key);
    if (prev) {
      console.error(
        [
          `\n✖ Two Replay Theater entries share one (videoId, startSeconds): ${key}`,
          `    #${prev.id}  ${prev.p1_name} vs ${prev.p2_name}  [${prev.tag}]`,
          `    #${l.e.id}  ${l.e.p1_name} vs ${l.e.p2_name}  [${l.e.tag}]`,
          `  That pair IS the record id, so one would silently overwrite the other.`,
        ].join('\n'),
      );
      process.exit(1);
    }
    seen.set(key, l.e);
  }

  // ── join to YouTube ─────────────────────────────────────────────────────────
  const vodIds = [...new Set(linked.map((l) => l.videoId))];
  console.log(`\n▶ Fetching YouTube metadata for ${vodIds.length} source VOD(s)…`);
  const vods = await fetchVideoMetadataWithUploader(vodIds, CH.key);
  const missingVods = vodIds.filter((id) => !vods.has(id));
  if (missingVods.length) {
    // Reported, never silent. A VOD that has gone private or been deleted takes
    // its matches with it, and that is a fact about the corpus, not noise.
    console.log(`  ⚠ ${missingVods.length} VOD(s) no longer resolve (private/deleted):`);
    for (const id of missingVods) {
      const n = linked.filter((l) => l.videoId === id).length;
      const tag = linked.find((l) => l.videoId === id)?.e.tag ?? '?';
      console.log(`      ${id}  ${n} match(es)  [${tag}]`);
    }
  }

  const chaptersByVod = new Map<string, Chapter[]>();
  for (const [id, v] of vods) chaptersByVod.set(id, chaptersOf(v.description));

  const chars = (e: TheaterEntry, side: 1 | 2): string[] =>
    ([`p${side}_char`, `p${side}_char2`, `p${side}_char3`, `p${side}_char4`] as const)
      .map((k) => (e as Record<string, unknown>)[k])
      .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      .map((c) => c.trim());

  const records: TheaterRawRecord[] = [];
  for (const { e, videoId, startSeconds } of linked) {
    const vod = vods.get(videoId);
    if (!vod) continue; // unresolvable VOD, already reported
    const round = roundAt(chaptersByVod.get(videoId) ?? [], startSeconds);
    records.push({
      id: `${videoId}@${startSeconds}`,
      channel: CH.key,
      // The title is SYNTHESIZED — Replay Theater carries none. It follows the
      // corpus's ▰ shape so cards read consistently, and it carries the event
      // tag because `title` is the engine's search haystack: that is what makes
      // "Saltmine" find these records without any new render surface.
      title: `2XKO ▰ ${e.p1_name ?? '?'} (${chars(e, 1).join(' / ')}) vs ${e.p2_name ?? '?'} (${chars(e, 2).join(' / ')}) ▰ ${e.tag}`,
      description: '',
      // The VOD's real publish time. Deliberately NOT offset by startSeconds:
      // that would shift a record by up to 10 hours and could cross a
      // day-grained patch boundary, which is the authority season and patch are
      // derived from. Sets within one VOD therefore share a timestamp and sort
      // by array order, which is start-offset ascending.
      publishedAt: vod.publishedAt,
      thumbnail: vod.thumbnail,
      // Replay Theater publishes no per-match duration and there is nothing
      // honest to derive one from — the gap to the next set includes the
      // downtime between them. 0 means "unknown"; emit.ts omits the field.
      durationSec: 0,
      viewCount: 0,
      theaterId: e.id!,
      videoId,
      startSeconds,
      tag: (e.tag ?? '').trim(),
      ...(round ? { round } : {}),
      uploader: vod.uploader,
      players: [(e.p1_name ?? '').trim(), (e.p2_name ?? '').trim()],
      characters: [chars(e, 1), chars(e, 2)],
    });
  }

  // Stable order: by VOD publish date, then by offset within the VOD. Deterministic
  // output means a re-pull that changed nothing produces no diff.
  records.sort(
    (a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.startSeconds - b.startSeconds,
  );

  await writeFile(OUT, JSON.stringify(records, null, 2) + '\n', 'utf8');
  console.log(`\n  → wrote raw/replayTheater.json (${records.length} record(s))`);

  // ── reconnaissance ──────────────────────────────────────────────────────────
  console.log(`\n\n${'█'.repeat(72)}`);
  console.log('  RECONNAISSANCE — replayTheater');
  console.log('█'.repeat(72));
  console.log(`\n  catalogue (all games' 2xko query): ${catalogue.length}`);
  console.log(`  rejected by the per-entry game gate: ${wrongGame.length}`);
  console.log(`  tagged tournament matches:           ${tagged.length}`);
  console.log(`  written (VOD resolvable):            ${records.length}`);

  const byTag = new Map<string, number>();
  for (const r of records) byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1);
  const byVod = new Map<string, number>();
  for (const r of records) byVod.set(r.videoId, (byVod.get(r.videoId) ?? 0) + 1);
  const perVod = [...byVod.values()].sort((a, b) => a - b);
  console.log(`\n  distinct event tags:  ${byTag.size}`);
  console.log(
    `  distinct source VODs: ${byVod.size}  (min ${perVod[0]} / median ${perVod[perVod.length >> 1]} / max ${perVod[perVod.length - 1]} matches per VOD)`,
  );
  const dates = records.map((r) => r.publishedAt.slice(0, 10)).sort();
  console.log(`  date range:           ${dates[0]} … ${dates[dates.length - 1]}`);
  const withRound = records.filter((r) => r.round).length;
  console.log(
    `  round harvested from VOD chapters: ${withRound}/${records.length} (${pct(withRound, records.length)}%)`,
  );

  const uploaders = new Map<string, number>();
  for (const r of records) uploaders.set(r.uploader, (uploaders.get(r.uploader) ?? 0) + 1);
  console.log(`\n  host channels (${uploaders.size}):`);
  for (const [name, n] of [...uploaders.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${name}`);
  }

  console.log(`\n  events (${byTag.size}):`);
  for (const [tag, n] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${tag}`);
  }

  console.log(
    `\n✔ Stage 1 (index) complete — ${records.length} tagged tournament match(es) over ${byVod.size} VOD(s).`,
  );
  console.log('  Next: npm run data:parse');
}

main().catch((err) => {
  console.error(
    `\n✖ data:theater failed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});

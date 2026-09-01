// Stage 1 for the INDEX source: pull Replay Theater's tagged 2XKO tournament
// matches, join each to the YouTube metadata of the VOD it points into, and dump
// the result to raw/replayTheater.json.
//
// Run: npm run data:theater   (and now: every morning, from the cron)
//
// THE POSTURE CHANGED ON 2026-08-31, and the old one is worth stating because
// this comment used to argue the opposite. It said the pull was LOCAL-FIRST —
// "a third party's uptime and goodwill should not become a cron dependency on
// day one of an integration" — and that was right, on day one. Four games have
// since been ingested, the trust re-measured against the uploaders' own chapter
// markers (99.8% agreement on player names here, 606 of 607, median timestamp
// offset 0s — see scripts/channels.ts), and the catalogue's operator is a
// collaborator rather than a stranger. replaytheater.app/robots.txt read
// 2026-08-31 is `User-agent: * / Disallow:`; requests carry a contactable
// user-agent and the catalogue's own pacing. What the old policy costs today is
// a human remembering to run this.
//
// WHAT MAKES IT SAFE IS NOT THE RELATIONSHIP, THOUGH — it is two rules that hold
// even when the goodwill does not:
//
//   1. ADD-ONLY. This source can only ADD records. A committed record is carried
//      regardless of what the catalogue says today; entries that vanish are
//      COUNTED in report.md, never removed, and the pin only grows.
//   2. THE CRON NEVER DEPENDS ON THIS SUCCEEDING. The step runs LAST and is
//      allowed to fail. On any failure — network, non-200, malformed page, an
//      unexplained id collision — there is simply no dump, parse.ts carries
//      exactly as it did before this change, and the cron stays green. A bad day
//      upstream costs that day's new entries and nothing else.
//
// AND WHAT MAKES IT AFFORDABLE is the cursor below. A full sweep is 71 paced
// requests for this game alone and 619 across the four; sending that every
// morning to a fellow fan project is not a design. The catalogue orders
// newest-first, so the daily path reads a handful of pages instead.
//
// WHAT IT IS NOT. Replay Theater hosts no video. It is an index: a match is a
// (videoId, startSeconds) pair plus players, champions and an event tag. So a
// record here is a SEGMENT — ~16 of them share one three-hour VOD — and its id
// is `${videoId}@${startSeconds}`. See scripts/channels.ts.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
/** What the pull learned about ITSELF, beside the dump. parse.ts reads it to
 *  learn whether this dump is the whole catalogue or a delta, how far the cursor
 *  reached, and how many double submissions were collapsed — a number the
 *  records alone cannot reconstruct, because the collapsed entries are gone by
 *  the time parse sees them. Absent on a carrying run, which report.md says
 *  rather than printing 0. */
const STATS = join(RAW_DIR, '.replayTheater.stats.json');
/** EVERY entry the run saw, tagged and untagged, in the catalogue's own shape.
 *  Kept OUT of raw/replayTheater.json on purpose: that file is the INTAKE and
 *  parse.ts builds one record per row of it, so an untagged row landing there
 *  would publish online ranked play as a tournament match. This file is the
 *  WITNESS — nothing reads it yet; it is the substrate for a cross-check. */
const WITNESS = join(RAW_DIR, 'replayTheater.witness.json');
/** The cursor's committed state: the highest catalogue entry id ever seen, so a
 *  run knows where "already seen" starts without re-reading 71 pages. Written by
 *  parse.ts (every data/ write is parse's), read here. */
const CURSOR = join(ROOT, 'data', 'theater-cursor.json');
/** Resume cache for a --full sweep only. The cursor replaced it on the daily
 *  path: two resume mechanisms that can disagree are worse than one, and this
 *  one records page NUMBERS against a catalogue that grows at the FRONT, so a
 *  second run refetched page 1 and skipped 2..N as "seen". Deleted on every
 *  successful run. */
const PARTIAL = join(RAW_DIR, '.replayTheater.partial.json');

const CH = CHANNELS.replayTheater;
const INDEX = CH.index!;

const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh');
/** THE DAILY PATH is the cursor. `--full` forces the whole-catalogue sweep,
 *  which is what `--fresh` has always meant and what a periodic reconciliation
 *  still wants. */
const FULL = argv.includes('--full') || FRESH;
const CURSOR_MODE = !FULL;
/** Two clean pages, not one. The catalogue orders `upload_date DESC, id ASC`, so
 *  a day's submissions can straddle a page boundary and one clean page is not
 *  proof there is nothing behind it. */
const CLEAN_PAGES_TO_STOP = 2;
/** A hard ceiling on the daily path, so a catalogue-side reordering can never
 *  turn the cron into a 71-page sweep.
 *
 *  THE HEADROOM HERE IS THIN, and that is worth stating rather than inheriting.
 *  Probed 2026-08-31 across the platform: the newest 200 submissions sit within
 *  page 10 for 2XKO — the deepest of the four games, where SF6's sit within page
 *  5. So ten pages is roughly the measured depth, not a comfortable multiple of
 *  it. Which is exactly why hitting the bound is REPORTED rather than silent:
 *  under add-only an unreached entry is late, never lost, and
 *  `npm run data:theater -- --full` reconciles. */
const CURSOR_MAX_PAGES = 10;
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

/** A side's champions, in the catalogue's own order and spelling. Four slots
 *  exist in the schema; a 2XKO side is a DUO, so two are filled on 886 of the
 *  888 committed records. Read at MODULE scope because two places need it: the
 *  double-submission collapse compares the whole tuple, and the record builder
 *  writes it. */
const chars = (e: TheaterEntry, side: 1 | 2): string[] =>
  ([`p${side}_char`, `p${side}_char2`, `p${side}_char3`, `p${side}_char4`] as const)
    .map((k) => (e as Record<string, unknown>)[k])
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });

  // CLEAR THE PREVIOUS RUN'S SELF-REPORT BEFORE FETCHING ANYTHING. parse.ts
  // reads .replayTheater.stats.json to learn what THIS pull did — its mode, its
  // page count, the cursor it reached — and a file left over from yesterday
  // answers those questions about the wrong run. Specifically: a pull that dies
  // on its first request writes nothing, so parse would find yesterday's stats,
  // report "the pull found no new entries" instead of "no pull this run", and
  // re-advance the cursor off a number this run never observed.
  //
  // Invisible in CI, where a fresh checkout has no raw/ at all — which is
  // exactly why it is done here rather than trusted to the environment.
  await rm(STATS, { force: true });
  await rm(WITNESS, { force: true });

  // Resume: a partial pull is keyed by Replay Theater's own entry id, so a
  // re-run after an interruption re-fetches only the pages it never saw and the
  // overlap merges rather than duplicating. --fresh discards it. FULL ONLY now:
  // the cursor is the daily path's resume mechanism, and this cache records page
  // NUMBERS against a catalogue that grows at the front, so on a cursor run it
  // would skip exactly the pages the cursor exists to read.
  const byTheaterId = new Map<number, TheaterEntry>();
  let seenPages = new Set<number>();
  if (FULL && !FRESH && existsSync(PARTIAL)) {
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

  // ── the cursor ──────────────────────────────────────────────────────────────
  // The catalogue orders `upload_date DESC, id ASC` — verified across a page
  // boundary on 2026-08-31 — and entry ids increase with submission. So "have I
  // seen everything new?" is answerable from the FRONT of the feed alone, and
  // the answer is: keep paging until CLEAN_PAGES_TO_STOP consecutive pages offer
  // no id above the committed cursor.
  //
  // WHY NOT `?since=` OR A REAL CURSOR: there isn't one. Probed 2026-08-31 —
  // `since`, `limit`, `per_page`, `sort`, `order` and `after_id` are all ACCEPTED
  // and silently IGNORED (byte-identical responses). Only `game` and `page` are
  // honoured, and `game` is validated: an unrecognised slug returns "Invalid
  // game" rather than falling through to the unfiltered catalogue. Worth knowing,
  // because it means the per-entry game gate below is a second line rather than
  // the only one.
  //
  // WHAT THE CURSOR CANNOT SEE, stated rather than hidden: the ordering key is
  // the VIDEO's upload date, not the submission's. Someone submitting a 2024 VOD
  // today lands deep in the feed, behind the bound, and this run will not reach
  // it. Under add-only that is late, never lost — the entry keeps its id, a
  // --full sweep collects it, and nothing already committed is affected.
  const cursorFile = await readFile(CURSOR, 'utf8')
    .then((t) => JSON.parse(t) as Record<string, number>)
    .catch(() => ({}) as Record<string, number>);
  const cursorAt = cursorFile[CH.key] ?? 0;

  console.log(`\n▶ Pulling the Replay Theater index (${INDEX.endpoint}, game=${INDEX.game})…`);
  const first = await getPage(1);
  const total = Number(first.total_count ?? 0);
  const fullPages = Math.ceil(total / INDEX.pageSize);
  const pages = Math.min(CURSOR_MODE ? CURSOR_MAX_PAGES : fullPages, MAX_PAGES);
  console.log(
    CURSOR_MODE
      ? `  catalogue reports ${total} match(es) (${fullPages} page(s) of ${INDEX.pageSize}); cursor at entry id ${cursorAt || '—'}, reading at most ${pages}`
      : `  catalogue reports ${total} match(es) → ${pages} page(s) of ${INDEX.pageSize}`,
  );
  for (const e of first.matches ?? []) if (e.id != null) byTheaterId.set(e.id, e);
  seenPages.add(1);

  let cleanRun = (first.matches ?? []).some((e) => (e.id ?? 0) > cursorAt) ? 0 : 1;
  let pagesRead = 1;
  let stoppedEarly = false;
  for (let p = 2; p <= pages; p++) {
    if (CURSOR_MODE && cleanRun >= CLEAN_PAGES_TO_STOP) {
      stoppedEarly = true;
      break;
    }
    if (seenPages.has(p)) continue;
    await sleep(INDEX.pacingMs);
    const data = await getPage(p);
    const rows = data.matches ?? [];
    for (const e of rows) if (e.id != null) byTheaterId.set(e.id, e);
    seenPages.add(p);
    pagesRead++;
    cleanRun = rows.some((e) => (e.id ?? 0) > cursorAt) ? 0 : cleanRun + 1;
    // An empty page is the END of the catalogue, not a clean page to count
    // towards the stop condition.
    if (rows.length === 0) {
      stoppedEarly = true;
      break;
    }
    if (!CURSOR_MODE && (p % 10 === 0 || p === pages)) {
      console.log(`  … page ${p}/${pages} (${byTheaterId.size} unique entries)`);
      await writeFile(
        PARTIAL,
        JSON.stringify({ pages: [...seenPages], entries: [...byTheaterId.values()] }),
        'utf8',
      );
    }
  }
  if (CURSOR_MODE && cleanRun >= CLEAN_PAGES_TO_STOP) stoppedEarly = true;
  const hitBound = CURSOR_MODE && !stoppedEarly && pagesRead >= pages;
  const catalogue = [...byTheaterId.values()];
  const maxEntryId = catalogue.reduce((m, e) => Math.max(m, e.id ?? 0), cursorAt);
  console.log(
    CURSOR_MODE
      ? `  read ${pagesRead} page(s), ${catalogue.length} entr(ies); ${catalogue.filter((e) => (e.id ?? 0) > cursorAt).length} newer than the cursor → new cursor ${maxEntryId}`
      : `  pulled ${catalogue.length} unique entr(ies)`,
  );
  if (hitBound) {
    console.log(
      `  ⚠ the cursor hit its ${CURSOR_MAX_PAGES}-page bound without going quiet — entries may be\n` +
        `    unreached this run. Nothing is lost (this source is add-only), only late; run\n` +
        `    \`npm run data:theater -- --full\` to reconcile.`,
    );
  }

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

  // ── the same match, submitted twice ─────────────────────────────────────────
  //
  // A (videoId, startSeconds) pair IS the record id, so two entries sharing one
  // would mean two records competing for it and one silently overwriting the
  // other. This used to exit 1 on the FIRST such pair, which was right while the
  // catalogue had none — and is the wrong shape for a cron: a double submission
  // upstream would take the daily pull down every morning until a human noticed,
  // for a cause that has one known, tractable form. SF6's catalogue carries 35 of
  // them and they all share it: the same event submitted twice under two tag
  // spellings, identical players, champions, videoId and offset.
  //
  // THIS catalogue had none at first ingest — 0 collisions across its 3,547
  // entries — so nothing collapses here today and the counter reports 0. The
  // machinery is here because a cron cannot afford the old answer, not because
  // the data needs it yet.
  //
  // So that form is COLLAPSED first, deterministically, and COUNTED — a silent
  // collapse is indistinguishable from a fetcher that lost records. The tie is
  // broken on the TAG SPELLING rather than on the catalogue's entry ids, because
  // entry ids reflect submission order and would make the surviving copy depend
  // on which of two identical rows happened to be typed first.
  //
  // SAMENESS IS THE WHOLE CHAMPION TUPLE, not the first slot, and that widening
  // is load-bearing in this game rather than defensive. A 2XKO side is a DUO:
  // 886 of the 888 committed records carry two champions on both sides (99.8%;
  // the two exceptions carry one). Comparing `p1_char`/`p2_char` alone would read
  // "Ahri / Yasuo vs Jinx / Darius" and "Ahri / Braum vs Jinx / Ekko" as the same
  // match on essentially every row, and collapsing those would delete a real set.
  //
  // AND SAMENESS IS A MULTISET, NOT AN ORDER — the second half of that widening,
  // and it is the half specific to a TAG game. A 2XKO side is a duo with no
  // canonical ordering: the submitter types whichever champion they noticed
  // first, so the same double-submitted match reads "Ahri / Yasuo" on one copy
  // and "Yasuo / Ahri" on the other. Compared in the catalogue's order those two
  // rows are not the same match, the collapse declines them, they fall through to
  // the collision assert, and the run exits 1 — the exact cron-killing outcome
  // the collapse exists to remove, arrived at by being too strict rather than too
  // loose. Sorted, they collapse the way they should.
  //
  // ONLY FOR THE SAMENESS TEST. The record builder below still writes
  // `chars(e, side)` UNSORTED, so what gets published is the catalogue's own
  // order — sorting here decides which rows are the same match, never what a
  // record says.
  const charTuple = (e: TheaterEntry, side: 1 | 2): string =>
    chars(e, side)
      .map((c) => c.toLowerCase())
      .sort()
      .join('|');
  const byKey = new Map<
    string,
    Array<{ e: TheaterEntry; videoId: string; startSeconds: number }>
  >();
  for (const l of linked) {
    const key = `${l.videoId}@${l.startSeconds}`;
    byKey.set(key, [...(byKey.get(key) ?? []), l]);
  }
  const deduped: Array<{ e: TheaterEntry; videoId: string; startSeconds: number }> = [];
  const collapsedTags = new Map<string, number>();
  let collapsed = 0;
  const collisions: string[] = [];
  for (const [key, group] of byKey) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    const head = group[0].e;
    const sameMatch = group.every(
      (g) =>
        (g.e.p1_name ?? '') === (head.p1_name ?? '') &&
        (g.e.p2_name ?? '') === (head.p2_name ?? '') &&
        charTuple(g.e, 1) === charTuple(head, 1) &&
        charTuple(g.e, 2) === charTuple(head, 2),
    );
    if (sameMatch) {
      const sorted = [...group].sort((a, b) =>
        (a.e.tag ?? '').trim().localeCompare((b.e.tag ?? '').trim()),
      );
      deduped.push(sorted[0]);
      collapsed += group.length - 1;
      const pair = [...new Set(group.map((g) => (g.e.tag ?? '').trim()))].sort().join('  ||  ');
      collapsedTags.set(pair, (collapsedTags.get(pair) ?? 0) + group.length - 1);
      continue;
    }
    collisions.push(
      [
        `  ${key}`,
        ...group.map(
          (g) => `    #${g.e.id}  ${g.e.p1_name} vs ${g.e.p2_name}  [${(g.e.tag ?? '').trim()}]`,
        ),
      ].join('\n'),
    );
    deduped.push(group[0]);
  }
  if (collapsed > 0) {
    console.log(`\n  collapsed ${collapsed} double-submitted entr(ies) — same match, two tags:`);
    for (const [pair, n] of [...collapsedTags].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${n}×  ${pair}`);
    }
  }
  if (collisions.length > 0) {
    console.error(
      `\n✖ ${collisions.length} (videoId, startSeconds) collision(s) this cannot explain:`,
    );
    console.error(collisions.join('\n'));
    console.error(
      [
        '  That pair IS the record id, so one entry would silently overwrite the other.',
        '  These are not the same match under two tag spellings, which is handled above.',
        '  Two genuinely different matches whose links defeat the offset reader need the',
        '  reader fixed, not the assert loosened.',
      ].join('\n'),
    );
    process.exit(1);
  }

  // ── join to YouTube ─────────────────────────────────────────────────────────
  const vodIds = [...new Set(deduped.map((l) => l.videoId))];
  console.log(`\n▶ Fetching YouTube metadata for ${vodIds.length} source VOD(s)…`);
  const vods = await fetchVideoMetadataWithUploader(vodIds, CH.key);
  const missingVods = vodIds.filter((id) => !vods.has(id));
  if (missingVods.length) {
    // Reported, never silent. A VOD that has gone private or been deleted takes
    // its matches with it, and that is a fact about the corpus, not noise.
    console.log(`  ⚠ ${missingVods.length} VOD(s) no longer resolve (private/deleted):`);
    for (const id of missingVods) {
      const n = deduped.filter((l) => l.videoId === id).length;
      const tag = deduped.find((l) => l.videoId === id)?.e.tag ?? '?';
      console.log(`      ${id}  ${n} match(es)  [${tag}]`);
    }
  }

  const chaptersByVod = new Map<string, Chapter[]>();
  for (const [id, v] of vods) chaptersByVod.set(id, chaptersOf(v.description));

  const records: TheaterRawRecord[] = [];
  for (const { e, videoId, startSeconds } of deduped) {
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

  // ── the floor, on a FULL sweep only ─────────────────────────────────────────
  // A cursor run's dump is a DELTA and is legitimately tiny — often empty — so
  // "materially smaller than the pin" means nothing there; parse.ts merges it
  // add-only and that is what does the protecting. A FULL sweep is different: it
  // CLAIMS to be the whole catalogue, so a collapse in it is a claim that most of
  // the catalogue is gone.
  //
  // The shape this guards against is not hypothetical. `records` is filtered by
  // the per-entry game gate above, and that gate compares against a string the
  // catalogue controls: the day "2XKO" is renamed upstream, `rightGame` is 0,
  // `records` is 0, and the old code wrote `[]` over a good dump without comment.
  // Downstream that reads as n → 0 and trips the collapse guard, so the cron goes
  // red for a reason nothing in the failure names. Refuse here, where the cause
  // is visible and can be named.
  if (FULL) {
    const pins = await readFile(join(ROOT, 'data', 'source-pins.json'), 'utf8')
      .then((t) => JSON.parse(t) as Record<string, number>)
      .catch(() => ({}) as Record<string, number>);
    const pinned = pins[CH.key] ?? 0;
    if (pinned > 0 && records.length < pinned * 0.9) {
      console.error(
        [
          `\n✖ A full sweep produced ${records.length} record(s) against a committed pin of ${pinned}.`,
          `  That is a claim that ${pinned - records.length} tournament matches left the catalogue at once.`,
          ``,
          `  The likeliest cause is not deletion. Every entry is checked against`,
          `  game ${JSON.stringify(WANT_GAME)}, and ${wrongGame.length} of ${catalogue.length} entr(ies) failed that check this`,
          `  run — if the catalogue renamed the game, every row fails and this file`,
          `  would be overwritten with almost nothing.`,
          ``,
          `  Refusing to write. The committed records are untouched and the next parse`,
          `  carries them exactly as it does on a day this never ran.`,
          `  If the drop is real: npm run data:theater -- --full --allow-shrink`,
        ].join('\n'),
      );
      if (!argv.includes('--allow-shrink')) process.exit(1);
    }
  }

  await writeFile(OUT, JSON.stringify(records, null, 2) + '\n', 'utf8');

  // ── the witness ─────────────────────────────────────────────────────────────
  // EVERY entry the run saw, tagged and untagged, in the catalogue's own shape.
  // The untagged remainder is online ranked play and is out of INGESTION scope by
  // design — but it is not out of scope as EVIDENCE: those rows carry a second
  // reading of players and champions for videos this repo may already publish
  // from a tracked channel, which is an independent check on our own title
  // parser. Written SEPARATELY from the intake dump because parse.ts builds one
  // record per row of raw/replayTheater.json: an untagged row landing there would
  // publish online ranked play as a tournament match. Nothing reads this yet.
  await writeFile(
    WITNESS,
    JSON.stringify(
      {
        mode: CURSOR_MODE ? 'cursor' : 'full',
        maxEntryId,
        pagesRead,
        hitBound,
        // BEHIND THE PER-ENTRY GAME GATE, not the raw catalogue. The gate is this
        // intake's only real defence against a response that is not what was asked
        // for, and the witness has to sit behind it too — it feeds a comparison
        // whose whole claim is that it is reading THIS game.
        //
        // Not hypothetical. On 2026-08-31 a `--full` sweep in tokon-replay-database
        // resumed from a partial cache left over from an era when this endpoint
        // returned everything, and wrote 15,286 Street Fighter 6 rows into a
        // 266-entry Tokon witness. The intake was untouched — the gate did its job
        // there — but the witness was 98% another game, and nothing downstream
        // would have said so.
        entries: rightGame,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  await writeFile(
    STATS,
    JSON.stringify(
      {
        // THE MODE IS LOAD-BEARING, not a diagnostic. parse.ts reads it to decide
        // whether this dump is the whole catalogue or a delta, which decides
        // whether "committed but absent from the dump" means "vanished upstream"
        // or "simply not in the pages we read".
        mode: CURSOR_MODE ? 'cursor' : 'full',
        maxEntryId,
        pagesRead,
        hitBound,
        catalogue: catalogue.length,
        rightGame: rightGame.length,
        tagged: tagged.length,
        collapsed,
        collapsedTags: Object.fromEntries(collapsedTags),
        unresolvableVods: missingVods.length,
        records: records.length,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // The resume cache existed to make a 71-page sweep restartable, and it records
  // page NUMBERS against a catalogue that grows at the FRONT — so a second local
  // run refetched page 1 and skipped 2..N as "seen", making anything past the
  // first 50 new entries invisible until someone remembered --fresh. The cursor
  // is the resume mechanism now, and two that can disagree are worse than one, so
  // a successful run clears it.
  if (existsSync(PARTIAL)) await rm(PARTIAL, { force: true });

  console.log(
    `\n  → wrote raw/replayTheater.json (${records.length} record(s)${CURSOR_MODE ? ', a delta' : ''})`,
  );
  // REPORTS WHAT WAS WRITTEN, not what was pulled. The witness is written from
  // `rightGame` — the per-entry game gate is upstream of it, deliberately — so
  // logging `catalogue.length` here overstated it by every wrong-game row, which
  // is precisely the number the gate exists to keep out and precisely the number
  // the tokon incident above would have needed this line to show.
  console.log(
    `  → wrote raw/replayTheater.witness.json (${rightGame.length} ${WANT_GAME} entr(ies) of ${catalogue.length} pulled)`,
  );

  // ── reconnaissance ──────────────────────────────────────────────────────────
  // A cursor run that found nothing tagged is the ORDINARY case now — tagged rows
  // were 899 of the catalogue's 3,547 at first ingest, and a quiet day has none.
  // Everything below reads `records[0]`-shaped things (date range, per-VOD
  // min/median/max), so on an empty delta it would print a page of `undefined`
  // and teach the reader to skim the cron log.
  if (records.length === 0) {
    console.log(
      `\n✔ Stage 1 (index) complete — no tagged tournament matches in this ${CURSOR_MODE ? 'delta' : 'sweep'}.`,
    );
    console.log('  The committed catalogue is carried unchanged. Next: npm run data:parse');
    return;
  }

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

// Diff data/patchBoundaries.json against Riot's own game-updates listing.
//
// WHY THIS EXISTS. Nothing checked this table against its source. The JSON's
// own header says "author from Riot's game-updates page", scripts/patches.ts
// validates the SHAPE of what was authored (ISO dates, release order, season
// nesting), and no offline rule can tell a typo'd day or a patch nobody added
// from a correct row. The 2026-09-02 refresh found sibling tables months stale
// with every offline check green. This reads the page and says what the table
// is missing, in the table's own grammar: a row per patch, hotfixes folded
// into the parent row's `includes`.
//
// THE SOURCE IS __NEXT_DATA__, NEVER THE DOM. The page is Next.js and carries
// its whole archive — 62 items back to 2024-03 — in one embedded script tag,
// no pagination. The rendered DOM holds 12 of them and reveals the rest
// client-side, so a DOM scraper would stop at 2026-04, miss every older patch,
// and report that as clean. There is no RSS; the _next/data route changes id
// on every deploy; the publishing API needs credentials. scripts/riot-site.ts
// reads the HTML route the same way for the roster.
//
// SET MEMBERSHIP, NOT DATE EQUALITY. Riot posts the evening before: on 6 of
// the 15 patch posts publishedAt is a day early, and the title's parenthetical
// is the announcement date (1.2.1 says "May 11"; the body says "drops May 12",
// and May 12 is right). So rows are matched by version, and a row's date is
// checked against the best evidence the post offers: the body's "drops/starts
// <Month> <D>" phrase exactly when there is one, otherwise publishedAt with a
// day either side. A version's first post is its base article; later posts
// for the same version are hotfixes and must appear in the parent row's
// `includes` by token or month/day. Riot skips numbers (no 1.0.2, 1.1.4,
// 1.2.2, 1.2.4), so a gap in the sequence is never a finding.
//
// A PATCH TITLE THIS CANNOT READ IS A HARD FAILURE (Tōkon's lesson: titles
// skipped in silence printed a tick over two missing patches). So is a feed
// far smaller than the archive: the page's shape changed, and nothing this
// would print afterwards is trustworthy.
//
// NETWORK, MANUAL, NEVER IN THE CRON. A Riot outage is not a data error and
// must not redden a refresh that produced correct data: it prints "NOT
// verified" and exits 0. Drift and unreadable input exit 1. The last line is
// always the machine-readable trailer, for the workspace-level wrapper.
//
// Run: npm run data:patch-check

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PatchBoundary } from '../types/index';
import { blades, fetchText, nextData } from './riot-site';

const PAGE = process.env.PATCH_CHECK_URL ?? 'https://2xko.riotgames.com/en-us/news/game-updates/';
/** Only posts on the site itself; half the listing is absolute YouTube links. */
const GAME_UPDATES = '/en-us/news/game-updates/';

/** Anything Riot titles like a patch. Checked alongside the tag, because the
 *  tag alone misses two real hotfixes (1.1.5 Apr 28, 1.0.1.2 Nov 4). */
const PATCH_TITLE = /patch notes|hotfix|patch \d/i;
const PATCH_TAG = 'patch_notes';
/** The version token as titles, `includes` strings and post bodies carry it:
 *  1.2.5, 1.0.1.2, 1.2.3b. */
export const VERSION = /\b(\d+\.\d+\.\d+(?:\.\d+)?[a-z]?)\b/;
/** The one reliable date in a post: "Patch 1.2.5 drops July 23",
 *  "Season 1 starts Jan 20". */
const PHRASE = /(?:drops|starts)\s+(?:on\s+)?([A-Z][a-z]+)\s+(\d{1,2})/;
/** A month/day inside an includes string or a title: "Apr 28 hotfix",
 *  "Dec 1 hotfix", "1.2.3b (Jul 8)", "(Dec  1, 2025)". */
const MONTH_DAY = /\b([A-Z][a-z]{2,})\.?\s+(\d{1,2})\b/g;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Below these the page's shape changed (62 items and 15 patch posts today).
 *  A smaller feed must fail, not report every older patch as invented. */
export const FLOORS = { items: 40, patchItems: 12 };

export interface RiotItem {
  title: string;
  /** ISO UTC, as the page model carries it */
  publishedAt: string;
  /** site-relative for posts, absolute for the YouTube links */
  url: string;
  /** tag machine names, e.g. patch_notes */
  tags: string[];
  /** the card's blurb — where "drops <Month> <D>" lives */
  body: string;
}

export interface Finding {
  /** + upstream-only · ~ date differs · - ours-only · ⚠ unrecorded hotfix · ⓘ informational */
  glyph: '+' | '~' | '-' | '⚠' | 'ⓘ';
  /** the version the finding is about, or 'feed' */
  about: string;
  text: string;
}

/** Everything but ⓘ fails the run. */
export const fatal = (f: Finding): boolean => f.glyph !== 'ⓘ';

export interface Summary {
  items: number;
  patchItems: number;
  versions: number;
  /** newest publishedAt across every item, patch or not */
  newestPost: string;
  rows: number;
  newestRow: string;
}

interface Options {
  floors?: { items: number; patchItems: number };
  now?: Date;
}

// ── the page model → items ───────────────────────────────────────────────────

/** The listing's items, all of them, from the embedded page model. Throws when
 *  the grid or the item shape is not what this was written against. */
export function parseRiot(data: unknown): RiotItem[] {
  const grid = blades(data).find((b) => b?.type === 'articleCardGrid');
  if (!grid) throw new Error('no articleCardGrid blade in __NEXT_DATA__ — the page model changed');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = Array.isArray(grid.items) ? grid.items : [];
  if (raw.length === 0) throw new Error('articleCardGrid carries no items');
  return raw.map((it, i) => {
    const title = typeof it?.title === 'string' ? it.title : '';
    const publishedAt = typeof it?.publishedAt === 'string' ? it.publishedAt : '';
    if (!title || !/^\d{4}-\d{2}-\d{2}T/.test(publishedAt))
      throw new Error(`item ${i + 1} has no title or publishedAt — the item shape changed`);
    return {
      title,
      publishedAt,
      url: typeof it.action?.payload?.url === 'string' ? it.action.payload.url : '',
      tags: (Array.isArray(it.tags) ? it.tags : []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (t: any) => String(t?.machineName ?? ''),
      ),
      body: typeof it.description?.body === 'string' ? it.description.body : '',
    };
  });
}

// ── dates ────────────────────────────────────────────────────────────────────

const day = (iso: string): string => iso.slice(0, 10);
const pad2 = (n: number): string => String(n).padStart(2, '0');
/** ISO day ± n, by Date arithmetic so Jan 31 + 1 is Feb 1. */
function shift(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const monthIndex = (name: string): number => MONTHS.indexOf(name.slice(0, 3).toLowerCase());
/** Riot posts the evening before, and a Pacific evening is the next UTC day. */
const withinADay = (start: string, pubDay: string): boolean =>
  start >= shift(pubDay, -1) && start <= shift(pubDay, 1);

/** The release day the post's own body states, with the phrase it came from,
 *  or null when it has none. The first phrase whose month parses wins: a blurb
 *  can say "starts Season 3" before "drops July 23", and a leading non-month
 *  must not hide the real one. The year is the post's, plus one for a December
 *  post announcing January. */
function phraseDate(it: RiotItem): { day: string; phrase: string } | null {
  for (const m of it.body.matchAll(new RegExp(PHRASE.source, 'g'))) {
    const month = monthIndex(m[1]!);
    if (month < 0) continue;
    const pub = new Date(it.publishedAt);
    let year = pub.getUTCFullYear();
    if (month < pub.getUTCMonth() - 6) year += 1;
    return { day: `${year}-${pad2(month + 1)}-${pad2(Number(m[2]))}`, phrase: m[0] };
  }
  return null;
}

/** First month/day in a string, month as a 0-based index. */
function monthDay(s: string): { month: number; d: number } | null {
  for (const m of s.matchAll(MONTH_DAY)) {
    const month = monthIndex(m[1]!);
    if (month >= 0) return { month, d: Number(m[2]) };
  }
  return null;
}

/** Does the string's month/day fall within a day of the post's publication?
 *  No year in an includes string, so only month and day are compared. */
function monthDayMatches(s: string, publishedAt: string): boolean {
  const md = monthDay(s);
  if (!md) return false;
  const pubDay = day(publishedAt);
  return [-1, 0, 1].some((k) => {
    const c = new Date(`${shift(pubDay, k)}T00:00:00Z`);
    return c.getUTCMonth() === md.month && c.getUTCDate() === md.d;
  });
}

/** Every version token in a string ("Read about patches 1.0.1 and 1.0.1.1"). */
const tokens = (s: string): string[] =>
  [...s.matchAll(new RegExp(VERSION.source, 'g'))].map((m) => m[1]!);

/** 1.0.1.1 and 1.2.3b are sub-versions of 1.0.1 and 1.2.3; 1.0.12 is not. */
const isSubVersion = (version: string, parent: string): boolean =>
  version.startsWith(parent) && /^(?:\.\d+|[a-z])$/.test(version.slice(parent.length));

/** The includes string a hotfix post would be recorded as. */
function suggestedInclude(hf: RiotItem): string {
  const md = monthDay(hf.title) ?? {
    month: new Date(hf.publishedAt).getUTCMonth(),
    d: new Date(hf.publishedAt).getUTCDate(),
  };
  const mon = MONTHS[md.month]!;
  return `${mon[0]!.toUpperCase()}${mon.slice(1)} ${md.d} hotfix`;
}

// ── the diff ─────────────────────────────────────────────────────────────────

/** Diff the table's `patches` against the listing's items. Throws when a
 *  patch-titled post carries no version, or the feed is under the floors. */
export function diffTwoXko(
  table: PatchBoundary[],
  items: RiotItem[],
  opts: Options = {},
): { findings: Finding[]; summary: Summary } {
  const floors = opts.floors ?? FLOORS;
  const now = opts.now ?? new Date();
  if (items.length < floors.items)
    throw new Error(
      `only ${items.length} item(s) in the listing (floor ${floors.items}) — the archive is no longer in one page`,
    );

  // which posts are patches, and their version
  type PatchPost = RiotItem & { version: string };
  const patchPosts: PatchPost[] = [];
  for (const it of items) {
    if (!it.url.startsWith(GAME_UPDATES)) continue;
    if (!PATCH_TITLE.test(it.title) && !it.tags.includes(PATCH_TAG)) continue;
    const version = VERSION.exec(it.title)?.[1];
    if (!version)
      throw new Error(
        `patch post with no version in its title: ${JSON.stringify(it.title)} (${it.url})`,
      );
    patchPosts.push({ ...it, version });
  }
  if (patchPosts.length < floors.patchItems)
    throw new Error(
      `only ${patchPosts.length} patch post(s) in the listing (floor ${floors.patchItems}) — the title or tag grammar changed`,
    );

  // group by version in publication order: first post is the base article,
  // every later one is a hotfix. Ordering by publication, not by the table's
  // start, keeps the diagnosis independent of the date being checked.
  const groups = new Map<string, PatchPost[]>();
  for (const p of [...patchPosts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    groups.set(p.version, [...(groups.get(p.version) ?? []), p]);
  }

  const findings: Finding[] = [];
  const rows = new Map(table.map((r) => [r.version, r]));
  const baseOf = new Map<string, PatchPost>();
  const matchedIncludes = new Set<string>();
  const incKey = (row: PatchBoundary, inc: string) => `${row.version} ${inc}`;

  // a row's date against its base article
  const checkDate = (row: PatchBoundary, base: PatchPost): void => {
    const phrase = phraseDate(base);
    if (phrase) {
      if (phrase.day !== row.start)
        findings.push({
          glyph: '~',
          about: row.version,
          text: `${row.version} — we say ${row.start}, Riot's post says ${phrase.day} (${JSON.stringify(phrase.phrase)})`,
        });
      return;
    }
    const pub = day(base.publishedAt);
    if (!withinADay(row.start, pub))
      findings.push({
        glyph: '~',
        about: row.version,
        text: `${row.version} — we say ${row.start}, Riot posted it ${pub} (no release phrase in the post; a day either side is normal)`,
      });
  };

  // a hotfix post against its parent row's includes: by token or month/day
  const checkHotfix = (row: PatchBoundary, hf: PatchPost): void => {
    // the post's own version is not evidence: every later post for 1.2.3b
    // carries "1.2.3b" by construction, and the includes token the version
    // folded by is that same string, so it would match them all
    const hfTokens = tokens(hf.title).filter((t) => t !== hf.version);
    for (const inc of row.includes ?? []) {
      // one string records one hotfix. Posts arrive in publication order, so
      // the earlier of two adjacent-day hotfixes takes "Dec 1 hotfix" and the
      // later one cannot ride on it under the ±1 rule.
      if (matchedIncludes.has(incKey(row, inc))) continue;
      if (tokens(inc).some((t) => hfTokens.includes(t)) || monthDayMatches(inc, hf.publishedAt)) {
        matchedIncludes.add(incKey(row, inc));
        return;
      }
    }
    findings.push({
      glyph: '⚠',
      about: row.version,
      text:
        `${row.version} — unrecorded hotfix ${JSON.stringify(hf.title)}, posted ${day(hf.publishedAt)}\n` +
        `    add "${suggestedInclude(hf)}" to the row's includes`,
    });
  };

  for (const [version, group] of groups) {
    const [base, ...hotfixes] = group as [PatchPost, ...PatchPost[]];
    const row = rows.get(version);
    if (row) {
      baseOf.set(version, base);
      checkDate(row, base);
      for (const hf of hotfixes) checkHotfix(row, hf);
      continue;
    }
    // folded: some row's includes names this version ("1.2.3b (Jul 8)")
    const byInclude = table.find((r) =>
      (r.includes ?? []).some((inc) => tokens(inc).includes(version)),
    );
    if (byInclude) {
      for (const inc of byInclude.includes ?? [])
        if (tokens(inc).includes(version)) matchedIncludes.add(incKey(byInclude, inc));
      for (const hf of hotfixes) checkHotfix(byInclude, hf);
      continue;
    }
    // folded: a row's base article names a sub-version of itself in its body
    // (1.0.1's names 1.0.1.1). Sub-versions only: Riot's blurbs name several
    // versions at once, and one that names the NEXT patch must not swallow
    // that patch's row.
    const byBody = table.find((r) => {
      const b = groups.get(r.version)?.[0];
      return (
        b !== undefined && isSubVersion(version, r.version) && tokens(b.body).includes(version)
      );
    });
    if (byBody) {
      for (const hf of hotfixes) checkHotfix(byBody, hf);
      continue;
    }
    // new to us. Row or includes is the human's call: the table gave 1.0.1.2 a
    // row and folded 1.0.1.1, and nothing in the post says which this is.
    const posted = day(base.publishedAt);
    const start = phraseDate(base)?.day ?? posted;
    const parent = table.filter((r) => r.start <= shift(posted, 1)).at(-1);
    findings.push({
      glyph: '+',
      about: version,
      text:
        `${version} (${start}) — on Riot's game-updates page, missing from patchBoundaries.json\n` +
        `    { "version": "${version}", "start": "${start}" }\n` +
        `    or fold into ${parent ? `${parent.version}'s` : "the parent row's"} includes if it is a hotfix` +
        (hotfixes.length ? `\n    (${hotfixes.length} later post(s) for the same version)` : ''),
    });
  }

  // reverse: every row needs a base article; includes are documentation only
  for (const row of table) {
    if (!groups.has(row.version)) {
      if (row.todo)
        findings.push({
          glyph: 'ⓘ',
          about: row.version,
          text: `${row.version} (${row.start}) — no Riot post yet; authored ahead (todo: ${row.todo})`,
        });
      else
        findings.push({
          glyph: '-',
          about: row.version,
          text: `${row.version} (${row.start}) — in patchBoundaries.json, on no Riot post (invented?)`,
        });
    }
    const base = baseOf.get(row.version);
    const bodyTokens = base ? tokens(base.body) : [];
    for (const inc of row.includes ?? []) {
      if (matchedIncludes.has(incKey(row, inc))) continue;
      if (tokens(inc).some((t) => bodyTokens.includes(t))) continue;
      findings.push({
        glyph: 'ⓘ',
        about: row.version,
        text: `${row.version} includes "${inc}" — no Riot post matches it (documentation only; fine if it was announced elsewhere)`,
      });
    }
  }

  // the feed's own age. Riot goes quiet between acts and ends active
  // development in December, so "no drift" and "feed went dark" look alike.
  const newestPost = items
    .map((i) => i.publishedAt)
    .sort()
    .at(-1)!;
  const ageDays = Math.floor((now.getTime() - new Date(newestPost).getTime()) / 86_400_000);
  findings.push({
    glyph: 'ⓘ',
    about: 'feed',
    text: `feed: newest post ${day(newestPost)}, ${ageDays} days ago — a quiet feed and a dark one look alike`,
  });

  const newest = table.at(-1);
  return {
    findings,
    summary: {
      items: items.length,
      patchItems: patchPosts.length,
      versions: groups.size,
      newestPost,
      rows: table.length,
      newestRow: newest ? `${newest.version} (${newest.start})` : 'none',
    },
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

/** The one network call. Anything it throws is "cannot verify", never drift. */
async function upstream(): Promise<string> {
  return fetchText(PAGE);
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  // the JSON directly, not loadPatchTable(): that exits on a shape error, and
  // a malformed table is the validator's finding, not drift
  const { patches } = JSON.parse(readFileSync(join(root, 'data/patchBoundaries.json'), 'utf8')) as {
    patches: PatchBoundary[];
  };

  const html = await upstream().catch((err: unknown) => {
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`⚠ patch table NOT verified — ${reason}${cause ? ` (${cause})` : ''}`);
    return null;
  });
  if (html === null) {
    console.log('patch-check: UNVERIFIED');
    process.exit(0);
  }

  let result: { findings: Finding[]; summary: Summary };
  try {
    result = diffTwoXko(patches, parseRiot(nextData(html)));
  } catch (err) {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    console.error('  Refusing to report on the rest. A post this script cannot read is');
    console.error('  indistinguishable from a patch that never shipped; teach the parser first.');
    console.log('patch-check: UNREADABLE');
    process.exit(1);
  }

  const { findings, summary } = result;
  const drift = findings.filter(fatal);
  const info = findings.filter((f) => !fatal(f));
  console.log(
    `upstream: ${summary.items} items on Riot's game-updates page, ${summary.patchItems} patch posts over ${summary.versions} versions, newest post ${day(summary.newestPost)}`,
  );
  console.log(`table:    ${summary.rows} rows, newest ${summary.newestRow}\n`);
  for (const f of info) console.log(`  ${f.glyph} ${f.text}`);
  if (info.length) console.log('');

  if (drift.length === 0) {
    console.log(`✓ patch table matches Riot's game-updates page — ${summary.rows} rows`);
    console.log('\npatch-check: CURRENT');
    process.exit(0);
  }
  console.error(`✖ patch table has drifted from Riot's game-updates page (${drift.length}):\n`);
  for (const f of drift) console.error(`  ${f.glyph} ${f.text}`);
  console.error(
    '\nEdit data/patchBoundaries.json (rows in release order, hotfixes in the parent\n' +
      "row's includes), then `npm run data:parse` — patchVersion is stored on each\n" +
      'record at parse time, so `data:emit` alone leaves every replay filed as before.\n',
  );
  console.log('patch-check: DRIFT');
  process.exit(1);
}

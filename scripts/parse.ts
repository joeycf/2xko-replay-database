// Stage 2: parse the raw dumps into structured VideoRecords, aggregate stats,
// write a report, and auto-append newly discovered players to the registry.
//
// Run: npm run data:parse   (tsx scripts/parse.ts)
//
// Confirmed decisions (Stage-1 gate, revised for patch-level filtering):
//  • Prefix strip widened to /^2XKO[^▰]*▰\s*/i  (handles "2XKO Season 2 ▰", "2XKO 🇯🇵 ▰").
//  • Season AND patchVersion: derived from publishedAt against the boundary
//    authority (scripts/patches.ts — see its header for the Riot replay-expiry
//    accuracy basis). The description "(Season N)" label no longer derives:
//    channels proved unreliable (they branded patch 1.2.1 "Season 2" a month
//    early, and left "Season 1" boilerplate running well into S2). The label
//    survives only as (a) a 2-day boundary grace — an explicit PRIOR-season
//    label within 2 days after a season start is upload-lagged prior-season
//    footage (Riot expires replays at every patch change, so it can't be
//    anything else) — and (b) a report diagnostic counting stale labels.
//  • Champions: exact alias → word-contains (tag balance notes) → Damerau/OSA ≤1 (low conf).

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, CHAR_SEP, PLAYER_SEP, THEATER_SPONSOR } from './channels';
import { applyExclusions, emitGeneric } from './emit';
import { loadPatchTable } from './patches';
import type {
  Champion,
  ChannelKey,
  Fuse,
  FuseDetection,
  ManualVideoEntry,
  ManualVideosFile,
  MatchType,
  ParseConfidence,
  Player,
  RawVideoRecord,
  Team,
  TeamSide,
  TheaterRawRecord,
  VideoRecord,
} from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const RAW = join(ROOT, 'raw');

// ── generic helpers ───────────────────────────────────────────────────────────
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const slugify = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Optimal String Alignment (Damerau–Levenshtein w/ adjacent transpositions). */
function osaDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

// ── load registries + raw + config ────────────────────────────────────────────
// Registries are the ENGINE-GENERIC arrays (Phase 3); the parser indexes them
// by id internally and writes players back as an array at the end.
const characterList = await readJson<Champion[]>(join(DATA, 'characters.json'));
const champions: Record<string, Champion> = Object.fromEntries(characterList.map((c) => [c.id, c]));
const playerList = await readJson<Player[]>(join(DATA, 'players.json'));
const players: Record<string, Player> = Object.fromEntries(playerList.map((p) => [p.id, p]));
const fuses = await readJson<Record<string, Fuse>>(join(DATA, 'fuses.json'));
// season + patch boundary authority (validates both files; hard-exits on drift)
const patchTable = loadPatchTable(DATA);
// overrides may also EXCLUDE a record outright ({ "exclude": true } — e.g. a
// stray non-2XKO upload a tracked channel published); applied after the manual
// merge, before stats/writes/emit.
const overrides = await readJson<Record<string, Partial<VideoRecord> & { exclude?: boolean }>>(
  join(DATA, 'overrides.json'),
);
// Hand-authored records (tournament VODs etc.) — validated + merged in below.
// A malformed file must fail the run loudly, so no .catch here.
const manualEntries: ManualVideoEntry[] =
  (await readJson<ManualVideosFile>(join(DATA, 'manual-videos.json'))).videos ?? [];
// CV fuse detections live in their own committed artifact (scripts/fuses.ts,
// local-only) so they survive the daily regeneration of videos.json.
const fusesDetected: Record<string, FuseDetection> = await readJson<Record<string, FuseDetection>>(
  join(DATA, 'fuses-detected.json'),
).catch(() => ({}));

const rawRecords: RawVideoRecord[] = [];
const rawPaths: string[] = [];
/** The index source's dump, when present. Kept OUT of `rawRecords` because its
 *  records are not built by a title parse — see buildTheaterRecords. */
let theaterRaw: TheaterRawRecord[] = [];
/** Local-first sources whose dump is absent on this run, so their committed
 *  records are carried instead of rebuilt. On the daily cron this is all of
 *  them, every time — raw/ is gitignored and the cron never fetches them. */
const carriedLocalFirst: ChannelKey[] = [];

for (const key of Object.keys(CHANNELS) as ChannelKey[]) {
  const ch = CHANNELS[key];
  // A frozen channel is not fetched, so it has no dump to require. Its records
  // are carried from the committed catalogue just below.
  if (ch.frozen) continue;
  const p = join(RAW, `${key}.json`);
  if (!existsSync(p)) {
    // A LOCAL-FIRST source legitimately has no dump here. That is the normal
    // state on the cron, not an error: carry its committed records the same way
    // a frozen channel's are carried. Requiring the dump would break the daily
    // build; parsing without it would delete every one of its records.
    if (ch.localFirst) {
      carriedLocalFirst.push(key);
      continue;
    }
    console.error(
      `✖ raw/${key}.json missing — run \`npm run data:fetch\` first (or \`npm run data:build\`).`,
    );
    process.exit(1);
  }
  rawPaths.push(p);
  if (ch.index) {
    // Structured at source: players, champions, event tag and a start offset are
    // separate fields, so there is no title to parse. Built by its own function.
    theaterRaw = await readJson<TheaterRawRecord[]>(p);
    continue;
  }
  rawRecords.push(...(await readJson<RawVideoRecord[]>(p)));
}

// ── source pins (data/source-pins.json) ───────────────────────────────────────
// The carry pin for local-first sources. A frozen channel pins its count as a
// constant in channels.ts because that count never changes again; a local-first
// source GROWS, so hand-editing a constant on every refresh would be friction
// that teaches you to ignore it. The local fetch-and-parse writes this file; a
// carrying run asserts against it. Same guarantee, no hand-edited number.
const PINS = join(DATA, 'source-pins.json');
const sourcePins: Record<string, number> = await readJson<Record<string, number>>(PINS).catch(
  () => ({}),
);

// ── frozen channels: carry the committed records forward ──────────────────────
// A frozen channel publishes this game no longer, but the matches it published
// are real and its videos still play. Rather than let them be pruned, the last
// good catalogue is the source: these records skip buildRecord (there is no raw
// to build from) and rejoin the pipeline at the merge stage, so fuse detections
// and overrides still reach them. See scripts/channels.ts for why proReplays is
// frozen, and the channel-collapse guard below for what happens without this.
const frozenKeys = (Object.keys(CHANNELS) as ChannelKey[]).filter((k) => CHANNELS[k].frozen);
// Both kinds of carry read the same committed catalogue and take the same pin
// treatment; they differ only in where the expected number lives.
const carriedKeys: ChannelKey[] = [...frozenKeys, ...carriedLocalFirst];
const committedAll =
  carriedKeys.length > 0
    ? await readJson<VideoRecord[]>(join(DATA, 'videos.json')).catch(() => [] as VideoRecord[])
    : [];
const carriedRecords: VideoRecord[] = committedAll.filter((v) =>
  carriedKeys.includes(v.channel as ChannelKey),
);
// The two kinds of carry rejoin the pipeline at DIFFERENT points, and conflating
// them is a real bug rather than a tidiness question.
//
// A frozen channel's records were built by a title parse and take the full
// curation merge, overrides included — that is how a hand correction still
// reaches a channel nobody fetches any more.
//
// A local-first source's records were NOT built by a title parse. On a rebuild
// they take the narrow merge (fuse column only), exactly as manual records do,
// so a stale verdict can never rewrite a title, an event or a champion. If the
// carry took the full merge instead, the SAME record would obey different rules
// depending on whether raw/ happened to be present — the cron and a local run
// would publish different bytes from identical inputs.
const carriedFrozen = carriedRecords.filter((v) => CHANNELS[v.channel as ChannelKey]?.frozen);
const carriedLocalFirstRecords = carriedRecords.filter(
  (v) => !CHANNELS[v.channel as ChannelKey]?.frozen,
);
for (const key of carriedKeys) {
  const frozen = CHANNELS[key].frozen;
  const want = frozen ? frozen.records : sourcePins[key];
  const got = carriedRecords.filter((v) => v.channel === key).length;
  const kind = frozen ? 'Frozen channel' : 'Local-first source';
  const fix = frozen
    ? 'update frozen.records in scripts/channels.ts'
    : `run \`npm run data:theater\` then \`npm run data:parse\` to rebuild and re-pin, or edit data/source-pins.json`;
  // A local-first source with no pin yet is its FIRST carry — that only happens
  // if someone commits records without the pin file, which the parse below
  // always writes. Treat a missing pin as a hard error rather than silently
  // accepting whatever is in videos.json, because "no expectation" is exactly
  // the state this guard exists to prevent.
  if (want === undefined) {
    console.error(
      [
        `✖ ${kind} "${key}" carried ${got} record(s) but data/source-pins.json has no pin for it.`,
        `  The carry has nothing to check itself against, which is the state the pin exists to`,
        `  prevent. Run \`npm run data:theater && npm run data:parse\` to build from the dump and`,
        `  write the pin.`,
      ].join('\n'),
    );
    process.exit(1);
  }
  // THE PIN. data/videos.json is both the source and the target of this carry, so
  // a run that dropped records would poison the next run's reference permanently
  // and silently. Any drift stops the pipeline; a deliberate prune means editing
  // the number, which shows up in review.
  if (got !== want) {
    console.error(
      [
        `✖ ${kind} "${key}" carried ${got} record(s), expected ${want}.`,
        `  data/videos.json is both the source and the target of this carry, so drift here`,
        `  compounds: the next run would treat ${got} as the new baseline.`,
        `  If the change is deliberate, ${fix}.`,
      ].join('\n'),
    );
    process.exit(1);
  }
}

// A carried record never passes through buildRecord, so it never lands in
// lowReports — but the report's Summary counts low-confidence records from
// `records`, which does include it. Without this the report reads "Low
// confidence: 12" above a table headed "Low-confidence records (2)", the exact
// desync the comment above that table exists to prevent. The original per-record
// reasons are not retained in videos.json, so say so rather than invent them.
const carriedLow: { id: string; channel: ChannelKey; title: string; reasons: string[] }[] =
  carriedRecords
    .filter((v) => v.parseConfidence === 'low')
    .map((v) => ({
      id: v.id,
      channel: v.channel as ChannelKey,
      title: v.title,
      reasons: [
        CHANNELS[v.channel as ChannelKey]?.frozen
          ? 'carried from a frozen channel — original parse reasons not retained'
          : 'carried from a local-first source — original parse reasons not retained',
      ],
    }));

// ── stale-raw guard ───────────────────────────────────────────────────────────
// Daily refreshes are committed by the remote cron, so this machine's gitignored
// raw/ can lag the committed videos.json — a bare parse would then silently
// regress it (observed 2026-07-06: 2,847 → 2,825). Refuse when the existing
// videos.json holds ids the dumps lack AND the dumps predate its last commit.
// Fresh dumps missing ids are legitimate (that's how deleted videos get pruned),
// and equal id sets (re-parse after an overrides/detections change) always pass.
if (!process.argv.includes('--allow-stale')) {
  const existing = await readJson<VideoRecord[]>(join(DATA, 'videos.json')).catch(
    () => [] as VideoRecord[],
  );
  // The index source's dump is read separately, so its ids must be unioned in
  // here or all 898 of them read as missing on a local run that DID fetch them.
  const rawIds = new Set([...rawRecords.map((r) => r.id), ...theaterRaw.map((r) => r.id)]);
  // manual-videos.json ids are never in the channel dumps — not a staleness signal
  const manualIds = new Set(manualEntries.map((e) => e.id));
  // Neither are a carried source's ids — frozen or local-first. They are
  // deliberately absent from raw/, so without this every one of them reads as a
  // staleness signal and this guard fires on every single run. That is how a
  // guard becomes a flag you learn to pass; the exclusion is load-bearing.
  const carriedIds = new Set(carriedRecords.map((v) => v.id));
  const missing = existing.filter(
    (v) => !rawIds.has(v.id) && !manualIds.has(v.id) && !carriedIds.has(v.id),
  );
  if (missing.length > 0) {
    let lastCommitMs: number | null = null;
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', 'data/videos.json'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (out) lastCommitMs = Number(out) * 1000;
    } catch {
      // no usable git history (CI shallow clone, tarball) — staleness can't be
      // proven, and those environments fetch first anyway; fall through
    }
    const rawMtimeMs = Math.max(...rawPaths.map((p) => statSync(p).mtimeMs));
    if (lastCommitMs !== null && rawMtimeMs < lastCommitMs) {
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      console.error(
        [
          `✖ Stale raw/ dumps: data/videos.json (last committed ${day(lastCommitMs)}) contains ${missing.length} video(s)`,
          `  missing from raw/*.json (fetched ${day(rawMtimeMs)}), e.g. ${missing[0].id}. The daily cron refreshes`,
          `  remotely, so local raw/ lags — parsing now would silently drop those videos.`,
          `  Run \`npm run data:fetch\` first (or \`npm run data:build\`); pass --allow-stale to override.`,
        ].join('\n'),
      );
      process.exit(1);
    }
  }
}

// ── channel-collapse guard ────────────────────────────────────────────────────
// The stale-raw guard above catches a raw/ that LAGS the catalogue. It cannot
// catch a raw/ that is fresh and SMALLER, because its second condition
// (rawMtimeMs < lastCommitMs) is false after any fetch — and its comment blesses
// that path: "fresh dumps missing ids are legitimate (that's how deleted videos
// get pruned)". True for a handful of deletions. Catastrophic for a channel that
// walks away.
//
// Observed 2026-08-08: the "2XKO Pro Replays" channel rebranded to MARVEL TOKON
// and unlisted its entire 2XKO back catalogue. The videos still exist and still
// play, but unlisted uploads leave the uploads playlist, so a fetch enumerated 7
// records where it had enumerated 1,317. A bare data:build would have rebuilt the
// catalogue at ~4,124 instead of 5,434 — a 24% loss — and committed it.
//
// COMPARING RAW AGAINST THE COMMITTED CATALOGUE IS SOUND because videos <= raw
// always holds for a fetched channel: videos.json is built FROM raw, minus
// exclusions and parse failures. So raw falling BELOW the committed video count
// is always real loss, never ordinary churn.
//
// TWO THRESHOLDS, BOTH REQUIRED. A percentage alone punishes a small channel for
// ordinary churn; an absolute alone misses a large channel bleeding slowly.
const COLLAPSE_PCT = 0.1; // >10% of the committed count
const COLLAPSE_ABS = 20; // AND >20 records
{
  const allowIdx = process.argv.indexOf('--allow-collapse');
  const allowed = new Set(
    allowIdx === -1 ? [] : (process.argv[allowIdx + 1] ?? '').split(',').map((x) => x.trim()),
  );
  const committed =
    committedAll.length > 0
      ? committedAll
      : await readJson<VideoRecord[]>(join(DATA, 'videos.json')).catch(() => [] as VideoRecord[]);
  if (committed.length > 0) {
    const countBy = (rs: { channel: string }[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of rs) m.set(r.channel, (m.get(r.channel) ?? 0) + 1);
      return m;
    };
    const before = countBy(committed);
    // theaterRaw is read outside rawRecords, so it has to be counted explicitly
    // or the index source reads as 898 → 0 on the very run that just fetched it.
    const now = countBy([...rawRecords, ...theaterRaw]);
    const collapsed: string[] = [];
    for (const key of Object.keys(CHANNELS) as ChannelKey[]) {
      // A FROZEN channel has no raw to compare — that is the whole point of
      // freezing one. A NEW channel has no committed history to fall from.
      if (CHANNELS[key].frozen) continue;
      // A CARRIED local-first source has no raw on this run BY DESIGN (every
      // cron run is one), so comparing against zero would fire the guard daily.
      // Its protection is the count pin above, which is strictly stronger: the
      // pin demands an exact number where this only demands "not much smaller".
      // Stated in report.md so the weaker coverage is visible, not assumed.
      if (carriedLocalFirst.includes(key)) continue;
      const was = before.get(key) ?? 0;
      if (was === 0) continue;
      const is = now.get(key) ?? 0;
      const lost = was - is;
      if (lost > COLLAPSE_ABS && lost / was > COLLAPSE_PCT) {
        collapsed.push(
          `  ${key}: ${was} → ${is}  (lost ${lost}, ${((lost / was) * 100).toFixed(1)}%)` +
            (allowed.has(key) ? '  [allowed]' : ''),
        );
      }
    }
    const blocking = collapsed.filter((l) => !l.endsWith('[allowed]'));
    if (collapsed.length > 0) console.error('Channel collapse detected:\n' + collapsed.join('\n'));
    if (blocking.length > 0) {
      console.error(
        [
          ``,
          `✖ Refusing to parse: a channel lost more than ${COLLAPSE_ABS} records AND more than`,
          `  ${COLLAPSE_PCT * 100}% of its committed count. videos.json is built from raw/, so this`,
          `  would publish the loss — silently, and the next run would treat it as the new normal.`,
          `  A channel can collapse because it was deleted, renamed, made private, or REBRANDED`,
          `  to another game and unlisted its back catalogue (observed 2026-08-08).`,
          ``,
          `  Retain the records:  mark the channel \`frozen\` in scripts/channels.ts`,
          `  Accept the prune:    npm run data:parse -- --allow-collapse ${blocking.map((l) => l.trim().split(':')[0]).join(',')}`,
        ].join('\n'),
      );
      process.exit(1);
    }
  }
}

// ── champion resolution ───────────────────────────────────────────────────────
const champByAlias = new Map<string, string>(); // aliasLower -> championId
const champAliases: { alias: string; id: string }[] = [];
for (const c of Object.values(champions)) {
  for (const a of new Set([c.name.toLowerCase(), ...c.extra.aliases.map((x) => x.toLowerCase())])) {
    champByAlias.set(a, c.id);
    champAliases.push({ alias: a, id: c.id });
  }
}

interface CharResult {
  id: string | null;
  confidence: ParseConfidence; // "low" only when fuzzy/unresolved
  notes: string[]; // balance descriptors, e.g. ["nerfed"]
  raw: string;
}

function resolveChampion(rawToken: string): CharResult {
  const token = rawToken.trim();
  const lower = token.toLowerCase();

  // 1. exact alias / canonical name
  const exact = champByAlias.get(lower);
  if (exact) return { id: exact, confidence: 'high', notes: [], raw: token };

  // 2. word-contains: a multi-word token carrying exactly one champion alias as a word
  //    e.g. "nerfed Ekko" → ekko (+ note "nerfed"), "adjusted Ahri" → ahri.
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length > 1) {
    const hits = uniq(words.map((w) => champByAlias.get(w)).filter((x): x is string => x != null));
    if (hits.length === 1) {
      const notes = words
        .filter((w) => !champByAlias.has(w))
        .filter((w) => w.length >= 3 && /^[a-z]+$/.test(w));
      return { id: hits[0], confidence: 'high', notes, raw: token };
    }
  }

  // 3. fuzzy fallback: Damerau/OSA ≤ 1 (guard against short-token noise)
  if (lower.length >= 3) {
    let best: { id: string; dist: number } | null = null;
    for (const { alias, id } of champAliases) {
      if (alias.length < 3) continue;
      const dist = osaDistance(lower, alias);
      if (dist <= 1 && (best === null || dist < best.dist)) best = { id, dist };
    }
    if (best) return { id: best.id, confidence: 'low', notes: [], raw: token };
  }

  // 4. unresolved
  return { id: null, confidence: 'low', notes: [], raw: token };
}

// ── player resolution (with auto-discovery) ───────────────────────────────────
const playerByAlias = new Map<string, string>(); // aliasLower -> playerId
for (const p of Object.values(players)) {
  playerByAlias.set(p.handle.toLowerCase(), p.id);
  for (const a of p.extra.aliases) playerByAlias.set(a.toLowerCase(), p.id);
}

interface Discovered {
  id: string;
  displayNames: Map<string, number>; // raw casing -> count
  aliases: Set<string>; // lowercased variants
  count: number;
}
const discovered = new Map<string, Discovered>(); // keyed by slug
const usedIds = new Set<string>(Object.keys(players));
const bestDisplay = (d: Discovered): string =>
  [...d.displayNames.entries()].sort((a, b) => b[1] - a[1])[0][0];

function resolvePlayer(rawName: string): { id: string; displayName: string } {
  const name = rawName.trim();
  const lower = name.toLowerCase();

  const known = playerByAlias.get(lower);
  if (known) return { id: known, displayName: players[known].handle };

  const slug = slugify(name) || 'player';
  let entry = discovered.get(slug);
  if (!entry) {
    let id = slug;
    for (let n = 2; usedIds.has(id); n++) id = `${slug}-${n}`; // avoid colliding with seed ids
    usedIds.add(id);
    entry = { id, displayNames: new Map(), aliases: new Set(), count: 0 };
    discovered.set(slug, entry);
  }
  entry.count++;
  entry.aliases.add(lower);
  entry.displayNames.set(name, (entry.displayNames.get(name) ?? 0) + 1);
  return { id: entry.id, displayName: bestDisplay(entry) };
}

// ── metadata extraction ───────────────────────────────────────────────────────
/** The description's season label — DIAGNOSTIC + grace input only (see header). */
function labeledSeason(description: string): number | null {
  const paren = /\(Season\s*(\d+)\)/i.exec(description);
  if (paren) return Number(paren[1]);
  const bare = /Season\s*(\d+)/i.exec(description);
  if (bare) return Number(bare[1]);
  return null;
}

/** Boundary grace: honor an explicit label exactly ONE season earlier than the
 *  date's, within this many days after the season start — daily-upload lag. */
const LABEL_GRACE_DAYS = 2;
const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let gracedCount = 0;
const staleLabels: { id: string; labeled: number; used: number | null }[] = [];

/** Season from publishedAt vs the boundary authority; the description label
 *  only wins through the narrow boundary grace, and stale labels are counted. */
function resolveSeason(id: string, description: string, publishedAt: string): number | null {
  const day = publishedAt.slice(0, 10);
  const dated = patchTable.seasonForDate(day);
  const labeled = labeledSeason(description);
  if (labeled !== null && dated !== null && labeled === dated - 1) {
    const start = patchTable.seasons.find((s) => s.season === dated)?.start;
    if (start && day < addDays(start, LABEL_GRACE_DAYS)) {
      gracedCount++;
      return labeled;
    }
  }
  if (labeled !== null && labeled !== dated) staleLabels.push({ id, labeled, used: dated });
  return dated;
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
function extractPatch(description: string): string | null {
  const m = /Patch\s*:\s*([^\n\r]+)/i.exec(description);
  if (!m) return null;
  const label = m[1].trim();
  const dm = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/.exec(label); // "12th May 2026"
  if (dm) {
    const mon = MONTHS[dm[2].toLowerCase()];
    if (mon !== undefined) {
      const d = new Date(Date.UTC(Number(dm[3]), mon, Number(dm[1])));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return label; // keep raw label when not a parseable date
}

// Fuse aliases → id, longest-first for greedy matching.
const fuseAliases: { alias: string; id: string }[] = [];
for (const f of Object.values(fuses)) {
  for (const a of new Set([f.name.toLowerCase(), ...f.aliases.map((x) => x.toLowerCase())])) {
    fuseAliases.push({ alias: a, id: f.id });
  }
}
fuseAliases.sort((a, b) => b.alias.length - a.alias.length);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Scan a per-team text segment for a fuse alias (accurate attribution, no guessing). */
function scanFuse(text: string): string | null {
  const lower = text.toLowerCase();
  for (const { alias, id } of fuseAliases) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(lower)) return id;
  }
  return null;
}

// Round / bracket tags (best-effort, from the raw title).
const ROUND_TAGS: [RegExp, string][] = [
  [/\bgrand\s*finals?\b/i, 'grand-finals'],
  [/\bgf\b/i, 'grand-finals'],
  [/\blosers?\s*finals?\b/i, 'losers-final'],
  [/\bwinners?\s*finals?\b/i, 'winners-final'],
  [/\bsemi[-\s]?finals?\b/i, 'semifinals'],
  [/\btop\s*8\b/i, 'top-8'],
  [/\btop\s*16\b/i, 'top-16'],
  [/\bfirst\s*strike\b/i, 'first-strike'],
];
function roundTags(title: string): string[] {
  return uniq(ROUND_TAGS.filter(([re]) => re.test(title)).map(([, t]) => t));
}

// ── title parsing ─────────────────────────────────────────────────────────────
// PREFIX is NOT anchored at "2XKO": bestReplays prefixes 215 titles with
// "NEW PATCH 2XKO ▰ …". The leading segment is [^▰]*? so it can never cross a ▰ —
// that guard is what keeps the one title whose only "2XKO" lives in the *suffix*
// (VklFg7dEoSQ, "Justin Wong (…) vs … ▰ 2XKO Pro level replays") from having its
// whole left side eaten: there is no ▰-free path from that "2XKO" to a ▰, so the
// pattern correctly declines to match and the title parses as it always has.
const PREFIX = /^[^▰]*?\b2XKO\b[^▰]*▰\s*/i;
const SUFFIX = /\s*▰[^▰]*$/;
const TEAM_SPLIT = /^(.+?\([^)]*\))\s+vs\s+(.+\([^)]*\))$/i;
const TEAM_EXTRACT = /^(?<players>.*?)\s*\((?<chars>[^)]*)\)\s*$/;

// bestReplays editorialises inside the player field: "RANK 1 NA EDUARDOHOOK",
// "RANK 1 CHALLENGER LEFFEN", "Rank 1 Duo! HARU & TOSHI", "RANK 1 vs RANK 2 X".
// Left in place, each variant mints its own auto-discovered player id (and a
// prerendered, crawlable /players/<id> page). The accolade is a channel editorial
// flourish, not a property of the match, so it is dropped rather than kept as a tag —
// the tag facet is a closed vocabulary (ROUND_TAGS + balance notes) and free-text
// accolades would pollute it. Zero pre-bestReplays titles match this, so stripping
// cannot change how any existing record parses.
const ACCOLADE =
  /^\s*▰?\s*rank\s*\d+(?:\s*(?:&|vs\.?)\s*(?:rank\s*)?\d+)?(?:\s*(?:na|eu|asia|jp|kr|world|challenger|duo))*\s*[-!:,]*\s+/i;
// bestReplays also writes rank as a TRAILING suffix: "INVIS K #6 Rank",
// "XYZZY #4 Rank". Left in place these mint invisk6rank / xyzzy4rank instead of
// merging into the established invisk / xyzzy — the same fragmentation ACCOLADE
// prevents at the front. Require a space before the number so a legit handle ending
// in a digit ("PLAYER6") is never touched.
const TRAILING_RANK = /\s+(?:#\s*)?\d+\s+rank\s*$/i;

/** Strip a stray leading ▰ and any stacked leading/trailing accolades
 *  ("RANK 1 DUO ASIA! X", "X #6 Rank") from a team's player segment. Never returns
 *  empty — a segment that is *only* an accolade is left alone so it still resolves to
 *  some player rather than vanishing. */
function normalizePlayerSegment(seg: string): string {
  let s = seg.trim().replace(/^▰\s*/, '').trim();
  for (;;) {
    let next = s;
    if (ACCOLADE.test(next)) next = next.replace(ACCOLADE, '').trim();
    if (TRAILING_RANK.test(next)) next = next.replace(TRAILING_RANK, '').trim();
    if (next === s || next === '') return s;
    s = next;
  }
}

interface ParsedTeam {
  playersRaw: string;
  charsRaw: string;
}
function parseTitle(
  rawTitle: string,
): { ok: true; teams: [ParsedTeam, ParsedTeam] } | { ok: false; stage: string } {
  let s = rawTitle.replace(/\s+/g, ' ').trim(); // 1. normalize whitespace
  s = s.replace(PREFIX, ''); // 2. strip leading prefix
  s = s.replace(SUFFIX, '').trim(); // 3. strip trailing suffix
  const m = TEAM_SPLIT.exec(s); // 4. split teams (parens-anchored)
  if (!m) return { ok: false, stage: 'team-split' };
  const teams: ParsedTeam[] = [];
  for (const seg of [m[1], m[2]]) {
    // 5. extract players + chars
    const tm = TEAM_EXTRACT.exec(seg);
    if (!tm?.groups) return { ok: false, stage: 'team-extract' };
    teams.push({ playersRaw: tm.groups.players, charsRaw: tm.groups.chars });
  }
  return { ok: true, teams: teams as [ParsedTeam, ParsedTeam] };
}

// ── build one VideoRecord ─────────────────────────────────────────────────────
interface LowReason {
  id: string;
  channel: ChannelKey;
  title: string;
  reasons: string[];
}
const lowReports: LowReason[] = [];

function buildRecord(raw: RawVideoRecord): VideoRecord {
  const cfg = CHANNELS[raw.channel];
  const season = resolveSeason(raw.id, raw.description, raw.publishedAt);
  const patch = extractPatch(raw.description);
  const tags = new Set<string>(roundTags(raw.title));
  const reasons: string[] = [];

  const base = {
    id: raw.id,
    channel: raw.channel,
    channelName: cfg.name,
    title: raw.title,
    publishedAt: raw.publishedAt,
    thumbnail: raw.thumbnail,
    durationSec: raw.durationSec,
    viewCount: raw.viewCount,
    season,
    patch,
    // same single authority as season; the post-override normalize below nulls
    // it when an explicit season contradicts the date ("patch unknown")
    patchVersion: patchTable.patchForDate(raw.publishedAt)?.version ?? null,
  };

  const parsed = parseTitle(raw.title);
  if (!parsed.ok) {
    reasons.push(`structural failure (${parsed.stage})`);
    lowReports.push({ id: raw.id, channel: raw.channel, title: raw.title, reasons });
    return {
      ...base,
      matchType: 'ranked',
      teams: [],
      allCharacters: [],
      allPlayers: [],
      tags: [...tags].sort(),
      parseConfidence: 'low',
      rawUnparsed: raw.title,
    };
  }

  const sides: TeamSide[] = ['left', 'right'];
  const teams: Team[] = [];
  let confidence: ParseConfidence = 'high';

  const rawSegments = [
    `${parsed.teams[0].playersRaw} (${parsed.teams[0].charsRaw})`,
    `${parsed.teams[1].playersRaw} (${parsed.teams[1].charsRaw})`,
  ];

  for (let i = 0; i < parsed.teams.length; i++) {
    const pt = parsed.teams[i];
    // characters
    const charTokens = pt.charsRaw
      .split(CHAR_SEP)
      .map((x) => x.trim())
      .filter(Boolean);
    if (charTokens.length !== 2) {
      confidence = 'low';
      reasons.push(`team ${sides[i]}: ${charTokens.length} character(s) (expected 2)`);
    }
    const characters: string[] = [];
    for (const tok of charTokens) {
      const r = resolveChampion(tok);
      if (r.id === null) {
        confidence = 'low';
        reasons.push(`unresolved character "${tok}" on ${sides[i]}`);
        continue;
      }
      if (r.confidence === 'low') {
        confidence = 'low';
        reasons.push(`fuzzy character "${tok}" → ${r.id} on ${sides[i]}`);
      }
      for (const n of r.notes) tags.add(n);
      characters.push(r.id);
    }

    // players (unified separator — the channels mix " & ", " + " and spaced "-")
    const playerTokens = normalizePlayerSegment(pt.playersRaw)
      .split(PLAYER_SEP)
      .map((x) => x.trim())
      .filter(Boolean);
    if (playerTokens.length === 0) {
      confidence = 'low';
      reasons.push(`team ${sides[i]}: no players parsed`);
    }
    const teamPlayers = playerTokens.map((t) => resolvePlayer(t));

    teams.push({
      side: sides[i],
      players: teamPlayers,
      characters: uniq(characters),
      fuse: scanFuse(rawSegments[i]),
    });
  }

  // tags: mirror (both teams same 2-character set)
  if (teams[0].characters.length === 2 && teams[1].characters.length === 2) {
    if ([...teams[0].characters].sort().join('|') === [...teams[1].characters].sort().join('|')) {
      tags.add('mirror');
    }
  }

  // matchType
  const maxPlayers = Math.max(teams[0].players.length, teams[1].players.length);
  const matchType: MatchType =
    maxPlayers >= 2 ? 'duo' : roundTags(raw.title).length > 0 ? 'tournament' : 'ranked';

  if (confidence === 'low') {
    lowReports.push({ id: raw.id, channel: raw.channel, title: raw.title, reasons });
  }

  return {
    ...base,
    matchType,
    teams,
    allCharacters: uniq(teams.flatMap((t) => t.characters)),
    allPlayers: uniq(teams.flatMap((t) => t.players.map((p) => p.id))),
    tags: [...tags].sort(),
    parseConfidence: confidence,
    rawUnparsed: null,
  };
}

// ── manual videos (data/manual-videos.json) ──────────────────────────────────
// Hand-authored records the title parser can't produce (tournament VODs etc.).
// Authoritative: never parsed, never overwritten, parseConfidence "manual".
// Tournament entries are SET-level — teams[].characters is the union of
// champions fielded across the set (see the file's "//" header).
const manualNewPlayers: { id: string; displayName: string }[] = [];
const manualTodos: { id: string; todo: string }[] = [];

/** Strict validation: unknown champions/fuses, malformed entries, and id
 *  collisions are hard errors — bad hand-authored data must never land. */
function buildManualRecords(): VideoRecord[] {
  const errors: string[] = [];
  const err = (id: string, msg: string) => errors.push(`manual-videos.json [${id || '?'}]: ${msg}`);
  // Carried ids count as "already in the dumps" for the collision check: they are
  // published records, and a manual entry duplicating one is the same error it
  // has always been. Without the union this check silently stops covering them.
  const rawIds = new Set([...rawRecords.map((r) => r.id), ...carriedRecords.map((v) => v.id)]);
  const seenIds = new Set<string>();

  // final registry lookup — includes this run's parser-discovered players
  const finalAlias = new Map<string, string>(); // aliasLower -> playerId
  for (const p of Object.values(players)) {
    finalAlias.set(p.handle.toLowerCase(), p.id);
    for (const a of p.extra.aliases) finalAlias.set(a.toLowerCase(), p.id);
  }
  const resolveManualPlayer = (rawName: string): { id: string; displayName: string } => {
    const name = rawName.trim();
    const known = finalAlias.get(name.toLowerCase());
    if (known) return { id: known, displayName: players[known].handle };
    // Unknown → register as featured (the old "verified"): manual entries are
    // hand-curated, so the name is exact (tournament participants, not
    // parser guesses).
    const slug = slugify(name) || 'player';
    let id = slug;
    for (let n = 2; usedIds.has(id); n++) id = `${slug}-${n}`;
    usedIds.add(id);
    players[id] = { id, handle: name, featured: true, extra: { aliases: [name.toLowerCase()] } };
    finalAlias.set(name.toLowerCase(), id);
    manualNewPlayers.push({ id, displayName: name });
    return { id, displayName: name };
  };

  const out: VideoRecord[] = [];
  for (const e of manualEntries) {
    const id = typeof e.id === 'string' ? e.id : '';
    if (!id) err('', `entry with missing/non-string id (title: ${e.title ?? '?'})`);
    if (seenIds.has(id)) err(id, 'duplicate id within manual-videos.json');
    seenIds.add(id);
    if (rawIds.has(id))
      err(
        id,
        "id already exists in the channel dumps — fix the parse (overrides.json), don't duplicate it",
      );
    if (!e.title) err(id, 'missing title');
    if (!e.publishedAt || Number.isNaN(Date.parse(e.publishedAt)))
      err(id, `publishedAt "${e.publishedAt}" is not a parseable ISO timestamp`);
    if (!e.tournament) err(id, 'missing tournament (event name)');
    if (!Array.isArray(e.teams) || e.teams.length !== 2) {
      err(
        id,
        `expected exactly 2 teams, got ${Array.isArray(e.teams) ? e.teams.length : typeof e.teams}`,
      );
      continue; // team-level checks below would crash
    }
    if (e.matchType && !['ranked', 'tournament', 'duo'].includes(e.matchType))
      err(id, `invalid matchType "${e.matchType}"`);

    const sides: TeamSide[] = ['left', 'right'];
    const teams: Team[] = e.teams.map((t, i) => {
      const names = (t.players ?? []).map((n) => String(n).trim()).filter(Boolean);
      if (names.length === 0) err(id, `team ${sides[i]}: no players`);
      const characters = uniq(
        (t.characters ?? []).map((tok) => {
          const cid = champByAlias.get(String(tok).trim().toLowerCase()); // exact only — no fuzzy for hand-authored data
          if (!cid)
            err(
              id,
              `team ${sides[i]}: unknown champion "${tok}" (valid ids: ${Object.keys(champions).sort().join(', ')})`,
            );
          return cid ?? String(tok);
        }),
      );
      if (t.fuse != null && !fuses[t.fuse])
        err(
          id,
          `team ${sides[i]}: unknown fuse "${t.fuse}" (valid: ${Object.keys(fuses).sort().join(', ')})`,
        );
      return {
        side: sides[i],
        players: names.map(resolveManualPlayer),
        characters,
        fuse: t.fuse ?? null,
      };
    });

    const tags = new Set<string>([...roundTags(e.title ?? ''), ...(e.tags ?? [])]);
    if (
      teams[0].characters.length === 2 &&
      teams[1].characters.length === 2 &&
      [...teams[0].characters].sort().join('|') === [...teams[1].characters].sort().join('|')
    ) {
      tags.add('mirror');
    }
    if (e.todo) manualTodos.push({ id, todo: e.todo });

    out.push({
      id,
      channel: 'manual',
      channelName: e.channelName ?? e.tournament,
      title: e.title,
      publishedAt: e.publishedAt,
      thumbnail: e.thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      durationSec: e.durationSec ?? 0,
      viewCount: e.viewCount ?? 0,
      season: e.season !== undefined ? e.season : patchTable.seasonForDate(e.publishedAt ?? ''),
      patch: e.patch ?? null,
      patchVersion:
        e.patchVersion !== undefined
          ? e.patchVersion
          : (patchTable.patchForDate(e.publishedAt ?? '')?.version ?? null),
      matchType: e.matchType ?? 'tournament',
      teams,
      allCharacters: uniq(teams.flatMap((t) => t.characters)),
      allPlayers: uniq(teams.flatMap((t) => t.players.map((p) => p.id))),
      tags: [...tags].sort(),
      parseConfidence: 'manual',
      rawUnparsed: null,
      tournament: e.tournament,
      ...(e.round ? { round: e.round } : {}),
    });
  }

  if (errors.length > 0) {
    console.error(`✖ ${errors.length} error(s) in data/manual-videos.json — nothing written:`);
    for (const m of errors) console.error(`  • ${m}`);
    process.exit(1);
  }
  return out;
}

// ── the index source (raw/replayTheater.json) ────────────────────────────────
// Replay Theater indexes MATCHES inside longform tournament VODs, so a record
// here is a segment: ~16 of them share one three-hour video and the id is
// `${videoId}@${startSeconds}`. The data arrives structured — players,
// champions, event tag and offset are separate fields — so there is no title to
// parse and this is a third construction path beside buildRecord (title) and
// buildManualRecords (hand-authored).
//
// TRUST TIER. This is third-party curation, which is a weaker provenance than
// either of the other two, so it gets the STRICTER of their gates, not the
// looser: champions resolve on an exact alias only (no fuzzy, as with
// hand-authored data), and anything unresolved is dropped to residue rather
// than guessed. Players, by contrast, register as ordinary parser discoveries
// (`featured: false`) — a manual entry earns `featured: true` because a human
// here typed the name, and nobody here typed these.
const theaterSkippedKnown: { videoId: string; tag: string; where: string }[] = [];
const theaterResidue: { id: string; raw: string }[] = [];

function buildTheaterRecords(): VideoRecord[] {
  if (theaterRaw.length === 0) return [];

  // ── ignore-if-known, and it runs FIRST ──────────────────────────────────────
  // If this repo has already ruled on a video IN ANY CAPACITY, the index entry
  // is ignored. Not merged, not preferred — ignored. The predicate is
  // known-ANYWHERE rather than merely in-records, because an id excluded as
  // wrong-game or dropped as a duplicate must not re-enter through a side door;
  // those verdicts are the whole point of overrides.json.
  //
  // It keys on the VIDEO id, not the record id. A composite id can never equal
  // an 11-character YouTube id, so comparing record ids would match nothing and
  // the rule would silently never fire.
  //
  // Measured cost on the first ingest: 10 of 899, every one of them a
  // one-match VOD already hand-authored in manual-videos.json — so the rule
  // forgoes no segmentation at all. That is a fact about today's data, not a
  // guarantee, which is why the count is reported rather than assumed.
  const knownAnywhere = new Map<string, string>();
  const note = (id: string, where: string) => {
    if (!knownAnywhere.has(id)) knownAnywhere.set(id, where);
  };
  for (const r of rawRecords) note(r.id, `raw/${r.channel}.json`);
  for (const v of committedAll) note(v.id, `videos.json (${v.channel})`);
  for (const e of manualEntries) note(e.id, 'manual-videos.json');
  for (const [id, ov] of Object.entries(overrides)) {
    // `dupeOf` is provenance written by data:replay-dupes; it is not part of the
    // override type (nothing reads it), so it is read defensively here purely to
    // make the skip reason legible in the report.
    const dupeOf = (ov as { dupeOf?: string }).dupeOf;
    note(id, dupeOf ? `overrides.json (dupeOf ${dupeOf})` : 'overrides.json');
  }

  const kept: TheaterRawRecord[] = [];
  for (const r of theaterRaw) {
    const where = knownAnywhere.get(r.videoId);
    if (where) theaterSkippedKnown.push({ videoId: r.videoId, tag: r.tag, where });
    else kept.push(r);
  }

  // ── duplicate ids across intakes ────────────────────────────────────────────
  // Structurally impossible today — every theater id contains "@" and no other
  // intake's does — which is exactly why it is worth asserting rather than
  // assuming. Cross-source id collision could not happen at all before an
  // index-type source existed; the next one will not necessarily be so tidy,
  // and the failure it would otherwise cause is a record silently overwriting
  // another. Names both intakes so the fix is obvious.
  const byId = new Map<string, string>();
  for (const r of rawRecords) byId.set(r.id, r.channel);
  for (const v of carriedRecords) byId.set(v.id, v.channel);
  for (const e of manualEntries) byId.set(e.id, 'manual');
  const collisions: string[] = [];
  const seenTheater = new Set<string>();
  for (const r of kept) {
    const other = byId.get(r.id);
    if (other) collisions.push(`  ${r.id}: replayTheater vs ${other}`);
    if (seenTheater.has(r.id)) collisions.push(`  ${r.id}: replayTheater vs replayTheater`);
    seenTheater.add(r.id);
  }
  if (collisions.length > 0) {
    console.error(
      [
        `✖ ${collisions.length} record id(s) claimed by two intakes — nothing written:`,
        ...collisions.slice(0, 20),
        collisions.length > 20 ? `  … ${collisions.length - 20} more` : '',
        `  Ids are the primary key of videos.json, overrides.json and the fuse cache, so a`,
        `  collision does not error downstream — one record silently replaces the other.`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    process.exit(1);
  }

  const sides: TeamSide[] = ['left', 'right'];
  const out: VideoRecord[] = [];

  for (const r of kept) {
    let confidence: ParseConfidence = 'high';
    const unresolved: string[] = [];

    const teams: Team[] = [0, 1].map((i) => {
      // Sponsor prefix first, THEN the duo split — "PFGG | Paul Le / Monokeros"
      // needs both, in that order. Splitting first would leave "PFGG | Paul Le"
      // as a handle; treating "|" as a separator would mint a player called
      // "PFGG" with a page of its own.
      const raw = (r.players[i] ?? '').replace(THEATER_SPONSOR, '');
      const names = raw
        .split(CHANNELS.replayTheater.playerSep)
        .map((n) => n.trim())
        .filter(Boolean);

      const characters = uniq(
        (r.characters[i] ?? [])
          .map((tok) => {
            // EXACT ALIAS ONLY. The fuzzy ladder buildRecord uses exists to
            // rescue typos in a channel's own titles; applying it to someone
            // else's vocabulary would let a near-miss become a confident
            // champion nobody played. An unresolved token becomes residue: the
            // champion is omitted, never invented, and the raw string is kept
            // so a human can see what was discarded.
            const cid = champByAlias.get(tok.trim().toLowerCase());
            if (!cid) {
              unresolved.push(tok);
              confidence = 'low';
            }
            return cid;
          })
          .filter((c): c is string => c != null),
      );

      return {
        side: sides[i],
        players: names.length > 0 ? names.map(resolvePlayer) : [],
        characters,
        fuse: null, // CV only; scripts/fuses.ts fills these from the footage
      };
    });

    if (teams.some((t) => t.players.length === 0)) confidence = 'low';
    if (unresolved.length > 0) theaterResidue.push({ id: r.id, raw: unresolved.join(', ') });
    // Feed the SAME low-confidence table buildRecord feeds. A separate section
    // would let residue from a new source hide from anyone who already knows
    // where to look for residue.
    if (confidence === 'low') {
      const reasons: string[] = [];
      if (unresolved.length > 0) reasons.push(`unresolved champion(s): ${unresolved.join(', ')}`);
      for (const t of teams) if (t.players.length === 0) reasons.push(`team ${t.side}: no players`);
      lowReports.push({ id: r.id, channel: 'replayTheater', title: r.title, reasons });
    }

    const tags = new Set<string>(roundTags(r.round ?? ''));
    if (
      teams[0].characters.length === 2 &&
      teams[1].characters.length === 2 &&
      [...teams[0].characters].sort().join('|') === [...teams[1].characters].sort().join('|')
    ) {
      tags.add('mirror');
    }

    out.push({
      id: r.id,
      channel: 'replayTheater',
      // Per record, not per source: these 74 VODs belong to eleven different
      // event organisers, and naming the uploader is what makes the record
      // traceable back to the footage's actual publisher.
      channelName: r.uploader || CHANNELS.replayTheater.name,
      title: r.title,
      publishedAt: r.publishedAt,
      thumbnail: r.thumbnail,
      durationSec: r.durationSec,
      viewCount: r.viewCount,
      season: patchTable.seasonForDate(r.publishedAt),
      patch: null,
      patchVersion: patchTable.patchForDate(r.publishedAt)?.version ?? null,
      matchType: 'tournament',
      teams,
      allCharacters: uniq(teams.flatMap((t) => t.characters)),
      allPlayers: uniq(teams.flatMap((t) => t.players.map((p) => p.id))),
      tags: [...tags].sort(),
      parseConfidence: confidence,
      // Residue: what the roster gate refused, kept where the low-confidence
      // table in report.md will surface it. null when everything resolved.
      rawUnparsed:
        unresolved.length > 0 ? `unresolved champion(s): ${unresolved.join(', ')}` : null,
      tournament: r.tag,
      ...(r.round ? { round: r.round } : {}),
      videoId: r.videoId,
      startSeconds: r.startSeconds,
    });
  }

  return out;
}

// ── stats ─────────────────────────────────────────────────────────────────────
// buildStats + the deterministic sort helpers moved VERBATIM to scripts/stats.ts
// (Phase 3) so the standalone generic emitter derives identical numbers.

// ── report.md ─────────────────────────────────────────────────────────────────
const cell = (s: string) =>
  s
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();

function buildReport(
  records: VideoRecord[],
  counts: { seasonPct: string; patchPct: string; patchVersionPct: string; fusePct: string },
): string {
  const total = records.length;
  const low = records.filter((r) => r.parseConfidence === 'low').length;
  const newPlayers = [...discovered.values()].sort((a, b) => b.count - a.count);

  const manual = records.filter((r) => r.parseConfidence === 'manual').length;

  const lines: string[] = [];
  lines.push(`# 2XKO replay parse report`, ``, `_Generated ${new Date().toISOString()}._`, ``);
  lines.push(`## Summary`);
  lines.push(`- Total videos: **${total}**`);
  lines.push(
    `- High confidence: **${total - low - manual}**  ·  Low confidence: **${low}**  ·  Manual (hand-authored): **${manual}**`,
  );
  lines.push(
    `- Newly discovered players (auto-added to \`players.json\`): **${newPlayers.length}**`,
  );
  lines.push(
    `- Fill rates — season: **${counts.seasonPct}%** · patchVersion: **${counts.patchVersionPct}%** · patch label: **${counts.patchPct}%** · fuse: **${counts.fusePct}%**`,
  );
  lines.push(
    `- Season derivation (date-authoritative) — boundary-graced: **${gracedCount}** · stale description labels overridden: **${staleLabels.length}**`,
  );
  if (theaterRaw.length > 0) {
    lines.push(
      `- Replay Theater entries **skipped as already-known**: **${theaterSkippedKnown.length}** of ${theaterRaw.length} (existing ids win, by ignoring)`,
    );
  }
  lines.push(``);

  // ── per-source counts ─────────────────────────────────────────────────────
  // Σ has to reconcile with the total, and a source that quietly stopped
  // contributing should be visible as a row rather than inferred from a diff.
  lines.push(`## Records by source`, ``);
  lines.push(`| source | records | mode |`, `|---|---|---|`);
  const bySource = new Map<string, number>();
  for (const r of records) bySource.set(r.channel, (bySource.get(r.channel) ?? 0) + 1);
  for (const [src, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    const ch = CHANNELS[src as ChannelKey];
    const mode = !ch
      ? 'hand-authored'
      : ch.frozen
        ? 'carried (frozen)'
        : ch.localFirst
          ? carriedLocalFirst.includes(src as ChannelKey)
            ? 'carried (local-first, no dump this run)'
            : 'rebuilt from a local dump'
          : 'fetched';
    lines.push(`| \`${src}\` | ${n} | ${mode} |`);
  }
  lines.push(`| **Σ** | **${total}** | |`, ``);

  // ── frozen channels ───────────────────────────────────────────────────────
  // These records are not re-fetched and not re-parsed; they are carried from the
  // last good catalogue. That is invisible everywhere else — the badge, the source
  // chip and the filters all keep working — so this is the one place it stays
  // visible instead of becoming folklore.
  if (frozenKeys.length > 0) {
    lines.push(`## Frozen channels (${frozenKeys.length})`);
    lines.push(
      `_Not fetched. Their committed records are carried forward and still receive fuse detections and \`overrides.json\` verdicts. Pruning one requires editing \`frozen.records\` in \`scripts/channels.ts\`._`,
      ``,
    );
    lines.push(`| channel | carried | frozen since | reason |`, `|---|---|---|---|`);
    for (const key of frozenKeys) {
      const f = CHANNELS[key].frozen!;
      const carried = records.filter((r) => r.channel === key).length;
      lines.push(`| \`${key}\` | ${carried} | ${f.since} | ${cell(f.reason)} |`);
    }
    lines.push(``);
  }

  // ── local-first sources ───────────────────────────────────────────────────
  const localFirstKeys = (Object.keys(CHANNELS) as ChannelKey[]).filter(
    (k) => CHANNELS[k].localFirst && records.some((r) => r.channel === k),
  );
  if (localFirstKeys.length > 0) {
    lines.push(`## Local-first sources (${localFirstKeys.length})`);
    lines.push(
      `_Deliberately outside the daily cron: a third party's uptime is not a cron dependency. Refreshed by hand, and carried from the committed catalogue on every run without a dump — which is every cron run._`,
      ``,
      `**Guard posture, stated rather than assumed.** The channel-collapse guard is ASLEEP for these on a carrying run: it compares raw/ against the catalogue, and there is no raw/ to compare. The count pin in \`data/source-pins.json\` is what is awake, and it is strictly stronger — it demands an exact number where the collapse guard only demands "not much smaller".`,
      ``,
    );
    lines.push(
      `| source | records | pin now | this run | newest record |`,
      `|---|---|---|---|---|`,
    );
    for (const key of localFirstKeys) {
      const n = records.filter((r) => r.channel === key).length;
      const carried = carriedLocalFirst.includes(key);
      const dates = records.filter((r) => r.channel === key).map((r) => r.publishedAt);
      const newest = dates.length > 0 ? dates.sort()[dates.length - 1].slice(0, 10) : '—';
      // On a rebuild the pin is rewritten from this run's count, so report the
      // value now in force rather than the one this run happened to check
      // against — the file and the report must not disagree.
      const pin = carried ? (sourcePins[key] ?? '—') : n;
      lines.push(
        `| \`${key}\` | ${n} | ${pin} | ${carried ? 'carried (no dump)' : 'rebuilt from dump'} | ${newest} |`,
      );
    }
    lines.push(``);
    if (theaterSkippedKnown.length > 0) {
      const byWhere = new Map<string, number>();
      for (const k of theaterSkippedKnown) {
        const bucket = k.where.replace(/ \(.*\)$/, '');
        byWhere.set(bucket, (byWhere.get(bucket) ?? 0) + 1);
      }
      lines.push(
        `_Skipped as already-known (${theaterSkippedKnown.length}): ` +
          [...byWhere.entries()].map(([w, n]) => `${n} in ${w}`).join(', ') +
          `. Existing ids win, by ignoring — an id this repo has already ruled on, in any capacity, does not re-enter through a side door._`,
        ``,
      );
    }
  }

  if (manual > 0) {
    lines.push(`## Manual videos (${manual})`);
    lines.push(
      `_Hand-authored in \`data/manual-videos.json\` — never parse failures. Entries with an open \`todo\` need data filled in._`,
      ``,
    );
    lines.push(`| id | tournament | round | todo |`, `|---|---|---|---|`);
    for (const r of records.filter((x) => x.parseConfidence === 'manual')) {
      const todo = manualTodos.find((t) => t.id === r.id)?.todo ?? '';
      lines.push(
        `| \`${r.id}\` | ${cell(r.tournament ?? '')} | ${cell(r.round ?? '')} | ${cell(todo)} |`,
      );
    }
    lines.push(``);
    if (manualNewPlayers.length > 0) {
      lines.push(
        `_New players registered from manual entries (featured): ${manualNewPlayers
          .map((p) => `\`${p.id}\` (${p.displayName})`)
          .join(', ')}._`,
        ``,
      );
    }
  }

  // lowReports is populated in buildRecord BEFORE overrides apply, so a structural
  // failure later repaired by an overrides.json entry (final parseConfidence 'high')
  // is still in the list. Filter to records that are STILL low so the table matches
  // the `low` header count instead of listing override-fixed rows uncounted.
  const finalLow = new Set(records.filter((r) => r.parseConfidence === 'low').map((r) => r.id));
  const lowRows = lowReports.filter((r) => finalLow.has(r.id));
  lines.push(`## Low-confidence records (${lowRows.length})`);
  if (lowRows.length === 0) {
    lines.push(`_None._`, ``);
  } else {
    lines.push(`| id | channel | reason | raw title |`, `|---|---|---|---|`);
    for (const r of lowRows) {
      lines.push(
        `| \`${r.id}\` | ${r.channel} | ${cell(r.reasons.join('; '))} | ${cell(r.title)} |`,
      );
    }
    lines.push(``);
  }

  lines.push(`## Newly discovered players (${newPlayers.length})`);
  lines.push(
    `_Auto-added to \`data/players.json\` with a best-guess \`displayName\`. Fix casing / add aliases as needed._`,
    ``,
  );
  if (newPlayers.length === 0) {
    lines.push(`_None._`, ``);
  } else {
    lines.push(`| slug | displayName | occurrences | aliases seen |`, `|---|---|---|---|`);
    for (const d of newPlayers) {
      lines.push(
        `| \`${d.id}\` | ${cell(bestDisplay(d))} | ${d.count} | ${cell([...d.aliases].sort().join(', '))} |`,
      );
    }
    lines.push(``);
  }
  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────
const baseRecords = rawRecords.map(buildRecord);
lowReports.push(...carriedLow);

// Finalize discovered players into the registry (existing seed entries preserved).
for (const d of [...discovered.values()].sort((a, b) => b.count - a.count)) {
  players[d.id] = {
    id: d.id,
    handle: bestDisplay(d),
    featured: false, // parser-discovered — not part of the curated seed roster
    extra: { aliases: [...d.aliases].sort() },
  };
}

// Normalize embedded player displayNames to the final canonical value — discovery
// merges casing variants as it goes, so records built early held stale snapshots —
// then apply overrides.json LAST as a shallow merge.
const mergeCuration = (rec: VideoRecord): VideoRecord => {
  const teams = rec.teams.map((t) => ({
    ...t,
    players: t.players.map((p) => ({
      id: p.id,
      displayName: players[p.id]?.handle ?? p.displayName,
    })),
  }));
  let merged: VideoRecord = { ...rec, teams };
  // fuse merge: only confident detections set teams[].fuse ("low"/"none" stay
  // null); ok-unordered pairs are flagged — filters/stats are order-agnostic,
  // the modal shows the pair unattributed.
  const det = fusesDetected[rec.id];
  if (det && (det.status === 'ok' || det.status === 'ok-unordered') && merged.teams.length === 2) {
    merged = {
      ...merged,
      teams: [
        { ...merged.teams[0], fuse: det.left },
        { ...merged.teams[1], fuse: det.right },
      ],
      ...(det.status === 'ok-unordered' ? { fusesUnordered: true } : {}),
    };
  }
  // overrides.json last — a manual fuse override beats detection. Exclusion
  // entries don't shallow-merge (the record is dropped wholesale below).
  const ov = overrides[rec.id];
  return ov && !ov.exclude ? { ...merged, ...ov } : merged;
};

// Carried records take the SAME merge as parsed ones, deliberately. They skip
// buildRecord — there is no raw to rebuild them from — but a frozen channel is
// still a parser-derived one, so a corrected detection should land and a
// /dev/fuse-review verdict must reach it. Skipping this would strand every
// carried record: the review page would write a file the pipeline ignores.
const parsedRecords: VideoRecord[] = [...baseRecords, ...carriedFrozen].map(mergeCuration);

/** The fuse half of the merge above, for HAND-AUTHORED records.
 *
 *  Both merges above live inside the baseRecords.map, and manual records are
 *  concatenated after it — so until this existed, a detection or a
 *  /dev/fuse-review verdict keyed on a tournament id was silently discarded on
 *  every run. The review page wrote a file the pipeline ignored.
 *
 *  It is deliberately NOT the full shallow merge the parsed branch takes. A
 *  manual entry is "authoritative: never parsed, never overwritten" (see
 *  buildManualRecords), so letting overrides.json rewrite its title, tournament
 *  or characters would quietly outrank the file a human curates by hand. Fuses
 *  are the exception: they are CV output rather than authorship, so a detection
 *  may FILL a null side and a review verdict may correct one. Only the fuse
 *  column and the unordered flag cross over.
 *
 *  Detection FILLS PER SIDE, never overwrites: a hand-authored fuse outranks
 *  the detector, and a half-authored record must still get its null side
 *  filled — a record-level "already has a fuse" test would skip exactly that.
 */
function applyFuseSources(rec: VideoRecord): VideoRecord {
  if (rec.teams.length !== 2) return rec;
  let out = rec;

  const det = fusesDetected[rec.id];
  if (det && (det.status === 'ok' || det.status === 'ok-unordered')) {
    const pair = [det.left, det.right];
    if (out.teams.some((t, i) => t.fuse === null && pair[i] !== null)) {
      out = {
        ...out,
        teams: out.teams.map((t, i) => (t.fuse === null ? { ...t, fuse: pair[i]! } : t)),
        ...(det.status === 'ok-unordered' ? { fusesUnordered: true as const } : {}),
      };
    }
  }

  // An override carries a whole teams array (that is the shape fuse-review
  // writes); take ONLY the fuse column off it so a stale snapshot of the
  // players or characters can never land back on the record.
  const ov = overrides[rec.id];
  if (ov && !ov.exclude) {
    if (Array.isArray(ov.teams) && ov.teams.length === out.teams.length) {
      const fuses = ov.teams.map((t) => t.fuse ?? null);
      if (out.teams.some((t, i) => t.fuse !== fuses[i])) {
        out = { ...out, teams: out.teams.map((t, i) => ({ ...t, fuse: fuses[i]! })) };
      }
    }
    if (ov.fusesUnordered === true) {
      out = { ...out, fusesUnordered: true };
    } else if (ov.fusesUnordered === false && out.fusesUnordered) {
      // an explicit clear — drop the key rather than emitting `false`, since
      // VideoRecord types it `?: true`
      const { fusesUnordered: _cleared, ...rest } = out;
      out = rest;
    }
  }
  return out;
}

// Manual records resolve players against the finalized registry (discovery
// included), so they build after the loop above; appended last — additive,
// authoritative, and absent from the raw dumps by definition. Overrides-driven
// exclusions apply to the final set (shared with the standalone emit).
// Hierarchy consistency normalize (LAST, after grace/manual/overrides settled
// season): a patchVersion whose release-date season contradicts the record's
// season becomes null — the emit then carries the bare era token, "season
// known, patch unknown", which matches whole-season selections but never a
// specific patch. Graced boundary-lag records land here by construction.
const normalizePatchVersion = (r: VideoRecord): VideoRecord =>
  r.patchVersion !== null && patchTable.seasonOfPatch(r.patchVersion) !== r.season
    ? { ...r, patchVersion: null }
    : r;

/** Footage-completion channels publish only what a verdict has actually settled.
 *
 *  These titles name players, game and round and never a champion, so a title
 *  parse produces a record with EMPTY sides. Publishing that is worse than
 *  publishing nothing: a championless row in the catalogue, dragging the
 *  low-confidence count, showing on the site as a match nobody played. The
 *  verdict lives in overrides.json, so a record without one is simply not ready.
 *  Held-out ids are reported rather than silently dropped. */
const footageChannels = new Set(
  Object.values(CHANNELS)
    .filter((c) => c.charactersFromFootage)
    .map((c) => c.key as string),
);
const heldForFootage: VideoRecord[] = [];
const publishable = parsedRecords.filter((r) => {
  if (!footageChannels.has(r.channel)) return true;
  const complete = r.teams.length === 2 && r.teams.every((t) => t.characters.length > 0);
  if (!complete) heldForFootage.push(r);
  return complete;
});

// The index source takes the SAME narrow merge manual records take
// (applyFuseSources): detection fills a null fuse side, and an override may
// contribute the fuse column and nothing else. An override must not be able to
// rewrite a theater record's title, event or champions — those come from the
// index, and a shallow merge would let a stale verdict outrank the source
// silently. Exclusions still apply, which is how a bad theater record gets
// dropped: `{ "<videoId>@<start>": { "exclude": true } }`.
const records: VideoRecord[] = applyExclusions(
  [
    ...publishable,
    ...buildManualRecords().map(applyFuseSources),
    // Same slot and same merge whether the dump was present or not, so the cron
    // and a local refresh publish identical bytes from identical inputs.
    ...(theaterRaw.length > 0 ? buildTheaterRecords() : carriedLocalFirstRecords).map(
      applyFuseSources,
    ),
  ],
  overrides,
).map(normalizePatchVersion);

// Drop discovered players no final record references — an override that rewrites
// a bad parse (e.g. an unsplit duo team) would otherwise re-register the bogus
// name on every run. Seed entries are untouched.
const referencedIds = new Set(
  records.flatMap((r) => [...r.allPlayers, ...r.teams.flatMap((t) => t.players.map((p) => p.id))]),
);
for (const [slug, d] of discovered) {
  if (!referencedIds.has(d.id)) {
    discovered.delete(slug);
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- registry pruning: the Record IS the mutable registry keyed by discovered ids
    delete players[d.id];
  }
}

/**
 * REGISTER PLAYERS AN OVERRIDE INTRODUCED. The pruning above is one half of the
 * job and this is the other.
 *
 * An override supplies whole `teams[]` arrays with hardcoded ids, so it bypasses
 * resolvePlayer() — which is the only thing that registers a discovered name.
 * A verdict naming somebody the parser never saw therefore produced a record
 * referencing a player who is in no registry, and nothing noticed: the page
 * links to /players/<id> and 404s.
 *
 * Live case, found by the new emit gate: jEWF1k9zyPk, an Evo 2026 duo duel
 * hand-validated and migrated from manual-videos.json on 2026-08-08, names
 * "Myth" — the other three (ApologyMan, Jake'n'bake, Yohosie) exist because
 * ordinary records mention them, and Myth does not.
 *
 * Registered as a non-featured discovery, exactly as if the parser had met the
 * name, so the next run's pruning treats it like any other.
 */
for (const r of records) {
  for (const t of r.teams) {
    for (const pl of t.players) {
      if (!pl.id || players[pl.id]) continue;
      players[pl.id] = {
        id: pl.id,
        handle: pl.displayName || pl.id,
        featured: false,
        extra: { aliases: [(pl.displayName || pl.id).toLowerCase()] },
      };
    }
  }
}

const total = records.length;
const seasonFilled = records.filter((r) => r.season !== null).length;
const patchFilled = records.filter((r) => r.patch !== null).length;
const patchVersionFilled = records.filter((r) => r.patchVersion !== null).length;
const fuseFilled = records.filter((r) => r.teams.some((t) => t.fuse !== null)).length;
const pctOf = (n: number) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));
const counts = {
  seasonPct: pctOf(seasonFilled),
  patchPct: pctOf(patchFilled),
  patchVersionPct: pctOf(patchVersionFilled),
  fusePct: pctOf(fuseFilled),
};

// ── re-pin every local-first source built from a dump this run ────────────────
// Written here, from the FINAL record count, so the number the next carrying run
// checks against is the number actually published — exclusions and all.
const rebuiltLocalFirst = (Object.keys(CHANNELS) as ChannelKey[]).filter(
  (k) => CHANNELS[k].localFirst && !carriedLocalFirst.includes(k),
);
if (rebuiltLocalFirst.length > 0) {
  const next = { ...sourcePins };
  for (const key of rebuiltLocalFirst) next[key] = records.filter((r) => r.channel === key).length;
  const ordered = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(PINS, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  for (const key of rebuiltLocalFirst) {
    const was = sourcePins[key];
    console.log(
      `  pinned ${key} at ${ordered[key]}${was !== undefined && was !== ordered[key] ? ` (was ${was})` : ''}`,
    );
  }
}

await writeFile(join(DATA, 'videos.json'), JSON.stringify(records, null, 2) + '\n', 'utf8');
await writeFile(
  join(DATA, 'players.json'),
  JSON.stringify(Object.values(players), null, 2) + '\n',
  'utf8',
);
await writeFile(join(DATA, 'report.md'), buildReport(records, counts), 'utf8');

// Generic-schema artifacts (replays.json + stats.json) — shared emitter, same
// stats math (scripts/stats.ts), count-asserted.
await emitGeneric({
  records,
  characters: Object.values(champions),
  players: Object.values(players),
  root: ROOT,
});

const low = records.filter((r) => r.parseConfidence === 'low').length;
const manualN = records.filter((r) => r.parseConfidence === 'manual').length;
console.log(`✔ Parsed ${total} videos → data/videos.json`);
console.log(
  `  high-confidence: ${total - low - manualN}   low-confidence: ${low}   manual: ${manualN}`,
);
console.log(
  `  newly discovered players: ${discovered.size}  (players.json now ${Object.keys(players).length} total)`,
);
if (manualNewPlayers.length > 0) {
  console.log(
    `  manual entries registered ${manualNewPlayers.length} new featured player(s): ${manualNewPlayers.map((p) => p.id).join(', ')}`,
  );
}
for (const t of manualTodos) console.log(`  ⚠ manual ${t.id} — todo: ${t.todo}`);
if (heldForFootage.length > 0) {
  console.log(
    `  ⚠ ${heldForFootage.length} footage record(s) held out of videos.json — awaiting a champion verdict:`,
  );
  for (const r of heldForFootage.slice(0, 10)) console.log(`      ${r.id}  ${r.title}`);
  if (heldForFootage.length > 10) console.log(`      … ${heldForFootage.length - 10} more`);
  console.log('    Resolve with: npm run data:extract  →  /dev/evo-review');
}
console.log(
  `  fill rates → season ${counts.seasonPct}%  ·  patchVersion ${counts.patchVersionPct}%  ·  fuse ${counts.fusePct}%`,
);

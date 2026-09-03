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

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, CHAR_SEP, PLAYER_SEP, THEATER_SPONSOR } from './channels';
import { crossCheck, formatCrossCheck, type WitnessArtifact, type WitnessFile } from './crosscheck';
import { applyExclusions, emitGeneric } from './emit';
import { formatStaleRefusal, staleEvidence } from './freshness';
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
/** Each channel's OWN dump, kept beside the pooled `rawRecords` for the
 *  stale-raw guard. The guard is scoped per channel — a stale bestReplays dump
 *  says nothing about highLevel — so pooling alone cannot drive it. */
const dumps = new Map<ChannelKey, RawVideoRecord[]>();
/** The index source's dump, when present. Kept OUT of `rawRecords` because its
 *  records are not built by a title parse — see buildTheaterRecords. */
let theaterRaw: TheaterRawRecord[] = [];
/** The index dump was there and could not be read. Reported rather than
 *  absorbed: a carry the reader cannot tell apart from a quiet catalogue is a
 *  carry that hides a broken fetcher for as long as nobody looks. */
let theaterUnreadable = false;
/** Cron-fetched sources with no usable dump on this run, so their committed
 *  records are carried instead of rebuilt. This USED to be every cron run, every
 *  time — raw/ is gitignored and the cron fetched nothing. Since 2026-08-31 it is
 *  the FALLBACK: the cron does fetch, and this is what happens on the mornings
 *  the catalogue is unreachable, unparseable, or hands back nothing. That is the
 *  whole of "the cron never depends on the index pull succeeding". */
const carriedWithFallback: ChannelKey[] = [];

for (const key of Object.keys(CHANNELS) as ChannelKey[]) {
  const ch = CHANNELS[key];
  // A frozen channel is not fetched, so it has no dump to require. Its records
  // are carried from the committed catalogue just below.
  if (ch.frozen) continue;
  const p = join(RAW, `${key}.json`);
  if (!existsSync(p)) {
    // A CRON-FETCHED source legitimately has no dump here. It is no longer the
    // normal state — the cron fetches now — but it is the designed failure
    // state, and the response is unchanged: carry its committed records the same
    // way a frozen channel's are carried. Requiring the dump would break the
    // daily build the first morning the catalogue was down; parsing without it
    // would delete every one of its records. This branch is what keeps a bad day
    // upstream costing that day's new entries and nothing else.
    if (ch.cronFetchedWithCarry) {
      carriedWithFallback.push(key);
      continue;
    }
    console.error(
      `✖ raw/${key}.json missing — run \`npm run data:fetch\` first (or \`npm run data:build\`).`,
    );
    process.exit(1);
  }
  if (ch.index) {
    // Structured at source: players, champions, event tag and a start offset are
    // separate fields, so there is no title to parse. Built by its own function.
    //
    // AND EXEMPT FROM THE STALE-RAW GUARD, which is load-bearing rather than a
    // concession — the same call SF6 makes. That guard asks whether a dump could
    // have produced the committed catalogue; for an index source the answer is
    // governed by a third party's catalogue, not by when we last fetched. An
    // event withdrawn upstream would read as staleness and refuse every run
    // thereafter, which is how a guard becomes a flag you learn to pass. Its
    // protection is the add-only merge and the only-grows pin instead, both
    // further down this file.
    // AND AN UNREADABLE DUMP IS AN ABSENT ONE. `readJson` is a bare JSON.parse,
    // so a truncated or malformed dump — this is a third party's output landing
    // in a directory we do not control, and a write cut off midway is a shape we
    // did not anticipate — would THROW here and take the whole parse down. The
    // workflow's `continue-on-error` covers the FETCH step, not this one, so that
    // is a red cron and the end of "the cron never depends on the index pull
    // succeeding". Treated exactly the way a missing dump is treated one branch
    // up: carry the committed records, and say so in report.md.
    //
    // Deliberately NOT extended to the channel dumps below. Those are our own
    // fetcher's output over a source we do parse, an unreadable one means the
    // parse would silently publish a channel short, and it must still fail loudly.
    theaterRaw = await readJson<TheaterRawRecord[]>(p).catch((err: unknown) => {
      theaterUnreadable = true;
      console.warn(
        `  ⚠ raw/${key}.json is present but unreadable (${err instanceof Error ? err.message : String(err)}) — carrying the committed catalogue.`,
      );
      return [];
    });
    // AN EMPTY DUMP IS A CARRY, NOT A REBUILD TO ZERO. `readJson` succeeds on a
    // present-but-empty file, so without this the empty case falls through as a
    // rebuild: `carriedWithFallback` never learns about the source, the pin is
    // never asserted, the committed records are not in `carriedRecords` to be
    // carried, and the run publishes 0 — which trips the channel-collapse guard
    // at 888 → 0, a red cron for a reason nothing in the failure names.
    //
    // The fetcher refuses to write an empty dump over a good one (its full-sweep
    // floor), but this file is a third party's output landing in a directory we
    // do not control, and "the cron never depends on this succeeding" has to hold
    // for the shapes we did not anticipate too.
    if (theaterRaw.length === 0) carriedWithFallback.push(key);
    continue;
  }
  const dump = await readJson<RawVideoRecord[]>(p);
  dumps.set(key, dump);
  rawRecords.push(...dump);
}

// ── source pins (data/source-pins.json) ───────────────────────────────────────
// The carry pin for the index source. A frozen channel pins its count as a
// constant in channels.ts because that count never changes again; the index
// source GROWS, so hand-editing a constant on every refresh would be friction
// that teaches you to ignore it. Every rebuilding run writes this file; a
// carrying run asserts against it. Same guarantee, no hand-edited number.
//
// SINCE THE CRON MOVE, MOST RUNS REBUILD, so the exact-equality assert below is
// no longer reached daily. Its replacement is the only-grows refusal at the
// re-pin, near the end of this file — see the comment there.
const PINS = join(DATA, 'source-pins.json');
const sourcePins: Record<string, number> = await readJson<Record<string, number>>(PINS).catch(
  () => ({}),
);

// ── what the index pull said about ITSELF ─────────────────────────────────────
// Written by scripts/fetch-theater.ts beside its dump, and cleared by that script
// at the START of a pull so a failed run cannot leave yesterday's answers looking
// current. Absent means NO PULL HAPPENED this run — which report.md states rather
// than printing zeros, and which is the difference between "the catalogue had
// nothing new" and "we never asked".
const theaterStats = await readJson<{
  /** 'cursor' = this dump is a DELTA off the front of the feed; 'full' = it
   *  claims to be the whole catalogue. Only a full sweep can support the claim
   *  that a committed record is gone from upstream. */
  mode?: 'cursor' | 'full';
  maxEntryId?: number;
  pagesRead?: number;
  hitBound?: boolean;
  tagged?: number;
  collapsed?: number;
  collapsedTags?: Record<string, number>;
  unresolvableVods?: number;
}>(join(RAW, '.replayTheater.stats.json')).catch(() => null);
/** The committed cursor, read here and rewritten at the end of this file. Every
 *  data/ write is parse's, including this one. */
const CURSOR = join(DATA, 'theater-cursor.json');
const theaterCursor: Record<string, number> = await readJson<Record<string, number>>(CURSOR).catch(
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
const carriedKeys: ChannelKey[] = [...frozenKeys, ...carriedWithFallback];
/** Sources whose committed records are read on EVERY run, carrying or not. The
 *  index source joined this list with add-only: a rebuild now needs the committed
 *  catalogue to merge against, not just to carry from. */
const indexKeys = (Object.keys(CHANNELS) as ChannelKey[]).filter((k) => CHANNELS[k].index);
const committedAll =
  carriedKeys.length > 0 || indexKeys.length > 0
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
// The INDEX source's records were NOT built by a title parse. On a rebuild they
// take the narrow merge (fuse column only), exactly as manual records do, so a
// stale verdict can never rewrite a title, an event or a champion. If the carry
// took the full merge instead, the SAME record would obey different rules
// depending on whether a dump happened to be present — a morning the pull failed
// and a morning it succeeded would publish different bytes from identical inputs.
//
// The add-only merge below preserves that split exactly: survivors are index
// records, so they take the index path, and nothing here touches the frozen one.
const carriedFrozen = carriedRecords.filter((v) => CHANNELS[v.channel as ChannelKey]?.frozen);
const carriedIndexRecords = carriedRecords.filter(
  (v) => !CHANNELS[v.channel as ChannelKey]?.frozen,
);
for (const key of carriedKeys) {
  const frozen = CHANNELS[key].frozen;
  const want = frozen ? frozen.records : sourcePins[key];
  const got = carriedRecords.filter((v) => v.channel === key).length;
  const kind = frozen ? 'Frozen channel' : 'Index source';
  const fix = frozen
    ? 'update frozen.records in scripts/channels.ts'
    : `run \`npm run data:theater\` then \`npm run data:parse\` to rebuild and re-pin, or edit data/source-pins.json`;
  // An index source with no pin yet is its FIRST carry — that only happens
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
//
// THIS ARM ONLY COVERS `carriedRecords`, WHICH IS NOT THE WHOLE CARRY ANY MORE.
// On a REBUILDING run the index source is deliberately absent from `carriedKeys`
// — the add-only merge reads its committed records itself — so its survivors
// reach `records` without passing through here. That half is synthesized where
// the survivors exist, right after the merge runs; see the block below
// `theaterForPublication()`.
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
          : 'carried from the index source — original parse reasons not retained',
      ],
    }));

// ── stale-raw guard ───────────────────────────────────────────────────────────
// DATA-ONLY, per channel. The predicate and its refusal text live in
// scripts/freshness.ts so scripts/e2e.ts can drive them directly; the whole
// argument for the shape — and for why the old mtime arm had to go before the
// Replay Theater intake could join the cron — is in that file's header.
//
// The three exclusions the old id-set arm carried by hand (manual entries,
// frozen channels, the index source) are gone because they are no longer needed:
// a record is judged only against the dump of the channel it names, and
// 'manual', 'proReplays' and 'replayTheater' have no dump in `dumps` at all.
// That last one still holds now the index source is fetched daily — its dump is
// read into `theaterRaw` at the `ch.index` branch above and never enters
// `dumps`, which is what keeps a cursor delta from reading as a stale channel.
if (!process.argv.includes('--allow-stale')) {
  const existing = await readJson<VideoRecord[]>(join(DATA, 'videos.json')).catch(
    () => [] as VideoRecord[],
  );
  for (const [key, dump] of dumps) {
    const ev = staleEvidence(key, dump, existing);
    if (ev) {
      console.error(formatStaleRefusal(key, ev));
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
    // Channel dumps only. The index source is judged by the add-only merge and
    // the only-grows pin instead, because its dump is no longer a claim about
    // the whole intake — see the skip inside the loop.
    const now = countBy(rawRecords);
    const collapsed: string[] = [];
    for (const key of Object.keys(CHANNELS) as ChannelKey[]) {
      // A FROZEN channel has no raw to compare — that is the whole point of
      // freezing one. A NEW channel has no committed history to fall from.
      if (CHANNELS[key].frozen) continue;
      // AN INDEX SOURCE'S DUMP IS A DELTA, so this guard cannot read it. Until
      // 2026-08-31 raw/replayTheater.json was always the whole catalogue and the
      // comparison meant something; the cron reads a cursor now, so an ordinary
      // successful morning produces a dump holding a day's new entries against
      // 888 committed, and this guard would fire on that gap every single day. A
      // guard that fires every run is a flag you learn to pass.
      //
      // WHAT REPLACED IT IS STRICTLY STRONGER, not weaker. The merge is ADD-ONLY:
      // a committed id the dump does not mention is carried untouched, so the
      // published count for this source CANNOT fall on its own. And the re-pin at
      // the end of this file refuses to move the pin downward without
      // --allow-shrink, which catches the case this guard could never catch here
      // anyway — the largest single source VOD behind the intake holds 22 of the
      // 888 records (2.5%), which clears the >20 arm and fails the >10% arm, so
      // one VOD going private passes this guard in silence.
      if (CHANNELS[key].index) continue;
      // A CARRIED source has no raw on this run, so comparing against zero would
      // fire the guard on exactly the mornings the fallback did its job. Its
      // protection is the count pin above, which is strictly stronger: the pin
      // demands an exact number where this only demands "not much smaller".
      // Stated in report.md so the weaker coverage is visible, not assumed.
      if (carriedWithFallback.includes(key)) continue;
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
        : ch.cronFetchedWithCarry
          ? carriedWithFallback.includes(src as ChannelKey)
            ? theaterUnreadable
              ? 'carried (the dump was unreadable)'
              : theaterStats
                ? 'carried (pull found no new tournament entries)'
                : 'carried (no pull this run)'
            : theaterStats?.mode === 'cursor'
              ? 'rebuilt add-only from a cursor delta'
              : 'rebuilt add-only from a full sweep'
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

  // ── index intakes ─────────────────────────────────────────────────────────
  const indexIntakeKeys = (Object.keys(CHANNELS) as ChannelKey[]).filter(
    (k) => CHANNELS[k].cronFetchedWithCarry && records.some((r) => r.channel === k),
  );
  if (indexIntakeKeys.length > 0) {
    lines.push(`## Index intakes (${indexIntakeKeys.length})`);
    lines.push(
      `_Fetched by the daily cron since 2026-09-02, and **add-only**: a committed record is carried whether or not the catalogue still lists it, so this count can only rise. The cron does not depend on the pull succeeding — on any failure there is no dump, the committed records are carried, and the run stays green._`,
      ``,
      `**Guard posture, stated rather than assumed.** The channel-collapse guard is ASLEEP for these: its dump is a cursor DELTA, so comparing it against the committed catalogue would fire every morning. What is awake instead is the add-only merge, which makes the published count non-decreasing by construction, and the pin in \`data/source-pins.json\`, which now refuses to move DOWNWARD without \`--allow-shrink\`.`,
      ``,
    );
    lines.push(
      `| source | records | pin now | this run | pages | new | not in this pull | newest record |`,
      `|---|---|---|---|---|---|---|---|`,
    );
    for (const key of indexIntakeKeys) {
      const n = records.filter((r) => r.channel === key).length;
      const carried = carriedWithFallback.includes(key);
      const dates = records.filter((r) => r.channel === key).map((r) => r.publishedAt);
      const newest = dates.length > 0 ? dates.sort()[dates.length - 1].slice(0, 10) : '—';
      // On a rebuild the pin is rewritten from this run's count, so report the
      // value now in force rather than the one this run happened to check
      // against — the file and the report must not disagree.
      const pin = carried ? (sourcePins[key] ?? '—') : n;
      // THE MODE NAMES THE MODE AND NOTHING ELSE. `hitBound` used to ride along
      // in this cell, which made a per-run event part of a string that is
      // otherwise identical between two cursor mornings. It has its own
      // conditional line under the table now — see below.
      const mode = carried
        ? theaterUnreadable
          ? 'carried (the dump was unreadable)'
          : theaterStats
            ? 'carried (pull found nothing tagged)'
            : 'carried (no pull this run)'
        : theaterStats?.mode === 'cursor'
          ? 'cursor delta'
          : 'rebuilt from a full sweep';
      const survivors = theaterSurvivors.get(key) ?? [];
      const built = n - survivors.length;
      // WHAT "not in this pull" MEANS DEPENDS ON THE MODE, and conflating the two
      // would make this the most misleading number on the page. After a FULL
      // sweep it is "committed records the catalogue no longer lists" — the
      // add-only rule's whole visible output. After a CURSOR run it is every
      // record older than the handful of pages read, i.e. nearly all of them, and
      // it means nothing. So the full number is reported and the cursor number is
      // withheld rather than dressed up.
      const gone = carried || theaterStats?.mode !== 'full' ? '—' : String(survivors.length);
      // AND THE PER-RUN COLUMNS ARE WITHHELD ON A CURSOR MORNING, for the same
      // reason the cross-check block is now rendered from the committed artifact:
      // `pages` and `new` describe this morning's WINDOW, not the corpus. The
      // catalogue takes entries daily, so the window moves daily, so printing
      // them made report.md differ every morning whether or not a record had —
      // which retires the cron's no-change-no-commit rule from the other side and
      // deploys the site every day forever. `gone` was already withheld, one
      // column over, for the neighbouring reason.
      const full = !carried && theaterStats?.mode === 'full';
      lines.push(
        `| \`${key}\` | ${n} | ${pin} | ${mode} | ${full ? (theaterStats?.pagesRead ?? '—') : '—'} | ${full ? built : '—'} | ${gone} | ${newest} |`,
      );
    }
    lines.push(``);
    // NOT PER-RUN NOISE: normally absent, and present only on a morning the
    // cursor could not go quiet inside its page bound. That is a real event and
    // deserves to reach the commit, the same way the collapsed-tag note below
    // does — the guard's rule is that a diff which is ONLY the timestamp is not a
    // change, not that report.md may never change.
    if (theaterStats?.hitBound) {
      lines.push(
        `_⚠ The cursor hit its page bound this run — entries may be unreached. Nothing is lost (the merge is add-only); \`npm run data:theater -- --full\` reconciles._`,
        ``,
      );
    }
    // A CARRY measures none of the intake counts — the dump they would be
    // measured from is absent. Saying so beats printing 0, which reads as
    // "checked, found nothing" when the truth is "not checked this run".
    if (carriedWithFallback.includes('replayTheater')) {
      lines.push(
        theaterUnreadable
          ? `_\`raw/replayTheater.json\` was present but could not be read, so the committed catalogue was carried and the intake counts were not measured. An unreadable dump is treated as an absent one rather than as a parse failure — the cron does not depend on the index pull succeeding — but unlike a quiet catalogue it is worth looking at: the parse log names the error._`
          : theaterStats
            ? `_The pull ran and found no new tournament entries, so the committed catalogue was carried unchanged. ${cursorMoved ? 'The cursor still advanced — a quiet day is the ordinary case here, not a failed one.' : 'The cursor did not move: the catalogue has taken no new 2XKO entry since the last pull — quieter still, and equally ordinary.'}_`
            : `_No pull produced a dump this run, so the committed catalogue was carried and the intake counts were not measured. That is the designed fallback, not a failure of this run: \`npm run data:theater\` refreshes them._`,
        ``,
      );
    } else if (theaterStats && (theaterStats.collapsed ?? 0) > 0) {
      // Collapsed entries are gone from the dump by the time parse sees it, so
      // this is the only place the number can be stated rather than absorbed.
      const pairs = Object.entries(theaterStats.collapsedTags ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([pair, n]) => `${n}× \`${cell(pair)}\``)
        .join(', ');
      lines.push(
        `_Collapsed as double-submitted: **${theaterStats.collapsed}** of ${theaterStats.tagged ?? '?'} tagged — ${pairs}. The same match submitted twice under two tag spellings; one copy kept, chosen on the tag so the survivor does not depend on submission order._`,
        ``,
      );
    }
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

  // ── the second witness ────────────────────────────────────────────────────
  // RENDERED FROM THE COMMITTED ARTIFACT, not from this run. A full sweep
  // measures and writes data/theater-disagreements.json; every run — cursor,
  // carrying, or sweeping — renders this block out of it, so it is byte-identical
  // between sweeps and a quiet morning stays quiet. See WitnessArtifact in
  // scripts/crosscheck.ts for the failure that came of rendering the window.
  //
  // Still emits NOTHING until a sweep has measured something (the block is empty
  // with no `measured`), which keeps the old posture: "not measured this run" is
  // a different statement from "measured, found nothing", and neither is a table
  // of zeros.
  lines.push(...formatCrossCheck(witnessArtifact));

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
/** Detection reports WHICH TEMPLATE matched; a record must carry the REGISTRY id.
 *
 *  The pill templates in assets/fuse-templates are named `<fuseId>-<variant>`
 *  for the era and stream skins the same fuse wears — 2x-assist-evo,
 *  freestyle-restream, double-down-broadcast. That distinction is real and worth
 *  keeping in data/fuses-detected.json, because it says which artwork matched.
 *  It is NOT what belongs on a record: the filter chip, the badge and the stats
 *  all key on data/fuses.json, so a record wearing `2x-assist-evo` is simply
 *  unreachable by the `2x-assist` chip.
 *
 *  22 records shipped that way before this existed, 15 of them invisible to
 *  their own fuse filter. Strips trailing `-<variant>` segments until the
 *  registry recognises the base; an id that never resolves is passed through
 *  untouched so the emit gate refuses it loudly rather than being papered over
 *  here. */
const canonicalFuse = (id: string | null): string | null => {
  if (!id || fuses[id]) return id;
  let base = id;
  while (base.includes('-')) {
    base = base.slice(0, base.lastIndexOf('-'));
    if (fuses[base]) return base;
  }
  return id;
};

/** A NULL FUSE IN AN OVERRIDE IS AN ABSENCE, NOT A VERDICT — so a confident
 *  detection may fill it. A hand-authored fuse still outranks the detector;
 *  a hand-authored *null* never asserted anything to outrank.
 *
 *  Both writers agree on that reading. /api/dev/fuse-orient only ever asked
 *  which title team owns an already-settled pill and documents that "the other
 *  team stays null"; FuseReviewVerdict types its own field "null = this side is
 *  unread". Neither can express "this side has no fuse".
 *
 *  applyFuseSources (the hand-authored path) has always filled a null side for
 *  exactly this reason — "a record-level 'already has a fuse' test would skip
 *  exactly that". mergeCuration did not, so on the parsed path an override
 *  ended the conversation: `{ ...merged, ...ov }` puts the null back over any
 *  detection. 55 records sat half-attributed since 2026-07-07 because of it,
 *  and no amount of re-detection could ever have moved them.
 *
 *  ON UNORDERED PAIRS this deduces rather than guesses. `ok-unordered` means the
 *  PAIR is settled and the owner is not — but here one owner is already known by
 *  hand, so if that fuse is in the pair the remaining member belongs to the other
 *  side. When both members are the same fuse the ordering was never in question.
 *  Anything else is left null for review. */
const fillNullFuseSides = (rec: VideoRecord, det: FuseDetection | undefined): VideoRecord => {
  if (!det || rec.teams.length !== 2) return rec;
  if (det.status !== 'ok' && det.status !== 'ok-unordered') return rec;
  const cur = rec.teams.map((t) => t.fuse);
  // exactly one side known: nothing to fill, or nothing to deduce from
  if (cur.every(Boolean) || cur.every((f) => !f)) return rec;

  const missing = cur[0] ? 1 : 0;
  const known = cur[missing === 0 ? 1 : 0]!;
  const pair = [canonicalFuse(det.left), canonicalFuse(det.right)];

  let fill: string | null = null;
  if (det.status === 'ok') fill = pair[missing];
  else if (pair[0] && pair[0] === pair[1]) fill = pair[0];
  else if (pair.includes(known)) fill = pair.find((f) => f !== known) ?? null;

  if (!fill) return rec;
  return {
    ...rec,
    teams: rec.teams.map((t, i) => (i === missing ? { ...t, fuse: fill } : t)),
  };
};

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
        { ...merged.teams[0], fuse: canonicalFuse(det.left) },
        { ...merged.teams[1], fuse: canonicalFuse(det.right) },
      ],
      ...(det.status === 'ok-unordered' ? { fusesUnordered: true } : {}),
    };
  }
  // overrides.json last — a manual fuse override beats detection. Exclusion
  // entries don't shallow-merge (the record is dropped wholesale below).
  const ov = overrides[rec.id];
  const withOverride = ov && !ov.exclude ? { ...merged, ...ov } : merged;
  return fillNullFuseSides(withOverride, det);
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
        teams: out.teams.map((t, i) =>
          t.fuse === null ? { ...t, fuse: canonicalFuse(pair[i])! } : t,
        ),
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

// ── the index source, merged ADD-ONLY ────────────────────────────────────────
// This is where that rule stops being aspirational.
//
// A rebuild used to REPLACE this source's records wholesale with whatever the
// dump could produce. That was safe while the dump was always the whole
// catalogue, fetched by a human who would notice. It is not safe now, for two
// independent reasons, either sufficient on its own:
//
//  · THE DUMP IS USUALLY A DELTA. The cron runs the cursor, which reads the front
//    of the feed and stops, so `theaterRaw` holds a day's new entries rather than
//    888. Replacing on that would delete the whole committed intake every
//    morning.
//  · A SOURCE VOD GOING PRIVATE DELETES EVERY SEGMENT CUT FROM IT. Measured over
//    the committed catalogue: the intake's 888 records come off 64 VODs and the
//    largest holds 22 of them — 2.5%. That clears the collapse guard's >20
//    absolute arm and fails its >10% arm, so the loss passes in silence, and the
//    pin would then be rewritten downward to match it.
//
// So: BUILT WINS WHERE THE DUMP SPEAKS, COMMITTED SURVIVES WHERE IT DOES NOT. An
// entry the catalogue still lists is re-derived exactly as before — which is what
// keeps a carry and a rebuild byte-identical — and an id the dump does not
// mention is carried untouched rather than dropped.
//
// The survivors are COUNTED, not silent. What the count MEANS depends on the
// pull's mode, though, so report.md states it as a number only after a full
// sweep: on a cursor run "absent from the dump" is the normal condition of every
// record older than a few pages and means nothing at all.
/** intake key → committed records this run's dump did not mention. */
const theaterSurvivors = new Map<ChannelKey, VideoRecord[]>();
/** A FUNCTION, not a const, so it keeps its place in the evaluation order below.
 *  buildTheaterRecords registers the players it meets, and buildManualRecords
 *  registers ITS players as `featured` — so which of the two runs first decides
 *  how a handle appearing in both is flagged. Hoisting this to a const would
 *  quietly swap that order and change published bytes for a reason no reader
 *  would connect to an add-only merge. */
function theaterForPublication(): VideoRecord[] {
  const key: ChannelKey = 'replayTheater';
  if (theaterRaw.length === 0) {
    // No dump at all, or an empty one: the carry. `carriedIndexRecords` already
    // holds this source's committed records, put there by the carry above.
    theaterSurvivors.set(key, []);
    return carriedIndexRecords;
  }
  const built = buildTheaterRecords();
  const builtIds = new Set(built.map((v) => v.id));
  // Read from `committedAll` rather than `carriedRecords`: on a rebuilding run
  // this source is deliberately NOT in `carriedKeys`, so its committed records
  // are not in the carried set — they are exactly the records this merge has to
  // find on its own.
  const survivors = committedAll.filter((v) => v.channel === key && !builtIds.has(v.id));
  theaterSurvivors.set(key, survivors);
  // SORTED WITH THE FETCHER'S OWN COMPARATOR, and this is not cosmetic. Nothing
  // sorts `records` globally in this file — the emitted order IS the assembly
  // order — so a bare `[...built, ...survivors]` would publish the block in
  // concatenation order. A cursor delta holds the NEWEST entries, so they would
  // land in FRONT of the survivors and every cron morning that found anything
  // tagged would rewrite the whole theater block of videos.json and replays.json
  // (emit walks records in order) for a reordering, with zero content changed —
  // a large diff and a deploy for nothing, and a later --full sweep would sort it
  // all back. It would also break the identity claimed two blocks down: a
  // carrying run returns the committed order and a rebuilding run would not.
  //
  // This is fetch-theater.ts's own key (publishedAt, then start offset within the
  // VOD), so carry and rebuild converge on the same bytes.
  return [...built, ...survivors].sort(
    (a, b) =>
      a.publishedAt.localeCompare(b.publishedAt) || (a.startSeconds ?? 0) - (b.startSeconds ?? 0),
  );
}

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
    // Same slot and same merge whether the record was rebuilt from the dump or
    // survived from the committed catalogue, so a morning the pull failed and a
    // morning it succeeded publish identical bytes from identical inputs.
    ...theaterForPublication().map(applyFuseSources),
  ],
  overrides,
).map(normalizePatchVersion);

// THE OTHER HALF OF `carriedLow`, and it exists because the add-only merge moved
// where a carried record comes from. `carriedLow` is derived from
// `carriedRecords`, and on a REBUILDING run this source is not in `carriedKeys`
// at all — so an add-only SURVIVOR lands in `records`, is counted by the
// Summary's low-confidence total, and has no row in the table underneath it. The
// desync is not hypothetical: KtljpBCtoko@4191 is the intake's only
// low-confidence record and it survives every cursor run, which reads as "Low
// confidence: 17" over "## Low-confidence records (16)" on an ordinary morning.
//
// Deduped against `lowReports` because a carrying run has already added the same
// record through `carriedLow`, and the table would otherwise list it twice.
const alreadyReported = new Set(lowReports.map((r) => r.id));
for (const survivors of theaterSurvivors.values()) {
  for (const v of survivors) {
    if (v.parseConfidence !== 'low' || alreadyReported.has(v.id)) continue;
    alreadyReported.add(v.id);
    lowReports.push({
      id: v.id,
      channel: v.channel as ChannelKey,
      title: v.title,
      reasons: ['carried from the index source — original parse reasons not retained'],
    });
  }
}

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

// ── re-pin every source rebuilt from a dump this run — AND IT ONLY GROWS ──────
// Written here, from the FINAL record count, so the number the next carrying run
// checks against is the number actually published — exclusions and all.
//
// THE ONLY-GROWS REFUSAL IS NEW, and it replaces a guarantee this change removes
// rather than adding a belt on top of one. Until 2026-08-31 every cron run was a
// carry, so the pin was ASSERTED daily at exact equality — the strongest check
// this source had, and it ran 365 times a year. From today most runs REBUILD,
// and a rebuilding run does not assert the pin at all: it overwrites it. The only
// remaining check would have been the channel-collapse guard, and that guard is
// measurably blind to the loss that actually happens here — the largest source
// VOD holds 22 of the 888 records (2.5%), which clears its >20 arm and fails its
// >10% one, so one VOD going private passes silently and the pin would be
// rewritten downward to match.
//
// A pin that can only rise turns "records left quietly" into a refusal. When the
// drop is real — an event genuinely withdrawn — it is said once, deliberately,
// with --allow-shrink, and the new number lands in review as a diff.
const rebuiltThisRun = (Object.keys(CHANNELS) as ChannelKey[]).filter(
  (k) => CHANNELS[k].cronFetchedWithCarry && !carriedWithFallback.includes(k),
);
if (rebuiltThisRun.length > 0) {
  const next = { ...sourcePins };
  for (const key of rebuiltThisRun) {
    const got = records.filter((r) => r.channel === key).length;
    const was = sourcePins[key] ?? 0;
    if (got < was && !process.argv.includes('--allow-shrink')) {
      console.error(
        [
          `✖ ${key} would re-pin DOWNWARD: ${was} → ${got}.`,
          ``,
          `  This source is add-only. A committed record is carried whether or not the`,
          `  catalogue still lists it, so the published count cannot fall on its own —`,
          `  which means ${was - got} record(s) were dropped by something in this run, and the`,
          `  collapse guard is not sensitive enough to have caught it (the largest single`,
          `  source VOD here is 22 records, 2.5%, and that guard's band needs >10%).`,
          ``,
          `  Nothing has been written. If the drop is genuine and deliberate:`,
          `    npm run data:parse -- --allow-shrink`,
        ].join('\n'),
      );
      process.exit(1);
    }
    next[key] = got;
  }
  const ordered = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(PINS, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  for (const key of rebuiltThisRun) {
    const was = sourcePins[key];
    console.log(
      `  pinned ${key} at ${ordered[key]}${was !== undefined && was !== ordered[key] ? ` (was ${was})` : ''}`,
    );
  }
}

// ── the cursor (data/theater-cursor.json) ─────────────────────────────────────
// One integer per index source: the highest catalogue entry id ever seen. It is
// what lets tomorrow's fetch read a few pages instead of 71, so it has to survive
// into the REPOSITORY — raw/ is gitignored and CI starts from a fresh checkout
// with no memory but data/.
//
// CONTENT ONLY, no timestamp. report.md's "_Generated_" line already costs the
// cron a suppression rule; a second file that changed every morning would defeat
// that rule from the other side and produce a commit — and a deploy — on days
// when nothing happened.
//
// ONLY GROWS, for the same reason the pin does, and here it matters more: a
// cursor that moved BACKWARD would silently re-admit entries as "new", and a
// cursor that moved back to 0 would turn every cron run into a bounded sweep that
// never goes quiet.
//
// KEYED ON THE PULL HAVING HAPPENED, NOT ON THE REBUILD, and that distinction is
// the whole reason this block reads the stats file rather than `rebuiltThisRun`.
// A cursor pass that returns no TAGGED entries is the ORDINARY case here — tagged
// rows were 899 of the catalogue's 3,547 at first ingest, a quarter, and a quiet
// day has none at all — and it writes an empty dump, which parse correctly treats
// as a carry. `rebuiltThisRun` is then empty. Driving the cursor off that list
// means the most common successful pull on the calendar advances the cursor in
// memory and never persists it, so the next morning re-reads the same pages
// forever and the cursor only ever moves on the days a tournament happens to be
// added. The pull happening is what moves the cursor; whether it produced records
// is a different question.
// WHETHER THE CURSOR MOVED is a fact the report states, so it is measured
// rather than assumed: on 2026-09-02 2XKO's cursor stayed at 488405 while its
// report said it "still advanced".
const cursorMoved =
  !!theaterStats &&
  typeof theaterStats.maxEntryId === 'number' &&
  theaterStats.maxEntryId > (theaterCursor.replayTheater ?? 0);
if (theaterStats && typeof theaterStats.maxEntryId === 'number') {
  const nextCursor: Record<string, number> = { ...theaterCursor };
  for (const key of indexKeys) {
    nextCursor[key] = Math.max(theaterCursor[key] ?? 0, theaterStats.maxEntryId);
  }
  const ordered = Object.fromEntries(
    Object.entries(nextCursor).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(CURSOR, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

// ── the second witness (scripts/crosscheck.ts) ────────────────────────────────
// Reads raw/replayTheater.witness.json — every entry the pull saw, INCLUDING the
// untagged online rows the intake deliberately ignores — and compares the
// catalogue's claim to ours on the videos both sides hold. It writes no field,
// gates nothing, and emits nothing at all on a carrying run: no witness file, no
// block, the same way the carry note says "not measured this run" rather than
// printing zeros.
//
// WHY THE DISAGREEMENTS DO NOT GO IN A REVIEW QUEUE. This repo has no
// data/review-queue.json — its withholding gate is `heldForFootage`, which keeps
// a record OUT of videos.json until a champion verdict arrives, and e2e asserts
// the same shape from the other end (`every emitted id exists in videos.json`).
// A cross-check disagreement is the opposite case: a record we have ALREADY
// published from a tracked channel, which we are not proposing to unpublish on a
// third party's say-so. Withholding it would either break that gate or quietly
// pull a good record off the site, and the catalogue does not outrank a confident
// parse. So it gets its own artifact — published, contested, both claims recorded
// — and e2e gates the MIRROR of the withholding rule: every row here MUST still
// be in videos.json.
//
// THE PLAYER KEY IS READ, NOT RE-RESOLVED, on our side: TeamPlayer.id already IS
// what resolvePlayer decided. The catalogue's handles do need resolving, so they
// go through a READ-ONLY twin of that function — registry alias, then slugify.
// resolvePlayer itself registers what it meets, and a measurement must not mint
// players out of a catalogue we are only reading.
const witness = await readJson<WitnessFile>(join(RAW, 'replayTheater.witness.json')).catch(
  () => null,
);
/** The FINAL registry, including this run's discoveries and the overrides pass —
 *  built here rather than reusing `playerByAlias`, which is the seed snapshot
 *  taken before any of that happened. */
const finalPlayerByAlias = new Map<string, string>();
for (const p of Object.values(players)) {
  finalPlayerByAlias.set(p.handle.toLowerCase(), p.id);
  for (const a of p.extra.aliases) finalPlayerByAlias.set(a.toLowerCase(), p.id);
}
const witnessResult = witness
  ? crossCheck(
      witness,
      records,
      champByAlias,
      (h) => {
        const n = h.trim();
        return finalPlayerByAlias.get(n.toLowerCase()) ?? slugify(n);
      },
      (h) => h.replace(THEATER_SPONSOR, ''),
      (str) =>
        str
          .split(CHANNELS.replayTheater.playerSep)
          .map((x) => x.trim())
          .filter(Boolean),
      // TWO, NOT FOUR. The schema has four champion columns, but this game's
      // ceiling is lower than its schema and it is written down: README, "Two
      // champions per side, always" — the index cannot express a within-set
      // counter-pick. A side of ours longer than two is `cannotWitness`.
      2,
    )
  : null;
const witnessPath = join(DATA, 'theater-disagreements.json');
let witnessArtifact = await readJson<WitnessArtifact>(witnessPath).catch(
  () => ({ disagreements: [] }) as WitnessArtifact,
);
// ONLY A FULL SWEEP WRITES HERE. A cursor pull sees a few hundred catalogue rows
// — whatever is at the front of the feed this morning — so its reading is a
// different WINDOW, not a different corpus. Letting it write threw away the full
// sweep's rows on the first quiet morning (a delta that compared a few dozen
// records and found nothing overwrote them with []) and flapped them back the
// next time a delta happened to contain one. A CARRYING run never reached this
// write at all — there is no witness file to measure, so `witnessResult` is null
// and the rows survive by accident of that. A cursor run does reach it, and took
// the same erasure through the front door.
if (witnessResult && witness?.mode === 'full') {
  witnessArtifact = {
    measured: {
      // The catalogue's own high-water entry id names the sweep. A timestamp
      // would name it too, and would be the exact churn this is fixing. Both
      // files are written by the same pull with the same value; the stats file is
      // the one report.md already reads.
      atEntryId: theaterStats?.maxEntryId ?? witness.maxEntryId ?? 0,
      compared: witnessResult.compared,
      unmatched: witnessResult.unmatched,
      segmented: witnessResult.segmented,
      unalignable: witnessResult.unalignable,
      players: witnessResult.players,
      characters: witnessResult.characters,
    },
    disagreements: witnessResult.disagreements,
  };
  await writeFile(witnessPath, JSON.stringify(witnessArtifact, null, 2) + '\n', 'utf8');
} else if (!existsSync(witnessPath)) {
  // The cron NAMES this path in its `git add`, and `git add` on a path that does
  // not exist fails under `set -e` and aborts the whole commit step. Seeded when
  // absent, never rewritten when present.
  await writeFile(witnessPath, JSON.stringify({ disagreements: [] }, null, 2) + '\n', 'utf8');
}
// The cursor window's reading still gets said out loud, where it is useful and
// costs nothing — it just does not reach a committed file.
if (witnessResult && witness?.mode !== 'full') {
  const cc = witnessResult.characters;
  console.log(
    `  cross-check (cursor window, not committed): ${witnessResult.compared} record(s), ` +
      `${witnessResult.players.both} both-handles, ${cc.agree}/${cc.sides} champion sides agree, ` +
      `${witnessResult.disagreements.length} disagreement(s)`,
  );
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

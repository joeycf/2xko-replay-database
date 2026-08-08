// Generic-schema emitter (Phase 3): maps the rich pipeline artifacts onto the
// engine's data contract and writes the four app-consumed files. Called by
// parse.ts at the end of every run, and runnable standalone
// (`npm run data:emit`) to re-derive the generic files from the COMMITTED
// videos.json + registries with no YouTube access — deterministic either way
// (the stats math is shared: scripts/stats.ts).
//
//   data/videos.json      (rich, committed)   → INPUT — stays the substrate
//                                               for the fuse pipeline + dev
//                                               curation tooling
//   data/characters.json  (generic Character[]) → INPUT (scripts/champions.ts
//                                               owns it) — counted + asserted
//   data/players.json     (generic Player[])  → INPUT (parse.ts round-trips it)
//   data/replays.json     (generic Replay[])  → EMITTED (compact — this is the
//                                               client-fetched whale file)
//   data/stats.json       (KnownStats + fuse extras) → EMITTED
//   data/summary.json     (the shell selector's card) → EMITTED (Phase 6)
//   public/data/{replays,summary}.json        → EMITTED copies (gitignored; the
//                                               build's build:before hook does
//                                               the same for Vercel, which
//                                               never runs the pipeline)
//
// 2XKO extension data NEVER enters the generic schema: fuse analytics ride as
// extra stats keys (fuseUsage / fuseByPatch / totals.withFuse) consumed by the
// app-side useFuses; per-video fuse tags, matchType, tournament/round remain
// rich-only fields (videos.json).

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStats, sort1, sort2 } from './stats';
import { loadPatchTable } from './patches';
import type { Champion, Player, VideoRecord } from '../types/index';

// ── the emitted generic shapes (mirror @engine/types — the pipeline can't
//    resolve the Nuxt alias, so the contract is restated here) ───────────────
export interface GenericSide {
  player: string;
  players?: string[];
  characters: string[];
}
export interface GenericReplay {
  id: string;
  sides: [GenericSide, GenericSide];
  date: string;
  patch?: string;
  source: string;
  title: string;
  views?: number;
  thumb?: string;
  durationSec?: number;
  /** 2XKO EXTENSION fields (the engine never reads them; the app's fuse facet
   *  + badge overrides do): per-side fuse ids in sides order, and the
   *  detection-confidence flag for pairs whose side attribution is unknown.
   *  Present only when at least one side has a fuse. */
  fuses?: [string | null, string | null];
  fusesUnordered?: true;
}

/** The game's identity as it appears in data/summary.json — the shell selector
 *  keys its cards on it. Restated here for the same reason the generic shapes
 *  above are: the pipeline can't resolve the Nuxt `@engine`/app.config graph.
 *  app/app.config.ts is the authority; the shell's verify:cutover asserts these
 *  two values against its own GAMES table, so a drift fails at the apex. */
const GAME_ID = '2xko';
const GAME_NAME = '2XKO';

/** Era → the display/patch key the whole UI keys on ('Beta', 'S0', 'S1', …).
 *  Matches the shipped stats-page chip labels (eraLabel). */
const eraKey = (season: number | null): string => (season === null ? 'Beta' : `S${season}`);

/** bySeason keys ('beta' | '0' | '1' | …) in timeline order: beta → 0 → 1 → 2.
 *  byPatchUsage key ORDER is the engine's timeline (JSON preserves insertion). */
const timeline = (keys: string[]): string[] =>
  [...keys].sort((x, y) => (x === 'beta' ? -1 : y === 'beta' ? 1 : Number(x) - Number(y)));

const remapEras = (
  o: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> =>
  Object.fromEntries(
    timeline(Object.keys(o)).map((k) => [eraKey(k === 'beta' ? null : Number(k)), sort1(o[k])]),
  );

function toSide(t: VideoRecord['teams'][number]): GenericSide {
  const ids = t.players.map((p) => p.id);
  return {
    player: ids[0] ?? '',
    ...(ids.length > 1 ? { players: ids } : {}),
    characters: t.characters,
  };
}

function toReplay(v: VideoRecord): GenericReplay {
  // structurally unparsed records (teams !== 2, e.g. a stray non-2XKO upload)
  // keep their slot with empty sides — count parity beats prettiness; the
  // engine renders placeholder badges and no player names for them
  const sides: [GenericSide, GenericSide] =
    v.teams.length === 2
      ? [toSide(v.teams[0]), toSide(v.teams[1])]
      : [
          { player: '', characters: [] },
          { player: '', characters: [] },
        ];
  const fuseA = v.teams[0]?.fuse ?? null;
  const fuseB = v.teams[1]?.fuse ?? null;
  return {
    id: v.id,
    sides,
    date: v.publishedAt,
    // fine patch token when the boundary derivation produced one; the bare era
    // token means "season known, patch unknown" (Beta era, or an explicit
    // season that contradicted the date) — the engine's patchGroups facet
    // gives both the right semantics (v0.6.0)
    patch: v.patchVersion ?? eraKey(v.season),
    source: v.channel,
    title: v.title,
    views: v.viewCount,
    thumb: v.thumbnail,
    ...(v.durationSec > 0 ? { durationSec: v.durationSec } : {}),
    ...(fuseA || fuseB ? { fuses: [fuseA, fuseB] as [string | null, string | null] } : {}),
    ...(v.fusesUnordered ? { fusesUnordered: true as const } : {}),
  };
}

/** Overrides-driven exclusions (`{ "<id>": { "exclude": true } }`): drops
 *  records the site must not carry (e.g. a stray non-2XKO upload a tracked
 *  channel published). Shared by parse.ts (future runs regenerate videos.json
 *  without them) and the standalone emit (applies them to the committed
 *  substrate immediately). */
export function applyExclusions(
  records: VideoRecord[],
  overrides: Record<string, Partial<VideoRecord> & { exclude?: boolean }>,
): VideoRecord[] {
  const excluded = new Set(
    Object.entries(overrides)
      .filter(([, ov]) => ov.exclude === true)
      .map(([id]) => id),
  );
  if (excluded.size === 0) return records;
  const out = records.filter((v) => !excluded.has(v.id));
  console.log(
    `  overrides.json excludes ${records.length - out.length} record(s): ${[...excluded].filter((id) => records.some((v) => v.id === id)).join(', ')}`,
  );
  return out;
}

export async function emitGeneric(opts: {
  records: VideoRecord[];
  characters: Champion[];
  players: Player[];
  root: string;
}): Promise<void> {
  const { records, characters, players, root } = opts;
  const DATA = join(root, 'data');

  const stats = buildStats(records);
  const replays = records.map(toReplay);

  // KnownStats + the 2XKO fuse extension keys (engine ignores unknown keys;
  // app-side useFuses consumes them).
  const genericStats = {
    totals: {
      replays: stats.totals.videos,
      characters: characters.length,
      players: players.length,
      byPatch: Object.fromEntries(
        timeline(Object.keys(stats.totals.bySeason)).map((k) => [
          eraKey(k === 'beta' ? null : Number(k)),
          stats.totals.bySeason[k],
        ]),
      ),
      withFuse: stats.totals.withFuse,
    },
    characterUsage: sort1(stats.characterUsage),
    byPatchUsage: remapEras(stats.bySeasonUsage),
    pairingUsage: sort1(stats.pairingUsage),
    playerCharacters: sort2(stats.playerCharacters!),
    playerPairings: sort2(stats.playerPairings!),
    matchupMatrix: sort2(stats.matchupMatrix!),
    fuseUsage: sort1(stats.fuseUsage),
    fuseByPatch: remapEras(stats.fuseBySeason),
  };

  // ── count-parity assertions (the Phase-3 discipline: drift = hard fail) ──
  if (replays.length !== records.length)
    throw new Error(`emit: replay count ${replays.length} !== video count ${records.length}`);
  if (!replays.every((r) => r.sides.length === 2))
    throw new Error('emit: a replay lost its two-sides invariant');
  if (genericStats.totals.replays !== records.length)
    throw new Error('emit: stats.totals.replays drifted from the record count');

  // ── per-side character gates ────────────────────────────────────────────
  // There was no per-side gate here at all: toSide passed `characters` through
  // at any length, so a side could reference a champion that is not on the
  // roster, or name one twice, and nothing downstream would notice.
  //
  // ZERO IS A WARNING, NOT A THROW, and that is measured rather than timid.
  // Two shipped records already have an empty side (VjA1VOogCog, 8_JJkHTB-UA —
  // both low-confidence parses), and data/manual-videos.json documents `[]` as a
  // legitimate authoring state paired with a `todo`. A hard fail would break the
  // 06:17 UTC refresh on its first run to punish a state the pipeline already
  // supports. Counting it keeps it visible; the review surface is where it gets
  // fixed. This is deliberately NOT Tekken's `characters.length < 1` throw — that
  // repo has no hand-authored records and no such state to protect.
  const rosterIds = new Set(characters.map((c) => c.id));
  const emptySides: string[] = [];
  for (const r of replays) {
    for (const s of r.sides) {
      if (s.characters.length === 0) {
        emptySides.push(r.id);
        continue;
      }
      // a side is a set — a duo never fields the same champion twice, and a set
      // union is deduped at build time. A repeat means a merge went wrong.
      if (new Set(s.characters).size !== s.characters.length)
        throw new Error(`emit: ${r.id} side repeats a character (${s.characters.join(',')})`);
      for (const c of s.characters)
        if (!rosterIds.has(c)) throw new Error(`emit: ${r.id} references unknown character '${c}'`);
    }
  }
  if (emptySides.length > 0)
    console.log(
      `  ⚠ ${emptySides.length} side(s) with no champion (unresolved parses): ${[...new Set(emptySides)].join(', ')}`,
    );

  // The union's own arithmetic. characterUsage counts v.allCharacters — the
  // PER-VIDEO DEDUPED union — so the expected total is the union over each
  // record's sides, NOT the sum of side lengths. Those diverge exactly when both
  // sides field the same champion, which is common here and rare in a 1v1 game:
  // the sibling pipelines' `sum of side lengths` form gives 21,730 against an
  // actual 19,563 and would throw on run one. Equality is what ties the usage
  // bars, the per-patch timeline and the player tables to one denominator.
  const usageTotal = Object.values(genericStats.characterUsage).reduce((a, b) => a + b, 0);
  const expectedUsage = replays.reduce(
    (n, r) => n + new Set(r.sides.flatMap((s) => s.characters)).size,
    0,
  );
  if (usageTotal !== expectedUsage)
    throw new Error(
      `emit: characterUsage sums to ${usageTotal}, expected ${expectedUsage} per-video character appearances`,
    );

  // Pairing stats deliberately count a side only when its union is EXACTLY two
  // (scripts/stats.ts) — a set VOD whose duo changed lists every champion it
  // fielded, and naive C(n,2) over [a,b,c] would mint a pairing that never
  // played. That exclusion has always been silent; this surfaces its size.
  const oversized = records.flatMap((v) =>
    v.teams.filter((t) => t.characters.length > 2).map(() => v.id),
  );
  if (oversized.length > 0)
    console.log(
      `  ℹ ${oversized.length} oversized side(s) counted in usage but excluded from pairing stats: ${[...new Set(oversized)].join(', ')}`,
    );
  // every emitted patch token must be an era key or a declared boundary
  // version, and a fine token's release-date season must equal the record's —
  // the invariant the grouped facet's counts depend on
  const patchTable = loadPatchTable(DATA);
  const knownVersions = new Set(patchTable.patches.map((p) => p.version));
  for (let i = 0; i < replays.length; i++) {
    const token = replays[i].patch!;
    if (/^(Beta|S\d+)$/.test(token)) continue;
    if (!knownVersions.has(token))
      throw new Error(`emit: ${replays[i].id} carries unknown patch token "${token}"`);
    if (patchTable.seasonOfPatch(token) !== records[i].season)
      throw new Error(
        `emit: ${replays[i].id} patch ${token} contradicts season ${records[i].season}`,
      );
  }

  // ── the shell selector's payload (Phase 6) ───────────────────────────────
  // Tiny, and fetched same-origin by the apex selector through its /2xko
  // rewrite — so it has to be COMMITTED (Vercel never runs the pipeline);
  // data/summary.json is the committed artifact and the build's build:before
  // hook copies it into public/data/ alongside the whale.
  //
  // `updated` is the newest replay's DATE, never build time. A build timestamp
  // would rewrite this file on a zero-new-video day and defeat the cron's
  // commit guard, turning every no-op day into a commit and a deploy.
  const newest = records.reduce((max, v) => (v.publishedAt > max ? v.publishedAt : max), '');
  // The counts are READ FROM the stats artifact rather than re-derived, so the
  // selector and the site's own stats page cannot disagree by construction.
  // (Re-deriving them here and asserting equality would compare `players.length`
  // with `players.length` — a throw that can never fire is not a gate.) What
  // follows are the two comparisons that CAN fire; `updated` gets its real teeth
  // in scripts/e2e.ts, which recomputes it from the substrate independently.
  const summary = {
    game: GAME_ID,
    name: GAME_NAME,
    replays: genericStats.totals.replays,
    players: genericStats.totals.players,
    characters: genericStats.totals.characters,
    updated: newest.slice(0, 10),
  };
  if (summary.replays !== replays.length)
    throw new Error(
      `emit: summary.replays ${summary.replays} !== emitted replay count ${replays.length}`,
    );
  if (summary.players < 1 || summary.characters < 1)
    throw new Error(
      `emit: summary has an empty registry (players ${summary.players}, characters ${summary.characters})`,
    );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(summary.updated))
    throw new Error(`emit: summary.updated is not a replay date ("${summary.updated}")`);

  await writeFile(join(DATA, 'replays.json'), JSON.stringify(replays) + '\n', 'utf8');
  await writeFile(join(DATA, 'stats.json'), JSON.stringify(genericStats, null, 2) + '\n', 'utf8');
  await writeFile(join(DATA, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  // the UI's season→patch hierarchy, derived from the SAME authority as the
  // tokens above so config and derivation can never drift (app.config imports
  // this committed artifact — Vercel builds never run the pipeline)
  await writeFile(
    join(DATA, 'patchGroups.json'),
    JSON.stringify(patchTable.buildPatchGroups(), null, 2) + '\n',
    'utf8',
  );

  // local-dev convenience copy (gitignored) — the build's build:before hook
  // performs the same copy on Vercel
  const pub = join(root, 'public/data');
  mkdirSync(pub, { recursive: true });
  await writeFile(join(pub, 'replays.json'), JSON.stringify(replays) + '\n', 'utf8');
  await writeFile(join(pub, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  console.log(
    `✔ Emitted generic schema → data/replays.json (${replays.length}) + data/stats.json ` +
      `(characters ${characters.length} · players ${players.length} · patches ${Object.keys(genericStats.byPatchUsage).join(',')})`,
  );
  console.log(`  summary.json → ${summary.replays} replays, newest ${summary.updated}`);
}

// ── standalone: re-derive generic files from the committed artifacts ─────────
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;
  if (!existsSync(join(root, 'data/videos.json'))) {
    console.error('✖ data/videos.json missing — run the pipeline first.');
    process.exit(1);
  }
  const all = await readJson<VideoRecord[]>(join(root, 'data/videos.json'));
  const overrides = await readJson<Record<string, Partial<VideoRecord> & { exclude?: boolean }>>(
    join(root, 'data/overrides.json'),
  ).catch(() => ({}));
  const records = applyExclusions(all, overrides);
  const characters = await readJson<Champion[]>(join(root, 'data/characters.json'));
  const players = await readJson<Player[]>(join(root, 'data/players.json'));
  await emitGeneric({ records, characters, players, root });
}

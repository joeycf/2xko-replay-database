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
//   public/data/replays.json                  → EMITTED copy (gitignored; the
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
}

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
  return {
    id: v.id,
    sides,
    date: v.publishedAt,
    patch: eraKey(v.season),
    source: v.channel,
    title: v.title,
    views: v.viewCount,
    thumb: v.thumbnail,
    ...(v.durationSec > 0 ? { durationSec: v.durationSec } : {}),
  };
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

  await writeFile(join(DATA, 'replays.json'), JSON.stringify(replays) + '\n', 'utf8');
  await writeFile(join(DATA, 'stats.json'), JSON.stringify(genericStats, null, 2) + '\n', 'utf8');

  // local-dev convenience copy (gitignored) — the build's build:before hook
  // performs the same copy on Vercel
  const pub = join(root, 'public/data');
  mkdirSync(pub, { recursive: true });
  await writeFile(join(pub, 'replays.json'), JSON.stringify(replays) + '\n', 'utf8');

  console.log(
    `✔ Emitted generic schema → data/replays.json (${replays.length}) + data/stats.json ` +
      `(characters ${characters.length} · players ${players.length} · patches ${Object.keys(genericStats.byPatchUsage).join(',')})`,
  );
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
  const records = await readJson<VideoRecord[]>(join(root, 'data/videos.json'));
  const characters = await readJson<Champion[]>(join(root, 'data/characters.json'));
  const players = await readJson<Player[]>(join(root, 'data/players.json'));
  await emitGeneric({ records, characters, players, root });
}

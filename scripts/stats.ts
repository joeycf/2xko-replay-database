// Aggregate stats over parsed VideoRecords — extracted VERBATIM from
// scripts/parse.ts (Stage 2) so parse.ts and the standalone generic emitter
// (scripts/emit.ts) derive IDENTICAL numbers from the same records. Any change
// to counting rules happens here, once.

import type { Stats, VideoRecord } from '../types/index';

const inc = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);

export function buildStats(records: VideoRecord[]): Stats {
  const stats: Stats = {
    characterUsage: {},
    pairingUsage: {},
    bySeasonUsage: {},
    totals: {
      videos: records.length,
      bySeason: {},
      // videos with ≥1 detected/overridden team fuse — the UI's coverage line
      withFuse: records.filter((v) => v.teams.some((t) => t.fuse)).length,
    },
    fuseUsage: {},
    fuseBySeason: {},
    playerCharacters: {},
    playerPairings: {},
    matchupMatrix: {},
  };
  for (const v of records) {
    for (const c of v.allCharacters) inc(stats.characterUsage, c); // per-video dedup
    // season === null → the pre-Season-0 "beta" era; timeline order is beta → 0 → 1 → 2
    const sk = v.season === null ? 'beta' : String(v.season);
    inc(stats.totals.bySeason, sk);
    stats.bySeasonUsage[sk] ??= {};
    for (const c of v.allCharacters) inc(stats.bySeasonUsage[sk], c);
    for (const t of v.teams) {
      if (t.fuse) {
        inc(stats.fuseUsage, t.fuse);
        stats.fuseBySeason[sk] ??= {};
        inc(stats.fuseBySeason[sk], t.fuse);
      }
      const pairKey = t.characters.length === 2 ? [...t.characters].sort().join('|') : null;
      if (pairKey) inc(stats.pairingUsage, pairKey); // per team occurrence
      for (const p of t.players) {
        stats.playerCharacters![p.id] ??= {};
        for (const c of t.characters) inc(stats.playerCharacters![p.id], c);
        if (pairKey) {
          stats.playerPairings![p.id] ??= {};
          inc(stats.playerPairings![p.id], pairKey);
        }
      }
    }
    if (v.teams.length === 2 && v.teams.every((t) => t.characters.length === 2)) {
      const a = [...v.teams[0].characters].sort().join('|');
      const b = [...v.teams[1].characters].sort().join('|');
      stats.matchupMatrix![a] ??= {};
      inc(stats.matchupMatrix![a], b);
      stats.matchupMatrix![b] ??= {};
      inc(stats.matchupMatrix![b], a);
    }
  }
  return stats;
}

// Deterministic key ordering for stable diffs.
export const sort1 = (o: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
export const sort2 = (
  o: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> =>
  Object.fromEntries(
    Object.entries(o)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sort1(v)]),
  );

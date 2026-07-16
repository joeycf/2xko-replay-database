import fusesData from '~~/data/fuses.json';
import statsData from '~~/data/stats.json';
import type { Fuse } from '~~/types';

// Static imports like the registries: tiny, synchronously available — fuse
// panels prerender with real numbers and never touch replays.json. stats.json
// is the generic KnownStats file; the fuse keys are 2XKO EXTENSION data the
// engine ignores (fuseUsage / fuseByPatch / totals.withFuse — emitted by
// scripts/emit.ts, patch keys = the engine's 'Beta'/'S0'/… timeline).
interface FuseStats {
  totals: { replays: number; withFuse: number };
  fuseUsage: Record<string, number>;
  fuseByPatch: Record<string, Record<string, number>>;
}

const registry = fusesData as unknown as Record<string, Fuse>;
const stats = statsData as unknown as FuseStats;

export interface DetectedFuse extends Fuse {
  /** team picks across the detected set (stats.fuseUsage) */
  count: number;
}

/** Fuses with ≥1 detected team pick, ranked by usage — the UI never shows
 *  chips for fuses with zero data (sidekick/fury/pulse today). */
const rankFuses = (usage: Record<string, number>): DetectedFuse[] =>
  Object.entries(usage)
    .filter(([id]) => registry[id])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ ...registry[id]!, count }));

const detected = rankFuses(stats.fuseUsage);
/** patch keys in timeline order (emit.ts insertion order: Beta → S0 → S1 → …) */
const patches = Object.keys(stats.fuseByPatch);
const detectedByPatch = new Map(patches.map((p) => [p, rankFuses(stats.fuseByPatch[p] ?? {})]));

const fullList = Object.values(registry).sort(
  (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
);

export const useFuses = () => ({
  detected,
  /** the whole catalog (active first) — authoring UIs offer every fuse, not just detected ones */
  list: fullList,
  /** patch keys with fuse data, timeline order — feeds the era small-multiples */
  patches,
  /** raw per-patch usage (2XKO extension stats) */
  fuseByPatch: stats.fuseByPatch,
  /** ranked detected fuses for an engine patch key ('S1'), or all-time when null */
  detectedFor: (patch: string | null): DetectedFuse[] =>
    patch === null ? detected : (detectedByPatch.get(patch) ?? []),
  byId: (id: string): Fuse | undefined => registry[id],
  fuseName: (id: string): string => registry[id]?.name ?? id,
  fuseAccent: (id: string): string => registry[id]?.accent ?? '#8B93A8',
  /** the coverage honesty line: detections cover a subset of the catalog */
  coverage: {
    withFuse: stats.totals.withFuse,
    total: stats.totals.replays,
  },
});

import fusesData from '~~/data/fuses.json';
import statsData from '~~/data/stats.json';
import type { Fuse, Stats } from '~~/types';

// Static imports like useStats: tiny registries, synchronously available —
// fuse chips/panels prerender with real numbers and never touch videos.json.
const registry = fusesData as unknown as Record<string, Fuse>;
const stats = statsData as unknown as Stats;

export interface DetectedFuse extends Fuse {
  /** team picks across the detected set (stats.fuseUsage) */
  count: number;
}

/** Fuses with ≥1 detected team pick, ranked by usage — the UI never shows
 *  chips for fuses with zero data (sidekick/teamfight/fury/pulse today). */
const rankFuses = (usage: Record<string, number>): DetectedFuse[] =>
  Object.entries(usage)
    .filter(([id]) => registry[id])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ ...registry[id]!, count }));

const detected = rankFuses(stats.fuseUsage);
const detectedByEra = new Map(
  Object.keys(stats.fuseBySeason).map((e) => [e, rankFuses(stats.fuseBySeason[e] ?? {})])
);

const fullList = Object.values(registry).sort(
  (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
);

export const useFuses = () => ({
  detected,
  /** the whole catalog (active first) — authoring UIs offer every fuse, not just detected ones */
  list: fullList,
  /** ranked detected fuses for an era key, or all-time when null */
  detectedFor: (era: string | null): DetectedFuse[] =>
    era === null ? detected : (detectedByEra.get(era) ?? []),
  byId: (id: string): Fuse | undefined => registry[id],
  fuseName: (id: string): string => registry[id]?.name ?? id,
  fuseAccent: (id: string): string => registry[id]?.accent ?? '#8B93A8',
  /** the Browse facet's honesty line: detections cover a subset of the catalog */
  coverage: {
    withFuse: stats.totals.withFuse,
    total: stats.totals.videos
  }
});

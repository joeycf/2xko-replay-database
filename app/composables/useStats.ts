import championsData from '~~/data/champions.json'
import statsData from '~~/data/stats.json'
import type { Stats } from '~~/types'

// Static imports: small registries, bundled once, synchronously available —
// /stats prerenders with real numbers and never touches videos.json.
const stats = statsData as unknown as Stats
const championIds = Object.keys(championsData)

export interface UsageRow {
  id: string
  value: number
  /** bar width %, design rule: max(4, …) for non-zero values */
  pct: number
  rank: number
}

export interface PairRow {
  /** sorted "a|b" key as stored in pairingUsage */
  key: string
  a: string
  b: string
  value: number
  pct: number
  rank: number
}

/** Era keys in timeline order: beta → 0 → 1 → 2 → … */
const eras = Object.keys(stats.bySeasonUsage).sort((x, y) =>
  x === 'beta' ? -1 : y === 'beta' ? 1 : Number(x) - Number(y),
)

export function eraLabel(era: string | null): string {
  if (era === null) return 'All seasons'
  return era === 'beta' ? 'Beta' : `S${era}`
}

function rankRows(usage: Record<string, number>): UsageRow[] {
  const rows = championIds
    .map((id) => ({ id, value: usage[id] ?? 0 }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
  const max = rows[0]?.value || 1
  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    pct: r.value === 0 ? 0 : Math.max(4, Math.round((r.value / max) * 100)),
  }))
}

const usageAllTime = rankRows(stats.characterUsage)
const usageByEra = new Map(eras.map((e) => [e, rankRows(stats.bySeasonUsage[e] ?? {})]))

const pairsRanked: PairRow[] = Object.entries(stats.pairingUsage)
  .map(([key, value]) => {
    const [a = '', b = ''] = key.split('|')
    return { key, a, b, value }
  })
  .sort((x, y) => y.value - x.value || x.key.localeCompare(y.key))
  .map((p, i, arr) => ({
    ...p,
    rank: i + 1,
    pct: Math.max(6, Math.round((p.value / (arr[0]?.value || 1)) * 100)),
  }))

/** Arbitrary usage record (e.g. playerCharacters[id]) → ranked UsageRow[]. */
export function toUsageRows(usage: Record<string, number> | undefined): UsageRow[] {
  const rows = Object.entries(usage ?? {})
    .map(([id, value]) => ({ id, value }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
  const max = rows[0]?.value || 1
  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    pct: r.value === 0 ? 0 : Math.max(4, Math.round((r.value / max) * 100)),
  }))
}

/** Arbitrary pairing record (e.g. playerPairings[id]) → ranked PairRow[]. */
export function toPairRows(pairings: Record<string, number> | undefined): PairRow[] {
  const rows = Object.entries(pairings ?? {})
    .map(([key, value]) => {
      const [a = '', b = ''] = key.split('|')
      return { key, a, b, value }
    })
    .sort((x, y) => y.value - x.value || x.key.localeCompare(y.key))
  const max = rows[0]?.value || 1
  return rows.map((p, i) => ({
    ...p,
    rank: i + 1,
    pct: Math.max(6, Math.round((p.value / max) * 100)),
  }))
}

/** All pairings featuring a champion, re-normalized to the subset max. */
export function pairsFor(championId: string): PairRow[] {
  const subset = pairsRanked.filter((p) => p.a === championId || p.b === championId)
  const max = subset[0]?.value || 1
  return subset.map((p, i) => ({
    ...p,
    rank: i + 1,
    pct: Math.max(6, Math.round((p.value / max) * 100)),
  }))
}

const maxPairing = pairsRanked[0]?.value ?? 1

/** era → championId → rank (1-based, among all champions by that era's usage) */
const eraRanks: Record<string, Record<string, number>> = Object.fromEntries(
  eras.map((e) => [
    e,
    Object.fromEntries((usageByEra.get(e) ?? []).map((r) => [r.id, r.rank])),
  ]),
)

export function useStats() {
  return {
    stats: computed(() => stats),
    totals: stats.totals,
    eras,
    /** ranked usage rows for an era key, or all-time when null */
    usageFor: (era: string | null): UsageRow[] =>
      era === null ? usageAllTime : (usageByEra.get(era) ?? []),
    pairsRanked,
    pairCount: (a: string, b: string): number =>
      stats.pairingUsage[[a, b].sort().join('|')] ?? 0,
    maxPairing,
    /** heatmap cell alpha per the design: 0.05 + intensity × 0.9 (0.03 floor for zero) */
    pairingAlpha: (a: string, b: string): number => {
      if (a === b) return 0
      const n = stats.pairingUsage[[a, b].sort().join('|')] ?? 0
      return n === 0 ? 0.03 : Math.min(0.95, 0.05 + (n / maxPairing) * 0.9)
    },
    eraRanks,
  }
}

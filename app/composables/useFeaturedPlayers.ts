import type { Player } from '~~/types'

export interface RankedPlayer extends Player {
  /** ≈ number of videos the player appears in (derived from stats.playerCharacters). */
  appearances: number
}

/**
 * Featured = verified === true OR appearances ≥ FEATURED_MIN_APPEARANCES.
 * stats.playerCharacters increments once per (player × character) per team, and
 * teams have two characters, so summing and halving ≈ video appearances.
 */
export function useFeaturedPlayers() {
  const { list } = usePlayers()
  const { stats } = useStats()

  const ranked = computed<RankedPlayer[]>(() => {
    const pc = stats.value.playerCharacters ?? {}
    return list.value
      .map((p) => {
        const sum = Object.values(pc[p.id] ?? {}).reduce((n, x) => n + x, 0)
        return { ...p, appearances: Math.round(sum / 2) }
      })
      .sort((a, b) => b.appearances - a.appearances)
  })

  const featured = computed<RankedPlayer[]>(() =>
    ranked.value
      .filter((p) => p.verified || p.appearances >= FEATURED_MIN_APPEARANCES)
      .sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || b.appearances - a.appearances),
  )

  /** Everyone below the featured bar — mostly 1–2 appearance names, so tiebreak alphabetically. */
  const rest = computed<RankedPlayer[]>(() =>
    ranked.value
      .filter((p) => !p.verified && p.appearances < FEATURED_MIN_APPEARANCES)
      .sort((a, b) => b.appearances - a.appearances || a.displayName.localeCompare(b.displayName)),
  )

  return { ranked, featured, rest }
}

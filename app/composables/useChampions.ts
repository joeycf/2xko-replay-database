import championsData from '~~/data/champions.json'
import type { Champion } from '~~/types'

// Static import: 15 champions, bundled once, synchronously available.
const champions = championsData as unknown as Record<string, Champion>
const championList = Object.values(champions)

/** Champion registry (id → Champion), plus a list + lookup helper. */
export function useChampions() {
  return {
    champions: computed(() => champions),
    list: computed(() => championList),
    byId: (id: string): Champion | undefined => champions[id],
  }
}

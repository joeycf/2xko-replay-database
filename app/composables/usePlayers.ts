import playersData from '~~/data/players.json'
import type { Player } from '~~/types'

// Static import: the player registry (~714 entries) is bundled once and
// synchronously available — no async state, no payload serialization.
const players = playersData as unknown as Record<string, Player>
const playerList = Object.values(players)
const verifiedTotal = playerList.filter((p) => p.verified).length

/** Player registry (id → Player), plus a list, verified count, and lookup. */
export function usePlayers() {
  return {
    players: computed(() => players),
    list: computed(() => playerList),
    verifiedCount: computed(() => verifiedTotal),
    byId: (id: string): Player | undefined => players[id],
  }
}

import type { VideoRecord } from '~~/types'

/**
 * The video modal's open state lives in `?v=<videoId>`:
 *  - open() pushes (Back closes the modal naturally)
 *  - close() pops the entry we pushed, or strips the param for direct loads
 *  - swap() replaces in place (related-replay clicks don't grow history)
 */
export function useVideoModal() {
  const route = useRoute()
  const router = useRouter()
  const { videos, pending, byId } = useVideos()
  // whether the current ?v= was pushed by us in-session (vs. loaded directly)
  const pushedInSession = useState('video-modal-pushed', () => false)

  const openId = computed(() => (typeof route.query.v === 'string' ? route.query.v : null))
  const video = computed<VideoRecord | null>(() => (openId.value ? (byId(openId.value) ?? null) : null))

  const query = (patch: { v?: string }) => {
    const q: Record<string, string> = {}
    for (const [k, val] of Object.entries(route.query)) {
      if (k === 'v') continue
      if (typeof val === 'string' && val !== '') q[k] = val
    }
    if (patch.v) q.v = patch.v
    return q
  }

  function open(id: string) {
    pushedInSession.value = true
    router.push({ query: query({ v: id }) })
  }
  function close() {
    if (pushedInSession.value) {
      pushedInSession.value = false
      router.back()
    } else {
      router.replace({ query: query({}) })
    }
  }
  function swap(id: string) {
    router.replace({ query: query({ v: id }) })
  }

  const pairingsOf = (v: VideoRecord) =>
    v.teams.filter((t) => t.characters.length === 2).map((t) => [...t.characters].sort().join('|'))

  /** Same team pairing first, then shared players; newest first within each group. */
  const related = computed<VideoRecord[]>(() => {
    const cur = video.value
    if (!cur) return []
    const pairs = new Set(pairingsOf(cur))
    const people = new Set(cur.allPlayers)
    const byPairing: VideoRecord[] = []
    const byPlayer: VideoRecord[] = []
    for (const v of videos.value) {
      if (v.id === cur.id) continue
      if (pairs.size && pairingsOf(v).some((p) => pairs.has(p))) byPairing.push(v)
      else if (v.allPlayers.some((p) => people.has(p))) byPlayer.push(v)
    }
    const newest = (a: VideoRecord, b: VideoRecord) => b.publishedAt.localeCompare(a.publishedAt)
    return [...byPairing.sort(newest), ...byPlayer.sort(newest)].slice(0, RELATED_LIMIT)
  })

  return { openId, video, pending, open, close, swap, related }
}

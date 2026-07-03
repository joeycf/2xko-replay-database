import type { LocationQuery } from 'vue-router'
import type { ChannelKey, MatchType, VideoRecord } from '~~/types'

export type VideoSort = 'newest' | 'oldest' | 'views' | 'longest'
export type SeasonFilter = number | 'beta' | null

export interface ActiveChip {
  key: string
  label: string
  remove: () => void
}

/**
 * URL query scheme (all filter state lives in the route — shareable, back/forward safe):
 *   c=ahri,akali   side=1        p=sonicfox,inzem   ch=pro|high
 *   s=0|1|2|beta   mt=ranked|duo q=free+text        sort=oldest|views|longest
 *   fuse=freestyle,juggernaut  (OR-match against either team's detected fuse)
 * `v=<videoId>` (the modal) is owned by useVideoModal and always preserved here.
 * Discrete toggles push (Back undoes a step); typing replaces, debounced.
 */

const one = (v: LocationQuery[string]): string | null =>
  typeof v === 'string' ? v : Array.isArray(v) ? ((v[0] as string | null) ?? null) : null
const csv = (v: LocationQuery[string]): string[] => one(v)?.split(',').filter(Boolean) ?? []

export function useFilters() {
  const route = useRoute()
  const router = useRouter()
  const { videos } = useVideos()
  const { byId: champById, list: champList } = useChampions()
  const { players: playerRegistry } = usePlayers()
  const { fuseName } = useFuses()

  // ── state (derived from the URL) ──────────────────────────────────────────
  const selectedChampions = computed(() => csv(route.query.c))
  const sameSide = computed(() => one(route.query.side) === '1')
  const selectedPlayers = computed(() => csv(route.query.p))
  const channel = computed<ChannelKey | null>(() => {
    const v = one(route.query.ch)
    return v === 'pro' ? 'proReplays' : v === 'high' ? 'highLevel' : null
  })
  const season = computed<SeasonFilter>(() => {
    const v = one(route.query.s)
    if (v === 'beta') return 'beta'
    return v !== null && /^\d+$/.test(v) ? Number(v) : null
  })
  const matchType = computed<MatchType | null>(() => {
    const v = one(route.query.mt)
    return v === 'ranked' || v === 'duo' || v === 'tournament' ? v : null
  })
  const selectedFuses = computed(() => csv(route.query.fuse))
  const search = computed(() => one(route.query.q) ?? '')
  const sort = computed<VideoSort>(() => {
    const v = one(route.query.sort)
    return v === 'oldest' || v === 'views' || v === 'longest' ? v : 'newest'
  })

  // ── URL writes ────────────────────────────────────────────────────────────
  function write(patch: Record<string, string | null>, mode: 'push' | 'replace' = 'push') {
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries(route.query)) {
      const s = one(v)
      if (s !== null && s !== '') q[k] = s
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') delete q[k]
      else q[k] = v
    }
    router[mode]({ query: q })
  }

  const toggled = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  const toggleChampion = (id: string) => write({ c: toggled(selectedChampions.value, id).join(',') || null })
  const toggleSameSide = () => write({ side: sameSide.value ? null : '1' })
  const togglePlayer = (id: string) => write({ p: toggled(selectedPlayers.value, id).join(',') || null })
  const toggleChannel = (key: ChannelKey) =>
    write({ ch: channel.value === key ? null : key === 'proReplays' ? 'pro' : 'high' })
  const toggleSeason = (v: number | 'beta') =>
    write({ s: season.value === v ? null : String(v) })
  const toggleMatchType = (v: MatchType) => write({ mt: matchType.value === v ? null : v })
  const toggleFuse = (id: string) => write({ fuse: toggled(selectedFuses.value, id).join(',') || null })
  const setSort = (v: VideoSort) => write({ sort: v === 'newest' ? null : v }, 'replace')

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  function setSearch(v: string) {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => write({ q: v.trim() || null }, 'replace'), SEARCH_DEBOUNCE_MS)
  }
  const clearAll = () =>
    write({ c: null, side: null, p: null, ch: null, s: null, mt: null, fuse: null, q: null, sort: null })

  // ── active chips (design order: champions, same side, players, channel, season, type, query) ──
  const chips = computed<ActiveChip[]>(() => {
    const out: ActiveChip[] = []
    for (const c of selectedChampions.value)
      out.push({ key: `c:${c}`, label: champById(c)?.name ?? c, remove: () => toggleChampion(c) })
    if (sameSide.value) out.push({ key: 'side', label: 'Same side', remove: toggleSameSide })
    for (const p of selectedPlayers.value)
      out.push({ key: `p:${p}`, label: playerRegistry.value[p]?.displayName ?? p, remove: () => togglePlayer(p) })
    if (channel.value) {
      const key = channel.value
      out.push({
        key: `ch:${key}`,
        label: key === 'proReplays' ? 'Pro Replays' : 'High Level',
        remove: () => toggleChannel(key),
      })
    }
    if (season.value !== null) {
      const v = season.value
      out.push({ key: `s:${v}`, label: v === 'beta' ? 'Beta' : `Season ${v}`, remove: () => toggleSeason(v) })
    }
    if (matchType.value) {
      const v = matchType.value
      out.push({ key: `mt:${v}`, label: matchTypeLabel(v), remove: () => toggleMatchType(v) })
    }
    for (const fu of selectedFuses.value)
      out.push({ key: `fuse:${fu}`, label: fuseName(fu), remove: () => toggleFuse(fu) })
    if (search.value)
      out.push({ key: 'q', label: `“${search.value}”`, remove: () => write({ q: null }, 'replace') })
    return out
  })
  const activeCount = computed(() => chips.value.length)

  // ── search index: title + player names + champion names/aliases per video ──
  const searchIndex = computed(() => {
    const champText = new Map<string, string>()
    for (const c of champList.value) champText.set(c.id, normalizeText([c.name, ...c.aliases].join(' ')))
    const map = new Map<string, string>()
    for (const v of videos.value) {
      const parts = [v.title]
      for (const t of v.teams) for (const p of t.players) parts.push(p.displayName)
      for (const cid of v.allCharacters) parts.push(champText.get(cid) ?? cid)
      map.set(v.id, normalizeText(parts.join(' ')))
    }
    return map
  })

  // ── the filtered + sorted list ────────────────────────────────────────────
  const filtered = computed<VideoRecord[]>(() => {
    const champs = selectedChampions.value
    const tokens = normalizeText(search.value).split(/\s+/).filter(Boolean)

    const out = videos.value.filter((v) => {
      if (champs.length) {
        if (sameSide.value && champs.length >= 2) {
          // team-pairing filter: all selected champions together on ONE side
          if (!v.teams.some((t) => champs.every((c) => t.characters.includes(c)))) return false
        } else if (!champs.every((c) => v.allCharacters.includes(c))) {
          return false
        }
      }
      if (selectedPlayers.value.length && !selectedPlayers.value.some((p) => v.allPlayers.includes(p)))
        return false
      if (channel.value && v.channel !== channel.value) return false
      if (season.value !== null) {
        if (season.value === 'beta' ? v.season !== null : v.season !== season.value) return false
      }
      if (matchType.value && v.matchType !== matchType.value) return false
      // fuse: OR-match against either team's detected fuse — undetected
      // videos (teams[].fuse null) simply never match a fuse selection
      if (selectedFuses.value.length && !v.teams.some((t) => t.fuse && selectedFuses.value.includes(t.fuse)))
        return false
      if (tokens.length) {
        const hay = searchIndex.value.get(v.id) ?? ''
        if (!tokens.every((t) => hay.includes(t))) return false
      }
      return true
    })

    const s = sort.value
    return out.sort((a, b) =>
      s === 'oldest'
        ? a.publishedAt.localeCompare(b.publishedAt)
        : s === 'views'
          ? b.viewCount - a.viewCount
          : s === 'longest'
            ? b.durationSec - a.durationSec
            : b.publishedAt.localeCompare(a.publishedAt),
    )
  })

  /** Changes exactly when a filter/search/sort changes (not when ?v= does) — used to reset paging. */
  const filterKey = computed(() =>
    JSON.stringify([
      selectedChampions.value,
      sameSide.value,
      selectedPlayers.value,
      channel.value,
      season.value,
      matchType.value,
      selectedFuses.value,
      search.value,
      sort.value,
    ]),
  )

  return {
    selectedChampions, sameSide, selectedPlayers, channel, season, matchType, selectedFuses, search, sort,
    toggleChampion, toggleSameSide, togglePlayer, toggleChannel, toggleSeason, toggleMatchType, toggleFuse,
    setSort, setSearch, clearAll,
    chips, activeCount, filtered, filterKey,
  }
}

<script setup lang="ts">
// Stats dashboard — design screen 3a. Fully prerendered with real numbers
// (stats.json is a static import); animations are a client-side reveal layer.
const { totals, eras, usageFor, pairsRanked } = useStats()
const { byId } = useChampions()
const { verifiedCount } = usePlayers()

const season = ref<string | null>(null)
const usageRows = computed(() => usageFor(season.value))
const seasonName = computed(() =>
  season.value === null ? 'All seasons' : season.value === 'beta' ? 'Beta era' : `Season ${season.value}`,
)
const contextCount = computed(() =>
  season.value === null ? totals.videos : (totals.bySeason[season.value] ?? 0),
)

const cname = (id: string) => byId(id)?.name ?? id
const caccent = (id: string) => byId(id)?.accent ?? '#FF2E88'
const topChamp = usageFor(null)[0]!
const topPair = pairsRanked[0]!
const tiles = [
  { label: 'Total replays', value: totals.videos.toLocaleString('en-US'), accent: '#FF2E88' },
  { label: 'Most-used champ', value: cname(topChamp.id), accent: caccent(topChamp.id) },
  { label: 'Top pairing', value: `${cname(topPair.a)} + ${cname(topPair.b)}`, accent: caccent(topPair.b) },
  { label: 'Verified pros', value: verifiedCount.value.toLocaleString('en-US'), accent: '#38CFFF' },
]

const pill = (on: boolean) =>
  on
    ? 'border-accent bg-accent text-[#08090c]'
    : 'border-white/[0.12] bg-[#141722] text-ink-secondary hover:text-ink-primary'

useSiteMeta({
  title: 'Stats — 2XKO Replay Database',
  description: `2XKO champion usage, team pairings, and meta over time — from ${totals.videos.toLocaleString('en-US')} pro and high-level replays.`,
})
</script>

<template>
  <div class="mx-auto w-full max-w-[1440px]">
    <!-- title + season context -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 pb-1.5 pt-[22px] md:px-7">
      <h1 class="font-display text-[22px] font-bold text-ink-primary md:text-[26px]">Meta Stats</h1>
      <span class="font-mono text-[11px] text-ink-muted">
        {{ seasonName }} ·
        <span data-testid="context-count">{{ contextCount.toLocaleString('en-US') }}</span> replays
      </span>
      <div
        data-testid="season-chips"
        class="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 md:ml-auto md:mx-0 md:px-0"
      >
        <span
          class="mr-0.5 hidden font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted sm:block"
          >Season</span
        >
        <button
          type="button"
          class="flex-none cursor-pointer rounded-full border px-3.5 py-2 font-sans text-[12px] font-semibold"
          :class="pill(season === null)"
          @click="season = null"
        >
          All
        </button>
        <button
          v-for="e in eras"
          :key="e"
          type="button"
          class="flex-none cursor-pointer rounded-full border px-[13px] py-2 font-mono text-[12px]"
          :class="pill(season === e)"
          @click="season = e"
        >
          {{ eraLabel(e) }}
        </button>
      </div>
    </div>

    <!-- headline tiles -->
    <div class="grid grid-cols-2 gap-3 px-4 pb-1 pt-4 md:grid-cols-4 md:gap-3.5 md:px-7">
      <div
        v-for="t in tiles"
        :key="t.label"
        class="border border-white/[0.08] bg-[#0F1118] p-4"
        :style="{ borderTop: `2px solid ${t.accent}` }"
      >
        <div class="font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
          {{ t.label }}
        </div>
        <div class="mt-1 truncate font-display text-[22px] font-bold text-ink-primary md:text-[30px]">
          {{ t.value }}
        </div>
      </div>
    </div>

    <!-- Panel 1: champion usage -->
    <div class="px-4 py-5 md:px-7">
      <StatPanel title="Champion usage" :hint="`appearances · ${seasonName}`">
        <ChampionUsageBars :items="usageRows" />
      </StatPanel>
    </div>

    <!-- Panel 2: pairings + matrix -->
    <div class="grid grid-cols-1 gap-4 px-4 pb-5 md:grid-cols-2 md:px-7">
      <StatPanel title="Top team pairings" hint="same-side teams · all time">
        <PairingBars :limit="10" />
      </StatPanel>
      <StatPanel title="Synergy matrix" hint="click a cell → filter">
        <SynergyMatrix />
      </StatPanel>
    </div>

    <!-- Panel 3: meta over time -->
    <div class="px-4 pb-5 md:px-7">
      <StatPanel title="Meta over time" :hint="`usage rank · ${eraLabel(eras[0] ?? '0')} → ${eraLabel(eras[eras.length - 1] ?? '2')}`">
        <MetaTimeline :top-n="5" />
      </StatPanel>
    </div>

    <!-- Panel 4: fuses (NEW vs design mockups — Phase 7 CV detections) -->
    <div class="grid grid-cols-1 gap-4 px-4 pb-6 md:grid-cols-2 md:px-7">
      <StatPanel
        title="Fuse usage"
        :hint="`team picks · detected in ${totals.withFuse.toLocaleString('en-US')} of ${totals.videos.toLocaleString('en-US')} replays`"
      >
        <FuseUsageBars />
      </StatPanel>
      <StatPanel title="Fuse meta by era" hint="share of team picks per era">
        <FuseEraShift />
      </StatPanel>
    </div>
  </div>
</template>

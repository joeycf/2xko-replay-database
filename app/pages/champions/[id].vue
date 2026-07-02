<script setup lang="ts">
// Character page — design template 4a (Ekko), themed with the champion accent.
// Hero + stat rail prerender with real numbers; the replay grid is the same
// client-side videos fetch as Browse (skeletons below the fold).
import { pairsFor } from '~/composables/useStats'

const route = useRoute()
const { byId } = useChampions()
const champ = byId(String(route.params.id))
if (!champ) {
  throw createError({ statusCode: 404, statusMessage: 'Champion not found', fatal: true })
}
const accent = champ.accent ?? '#FF2E88'

const { stats, eras, usageFor, eraRanks } = useStats()
const usage = usageFor(null).find((r) => r.id === champ.id)!
const latestEra = eras[eras.length - 1] ?? '2'
const latestRank = eraRanks[latestEra]?.[champ.id] ?? 0
const latestCount = stats.value.bySeasonUsage[latestEra]?.[champ.id] ?? 0
const firstEra = eras.find((e) => (stats.value.bySeasonUsage[e]?.[champ.id] ?? 0) > 0) ?? latestEra
const eraName = (e: string) => (e === 'beta' ? 'Beta' : `Season ${e}`)

const teammates = pairsFor(champ.id).slice(0, 5)

// top pilots: playerCharacters inverted, verified first
const { players: playerRegistry } = usePlayers()
const pilots = Object.entries(stats.value.playerCharacters ?? {})
  .map(([pid, champs]) => ({
    id: pid,
    count: champs[champ.id] ?? 0,
    player: playerRegistry.value[pid],
  }))
  .filter((p) => p.count > 0 && p.player)
  .sort(
    (a, b) =>
      (b.player!.verified ? 1 : 0) - (a.player!.verified ? 1 : 0) || b.count - a.count,
  )
  .slice(0, 6)

// replays (client fetch, same as Browse)
const { videos, pending } = useVideos()
const replays = computed(() =>
  videos.value
    .filter((v) => v.allCharacters.includes(champ.id))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
)

const splash = champ.splash ?? ''
const splash800 = splash.replace('-splash.webp', '-splash-800.webp')
useSiteMeta({
  title: `${champ.name} — ${usage.value.toLocaleString('en-US')} appearances · 2XKO Replay Database`,
  description: `${champ.name} in competitive 2XKO: usage rank #${usage.rank}, ${usage.value.toLocaleString('en-US')} replay appearances, top teammates and pilots, and every ${champ.name} replay on file.`,
  image: splash || undefined,
})
useHead({
  link: splash
    ? [
        {
          rel: 'preload',
          as: 'image',
          href: splash,
          imagesrcset: `${splash800} 800w, ${splash} 1600w`,
          imagesizes: '100vw',
          fetchpriority: 'high',
        },
      ]
    : [],
})
</script>

<template>
  <div class="mx-auto w-full max-w-[1440px]">
    <!-- HERO -->
    <div class="relative h-[280px] overflow-hidden border-b border-white/[0.09] md:h-[340px]">
      <div
        class="absolute inset-0"
        style="background: repeating-linear-gradient(135deg, #0e1016, #0e1016 12px, #0b0d13 12px, #0b0d13 24px)"
      />
      <img
        v-if="splash"
        :src="splash"
        :srcset="`${splash800} 800w, ${splash} 1600w`"
        sizes="100vw"
        width="1600"
        height="900"
        alt=""
        fetchpriority="high"
        class="absolute inset-0 h-full w-full object-cover object-[70%_25%]"
      />
      <div
        class="absolute inset-0"
        :style="{
          background: `radial-gradient(80% 120% at 78% 30%, ${accent}38, transparent 60%), linear-gradient(90deg, #0A0B0F 25%, transparent 70%)`,
        }"
      />
      <div class="absolute bottom-7 left-4 md:bottom-[34px] md:left-10">
        <div class="mb-2 flex items-center gap-3">
          <ChampBadge :champion-id="champ.id" :size="52" :notch="11" :font-size="20" strong />
          <span
            class="font-sans text-[11px] font-semibold uppercase tracking-[.18em]"
            :style="{ color: accent }"
          >
            {{ eraName(latestEra) }} ·
            {{ latestRank === 1 ? 'Most picked' : `#${latestRank} most picked` }}
          </span>
        </div>
        <h1
          class="font-display text-[52px] font-bold uppercase leading-[.9] tracking-[-.02em] text-ink-primary md:text-[76px]"
          :style="{ textShadow: `0 4px 30px ${accent}4d` }"
        >
          {{ champ.name }}
        </h1>
        <p class="mt-2 font-sans text-[14px] text-ink-secondary md:text-[15px]">
          #{{ usage.rank }} all-time ·
          <span data-testid="champ-appearances">{{ usage.value.toLocaleString('en-US') }}</span>
          appearances · first seen {{ eraName(firstEra) }}
        </p>
      </div>
    </div>

    <!-- STAT RAIL -->
    <div class="grid grid-cols-1 gap-4 px-4 py-[22px] md:grid-cols-[1.1fr_1fr_1fr] md:px-7">
      <section
        class="border border-white/[0.08] bg-[#0F1118] p-5"
        :style="{ borderTop: `2px solid ${accent}` }"
      >
        <h2 class="mb-4 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
          Top teammates
        </h2>
        <PairingBars :items="teammates" :limit="5" :solo-for="champ.id" />
      </section>

      <section class="border border-white/[0.08] bg-[#0F1118] p-5">
        <h2 class="mb-4 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
          Top pilots
        </h2>
        <div data-testid="top-pilots" class="flex flex-col gap-[9px]">
          <NuxtLink
            v-for="p in pilots"
            :key="p.id"
            :to="{ path: '/', query: { p: p.id, c: champ.id } }"
            class="flex items-center gap-2 hover:text-accent-hover"
          >
            <VerifiedMark v-if="p.player!.verified" :size="10" />
            <span class="font-sans text-[13px] font-semibold text-ink-primary">{{
              p.player!.displayName
            }}</span>
            <span class="ml-auto font-mono text-[11px] text-ink-muted"
              >{{ p.count.toLocaleString('en-US') }} played</span
            >
          </NuxtLink>
        </div>
      </section>

      <section class="border border-white/[0.08] bg-[#0F1118] p-5">
        <h2 class="mb-4 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
          At a glance
        </h2>
        <div class="flex flex-col gap-3.5">
          <div class="flex items-baseline gap-2">
            <span class="font-display text-[30px] font-bold" :style="{ color: accent }"
              >#{{ usage.rank }}</span
            >
            <span class="font-sans text-[12px] text-ink-secondary">usage rank</span>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="font-display text-[30px] font-bold text-ink-primary">{{
              usage.value.toLocaleString('en-US')
            }}</span>
            <span class="font-sans text-[12px] text-ink-secondary">appearances</span>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="font-display text-[30px] font-bold text-ink-primary">{{
              latestCount.toLocaleString('en-US')
            }}</span>
            <span class="font-sans text-[12px] text-ink-secondary"
              >{{ eraName(latestEra) }} appearances</span
            >
          </div>
        </div>
      </section>
    </div>

    <!-- REPLAY GRID -->
    <div class="px-4 pb-7 pt-1.5 md:px-7">
      <div class="mb-4 flex items-center gap-2.5">
        <span class="h-2 w-2 rotate-45" :style="{ background: accent }" />
        <h2 class="font-display text-[17px] font-semibold text-ink-primary">
          {{ champ.name }} replays
        </h2>
        <span class="font-mono text-[12px] text-ink-muted"
          >{{ usage.value.toLocaleString('en-US') }} matches</span
        >
      </div>
      <ClientOnly>
        <ReplayGrid :list="replays" :pending="pending" />
        <VideoModal />
        <template #fallback>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <BrowseCardSkeleton v-for="i in 4" :key="i" />
          </div>
        </template>
      </ClientOnly>
    </div>
  </div>
</template>

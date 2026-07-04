<script setup lang="ts">
// Player page — design template 5a (SonicFox). Hero + stat rail prerender
// with real numbers; replay grid is the client-side videos fetch.
import { toPairRows, toUsageRows } from '~/composables/useStats'

const route = useRoute()
const { byId: playerById } = usePlayers()
const player = playerById(String(route.params.id))
if (!player) {
  throw createError({ statusCode: 404, statusMessage: 'Player not found', fatal: true })
}

const { stats } = useStats()
const { byId: champById } = useChampions()

const champRows = toUsageRows(stats.value.playerCharacters?.[player.id])
const pairRows = toPairRows(stats.value.playerPairings?.[player.id])
const matches = Math.round(champRows.reduce((n, r) => n + r.value, 0) / 2)
const mainChamp = champRows[0] ? champById(champRows[0].id) : undefined

const initials = (player.displayName.match(/\b[a-z0-9]/gi)?.slice(0, 2).join('') ?? player.displayName.slice(0, 2)).toUpperCase()

// replays (client fetch, same as Browse)
const { videos, pending } = useVideos()
const replays = computed(() =>
  videos.value
    .filter((v) => v.allPlayers.includes(player.id))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
)

useSiteMeta({
  title: `${player.displayName} — ${matches.toLocaleString('en-US')} 2XKO replays · 2XKO Replay Database`,
  description: `${player.displayName}${player.verified ? ' (verified pro)' : ''} in competitive 2XKO: ${matches.toLocaleString('en-US')} replays on file${mainChamp ? `, main champion ${mainChamp.name}` : ''}, most-used champions and signature pairings.`,
})

const site = useRuntimeConfig().public.siteUrl.replace(/\/$/, '')
useJsonLd([
  {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${site}/` },
      { '@type': 'ListItem', position: 2, name: 'Players', item: `${site}/players` },
      { '@type': 'ListItem', position: 3, name: player.displayName, item: `${site}/players/${player.id}` },
    ],
  },
])
</script>

<template>
  <div class="mx-auto w-full max-w-[1440px]">
    <!-- HERO -->
    <div class="relative overflow-hidden border-b border-white/[0.09] px-4 py-8 md:px-10 md:py-[34px]">
      <div
        class="absolute inset-0"
        style="background: radial-gradient(70% 130% at 20% 20%, rgba(255, 46, 136, 0.2), transparent 60%)"
      />
      <div class="relative flex flex-wrap items-center gap-5 md:gap-[26px]">
        <div
          class="relative flex h-[92px] w-[92px] flex-none items-center justify-center border-2 border-accent/40 md:h-[120px] md:w-[120px]"
          style="
            background: repeating-linear-gradient(135deg, #1a0e15, #1a0e15 10px, #160b12 10px, #160b12 20px);
            clip-path: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px));
          "
          aria-hidden="true"
        >
          <span class="font-display text-[34px] font-bold text-accent/70 md:text-[44px]">{{
            initials
          }}</span>
        </div>
        <div class="min-w-0">
          <div
            v-if="player.verified"
            class="mb-2.5 inline-flex items-center gap-2 border border-accent/50 bg-accent-dim px-[11px] py-[5px]"
          >
            <VerifiedMark :size="12" />
            <span class="font-sans text-[10px] font-bold uppercase tracking-[.16em] text-accent"
              >Verified Pro</span
            >
          </div>
          <h1
            class="break-words font-display text-[38px] font-bold uppercase leading-[.9] tracking-[-.01em] text-ink-primary md:text-[60px]"
          >
            {{ player.displayName }}
          </h1>
          <p class="mt-2 font-sans text-[14px] text-ink-secondary md:text-[15px]">
            2XKO {{ player.verified ? 'pro circuit' : 'competitor' }} ·
            {{ matches.toLocaleString('en-US') }} matches on file
          </p>
        </div>
        <div class="ml-auto flex gap-3.5">
          <div class="text-right">
            <div class="font-display text-[28px] font-bold text-accent md:text-[34px]">
              <span data-testid="player-matches">{{ matches.toLocaleString('en-US') }}</span>
            </div>
            <div class="font-sans text-[11px] text-ink-muted">replays on file</div>
          </div>
          <div class="w-px bg-white/10" aria-hidden="true" />
          <div class="text-right">
            <div class="truncate font-display text-[28px] font-bold text-ink-primary md:text-[34px]">
              <NuxtLink
                v-if="mainChamp"
                :to="`/champions/${mainChamp.id}`"
                class="hover:text-accent-hover"
                >{{ mainChamp.name }}</NuxtLink
              >
              <template v-else>—</template>
            </div>
            <div class="font-sans text-[11px] text-ink-muted">main champion</div>
          </div>
        </div>
      </div>
    </div>

    <!-- STAT RAIL -->
    <div class="grid grid-cols-1 gap-4 px-4 py-[22px] md:grid-cols-2 md:px-7">
      <section class="border border-white/[0.08] bg-[#0F1118] p-5">
        <h2 class="mb-4 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
          Most-used champions
        </h2>
        <ChampionUsageBars :items="champRows" :limit="5" compact :link-player-id="player.id" />
      </section>
      <section class="border border-white/[0.08] bg-[#0F1118] p-5">
        <h2 class="mb-4 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
          Signature pairings
        </h2>
        <PairingBars :items="pairRows" :limit="5" boxed :with-player="player.id" />
        <p v-if="pairRows.length === 0" class="font-mono text-[11px] text-ink-muted">
          No full-team data on file.
        </p>
      </section>
    </div>

    <!-- REPLAY GRID -->
    <div class="px-4 pb-7 pt-1.5 md:px-7">
      <div class="mb-4 flex items-center gap-2.5">
        <span class="h-2 w-2 rotate-45 bg-accent" />
        <h2 class="font-display text-[17px] font-semibold text-ink-primary">
          {{ player.displayName }} replays
        </h2>
        <span class="font-mono text-[12px] text-ink-muted"
          >{{ matches.toLocaleString('en-US') }} matches</span
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

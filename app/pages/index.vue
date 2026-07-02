<script setup lang="ts">
// Browse — the design's 1A Broadcast Grid: filter bar → active chips + count →
// infinite-scroll card grid, with the mobile drawer and the video modal.
const { pending } = useVideos()
const f = useFilters()

const visible = ref(GRID_PAGE_SIZE)
watch(f.filterKey, () => {
  visible.value = GRID_PAGE_SIZE
})
const shown = computed(() => f.filtered.value.slice(0, visible.value))

const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | undefined
onMounted(() => {
  io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      if (visible.value >= f.filtered.value.length) return
      visible.value += GRID_PAGE_SIZE
      // re-observe so a still-visible sentinel emits a fresh intersection record
      nextTick(() => {
        const el = sentinel.value
        if (el && io) {
          io.unobserve(el)
          io.observe(el)
        }
      })
    },
    { rootMargin: '600px 0px' },
  )
  if (sentinel.value) io.observe(sentinel.value)
})
watch(sentinel, (el) => {
  if (!io) return
  io.disconnect()
  if (el) io.observe(el)
})
onBeforeUnmount(() => io?.disconnect())

const { totals } = useStats()
useSiteMeta({
  title: 'Browse — 2XKO Replay Database',
  description: `Browse ${totals.videos.toLocaleString('en-US')} competitive 2XKO replays — filter by champion, team pairing, player, season, and channel.`,
})
</script>

<template>
  <div class="mx-auto w-full max-w-[1440px]">
    <ClientOnly>
      <FilterBar class="hidden md:block" />
      <ActiveChips />

      <!-- grid -->
      <div
        v-if="pending"
        class="grid grid-cols-1 gap-4 px-4 pb-[30px] pt-[22px] sm:grid-cols-2 md:px-[26px] lg:grid-cols-3 xl:grid-cols-4"
      >
        <BrowseCardSkeleton v-for="i in 12" :key="i" />
      </div>
      <template v-else-if="f.filtered.value.length">
        <div
          class="grid grid-cols-1 gap-4 px-4 pb-[30px] pt-[22px] sm:grid-cols-2 md:px-[26px] lg:grid-cols-3 xl:grid-cols-4"
        >
          <BrowseCard v-for="v in shown" :key="v.id" :video="v" />
        </div>
        <div v-if="shown.length < f.filtered.value.length" ref="sentinel" class="h-px" aria-hidden="true" />
      </template>
      <BrowseEmpty v-else />

      <FilterDrawer />
      <VideoModal />

      <!-- prerendered fallback: static skeletons (cards arrive client-side; SEO
           lives on the champion/player/stats pages) -->
      <template #fallback>
        <div class="border-b border-white/[0.07] bg-[#0C0D12] px-4 py-[13px] md:px-[26px]">
          <span class="font-mono text-[13px] text-ink-secondary">Loading replays…</span>
        </div>
        <div
          class="grid grid-cols-1 gap-4 px-4 pb-[30px] pt-[22px] sm:grid-cols-2 md:px-[26px] lg:grid-cols-3 xl:grid-cols-4"
        >
          <BrowseCardSkeleton v-for="i in 8" :key="i" />
        </div>
      </template>
    </ClientOnly>
  </div>
</template>

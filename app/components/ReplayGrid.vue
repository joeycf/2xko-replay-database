<script setup lang="ts">
// Entity-page replay grid: the Phase 4 cards + infinite scroll, fed a
// pre-filtered list (champion/player pages). Client-only by nature — the
// list derives from the client videos fetch.
import type { VideoRecord } from '~~/types'

const props = defineProps<{ list: VideoRecord[]; pending: boolean }>()

const visible = ref(GRID_PAGE_SIZE)
watch(
  () => props.list,
  () => (visible.value = GRID_PAGE_SIZE),
)
const shown = computed(() => props.list.slice(0, visible.value))

const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | undefined
onMounted(() => {
  io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      if (visible.value >= props.list.length) return
      visible.value += GRID_PAGE_SIZE
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
</script>

<template>
  <div>
    <div
      v-if="pending"
      class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      <BrowseCardSkeleton v-for="i in 8" :key="i" />
    </div>
    <template v-else-if="list.length">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <BrowseCard v-for="v in shown" :key="v.id" :video="v" />
      </div>
      <div v-if="shown.length < list.length" ref="sentinel" class="h-px" aria-hidden="true" />
    </template>
    <p v-else class="py-10 text-center font-mono text-[12px] text-ink-muted">No replays on file.</p>
  </div>
</template>

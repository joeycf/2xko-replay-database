<script setup lang="ts">
// Typeahead over the full player registry (verified + discovered), anchored
// under the "Search all N players" affordance. Click toggles; stays open for
// multi-select; closes on outside click / Esc.
const emit = defineEmits<{ close: [] }>()

const { ranked } = useFeaturedPlayers()
const { selectedPlayers, togglePlayer } = useFilters()

const q = ref('')
const root = ref<HTMLElement>()
const input = ref<HTMLInputElement>()

const results = computed(() => {
  const n = normalizeText(q.value.trim())
  const base = n
    ? ranked.value.filter(
        (p) =>
          normalizeText(p.displayName).includes(n) ||
          p.aliases.some((a) => normalizeText(a).includes(n)),
      )
    : ranked.value
  return base.slice(0, 60)
})

function onOutside(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node)) emit('close')
}
onMounted(() => {
  input.value?.focus()
  document.addEventListener('pointerdown', onOutside, true)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))
</script>

<template>
  <div
    ref="root"
    data-testid="player-typeahead"
    class="absolute left-0 top-full z-30 mt-2 flex max-h-[340px] w-[300px] flex-col border border-white/[0.14] bg-surface shadow-lg"
    @keydown.esc.stop="emit('close')"
  >
    <div class="border-b border-white/[0.09] p-2">
      <input
        ref="input"
        v-model="q"
        type="search"
        placeholder="Type a player name…"
        aria-label="Search all players"
        class="w-full border border-white/[0.12] bg-[#08090c] px-2.5 py-2 font-sans text-[13px] text-ink-primary outline-none placeholder:text-ink-muted"
      />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-1">
      <button
        v-for="p in results"
        :key="p.id"
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left font-sans text-[12.5px] font-semibold text-ink-primary hover:bg-elevated"
        :class="selectedPlayers.includes(p.id) ? 'bg-accent-dim' : ''"
        :aria-pressed="selectedPlayers.includes(p.id)"
        @click="togglePlayer(p.id)"
      >
        <VerifiedMark v-if="p.verified" :size="9" />
        <span class="min-w-0 truncate">{{ p.displayName }}</span>
        <span class="ml-auto font-mono text-[10px] text-ink-muted">{{ p.appearances }}</span>
      </button>
      <div v-if="results.length === 0" class="px-3 py-4 font-sans text-[12px] text-ink-muted">
        No players match.
      </div>
    </div>
  </div>
</template>

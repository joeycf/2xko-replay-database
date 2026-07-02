<script setup lang="ts">
const { videos } = useVideos()
const { list: champions } = useChampions()
const { list: players, verifiedCount } = usePlayers()

const withPortrait = computed(() => champions.value.filter((c) => !!c.portrait).length)

const cards = computed(() => [
  { label: 'Videos', value: videos.value.length.toLocaleString() },
  { label: 'Champions', value: champions.value.length.toLocaleString() },
  { label: 'Players', value: players.value.length.toLocaleString() },
  { label: 'Verified players', value: `${verifiedCount.value} / ${players.value.length}` },
])

useHead({ title: 'Health — 2XKO Replay Database' })
</script>

<template>
  <section class="mx-auto max-w-6xl px-6 py-10">
    <p class="font-mono text-label uppercase text-ink-muted">Scaffold</p>
    <h1 class="mt-1 font-display text-d2 font-bold text-ink-primary">Health check</h1>

    <!-- counts -->
    <div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div v-for="c in cards" :key="c.label" class="cut border border-white/10 bg-surface p-4">
        <div class="font-mono text-data-xl text-ink-primary">{{ c.value }}</div>
        <div class="mt-1 font-sans text-label uppercase text-ink-muted">{{ c.label }}</div>
      </div>
    </div>

    <!-- champion portraits -->
    <h2 class="mt-10 font-display text-title font-semibold text-ink-primary">
      Champion portraits
      <span class="font-mono text-sub" :class="withPortrait === 15 ? 'text-success' : 'text-warning'">
        {{ withPortrait }}/15
      </span>
    </h2>
    <div class="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-8 xl:grid-cols-[repeat(15,minmax(0,1fr))]">
      <figure v-for="c in champions" :key="c.id" class="min-w-0">
        <img
          v-if="c.portrait"
          :src="c.portrait"
          :alt="c.name"
          loading="lazy"
          class="cut aspect-[3/4] w-full object-cover"
          :style="{ boxShadow: `inset 0 0 0 1px var(--champ-${c.id})` }"
        />
        <div v-else class="cut grid aspect-[3/4] w-full place-items-center bg-elevated font-mono text-[9px] text-ink-faint">
          no art
        </div>
        <figcaption class="mt-1 truncate text-center font-sans text-[11px] text-ink-secondary">{{ c.name }}</figcaption>
      </figure>
    </div>

    <!-- accent swatches (from theme tokens) -->
    <h2 class="mt-10 font-display text-title font-semibold text-ink-primary">Champion accents (theme tokens)</h2>
    <div class="mt-4 flex flex-wrap gap-2">
      <div
        v-for="c in champions"
        :key="c.id"
        class="flex items-center gap-2 border border-white/10 bg-surface px-2.5 py-1.5"
      >
        <span class="inline-block h-5 w-5 rounded-sm" :style="{ background: `var(--champ-${c.id})` }" />
        <span class="font-mono text-[11px] text-ink-secondary">{{ c.id }}</span>
        <span class="font-mono text-[11px] text-ink-faint">{{ c.accent ?? '—' }}</span>
      </div>
    </div>

    <p class="mt-10 font-sans text-body text-ink-muted">Temporary scaffold page — remove before launch.</p>
  </section>
</template>

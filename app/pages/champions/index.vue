<script setup lang="ts">
const { list } = useChampions()
useSiteMeta({
  title: 'Champions — 2XKO Replay Database',
  description: 'The 2XKO roster — usage stats, top teammates, top pilots, and every replay for all 15 champions.',
})
</script>

<template>
  <section class="mx-auto max-w-6xl px-6 py-12">
    <h1 class="font-display text-d1 font-bold text-ink-primary">Champions</h1>
    <p class="mt-2 font-sans text-body text-ink-secondary">
      Roster &amp; per-champion breakdowns land in Phase 5.
    </p>
    <ul class="mt-8 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
      <li v-for="c in list" :key="c.id">
        <NuxtLink
          :to="`/champions/${c.id}`"
          class="group cut block overflow-hidden border border-white/10 bg-surface transition-colors hover:border-accent/50"
        >
          <img
            v-if="c.portrait"
            :src="c.portrait"
            :alt="c.name"
            loading="lazy"
            class="aspect-[3/4] w-full object-cover"
          />
          <div v-else class="grid aspect-[3/4] w-full place-items-center bg-elevated font-mono text-[10px] text-ink-faint">
            no art
          </div>
          <span class="block px-2 py-1.5 font-sans text-body text-ink-secondary group-hover:text-ink-primary">
            {{ c.name }}
          </span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

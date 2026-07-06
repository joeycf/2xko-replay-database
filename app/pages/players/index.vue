<template>
  <section class="mx-auto w-full max-w-[1440px] px-4 py-10 md:px-7">
    <h1 class="font-display text-d1 font-bold text-ink-primary">Players</h1>
    <p class="mt-2 font-sans text-body text-ink-secondary">
      <span class="font-mono text-ink-primary">{{ list.length.toLocaleString('en-US') }}</span>
      players indexed —
      <span class="text-accent2">{{ featured.filter((p) => p.verified).length }} verified pros</span>,
      {{ featured.length }} featured. Every player has a profile; find anyone via
      <NuxtLink
        to="/"
        class="text-accent hover:underline"
      >Browse search</NuxtLink>.
    </p>
    <h2 class="mt-8 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
      Featured players
    </h2>
    <div class="mt-3 flex flex-wrap gap-[7px]">
      <NuxtLink
        v-for="p in featured"
        :key="p.id"
        :to="`/players/${p.id}`"
        class="inline-flex items-center gap-1.5 border border-white/[0.12] bg-[#141722] px-[11px] py-1.5 font-sans text-[12px] font-semibold text-ink-primary transition-colors hover:border-accent/50"
      >
        <VerifiedMark
          v-if="p.verified"
          :size="10"
        />
        {{ p.displayName }}
        <span class="font-mono text-[10px] text-ink-muted">{{ p.appearances }}</span>
      </NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
// Players index: featured players (verified or ≥25 appearances) as crawlable
// links into the 714 prerendered profiles; the rest are reachable via the
// Browse typeahead and direct URLs. (No design screen exists for this route —
// kept minimal and on-token.)
const { list } = usePlayers();
const { featured } = useFeaturedPlayers();

useSiteMeta({
  title: 'Players — 2XKO Replay Database',
  description: `${list.value.length.toLocaleString('en-US')} 2XKO players on file — verified pros, featured competitors, most-used champions, and full replay histories.`
});
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-3 border-b border-white/[0.07] bg-[#0C0D12] px-4 py-[13px] md:px-[26px]"
  >
    <span class="font-mono text-[13px] text-ink-secondary">
      <b
        data-testid="result-count"
        class="font-bold text-white"
      >{{ pending ? '…' : filtered.length.toLocaleString() }}</b>
      replays
    </span>
    <button
      v-for="chip in chips"
      :key="chip.key"
      type="button"
      class="inline-flex cursor-pointer items-center gap-[7px] border border-accent/40 bg-accent-dim px-2.5 py-[5px] font-sans text-[12px] font-semibold text-white"
      :aria-label="`Remove filter ${chip.label}`"
      @click="chip.remove()"
    >
      {{ chip.label }} <span class="opacity-65">✕</span>
    </button>
    <button
      v-if="chips.length"
      type="button"
      class="cursor-pointer px-1 py-[5px] font-sans text-[12px] font-semibold text-accent hover:text-accent-hover"
      @click="clearAll()"
    >
      Clear all
    </button>
  </div>
</template>

<script setup lang="ts">
const { chips, filtered, clearAll } = useFilters();
const { pending } = useVideos();
</script>

<template>
  <div
    ref="root"
    data-testid="fuse-era-shift"
    class="grid grid-cols-2 gap-3"
  >
    <div
      v-for="card in cards"
      :key="card.era"
      class="border border-white/[0.06] bg-[#0C0D12] p-3"
    >
      <div class="mb-2.5 flex items-baseline justify-between gap-2">
        <span class="font-mono text-[11px] font-semibold text-ink-primary">{{ eraLabel(card.era).toUpperCase() }}</span>
        <span class="font-mono text-[9px] text-ink-muted">{{ card.total.toLocaleString('en-US') }} picks</span>
      </div>
      <div class="flex flex-col gap-2">
        <div
          v-for="row in card.rows"
          :key="row.id"
        >
          <div class="mb-1 flex items-center gap-1.5">
            <span
              class="h-1.5 w-1.5 flex-none rotate-45"
              :style="{ background: fuseAccent(row.id) }"
            />
            <span class="min-w-0 truncate font-sans text-[10.5px] font-semibold text-ink-secondary">{{ fuseName(row.id) }}</span>
            <span class="ml-auto flex-none font-mono text-[10px] text-ink-primary">{{ row.share }}%</span>
          </div>
          <div class="h-1.5 overflow-hidden bg-[#08090c]">
            <div
              class="bar-fill h-full origin-left"
              :data-pct="row.pct"
              :style="{
                width: `${row.pct}%`,
                background: `linear-gradient(90deg, ${fuseAccent(row.id)}, ${fuseAccent(row.id)}55)`
              }"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Fuse meta by era (Stats Panel 4, NEW vs design mockups): small multiples of
// per-era pick share, Beta → S0 → S1 → S2. Shares rather than MetaTimeline's
// usage ranks — with four fuses the story is magnitude (Freestyle 33% → 62%),
// which rank lines can't show.
const { eras, stats } = useStats();
const { fuseName, fuseAccent } = useFuses();

const cards = eras.map((era) => {
  const usage = stats.value.fuseBySeason[era] ?? {};
  const total = Object.values(usage).reduce((a, b) => a + b, 0);
  const rows = Object.entries(usage)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({
      id,
      count,
      share: total ? Math.round((count / total) * 100) : 0,
      pct: total ? Math.max(3, Math.round((count / total) * 100)) : 0
    }));
  return {
    era,
    total,
    rows
  };
});

const root = ref<HTMLElement | null>(null);
useReveal(root, {
  prepare: prepareBars,
  reveal: (el, anime) => animateBarsIn(el, anime)
});
</script>

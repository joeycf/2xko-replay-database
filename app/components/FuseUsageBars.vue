<template>
  <div ref="root" data-testid="fuse-usage-bars" class="flex flex-col gap-2 md:gap-[9px]">
    <div v-for="row in rows" :key="row.id" class="flex items-center gap-2.5 md:gap-3">
      <span class="hidden w-5 flex-none text-right font-mono text-[11px] text-text-muted sm:block">
        {{ row.rank }}
      </span>
      <span class="flex h-7 w-7 flex-none items-center justify-center">
        <span class="h-2.5 w-2.5 rotate-45" :style="{ background: row.accent ?? '#8B93A8' }" />
      </span>
      <span
        class="w-[86px] flex-none font-ui text-[12px] font-semibold text-text md:w-[104px] md:text-[13px]"
      >
        {{ row.name }}
      </span>
      <div class="h-4 flex-1 overflow-hidden bg-[#08090c] md:h-5">
        <div
          class="bar-fill h-full origin-left transition-[width] duration-[550ms] ease-snap"
          :data-pct="row.pct"
          :style="{
            width: `${row.pct}%`,
            background: `linear-gradient(90deg, ${row.accent ?? '#8B93A8'}, ${row.accent ?? '#8B93A8'}55)`,
          }"
        />
      </div>
      <span
        class="count-up w-[42px] flex-none text-right font-mono text-[11px] text-text md:w-[52px] md:text-[13px]"
        :data-value="row.count"
      >
        {{ row.count.toLocaleString('en-US') }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
// Ranked fuse team-pick bars (Stats Panel 2, NEW vs design mockups) — same
// anatomy as ChampionUsageBars' dashboard rows with the fuse accent diamond
// in place of a champion badge. `items` is reactive so the Stats page's
// season chips re-rank the bars, mirroring ChampionUsageBars.
import type { DetectedFuse } from '~/composables/useFuses';

const props = defineProps<{
  // ranked fuses to render (useFuses().detectedFor)
  items: DetectedFuse[];
}>();

const root = ref<HTMLElement | null>(null);

const { revealed } = useReveal(root, {
  prepare: prepareBars,
  reveal: (el, anime) => {
    animateBarsIn(el, anime);
    for (const fill of el.querySelectorAll<HTMLElement>('.bar-fill')) {
      setTimeout(() => (fill.style.transition = ''), 1500); // hand back to the CSS transition
    }
  },
});

const rows = computed(() => {
  const max = props.items[0]?.count || 1;
  return props.items.map((f, i) => ({
    ...f,
    rank: i + 1,
    pct: f.count === 0 ? 0 : Math.max(4, Math.round((f.count / max) * 100)),
  }));
});

// season switch: bars transition via CSS; labels re-count
watch(
  () => props.items,
  async () => {
    if (!revealed.value || prefersReducedMotion()) return;
    await nextTick();
    if (root.value) animateCountUps(root.value, await import('animejs'));
  },
);
</script>

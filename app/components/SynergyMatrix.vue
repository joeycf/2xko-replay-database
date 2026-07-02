<script setup lang="ts">
// 15×15 champion synergy heatmap (design Panel 2 right) — mirrored across the
// diagonal per the design, cell intensity = same-side pairing count. Cells
// deep-link to Browse with the useFilters schema (/?c=a,b&side=1).
// Mobile delta: the design has no mobile matrix treatment, so the grid lives
// in a contained horizontal scroll with a hint (flagged in the report).
const { list: champions } = useChampions()
const { pairingAlpha, pairCount } = useStats()

const name = (id: string) => champions.value.find((c) => c.id === id)?.name ?? id
const goPair = (a: string, b: string) =>
  navigateTo({ path: '/', query: { c: `${a},${b}`, side: '1' } })

const root = ref<HTMLElement | null>(null)
useReveal(
  root,
  {
    prepare: (el) => {
      for (const cell of el.querySelectorAll<HTMLElement>('.mx-cell')) cell.style.opacity = '0'
    },
    reveal: (el, { animate, stagger }) => {
      animate(el.querySelectorAll<HTMLElement>('.mx-cell'), {
        opacity: 1,
        duration: 260,
        ease: 'outQuad',
        delay: stagger(3, { grid: [15, 15], from: 'first' }),
      })
    },
  },
  { threshold: 0.2 },
)
</script>

<template>
  <div>
    <div class="mb-2 font-mono text-[10px] text-ink-muted sm:hidden" aria-hidden="true">
      scroll →
    </div>
    <div class="overflow-x-auto">
      <div ref="root" data-testid="synergy-matrix" class="min-w-[460px]">
        <!-- column initials -->
        <div class="mb-[2px] flex gap-[2px] pl-6">
          <span
            v-for="c in champions"
            :key="c.id"
            class="flex-1 text-center font-display text-[8px] font-bold text-ink-muted"
            >{{ championInitials(c) }}</span
          >
        </div>
        <!-- rows -->
        <div v-for="row in champions" :key="row.id" class="mb-[2px] flex items-center gap-[2px]">
          <span class="w-[22px] flex-none font-display text-[8px] font-bold text-ink-muted">{{
            championInitials(row)
          }}</span>
          <template v-for="col in champions" :key="col.id">
            <div
              v-if="row.id === col.id"
              class="mx-cell aspect-square flex-1 border border-white/[0.04]"
              aria-hidden="true"
            />
            <button
              v-else
              type="button"
              class="mx-cell aspect-square flex-1 cursor-pointer border border-white/[0.04] transition-shadow duration-100 hover:shadow-[inset_0_0_0_1.5px_#fff] focus-visible:shadow-[inset_0_0_0_1.5px_#fff]"
              :data-pair="[row.id, col.id].sort().join('|')"
              :style="{ background: `rgba(255, 46, 136, ${pairingAlpha(row.id, col.id)})` }"
              :title="`${name(row.id)} + ${name(col.id)} — ${pairCount(row.id, col.id).toLocaleString('en-US')} team appearances`"
              :aria-label="`Filter Browse to ${name(row.id)} + ${name(col.id)} on the same side`"
              @click="goPair(row.id, col.id)"
            />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

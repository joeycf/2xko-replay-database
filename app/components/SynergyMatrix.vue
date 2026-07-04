<script setup lang="ts">
// 15×15 champion synergy heatmap (design Panel 2 right) — mirrored across the
// diagonal per the design, cell intensity = same-side pairing count. Cells
// deep-link to Browse with the useFilters schema (/?c=a,b&side=1).
// Mobile delta: the design has no mobile matrix treatment, so the grid lives
// in a contained horizontal scroll with a hint (flagged in the report).
// Hover tooltip (desktop-only enhancement): the design system has no tooltip
// component, so this is a minimal dark-surface + accent build. It replaces the
// old native title attribute (which would double-render beneath it).
const { list: champions } = useChampions()
const { pairingAlpha, pairCount } = useStats()

const name = (id: string) => champions.value.find((c) => c.id === id)?.name ?? id
const accent = (id: string) => champions.value.find((c) => c.id === id)?.accent ?? '#FF2E88'
const goPair = (a: string, b: string) =>
  navigateTo({ path: '/', query: { c: `${a},${b}`, side: '1' } })

// ── tooltip ───────────────────────────────────────────────────────────────────
interface Tip {
  rowId: string
  colId: string | null // null → diagonal (same champion, not a pairing)
  x: number // clamped viewport-x of the anchor center
  y: number // viewport-y to attach to (cell top or bottom)
  above: boolean
}
const tip = ref<Tip | null>(null)
// hover is meaningless on touch — tap must stay a pure click-to-filter
const canHover = ref(false)
const hideTip = () => {
  tip.value = null
}
onMounted(() => {
  canHover.value = window.matchMedia('(hover: hover) and (pointer: fine)').matches
  window.addEventListener('scroll', hideTip, { passive: true })
})
onBeforeUnmount(() => window.removeEventListener('scroll', hideTip))

function showTip(e: MouseEvent, rowId: string, colId: string | null) {
  if (!canHover.value) return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const above = r.top > 52 // flip below the cell when the viewport top is close
  tip.value = {
    rowId,
    colId,
    // clamp the anchor center so a ~300px-wide tip can't overflow either edge
    x: Math.min(Math.max(r.left + r.width / 2, 158), window.innerWidth - 158),
    y: above ? r.top : r.bottom,
    above,
  }
}

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
              :data-diag="row.id"
              aria-hidden="true"
              @mouseenter="showTip($event, row.id, null)"
              @mouseleave="hideTip"
            />
            <button
              v-else
              type="button"
              class="mx-cell aspect-square flex-1 cursor-pointer border border-white/[0.04] transition-shadow duration-100 hover:shadow-[inset_0_0_0_1.5px_#fff] focus-visible:shadow-[inset_0_0_0_1.5px_#fff]"
              :data-pair="[row.id, col.id].sort().join('|')"
              :style="{ background: `rgba(255, 46, 136, ${pairingAlpha(row.id, col.id)})` }"
              :aria-label="`${name(row.id)} + ${name(col.id)} — ${pairCount(row.id, col.id).toLocaleString('en-US')} team appearances. Filter Browse to this pairing.`"
              @mouseenter="showTip($event, row.id, col.id)"
              @mouseleave="hideTip"
              @click="hideTip(), goPair(row.id, col.id)"
            />
          </template>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="tip"
        data-testid="synergy-tip"
        class="pointer-events-none fixed z-[80] whitespace-nowrap border border-white/[0.14] bg-[#0F1118] px-3 py-2 shadow-modal cut-bl-7 motion-safe:transition-opacity motion-safe:duration-100"
        :style="{
          left: `${tip.x}px`,
          top: `${tip.above ? tip.y - 7 : tip.y + 7}px`,
          transform: tip.above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
        }"
        role="presentation"
      >
        <template v-if="tip.colId === null">
          <span class="font-sans text-[12px] font-semibold" :style="{ color: accent(tip.rowId) }">{{
            name(tip.rowId)
          }}</span>
          <span class="ml-2 font-mono text-[10px] text-ink-muted">same champion</span>
        </template>
        <template v-else>
          <span class="font-sans text-[12px] font-semibold" :style="{ color: accent(tip.rowId) }">{{
            name(tip.rowId)
          }}</span>
          <span class="mx-1 font-sans text-[12px] font-semibold text-ink-muted">+</span>
          <span class="font-sans text-[12px] font-semibold" :style="{ color: accent(tip.colId) }">{{
            name(tip.colId)
          }}</span>
          <span class="ml-2 font-mono text-[11px] text-ink-primary">
            {{
              pairCount(tip.rowId, tip.colId) === 0
                ? 'never paired'
                : `${pairCount(tip.rowId, tip.colId).toLocaleString('en-US')} team appearances`
            }}
          </span>
        </template>
      </div>
    </Teleport>
  </div>
</template>

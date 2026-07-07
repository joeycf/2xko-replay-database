<template>
  <Teleport
    v-if="tip"
    to="body"
  >
    <div
      v-bind="$attrs"
      class="pointer-events-none fixed z-[80] whitespace-nowrap border border-white/[0.14] bg-[#0F1118] px-3 py-2 shadow-modal cut-bl-7 motion-safe:transition-opacity motion-safe:duration-100"
      :style="{
        left: `${tip.x}px`,
        top: `${tip.above ? tip.y - 7 : tip.y + 7}px`,
        transform: tip.above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
      }"
      role="presentation"
    >
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// Minimal dark-surface tooltip box — the design system has no tooltip
// component, so this shared build serves the synergy matrix cells and the
// champion filter chips. Show state + position come from useHoverTip; content
// is the caller's slot. inheritAttrs off because the root is a Teleport:
// attrs (e.g. data-testid) must land on the box itself.
import type { HoverTipPos } from '~/composables/useHoverTip';

defineOptions({ inheritAttrs: false });
defineProps<{ tip: HoverTipPos | null }>();
</script>

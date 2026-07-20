<template>
  <!-- Fuse usage — the shipped Panel 2 (naked anchor: this div IS the row) -->
  <div
    v-if="position === 'after-usage'"
    class="px-4 pb-5 md:px-7"
  >
    <StatPanel
      title="Fuse usage"
      :hint="fuseHint"
    >
      <FuseUsageBars :items="fuseRows" />
    </StatPanel>
  </div>

  <!-- Fuse meta by era — the shipped Panel 4 right (the grid's second cell) -->
  <StatPanel
    v-else-if="position === 'beside-timeline'"
    title="Fuse meta by era"
    hint="share of team picks per era"
  >
    <FuseEraShift />
  </StatPanel>
</template>

<script setup lang="ts">
// 2XKO's stats-page extension panels — same-path override of the engine's
// GameStatsPanels, branching on the v0.4.0 positioned anchors to restore the
// SHIPPED page composition exactly:
//   after-usage     → Fuse usage (full-width, directly under Champion usage —
//                     the shipped Panel 2)
//   beside-timeline → Fuse meta by era (the Meta-over-time grid's second
//                     cell — the shipped Panel 4 right)
//   bottom          → nothing
// Receives the dashboard's active patch selection (patch keys = the emitted
// 'Beta'/'S0'/… timeline).
const props = withDefaults(
  defineProps<{
    patch?: string | null;
    position?: 'after-usage' | 'beside-timeline' | 'bottom';
  }>(),
  {
    patch: null,
    position: 'bottom',
  },
);

const { detectedFor, coverage } = useFuses();

const fuseRows = computed(() => detectedFor(props.patch ?? null));
const fuseHint = computed(() =>
  props.patch == null
    ? `team picks · detected in ${coverage.withFuse.toLocaleString('en-US')} of ${coverage.total.toLocaleString('en-US')} replays`
    : `team picks · ${props.patch}`,
);
</script>

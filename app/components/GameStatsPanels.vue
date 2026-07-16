<script setup lang="ts">
// 2XKO's stats-page extension panels — this component OVERRIDES the engine's
// empty GameStatsPanels at the same path (layer precedence), the sanctioned
// slot for game-specific analytics (PLAN §11: never genericize a mechanic one
// game has). Receives the dashboard's active patch selection and feeds it to
// the fuse system (patch keys = the emitted 'Beta'/'S0'/… timeline).
const props = defineProps<{ patch?: string | null }>();

const { detectedFor, coverage } = useFuses();

const fuseRows = computed(() => detectedFor(props.patch ?? null));
const fuseHint = computed(() =>
  props.patch == null
    ? `team picks · detected in ${coverage.withFuse.toLocaleString('en-US')} of ${coverage.total.toLocaleString('en-US')} replays`
    : `team picks · ${props.patch}`,
);
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Fuse usage — patch-aware ranked bars (the shipped Stats Panel 2) -->
    <StatPanel title="Fuse usage" :hint="fuseHint">
      <FuseUsageBars :items="fuseRows" />
    </StatPanel>

    <!-- Fuse meta by era — per-era pick-share small multiples (shipped Panel 4 right) -->
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      <StatPanel title="Fuse meta by era" hint="share of team picks per era">
        <FuseEraShift />
      </StatPanel>
    </div>
  </div>
</template>

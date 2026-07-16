<script setup lang="ts">
// 2XKO per-side fuse tag — same-path override of the engine's empty
// GameSideBadge (v0.3.0 badge slot). Renders ONLY when side attribution is
// confirmed: fusesUnordered pairs stay off the sides entirely (they render
// unbound via GameReplayBadges), so a wrong left/right claim can never appear.
import type { Replay } from '@engine/types';

const props = defineProps<{
  replay: Replay;
  side: 0 | 1;
  context: 'card' | 'modal';
  compact?: boolean;
}>();

const { replayFuses } = useFuses();
const fuse = computed(() => {
  const info = replayFuses(props.replay);
  if (info.unordered) return null;
  return props.side === 0 ? info.a : info.b;
});
</script>

<template>
  <div
    v-if="context === 'modal' && fuse"
    :data-testid="compact ? undefined : `team-fuse-${side === 0 ? 'a' : 'b'}`"
    :class="compact ? 'mt-0.5' : 'mt-1'"
  >
    <FuseTag :fuse-id="fuse" :size="compact ? 'sm' : 'md'" />
  </div>
</template>

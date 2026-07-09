<template>
  <span
    class="cut-bl-6 whitespace-nowrap font-sans font-bold uppercase tracking-[.1em]"
    :class="[
      size === 'sm' ? 'px-2 py-1 text-[8.5px]' : 'px-[9px] py-1 text-[9px]',
      channel === 'proReplays'
        ? 'border border-transparent bg-accent text-[#050607]'
        : channel === 'manual'
          ? 'border border-[rgba(245,179,60,.5)] bg-[rgba(245,179,60,.14)] text-warning'
          : 'border border-[rgba(56,207,255,.5)] bg-[rgba(56,207,255,.14)] text-accent2'
    ]"
  >{{ label }}</span>
</template>

<script setup lang="ts">
import type { VideoSource } from '~~/types';

const props = withDefaults(defineProps<{ channel: VideoSource; size?: 'sm' | 'md' }>(), { size: 'sm' });

// "manual" = hand-authored records (data/manual-videos.json) — tournament VODs
const label = computed(() =>
  props.channel === 'proReplays' ? 'Pro Replays' : props.channel === 'manual' ? 'Tournament' : 'High Level'
);
</script>

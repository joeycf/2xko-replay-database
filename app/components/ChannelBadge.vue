<script setup lang="ts">
import type { ChannelKey } from '~~/types'

const props = withDefaults(defineProps<{ channel: ChannelKey; size?: 'sm' | 'md' }>(), {
  size: 'sm',
})
const pro = computed(() => props.channel === 'proReplays')
</script>

<template>
  <span
    class="cut-bl-6 whitespace-nowrap font-sans font-bold uppercase tracking-[.1em]"
    :class="[
      size === 'sm' ? 'px-2 py-1 text-[8.5px]' : 'px-[9px] py-1 text-[9px]',
      pro
        ? 'border border-transparent bg-accent text-[#050607]'
        : 'border border-[rgba(56,207,255,.5)] bg-[rgba(56,207,255,.14)] text-accent2',
    ]"
    >{{ pro ? 'Pro Replays' : 'High Level' }}</span
  >
</template>

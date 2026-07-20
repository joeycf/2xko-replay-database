<template>
  <span
    class="inline-flex items-center"
    :class="size === 'sm' ? 'gap-[5px]' : 'gap-1.5'"
  >
    <span
      class="flex-none rotate-45"
      :class="size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2'"
      :style="{ background: accent }"
      aria-hidden="true"
    />
    <span
      class="font-mono font-semibold uppercase tracking-[.06em]"
      :class="size === 'sm' ? 'text-[10px]' : 'text-[11px]'"
      :style="{ color: accent }"
      >{{ fuseName(fuseId) }}</span
    >
  </span>
</template>

<script setup lang="ts">
// Small fuse identity tag: accent diamond + name (the "clean rendering" of the
// in-game HUD pill — accents in data/fuses.json are sampled from the pill art).
const props = withDefaults(defineProps<{ fuseId: string; size?: 'sm' | 'md' }>(), { size: 'md' });

const { fuseName, fuseAccent } = useFuses();

const accent = computed(() => fuseAccent(props.fuseId));
</script>

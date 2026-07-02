<script setup lang="ts">
defineProps<{ title: string; hint?: string }>()
</script>

<template>
  <section class="border border-white/[0.08] bg-[#0F1118] p-4 md:px-6 md:py-[22px]">
    <div class="mb-3.5 flex items-center gap-2.5 md:mb-[18px]">
      <span class="h-2 w-2 flex-none rotate-45 bg-accent" />
      <h2 class="font-display text-[15px] font-semibold text-ink-primary md:text-[17px]">
        {{ title }}
      </h2>
      <span v-if="hint" class="ml-auto font-mono text-[10px] text-ink-muted md:text-[11px]">{{
        hint
      }}</span>
    </div>
    <slot />
  </section>
</template>

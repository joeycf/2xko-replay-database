<template>
  <span
    class="inline-block flex-none rotate-45 bg-accent"
    :style="{
      width: `${size}px`,
      height: `${size}px`
    }"
    title="Verified pro"
  />
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 9 });
</script>

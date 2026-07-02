<script setup lang="ts">
// The static host's not-found document: prerendered here, then copied over
// nitro's SPA-fallback 404.html by scripts/postgenerate.mjs (Vercel serves
// 404.html for unknown URLs). Client-side unknown navigations go through the
// [...slug] catch-all → error.vue instead, which shows the same content.
useHead({
  title: '404 — 2XKO Replay Database',
  meta: [{ name: 'robots', content: 'noindex' }],
})
</script>

<template>
  <NotFoundContent />
</template>

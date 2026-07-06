<template>
  <div />
</template>

<script setup lang="ts">
// Catch-all: any route not matched by a real page is a 404. This is what
// makes the prerendered /404.html carry the designed error page (the static
// host serves it for unknown URLs), and covers client-side navigation too.
throw createError({
  statusCode: 404,
  statusMessage: 'Page not found',
  fatal: true
});
</script>

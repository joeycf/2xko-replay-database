<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const code = computed(() => props.error?.statusCode ?? 500)

useHead({
  title: `${code.value} — 2XKO Replay Database`,
  meta: [{ name: 'robots', content: 'noindex' }],
})
</script>

<template>
  <NuxtLayout>
    <NotFoundContent
      :code="code"
      :message="code === 404 ? undefined : (error?.message ?? 'Unexpected error.')"
    />
  </NuxtLayout>
</template>

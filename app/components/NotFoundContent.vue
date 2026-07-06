<template>
  <section class="mx-auto max-w-2xl px-6 py-20 text-center md:py-28">
    <div
      class="mx-auto flex h-24 w-24 items-center justify-center bg-accent cut-14"
      aria-hidden="true"
    >
      <span class="font-display text-[26px] font-bold text-[#08090c]">{{ code }}</span>
    </div>
    <h1 class="mt-7 font-display text-d2 font-bold text-ink-primary">
      {{ code === 404 ? 'No data at this route' : 'Something broke the combo' }}
    </h1>
    <p class="mt-3 font-mono text-[12px] text-ink-muted">
      {{ message ?? 'That champion, player, or page isn\'t in the database.' }}
    </p>
    <button
      type="button"
      class="mt-8 cursor-pointer bg-accent px-5 py-3 font-sans text-[14px] font-bold text-[#08090c] cut-bl-10"
      @click="back"
    >
      Back to Browse
    </button>
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ code?: number; message?: string }>(), {
  code: 404,
  message: undefined
});

const back = () => clearError({ redirect: '/' });
</script>

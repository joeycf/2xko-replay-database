<script setup lang="ts">
// Lite-YouTube facade: thumbnail + play button first; the youtube-nocookie
// iframe is injected only on click. Grid cards never render this.
const props = defineProps<{ videoId: string; thumbnail?: string | null; title?: string }>()

const playing = ref(false)
watch(
  () => props.videoId,
  () => (playing.value = false),
)
const embedSrc = computed(
  () => `https://www.youtube-nocookie.com/embed/${props.videoId}?autoplay=1&rel=0`,
)
</script>

<template>
  <div
    class="relative aspect-video overflow-hidden border-b border-white/[0.09]"
    style="background: radial-gradient(circle at 50% 40%, #171a22, #0a0b0f)"
  >
    <iframe
      v-if="playing"
      :src="embedSrc"
      class="absolute inset-0 h-full w-full border-0"
      :title="title ?? 'YouTube video'"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen
    />
    <button
      v-else
      type="button"
      class="group absolute inset-0 block h-full w-full cursor-pointer"
      :aria-label="`Play — ${title ?? 'replay'}`"
      @click="playing = true"
    >
      <img
        v-if="thumbnail"
        :src="thumbnail"
        :alt="title ?? ''"
        class="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        decoding="async"
      />
      <span class="absolute inset-0 flex items-center justify-center bg-[rgba(6,7,11,.18)]">
        <span
          class="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-accent shadow-[0_8px_30px_rgba(255,46,136,.5)] transition-transform duration-200 ease-snap group-hover:scale-105"
        >
          <span
            class="ml-[5px] h-0 w-0 border-y-[13px] border-l-[21px] border-y-transparent border-l-white"
          />
        </span>
      </span>
    </button>
  </div>
</template>

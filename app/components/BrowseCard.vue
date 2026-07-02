<script setup lang="ts">
import type { Team, VideoRecord } from '~~/types'

const props = defineProps<{ video: VideoRecord }>()
const { open } = useVideoModal()
const { players: playerRegistry } = usePlayers()

const left = computed<Team | undefined>(() => props.video.teams[0])
const right = computed<Team | undefined>(() => props.video.teams[1])
const hasMatchup = computed(() => props.video.teams.length === 2)

const playerLabel = (t?: Team) => t?.players.map((p) => p.displayName).join(' + ') ?? ''
const hasVerified = (t?: Team) =>
  !!t?.players.some((p) => playerRegistry.value[p.id]?.verified)

const metaLine = computed(
  () => `${seasonLabel(props.video.season)} · ${matchTypeLabel(props.video.matchType)}`,
)
</script>

<template>
  <!-- accessible name comes from the visible content (players, champions,
       views) — an aria-label of the raw title would mismatch it (WCAG 2.5.3) -->
  <button
    type="button"
    class="group block w-full cursor-pointer border border-white/[0.09] bg-[#0F1118] text-left transition-[transform,border-color] duration-200 ease-snap cut-14 hover:border-accent/50 motion-safe:hover:-translate-y-1"
    :data-video-id="video.id"
    @click="open(video.id)"
  >
    <!-- thumbnail -->
    <div
      class="relative aspect-video overflow-hidden"
      style="background: repeating-linear-gradient(135deg, #141821, #141821 9px, #10131a 9px, #10131a 18px)"
    >
      <img
        v-if="video.thumbnail"
        :src="video.thumbnail"
        alt=""
        class="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        decoding="async"
      />
      <ChannelBadge :channel="video.channel" class="absolute left-[9px] top-[9px]" />
      <span
        v-if="video.durationSec > 0"
        class="absolute bottom-[9px] right-[9px] bg-[rgba(6,7,11,.82)] px-[7px] py-[3px] font-mono text-[11px] text-white"
        >{{ formatDuration(video.durationSec) }}</span
      >
      <span
        class="absolute bottom-[9px] left-[9px] hidden font-mono text-[9px] tracking-[.08em] text-[#9198a8] sm:block"
        >{{ metaLine }}</span
      >
      <!-- hover play affordance -->
      <span
        class="absolute inset-0 flex items-center justify-center bg-[rgba(6,7,11,.32)] opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <span
          class="flex h-11 w-11 items-center justify-center rounded-full bg-accent shadow-[0_6px_22px_rgba(255,46,136,.5)]"
        >
          <span class="ml-[3px] h-0 w-0 border-y-8 border-l-[13px] border-y-transparent border-l-white" />
        </span>
      </span>
    </div>

    <!-- body -->
    <div class="px-3.5 py-[13px]">
      <!-- matchup -->
      <div v-if="hasMatchup" class="flex items-center justify-center gap-2.5">
        <div class="flex">
          <ChampBadge
            v-for="(c, i) in left!.characters.slice(0, 2)"
            :key="c"
            :champion-id="c"
            :size="28"
            :font-size="11"
            :class="i > 0 ? '-ml-[7px]' : ''"
          />
          <ChampBadge v-if="left!.characters.length === 0" :size="28" :font-size="11" />
        </div>
        <span class="font-display text-[12px] font-bold text-ink-muted">VS</span>
        <div class="flex">
          <ChampBadge
            v-for="(c, i) in right!.characters.slice(0, 2)"
            :key="c"
            :champion-id="c"
            :size="28"
            :font-size="11"
            :class="i > 0 ? '-ml-[7px]' : ''"
          />
          <ChampBadge v-if="right!.characters.length === 0" :size="28" :font-size="11" />
        </div>
      </div>
      <div v-else class="truncate text-center font-sans text-[12.5px] font-semibold text-ink-secondary">
        {{ video.title }}
      </div>

      <!-- players -->
      <div v-if="hasMatchup" class="mt-[11px] flex items-center justify-between gap-2">
        <span class="inline-flex min-w-0 items-center gap-[5px]">
          <VerifiedMark v-if="hasVerified(left)" />
          <span class="truncate font-sans text-[12.5px] font-semibold text-ink-primary">{{
            playerLabel(left)
          }}</span>
        </span>
        <span class="inline-flex min-w-0 items-center justify-end gap-[5px]">
          <span class="truncate font-sans text-[12.5px] font-semibold text-ink-primary">{{
            playerLabel(right)
          }}</span>
          <VerifiedMark v-if="hasVerified(right)" />
        </span>
      </div>

      <!-- meta -->
      <div
        class="mt-2.5 flex items-center justify-between border-t border-white/[0.07] pt-2.5 font-mono text-[10px] text-ink-muted"
      >
        <span>{{ formatViews(video.viewCount) }} views</span>
        <span>{{ relativeDate(video.publishedAt) }}</span>
      </div>
    </div>
  </button>
</template>

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
      <ChannelBadge
        :channel="video.channel"
        class="absolute left-[9px] top-[9px]"
      />
      <span
        v-if="video.durationSec > 0"
        class="absolute bottom-[9px] right-[9px] bg-[rgba(6,7,11,.82)] px-[7px] py-[3px] font-mono text-[11px] text-white"
      >{{ formatDuration(video.durationSec) }}</span>
      <span class="absolute bottom-[9px] left-[9px] hidden font-mono text-[9px] tracking-[.08em] text-[#9198a8] sm:block">{{ metaLine }}</span>
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
      <!-- matchup — EXTENDED vs design (dc.html cards are fixed 2v2): set-level
           tournament entries carry a champion UNION per side (3, 4+…), so each
           cluster renders its full characters[] list. A 1fr/auto/1fr grid keeps
           VS dead-center whatever the counts; badges shrink as the bigger side
           grows and wrap inside their own cell — the card never widens. -->
      <div
        v-if="hasMatchup"
        class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2.5"
      >
        <div class="flex flex-wrap items-center justify-end gap-y-1">
          <ChampBadge
            v-for="(c, i) in left!.characters"
            :key="c"
            :champion-id="c"
            :size="badge.size"
            :font-size="badge.font"
            :notch="badge.notch"
            :class="i > 0 ? badge.overlap : ''"
          />
          <ChampBadge
            v-if="left!.characters.length === 0"
            :size="badge.size"
            :font-size="badge.font"
            :notch="badge.notch"
          />
        </div>
        <span class="font-display text-[12px] font-bold text-ink-muted">VS</span>
        <div class="flex flex-wrap items-center justify-start gap-y-1">
          <ChampBadge
            v-for="(c, i) in right!.characters"
            :key="c"
            :champion-id="c"
            :size="badge.size"
            :font-size="badge.font"
            :notch="badge.notch"
            :class="i > 0 ? badge.overlap : ''"
          />
          <ChampBadge
            v-if="right!.characters.length === 0"
            :size="badge.size"
            :font-size="badge.font"
            :notch="badge.notch"
          />
        </div>
      </div>
      <div
        v-else
        class="truncate text-center font-sans text-[12.5px] font-semibold text-ink-secondary"
      >
        {{ video.title }}
      </div>

      <!-- fuse identity — NEW vs design (requested at launch): same attribution
           rules as the modal. Ordered → each fuse on its own side; unordered →
           the pair centered/unbound (pinning left/right could be wrong); no
           detection (incl. all tournament entries) → nothing at all. -->
      <div
        v-if="hasMatchup && fusesUnordered && (fuseA || fuseB)"
        data-testid="card-fuses-unordered"
        title="Fuses detected — side attribution unconfirmed"
        class="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5"
      >
        <FuseTag
          v-if="fuseA"
          :fuse-id="fuseA"
          size="sm"
        />
        <span
          v-if="fuseA && fuseB"
          class="font-mono text-[10px] text-ink-muted"
        >·</span>
        <FuseTag
          v-if="fuseB"
          :fuse-id="fuseB"
          size="sm"
        />
      </div>
      <div
        v-else-if="hasMatchup && (fuseA || fuseB)"
        class="mt-2 flex items-center justify-between gap-2"
      >
        <span class="min-w-0">
          <FuseTag
            v-if="fuseA"
            data-testid="card-fuse-a"
            :fuse-id="fuseA"
            size="sm"
          />
        </span>
        <span class="min-w-0">
          <FuseTag
            v-if="fuseB"
            data-testid="card-fuse-b"
            :fuse-id="fuseB"
            size="sm"
          />
        </span>
      </div>

      <!-- players -->
      <div
        v-if="hasMatchup"
        class="mt-[11px] flex items-center justify-between gap-2"
      >
        <span class="inline-flex min-w-0 items-center gap-[5px]">
          <VerifiedMark v-if="hasVerified(left)" />
          <span class="truncate font-sans text-[12.5px] font-semibold text-ink-primary">{{ playerLabel(left) }}</span>
        </span>
        <span class="inline-flex min-w-0 items-center justify-end gap-[5px]">
          <span class="truncate font-sans text-[12.5px] font-semibold text-ink-primary">{{ playerLabel(right) }}</span>
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

<script setup lang="ts">
import type { Team, VideoRecord } from '~~/types';

const props = defineProps<{ video: VideoRecord }>();

const { open } = useVideoModal();
const { players: playerRegistry } = usePlayers();

const playerLabel = (t?: Team) => t?.players.map((p) => p.displayName).join(' + ') ?? '';
const hasVerified = (t?: Team) =>
  !!t?.players.some((p) => playerRegistry.value[p.id]?.verified);

const left = computed<Team | undefined>(() => props.video.teams[0]);
const right = computed<Team | undefined>(() => props.video.teams[1]);
const hasMatchup = computed(() => props.video.teams.length === 2);
const metaLine = computed(
  () => `${seasonLabel(props.video.season)} · ${matchTypeLabel(props.video.matchType)}`
);

// badge sizing follows the BIGGER side so both clusters stay visually matched:
// 2 per side is the design's 28px; unions shrink toward 21px and, past ~6,
// wrap to a second row inside their own grid cell (footprint over full size)
const badge = computed(() => {
  const n = Math.max(left.value?.characters.length ?? 0, right.value?.characters.length ?? 0);
  if (n <= 2) return { size: 28, font: 11, notch: 7, overlap: '-ml-[7px]' };
  if (n === 3) return { size: 24, font: 10, notch: 6, overlap: '-ml-1.5' };
  return { size: 21, font: 9, notch: 5, overlap: '-ml-[5px]' };
});

// same per-side vs unbound semantics as the modal (fusesUnordered records are
// a confident PAIR with unknown side attribution — never pin those)
const fuseA = computed(() => left.value?.fuse ?? null);
const fuseB = computed(() => right.value?.fuse ?? null);
const fusesUnordered = computed(() => !!props.video.fusesUnordered);
</script>

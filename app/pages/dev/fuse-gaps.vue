<template>
  <section class="mx-auto w-full max-w-[1440px] px-4 py-8 md:px-[26px]">
    <ClientOnly>
      <p class="font-mono text-label uppercase text-text-muted">Diagnostic — dev only</p>
      <h1 class="mt-1 font-display text-d2 font-bold text-text">Fuse gaps</h1>

      <template v-if="gapsError">
        <p class="mt-6 font-mono text-body text-warning">
          No gap report found — run <span class="text-text">npm run data:fuse-gaps</span> first.
        </p>
      </template>
      <template v-else-if="gaps">
        <p class="mt-2 font-mono text-[12px] text-text-muted">
          generated {{ gaps.generatedAt.slice(0, 16).replace('T', ' ') }} · attempt universe
          {{ gaps.universe.commit }} ({{ gaps.universe.videos.toLocaleString() }} ids) · full report
          in cache/fuse/review/fuse-gaps.md
        </p>

        <!-- summary cards -->
        <div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div class="cut border border-white/10 bg-surface p-4">
            <div class="font-mono text-data-xl text-text">{{ gaps.totals.missing }}</div>
            <div class="mt-1 font-ui text-label uppercase text-text-muted">
              missing / {{ gaps.totals.videos.toLocaleString() }}
            </div>
          </div>
          <button
            v-for="b in bucketDefs"
            :key="b.id"
            type="button"
            class="cut border p-4 text-left transition-colors"
            :class="
              bucket === b.id
                ? 'border-primary bg-surface'
                : 'border-white/10 bg-surface hover:border-white/25'
            "
            @click="bucket = bucket === b.id ? 'all' : b.id"
          >
            <div
              class="font-mono text-data-xl"
              :class="bucket === b.id ? 'text-primary' : 'text-text'"
            >
              {{ gaps.counts[b.id] }}
            </div>
            <div class="mt-1 font-ui text-label uppercase text-text-muted">{{ b.label }}</div>
          </button>
        </div>

        <!-- era filter -->
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <span class="font-mono text-[11px] uppercase text-text-muted">era</span>
          <button
            v-for="e in ['all', ...eras]"
            :key="e"
            type="button"
            class="border px-2.5 py-1 font-mono text-[11px] uppercase transition-colors"
            :class="
              era === e
                ? 'border-primary text-primary'
                : 'border-white/10 text-text-secondary hover:border-white/25'
            "
            @click="era = e"
          >
            {{ e }}
          </button>
          <span class="ml-auto font-mono text-[12px] text-text-muted"
            >{{ filtered.length }} shown</span
          >
        </div>

        <!-- gap grid -->
        <div class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <div v-for="{ gap, video } in filtered" :key="gap.id" class="flex flex-col">
            <BrowseCard :replay="toReplay(video)" />
            <!-- bucket-specific footer -->
            <div
              class="border border-t-0 border-white/[0.09] bg-[#0C0D12] px-3 py-2 font-mono text-[11px] text-text-secondary"
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="uppercase text-text-muted">{{ gap.bucket }}</span>
                <span>{{ gap.era }}</span>
                <span v-if="gap.bucket === 'unavailable' || gap.bucket === 'pending'">{{
                  gap.publishedAt.slice(0, 10)
                }}</span>
                <span v-for="f in gap.flags" :key="f" class="text-warning">{{ f }}</span>
                <span
                  v-if="gap.attempts"
                  :class="gap.attempts.length >= 2 ? 'text-warning' : 'text-text-muted'"
                  >tried {{ gap.attempts.length }}×</span
                >
                <a
                  :href="`https://youtu.be/${gap.id}`"
                  target="_blank"
                  rel="noopener"
                  class="ml-auto text-text-muted underline decoration-white/20 hover:text-text"
                  >youtube ↗</a
                >
              </div>
              <div v-if="gap.detection" class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="inline-flex items-center gap-1.5">
                  L
                  <FuseTag v-if="gap.detection.left" :fuse-id="gap.detection.left" size="sm" />
                  <span v-else>∅</span>
                  <span class="text-text-muted">d{{ gap.detection.score.left }}</span>
                </span>
                <span class="inline-flex items-center gap-1.5">
                  R
                  <FuseTag v-if="gap.detection.right" :fuse-id="gap.detection.right" size="sm" />
                  <span v-else>∅</span>
                  <span class="text-text-muted">d{{ gap.detection.score.right }}</span>
                </span>
                <button
                  v-if="gap.frames > 0"
                  type="button"
                  class="ml-auto border border-white/10 px-2 py-0.5 uppercase hover:border-white/25"
                  :class="pillsOpen.has(gap.id) ? 'text-primary' : 'text-text-secondary'"
                  @click="togglePills(gap.id)"
                >
                  pills
                </button>
              </div>
              <!-- pill strips from cached frames (dev API crops on the fly) -->
              <div v-if="pillsOpen.has(gap.id)" class="mt-2 space-y-1.5">
                <div
                  v-for="side in ['left', 'right'] as const"
                  :key="side"
                  class="flex items-center gap-1.5"
                >
                  <span class="w-3 flex-none text-text-muted">{{
                    side === 'left' ? 'L' : 'R'
                  }}</span>
                  <a
                    v-for="n in framePicks(gap.frames)"
                    :key="n"
                    :href="`/api/dev/fuse-frame?id=${gap.id}&n=${n}`"
                    target="_blank"
                    rel="noopener"
                    title="open full frame"
                    class="min-w-0"
                  >
                    <img
                      :src="`/api/dev/fuse-pill?id=${gap.id}&n=${n}&side=${side}`"
                      :alt="`${gap.id} ${side} pill, frame ${n}`"
                      loading="lazy"
                      class="h-9 border border-white/10"
                    />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        <VideoModal />
      </template>
      <div v-else class="mt-8 font-mono text-body text-text-muted">Loading…</div>
    </ClientOnly>
  </section>
</template>

<script setup lang="ts">
// Dev-only fuse-gap viewer: eyeball missing-fuse videos (thumbnail, in-app
// playback via the shared modal, pill crops for LOW adjudication). Never part
// of the shipped site — not in publicRoutes/sitemap, nothing links here so the
// prerender crawler can't reach it, and this guard 404s any production render.
import type { Replay, Side } from '@engine/types';
import type { FuseGapBucket, FuseGapItem, FuseGapReport, VideoRecord } from '~~/types';

if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' });
}

const { videos } = useDevVideos();

// rich record → the engine BrowseCard's generic Replay (display-only mirror of
// scripts/emit.ts toReplay — that module is node-side and can't import here)
const emptySide = (): Side => ({ player: '', characters: [] });
const toReplay = (v: VideoRecord): Replay => ({
  id: v.id,
  sides: (v.teams.length === 2
    ? v.teams.map((t) => ({
        player: t.players[0]?.id ?? '',
        ...(t.players.length > 1 ? { players: t.players.map((p) => p.id) } : {}),
        characters: t.characters,
      }))
    : [emptySide(), emptySide()]) as [Side, Side],
  date: v.publishedAt,
  patch: v.season === null ? 'Beta' : `S${v.season}`,
  source: v.channel,
  title: v.title,
  views: v.viewCount,
  thumb: v.thumbnail,
  ...(v.durationSec > 0 ? { durationSec: v.durationSec } : {}),
});
const { data: gaps, error: gapsError } = useAsyncData(
  'fuse-gaps',
  () => $fetch<FuseGapReport>('/api/dev/fuse-gaps'),
  { server: false },
);

const bucketDefs: { id: FuseGapBucket; label: string }[] = [
  { id: 'unavailable', label: 'unavailable' },
  { id: 'low', label: 'low-confidence' },
  { id: 'none', label: 'none' },
  { id: 'pending', label: 'not processed' },
  { id: 'anomaly', label: 'anomaly' },
];

const bucket = ref<FuseGapBucket | 'all'>('all');
const era = ref('all');
const pillsOpen = ref(new Set<string>());

const byId = computed(() => new Map(videos.value.map((v) => [v.id, v])));
const joined = computed(() =>
  (gaps.value?.items ?? [])
    .map((gap) => ({ gap, video: byId.value.get(gap.id) }))
    .filter((x): x is { gap: FuseGapItem; video: VideoRecord } => !!x.video),
);
const eras = computed(() => [...new Set(joined.value.map((x) => x.gap.era))]);
const filtered = computed(() =>
  joined.value.filter(
    (x) =>
      (bucket.value === 'all' || x.gap.bucket === bucket.value) &&
      (era.value === 'all' || x.gap.era === era.value),
  ),
);

function togglePills(id: string) {
  const next = new Set(pillsOpen.value);
  if (!next.delete(id)) next.add(id);
  pillsOpen.value = next;
}

/** early / mid / last cached frame numbers (frames are 01.png … NN.png) */
function framePicks(frames: number): string[] {
  return [...new Set([Math.min(3, frames), Math.ceil(frames / 2), frames])]
    .filter((n) => n >= 1)
    .map((n) => String(n).padStart(2, '0'));
}

useHead({
  title: 'Fuse gaps (dev) — 2XKO Replay Database',
  meta: [
    {
      name: 'robots',
      content: 'noindex',
    },
  ],
});
</script>

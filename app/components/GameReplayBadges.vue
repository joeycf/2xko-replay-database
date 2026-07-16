<script setup lang="ts">
// 2XKO fuse badges — same-path override of the engine's empty GameReplayBadges
// (v0.3.0 badge slot). Restores the shipped attribution rules:
//   ordered      → each fuse pinned to its side (card row variant here; the
//                  modal's per-side tags live in GameSideBadge)
//   fusesUnordered → the pair rendered together and UNBOUND — pinning
//                  left/right could be wrong, so it never is
//   null / undetected (incl. all tournament entries) → nothing at all
import type { Replay } from '@engine/types';

const props = defineProps<{ replay: Replay; context: 'card' | 'modal' }>();

const { replayFuses } = useFuses();
const info = computed(() => replayFuses(props.replay));
// structural records (empty sides) render title-only cards — no fuse row
const hasSides = computed(() => props.replay.sides.some((s) => s.characters.length > 0));
</script>

<template>
  <!-- card: the shipped BrowseCard fuse rows -->
  <template v-if="context === 'card'">
    <div
      v-if="hasSides && info.unordered && (info.a || info.b)"
      data-testid="card-fuses-unordered"
      title="Fuses detected — side attribution unconfirmed"
      class="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5"
    >
      <FuseTag v-if="info.a" :fuse-id="info.a" size="sm" />
      <span v-if="info.a && info.b" class="font-mono text-[10px] text-text-muted">·</span>
      <FuseTag v-if="info.b" :fuse-id="info.b" size="sm" />
    </div>
    <div
      v-else-if="hasSides && (info.a || info.b)"
      class="mt-2 flex items-center justify-between gap-2"
    >
      <span class="min-w-0">
        <FuseTag v-if="info.a" data-testid="card-fuse-a" :fuse-id="info.a" size="sm" />
      </span>
      <span class="min-w-0">
        <FuseTag v-if="info.b" data-testid="card-fuse-b" :fuse-id="info.b" size="sm" />
      </span>
    </div>
  </template>

  <!-- modal: the shipped unbound pair row (ordered tags are GameSideBadge's) -->
  <div
    v-else-if="info.unordered && (info.a || info.b)"
    data-testid="fuses-unordered"
    title="Fuses detected for this match — side attribution unconfirmed"
    class="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 md:justify-center"
  >
    <span class="font-ui text-[10px] font-semibold uppercase tracking-label text-text-muted"
      >Fuses</span
    >
    <FuseTag v-if="info.a" :fuse-id="info.a" />
    <span v-if="info.a && info.b" class="font-mono text-[11px] text-text-muted">·</span>
    <FuseTag v-if="info.b" :fuse-id="info.b" />
  </div>
</template>

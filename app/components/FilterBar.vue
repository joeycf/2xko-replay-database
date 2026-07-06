<template>
  <div class="border-b border-white/[0.07] bg-base px-4 py-4 md:px-[26px]">
    <!-- champion facet -->
    <div
      :class="labelClass"
      class="mb-2.5"
    >
      Champion · team includes
    </div>
    <div class="flex flex-wrap items-center gap-[7px]">
      <button
        v-for="c in champions"
        :key="c.id"
        type="button"
        :title="c.name"
        :aria-pressed="f.selectedChampions.value.includes(c.id)"
        class="flex h-9 w-9 flex-none cursor-pointer items-center justify-center border-2 p-0 font-display text-[12px] font-bold text-[#050607] transition-[opacity,border-color] duration-150 cut-8"
        :style="{
          background: champGradient(c.accent),
          borderColor: f.selectedChampions.value.includes(c.id) ? (c.accent ?? '#fff') : 'rgba(255,255,255,.12)',
          opacity: f.selectedChampions.value.includes(c.id) ? 1 : 0.46
        }"
        @click="f.toggleChampion(c.id)"
      >
        {{ championInitials(c) }}
      </button>
      <button
        type="button"
        class="h-9 cursor-pointer border px-3.5 font-sans text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        :class="togClass(f.sameSide.value)"
        :disabled="!sameSideUsable && !f.sameSide.value"
        :title="sameSideUsable ? 'Require selected champions on one team' : 'Select 2 champions first'"
        :aria-pressed="f.sameSide.value"
        @click="f.toggleSameSide()"
      >
        ◆ Same side
      </button>
    </div>

    <!-- channel · season · type · sort -->
    <div class="mt-4 flex flex-wrap items-center gap-[18px]">
      <div class="flex items-center gap-1.5">
        <span
          :class="labelClass"
          class="mr-1"
        >
          Channel
        </span>
        <button
          type="button"
          class="cursor-pointer border px-[13px] py-2 font-sans text-[12px] font-semibold cut-bl-7"
          :class="togClass(f.channel.value === 'proReplays')"
          :aria-pressed="f.channel.value === 'proReplays'"
          @click="f.toggleChannel('proReplays')"
        >
          Pro Replays
        </button>
        <button
          type="button"
          class="cursor-pointer border px-[13px] py-2 font-sans text-[12px] font-semibold cut-bl-7"
          :class="highClass"
          :aria-pressed="f.channel.value === 'highLevel'"
          @click="f.toggleChannel('highLevel')"
        >
          High Level
        </button>
      </div>
      <span class="h-6 w-px bg-white/10" />
      <div class="flex items-center gap-1.5">
        <span
          :class="labelClass"
          class="mr-1"
        >
          Season
        </span>
        <button
          v-for="s in [0, 1, 2]"
          :key="s"
          type="button"
          class="h-[34px] w-[34px] cursor-pointer border font-mono text-[13px]"
          :class="togClass(f.season.value === s)"
          :aria-pressed="f.season.value === s"
          @click="f.toggleSeason(s)"
        >
          {{ s }}
        </button>
        <button
          type="button"
          class="h-[34px] cursor-pointer border px-3 font-mono text-[13px]"
          :class="togClass(f.season.value === 'beta')"
          :aria-pressed="f.season.value === 'beta'"
          title="Pre-Season-0 footage"
          @click="f.toggleSeason('beta')"
        >
          Beta
        </button>
      </div>
      <span class="h-6 w-px bg-white/10" />
      <div class="flex items-center gap-1.5">
        <span
          :class="labelClass"
          class="mr-1"
        >
          Type
        </span>
        <button
          type="button"
          class="cursor-pointer border px-[13px] py-2 font-sans text-[12px] font-semibold"
          :class="togClass(f.matchType.value === 'ranked')"
          :aria-pressed="f.matchType.value === 'ranked'"
          @click="f.toggleMatchType('ranked')"
        >
          Ranked
        </button>
        <button
          type="button"
          class="cursor-pointer border px-[13px] py-2 font-sans text-[12px] font-semibold"
          :class="togClass(f.matchType.value === 'duo')"
          :aria-pressed="f.matchType.value === 'duo'"
          @click="f.toggleMatchType('duo')"
        >
          Duo
        </button>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <label
          :class="labelClass"
          for="browse-sort"
        >
          Sort
        </label>
        <select
          id="browse-sort"
          :value="f.sort.value"
          class="cursor-pointer border border-white/[0.14] bg-[#141722] px-3 py-[9px] font-sans text-[12px] font-semibold text-ink-primary"
          @change="f.setSort(($event.target as HTMLSelectElement).value as VideoSort)"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="views">Most viewed</option>
          <option value="longest">Longest</option>
        </select>
      </div>
    </div>

    <!-- fuse facet — NEW vs the design mockups (Phase 4 omitted it): anatomy
         ported from the Season/Type chip groups; accents from the HUD pill art.
         Chips exist only for fuses with detections, OR-matched on either team. -->
    <div class="mt-4">
      <div class="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span :class="labelClass">Fuse · either team</span>
        <span
          data-testid="fuse-coverage"
          class="font-mono text-[10px] text-ink-muted"
        >
          fuse identified for {{ coverage.withFuse.toLocaleString('en-US') }} of
          {{ coverage.total.toLocaleString('en-US') }} replays
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-[7px]">
        <button
          v-for="fu in fuseChips"
          :key="fu.id"
          type="button"
          class="inline-flex h-9 cursor-pointer items-center gap-2 border px-[13px] font-sans text-[12px] font-semibold transition-colors cut-bl-7"
          :class="
            f.selectedFuses.value.includes(fu.id)
              ? ''
              : 'border-white/[0.12] bg-[#141722] text-ink-secondary hover:text-ink-primary'
          "
          :style="fuseChipStyle(fu.id, fu.accent)"
          :aria-pressed="f.selectedFuses.value.includes(fu.id)"
          :data-testid="`fuse-chip-${fu.id}`"
          @click="f.toggleFuse(fu.id)"
        >
          <span
            class="h-2 w-2 flex-none rotate-45"
            :style="{ background: fu.accent ?? '#8B93A8' }"
          />
          {{ fu.name }}
        </button>
      </div>
    </div>

    <!-- player facet -->
    <div class="mt-4">
      <div
        :class="labelClass"
        class="mb-2.5"
      >
        Player · featured
      </div>
      <div class="flex flex-wrap items-center gap-[7px]">
        <button
          v-for="p in featured"
          :key="p.id"
          type="button"
          class="inline-flex cursor-pointer items-center gap-1.5 border bg-[#141722] px-[11px] py-1.5 font-sans text-[12px] font-semibold text-ink-primary"
          :style="{ borderColor: f.selectedPlayers.value.includes(p.id) ? '#FF2E88' : 'rgba(255,255,255,.12)' }"
          :aria-pressed="f.selectedPlayers.value.includes(p.id)"
          @click="f.togglePlayer(p.id)"
        >
          <VerifiedMark
            v-if="p.verified"
            :size="10"
          />
          {{ p.displayName }}
          <span class="font-mono text-[10px] text-ink-muted">{{ p.appearances }}</span>
        </button>
        <div class="relative">
          <button
            type="button"
            class="cursor-pointer border border-dashed border-[rgba(56,207,255,.4)] bg-transparent px-[11px] py-1.5 font-sans text-[12px] font-semibold text-accent2"
            :aria-expanded="typeaheadOpen"
            @click="typeaheadOpen = !typeaheadOpen"
          >
            Search all {{ ranked.length.toLocaleString() }} players ▾
          </button>
          <PlayerTypeahead
            v-if="typeaheadOpen"
            @close="typeaheadOpen = false"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Desktop filter bar — port of design 1A rows: champion chips + same-side,
// channel/season/type/sort, player facet with featured chips + typeahead.
import type { VideoSort } from '~/composables/useFilters';

const { list: champions } = useChampions();
const { ranked, featured } = useFeaturedPlayers();
const { detected: fuseChips, coverage } = useFuses();
const f = useFilters();

const typeaheadOpen = ref(false);

const fuseChipStyle = (id: string, accent: string | null) =>
  f.selectedFuses.value.includes(id)
    ? {
        borderColor: accent ?? '#F4F5F8',
        background: `${accent ?? '#F4F5F8'}26`,
        color: '#F4F5F8'
      }
    : {};

const togClass = (on: boolean) =>
  on
    ? 'bg-accent text-[#08090c] border-accent'
    : 'bg-[#141722] text-ink-secondary border-white/[0.12] hover:text-ink-primary';

const labelClass = 'font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted';

const sameSideUsable = computed(() => f.selectedChampions.value.length >= 2);
const highClass = computed(() =>
  f.channel.value === 'highLevel'
    ? 'bg-[rgba(56,207,255,.16)] text-accent2 border-accent2'
    : 'bg-[#141722] text-ink-secondary border-white/[0.12] hover:text-ink-primary'
);
</script>

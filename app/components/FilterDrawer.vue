<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex items-end md:hidden"
      >
        <button
          type="button"
          class="absolute inset-0 cursor-default bg-[rgba(6,7,11,.6)]"
          aria-label="Close filters"
          @click="close"
        />
        <div
          class="drawer-sheet relative flex max-h-[85vh] w-full flex-col rounded-t-[22px] border-t border-white/[0.14] bg-surface shadow-[0_-24px_60px_rgba(0,0,0,.6)]"
          role="dialog"
          aria-modal="true"
          aria-label="Filters"
        >
          <!-- handle + header -->
          <div class="relative flex flex-none items-center px-[18px] pb-2.5 pt-4">
            <span
              class="absolute left-1/2 top-[9px] h-[5px] w-11 -translate-x-1/2 rounded-[3px] bg-[#2a2d38]"
            />
            <span class="mt-1.5 font-display text-[18px] font-bold text-ink-primary">Filters</span>
            <span class="ml-auto mt-1.5 font-mono text-[12px] text-accent2">
              <b class="text-white">{{ pending ? '…' : f.filtered.value.length.toLocaleString() }}</b>
              results
            </span>
          </div>

          <!-- facets -->
          <div class="min-h-0 flex-1 overflow-y-auto px-[18px] pb-3 pt-1.5">
            <div
              :class="labelClass"
              class="my-2.5"
            >
              Champion · team includes
            </div>
            <div class="flex flex-wrap gap-[7px]">
              <button
                v-for="c in champions"
                :key="c.id"
                type="button"
                :title="c.name"
                :aria-pressed="f.selectedChampions.value.includes(c.id)"
                class="flex h-[38px] w-[38px] flex-none cursor-pointer items-center justify-center border-2 p-0 font-display text-[12px] font-bold text-[#050607] cut-8"
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
                class="h-[38px] cursor-pointer border px-3.5 font-sans text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                :class="togClass(f.sameSide.value)"
                :disabled="f.selectedChampions.value.length < 2 && !f.sameSide.value"
                :aria-pressed="f.sameSide.value"
                @click="f.toggleSameSide()"
              >
                ◆ Same side
              </button>
            </div>

            <div
              :class="labelClass"
              class="mb-2.5 mt-5"
            >
              Channel
            </div>
            <div class="flex gap-2">
              <button
                type="button"
                class="flex-1 cursor-pointer border p-[11px] font-sans text-[13px] font-semibold"
                :class="togClass(f.channel.value === 'proReplays')"
                :aria-pressed="f.channel.value === 'proReplays'"
                @click="f.toggleChannel('proReplays')"
              >
                Pro Replays
              </button>
              <button
                type="button"
                class="flex-1 cursor-pointer border p-[11px] font-sans text-[13px] font-semibold"
                :class="highClass"
                :aria-pressed="f.channel.value === 'highLevel'"
                @click="f.toggleChannel('highLevel')"
              >
                High Level
              </button>
            </div>

            <div class="flex gap-6">
              <div class="flex-1">
                <div
                  :class="labelClass"
                  class="mb-2.5 mt-5"
                >
                  Season
                </div>
                <div class="flex gap-2">
                  <button
                    v-for="s in [0, 1, 2]"
                    :key="s"
                    type="button"
                    class="h-10 flex-1 cursor-pointer border font-mono text-[14px]"
                    :class="togClass(f.season.value === s)"
                    :aria-pressed="f.season.value === s"
                    @click="f.toggleSeason(s)"
                  >
                    {{ s }}
                  </button>
                  <button
                    type="button"
                    class="h-10 flex-1 cursor-pointer border font-mono text-[13px]"
                    :class="togClass(f.season.value === 'beta')"
                    :aria-pressed="f.season.value === 'beta'"
                    @click="f.toggleSeason('beta')"
                  >
                    β
                  </button>
                </div>
              </div>
              <div class="flex-1">
                <div
                  :class="labelClass"
                  class="mb-2.5 mt-5"
                >
                  Type
                </div>
                <div class="flex gap-2">
                  <button
                    type="button"
                    class="h-10 flex-1 cursor-pointer border font-sans text-[12px] font-semibold"
                    :class="togClass(f.matchType.value === 'ranked')"
                    :aria-pressed="f.matchType.value === 'ranked'"
                    @click="f.toggleMatchType('ranked')"
                  >
                    Ranked
                  </button>
                  <button
                    type="button"
                    class="h-10 flex-1 cursor-pointer border font-sans text-[12px] font-semibold"
                    :class="togClass(f.matchType.value === 'duo')"
                    :aria-pressed="f.matchType.value === 'duo'"
                    @click="f.toggleMatchType('duo')"
                  >
                    Duo
                  </button>
                </div>
              </div>
            </div>

            <!-- fuse facet — NEW vs design (see FilterBar): detected fuses only -->
            <div
              :class="labelClass"
              class="mb-2.5 mt-5"
            >
              Fuse · either team
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="fu in fuseChips"
                :key="fu.id"
                type="button"
                class="inline-flex h-10 cursor-pointer items-center justify-center gap-2 border px-2 font-sans text-[12px] font-semibold"
                :class="
                  f.selectedFuses.value.includes(fu.id)
                    ? ''
                    : 'border-white/[0.12] bg-[#141722] text-ink-secondary'
                "
                :style="fuseChipStyle(fu.id, fu.accent)"
                :aria-pressed="f.selectedFuses.value.includes(fu.id)"
                @click="f.toggleFuse(fu.id)"
              >
                <span
                  class="h-2 w-2 flex-none rotate-45"
                  :style="{ background: fu.accent ?? '#8B93A8' }"
                />
                {{ fu.name }}
              </button>
            </div>
            <div class="mt-2 font-mono text-[10px] text-ink-muted">
              fuse identified for {{ coverage.withFuse.toLocaleString('en-US') }} of
              {{ coverage.total.toLocaleString('en-US') }} replays
            </div>

            <div
              :class="labelClass"
              class="mb-2.5 mt-5"
            >
              Player · featured
            </div>
            <div class="flex flex-wrap gap-[7px]">
              <button
                v-for="p in featured"
                :key="p.id"
                type="button"
                class="inline-flex cursor-pointer items-center gap-1.5 border bg-[#0F1118] px-[11px] py-2 font-sans text-[12px] font-semibold text-ink-primary"
                :style="{ borderColor: f.selectedPlayers.value.includes(p.id) ? '#FF2E88' : 'rgba(255,255,255,.12)' }"
                :aria-pressed="f.selectedPlayers.value.includes(p.id)"
                @click="f.togglePlayer(p.id)"
              >
                <VerifiedMark
                  v-if="p.verified"
                  :size="10"
                />
                {{ p.displayName }}
              </button>
              <button
                type="button"
                class="cursor-pointer border border-dashed border-[rgba(56,207,255,.4)] px-[11px] py-2 font-sans text-[12px] font-semibold text-accent2"
                :aria-expanded="showAllPlayers"
                @click="showAllPlayers = !showAllPlayers"
              >
                Search all {{ ranked.length.toLocaleString() }} players ▾
              </button>
            </div>
            <div
              v-if="showAllPlayers"
              class="mt-2.5"
            >
              <input
                v-model="playerQuery"
                type="search"
                placeholder="Type a player name…"
                aria-label="Search all players"
                class="w-full border border-white/[0.12] bg-[#08090c] px-3 py-2.5 font-sans text-[13px] text-ink-primary outline-none placeholder:text-ink-muted"
              />
              <div class="mt-1 max-h-44 overflow-y-auto">
                <button
                  v-for="p in playerResults"
                  :key="p.id"
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left font-sans text-[12.5px] font-semibold text-ink-primary"
                  :class="f.selectedPlayers.value.includes(p.id) ? 'bg-accent-dim' : ''"
                  :aria-pressed="f.selectedPlayers.value.includes(p.id)"
                  @click="f.togglePlayer(p.id)"
                >
                  <VerifiedMark
                    v-if="p.verified"
                    :size="9"
                  />
                  <span class="min-w-0 truncate">{{ p.displayName }}</span>
                  <span class="ml-auto font-mono text-[10px] text-ink-muted">{{ p.appearances }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- footer -->
          <div class="flex flex-none gap-2.5 border-t border-white/10 bg-surface px-[18px] py-3.5">
            <button
              type="button"
              class="flex-1 cursor-pointer border border-white/[0.12] bg-elevated p-3.5 font-sans text-[14px] font-bold text-ink-secondary"
              @click="f.clearAll()"
            >
              Reset
            </button>
            <button
              type="button"
              class="flex-[2] cursor-pointer bg-accent p-3.5 font-sans text-[14px] font-bold text-[#08090c] cut-bl-10"
              @click="close"
            >
              Show {{ pending ? '…' : f.filtered.value.length.toLocaleString() }} replays
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
// Mobile bottom-sheet filter drawer (design 1A / 2a). Filters apply live;
// "Show N replays" confirms & closes, Reset clears everything.
const open = useState('filter-drawer-open', () => false);

const { list: champions } = useChampions();
const { ranked, featured } = useFeaturedPlayers();
const { detected: fuseChips, coverage } = useFuses();
const f = useFilters();
const { pending } = useVideos();

const showAllPlayers = ref(false);
const playerQuery = ref('');

const fuseChipStyle = (id: string, accent: string | null) =>
  f.selectedFuses.value.includes(id)
    ? {
        borderColor: accent ?? '#F4F5F8',
        background: `${accent ?? '#F4F5F8'}26`,
        color: '#F4F5F8'
      }
    : {};

const togClass = (on: boolean) =>
  on ? 'bg-accent text-[#08090c] border-accent' : 'bg-[#141722] text-ink-secondary border-white/[0.12]';

function close() {
  open.value = false;
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

const labelClass = 'font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted';

const playerResults = computed(() => {
  const n = normalizeText(playerQuery.value.trim());
  if (!n) return [];
  return ranked.value
    .filter(
      (p) =>
        normalizeText(p.displayName).includes(n) ||
        p.aliases.some((a) => normalizeText(a).includes(n))
    )
    .slice(0, 20);
});
const highClass = computed(() =>
  f.channel.value === 'highLevel'
    ? 'bg-[rgba(56,207,255,.16)] text-accent2 border-accent2'
    : 'bg-[#141722] text-ink-secondary border-white/[0.12]'
);

watch(open, (v) => {
  if (import.meta.server) return;
  if (v) {
    lockBodyScroll();
    document.addEventListener('keydown', onKeydown);
  } else {
    unlockBodyScroll();
    document.removeEventListener('keydown', onKeydown);
  }
});
onBeforeUnmount(() => {
  if (open.value) unlockBodyScroll();
  document.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.2s;
}
.drawer-enter-active .drawer-sheet,
.drawer-leave-active .drawer-sheet {
  transition: transform 0.36s cubic-bezier(0.16, 1, 0.3, 1);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer-sheet,
.drawer-leave-to .drawer-sheet {
  transform: translateY(100%);
}
</style>

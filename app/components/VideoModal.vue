<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="isOpen"
        class="fixed inset-0 z-[70] md:flex md:items-center md:justify-center md:p-8"
        @keydown="onKeydown"
      >
        <div
          class="absolute inset-0 bg-[rgba(6,7,11,.82)] backdrop-blur-[6px]"
          aria-hidden="true"
          @click="close()"
        />
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="video?.title ?? 'Replay'"
          tabindex="-1"
          class="modal-panel relative h-full w-full overflow-y-auto bg-base outline-none md:h-auto md:max-h-[85vh] md:w-[min(940px,100%)] md:border md:border-white/[0.14] md:bg-surface md:shadow-modal md:cut-20"
        >
          <!-- mobile top bar -->
          <div class="flex items-center gap-3 px-4 py-3 md:hidden">
            <button
              type="button"
              class="flex h-[30px] w-[30px] cursor-pointer items-center justify-center border border-white/[0.12] bg-[#141722] text-[18px] leading-none text-ink-primary"
              aria-label="Back to browse"
              @click="close()"
            >
              ‹
            </button>
            <span class="font-display text-[15px] font-semibold text-ink-primary">Replay</span>
            <ChannelBadge
              v-if="video"
              :channel="video.channel"
              class="ml-auto"
            />
          </div>

          <!-- desktop top bar -->
          <div class="hidden items-center gap-3 border-b border-white/[0.09] px-5 py-3.5 md:flex">
            <ChannelBadge
              v-if="video"
              :channel="video.channel"
              size="md"
            />
            <span class="truncate font-mono text-[11px] text-ink-muted">{{ metaLine }}</span>
            <a
              :href="youtubeUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="ml-auto whitespace-nowrap font-mono text-[11px] text-accent2 hover:underline"
            >Watch on YouTube ↗</a>
            <button
              type="button"
              class="h-[34px] w-[34px] flex-none cursor-pointer border border-white/[0.12] bg-elevated text-[16px] leading-none text-ink-secondary hover:text-ink-primary"
              aria-label="Close"
              @click="close()"
            >
              ✕
            </button>
          </div>

          <template v-if="video">
            <LiteYouTube
              :video-id="video.id"
              :thumbnail="video.thumbnail"
              :title="video.title"
            />

            <!-- mobile meta line -->
            <div class="flex items-center justify-between gap-3 px-4 pt-4 md:hidden">
              <span class="font-mono text-[10px] tracking-[.04em] text-ink-muted">{{ metaLine }}</span>
              <a
                :href="youtubeUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="whitespace-nowrap font-mono text-[10px] text-accent2"
              >YouTube ↗</a>
            </div>

            <div class="px-4 py-5 md:px-6 md:py-[22px]">
              <!-- teams: desktop row -->
              <div
                v-if="hasTeams"
                class="hidden flex-wrap items-stretch gap-5 md:flex"
              >
                <div class="min-w-[200px] flex-1">
                  <div class="flex items-center gap-2.5">
                    <div class="flex">
                      <ChampBadge
                        v-for="(c, i) in teamA!.characters.slice(0, 2)"
                        :key="c"
                        :champion-id="c"
                        :size="44"
                        :notch="9"
                        :font-size="16"
                        strong
                        :class="i > 0 ? '-ml-2.5' : ''"
                      />
                    </div>
                    <div>
                      <div class="font-display text-[14px] font-semibold text-ink-primary">
                        {{ champNames(teamA) }}
                      </div>
                      <div class="mt-[3px] inline-flex items-center gap-1.5">
                        <VerifiedMark
                          v-if="hasVerified(teamA)"
                          :size="10"
                        />
                        <span class="font-sans text-[14px] font-semibold text-ink-secondary">{{ playerLabel(teamA) }}</span>
                      </div>
                      <div
                        v-if="fuseA && !fusesUnordered"
                        data-testid="team-fuse-a"
                        class="mt-1"
                      >
                        <FuseTag :fuse-id="fuseA" />
                      </div>
                    </div>
                  </div>
                </div>
                <div class="flex items-center font-display text-[22px] font-bold text-accent">VS</div>
                <div class="min-w-[200px] flex-1">
                  <div class="flex items-center justify-end gap-2.5">
                    <div class="text-right">
                      <div class="font-display text-[14px] font-semibold text-ink-primary">
                        {{ champNames(teamB) }}
                      </div>
                      <div class="mt-[3px] inline-flex items-center gap-1.5">
                        <span class="font-sans text-[14px] font-semibold text-ink-secondary">{{ playerLabel(teamB) }}</span>
                        <VerifiedMark
                          v-if="hasVerified(teamB)"
                          :size="10"
                        />
                      </div>
                      <div
                        v-if="fuseB && !fusesUnordered"
                        data-testid="team-fuse-b"
                        class="mt-1"
                      >
                        <FuseTag :fuse-id="fuseB" />
                      </div>
                    </div>
                    <div class="flex">
                      <ChampBadge
                        v-for="(c, i) in teamB!.characters.slice(0, 2)"
                        :key="c"
                        :champion-id="c"
                        :size="44"
                        :notch="9"
                        :font-size="16"
                        strong
                        :class="i > 0 ? '-ml-2.5' : ''"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- teams: mobile stacked -->
              <div
                v-if="hasTeams"
                class="md:hidden"
              >
                <div class="mt-3.5 flex items-center gap-2.5">
                  <div class="flex">
                    <ChampBadge
                      v-for="(c, i) in teamA!.characters.slice(0, 2)"
                      :key="c"
                      :champion-id="c"
                      :size="40"
                      :notch="8"
                      :font-size="14"
                      strong
                      :class="i > 0 ? '-ml-[9px]' : ''"
                    />
                  </div>
                  <div class="min-w-0">
                    <div class="font-display text-[13px] font-semibold text-ink-primary">
                      {{ champNames(teamA) }}
                    </div>
                    <div class="inline-flex items-center gap-[5px]">
                      <VerifiedMark v-if="hasVerified(teamA)" />
                      <span class="font-sans text-[13px] font-semibold text-ink-secondary">{{ playerLabel(teamA) }}</span>
                    </div>
                    <div
                      v-if="fuseA && !fusesUnordered"
                      class="mt-0.5"
                    >
                      <FuseTag
                        :fuse-id="fuseA"
                        size="sm"
                      />
                    </div>
                  </div>
                </div>
                <div class="my-2 text-center font-display text-[13px] font-bold text-accent">VS</div>
                <div class="flex items-center gap-2.5">
                  <div class="flex">
                    <ChampBadge
                      v-for="(c, i) in teamB!.characters.slice(0, 2)"
                      :key="c"
                      :champion-id="c"
                      :size="40"
                      :notch="8"
                      :font-size="14"
                      strong
                      :class="i > 0 ? '-ml-[9px]' : ''"
                    />
                  </div>
                  <div class="min-w-0">
                    <div class="font-display text-[13px] font-semibold text-ink-primary">
                      {{ champNames(teamB) }}
                    </div>
                    <div class="inline-flex items-center gap-[5px]">
                      <VerifiedMark v-if="hasVerified(teamB)" />
                      <span class="font-sans text-[13px] font-semibold text-ink-secondary">{{ playerLabel(teamB) }}</span>
                    </div>
                    <div
                      v-if="fuseB && !fusesUnordered"
                      class="mt-0.5"
                    >
                      <FuseTag
                        :fuse-id="fuseB"
                        size="sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <!-- ok-unordered detections: the pair is confident, sides aren't —
                   shown match-level so we never render a wrong left/right claim -->
              <div
                v-if="hasTeams && fusesUnordered && (fuseA || fuseB)"
                data-testid="fuses-unordered"
                title="Fuses detected for this match — side attribution unconfirmed"
                class="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 md:justify-center"
              >
                <span class="font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">Fuses</span>
                <FuseTag
                  v-if="fuseA"
                  :fuse-id="fuseA"
                />
                <span
                  v-if="fuseA && fuseB"
                  class="font-mono text-[11px] text-ink-muted"
                >·</span>
                <FuseTag
                  v-if="fuseB"
                  :fuse-id="fuseB"
                />
              </div>

              <!-- unparseable records: raw title -->
              <div
                v-if="!hasTeams"
                class="font-sans text-[14px] font-semibold text-ink-primary"
              >
                {{ video.title }}
              </div>

              <!-- related replays -->
              <div
                v-if="related.length"
                class="mt-6"
              >
                <div
                  class="mb-3 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted"
                >
                  Related replays
                </div>
                <!-- desktop grid -->
                <div
                  data-testid="related-grid"
                  class="hidden grid-cols-5 gap-3 md:grid"
                >
                  <button
                    v-for="r in related.slice(0, 10)"
                    :key="r.id"
                    type="button"
                    class="cursor-pointer border border-white/[0.09] bg-[#0F1118] text-left transition-colors hover:border-accent/50"
                    :aria-label="r.title"
                    @click="swap(r.id)"
                  >
                    <div
                      class="relative aspect-video overflow-hidden"
                      style="background: repeating-linear-gradient(135deg, #141821, #141821 7px, #10131a 7px, #10131a 14px)"
                    >
                      <img
                        v-if="r.thumbnail"
                        :src="r.thumbnail"
                        alt=""
                        class="absolute inset-0 h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                      <span class="absolute bottom-[5px] right-[5px] bg-[rgba(6,7,11,.82)] px-[5px] py-[2px] font-mono text-[9px] text-white">{{ formatDuration(r.durationSec) }}</span>
                    </div>
                    <div class="flex items-center justify-center gap-1 p-2">
                      <ChampBadge
                        v-for="c in (r.teams[0]?.characters ?? []).slice(0, 2)"
                        :key="`a${c}`"
                        :champion-id="c"
                        :size="20"
                        :notch="0"
                        :font-size="8"
                      />
                      <span class="font-display text-[8px] font-bold text-ink-muted">V</span>
                      <ChampBadge
                        v-for="c in (r.teams[1]?.characters ?? []).slice(0, 2)"
                        :key="`b${c}`"
                        :champion-id="c"
                        :size="20"
                        :notch="0"
                        :font-size="8"
                      />
                    </div>
                  </button>
                </div>
                <!-- mobile rows -->
                <div
                  data-testid="related-list"
                  class="flex flex-col gap-[9px] md:hidden"
                >
                  <button
                    v-for="r in related.slice(0, 5)"
                    :key="r.id"
                    type="button"
                    class="flex cursor-pointer items-center gap-[11px] border border-white/[0.08] bg-[#0F1118] p-2 text-left"
                    :aria-label="r.title"
                    @click="swap(r.id)"
                  >
                    <div
                      class="relative aspect-video w-[104px] flex-none overflow-hidden"
                      style="background: repeating-linear-gradient(135deg, #141821, #141821 7px, #10131a 7px, #10131a 14px)"
                    >
                      <img
                        v-if="r.thumbnail"
                        :src="r.thumbnail"
                        alt=""
                        class="absolute inset-0 h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                      <span class="absolute bottom-1 right-1 bg-[rgba(6,7,11,.82)] px-1 py-px font-mono text-[8px] text-white">{{ formatDuration(r.durationSec) }}</span>
                    </div>
                    <div class="min-w-0 truncate font-sans text-[12px] font-semibold text-ink-primary">
                      {{ relPlayers(r, 0) }} <span class="text-ink-muted">vs</span>
                      {{ relPlayers(r, 1) }}
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <!-- mobile mini-disclaimer -->
            <div
              class="border-t border-white/[0.08] bg-[#0C0D12] px-4 py-3.5 font-sans text-[10px] text-ink-muted md:hidden"
            >
              Unofficial fan project · not affiliated with Riot Games.
            </div>
          </template>

          <!-- pending / not-found states -->
          <template v-else>
            <div
              v-if="pending"
              class="aspect-video border-b border-white/[0.09] bg-elevated motion-safe:animate-pulse"
            />
            <div
              v-if="pending"
              class="p-6 text-center font-mono text-[12px] text-ink-muted"
            >
              Loading replay…
            </div>
            <div
              v-else
              class="p-10 text-center"
            >
              <div class="font-display text-[18px] font-semibold text-ink-secondary">
                Replay not found
              </div>
              <button
                type="button"
                class="mt-4 cursor-pointer border border-white/[0.12] bg-elevated px-4 py-2 font-sans text-[13px] font-semibold text-ink-primary"
                @click="close()"
              >
                Back to browse
              </button>
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
// Video view — desktop modal / mobile full-screen (design VIDEO VIEW screens).
// Open state lives in ?v= (see useVideoModal). Lite-YouTube facade inside.
import type { Team } from '~~/types';

const { openId, video, pending, close, swap, related } = useVideoModal();
const { players: playerRegistry } = usePlayers();
const { byId: champById } = useChampions();

const panel = ref<HTMLElement>();
let lastFocus: HTMLElement | null = null;

// Esc lives on document (capture) — focus may sit inside the YouTube iframe,
// where a panel-level keydown would never fire.
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Tab' || !panel.value) return;
  // visible elements only — hidden ones (e.g. the mobile top bar on desktop)
  // can't take focus, and wrapping onto them lets Tab escape the dialog
  const els = [...panel.value.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, [tabindex]:not([tabindex="-1"])'
  )].filter((el) => el.checkVisibility?.() ?? el.offsetParent !== null);
  if (!els.length) return;
  const first = els[0]!;
  const last = els[els.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
}

const champNames = (t?: Team) =>
  t?.characters.map((c) => champById(c)?.name ?? c).join(' + ') ?? '';
const playerLabel = (t?: Team) => t?.players.map((p) => p.displayName).join(' + ') ?? '';
const hasVerified = (t?: Team) => !!t?.players.some((p) => playerRegistry.value[p.id]?.verified);
const relPlayers = (v: { teams: Team[] }, i: number) =>
  v.teams[i]?.players.map((p) => p.displayName).join(' + ') ?? '—';

const isOpen = computed(() => openId.value !== null);

const teamA = computed<Team | undefined>(() => video.value?.teams[0]);
const teamB = computed<Team | undefined>(() => video.value?.teams[1]);
const hasTeams = computed(() => (video.value?.teams.length ?? 0) === 2);

// CV-detected fuses: per-side when ordered; `fusesUnordered` records show the
// pair without side attribution (binding them left/right could be wrong)
const fuseA = computed(() => teamA.value?.fuse ?? null);
const fuseB = computed(() => teamB.value?.fuse ?? null);
const fusesUnordered = computed(() => !!video.value?.fusesUnordered);

const metaLine = computed(() => {
  const v = video.value;
  if (!v) return '';
  return [
    seasonLabel(v.season),
    matchTypeLabel(v.matchType),
    formatDuration(v.durationSec),
    relativeDate(v.publishedAt),
    `${formatViews(v.viewCount)} views`
  ].join(' · ');
});
const youtubeUrl = computed(() =>
  openId.value ? `https://www.youtube.com/watch?v=${openId.value}` : '#'
);

watch(
  isOpen,
  (v) => {
    if (import.meta.server) return;
    if (v) {
      lastFocus = document.activeElement as HTMLElement | null;
      lockBodyScroll();
      document.addEventListener('keydown', onDocKeydown, true);
      nextTick(() => panel.value?.focus());
    } else {
      unlockBodyScroll();
      document.removeEventListener('keydown', onDocKeydown, true);
      lastFocus?.focus?.();
      lastFocus = null;
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  if (isOpen.value) {
    unlockBodyScroll();
    document.removeEventListener('keydown', onDocKeydown, true);
  }
});
</script>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s;
}
.modal-enter-active .modal-panel,
.modal-leave-active .modal-panel {
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-panel,
.modal-leave-to .modal-panel {
  transform: translateY(8px) scale(0.985);
}
</style>

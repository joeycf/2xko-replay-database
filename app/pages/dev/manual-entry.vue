<template>
  <section class="mx-auto w-full max-w-[1240px] px-4 py-8 md:px-[26px]">
    <ClientOnly>
      <p class="font-mono text-label uppercase text-ink-muted">Authoring — dev only</p>
      <h1 class="mt-1 font-display text-d2 font-bold text-ink-primary">Manual entry champions</h1>
      <p class="mt-2 max-w-[760px] font-mono text-[12px] text-ink-muted">
        Watch each set's VS screens and click every champion that side fielded
        <strong class="text-ink-primary">across the whole set</strong> (set-level union — any length).
        Fuses are optional — set one only when you can read the HUD pill; click again to clear.
        Saves write <span class="text-ink-primary">data/manual-videos.json</span> only;
        run <span class="text-ink-primary">npm run data:parse</span> yourself when done.
      </p>

      <!-- filter -->
      <div class="mt-5 flex items-center gap-2">
        <button
          type="button"
          class="cursor-pointer border px-3 py-1.5 font-mono text-[12px]"
          :class="onlyNeedy ? onClass : offClass"
          :aria-pressed="onlyNeedy"
          data-testid="filter-needy"
          @click="onlyNeedy = true"
        >needs champions ({{ needyCount }})</button>
        <button
          type="button"
          class="cursor-pointer border px-3 py-1.5 font-mono text-[12px]"
          :class="!onlyNeedy ? onClass : offClass"
          :aria-pressed="!onlyNeedy"
          data-testid="filter-all"
          @click="onlyNeedy = false"
        >all ({{ entries.length }})</button>
      </div>

      <div
        v-if="loadError"
        class="mt-6 font-mono text-body text-warning"
      >Failed to load manual-videos.json — is this `nuxt dev`?</div>

      <div
        v-else-if="shown.length"
        class="mt-6 space-y-8 pb-28"
      >
        <div
          v-for="e in shown"
          :key="e.id"
          class="cut border border-white/10 bg-surface"
          data-testid="manual-card"
          :data-video-id="e.id"
        >
          <!-- header: read-only context -->
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.07] px-4 py-2 font-mono text-[11px] text-ink-secondary">
            <span class="border border-[rgba(245,179,60,.5)] bg-[rgba(245,179,60,.14)] px-1.5 py-0.5 text-[10px] uppercase tracking-[.1em] text-warning">
              {{ e.round ?? e.tournament }}
            </span>
            <span class="text-ink-muted">{{ e.tournament }}</span>
            <span class="text-ink-muted">{{ e.id }}</span>
            <span class="hidden min-w-0 flex-1 truncate lg:block">{{ e.title }}</span>
            <a
              :href="`https://youtu.be/${e.id}`"
              target="_blank"
              rel="noopener"
              class="underline decoration-white/20 hover:text-ink-primary"
            >youtube ↗</a>
          </div>

          <div class="grid gap-4 p-4 lg:grid-cols-2">
            <!-- THE VIDEO — right next to the form -->
            <div>
              <div
                class="relative aspect-video overflow-hidden border border-white/[0.08]"
                style="background: radial-gradient(circle at 50% 40%, #171a22, #0a0b0f)"
              >
                <iframe
                  v-if="playStart[e.id] !== undefined"
                  :src="embedSrc(e.id, playStart[e.id]!)"
                  class="absolute inset-0 h-full w-full border-0"
                  :title="e.title"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowfullscreen
                />
                <button
                  v-else
                  type="button"
                  class="group absolute inset-0 block h-full w-full cursor-pointer"
                  :aria-label="`Play — ${e.title}`"
                  @click="playStart[e.id] = 0"
                >
                  <img
                    v-if="e.thumbnail"
                    :src="e.thumbnail"
                    alt=""
                    class="absolute inset-0 h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                  <span class="absolute inset-0 flex items-center justify-center bg-[rgba(6,7,11,.24)]">
                    <span class="flex h-14 w-14 items-center justify-center rounded-full bg-accent shadow-[0_6px_22px_rgba(255,46,136,.5)] transition-transform duration-200 group-hover:scale-105">
                      <span class="ml-1 h-0 w-0 border-y-[10px] border-l-[16px] border-y-transparent border-l-white" />
                    </span>
                  </span>
                </button>
              </div>
              <!-- VS screens precede every game of the set — quarter jumps get
                   you near the later games without hunting from 0:00 -->
              <div class="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
                <span class="mr-1">jump:</span>
                <button
                  v-for="s in seekStops(e)"
                  :key="s.t"
                  type="button"
                  class="cursor-pointer border border-white/[0.12] bg-[#141722] px-2 py-0.5 text-ink-secondary hover:text-ink-primary"
                  @click="playStart[e.id] = s.t"
                >{{ s.label }}</button>
              </div>
            </div>

            <!-- per-side champion assignment -->
            <div class="flex flex-col gap-4">
              <div
                v-for="(t, i) in e.teams"
                :key="i"
                class="border border-white/[0.08] bg-[#0F1118] p-3"
              >
                <div class="flex items-baseline gap-2">
                  <span class="font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-muted">
                    {{ i === 0 ? 'Left' : 'Right' }}
                  </span>
                  <span class="font-sans text-[13px] font-semibold text-ink-primary">
                    {{ t.players.join(' + ') }}
                  </span>
                  <span
                    v-if="(sel[e.id]?.[i] ?? []).length === 0"
                    class="ml-auto font-mono text-[10px] text-warning"
                  >empty</span>
                  <span
                    v-else-if="(sel[e.id]?.[i] ?? []).length % 2 !== 0"
                    class="ml-auto font-mono text-[10px] text-ink-muted"
                  >odd count — ok for set unions</span>
                </div>

                <!-- selected, in click order -->
                <div class="mt-2 flex min-h-[26px] flex-wrap items-center gap-1.5">
                  <button
                    v-for="cid in sel[e.id]?.[i] ?? []"
                    :key="cid"
                    type="button"
                    class="inline-flex cursor-pointer items-center gap-1.5 border border-white/[0.14] bg-[#141722] py-0.5 pl-1 pr-2 font-sans text-[12px] font-semibold text-ink-primary hover:border-danger/60"
                    :title="`remove ${champName(cid)}`"
                    :data-selected-champ="cid"
                    @click="toggle(e.id, i as 0 | 1, cid)"
                  >
                    <ChampBadge
                      :champion-id="cid"
                      :size="20"
                      :notch="0"
                      :font-size="8"
                    />
                    {{ champName(cid) }}
                    <span class="text-ink-muted">✕</span>
                  </button>
                  <span
                    v-if="(sel[e.id]?.[i] ?? []).length === 0"
                    class="font-mono text-[11px] text-ink-faint"
                  >click champions below</span>
                </div>

                <!-- 15-champion palette -->
                <div class="mt-2 flex flex-wrap gap-1.5">
                  <button
                    v-for="c in champList"
                    :key="c.id"
                    type="button"
                    class="flex h-8 w-8 flex-none cursor-pointer items-center justify-center border-2 font-display text-[11px] font-bold text-[#050607] transition-[opacity,border-color] duration-150 cut-8"
                    :title="c.name"
                    :aria-label="c.name"
                    :aria-pressed="(sel[e.id]?.[i] ?? []).includes(c.id)"
                    :data-champ="`${i}:${c.id}`"
                    :style="{
                      background: champGradient(c.accent),
                      borderColor: (sel[e.id]?.[i] ?? []).includes(c.id) ? (c.accent ?? '#fff') : 'rgba(255,255,255,.12)',
                      opacity: (sel[e.id]?.[i] ?? []).includes(c.id) ? 1 : 0.42
                    }"
                    @click="toggle(e.id, i as 0 | 1, c.id)"
                  >{{ championInitials(c) }}</button>
                </div>

                <!-- fuse (optional, single-select — read the HUD pill; click again to clear) -->
                <div class="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2.5">
                  <span class="mr-0.5 font-sans text-[10px] font-semibold uppercase tracking-[.16em] text-ink-faint">Fuse</span>
                  <button
                    v-for="fu in fuseList"
                    :key="fu.id"
                    type="button"
                    class="inline-flex h-7 cursor-pointer items-center gap-1.5 border px-2 font-mono text-[10px] uppercase tracking-[.04em] transition-colors"
                    :class="selFuse[e.id]?.[i] === fu.id ? '' : 'border-white/[0.12] bg-[#141722] text-ink-secondary hover:text-ink-primary'"
                    :style="selFuse[e.id]?.[i] === fu.id
                      ? { borderColor: fuseAccent(fu.id), background: `${fuseAccent(fu.id)}26`, color: '#F4F5F8' }
                      : {}"
                    :aria-pressed="selFuse[e.id]?.[i] === fu.id"
                    :data-fuse="`${i}:${fu.id}`"
                    @click="toggleFuse(e.id, i as 0 | 1, fu.id)"
                  >
                    <span
                      class="h-1.5 w-1.5 flex-none rotate-45"
                      :style="{ background: fuseAccent(fu.id) }"
                    />
                    {{ fu.name }}
                  </button>
                </div>
              </div>

              <!-- save row -->
              <div class="mt-auto flex items-center gap-3">
                <span
                  class="font-mono text-[11px]"
                  :class="dirty(e.id) ? 'text-warning' : 'text-success'"
                  :data-testid="`state-${e.id}`"
                >{{ dirty(e.id) ? 'unsaved changes' : (needsChampions(e) ? 'needs champions' : 'saved ✓') }}</span>
                <span
                  v-if="cardNote[e.id]"
                  class="min-w-0 truncate font-mono text-[11px] text-ink-muted"
                >{{ cardNote[e.id] }}</span>
                <button
                  type="button"
                  class="ml-auto cursor-pointer border px-4 py-1.5 font-mono text-[12px] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  :class="confirmEmpty[e.id]
                    ? 'border-warning text-warning hover:bg-warning/10'
                    : 'border-accent text-accent hover:bg-accent/10'"
                  :disabled="!dirty(e.id) || savingId === e.id"
                  :data-testid="`save-${e.id}`"
                  @click="saveOne(e)"
                >{{ savingId === e.id ? 'saving…' : confirmEmpty[e.id] ? 'empty side — save anyway?' : 'save' }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        v-else-if="entries.length"
        class="mt-8 font-mono text-body text-success"
      >All entries have champions 🎯 — switch to “all” to review.</div>
      <div
        v-else
        class="mt-8 font-mono text-body text-ink-muted"
      >Loading…</div>

      <!-- sticky save-all bar -->
      <div
        v-if="shown.length"
        class="fixed inset-x-0 bottom-0 border-t border-white/10 bg-[#0C0D12]/95 backdrop-blur"
      >
        <div class="mx-auto flex max-w-[1240px] items-center gap-4 px-4 py-3 md:px-[26px]">
          <span class="font-mono text-[12px] text-ink-secondary">
            {{ entries.length - needyCount }} / {{ entries.length }} complete
            <span
              v-if="dirtyIds.length"
              class="text-warning"
            >· {{ dirtyIds.length }} unsaved</span>
          </span>
          <button
            type="button"
            class="ml-auto cursor-pointer border border-accent px-4 py-1.5 font-mono text-[12px] uppercase text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
            :disabled="dirtyIds.length === 0 || savingAll"
            data-testid="save-all"
            @click="saveAll"
          >{{ savingAll ? 'saving…' : `save all (${dirtyIds.length})` }}</button>
          <span
            v-if="barNote"
            class="font-mono text-[12px] text-success"
          >{{ barNote }}</span>
        </div>
      </div>
    </ClientOnly>
  </section>
</template>

<script setup lang="ts">
// Dev-only authoring UI for data/manual-videos.json: fills teams[].characters
// (SET-level champion unions — variable length by design) with the video
// embedded beside the form. Saves POST one entry at a time to
// /api/dev/manual-entry, which validates and writes ONLY that file; data:parse
// stays a manual follow-up. Same shipping guarantees as /dev/fuse-orient:
// dev-guarded, unlinked from public pages, noindex, absent from prerender
// output, no third-party embeds beyond the youtube-nocookie iframe.
import type { ManualVideoEntry } from '~~/types';

if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' });
}

const { list: champList, byId: champById } = useChampions();
const { list: fuseList, fuseAccent } = useFuses();

const { data, error: loadError } = useAsyncData(
  'manual-entry',
  () => $fetch<{ videos: ManualVideoEntry[] }>('/api/dev/manual-entry'),
  { server: false }
);

const entries = computed(() => data.value?.videos ?? []);
const onlyNeedy = ref(true);

// selection + last-saved snapshot, keyed by video id. All view state lives in
// these refs — the useAsyncData payload is a shallowRef in Nuxt 4, so mutating
// its entries (e.g. deleting todo after a save) would never trigger the
// filter/count computeds.
const sel = ref<Record<string, [string[], string[]]>>({});
const savedChars = ref<Record<string, [string[], string[]]>>({});
const selFuse = ref<Record<string, [string | null, string | null]>>({});
const savedFuse = ref<Record<string, [string | null, string | null]>>({});
const todoOpen = ref<Record<string, boolean>>({});
// saving satisfies "needs champions" instantly — keep the card on screen so
// its saved ✓ state and any warnings stay readable instead of vanishing
const savedThisSession = ref<Record<string, boolean>>({});
const cardNote = ref<Record<string, string>>({});
const confirmEmpty = ref<Record<string, boolean>>({});
const playStart = ref<Record<string, number>>({});
const savingId = ref<string | null>(null);
const savingAll = ref(false);
const barNote = ref('');

watch(entries, (list) => {
  for (const e of list) {
    if (sel.value[e.id]) continue; // keep in-progress edits across refreshes
    const chars = [[...(e.teams[0]?.characters ?? [])], [...(e.teams[1]?.characters ?? [])]] as [string[], string[]];
    sel.value[e.id] = chars;
    savedChars.value[e.id] = [[...chars[0]], [...chars[1]]];
    const fuses = [e.teams[0]?.fuse ?? null, e.teams[1]?.fuse ?? null] as [string | null, string | null];
    selFuse.value[e.id] = fuses;
    savedFuse.value[e.id] = [...fuses];
    todoOpen.value[e.id] = !!e.todo;
  }
}, { immediate: true });

// "needs champions" reflects the FILE state (todo marker / an empty saved side),
// so a card drops out of the needy view only once its save lands
const needsChampions = (e: ManualVideoEntry) =>
  todoOpen.value[e.id] === true || (savedChars.value[e.id] ?? [[], []]).some((side) => side.length === 0);
const needyCount = computed(() => entries.value.filter(needsChampions).length);
const shown = computed(() =>
  onlyNeedy.value
    ? entries.value.filter((e) => needsChampions(e) || savedThisSession.value[e.id])
    : entries.value,
);

const dirty = (id: string) =>
  JSON.stringify(sel.value[id]) !== JSON.stringify(savedChars.value[id]) ||
  JSON.stringify(selFuse.value[id]) !== JSON.stringify(savedFuse.value[id]);
const dirtyIds = computed(() => entries.value.filter((e) => dirty(e.id)).map((e) => e.id));

const champName = (id: string) => champById(id)?.name ?? id;

function toggle(id: string, side: 0 | 1, cid: string) {
  const arr = sel.value[id]?.[side];
  if (!arr) return;
  const ix = arr.indexOf(cid);
  if (ix >= 0) arr.splice(ix, 1);
  else arr.push(cid);
  confirmEmpty.value[id] = false;
}

// single-select per side; clicking the active fuse clears it (blank is valid)
function toggleFuse(id: string, side: 0 | 1, fid: string) {
  const pair = selFuse.value[id];
  if (!pair) return;
  pair[side] = pair[side] === fid ? null : fid;
}

const embedSrc = (id: string, start: number) =>
  `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&start=${start}`;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const seekStops = (e: ManualVideoEntry) => {
  const d = e.durationSec ?? 0;
  if (d <= 0) return [{ t: 0, label: '0:00' }];
  return [0, 0.25, 0.5, 0.75].map((f) => {
    const t = Math.floor(d * f);
    return { t, label: fmt(t) };
  });
};

async function postOne(e: ManualVideoEntry): Promise<string[]> {
  const res = await $fetch<{ ok: boolean; warnings: string[] }>('/api/dev/manual-entry', {
    method: 'POST',
    body: { id: e.id, characters: sel.value[e.id], fuses: selFuse.value[e.id] }
  });
  // mirror the server's write in the reactive view state (no refetch needed)
  savedChars.value[e.id] = [[...sel.value[e.id]![0]], [...sel.value[e.id]![1]]];
  savedFuse.value[e.id] = [...selFuse.value[e.id]!] as [string | null, string | null];
  todoOpen.value[e.id] = false;
  savedThisSession.value[e.id] = true;
  return res.warnings;
}

async function saveOne(e: ManualVideoEntry) {
  const hasEmpty = (sel.value[e.id] ?? [[], []]).some((side) => side.length === 0);
  if (hasEmpty && !confirmEmpty.value[e.id]) {
    confirmEmpty.value[e.id] = true; // two-step: flag the blank side first
    return;
  }
  confirmEmpty.value[e.id] = false;
  savingId.value = e.id;
  cardNote.value[e.id] = '';
  try {
    const warnings = await postOne(e);
    cardNote.value[e.id] = warnings.length ? `saved · ${warnings.join('; ')}` : 'saved to manual-videos.json';
  } catch (err) {
    cardNote.value[e.id] = `save failed: ${(err as { statusMessage?: string }).statusMessage ?? String(err)}`;
  } finally {
    savingId.value = null;
  }
}

async function saveAll() {
  savingAll.value = true;
  barNote.value = '';
  let written = 0;
  const skipped: string[] = [];
  try {
    for (const e of entries.value.filter((x) => dirty(x.id))) {
      // save-all never writes a blank side — those need the per-card confirm
      if ((sel.value[e.id] ?? [[], []]).some((side) => side.length === 0)) {
        skipped.push(e.id);
        continue;
      }
      await postOne(e);
      written++;
    }
    barNote.value = `wrote ${written}${skipped.length ? ` · skipped ${skipped.length} with empty side(s)` : ''}`;
  } finally {
    savingAll.value = false;
  }
}

const onClass = 'border-accent bg-accent/10 text-accent';
const offClass = 'border-white/[0.12] bg-[#141722] text-ink-secondary hover:text-ink-primary';

useHead({
  title: 'Manual entry champions (dev) — 2XKO Replay Database',
  meta: [{ name: 'robots', content: 'noindex' }]
});
</script>

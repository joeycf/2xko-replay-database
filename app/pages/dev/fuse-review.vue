<template>
  <section class="mx-auto w-full max-w-[1100px] px-4 py-8 md:px-[26px]">
    <ClientOnly>
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div>
          <p class="font-mono text-label uppercase text-text-muted">Diagnostic — dev only</p>
          <h1 class="mt-1 font-display text-d2 font-bold text-text">Fuse review</h1>
        </div>
        <NuxtLink
          to="/dev/fuse-gaps"
          class="ml-auto font-mono text-[12px] text-text-muted underline decoration-white/20 hover:text-text"
          >← fuse gaps</NuxtLink
        >
      </div>

      <p
        v-if="queueError"
        class="mt-6 font-mono text-body text-warning"
      >
        No gap report found — run <span class="text-text">npm run data:fuse-gaps</span> first.
      </p>

      <template v-else-if="item">
        <!-- progress -->
        <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12px]">
          <span class="text-text-secondary">
            <span class="text-text">{{ cursor + 1 }}</span> / {{ items.length }}
          </span>
          <span class="text-success">{{ resolvedCount }} resolved</span>
          <span
            v-if="dirtyCount"
            class="text-warning"
            >{{ dirtyCount }} unsaved</span
          >
          <span class="text-text-muted"
            >report {{ queue?.generatedAt.slice(0, 16).replace('T', ' ') }}</span
          >
          <button
            type="button"
            class="ml-auto border border-white/10 px-2 py-0.5 uppercase text-text-secondary hover:border-white/25"
            @click="showHelp = !showHelp"
          >
            keys ?
          </button>
        </div>

        <!-- jump strip: one cell per item, colour = state -->
        <div class="mt-3 flex flex-wrap gap-[3px]">
          <button
            v-for="(it, i) in items"
            :key="it.id"
            type="button"
            :title="`${i + 1}. ${it.id} — ${stateOf(it)}`"
            class="h-2.5 w-2.5 border transition-transform"
            :class="[
              stateOf(it) === 'saved'
                ? 'border-success/40 bg-success/70'
                : stateOf(it) === 'unsaved'
                  ? 'border-warning/40 bg-warning/70'
                  : 'border-white/15 bg-white/[0.06]',
              i === cursor ? 'scale-150 !border-primary' : '',
            ]"
            @click="go(i)"
          />
        </div>

        <div
          v-if="showHelp"
          class="mt-3 cut border border-white/10 bg-surface px-4 py-3"
        >
          <dl class="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] sm:grid-cols-3">
            <div
              v-for="k in keyHelp"
              :key="k[0]"
              class="flex gap-2"
            >
              <dt class="w-20 flex-none text-primary">{{ k[0] }}</dt>
              <dd class="text-text-secondary">{{ k[1] }}</dd>
            </div>
          </dl>
        </div>

        <!-- the item under review -->
        <div class="mt-4 cut border border-white/10 bg-surface">
          <div
            class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.07] px-4 py-2 font-mono text-[11px] text-text-secondary"
          >
            <span
              class="uppercase"
              :class="item.bucket === 'low' ? 'text-warning' : 'text-text-muted'"
              >{{ item.bucket }}</span
            >
            <span>{{ item.id }}</span>
            <span>{{ seasonLabel(item.season) }}</span>
            <span>{{ item.era }}</span>
            <span>{{ item.publishedAt.slice(0, 10) }}</span>
            <a
              :href="`https://youtu.be/${item.id}`"
              target="_blank"
              rel="noopener"
              class="ml-auto underline decoration-white/20 hover:text-text"
              >youtube ↗</a
            >
          </div>
          <p class="truncate px-4 pt-2 font-mono text-[11px] text-text-muted">{{ item.title }}</p>

          <!-- evidence: full HUD strip (both pills + both nameplates) -->
          <div class="relative mt-2">
            <img
              :key="`hud-${item.id}-${frame}`"
              :src="`/api/dev/fuse-hud?id=${item.id}&n=${nn(frame)}`"
              :alt="`${item.id} HUD strip, frame ${frame}`"
              class="block w-full"
            />
            <div class="absolute right-2 top-2 flex items-center gap-1 font-mono text-[11px]">
              <button
                type="button"
                class="bg-[rgba(6,7,11,.8)] px-2 py-0.5 text-text-secondary hover:text-text"
                @click="cycle(-1)"
              >
                ‹
              </button>
              <span class="bg-[rgba(6,7,11,.8)] px-1.5 py-0.5 text-text-muted"
                >{{ frame }}/{{ item.frames }}</span
              >
              <button
                type="button"
                class="bg-[rgba(6,7,11,.8)] px-2 py-0.5 text-text-secondary hover:text-text"
                @click="cycle(1)"
              >
                ›
              </button>
            </div>
          </div>

          <!-- pill zooms, labelled by SCREEN side (not title order) -->
          <div class="flex flex-wrap gap-4 px-4 py-3">
            <div
              v-for="side in ['left', 'right'] as const"
              :key="side"
              class="flex items-center gap-2"
            >
              <span class="font-mono text-[11px] uppercase text-text-muted"
                >screen-{{ side === 'left' ? 'L' : 'R' }}</span
              >
              <a
                :href="`/api/dev/fuse-frame?id=${item.id}&n=${nn(frame)}`"
                target="_blank"
                rel="noopener"
                title="open the full frame"
              >
                <img
                  :key="`pill-${item.id}-${side}-${frame}`"
                  :src="`/api/dev/fuse-pill?id=${item.id}&n=${nn(frame)}&side=${side}`"
                  :alt="`${item.id} ${side} pill`"
                  class="h-11 border border-white/10"
                />
              </a>
            </div>
            <p class="ml-auto max-w-[22rem] font-mono text-[10px] leading-relaxed text-text-muted">
              Screen side is not title order — read the nameplates in the strip above to decide
              which team owns which pill.
            </p>
          </div>

          <!-- the verdict: one fuse per TITLE-ordered team -->
          <div class="border-t border-white/[0.07]">
            <div
              v-for="(team, i) in item.teams"
              :key="team.side"
              class="border-b border-white/[0.05] px-4 py-3 transition-colors"
              :class="row === i ? 'bg-white/[0.03]' : ''"
              @click="row = i as 0 | 1"
            >
              <div class="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
                <span :class="row === i ? 'text-primary' : 'text-text-muted'">{{
                  row === i ? '▸' : ' '
                }}</span>
                <span
                  class="uppercase"
                  :class="row === i ? 'text-primary' : 'text-text-muted'"
                  >{{ verdict.unordered ? `fuse ${i === 0 ? 'A' : 'B'}` : `team ${i + 1}` }}</span
                >
                <span class="text-text">{{
                  team.players.map((p) => p.displayName).join(' + ') || '?'
                }}</span>
                <span class="text-text-muted">({{ team.characters.join('-') || '?' }})</span>
                <span
                  v-if="guess[i]"
                  class="ml-auto text-text-muted"
                >
                  detector: {{ fuseName(guess[i]!) }}
                  <span :class="guessScore(i) <= 75 ? 'text-text-secondary' : 'text-warning'"
                    >d{{ guessScore(i) }}</span
                  >
                </span>
              </div>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <button
                  v-for="(fuse, n) in fuseList"
                  :key="fuse.id"
                  type="button"
                  class="border px-2.5 py-1 font-mono text-[11px] uppercase transition-colors"
                  :class="
                    verdict.fuses[i] === fuse.id
                      ? 'border-current'
                      : 'border-white/10 text-text-secondary hover:border-white/25'
                  "
                  :style="
                    verdict.fuses[i] === fuse.id
                      ? { color: fuseAccent(fuse.id), background: `${fuseAccent(fuse.id)}1A` }
                      : undefined
                  "
                  @click.stop="pick(i as 0 | 1, fuse.id)"
                >
                  <span class="mr-1 text-[9px] text-text-muted">{{ n + 1 }}</span>
                  {{ fuse.name }}
                </button>
                <button
                  type="button"
                  class="border px-2.5 py-1 font-mono text-[11px] uppercase transition-colors"
                  :class="
                    verdict.fuses[i] === null
                      ? 'border-white/40 text-text'
                      : 'border-white/10 text-text-muted hover:border-white/25'
                  "
                  @click.stop="pick(i as 0 | 1, null)"
                >
                  <span class="mr-1 text-[9px] text-text-muted">0</span>
                  unreadable
                </button>
              </div>
            </div>
          </div>

          <!-- orientation escape hatch -->
          <label
            class="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 font-mono text-[11px]"
            :class="verdict.unordered ? 'text-primary' : 'text-text-secondary'"
          >
            <input
              type="checkbox"
              :checked="verdict.unordered"
              class="accent-primary"
              @change="toggleUnordered"
            />
            <span class="uppercase">can't tell which team owns which</span>
            <span class="text-text-muted"
              >— saves the pair unattributed (fusesUnordered), needs both sides set</span
            >
            <kbd class="ml-auto border border-white/10 px-1.5 text-text-muted">u</kbd>
          </label>
        </div>

        <!-- actions -->
        <div class="mt-4 flex flex-wrap items-center gap-2 pb-8">
          <button
            type="button"
            class="border border-white/10 px-3 py-1.5 font-mono text-[12px] uppercase text-text-secondary transition-colors hover:border-white/25"
            @click="go(cursor - 1)"
          >
            ‹ prev
          </button>
          <button
            type="button"
            class="border border-white/10 px-3 py-1.5 font-mono text-[12px] uppercase text-text-secondary transition-colors hover:border-white/25"
            @click="go(cursor + 1)"
          >
            skip ›
          </button>
          <button
            type="button"
            class="border border-primary px-4 py-1.5 font-mono text-[12px] uppercase text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
            :disabled="!canSave || saving"
            @click="saveCurrent"
          >
            {{ saving ? 'saving…' : 'save & next ⏎' }}
          </button>
          <button
            v-if="dirtyCount > 1"
            type="button"
            class="border border-white/10 px-3 py-1.5 font-mono text-[12px] uppercase text-text-secondary transition-colors hover:border-white/25 disabled:opacity-40"
            :disabled="saving"
            @click="saveAll"
          >
            save all {{ dirtyCount }}
          </button>
          <span
            v-if="note"
            class="font-mono text-[12px]"
            :class="noteTone"
            >{{ note }}</span
          >
        </div>
      </template>

      <p
        v-else-if="queue"
        class="mt-8 font-mono text-body text-success"
      >
        Nothing to review — every gap in the report either lacks cached frames or has no 2-team
        parse.
      </p>
      <div
        v-else
        class="mt-8 font-mono text-body text-text-muted"
      >
        Loading…
      </div>
    </ClientOnly>
  </section>
</template>

<script setup lang="ts">
// Dev-only manual fuse adjudicator: one video at a time, HUD strip + pill zooms
// as evidence, a fuse picker per TITLE-ordered team, and an "unordered" escape
// hatch for pairs whose owner can't be read. Covers all three review cases in
// one screen (missing, low-confidence, side-unknown) so the only thing that
// ever edits overrides.json by hand is a title-parse fix.
//
// Verdicts POST to /api/dev/fuse-review on the same override contract as
// --promote-lows. Same shipping guarantees as the sibling dev pages: dev-guarded,
// unlinked from public pages, noindex, absent from prerender output.
import type { FuseReviewItem, FuseReviewQueue, FuseReviewVerdict } from '~~/types';

if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' });
}

const { list: fuseList, fuseName, fuseAccent } = useFuses();

// local (utils/format.ts's seasonLabel retired with the layer refactor)
const seasonLabel = (season: number | null): string => (season === null ? 'BETA' : `S${season}`);

const {
  data: queue,
  error: queueError,
  refresh,
} = useAsyncData('fuse-review', () => $fetch<FuseReviewQueue>('/api/dev/fuse-review'), {
  server: false,
});

const blank = (): FuseReviewVerdict => ({ fuses: [null, null], unordered: false });

const cursor = ref(0);
const row = ref<0 | 1>(0);
const frameN = ref<Record<string, number>>({});
const draft = ref<Record<string, FuseReviewVerdict>>({});
const showHelp = ref(false);
const saving = ref(false);
const note = ref('');
const noteTone = ref('text-success');

const items = computed(() => queue.value?.items ?? []);
const item = computed<FuseReviewItem | null>(() => items.value[cursor.value] ?? null);
const verdict = computed<FuseReviewVerdict>(
  () => (item.value ? draft.value[item.value.id] : undefined) ?? blank(),
);

// seed one draft per item from whatever overrides.json already holds, so an
// already-resolved id shows its saved verdict instead of an empty picker
watch(
  queue,
  (q) => {
    if (!q) return;
    draft.value = Object.fromEntries(
      q.items.map((it) => [
        it.id,
        it.saved
          ? {
              fuses: [...it.saved.fuses] as [string | null, string | null],
              unordered: it.saved.unordered,
            }
          : blank(),
      ]),
    );
  },
  { immediate: true },
);

/** the detector's rejected read, in title order (its `left`/`right` are teams[0]/[1]) */
const guess = computed<[string | null, string | null]>(() => [
  item.value?.detection?.left ?? null,
  item.value?.detection?.right ?? null,
]);
const guessScore = (i: number) =>
  i === 0 ? (item.value?.detection?.score.left ?? 0) : (item.value?.detection?.score.right ?? 0);

const isDirty = (it: FuseReviewItem): boolean => {
  const d = draft.value[it.id];
  if (!d) return false;
  if (!it.saved) return !!(d.fuses[0] || d.fuses[1]);
  return (
    d.fuses[0] !== it.saved.fuses[0] ||
    d.fuses[1] !== it.saved.fuses[1] ||
    d.unordered !== it.saved.unordered
  );
};
const stateOf = (it: FuseReviewItem): 'saved' | 'unsaved' | 'open' =>
  isDirty(it) ? 'unsaved' : it.saved ? 'saved' : 'open';

const resolvedCount = computed(() => items.value.filter((it) => !!it.saved).length);
const dirtyCount = computed(() => items.value.filter(isDirty).length);
// an unordered verdict is only meaningful with both sides filled (the server
// rejects it otherwise) — mirror that here so the button can't lie
const canSave = computed(
  () =>
    !!item.value &&
    isDirty(item.value) &&
    (!verdict.value.unordered || (!!verdict.value.fuses[0] && !!verdict.value.fuses[1])),
);

const frame = computed(() =>
  item.value ? (frameN.value[item.value.id] ?? Math.min(6, item.value.frames)) : 1,
);
const nn = (n: number) => String(n).padStart(2, '0');
const cycle = (dir: number) => {
  if (!item.value) return;
  const next = frame.value + dir;
  frameN.value[item.value.id] = next < 1 ? item.value.frames : next > item.value.frames ? 1 : next;
};

// the save note deliberately survives navigation: saving advances to the next
// item, so clearing it here would blank the confirmation the moment it appears
const go = (i: number) => {
  if (!items.value.length) return;
  cursor.value = Math.min(Math.max(i, 0), items.value.length - 1);
  row.value = 0;
};
/** next still-open item after the cursor, wrapping once — the grind order */
const advance = () => {
  const n = items.value.length;
  for (let step = 1; step <= n; step++) {
    const i = (cursor.value + step) % n;
    const it = items.value[i];
    if (it && stateOf(it) === 'open') return go(i);
  }
  go(cursor.value + 1);
};

const pick = (i: 0 | 1, fuse: string | null) => {
  if (!item.value) return;
  const d = draft.value[item.value.id];
  if (!d) return;
  d.fuses[i] = d.fuses[i] === fuse && fuse !== null ? null : fuse;
  row.value = i;
};
const toggleUnordered = () => {
  if (!item.value) return;
  const d = draft.value[item.value.id];
  if (d) d.unordered = !d.unordered;
};
const acceptGuess = () => {
  if (!item.value) return;
  const d = draft.value[item.value.id];
  if (d) d.fuses = [...guess.value];
};

const post = async (
  entries: { id: string; fuses: [string | null, string | null]; unordered: boolean }[],
) => {
  saving.value = true;
  note.value = '';
  try {
    const res = await $fetch<{
      written: number;
      cleared: number;
      rejected: { id: string; reason: string }[];
    }>('/api/dev/fuse-review', { method: 'POST', body: { entries } });
    const at = cursor.value;
    await refresh(); // re-seeds drafts from the file we just wrote
    cursor.value = at;
    noteTone.value = res.rejected.length ? 'text-warning' : 'text-success';
    note.value = res.rejected.length
      ? `wrote ${res.written} · rejected ${res.rejected.map((r) => `${r.id} (${r.reason})`).join(', ')}`
      : `wrote ${res.written}${res.cleared ? ` · cleared ${res.cleared}` : ''} to overrides.json`;
    return res.rejected.length === 0;
  } catch (err) {
    noteTone.value = 'text-warning';
    note.value = (err as Error).message;
    return false;
  } finally {
    saving.value = false;
  }
};

const saveCurrent = async () => {
  if (!item.value || !canSave.value) return;
  const d = draft.value[item.value.id];
  if (!d) return;
  const ok = await post([{ id: item.value.id, fuses: [...d.fuses], unordered: d.unordered }]);
  if (ok) advance();
};
const saveAll = async () => {
  const entries = items.value.filter(isDirty).map((it) => {
    const d = draft.value[it.id]!;
    return {
      id: it.id,
      fuses: [...d.fuses] as [string | null, string | null],
      unordered: d.unordered,
    };
  });
  if (entries.length) await post(entries);
};

const onKey = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const digit = /^[0-9]$/.test(e.key) ? Number(e.key) : null;
  if (digit !== null) {
    if (digit === 0) pick(row.value, null);
    else if (fuseList[digit - 1]) pick(row.value, fuseList[digit - 1]!.id);
    else return;
  } else if (e.key === 'ArrowLeft') cycle(-1);
  else if (e.key === 'ArrowRight') cycle(1);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab')
    row.value = row.value === 0 ? 1 : 0;
  else if (e.key === 'Enter') void saveCurrent();
  else if (e.key === 's') go(cursor.value + 1);
  else if (e.key === '[' || e.key === ',') go(cursor.value - 1);
  else if (e.key === ']' || e.key === '.') go(cursor.value + 1);
  else if (e.key === 'u') toggleUnordered();
  else if (e.key === 'g') acceptGuess();
  else if (e.key === '?') showHelp.value = !showHelp.value;
  else return;
  e.preventDefault();
};

const keyHelp: [string, string][] = [
  ['1 – 8', 'set the focused row’s fuse'],
  ['0', 'mark the row unreadable'],
  ['↑ ↓ / tab', 'switch team row'],
  ['← →', 'cycle frame'],
  ['g', 'accept detector guess'],
  ['u', 'toggle unordered'],
  ['⏎', 'save & next open'],
  ['s / ] / [', 'skip · next · prev'],
  ['?', 'toggle this help'],
];

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

useHead({
  title: 'Fuse review (dev) — 2XKO Replay Database',
  meta: [
    {
      name: 'robots',
      content: 'noindex',
    },
  ],
});
</script>

<template>
  <section class="mx-auto w-full max-w-[1240px] px-4 py-8 md:px-[26px]">
    <ClientOnly>
      <p class="font-mono text-label uppercase text-text-muted">Curation — dev only</p>
      <h1 class="mt-1 font-display text-d2 font-bold text-text">Evo champion completion</h1>
      <p class="mt-2 max-w-[820px] font-mono text-[12px] text-text-muted">
        Read the four champions off the broadcast HUD and click every champion that side fielded
        <strong class="text-text">across the whole set</strong> (set-level union — any length). The
        extractor's proposal is shown where it read one;
        <span class="text-warning">amber border</span> means it disagrees with what is saved. Saves
        write <span class="text-text">data/manual-videos.json</span> only — run
        <span class="text-text">npm run data:parse</span> yourself afterwards.
      </p>

      <p
        v-if="loadError"
        class="mt-5 border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[12px] text-danger"
      >
        {{ loadError.statusMessage ?? loadError.message }}
      </p>

      <template v-else-if="items.length">
        <!-- counters + jumps -->
        <div class="mt-5 flex flex-wrap items-center gap-2">
          <span class="font-mono text-[12px] text-text-secondary">
            {{ completeCount }} / {{ items.length }} complete
            <span
              v-if="dirtyCount"
              class="text-warning"
              >· {{ dirtyCount }} unsaved</span
            >
          </span>
          <button
            type="button"
            class="cursor-pointer border border-white/[0.12] bg-[#141722] px-3 py-1.5 font-mono text-[12px] text-text-secondary hover:text-text"
            data-testid="next-open"
            @click="advance"
          >
            next open (⏎)
          </button>
          <button
            v-if="disputedCount"
            type="button"
            class="cursor-pointer border border-warning px-3 py-1.5 font-mono text-[12px] text-warning hover:bg-warning/10"
            data-testid="next-disputed"
            @click="nextDisputed"
          >
            {{ disputedCount }} disputed (d)
          </button>
        </div>

        <!-- jump strip: FILL = save state, BORDER = the extractor disagrees.
             Two independent facts, two channels — the same split fuse-review uses. -->
        <div class="mt-3 flex flex-wrap gap-[3px]">
          <button
            v-for="(it, i) in items"
            :key="it.id"
            type="button"
            :title="`${i + 1}. ${it.id} — ${stateOf(it)}${isDisputed(it) ? ' · extractor disagrees' : ''}`"
            class="h-2.5 w-2.5 border transition-transform"
            :class="[
              stateOf(it) === 'saved'
                ? 'border-success/40 bg-success/70'
                : stateOf(it) === 'unsaved'
                  ? 'border-warning/40 bg-warning/70'
                  : 'border-white/15 bg-white/[0.06]',
              isDisputed(it) ? '!border-warning scale-125' : '',
              i === cursor ? 'scale-150 !border-primary' : '',
            ]"
            :data-testid="`jump-${it.id}`"
            @click="go(i)"
          />
        </div>

        <!-- the item -->
        <article
          v-if="item"
          class="mt-6 border border-white/[0.10] bg-[#0F1218] p-4"
          :class="isDisputed(item) ? 'border-warning' : ''"
          data-testid="evo-card"
        >
          <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="font-display text-d4 font-bold text-text">{{ item.title }}</h2>
            <span class="font-mono text-[11px] uppercase text-text-muted">
              {{ item.tournament }}<span v-if="item.round"> · {{ item.round }}</span> ·
              {{ item.script }}
            </span>
            <a
              :href="`https://www.youtube.com/watch?v=${item.id}`"
              target="_blank"
              rel="noopener"
              class="ml-auto font-mono text-[11px] text-primary underline"
              >watch ↗</a
            >
          </header>

          <p
            v-if="item.todo"
            class="mt-1 font-mono text-[11px] text-warning"
          >
            todo: {{ item.todo }}
          </p>

          <!-- evidence -->
          <div
            v-if="item.frames.length"
            class="mt-3"
          >
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="cursor-pointer border border-white/[0.12] px-2 py-1 font-mono text-[11px] text-text-secondary hover:text-text"
                @click="frameStep(-1)"
              >
                ←
              </button>
              <span class="font-mono text-[11px] text-text-muted">
                frame {{ frameIdx + 1 }}/{{ item.frames.length }} · t={{ item.frames[frameIdx] }}s
              </span>
              <button
                type="button"
                class="cursor-pointer border border-white/[0.12] px-2 py-1 font-mono text-[11px] text-text-secondary hover:text-text"
                @click="frameStep(1)"
              >
                →
              </button>
              <label class="ml-2 flex items-center gap-1 font-mono text-[11px] text-text-muted">
                <input
                  v-model="fullFrame"
                  type="checkbox"
                />
                full frame (VS screens)
              </label>
            </div>
            <img
              :src="`/api/dev/evo-frame?id=${item.id}&n=${item.frames[frameIdx]}${fullFrame ? '&full=1' : ''}`"
              alt=""
              class="mt-2 w-full border border-white/[0.08]"
            />
          </div>

          <!-- two sides -->
          <div class="mt-4 grid gap-4 md:grid-cols-2">
            <div
              v-for="i in [0, 1]"
              :key="i"
              class="border border-white/[0.08] p-3"
            >
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="font-mono text-[12px] uppercase text-text-secondary">
                  team {{ i + 1 }}
                </span>
                <span class="font-mono text-[12px] text-text">{{
                  item.players[i]?.join(' + ') || '—'
                }}</span>
              </div>

              <!-- what the extractor read for THIS title-team -->
              <p
                class="mt-1 font-mono text-[11px]"
                :class="proposalFor(item, i).cls"
              >
                extractor: {{ proposalFor(item, i).text }}
              </p>

              <div class="mt-2 flex flex-wrap gap-1.5">
                <button
                  v-for="c in champList"
                  :key="c.id"
                  type="button"
                  class="flex h-8 w-8 flex-none cursor-pointer items-center justify-center border-2 font-display text-[11px] font-bold text-[#050607] transition-[opacity,border-color] duration-150 cut-sm"
                  :title="c.name"
                  :aria-label="c.name"
                  :aria-pressed="picked(item.id, i as 0 | 1).includes(c.id)"
                  :data-champ="`${i}:${c.id}`"
                  :style="{
                    background: accentGradient(c.id),
                    borderColor: picked(item.id, i as 0 | 1).includes(c.id)
                      ? (c.accent ?? '#fff')
                      : 'rgba(255,255,255,.12)',
                    opacity: picked(item.id, i as 0 | 1).includes(c.id) ? 1 : 0.42,
                  }"
                  @click="toggle(item!.id, i as 0 | 1, c.id)"
                >
                  {{ characterInitials(c) }}
                </button>
              </div>
              <!-- FUSE: read the pill in the frame above. Deliberately starts
                   BLANK and shows no proposal — 38 of 40 sides in this corpus say
                   `freestyle`, so seeding from the stored value (or from a
                   detector guess) would launder an unvalidated default through a
                   human instead of replacing it. -->
              <div
                class="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2.5"
              >
                <span
                  class="mr-0.5 font-ui text-[10px] font-semibold uppercase tracking-[.16em] text-text-faint"
                  >Fuse</span
                >
                <button
                  v-for="fu in fuseList"
                  :key="fu.id"
                  type="button"
                  class="inline-flex h-7 cursor-pointer items-center gap-1.5 border px-2 font-mono text-[10px] uppercase tracking-[.04em] transition-colors"
                  :class="
                    pickedFuse(item.id, i as 0 | 1) === fu.id
                      ? ''
                      : 'border-white/[0.12] bg-[#141722] text-text-secondary hover:text-text'
                  "
                  :style="
                    pickedFuse(item.id, i as 0 | 1) === fu.id
                      ? {
                          borderColor: fuseAccent(fu.id),
                          background: `${fuseAccent(fu.id)}26`,
                          color: '#F4F5F8',
                        }
                      : {}
                  "
                  :aria-pressed="pickedFuse(item.id, i as 0 | 1) === fu.id"
                  :data-fuse="`${i}:${fu.id}`"
                  @click="toggleFuse(item!.id, i as 0 | 1, fu.id)"
                >
                  <span
                    class="h-1.5 w-1.5 flex-none rotate-45"
                    :style="{ background: fuseAccent(fu.id) }"
                  />
                  {{ fu.name }}
                </button>
                <button
                  type="button"
                  class="inline-flex h-7 cursor-pointer items-center border px-2 font-mono text-[10px] uppercase tracking-[.04em] transition-colors"
                  :class="
                    pickedFuse(item.id, i as 0 | 1) === null
                      ? 'border-warning bg-warning/10 text-warning'
                      : 'border-white/[0.12] bg-[#141722] text-text-secondary hover:text-text'
                  "
                  :aria-pressed="pickedFuse(item.id, i as 0 | 1) === null"
                  :data-testid="`fuse-unreadable-${i}`"
                  title="you looked and the pill could not be read — records null rather than a guess"
                  @click="markFuseUnreadable(item!.id, i as 0 | 1)"
                >
                  can't read it
                </button>
                <span class="ml-1 font-mono text-[10px] text-text-faint">
                  {{ fuseStateLabel(item, i as 0 | 1) }}
                </span>
              </div>

              <p class="mt-1.5 font-mono text-[11px] text-text-muted">
                {{ picked(item.id, i as 0 | 1).join(', ') || 'none' }}
                <span
                  v-if="picked(item.id, i as 0 | 1).length % 2 !== 0"
                  class="text-warning"
                >
                  · odd count — ok for set unions
                </span>
              </p>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="cursor-pointer border border-white/[0.12] px-3 py-1.5 font-mono text-[12px] text-text-secondary hover:text-text"
              :title="'move both champion lists to the other team'"
              :data-testid="`swap-${item.id}`"
              @click="swapSides(item.id)"
            >
              ⇄ swap sides
            </button>
            <button
              type="button"
              class="cursor-pointer border border-white/[0.12] px-3 py-1.5 font-mono text-[12px] text-text-secondary hover:text-text disabled:opacity-40"
              :disabled="!item.proposal"
              title="fill both sides from the extractor's proposal, mapped to title order"
              :data-testid="`accept-${item.id}`"
              @click="acceptProposal(item!)"
            >
              accept proposal (a)
            </button>
            <button
              type="button"
              class="ml-auto cursor-pointer border border-primary px-4 py-1.5 font-mono text-[12px] uppercase text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
              :disabled="!isDirty(item) || saving"
              :data-testid="`save-${item.id}`"
              @click="save()"
            >
              save (s)
            </button>
          </div>
          <p
            v-if="note"
            class="mt-2 font-mono text-[11px] text-text-secondary"
          >
            {{ note }}
          </p>
        </article>
      </template>

      <p
        v-else
        class="mt-6 font-mono text-[12px] text-text-muted"
      >
        No Evo entries in data/manual-videos.json.
      </p>
    </ClientOnly>
  </section>
</template>

<script setup lang="ts">
import type { EvoReviewItem, EvoReviewQueue } from '~~/types';

// Dev-only surface: never prerendered (nuxt.config nitro.prerender.ignore),
// noindex, and nothing links to it.

// Declares this tool on the /dev index (engine app/pages/dev/index.vue). Every
// value MUST stay a plain quoted literal — the build extracts them from the AST
// and a variable or backtick string drops the key silently.
definePageMeta({
  devTool: {
    title: 'Evo champion completion',
    category: 'Curation',
    description: 'Complete the champions on Evo broadcast VODs the extractor could not read.',
    writes: 'data/manual-videos.json',
  },
});

if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' });
}

const { list: champList } = useCharacters();
const { list: fuseList, fuseAccent, fuseName } = useFuses();

const {
  data,
  error: loadError,
  refresh,
} = useAsyncData('evo-review', () => $fetch<EvoReviewQueue>('/api/dev/evo-review'), {
  server: false,
});
const items = computed<EvoReviewItem[]>(() => data.value?.items ?? []);

const cursor = ref(0);
const frameIdx = ref(0);
const fullFrame = ref(false);
const saving = ref(false);
const note = ref('');
const item = computed<EvoReviewItem | undefined>(() => items.value[cursor.value]);

// draft vs saved, keyed by id. The useAsyncData payload is a shallowRef in
// Nuxt 4, so view state has to live in its own refs — mutating the payload
// would never re-trigger the computeds that drive the strip and the counters.
const draft = ref<Record<string, [string[], string[]]>>({});
// THREE-STATE, and the third state is the point. `undefined` = not looked at yet
// (the picker is blank and a save leaves the stored value alone); `null` = looked
// and unreadable; a string = read off the pill. Two states would force every
// unfinished side into either a guess or a silent overwrite.
const draftFuse = ref<Record<string, [string | null | undefined, string | null | undefined]>>({});
watch(
  items,
  (list) => {
    const next: Record<string, [string[], string[]]> = {};
    for (const it of list) next[it.id] = [[...it.saved[0]], [...it.saved[1]]];
    draft.value = next;
    // deliberately NOT seeded from it.savedFuses — see the template comment
    const nf: Record<string, [string | null | undefined, string | null | undefined]> = {};
    for (const it of list) nf[it.id] = [undefined, undefined];
    draftFuse.value = nf;
  },
  { immediate: true },
);

const picked = (id: string, side: 0 | 1): string[] => draft.value[id]?.[side] ?? [];
const pickedFuse = (id: string, side: 0 | 1): string | null | undefined =>
  draftFuse.value[id]?.[side];

function toggleFuse(id: string, side: 0 | 1, fuse: string): void {
  const d = draftFuse.value[id];
  if (!d) return;
  d[side] = d[side] === fuse ? undefined : fuse; // click the active chip to unset
  draftFuse.value = { ...draftFuse.value };
}
function markFuseUnreadable(id: string, side: 0 | 1): void {
  const d = draftFuse.value[id];
  if (!d) return;
  d[side] = d[side] === null ? undefined : null;
  draftFuse.value = { ...draftFuse.value };
}
/** What the file holds vs what this pass has said, so a reviewer can see when
 *  they are about to overwrite — and what with. */
function fuseStateLabel(it: EvoReviewItem, side: 0 | 1): string {
  const was = it.savedFuses[side];
  const seen = it.validatedFuses[side];
  const now = pickedFuse(it.id, side);
  const fileTxt = was ? fuseName(was) : 'none';
  if (now === undefined) {
    if (seen === undefined) return `file: ${fileTxt} · UNREAD`;
    return `file: ${fileTxt} · read ✓ (${seen === null ? 'unreadable' : fuseName(seen)})`;
  }
  if (now === null) return `file: ${fileTxt} → unreadable`;
  return was === now ? `confirms file: ${fuseName(now)}` : `file: ${fileTxt} → ${fuseName(now)}`;
}

function toggle(id: string, side: 0 | 1, champ: string): void {
  const d = draft.value[id];
  if (!d) return;
  const cur = d[side];
  d[side] = cur.includes(champ) ? cur.filter((c) => c !== champ) : [...cur, champ];
  draft.value = { ...draft.value };
}

/** Move both champion lists to the other team.
 *
 *  Exactly one half moves. The champions are what the FOOTAGE gave (screen
 *  order); the players came from the title. Moving both halves would leave every
 *  pairing unchanged and only reorder the array. savedChars is deliberately
 *  untouched so dirty() flips and the card offers to save. */
function swapSides(id: string): void {
  const d = draft.value[id];
  if (!d) return;
  draft.value = { ...draft.value, [id]: [[...d[1]], [...d[0]]] };
}

/** Fill the draft from the extractor, mapped SCREEN order → TITLE order.
 *
 *  `leftIsFirst` is the whole point: the extractor reads champions by screen
 *  position and the entry stores them in title order, and the recon already found
 *  a corpus video where those disagree. An undecided side is not mapped — the
 *  reviewer sees the two reads and decides, which is strictly better than a
 *  coin-flip the UI presents as an answer. */
function acceptProposal(it: EvoReviewItem): void {
  const p = it.proposal;
  if (!p) return;
  if (!p.decided) {
    note.value =
      'side undecided — the footage could not say which team is on the left; pick manually';
    return;
  }
  const first = p.leftIsFirst ? p.left.characters : p.right.characters;
  const second = p.leftIsFirst ? p.right.characters : p.left.characters;
  draft.value = { ...draft.value, [it.id]: [[...first], [...second]] };
}

/** What the extractor read for a given TITLE-order team, or why it did not. */
function proposalFor(it: EvoReviewItem, titleIdx: number): { text: string; cls: string } {
  const p = it.proposal;
  if (!p) return { text: 'not run', cls: 'text-text-muted' };
  if (!p.decided) {
    const l = p.left.characters.join('+') || '—';
    const r = p.right.characters.join('+') || '—';
    return { text: `side undecided — screen L ${l} / R ${r}`, cls: 'text-warning' };
  }
  const side = (p.leftIsFirst ? titleIdx === 0 : titleIdx === 1) ? p.left : p.right;
  if (!side.characters.length)
    return {
      text: `no read (${side.read}/${side.sampled} duo-legible frames)`,
      cls: 'text-text-muted',
    };
  return {
    text: `${side.characters.join(' + ')}  conf ${side.confidence.toFixed(2)}${
      side.dropped.length ? ` · dropped ${side.dropped.map((d) => d.char).join(',')}` : ''
    }`,
    cls: 'text-success',
  };
}

const key = (xs: string[]): string => [...xs].sort().join(',');
const isDirty = (it: EvoReviewItem): boolean => {
  const d = draft.value[it.id];
  if (!d) return false;
  if (key(d[0]) !== key(it.saved[0]) || key(d[1]) !== key(it.saved[1])) return true;
  const f = draftFuse.value[it.id];
  if (!f) return false;
  // A CONFIRMATION IS WORTH SAVING. Arming only on a value that differs from the
  // file would make "a human read the pill and it really is freestyle"
  // indistinguishable from "nobody ever looked" — which is the exact ambiguity
  // this pass exists to remove. So a verdict counts as a change unless it is
  // already on record in data/fuse-validation-evo.json.
  return [0, 1].some((i) => {
    const v = f[i as 0 | 1];
    return v !== undefined && v !== it.validatedFuses[i as 0 | 1];
  });
};
const isComplete = (it: EvoReviewItem): boolean => it.saved[0].length > 0 && it.saved[1].length > 0;
const stateOf = (it: EvoReviewItem): 'saved' | 'unsaved' | 'open' =>
  isDirty(it) ? 'unsaved' : isComplete(it) ? 'saved' : 'open';

/** A saved verdict that contradicts what the extractor read.
 *
 *  Compared as an UNORDERED PAIR of sides, because neither array is in a
 *  trustworthy order — the proposal is screen order, the verdict is title order,
 *  and `decided` is exactly the flag that says whether those can be aligned at
 *  all. An undecided item is therefore never disputed: there is no claim to
 *  contradict. Same shape as fuse-review's isDisputed, widened from one fuse per
 *  side to a champion LIST per side; the sort/join is injective because champion
 *  ids contain neither comma nor pipe.
 *
 *  Rides on the BORDER because FILL already carries save state on this strip. */
const isDisputed = (it: EvoReviewItem): boolean => {
  if (!it.proposal || !it.proposal.decided) return false;
  if (!isComplete(it)) return false;
  const p = it.proposal;
  if (!p.left.characters.length || !p.right.characters.length) return false;
  const pair = (a: string[], b: string[]) => [key(a), key(b)].sort().join('|');
  return pair(p.left.characters, p.right.characters) !== pair(it.saved[0], it.saved[1]);
};

const completeCount = computed(() => items.value.filter(isComplete).length);
const dirtyCount = computed(() => items.value.filter(isDirty).length);
const disputedCount = computed(() => items.value.filter(isDisputed).length);

function go(i: number): void {
  cursor.value = i;
  // Open mid-set, not at t=0. The first sampled seconds of a tournament VOD are
  // walk-ons and crowd every time — the recon measured only 10-32% of frames
  // carrying a HUD at all, and none of them early — so frame 1 is reliably the
  // one frame that shows a reviewer nothing.
  frameIdx.value = Math.floor((items.value[i]?.frames.length ?? 0) * 0.4);
  note.value = '';
}
function frameStep(d: number): void {
  const n = item.value?.frames.length ?? 0;
  if (!n) return;
  frameIdx.value = (frameIdx.value + d + n) % n;
}
/** Next item still missing a champion list, wrapping once. */
function advance(): void {
  const n = items.value.length;
  for (let k = 1; k <= n; k++) {
    const i = (cursor.value + k) % n;
    const it = items.value[i];
    if (it && stateOf(it) === 'open') return go(i);
  }
}
function nextDisputed(): void {
  const n = items.value.length;
  for (let k = 1; k <= n; k++) {
    const i = (cursor.value + k) % n;
    const it = items.value[i];
    if (it && isDisputed(it)) return go(i);
  }
}

async function save(): Promise<void> {
  const it = item.value;
  if (!it || saving.value) return;
  saving.value = true;
  try {
    const res = await $fetch<{
      written: number;
      rejected: { id: string; reason: string }[];
      warnings: string[];
    }>('/api/dev/evo-review', {
      method: 'POST',
      body: {
        entries: [{ id: it.id, characters: draft.value[it.id], fuses: draftFuse.value[it.id] }],
      },
    });
    const at = cursor.value;
    await refresh();
    // restore the cursor so drafts re-seed from the file just written
    cursor.value = at;
    note.value = res.rejected.length
      ? `rejected: ${res.rejected.map((r) => `${r.id} (${r.reason})`).join('; ')}`
      : `saved${res.warnings.length ? ` — ${res.warnings.join('; ')}` : ''}`;
  } catch (e) {
    note.value = `save failed: ${(e as Error).message}`;
  } finally {
    saving.value = false;
  }
}

function onKey(ev: KeyboardEvent): void {
  const t = ev.target as HTMLElement | null;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'ArrowRight') go((cursor.value + 1) % items.value.length);
  else if (ev.key === 'ArrowLeft') go((cursor.value - 1 + items.value.length) % items.value.length);
  else if (ev.key === 'Enter') advance();
  else if (ev.key === 'd') nextDisputed();
  else if (ev.key === 's') void save();
  else if (ev.key === 'a' && item.value) acceptProposal(item.value);
  else if (ev.key === '[') frameStep(-1);
  else if (ev.key === ']') frameStep(1);
  else return;
  ev.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

useHead({
  title: 'Evo champion completion (dev) — 2XKO Replay Database',
  meta: [{ name: 'robots', content: 'noindex' }],
});
</script>

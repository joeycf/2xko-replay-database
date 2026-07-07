<template>
  <section class="mx-auto w-full max-w-[1100px] px-4 py-8 md:px-[26px]">
    <ClientOnly>
      <p class="font-mono text-label uppercase text-ink-muted">Diagnostic — dev only</p>
      <h1 class="mt-1 font-display text-d2 font-bold text-ink-primary">Fuse orientation</h1>
      <p class="mt-2 font-mono text-[12px] text-ink-muted">
        Each pill below is a settled, high-confidence read — only <em>which title team owns it</em> is unresolved.
        Pick the team whose nameplates sit under the highlighted pill.
        <NuxtLink
          to="/dev/fuse-gaps"
          class="underline decoration-white/20 hover:text-ink-primary"
        >← fuse gaps</NuxtLink>
      </p>

      <p
        v-if="queueError"
        class="mt-6 font-mono text-body text-warning"
      >
        No orientation queue — run <span class="text-ink-primary">npm run data:fuses -- --promote-lows</span> first.
      </p>

      <template v-else-if="rows.length">
        <div class="mt-6 space-y-6 pb-24">
          <div
            v-for="{ item, video } in rows"
            :key="item.id"
            class="cut border border-white/10 bg-surface"
          >
            <!-- header -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/[0.07] px-4 py-2 font-mono text-[11px] text-ink-secondary">
              <span class="text-ink-muted">{{ item.montage ? `#${String(item.montage).padStart(3, '0')}` : '—' }}</span>
              <span>{{ item.id }}</span>
              <span>{{ seasonLabel(video.season) }}</span>
              <span class="hidden min-w-0 flex-1 truncate sm:block">{{ video.title }}</span>
              <a
                :href="`https://youtu.be/${item.id}`"
                target="_blank"
                rel="noopener"
                class="underline decoration-white/20 hover:text-ink-primary"
              >youtube ↗</a>
            </div>

            <!-- HUD strip with frame cycler -->
            <div class="relative">
              <img
                :src="`/api/dev/fuse-hud?id=${item.id}&n=${nn(frameOf(item))}`"
                :alt="`${item.id} HUD strip`"
                loading="lazy"
                class="block w-full"
              />
              <div class="absolute right-2 top-2 flex items-center gap-1 font-mono text-[11px]">
                <button
                  type="button"
                  class="bg-[rgba(6,7,11,.8)] px-2 py-0.5 text-ink-secondary hover:text-ink-primary"
                  @click="cycle(item, -1)"
                >‹</button>
                <span class="bg-[rgba(6,7,11,.8)] px-1.5 py-0.5 text-ink-muted">{{ frameOf(item) }}/{{ item.frames }}</span>
                <button
                  type="button"
                  class="bg-[rgba(6,7,11,.8)] px-2 py-0.5 text-ink-secondary hover:text-ink-primary"
                  @click="cycle(item, 1)"
                >›</button>
              </div>
            </div>

            <!-- evidence + assignment -->
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span class="inline-flex items-center gap-2 font-mono text-[12px] text-ink-secondary">
                <FuseTag
                  :fuse-id="item.fuse"
                  size="sm"
                />
                <span class="text-ink-muted">d{{ item.dist }}</span>
                reads on the <strong class="text-ink-primary">screen-{{ item.screenSide.toUpperCase() }}</strong> pill
              </span>
              <img
                :src="`/api/dev/fuse-pill?id=${item.id}&n=${nn(frameOf(item))}&side=${item.screenSide}`"
                :alt="`${item.id} ${item.screenSide} pill zoom`"
                loading="lazy"
                class="h-8 border border-white/10"
              />
              <span class="ml-auto inline-flex items-center gap-2">
                <button
                  v-for="(t, i) in video.teams"
                  :key="t.side"
                  type="button"
                  class="border px-3 py-1.5 text-left font-mono text-[12px] transition-colors"
                  :class="choice[item.id] === i
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-white/10 text-ink-secondary hover:border-white/25'"
                  @click="choice[item.id] = choice[item.id] === i ? null : (i as 0 | 1)"
                >
                  <span class="block text-[10px] uppercase text-ink-muted">team {{ i + 1 }}</span>
                  {{ t.players.map((p) => p.displayName).join(' + ') || '?' }}
                  <span class="text-ink-muted">({{ t.characters.join('-') || '?' }})</span>
                </button>
                <span
                  v-if="saved[item.id] !== undefined && saved[item.id] === choice[item.id]"
                  class="font-mono text-[11px] text-success"
                >saved ✓</span>
              </span>
            </div>
          </div>
        </div>

        <!-- sticky save bar -->
        <div class="fixed inset-x-0 bottom-0 border-t border-white/10 bg-[#0C0D12]/95 backdrop-blur">
          <div class="mx-auto flex max-w-[1100px] items-center gap-4 px-4 py-3 md:px-[26px]">
            <span class="font-mono text-[12px] text-ink-secondary">
              {{ assignedCount }} / {{ rows.length }} assigned
              <span
                v-if="unsavedCount"
                class="text-warning"
              >· {{ unsavedCount }} unsaved</span>
            </span>
            <button
              type="button"
              class="ml-auto border border-accent px-4 py-1.5 font-mono text-[12px] uppercase text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
              :disabled="unsavedCount === 0 || saving"
              @click="save"
            >{{ saving ? 'saving…' : `save ${unsavedCount} assignment(s)` }}</button>
            <span
              v-if="saveNote"
              class="font-mono text-[12px] text-success"
            >{{ saveNote }}</span>
          </div>
        </div>
      </template>
      <div
        v-else
        class="mt-8 font-mono text-body text-ink-muted"
      >Loading…</div>
    </ClientOnly>
  </section>
</template>

<script setup lang="ts">
// Dev-only orientation adjudicator for the promote-lows blocked queue: the
// fuse identity is already high-confidence, the human picks which title team
// owns it. Assignments POST to /api/dev/fuse-orient which writes
// overrides.json. Same shipping guarantees as /dev/fuse-gaps: dev-guarded,
// unlinked from public pages, noindex, absent from prerender output.
import type { FuseOrientItem, FuseOrientQueue, VideoRecord } from '~~/types';

if (!import.meta.dev) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found' });
}

const { videos } = useVideos();
const { data: queue, error: queueError, refresh } = useAsyncData(
  'fuse-orient',
  () => $fetch<FuseOrientQueue & { assigned: Record<string, number> }>('/api/dev/fuse-orient'),
  { server: false }
);

const choice = ref<Record<string, 0 | 1 | null>>({});
const saved = ref<Record<string, number>>({});
const frameN = ref<Record<string, number>>({});
const saving = ref(false);
const saveNote = ref('');

watch(queue, (q) => {
  if (!q) return;
  saved.value = { ...q.assigned };
  for (const item of q.items) {
    if (choice.value[item.id] === undefined) {
      choice.value[item.id] = (q.assigned[item.id] as 0 | 1 | undefined) ?? null;
    }
  }
}, { immediate: true });

const byId = computed(() => new Map(videos.value.map((v) => [v.id, v])));
const rows = computed(() =>
  (queue.value?.items ?? [])
    .map((item) => ({ item, video: byId.value.get(item.id) }))
    .filter((x): x is { item: FuseOrientItem; video: VideoRecord } => !!x.video && x.video.teams.length === 2)
);

const assignedCount = computed(() => rows.value.filter(({ item }) => choice.value[item.id] !== null && choice.value[item.id] !== undefined).length);
const unsavedCount = computed(
  () => rows.value.filter(({ item }) => {
    const c = choice.value[item.id];
    return c !== null && c !== undefined && saved.value[item.id] !== c;
  }).length
);

const frameOf = (item: FuseOrientItem) => frameN.value[item.id] ?? Math.min(6, item.frames);
const nn = (n: number) => String(n).padStart(2, '0');
function cycle(item: FuseOrientItem, dir: number) {
  const next = frameOf(item) + dir;
  frameN.value[item.id] = next < 1 ? item.frames : next > item.frames ? 1 : next;
}

async function save() {
  saving.value = true;
  saveNote.value = '';
  try {
    const assignments = rows.value
      .filter(({ item }) => {
        const c = choice.value[item.id];
        return c !== null && c !== undefined && saved.value[item.id] !== c;
      })
      .map(({ item }) => ({ id: item.id, owner: choice.value[item.id] }));
    const res = await $fetch<{ written: number; rejected: string[] }>('/api/dev/fuse-orient', {
      method: 'POST',
      body: { assignments }
    });
    saveNote.value = `wrote ${res.written} to overrides.json${res.rejected.length ? ` (${res.rejected.length} rejected)` : ''}`;
    await refresh();
  } finally {
    saving.value = false;
  }
}

useHead({
  title: 'Fuse orientation (dev) — 2XKO Replay Database',
  meta: [{
    name: 'robots',
    content: 'noindex'
  }]
});
</script>

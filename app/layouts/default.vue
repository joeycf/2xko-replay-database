<script setup lang="ts">
const route = useRoute()

const nav = [
  { label: 'Browse', to: '/' },
  { label: 'Stats', to: '/stats' },
  { label: 'Champions', to: '/champions' },
  { label: 'Players', to: '/players' },
]

const isActive = (to: string) =>
  to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`)
const isBrowse = computed(() => route.path === '/')
const drawerOpen = useState('filter-drawer-open', () => false)

// Lightweight active-filter count (mirrors useFilters' chips without pulling
// in the data composables — the layout must not trigger the videos fetch).
const activeFilterCount = computed(() => {
  const q = route.query
  const csvLen = (v: unknown) =>
    typeof v === 'string' && v ? v.split(',').filter(Boolean).length : 0
  let n = csvLen(q.c) + csvLen(q.p)
  if (q.side === '1') n++
  if (typeof q.ch === 'string' && q.ch) n++
  if (typeof q.s === 'string' && q.s) n++
  if (typeof q.mt === 'string' && q.mt) n++
  if (typeof q.q === 'string' && q.q) n++
  return n
})
</script>

<template>
  <div class="flex min-h-screen flex-col bg-base text-ink-primary">
    <a href="#main" class="skip-link">Skip to content</a>

    <header
      class="sticky top-0 z-50 border-b border-white/[0.09] backdrop-blur"
      style="background: rgba(12, 13, 18, 0.92)"
    >
      <div class="flex items-center gap-4 px-4 py-3 md:gap-[26px] md:px-7 md:py-4">
        <NuxtLink
          to="/"
          class="flex-none font-display text-[16px] font-bold tracking-tight text-ink-primary md:text-[20px]"
        >
          2XKO<span class="text-accent">/</span><span class="hidden sm:inline">REPLAY</span>
        </NuxtLink>

        <nav class="hidden gap-[22px] font-sans text-[14px] font-semibold md:flex" aria-label="Primary">
          <NuxtLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="relative py-1 transition-colors duration-200"
            :class="isActive(item.to) ? 'text-ink-primary' : 'text-ink-muted hover:text-ink-secondary'"
          >
            {{ item.label }}
            <span
              v-if="isActive(item.to)"
              class="absolute inset-x-0 -bottom-[19px] h-0.5 bg-accent"
            />
          </NuxtLink>
        </nav>

        <!-- search everywhere: live on Browse, submit→/?q= elsewhere -->
        <SearchBox class="ml-auto hidden w-[340px] md:flex" />
        <SearchBox compact class="ml-auto min-w-0 max-w-[220px] flex-1 md:hidden" />
        <button
          v-if="isBrowse"
          type="button"
          class="relative flex flex-none cursor-pointer items-center gap-1.5 bg-accent px-3 py-[9px] font-sans text-[12px] font-bold text-[#08090c] cut-bl-6 md:hidden"
          aria-label="Open filters"
          @click="drawerOpen = true"
        >
          <span class="flex flex-col gap-[2.5px]" aria-hidden="true">
            <span class="h-0.5 w-3.5 bg-[#08090c]" />
            <span class="h-0.5 w-2.5 bg-[#08090c]" />
            <span class="h-0.5 w-1.5 bg-[#08090c]" />
          </span>
          Filters
          <ClientOnly>
            <span
              v-if="activeFilterCount > 0"
              class="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-accent bg-[#08090c] px-1 font-mono text-[10px] text-accent"
              >{{ activeFilterCount }}</span
            >
          </ClientOnly>
        </button>
      </div>

      <nav
        class="flex gap-5 overflow-x-auto px-4 pb-2.5 font-sans text-[13px] font-semibold md:hidden"
        aria-label="Primary mobile"
      >
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="whitespace-nowrap"
          :class="isActive(item.to) ? 'text-ink-primary' : 'text-ink-muted'"
        >
          {{ item.label }}
        </NuxtLink>
      </nav>
    </header>

    <main id="main" class="flex-1">
      <slot />
    </main>

    <footer
      class="border-t border-white/[0.08] px-7 py-4 font-sans text-[11px] text-ink-muted"
      style="background: #0c0d12"
    >
      2XKO Replay Database is an unofficial fan project, not endorsed by or affiliated with Riot
      Games.
    </footer>
  </div>
</template>

<script setup lang="ts">
// 2XKO footer — same-path override of the engine's SiteFooter (the mechanism
// its own docblock earmarks for exactly this). Keeps the shipped behavior:
// STICKY bottom bar (the browse grid scrolls forever, so the footer pins to
// the viewport instead of waiting at an unreachable page end), the tagline
// (hidden on phones — the pinned bar must stay one line tall), and the
// Buy Me a Coffee link. The fan-project disclaimer lives in the VideoModal.

/** Buy Me a Coffee page linked from the site footer. */
const BMC_URL = 'https://buymeacoffee.com/whatdaflip';
</script>

<template>
  <footer
    class="sticky bottom-0 z-40 flex flex-wrap items-center justify-center gap-x-8 gap-y-1 border-t border-white/[0.08] bg-[#0c0d12] px-7 py-4 font-ui text-[11px] text-text-muted sm:justify-between"
  >
    <p class="hidden sm:block">
      2XKO Replay Database was built with passion and love for the game.
    </p>
    <a
      :href="BMC_URL"
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label="Support the site (opens in a new tab)"
      class="-mx-2 -my-2.5 flex flex-none items-center gap-1.5 px-2 py-2.5 font-semibold transition-colors duration-normal hover:text-text-secondary"
    >
      <svg
        class="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M10 2v2" />
        <path d="M14 2v2" />
        <path
          d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"
        />
        <path d="M6 2v2" />
      </svg>
      Help support the site
    </a>
  </footer>
</template>

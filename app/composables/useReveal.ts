/**
 * Scroll-into-view reveal driver for the stats charts.
 *
 * SSR renders every chart in its FINAL state (real numbers in the HTML).
 * On the client — unless prefers-reduced-motion — `prepare` zeroes the visuals
 * right after mount and `reveal` animates them in (anime.js v4, dynamically
 * imported so it never evaluates during SSR). Reduced motion: neither hook
 * runs, so the prerendered final state simply stands.
 */
export function prefersReducedMotion(): boolean {
  return import.meta.client && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The design's snap easing, as an anime.js v4 ease string. */
export const SNAP_EASE = 'cubicBezier(0.16, 1, 0.3, 1)'

export type AnimeModule = typeof import('animejs')

export function useReveal(
  target: Ref<HTMLElement | null>,
  hooks: {
    prepare?: (el: HTMLElement) => void
    reveal: (el: HTMLElement, anime: AnimeModule) => void
  },
  options?: { threshold?: number },
) {
  const revealed = ref(false)
  let io: IntersectionObserver | undefined

  onMounted(() => {
    const el = target.value
    if (!el || prefersReducedMotion()) return
    hooks.prepare?.(el)
    io = new IntersectionObserver(
      async (entries) => {
        if (revealed.value || !entries.some((e) => e.isIntersecting)) return
        revealed.value = true
        io?.disconnect()
        hooks.reveal(el, await import('animejs'))
      },
      { threshold: options?.threshold ?? 0.15 },
    )
    io.observe(el)
  })
  onBeforeUnmount(() => io?.disconnect())

  return { revealed }
}

/** Zero out `.bar-fill` widths and `.count-up` labels inside a chart root. */
export function prepareBars(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('.bar-fill')) el.style.width = '0%'
  for (const el of root.querySelectorAll<HTMLElement>('.count-up')) el.textContent = '0'
}

/** Grow bars to their data-pct and count labels up to data-value, staggered. */
export function animateBarsIn(root: HTMLElement, anime: AnimeModule): void {
  const { animate, stagger } = anime
  const fills = [...root.querySelectorAll<HTMLElement>('.bar-fill')]
  if (fills.length) {
    animate(fills, {
      width: (el: HTMLElement) => `${el.dataset.pct ?? 0}%`,
      duration: 800,
      ease: SNAP_EASE,
      delay: stagger(45),
    })
  }
  animateCountUps(root, anime, 45)
}

/**
 * Count `.count-up` labels from 0 to their data-value. Each label animates a
 * plain state object, so per-element stagger is computed numerically here
 * (anime's stagger() helper only works when anime itself iterates targets).
 */
export function animateCountUps(root: HTMLElement, anime: AnimeModule, stepMs = 0): void {
  const { animate } = anime
  for (const [i, el] of [...root.querySelectorAll<HTMLElement>('.count-up')].entries()) {
    const target = Number(el.dataset.value ?? 0)
    const state = { n: 0 }
    animate(state, {
      n: target,
      duration: 750,
      ease: 'outCubic',
      delay: i * stepMs,
      onUpdate: () => {
        el.textContent = Math.round(state.n).toLocaleString('en-US')
      },
      onComplete: () => {
        el.textContent = target.toLocaleString('en-US')
      },
    })
  }
}

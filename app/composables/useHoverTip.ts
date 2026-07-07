/** Where a HoverTip box attaches: clamped anchor-center x, anchor top/bottom y. */
export interface HoverTipPos {
  x: number
  y: number
  above: boolean
}

// lazily cached device gate — mouseenter handlers only ever run client-side
let canHover: boolean | undefined

/**
 * Hover-tooltip state shared by the synergy matrix cells, the champion filter
 * chips and every ChampBadge. Desktop-only enhancement: on touch
 * (`hover: none`) showTip is a no-op so a tap stays a pure click. The tip
 * hides on any scroll — capture also catches nested scroll containers like
 * the filter drawer — and the scroll listener only exists while a tip is
 * showing, so per-badge instances cost nothing at rest.
 * Render the box with `<HoverTip :tip="tip">`.
 */
export function useHoverTip<T>({ clampX = 158, flipAt = 52 } = {}) {
  // shallowRef: replaced wholesale, and it keeps T clear of UnwrapRef
  const tip = shallowRef<(HoverTipPos & { data: T }) | null>(null)

  const hideTip = () => {
    tip.value = null
    window.removeEventListener('scroll', hideTip, { capture: true })
  }
  function showTip(e: Event, data: T) {
    canHover ??= window.matchMedia('(hover: hover) and (pointer: fine)').matches
    if (!canHover) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const above = r.top > flipAt // flip below the anchor when the viewport top is close
    tip.value = {
      data,
      // clamp the anchor center so a tip ~2×clampX wide can't overflow either edge
      x: Math.min(Math.max(r.left + r.width / 2, clampX), window.innerWidth - clampX),
      y: above ? r.top : r.bottom,
      above,
    }
    // identical listeners dedupe, so enter-after-enter without a leave is safe
    window.addEventListener('scroll', hideTip, { passive: true, capture: true })
  }

  // an anchor can unmount mid-hover (e.g. filter change) with no mouseleave —
  // the teleported box unmounts with the owner, but the listener must not leak
  onScopeDispose(hideTip)

  return { tip, showTip, hideTip }
}

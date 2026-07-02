import type { RouterConfig } from '@nuxt/schema'

// Query-only navigations (filters, ?v= modal) must never move the page —
// scroll offsets around the modal are handled by lock/unlockBodyScroll.
export default <RouterConfig>{
  scrollBehavior(to, from, savedPosition) {
    if (to.path === from.path) return false
    return savedPosition || { top: 0 }
  },
}

// Body scroll lock that PRESERVES the scroll offset (html{overflow:hidden}
// zeroes window.scrollY, which would jump the grid under the modal).
// Ref-counted: the drawer and the modal can overlap.
let lockedY = 0
let locks = 0

export function lockBodyScroll(): void {
  if (import.meta.server) return
  if (++locks > 1) return
  lockedY = window.scrollY
  const b = document.body
  b.style.position = 'fixed'
  b.style.top = `-${lockedY}px`
  b.style.left = '0'
  b.style.right = '0'
  b.style.width = '100%'
}

export function unlockBodyScroll(): void {
  if (import.meta.server) return
  if (locks === 0) return
  if (--locks > 0) return
  const b = document.body
  b.style.position = ''
  b.style.top = ''
  b.style.left = ''
  b.style.right = ''
  b.style.width = ''
  window.scrollTo(0, lockedY)
}

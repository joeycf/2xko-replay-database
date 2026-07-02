/**
 * Canonical URL + OG/Twitter card meta for a page. Champion pages pass their
 * splash as `image`; everything else falls back to the generated site card.
 * Absolute URLs come from runtimeConfig.public.siteUrl (NUXT_PUBLIC_SITE_URL
 * at generate time).
 */
export function useSiteMeta(opts: {
  title: string
  description: string
  image?: string
  path?: string
}) {
  const site = useRuntimeConfig().public.siteUrl.replace(/\/$/, '')
  const route = useRoute()
  const url = `${site}${opts.path ?? route.path}`
  const image = opts.image
    ? opts.image.startsWith('http')
      ? opts.image
      : `${site}${opts.image}`
    : `${site}/og-default.png`

  useHead({ link: [{ rel: 'canonical', href: url }] })
  useSeoMeta({
    title: opts.title,
    description: opts.description,
    ogTitle: opts.title,
    ogDescription: opts.description,
    ogImage: image,
    ogUrl: url,
    ogType: 'website',
    ogSiteName: '2XKO Replay Database',
    twitterCard: 'summary_large_image',
    twitterTitle: opts.title,
    twitterDescription: opts.description,
    twitterImage: image,
  })
}

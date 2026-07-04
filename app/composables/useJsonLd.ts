/**
 * Inject prerenderable JSON-LD structured data (each node gets @context).
 *
 * Deliberately NO VideoObject anywhere on the site: video metadata is
 * client-fetched from /data/videos.json and absent from the prerendered
 * HTML, so a VideoObject would describe content crawlers can't see.
 */
export function useJsonLd(nodes: Record<string, unknown>[]) {
  useHead({
    script: nodes.map((n) => ({
      type: 'application/ld+json',
      // escape '<' so a literal '</script>' in data can't break out of the tag
      innerHTML: JSON.stringify({ '@context': 'https://schema.org', ...n }).replace(/</g, '\\u003c'),
    })),
  })
}

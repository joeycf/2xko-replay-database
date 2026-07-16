/**
 * Legacy deep-link translation (Phase 3): the shipped Browse filter params
 * differ from the engine's URL schema. Old bookmarks/shared links keep
 * working by rewriting them once (replace — no history growth):
 *
 *   ch=pro|high        → src=proReplays|highLevel
 *   s=beta|0|1|2       → patch=Beta|S0|S1|S2      (the emitted patch keys)
 *   type=tournament    → src=manual               (same set: manual tournament VODs)
 *   type=ranked|duo    → dropped                  (no engine equivalent)
 *
 * fuse= needs NO translation since Phase 3.5: the fuse facet registers the
 * shipped param name (plugins/facets.ts), so old fuse deep links work
 * natively. c / p / side / q / sort / v are schema-identical too.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (to.path !== '/') return;
  const q = to.query;
  if (q.ch === undefined && q.s === undefined && q.type === undefined) return;

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }

  const srcParts = new Set(out.src ? out.src.split(',') : []);
  if (out.ch === 'pro') srcParts.add('proReplays');
  if (out.ch === 'high') srcParts.add('highLevel');
  delete out.ch;

  if (out.s === 'beta') out.patch = 'Beta';
  else if (out.s !== undefined && /^\d+$/.test(out.s)) out.patch = `S${out.s}`;
  delete out.s;

  if (out.type === 'tournament') srcParts.add('manual');
  delete out.type;

  if (srcParts.size) out.src = [...srcParts].join(',');

  return navigateTo({ path: to.path, query: out }, { replace: true });
});

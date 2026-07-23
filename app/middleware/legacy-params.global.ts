/**
 * Legacy deep-link translation (Phase 3): the shipped Browse filter params
 * differ from the engine's URL schema. Old bookmarks/shared links keep
 * working by rewriting them once (replace — no history growth):
 *
 *   ch=pro|high        → src=proReplays|highLevel
 *   s=beta|0|1        → patch=Beta|S0|S1           (the emitted patch keys)
 *   s=2 · patch=S2    → patch=<the 1.2.x acts>     (see below)
 *   type=tournament    → src=manual               (same set: manual tournament VODs)
 *   type=ranked|duo    → dropped                  (no engine equivalent)
 *
 * "S2" NEVER EXISTED (confirmed 2026-07-23): 2XKO versions are
 * <season>.<act>.<patch>, and the middle digit is an ACT within Season 1 —
 * the community (and this site, for six weeks) mislabeled the 1.2.x act as
 * "Season 2". Links minted in that window still mean that footage, so the
 * S2 token translates to every 1.2.x patch version, derived from
 * patchBoundaries.json so the set tracks new act-2 releases automatically.
 *
 * fuse= needs NO translation since Phase 3.5: the fuse facet registers the
 * shipped param name (plugins/facets.ts), so old fuse deep links work
 * natively. c / p / side / q / sort / v are schema-identical too.
 */
import boundaries from '../../data/patchBoundaries.json';

const ACT2 = boundaries.patches.map((p) => p.version).filter((v) => v.startsWith('1.2.'));

export default defineNuxtRouteMiddleware((to) => {
  if (to.path !== '/') return;
  const q = to.query;
  const patchHasS2 = typeof q.patch === 'string' && q.patch.split(',').includes('S2');
  if (q.ch === undefined && q.s === undefined && q.type === undefined && !patchHasS2) return;

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }

  const srcParts = new Set(out.src ? out.src.split(',') : []);
  if (out.ch === 'pro') srcParts.add('proReplays');
  if (out.ch === 'high') srcParts.add('highLevel');
  delete out.ch;

  if (out.s === 'beta') out.patch = 'Beta';
  else if (out.s === '2') out.patch = ACT2.join(',');
  else if (out.s !== undefined && /^\d+$/.test(out.s)) out.patch = `S${out.s}`;
  delete out.s;

  // the mislabeled-era token, wherever it came from (old chips, shared links)
  if (out.patch?.split(',').includes('S2')) {
    out.patch = out.patch
      .split(',')
      .flatMap((t) => (t === 'S2' ? ACT2 : [t]))
      .filter((t, i, xs) => xs.indexOf(t) === i)
      .join(',');
  }

  if (out.type === 'tournament') srcParts.add('manual');
  delete out.type;

  if (srcParts.size) out.src = [...srcParts].join(',');

  return navigateTo({ path: to.path, query: out }, { replace: true });
});

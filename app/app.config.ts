import type { GameConfig } from '@engine/types';

import patchGroups from '../data/patchGroups.json';

/**
 * The 2XKO GameConfig — merged OVER the engine's neutral default (PLAN §4a).
 * Everything game-shaped the engine renders comes from here via useGame()/
 * useGameTerms(); the visual skin lives separately in app/assets/theme.css.
 *
 * Accents are transcribed from design/handoff/tokens.css (--champ-*), the
 * design system's source of truth — scripts/champions.ts reads the same file
 * when enriching data/characters.json, so config and data can't drift apart.
 */
export default defineAppConfig({
  game: {
    id: '2xko',
    slug: '2xko',
    name: '2XKO',
    shortName: '2XKO',
    rightsHolder: 'Riot Games',
    baseURL: '/2xko', // behind the shell at replaydatabase.com/2xko (Phase 5)
    siteUrl: 'https://replaydatabase.com',
    // Web Analytics beacons go to THIS project instead of pooling into the
    // shell. Paired 1:1 with the shell vercel.json rewrite
    //   /2xko-insights/:path* → https://2xko-replay-database.vercel.app/_vercel/insights/:path*
    // — the two ship together or every beacon 404s. Same-origin on purpose:
    // the child's endpoints send no CORS headers, so an absolute URL here
    // would die at preflight. speedInsights is deliberately left at the engine
    // default (single-project on Hobby — it must reach the enabled project).
    observability: { insights: '/2xko-insights' },
    charactersPerSide: 2,
    filters: {
      coOccurrence: true, // the "same side" duo filter
      rank: false,
    },
    accents: {
      ahri: '#FF5DA2',
      akali: '#35D98A',
      blitzcrank: '#FFC24B',
      braum: '#58C7E8',
      caitlyn: '#B98AE0',
      darius: '#F0463F',
      ekko: '#1FE0D4',
      illaoi: '#CE9138',
      jinx: '#5B8CFF',
      senna: '#97DB4A',
      teemo: '#E27E3C',
      thresh: '#49E0A6',
      vi: '#FF6F61',
      warwick: '#7A6BE8',
      yasuo: '#52C4C4',
    },
    // Order matters: SourceBadge styles by index (0 = filled primary,
    // 1 = secondary outline, 2+ = warning outline) — matching the shipped
    // Pro Replays (pink) / High Level (cyan) / Tournament (amber) badges.
    // 'manual' is the pipeline's source id for hand-authored tournament VODs.
    // APPEND only: inserting would recolour the existing badges. 'bestReplays'
    // lands at index 3 and shares the amber outline with 'manual' (only 3 styles
    // exist) — the label distinguishes them.
    sourceChannels: [
      { id: 'proReplays', name: 'Pro Replays' },
      { id: 'highLevel', name: 'High Level' },
      { id: 'manual', name: 'Tournament' },
      { id: 'bestReplays', name: 'Best Replays' },
      // appended at index 4 — the badge palette has 3 styles, so this shares the
      // amber outline with 'manual' and 'bestReplays' and the label distinguishes
      { id: 'evoEvents', name: 'Evo' },
      // appended at index 5 — same amber outline again. Named for what the
      // footage IS rather than for the index that catalogued it: these are
      // tournament sets cut out of event organisers' own longform VOD uploads
      // (ParagonFGC, Tampa Never Sleeps, Evo and eight others), and each record
      // carries its uploader in channelName.
      { id: 'replayTheater', name: 'Tournament VODs' },
    ],
    // Filter chips are consolidated to two groups (the per-video SourceBadge keeps
    // the real channel name from sourceChannels above). Toggling a group filters its
    // member ids as a set via the same ?src= param, so per-channel deep links still
    // work. 'Online' spans the three YouTube channels; 'Tournament' spans the hand-authored
    // VODs, Evo's own uploads, and the Replay Theater segments.
    sourceGroups: [
      { id: 'online', name: 'Online', sources: ['proReplays', 'highLevel', 'bestReplays'] },
      {
        id: 'tournament',
        name: 'Tournament',
        sources: ['manual', 'evoEvents', 'replayTheater'],
      },
    ],
    // Season→patch hierarchy for the grouped patch facet (engine v0.6.0).
    // PIPELINE-EMITTED (scripts/emit.ts → data/patchGroups.json) from the same
    // boundary authority that derives every replay's patch token, so the UI
    // hierarchy and the data can never drift. Legacy ?patch=S1 season links
    // keep working: season tokens ARE the parent tokens.
    patchGroups,
    // 2XKO's vocabulary + the live site's indexed URL segment (v0.2.0):
    // nav/headings/labels render champion/team/season, and the characters section
    // stays at /champions/*. 'source' uses the engine default (the filter now groups
    // channels into Online/Tournament rather than naming the "channel" facet).
    terms: {
      character: 'champion',
      characters: 'champions',
      side: 'team',
      patch: 'season',
      patches: 'seasons',
      source: 'source',
    },
    characterRouteSegment: 'champions',
    fonts: {
      display: 'Chakra Petch',
      ui: 'Barlow',
      mono: 'JetBrains Mono',
    },
    manifest: {
      themeColor: '#FF2E88',
      backgroundColor: '#0A0B0F',
    },
    ogImage: '/og-default.png',
  } satisfies GameConfig,
});

import type { GameConfig } from '@engine/types';

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
    ],
    // 2XKO's vocabulary + the live site's indexed URL segment (v0.2.0):
    // nav/headings/labels render champion/team/season/channel, and the
    // characters section stays at /champions/*.
    terms: {
      character: 'champion',
      characters: 'champions',
      side: 'team',
      patch: 'season',
      patches: 'seasons',
      source: 'channel',
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

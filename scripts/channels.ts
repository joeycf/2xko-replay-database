// Channel configuration shared by fetch + parse.
// The two channels use DIFFERENT delimiters between duo player names, but the
// SAME delimiter between the two characters of a team.

import type { ChannelKey } from '../types/index';

export interface ChannelResolve {
  /** how to resolve the channel to its uploads playlist */
  by: 'id' | 'handle';
  value: string;
}

export interface ChannelConfig {
  key: ChannelKey;
  name: string;
  resolve: ChannelResolve;
  /** how duo player names are joined in a title, e.g. " - " or " + " */
  playerSep: RegExp;
  /** trailing channel-branding suffix (for reference / stripping) */
  suffix: RegExp;
  /** This channel publishes MORE THAN 2XKO, so an upload must carry a 2XKO marker
   *  to be considered at all. Every other channel here is 2XKO-only by
   *  construction and leaves this unset. */
  gameSignal?: RegExp;
  /** This channel's titles never name a champion, so its match-shaped uploads are
   *  completed from the FOOTAGE (scripts/hud-read.ts) and published from an
   *  overrides.json verdict rather than from a title parse. Without a verdict a
   *  record is held out of videos.json entirely — an empty-champion record is
   *  worse than no record. */
  charactersFromFootage?: boolean;
  /** This channel no longer publishes this game. It is NOT fetched, requires no
   *  raw dump, and its committed records are carried forward by parse.ts — see
   *  the channel-collapse guard there for why deleting them was the alternative.
   *  `records` pins the expected carry count: data/videos.json is both the source
   *  and the target of that carry, so a bad run would otherwise poison the next
   *  run's reference permanently. A deliberate prune means editing the number,
   *  which shows up in the diff. */
  frozen?: {
    /** ISO date fetching stopped */
    since: string;
    /** why — surfaced in data/report.md */
    reason: string;
    /** expected number of carried records; a mismatch is a hard failure */
    records: number;
  };
}

export const CHANNELS: Record<ChannelKey, ChannelConfig> = {
  proReplays: {
    key: 'proReplays',
    name: '2XKO Pro Replays',
    resolve: { by: 'id', value: 'UCdppkT52RXi-pGvyibNIXNw' },
    // FROZEN 2026-08-08. This channel rebranded to "MARVEL TOKON Pro Replays" and
    // unlisted its entire 2XKO back catalogue. The 1,317 uploads still exist and
    // still play at their URLs — unlisted videos merely leave the uploads
    // playlist — so a fetch enumerated 7 where it had enumerated 1,317, and a bare
    // data:build would have pruned a quarter of the archive for a rebrand.
    //
    // Its 6 current uploads are MARVEL Tokon pro replays and do not belong in this
    // pipeline; they are preserved at raw/_tokon-sample.json as the first
    // identified source for that game.
    frozen: {
      since: '2026-08-08',
      reason: 'channel rebranded to MARVEL TOKON and unlisted its 2XKO catalogue',
      records: 1317,
    },
    playerSep: /\s+-\s+/, // duo players joined by " - " (spaces)
    suffix: /2XKO Pro level replays/i,
  },
  highLevel: {
    key: 'highLevel',
    name: '2XKO High Level Replays',
    resolve: { by: 'handle', value: '@2xkoHighLevelReplay' },
    playerSep: /\s*\+\s*/, // duo players joined by " + "
    suffix: /High Level Gameplay/i,
  },
  bestReplays: {
    key: 'bestReplays',
    name: '2XKO Best Replays',
    // resolve by id: the channel id is stable, a handle can be changed by its owner
    resolve: { by: 'id', value: 'UCUULKDufuCn_OSInbqNz50g' },
    playerSep: /\s*&\s*/, // duo players joined by " & "
    // NOTE: this channel's branding tail is literally the *names* of the other two
    // channels ("▰ 2XKO Pro Replays" / "▰ 2XKO High Level Replays"). Nothing reads
    // `suffix`, so that collision is inert — but do not wire it up without revisiting.
    suffix: /2XKO (Pro|High Level) Replays?/i,
  },
  evoEvents: {
    key: 'evoEvents',
    name: 'Evo',
    // "Evo Events" — the event's own channel, ~2,750 uploads across every game it
    // runs. 21 of them are single 2XKO sets (Evo 2026 and Evo Japan 2026), and not
    // one names a champion.
    //
    // Tracked because the champions can now be READ off the broadcast HUD, which
    // prints all four as text — romanized at Evo Las Vegas, KATAKANA at Evo Japan.
    // Measured against 21 hand labels: zero fabrications, 100% precision at every
    // confidence threshold, 18/18 on side resolution. See README.
    resolve: { by: 'id', value: 'UCWI626ZNdqM5tOlctPUTW2g' },
    // Reference only, like every entry here — the parser splits on the unified
    // PLAYER_SEP below. Recorded because this channel's duo delimiter is "/"
    // ("SonicFox/INZEM"), which is ALSO in CHAR_SEP: a title parse would split it
    // in the wrong dimension. Inert only because charactersFromFootage holds these
    // records for a footage verdict instead of parsing their titles.
    playerSep: /\s*\/\s*|\s+and\s+/i,
    suffix: /\|\s*2XKO\s*\|/i,
    // The channel publishes Street Fighter, Tekken, Guilty Gear and the rest
    // alongside; without the marker every upload enters the 2XKO corpus.
    gameSignal: /\b2XKO\b/i,
    charactersFromFootage: true,
  },
};

// Character separator is UNIFIED across channels: split on /\s*[\/-]\s*/
// (handles High Level's " / " and Pro Replays' "-").
export const CHAR_SEP = /\s*[/-]\s*/;

// Duo player separator is ALSO effectively unified: in practice all channels mix
// delimiters — Pro uses " - ", one-sided "- "/" -", AND " + "; High Level uses " + "
// and sometimes " - "; Best Replays uses " & ". Split on "&" or "+" (any spacing) or a
// hyphen with whitespace on at least one side. A no-space hyphen ("DIAPHONE-ZANE") is
// left intact — it's indistinguishable from a single handle. (CHANNELS[].playerSep
// above is kept as the per-channel *primary* delimiter for reference; the parser
// splits on this unified one.)
//
// "&" is safe to unify: zero titles and zero player handles in the pre-bestReplays
// catalog (2946 channel records / 715 players) contained "&", so widening cannot
// change how any existing record parses — verified before landing.
export const PLAYER_SEP = /\s*&\s*|\s*\+\s*|\s+-\s*|\s*-\s+/;

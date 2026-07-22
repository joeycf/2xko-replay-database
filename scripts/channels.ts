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
}

export const CHANNELS: Record<ChannelKey, ChannelConfig> = {
  proReplays: {
    key: 'proReplays',
    name: '2XKO Pro Replays',
    resolve: { by: 'id', value: 'UCdppkT52RXi-pGvyibNIXNw' },
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

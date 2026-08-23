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
   *  construction and leaves this unset.
   *
   *  `scope` is REQUIRED, not defaulted, because the right answer differs per
   *  channel and a wrong one is silent either way. Measured with /\b2XKO\b/i
   *  against the 2026-08-23 dumps:
   *
   *    channel      n     titles lacking 2XKO   title AND description lacking it
   *    bestReplays  2516  1                     0
   *    highLevel    1813  0                     0
   *    evoEvents    42    9                     0
   *
   *  'title-or-description' cannot reject the one bestReplays upload that needs
   *  rejecting — a Marvel Tokon replay whose description still names both games.
   *  'title' deletes 9 legitimate Evo 2XKO clips, whose titles are bare
   *  commentary quotes ("Hikari not gonna give it to him.") naming no game at
   *  all. No default is right for both, so each channel states its own next to
   *  the count that justifies it.
   *
   *  The pattern must carry neither /g nor /y: one RegExp is reused across every
   *  record in a dump, and a stateful one would alternate true/false down the
   *  rows. */
  gameSignal?: {
    /** the marker; no /g or /y flag (see above) */
    pattern: RegExp;
    /** where the marker must appear for the upload to count as this game */
    scope: 'title' | 'title-or-description';
  };
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
    // Not a multi-game channel today: 1,813 of 1,813 dumped titles carry the
    // marker, so this rejects nothing. It is here because bestReplays looked
    // exactly like this the day before it rebranded (2026-08-23), and proReplays
    // looked exactly like this the day before it rebranded (2026-08-08). Two of
    // the three tracked replay channels have now walked to another game. The
    // price of assuming the third won't is a foreign-game record and a junk
    // player page that outlives it; the price of the gate, measured, is zero.
    gameSignal: { pattern: /\b2XKO\b/i, scope: 'title' },
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
    // GATED 2026-08-23. This channel rebranded to the multi-game "FGC Replays
    // Hub" and began publishing Marvel Tokon alongside 2XKO — same title grammar,
    // same "▰ High Level Gameplay" tail, different game. The first one shipped to
    // the site: WryZaaMayl8, "Marvel Tokon ▰ EDUARDO HOOK (Blade) vs SUPERNOON
    // (Magik)". Nothing stopped it. PREFIX (parse.ts) only strips a 2XKO-bearing
    // lead segment and a no-match is a no-op by design, so "Marvel Tokon ▰
    // EDUARDO HOOK" survived normalizePlayerSegment whole and minted the player
    // `marveltokoneduardohook`, with a prerendered profile page.
    //
    // TITLE SCOPE, not title-or-description. That upload's description reads
    // "featuring matches from 2XKO and Marvel Tokon" — the new multi-game
    // boilerplate names BOTH games, so a description check passes every Tokon
    // upload this channel will ever publish. The description stopped being
    // evidence here; the title is the only field that still separates the games.
    // Cost of the gate: 1 of 2,516 dumped titles, and it is that video.
    //
    // KNOWN HOLE, currently dormant. 2,470 of those 2,516 titles end in the
    // 2XKO-bearing branding tail noted above, and a Tokon upload pasting one
    // would pass this gate. The channel stopped using them: it moved to the
    // game-neutral "▰ High Level Gameplay" on 2026-08-17 and has used nothing
    // else since 2026-08-19 (newest 2XKO-bearing tail: 2026-08-18). Across that
    // neutral-tail era, 29 of 30 uploads name the game in the LEAD segment and
    // the one exception is the Tokon video — i.e. the convention now matches
    // what this gate reads. If that reverts, the move is a title-only negative
    // marker (/\bmarvel\s*tokon\b/i — 0 false positives across both replay
    // channels today). It must NOT read the description: the new "2XKO and
    // Marvel Tokon" boilerplate is on the 2XKO uploads too.
    gameSignal: { pattern: /\b2XKO\b/i, scope: 'title' },
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
    //
    // DESCRIPTION SCOPE IS LOAD-BEARING here, unlike the replay channels above.
    // 9 of the 42 records that pass this gate have titles that name no game:
    // bare commentary pulls ("Hikari not gonna give it to him.") and generic day
    // labels ("Evo 2026 Day 1: Evo Showcase"). All 9 are real 2XKO clips and all
    // 9 identify the game only in the description. Narrowing this to 'title'
    // silently deletes every one of them.
    gameSignal: { pattern: /\b2XKO\b/i, scope: 'title-or-description' },
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

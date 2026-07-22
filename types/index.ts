// Shared types for the 2XKO replay data pipeline.
// Registries (champions/players/fuses) are read from data/*.json at runtime —
// never hardcode the rosters in code.

/** A playable champion — data/characters.json, the ENGINE-GENERIC Character
 *  shape (Phase 3): the app plugin imports this file verbatim, and the
 *  pipeline reads/writes the same shape (scripts/champions.ts enriches art +
 *  accents; parse.ts matches on extra.aliases). */
export interface Champion {
  id: string;
  name: string;
  imgPortrait: string;
  imgSplash?: string;
  accent: string;
  extra: {
    /** search + two-letter badge initials (engine well-known key) */
    aliases: string[];
  };
}

/** A known player — data/players.json, the ENGINE-GENERIC Player shape
 *  (Phase 3). Seeded hand-curated; the parser auto-appends discovered names.
 *  `featured` carries the old `verified` semantics: true for the curated
 *  seed roster + manual-entry registrations, false for parser discoveries —
 *  it drives the VerifiedMark diamond and the featured filter rail. */
export interface Player {
  id: string;
  handle: string;
  featured: boolean;
  extra: {
    /** lowercased match variants (also the engine's search well-known key) */
    aliases: string[];
  };
}

/** A Fuse (team mechanic). From data/fuses.json. */
export interface Fuse {
  id: string;
  name: string;
  aliases: string[];
  active: boolean;
  /** UI accent, sampled from the in-game HUD pill (null = never rendered) */
  accent: string | null;
}

/** An editable season window. From data/seasonBoundaries.json. */
export interface SeasonBoundary {
  season: number;
  start: string;
  end: string | null;
}

/** 2XKO extension fields riding on emitted replays (scripts/emit.ts): the
 *  engine never reads them; the app's fuse facet + badge overrides do.
 *  Declared engine-free so both typecheck tracks can import this file. */
export interface ReplayFuseFields {
  /** per-side fuse ids in sides order — present iff at least one is known */
  fuses?: [string | null, string | null];
  /** CV pair is confident but side attribution is not — never side-pin */
  fusesUnordered?: true;
}

export type ChannelKey = 'proReplays' | 'highLevel' | 'bestReplays';
/** Where a record came from: a tracked channel dump, or data/manual-videos.json. */
export type VideoSource = ChannelKey | 'manual';
export type MatchType = 'ranked' | 'tournament' | 'duo';
/** "manual" = human-authored (data/manual-videos.json) — never a parse failure. */
export type ParseConfidence = 'high' | 'low' | 'manual';
export type TeamSide = 'left' | 'right';

/** A player reference as embedded in a parsed Team. */
export interface TeamPlayer {
  id: string;
  displayName: string;
}

/** One side of a match. */
export interface Team {
  side: TeamSide;
  players: TeamPlayer[];
  characters: string[]; // champion ids
  fuse: string | null; // fuse id, or null when unknown
}

/** A fully-parsed video record. Written to data/videos.json (Stage 2). */
export interface VideoRecord {
  id: string;
  channel: VideoSource;
  channelName: string;
  title: string;
  publishedAt: string;
  thumbnail: string;
  durationSec: number;
  viewCount: number;
  season: number | null;
  patch: string | null; // ISO date | raw label | null
  matchType: MatchType;
  teams: Team[];
  allCharacters: string[]; // flat, unique champion ids across both teams
  allPlayers: string[]; // flat, unique player ids across both teams
  tags: string[];
  parseConfidence: ParseConfidence;
  rawUnparsed: string | null;
  /** CV-detected fuses are confident as a pair but side attribution is ambiguous */
  fusesUnordered?: boolean;
  /** manual tournament records only: event name, e.g. "Evo 2026" */
  tournament?: string;
  /** manual tournament records only: bracket round label, e.g. "Grand Final" */
  round?: string;
}

/**
 * One side of a hand-authored video (data/manual-videos.json). Tournament
 * entries are SET-level: `characters` is the union of champions the player(s)
 * fielded across the whole set, not a single game's duo — so it may hold more
 * than 2 ids, and pairing/matchup stats only count it when it's exactly 2.
 */
export interface ManualTeamEntry {
  /** display names; resolved against players.json aliases, unknown names are registered (verified) */
  players: string[];
  /** champion ids or aliases (validated on merge); [] while not yet known */
  characters: string[];
  /** fuse id; omit/null when unknown (tournament fuses aren't CV-detected) */
  fuse?: string | null;
}

/** A hand-authored video record (data/manual-videos.json). Authoring docs live
 *  in that file's "//" header; scripts/parse.ts validates and merges these. */
export interface ManualVideoEntry {
  id: string;
  title: string;
  publishedAt: string;
  /** event name, e.g. "Evo 2026" */
  tournament: string;
  /** bracket round label, e.g. "Grand Final" */
  round?: string;
  /** hosting YouTube channel; defaults to the tournament name */
  channelName?: string;
  /** defaults to https://i.ytimg.com/vi/<id>/hqdefault.jpg */
  thumbnail?: string;
  durationSec?: number;
  viewCount?: number;
  /** defaults to "tournament" */
  matchType?: MatchType;
  /** defaults from publishedAt via seasonBoundaries.json */
  season?: number | null;
  patch?: string | null;
  /** extra tags; round tags are still derived from the title */
  tags?: string[];
  /** free-text incompleteness marker — parse warns but proceeds */
  todo?: string;
  /** exactly 2, in title order (left, right) */
  teams: ManualTeamEntry[];
}

/** Shape of data/manual-videos.json. */
export interface ManualVideosFile {
  '//'?: string[];
  videos: ManualVideoEntry[];
}

/** One video's CV fuse detection (data/fuses-detected.json, scripts/fuses.ts). */
export interface FuseDetection {
  /** teams[0]'s fuse IN TITLE ORDER (screen order only when status is ok-unordered) */
  left: string | null;
  right: string | null;
  score: { left: number; right: number };
  status: 'ok' | 'ok-unordered' | 'low' | 'none';
  era: string;
  detectedAt: string;
}

/** Which kind of fuse gap a missing-fuse video is (scripts/fuse-gaps.ts). */
export type FuseGapBucket = 'unavailable' | 'low' | 'none' | 'pending' | 'anomaly';

/** One missing-fuse video in the gap diagnostic. */
export interface FuseGapItem {
  id: string;
  bucket: FuseGapBucket;
  era: string;
  channel: ChannelKey;
  publishedAt: string;
  /** advisory markers: "maybe-pending" (appeared around the last run — may never have been attempted) · "premiere" (0-duration) */
  flags: string[];
  /** cached frame count (cache/fuse/frames/<id>/) — 0 when the download never succeeded */
  frames: number;
  /** download-attempt dates from cache/fuse/attempted.json (absent in git-fallback mode) */
  attempts?: string[];
  /** low/none/anomaly only: raw detection read from fuses-detected.json */
  detection?: Pick<FuseDetection, 'left' | 'right' | 'score' | 'status'>;
}

/** One orientation-blocked low read: fuse is legible, owning title-team is not. */
export interface FuseOrientItem {
  id: string;
  /** row # in the current gap-pills.png montage (null if report is stale) */
  montage: number | null;
  /** which SCREEN side the legible pill sits on */
  screenSide: TeamSide;
  fuse: string;
  dist: number;
  margin: number;
  struct: number;
  /** cached frame count, for the viewer's frame cycler */
  frames: number;
}

/** cache/fuse/review/orient-queue.json — written by --promote-lows, consumed by /dev/fuse-orient. */
export interface FuseOrientQueue {
  generatedAt: string;
  items: FuseOrientItem[];
}

/** What overrides.json currently says about one video's fuses, in title order. */
export interface FuseReviewVerdict {
  /** per-title-team fuse ids; null = this side is unread */
  fuses: [string | null, string | null];
  /** pair is settled but the owning teams are not — mirrors VideoRecord.fusesUnordered */
  unordered: boolean;
}

/** One hand-reviewable missing-fuse video: the gap, its parsed teams, the
 *  detector's rejected guess, and any verdict already in overrides.json.
 *  Joined server-side so /dev/fuse-review never pulls all of videos.json. */
export interface FuseReviewItem {
  id: string;
  bucket: FuseGapBucket;
  era: string;
  publishedAt: string;
  season: number | null;
  title: string;
  channelName: string;
  /** cached frame count (cache/fuse/frames/<id>/) — always ≥ 1 here */
  frames: number;
  /** exactly 2, in TITLE order (the order every verdict is expressed in) */
  teams: Team[];
  /** the read the detector made but did not trust; null when never attempted */
  detection: Pick<FuseDetection, 'left' | 'right' | 'score' | 'status'> | null;
  /** current overrides.json state, or null when this id is unresolved */
  saved: FuseReviewVerdict | null;
}

/** Payload of /api/dev/fuse-review — the manual worklist for /dev/fuse-review. */
export interface FuseReviewQueue {
  /** generatedAt of the underlying gap report (staleness signal for the UI) */
  generatedAt: string;
  items: FuseReviewItem[];
}

/** cache/fuse/review/fuse-gaps.json — written by scripts/fuse-gaps.ts, served by /api/dev/fuse-gaps. */
export interface FuseGapReport {
  generatedAt: string;
  /** the videos.json snapshot treated as "was attempted by the last download run" */
  universe: { commit: string; videos: number; runDate: string };
  totals: { videos: number; withFuse: number; missing: number };
  counts: Record<FuseGapBucket, number>;
  items: FuseGapItem[];
}

/** A raw video record as dumped by scripts/fetch.ts. Written to raw/<channel>.json. */
export interface RawVideoRecord {
  id: string;
  channel: ChannelKey;
  title: string;
  description: string;
  publishedAt: string;
  thumbnail: string;
  durationSec: number;
  viewCount: number;
}

/** Aggregate stats. Written to data/stats.json (Stage 2). */
export interface Stats {
  /** count of videos featuring each champion (deduped per video) */
  characterUsage: Record<string, number>;
  /** "a|b" (ids sorted) -> count of team occurrences */
  pairingUsage: Record<string, number>;
  /** era ("beta" for pre-Season-0, else the season number as string) -> championId -> count */
  bySeasonUsage: Record<string, Record<string, number>>;
  /** total video counts, overall and per era (same keys as bySeasonUsage) */
  totals: { videos: number; bySeason: Record<string, number>; withFuse: number };
  /** fuseId -> team occurrences (from CV-detected + override fuses) */
  fuseUsage: Record<string, number>;
  /** era -> fuseId -> team occurrences */
  fuseBySeason: Record<string, Record<string, number>>;
  /** optional: playerId -> championId -> count */
  playerCharacters?: Record<string, Record<string, number>>;
  /** optional: playerId -> "a|b" (champion ids sorted) -> team occurrences */
  playerPairings?: Record<string, Record<string, number>>;
  /** optional: "a|b" (champion ids sorted) -> "c|d" -> count */
  matchupMatrix?: Record<string, Record<string, number>>;
}

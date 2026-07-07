// Shared types for the 2XKO replay data pipeline.
// Registries (champions/players/fuses) are read from data/*.json at runtime —
// never hardcode the rosters in code.

/** A playable champion. Seeded from data/champions.json. */
export interface Champion {
  id: string;
  name: string;
  archetype: string | null;
  portrait: string | null;
  splash: string | null;
  accent: string | null;
  releasedSeason: number | null;
  aliases: string[];
}

/** A known player. Seeded from data/players.json; the parser auto-appends new ones. */
export interface Player {
  id: string;
  displayName: string;
  /** true for the hand-curated seed roster, false for parser-discovered names. */
  verified: boolean;
  aliases: string[];
  region: string | null;
  socials: Record<string, string>;
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

export type ChannelKey = "proReplays" | "highLevel";
export type MatchType = "ranked" | "tournament" | "duo";
export type ParseConfidence = "high" | "low";
export type TeamSide = "left" | "right";

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
  channel: ChannelKey;
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
}

/** One video's CV fuse detection (data/fuses-detected.json, scripts/fuses.ts). */
export interface FuseDetection {
  /** teams[0]'s fuse IN TITLE ORDER (screen order only when status is ok-unordered) */
  left: string | null;
  right: string | null;
  score: { left: number; right: number };
  status: "ok" | "ok-unordered" | "low" | "none";
  era: string;
  detectedAt: string;
}

/** Which kind of fuse gap a missing-fuse video is (scripts/fuse-gaps.ts). */
export type FuseGapBucket = "unavailable" | "low" | "none" | "pending" | "anomaly";

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
  detection?: Pick<FuseDetection, "left" | "right" | "score" | "status">;
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

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
  totals: { videos: number; bySeason: Record<string, number> };
  /** optional: playerId -> championId -> count */
  playerCharacters?: Record<string, Record<string, number>>;
  /** optional: "a|b" (champion ids sorted) -> "c|d" -> count */
  matchupMatrix?: Record<string, Record<string, number>>;
}

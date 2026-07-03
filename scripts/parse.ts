// Stage 2: parse the raw dumps into structured VideoRecords, aggregate stats,
// write a report, and auto-append newly discovered players to the registry.
//
// Run: npm run data:parse   (tsx scripts/parse.ts)
//
// Confirmed decisions (Stage-1 gate):
//  • Prefix strip widened to /^2XKO[^▰]*▰\s*/i  (handles "2XKO Season 2 ▰", "2XKO 🇯🇵 ▰").
//  • Season: description "(Season N)" primary, seasonBoundaries.json fallback.
//  • Champions: exact alias → word-contains (tag balance notes) → Damerau/OSA ≤1 (low conf).

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHANNELS, CHAR_SEP, PLAYER_SEP } from "./channels";
import type {
  Champion,
  ChannelKey,
  Fuse,
  FuseDetection,
  MatchType,
  ParseConfidence,
  Player,
  RawVideoRecord,
  SeasonBoundary,
  Stats,
  Team,
  TeamSide,
  VideoRecord,
} from "../types/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "data");
const RAW = join(ROOT, "raw");

// ── generic helpers ───────────────────────────────────────────────────────────
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, "utf8")) as T;
const inc = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const slugify = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Optimal String Alignment (Damerau–Levenshtein w/ adjacent transpositions). */
function osaDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const d = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[al][bl];
}

// ── load registries + raw + config ────────────────────────────────────────────
const champions = await readJson<Record<string, Champion>>(join(DATA, "champions.json"));
const players = await readJson<Record<string, Player>>(join(DATA, "players.json"));
const fuses = await readJson<Record<string, Fuse>>(join(DATA, "fuses.json"));
const boundaries = await readJson<SeasonBoundary[]>(join(DATA, "seasonBoundaries.json"));
const overrides = await readJson<Record<string, Partial<VideoRecord>>>(join(DATA, "overrides.json"));
// CV fuse detections live in their own committed artifact (scripts/fuses.ts,
// local-only) so they survive the daily regeneration of videos.json.
const fusesDetected: Record<string, FuseDetection> = await readJson<Record<string, FuseDetection>>(
  join(DATA, "fuses-detected.json"),
).catch(() => ({}));

const rawRecords: RawVideoRecord[] = [];
for (const key of Object.keys(CHANNELS) as ChannelKey[]) {
  rawRecords.push(...(await readJson<RawVideoRecord[]>(join(RAW, `${key}.json`))));
}

// ── champion resolution ───────────────────────────────────────────────────────
const champByAlias = new Map<string, string>(); // aliasLower -> championId
const champAliases: { alias: string; id: string }[] = [];
for (const c of Object.values(champions)) {
  for (const a of new Set([c.name.toLowerCase(), ...c.aliases.map((x) => x.toLowerCase())])) {
    champByAlias.set(a, c.id);
    champAliases.push({ alias: a, id: c.id });
  }
}

interface CharResult {
  id: string | null;
  confidence: ParseConfidence; // "low" only when fuzzy/unresolved
  notes: string[]; // balance descriptors, e.g. ["nerfed"]
  raw: string;
}

function resolveChampion(rawToken: string): CharResult {
  const token = rawToken.trim();
  const lower = token.toLowerCase();

  // 1. exact alias / canonical name
  const exact = champByAlias.get(lower);
  if (exact) return { id: exact, confidence: "high", notes: [], raw: token };

  // 2. word-contains: a multi-word token carrying exactly one champion alias as a word
  //    e.g. "nerfed Ekko" → ekko (+ note "nerfed"), "adjusted Ahri" → ahri.
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length > 1) {
    const hits = uniq(words.map((w) => champByAlias.get(w)).filter((x): x is string => x != null));
    if (hits.length === 1) {
      const notes = words
        .filter((w) => !champByAlias.has(w))
        .filter((w) => w.length >= 3 && /^[a-z]+$/.test(w));
      return { id: hits[0], confidence: "high", notes, raw: token };
    }
  }

  // 3. fuzzy fallback: Damerau/OSA ≤ 1 (guard against short-token noise)
  if (lower.length >= 3) {
    let best: { id: string; dist: number } | null = null;
    for (const { alias, id } of champAliases) {
      if (alias.length < 3) continue;
      const dist = osaDistance(lower, alias);
      if (dist <= 1 && (best === null || dist < best.dist)) best = { id, dist };
    }
    if (best) return { id: best.id, confidence: "low", notes: [], raw: token };
  }

  // 4. unresolved
  return { id: null, confidence: "low", notes: [], raw: token };
}

// ── player resolution (with auto-discovery) ───────────────────────────────────
const playerByAlias = new Map<string, string>(); // aliasLower -> playerId
for (const p of Object.values(players)) {
  playerByAlias.set(p.displayName.toLowerCase(), p.id);
  for (const a of p.aliases) playerByAlias.set(a.toLowerCase(), p.id);
}

interface Discovered {
  id: string;
  displayNames: Map<string, number>; // raw casing -> count
  aliases: Set<string>; // lowercased variants
  count: number;
}
const discovered = new Map<string, Discovered>(); // keyed by slug
const usedIds = new Set<string>(Object.keys(players));
const bestDisplay = (d: Discovered): string =>
  [...d.displayNames.entries()].sort((a, b) => b[1] - a[1])[0][0];

function resolvePlayer(rawName: string): { id: string; displayName: string } {
  const name = rawName.trim();
  const lower = name.toLowerCase();

  const known = playerByAlias.get(lower);
  if (known) return { id: known, displayName: players[known].displayName };

  const slug = slugify(name) || "player";
  let entry = discovered.get(slug);
  if (!entry) {
    let id = slug;
    for (let n = 2; usedIds.has(id); n++) id = `${slug}-${n}`; // avoid colliding with seed ids
    usedIds.add(id);
    entry = { id, displayNames: new Map(), aliases: new Set(), count: 0 };
    discovered.set(slug, entry);
  }
  entry.count++;
  entry.aliases.add(lower);
  entry.displayNames.set(name, (entry.displayNames.get(name) ?? 0) + 1);
  return { id: entry.id, displayName: bestDisplay(entry) };
}

// ── metadata extraction ───────────────────────────────────────────────────────
function extractSeason(description: string, publishedAt: string): number | null {
  const paren = /\(Season\s*(\d+)\)/i.exec(description); // prefer explicit "(Season N)"
  if (paren) return Number(paren[1]);
  const bare = /Season\s*(\d+)/i.exec(description);
  if (bare) return Number(bare[1]);
  const day = publishedAt.slice(0, 10); // fallback: publish date vs boundaries
  for (const b of boundaries) {
    if (day >= b.start && (b.end === null || day < b.end)) return b.season;
  }
  return null;
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
function extractPatch(description: string): string | null {
  const m = /Patch\s*:\s*([^\n\r]+)/i.exec(description);
  if (!m) return null;
  const label = m[1].trim();
  const dm = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/.exec(label); // "12th May 2026"
  if (dm) {
    const mon = MONTHS[dm[2].toLowerCase()];
    if (mon !== undefined) {
      const d = new Date(Date.UTC(Number(dm[3]), mon, Number(dm[1])));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return label; // keep raw label when not a parseable date
}

// Fuse aliases → id, longest-first for greedy matching.
const fuseAliases: { alias: string; id: string }[] = [];
for (const f of Object.values(fuses)) {
  for (const a of new Set([f.name.toLowerCase(), ...f.aliases.map((x) => x.toLowerCase())])) {
    fuseAliases.push({ alias: a, id: f.id });
  }
}
fuseAliases.sort((a, b) => b.alias.length - a.alias.length);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Scan a per-team text segment for a fuse alias (accurate attribution, no guessing). */
function scanFuse(text: string): string | null {
  const lower = text.toLowerCase();
  for (const { alias, id } of fuseAliases) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(lower)) return id;
  }
  return null;
}

// Round / bracket tags (best-effort, from the raw title).
const ROUND_TAGS: [RegExp, string][] = [
  [/\bgrand\s*finals?\b/i, "grand-finals"],
  [/\bgf\b/i, "grand-finals"],
  [/\blosers?\s*finals?\b/i, "losers-final"],
  [/\bwinners?\s*finals?\b/i, "winners-final"],
  [/\bsemi[-\s]?finals?\b/i, "semifinals"],
  [/\btop\s*8\b/i, "top-8"],
  [/\btop\s*16\b/i, "top-16"],
  [/\bfirst\s*strike\b/i, "first-strike"],
];
function roundTags(title: string): string[] {
  return uniq(ROUND_TAGS.filter(([re]) => re.test(title)).map(([, t]) => t));
}

// ── title parsing ─────────────────────────────────────────────────────────────
const PREFIX = /^2XKO[^▰]*▰\s*/i; // widened (confirmed)
const SUFFIX = /\s*▰[^▰]*$/;
const TEAM_SPLIT = /^(.+?\([^)]*\))\s+vs\s+(.+\([^)]*\))$/i;
const TEAM_EXTRACT = /^(?<players>.*?)\s*\((?<chars>[^)]*)\)\s*$/;

interface ParsedTeam {
  playersRaw: string;
  charsRaw: string;
}
function parseTitle(rawTitle: string): { ok: true; teams: [ParsedTeam, ParsedTeam] } | { ok: false; stage: string } {
  let s = rawTitle.replace(/\s+/g, " ").trim(); // 1. normalize whitespace
  s = s.replace(PREFIX, ""); // 2. strip leading prefix
  s = s.replace(SUFFIX, "").trim(); // 3. strip trailing suffix
  const m = TEAM_SPLIT.exec(s); // 4. split teams (parens-anchored)
  if (!m) return { ok: false, stage: "team-split" };
  const teams: ParsedTeam[] = [];
  for (const seg of [m[1], m[2]]) {
    // 5. extract players + chars
    const tm = TEAM_EXTRACT.exec(seg);
    if (!tm?.groups) return { ok: false, stage: "team-extract" };
    teams.push({ playersRaw: tm.groups.players, charsRaw: tm.groups.chars });
  }
  return { ok: true, teams: teams as [ParsedTeam, ParsedTeam] };
}

// ── build one VideoRecord ─────────────────────────────────────────────────────
interface LowReason {
  id: string;
  channel: ChannelKey;
  title: string;
  reasons: string[];
}
const lowReports: LowReason[] = [];

function buildRecord(raw: RawVideoRecord): VideoRecord {
  const cfg = CHANNELS[raw.channel];
  const season = extractSeason(raw.description, raw.publishedAt);
  const patch = extractPatch(raw.description);
  const tags = new Set<string>(roundTags(raw.title));
  const reasons: string[] = [];

  const base = {
    id: raw.id,
    channel: raw.channel,
    channelName: cfg.name,
    title: raw.title,
    publishedAt: raw.publishedAt,
    thumbnail: raw.thumbnail,
    durationSec: raw.durationSec,
    viewCount: raw.viewCount,
    season,
    patch,
  };

  const parsed = parseTitle(raw.title);
  if (!parsed.ok) {
    reasons.push(`structural failure (${parsed.stage})`);
    lowReports.push({ id: raw.id, channel: raw.channel, title: raw.title, reasons });
    return {
      ...base,
      matchType: "ranked",
      teams: [],
      allCharacters: [],
      allPlayers: [],
      tags: [...tags].sort(),
      parseConfidence: "low",
      rawUnparsed: raw.title,
    };
  }

  const sides: TeamSide[] = ["left", "right"];
  const teams: Team[] = [];
  let confidence: ParseConfidence = "high";

  const rawSegments = [
    `${parsed.teams[0].playersRaw} (${parsed.teams[0].charsRaw})`,
    `${parsed.teams[1].playersRaw} (${parsed.teams[1].charsRaw})`,
  ];

  for (let i = 0; i < parsed.teams.length; i++) {
    const pt = parsed.teams[i];
    // characters
    const charTokens = pt.charsRaw.split(CHAR_SEP).map((x) => x.trim()).filter(Boolean);
    if (charTokens.length !== 2) {
      confidence = "low";
      reasons.push(`team ${sides[i]}: ${charTokens.length} character(s) (expected 2)`);
    }
    const characters: string[] = [];
    for (const tok of charTokens) {
      const r = resolveChampion(tok);
      if (r.id === null) {
        confidence = "low";
        reasons.push(`unresolved character "${tok}" on ${sides[i]}`);
        continue;
      }
      if (r.confidence === "low") {
        confidence = "low";
        reasons.push(`fuzzy character "${tok}" → ${r.id} on ${sides[i]}`);
      }
      for (const n of r.notes) tags.add(n);
      characters.push(r.id);
    }

    // players (unified separator — both channels mix " + " and spaced "-")
    const playerTokens = pt.playersRaw.split(PLAYER_SEP).map((x) => x.trim()).filter(Boolean);
    if (playerTokens.length === 0) {
      confidence = "low";
      reasons.push(`team ${sides[i]}: no players parsed`);
    }
    const teamPlayers = playerTokens.map((t) => resolvePlayer(t));

    teams.push({
      side: sides[i],
      players: teamPlayers,
      characters: uniq(characters),
      fuse: scanFuse(rawSegments[i]),
    });
  }

  // tags: mirror (both teams same 2-character set)
  if (teams[0].characters.length === 2 && teams[1].characters.length === 2) {
    if ([...teams[0].characters].sort().join("|") === [...teams[1].characters].sort().join("|")) {
      tags.add("mirror");
    }
  }

  // matchType
  const maxPlayers = Math.max(teams[0].players.length, teams[1].players.length);
  const matchType: MatchType =
    maxPlayers >= 2 ? "duo" : roundTags(raw.title).length > 0 ? "tournament" : "ranked";

  if (confidence === "low") {
    lowReports.push({ id: raw.id, channel: raw.channel, title: raw.title, reasons });
  }

  return {
    ...base,
    matchType,
    teams,
    allCharacters: uniq(teams.flatMap((t) => t.characters)),
    allPlayers: uniq(teams.flatMap((t) => t.players.map((p) => p.id))),
    tags: [...tags].sort(),
    parseConfidence: confidence,
    rawUnparsed: null,
  };
}

// ── stats ─────────────────────────────────────────────────────────────────────
function buildStats(records: VideoRecord[]): Stats {
  const stats: Stats = {
    characterUsage: {},
    pairingUsage: {},
    bySeasonUsage: {},
    totals: { videos: records.length, bySeason: {} },
    fuseUsage: {},
    fuseBySeason: {},
    playerCharacters: {},
    playerPairings: {},
    matchupMatrix: {},
  };
  for (const v of records) {
    for (const c of v.allCharacters) inc(stats.characterUsage, c); // per-video dedup
    // season === null → the pre-Season-0 "beta" era; timeline order is beta → 0 → 1 → 2
    const sk = v.season === null ? "beta" : String(v.season);
    inc(stats.totals.bySeason, sk);
    (stats.bySeasonUsage[sk] ??= {});
    for (const c of v.allCharacters) inc(stats.bySeasonUsage[sk], c);
    for (const t of v.teams) {
      if (t.fuse) {
        inc(stats.fuseUsage, t.fuse);
        (stats.fuseBySeason[sk] ??= {});
        inc(stats.fuseBySeason[sk], t.fuse);
      }
      const pairKey = t.characters.length === 2 ? [...t.characters].sort().join("|") : null;
      if (pairKey) inc(stats.pairingUsage, pairKey); // per team occurrence
      for (const p of t.players) {
        (stats.playerCharacters![p.id] ??= {});
        for (const c of t.characters) inc(stats.playerCharacters![p.id], c);
        if (pairKey) {
          (stats.playerPairings![p.id] ??= {});
          inc(stats.playerPairings![p.id], pairKey);
        }
      }
    }
    if (v.teams.length === 2 && v.teams.every((t) => t.characters.length === 2)) {
      const a = [...v.teams[0].characters].sort().join("|");
      const b = [...v.teams[1].characters].sort().join("|");
      (stats.matchupMatrix![a] ??= {});
      inc(stats.matchupMatrix![a], b);
      (stats.matchupMatrix![b] ??= {});
      inc(stats.matchupMatrix![b], a);
    }
  }
  return stats;
}

// Deterministic key ordering for stable diffs.
const sort1 = (o: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const sort2 = (o: Record<string, Record<string, number>>): Record<string, Record<string, number>> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort1(v)]));

// ── report.md ─────────────────────────────────────────────────────────────────
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();

function buildReport(records: VideoRecord[], counts: { seasonPct: string; patchPct: string; fusePct: string }): string {
  const total = records.length;
  const low = records.filter((r) => r.parseConfidence === "low").length;
  const newPlayers = [...discovered.values()].sort((a, b) => b.count - a.count);

  const lines: string[] = [];
  lines.push(`# 2XKO replay parse report`, ``, `_Generated ${new Date().toISOString()}._`, ``);
  lines.push(`## Summary`);
  lines.push(`- Total videos: **${total}**`);
  lines.push(`- High confidence: **${total - low}**  ·  Low confidence: **${low}**`);
  lines.push(`- Newly discovered players (auto-added to \`players.json\`): **${newPlayers.length}**`);
  lines.push(
    `- Fill rates — season: **${counts.seasonPct}%** · patch: **${counts.patchPct}%** · fuse: **${counts.fusePct}%**`,
    ``,
  );

  lines.push(`## Low-confidence records (${low})`);
  if (low === 0) {
    lines.push(`_None._`, ``);
  } else {
    lines.push(`| id | channel | reason | raw title |`, `|---|---|---|---|`);
    for (const r of lowReports) {
      lines.push(`| \`${r.id}\` | ${r.channel} | ${cell(r.reasons.join("; "))} | ${cell(r.title)} |`);
    }
    lines.push(``);
  }

  lines.push(`## Newly discovered players (${newPlayers.length})`);
  lines.push(`_Auto-added to \`data/players.json\` with a best-guess \`displayName\`. Fix casing / add aliases as needed._`, ``);
  if (newPlayers.length === 0) {
    lines.push(`_None._`, ``);
  } else {
    lines.push(`| slug | displayName | occurrences | aliases seen |`, `|---|---|---|---|`);
    for (const d of newPlayers) {
      lines.push(`| \`${d.id}\` | ${cell(bestDisplay(d))} | ${d.count} | ${cell([...d.aliases].sort().join(", "))} |`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

// ── main ──────────────────────────────────────────────────────────────────────
const baseRecords = rawRecords.map(buildRecord);

// Finalize discovered players into the registry (existing seed entries preserved).
for (const d of [...discovered.values()].sort((a, b) => b.count - a.count)) {
  players[d.id] = {
    id: d.id,
    displayName: bestDisplay(d),
    verified: false, // parser-discovered — not part of the curated seed roster
    aliases: [...d.aliases].sort(),
    region: null,
    socials: {},
  };
}

// Normalize embedded player displayNames to the final canonical value — discovery
// merges casing variants as it goes, so records built early held stale snapshots —
// then apply overrides.json LAST as a shallow merge.
const records: VideoRecord[] = baseRecords.map((rec) => {
  const teams = rec.teams.map((t) => ({
    ...t,
    players: t.players.map((p) => ({ id: p.id, displayName: players[p.id]?.displayName ?? p.displayName })),
  }));
  let merged: VideoRecord = { ...rec, teams };
  // fuse merge: only confident detections set teams[].fuse ("low"/"none" stay
  // null); ok-unordered pairs are flagged — filters/stats are order-agnostic,
  // the modal shows the pair unattributed.
  const det = fusesDetected[rec.id];
  if (det && (det.status === "ok" || det.status === "ok-unordered") && merged.teams.length === 2) {
    merged = {
      ...merged,
      teams: [
        { ...merged.teams[0], fuse: det.left },
        { ...merged.teams[1], fuse: det.right },
      ],
      ...(det.status === "ok-unordered" ? { fusesUnordered: true } : {}),
    };
  }
  // overrides.json last — a manual fuse override beats detection
  const ov = overrides[rec.id];
  return ov ? { ...merged, ...ov } : merged;
});

const total = records.length;
const seasonFilled = records.filter((r) => r.season !== null).length;
const patchFilled = records.filter((r) => r.patch !== null).length;
const fuseFilled = records.filter((r) => r.teams.some((t) => t.fuse !== null)).length;
const pctOf = (n: number) => (total === 0 ? "0.0" : ((n / total) * 100).toFixed(1));
const counts = { seasonPct: pctOf(seasonFilled), patchPct: pctOf(patchFilled), fusePct: pctOf(fuseFilled) };

const stats = buildStats(records);
const statsOut: Stats = {
  characterUsage: sort1(stats.characterUsage),
  pairingUsage: sort1(stats.pairingUsage),
  bySeasonUsage: sort2(stats.bySeasonUsage),
  totals: { videos: stats.totals.videos, bySeason: sort1(stats.totals.bySeason) },
  fuseUsage: sort1(stats.fuseUsage),
  fuseBySeason: sort2(stats.fuseBySeason),
  playerCharacters: sort2(stats.playerCharacters!),
  playerPairings: sort2(stats.playerPairings!),
  matchupMatrix: sort2(stats.matchupMatrix!),
};

await writeFile(join(DATA, "videos.json"), JSON.stringify(records, null, 2) + "\n", "utf8");
await writeFile(join(DATA, "stats.json"), JSON.stringify(statsOut, null, 2) + "\n", "utf8");
await writeFile(join(DATA, "players.json"), JSON.stringify(players, null, 2) + "\n", "utf8");
await writeFile(join(DATA, "report.md"), buildReport(records, counts), "utf8");

const low = records.filter((r) => r.parseConfidence === "low").length;
console.log(`✔ Parsed ${total} videos → data/videos.json`);
console.log(`  high-confidence: ${total - low}   low-confidence: ${low}`);
console.log(`  newly discovered players: ${discovered.size}  (players.json now ${Object.keys(players).length} total)`);
console.log(`  fill rates → season ${counts.seasonPct}%  ·  patch ${counts.patchPct}%  ·  fuse ${counts.fusePct}%`);
console.log(`  wrote data/stats.json, data/report.md`);

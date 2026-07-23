// MIGRATION REPORT (read-only): how many committed videos change season under
// the boundary-only derivation (patchBoundaries.json era) vs the shipped
// explicit-first logic already baked into data/videos.json. Writes NOTHING —
// run BEFORE `npm run data:parse` regenerates the substrate, and stop for
// review when the changed count exceeds the ~20 gate (exit 1).
//
// New rule per record:
//   overrides.json season → wins (explicit)
//   manual entry season   → wins (explicit)
//   otherwise             → seasonForDate(publishedAt) — the description
//                           "(Season N)" regex no longer derives anything
//
// Run: npx tsx scripts/season-migration-report.ts   (or npm run data:migration-report)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatchTable } from './patches';
import type { ManualVideosFile, VideoRecord } from '../types/index';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(DATA, p), 'utf8')) as T;

const GATE = 20;

const videos = readJson<VideoRecord[]>('videos.json');
const overrides = readJson<Record<string, Partial<VideoRecord>>>('overrides.json');
const manualSeasons = new Map(
  (readJson<ManualVideosFile>('manual-videos.json').videos ?? [])
    .filter((e) => e.season !== undefined)
    .map((e) => [e.id, e.season as number | null]),
);
const table = loadPatchTable(DATA);

const label = (s: number | null): string => (s === null ? 'Beta' : `S${s}`);
const newSeason = (v: VideoRecord): number | null => {
  const ov = overrides[v.id];
  if (ov && 'season' in ov) return ov.season ?? null;
  if (manualSeasons.has(v.id)) return manualSeasons.get(v.id) ?? null;
  return table.seasonForDate(v.publishedAt);
};

const changed = videos
  .map((v) => ({ v, oldS: v.season, newS: newSeason(v) }))
  .filter(({ oldS, newS }) => oldS !== newS);

const dist = (get: (v: VideoRecord) => number | null): string => {
  const acc = new Map<string, number>();
  for (const v of videos) acc.set(label(get(v)), (acc.get(label(get(v))) ?? 0) + 1);
  return [...acc.entries()]
    .sort(([a], [b]) => (a === 'Beta' ? -1 : b === 'Beta' ? 1 : a.localeCompare(b)))
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
};

console.log(`# Season migration report (${videos.length} committed videos)\n`);
console.log(`Old (explicit-first): ${dist((v) => v.season)}`);
console.log(`New (boundary-only):  ${dist(newSeason)}\n`);
console.log(`Videos changing season: ${changed.length}\n`);
if (changed.length > 0) {
  console.log(`| id | published | old | new | title |`);
  console.log(`|---|---|---|---|---|`);
  for (const { v, oldS, newS } of changed) {
    const title = v.title.replace(/\|/g, '\\|').slice(0, 90);
    console.log(
      `| ${v.id} | ${v.publishedAt.slice(0, 10)} | ${label(oldS)} | ${label(newS)} | ${title} |`,
    );
  }
  console.log();
}

if (changed.length > GATE) {
  console.error(
    `✖ ${changed.length} re-buckets exceeds the ~${GATE} review gate — STOP: review the table above before regenerating.`,
  );
  process.exit(1);
}
console.log(`✔ within the ~${GATE} review gate`);

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fuse, FuseGapReport, Team, VideoRecord } from '~~/types';

// Dev-only: persists hand-adjudicated fuses from /dev/fuse-review into
// data/overrides.json, on exactly the contract --promote-lows writes: one fuse
// id per TITLE-ordered team, a side the reviewer could not read stays null, and
// `fusesUnordered` marks a pair whose owning teams they could not tell apart.
//
// Only ids in the current gap report are writable (same guard as the orient
// queue), fuse ids are checked against the registry, and re-saving an id
// overwrites its verdict. A verdict with both sides null CLEARS the id: the
// entry is deleted outright when this tool authored it, and reduced to null
// fuses when it also carries a title-parse correction worth keeping.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });

  const body = await readBody<{ entries?: unknown }>(event);
  if (!Array.isArray(body?.entries)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'expected { entries: [{ id, fuses: [id|null, id|null], unordered? }] }',
    });
  }

  const root = process.cwd();
  const gapsPath = join(root, 'cache/fuse/review/fuse-gaps.json');
  if (!existsSync(gapsPath))
    throw createError({ statusCode: 404, statusMessage: 'fuse-gaps.json not found' });
  const reviewable = new Set(
    (JSON.parse(readFileSync(gapsPath, 'utf8')) as FuseGapReport).items.map((i) => i.id),
  );
  const videos = JSON.parse(readFileSync(join(root, 'data/videos.json'), 'utf8')) as VideoRecord[];
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const registry = JSON.parse(readFileSync(join(root, 'data/fuses.json'), 'utf8')) as Record<
    string,
    Fuse
  >;
  const ovPath = join(root, 'data/overrides.json');
  const overrides = JSON.parse(readFileSync(ovPath, 'utf8')) as Record<
    string,
    Partial<VideoRecord>
  >;

  /** teams stripped of fuses — the shape an override shares with its parse */
  const skeleton = (teams: Team[]) => JSON.stringify(teams.map((t) => ({ ...t, fuse: null })));

  let written = 0;
  let cleared = 0;
  const rejected: { id: string; reason: string }[] = [];
  /** ids to drop from the file entirely — filtered out at write time */
  const dropped = new Set<string>();

  for (const raw of body.entries) {
    const entry = raw as { id?: unknown; fuses?: unknown; unordered?: unknown };
    const id = typeof entry.id === 'string' ? entry.id : '';
    const video = videoById.get(id);
    const fuses = entry.fuses;
    const unordered = entry.unordered === true;

    if (!reviewable.has(id)) {
      rejected.push({ id: String(entry.id), reason: 'not in the current gap report' });
      continue;
    }
    if (!video || video.teams.length !== 2) {
      rejected.push({ id, reason: 'record does not have exactly 2 parsed teams' });
      continue;
    }
    if (
      !Array.isArray(fuses) ||
      fuses.length !== 2 ||
      !fuses.every((f) => f === null || (typeof f === 'string' && !!registry[f]))
    ) {
      rejected.push({ id, reason: 'fuses must be [id|null, id|null] of known fuse ids' });
      continue;
    }
    const pair = fuses as [string | null, string | null];
    // "pair known, sides unknown" is only meaningful with both sides filled —
    // a single unattributed fuse carries no information about who owns it
    if (unordered && (!pair[0] || !pair[1])) {
      rejected.push({ id, reason: 'unordered needs a fuse on both sides' });
      continue;
    }

    const base = overrides[id];
    const baseTeams = base?.teams ?? video.teams;

    if (!pair[0] && !pair[1]) {
      const fuseOnly =
        !!base &&
        Object.keys(base).every((k) => k === 'teams' || k === 'fusesUnordered') &&
        skeleton(baseTeams) === skeleton(video.teams);
      if (!base) continue; // nothing to clear
      if (fuseOnly) dropped.add(id);
      else overrides[id] = { ...base, teams: baseTeams.map((t) => ({ ...t, fuse: null })) };
      cleared++;
      continue;
    }

    dropped.delete(id);
    overrides[id] = {
      ...base,
      teams: baseTeams.map((t, i) => ({ ...t, fuse: pair[i] ?? null })),
      fusesUnordered: unordered,
    };
    written++;
  }

  if (written > 0 || cleared > 0) {
    const next = Object.fromEntries(Object.entries(overrides).filter(([id]) => !dropped.has(id)));
    writeFileSync(ovPath, JSON.stringify(next, null, 2) + '\n');
  }
  return { written, cleared, rejected };
});

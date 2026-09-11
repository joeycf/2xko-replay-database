import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fuse, FuseGapReport, Team, TeamSide, UnreadableVerdict, VideoRecord } from '~~/types';

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
//
// UNREADABLE IS NOT A CLEAR, and telling them apart is the whole point of the
// `unreadable` field. Clearing says "forget I said anything" and hands the
// record back to the queue. Unreadable says "I looked at this pill and it cannot
// be read" — a finding, and the only thing that stops the record coming back
// forever wearing the same face as one nobody ever opened. Deleting the entry on
// a both-null save is exactly how that used to happen.
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
    Partial<VideoRecord> & { unreadable?: UnreadableVerdict }
  >;
  const nowIso = new Date().toISOString();

  /** teams stripped of fuses — the shape an override shares with its parse */
  const skeleton = (teams: Team[]) => JSON.stringify(teams.map((t) => ({ ...t, fuse: null })));

  let written = 0;
  let cleared = 0;
  let negative = 0;
  const rejected: { id: string; reason: string }[] = [];
  /** ids to drop from the file entirely — filtered out at write time */
  const dropped = new Set<string>();

  for (const raw of body.entries) {
    const entry = raw as {
      id?: unknown;
      fuses?: unknown;
      unordered?: unknown;
      unreadable?: unknown;
    };
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
    const sidesOf = (v: unknown): TeamSide[] =>
      Array.isArray(v) ? (v.filter((x) => x === 'left' || x === 'right') as TeamSide[]) : [];
    // A side cannot be both read and unreadable; the read wins, since it is the
    // more specific claim and the reviewer just made it.
    const unreadableSides = sidesOf(entry.unreadable).filter(
      (side) => !pair[video.teams.findIndex((t) => t.side === side)],
    );
    // "pair known, sides unknown" is only meaningful with both sides filled —
    // a single unattributed fuse carries no information about who owns it
    if (unordered && (!pair[0] || !pair[1])) {
      rejected.push({ id, reason: 'unordered needs a fuse on both sides' });
      continue;
    }

    const base = overrides[id];
    const baseTeams = base?.teams ?? video.teams;

    if (!pair[0] && !pair[1]) {
      // Both sides unread, but the reviewer said WHY for at least one of them.
      // That is a verdict and it has to persist — deleting the entry here is
      // precisely what put these records back in the queue, indistinguishable
      // from ones nobody had opened.
      if (unreadableSides.length) {
        dropped.delete(id);
        overrides[id] = {
          ...base,
          teams: baseTeams.map((t) => ({ ...t, fuse: null })),
          unreadable: { ...(base?.unreadable ?? {}), fuse: unreadableSides, at: nowIso },
        };
        negative++;
        continue;
      }
      const fuseOnly =
        !!base &&
        Object.keys(base).every(
          (k) => k === 'teams' || k === 'fusesUnordered' || k === 'unreadable',
        ) &&
        skeleton(baseTeams) === skeleton(video.teams);
      if (!base) continue; // nothing to clear
      if (fuseOnly) dropped.add(id);
      else {
        // A real clear also retracts any standing unreadable verdict — the
        // reviewer is saying they know nothing about this record now.
        const { unreadable: _retracted, ...rest } = base;
        overrides[id] = { ...rest, teams: baseTeams.map((t) => ({ ...t, fuse: null })) };
      }
      cleared++;
      continue;
    }

    dropped.delete(id);
    // A side that just received a fuse is no longer unreadable; when that empties
    // the object, the key goes with it rather than lingering as `{}`.
    const standing = (base?.unreadable?.fuse ?? []).filter(
      (side) => !pair[video.teams.findIndex((t) => t.side === side)],
    );
    const stillUnreadable = [...new Set([...standing, ...unreadableSides])];
    const { unreadable: _prev, ...keep } = base ?? {};
    overrides[id] = {
      ...keep,
      teams: baseTeams.map((t, i) => ({ ...t, fuse: pair[i] ?? null })),
      fusesUnordered: unordered,
      ...(stillUnreadable.length
        ? { unreadable: { ...(base?.unreadable ?? {}), fuse: stillUnreadable, at: nowIso } }
        : {}),
    };
    written++;
  }

  if (written > 0 || cleared > 0 || negative > 0) {
    const next = Object.fromEntries(Object.entries(overrides).filter(([id]) => !dropped.has(id)));
    writeFileSync(ovPath, JSON.stringify(next, null, 2) + '\n');
  }
  return { written, cleared, negative, rejected };
});

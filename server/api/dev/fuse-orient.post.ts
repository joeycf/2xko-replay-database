import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FuseOrientQueue, UnreadableVerdict, VideoRecord } from '~~/types';

// Dev-only: applies the user's orientation assignments from /dev/fuse-orient.
// Each assignment says which TITLE team owns the queue item's already-settled
// fuse; the override mirrors the --promote-lows single-side form (other team
// stays null). Only ids present in the queue are writable, and re-saving an id
// overwrites its previous assignment.
//
// `owner: 'unreadable'` IS THE THIRD ANSWER. "Which team owns this pill" has
// always had one the form could not express — nothing in frame attributes it —
// and a reviewer who reached that conclusion had no way to record it, so the row
// returned on every run. It writes the marker ONLY and leaves teams alone: the
// pair itself is a good read that --promote-lows already placed, and overwriting
// it with nulls would discard a fact to record the absence of another.
//
// A settled id is also PRUNED from the queue file here. Nothing else ever did:
// only --promote-lows writes that file, so it sat unchanged from 2026-07-10 with
// all ten of its rows long since adjudicated.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const body = await readBody<{
    assignments?: { id?: unknown; owner?: unknown; note?: unknown }[];
  }>(event);
  if (!Array.isArray(body?.assignments)) {
    throw createError({
      statusCode: 400,
      statusMessage: "expected { assignments: [{ id, owner: 0|1|'unreadable' }] }",
    });
  }

  const root = process.cwd();
  const queuePath = join(root, 'cache/fuse/review/orient-queue.json');
  if (!existsSync(queuePath))
    throw createError({ statusCode: 404, statusMessage: 'orient-queue.json not found' });
  const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as FuseOrientQueue;
  const byQueueId = new Map(queue.items.map((i) => [i.id, i]));
  const videos = JSON.parse(readFileSync(join(root, 'data/videos.json'), 'utf8')) as VideoRecord[];
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const ovPath = join(root, 'data/overrides.json');
  const overrides = JSON.parse(readFileSync(ovPath, 'utf8')) as Record<
    string,
    Partial<VideoRecord> & { unreadable?: UnreadableVerdict }
  >;
  const nowIso = new Date().toISOString();

  let written = 0;
  let negative = 0;
  const settled = new Set<string>();
  const rejected: string[] = [];
  for (const a of body.assignments) {
    const item = typeof a.id === 'string' ? byQueueId.get(a.id) : undefined;
    const video = item ? videoById.get(item.id) : undefined;
    const owner = a.owner;
    const isOwner = owner === 0 || owner === 1;
    if (!item || !video || video.teams.length !== 2 || (!isOwner && owner !== 'unreadable')) {
      rejected.push(String(a.id));
      continue;
    }
    if (owner === 'unreadable') {
      overrides[item.id] = {
        ...overrides[item.id],
        unreadable: {
          ...(overrides[item.id]?.unreadable ?? {}),
          fuseOwner: true,
          ...(typeof a.note === 'string' && a.note.trim() ? { '//': a.note.trim() } : {}),
          at: nowIso,
        },
      };
      negative++;
      settled.add(item.id);
      continue;
    }
    const { unreadable: _resolvedNow, ...keep } = overrides[item.id] ?? {};
    overrides[item.id] = {
      ...keep,
      teams: video.teams.map((t, i) => ({ ...t, fuse: i === owner ? item.fuse : null })),
      fusesUnordered: false,
    };
    written++;
    settled.add(item.id);
  }
  if (written > 0 || negative > 0) {
    writeFileSync(ovPath, JSON.stringify(overrides, null, 2) + '\n');
    // Prune what we just settled. The file is a gitignored cache artifact and
    // --promote-lows rebuilds it from scratch, so shrinking it loses nothing and
    // stops the queue advertising work that is done.
    const remaining = queue.items.filter((i) => !settled.has(i.id));
    if (remaining.length !== queue.items.length) {
      writeFileSync(queuePath, JSON.stringify({ ...queue, items: remaining }, null, 2) + '\n');
    }
  }
  return { written, negative, rejected };
});

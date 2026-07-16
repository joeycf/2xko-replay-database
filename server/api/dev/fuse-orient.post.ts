import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FuseOrientQueue, VideoRecord } from '~~/types';

// Dev-only: applies the user's orientation assignments from /dev/fuse-orient.
// Each assignment says which TITLE team owns the queue item's already-settled
// fuse; the override mirrors the --promote-lows single-side form (other team
// stays null). Only ids present in the queue are writable, and re-saving an id
// overwrites its previous assignment.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const body = await readBody<{ assignments?: { id?: unknown; owner?: unknown }[] }>(event);
  if (!Array.isArray(body?.assignments)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'expected { assignments: [{ id, owner: 0|1 }] }',
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
    Partial<VideoRecord>
  >;

  let written = 0;
  const rejected: string[] = [];
  for (const a of body.assignments) {
    const item = typeof a.id === 'string' ? byQueueId.get(a.id) : undefined;
    const video = item ? videoById.get(item.id) : undefined;
    if (!item || !video || video.teams.length !== 2 || (a.owner !== 0 && a.owner !== 1)) {
      rejected.push(String(a.id));
      continue;
    }
    const owner = a.owner;
    overrides[item.id] = {
      teams: video.teams.map((t, i) => ({ ...t, fuse: i === owner ? item.fuse : null })),
      fusesUnordered: false,
    };
    written++;
  }
  if (written > 0) writeFileSync(ovPath, JSON.stringify(overrides, null, 2) + '\n');
  return { written, rejected };
});

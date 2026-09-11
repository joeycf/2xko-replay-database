import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { partitionReviewQueue } from '@engine/server/utils/reviewQueue';
import type { ReviewState } from '@engine/types';
import type { FuseOrientItem, FuseOrientQueue, UnreadableVerdict, VideoRecord } from '~~/types';
import type { FuseOrientReviewQueue } from '~~/types/review';

// Dev-only: serves the orientation-adjudication queue written by
// `npm run data:fuses -- --promote-lows`, partitioned into what is still open
// and what has been settled.
//
// THE QUEUE FILE ROTS ON ITS OWN, which is why the partition is not optional
// here. Only --promote-lows ever writes orient-queue.json, and the POST that
// records a verdict never pruned it, so the file sat unchanged from 2026-07-10
// while every one of its 10 rows was adjudicated. The page then showed "10 / 10
// assigned" and still listed all ten as work. The POST now prunes what it
// settles; this route makes a stale file harmless either way.
export default defineEventHandler((): FuseOrientReviewQueue => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const queuePath = join(process.cwd(), 'cache/fuse/review/orient-queue.json');
  if (!existsSync(queuePath)) {
    throw createError({
      statusCode: 404,
      statusMessage:
        'orient-queue.json not found — run `npm run data:fuses -- --promote-lows` first',
    });
  }
  const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as FuseOrientQueue;
  const overrides = JSON.parse(
    readFileSync(join(process.cwd(), 'data/overrides.json'), 'utf8'),
  ) as Record<string, Partial<VideoRecord> & { unreadable?: UnreadableVerdict }>;

  const assigned: Record<string, number> = {};
  for (const item of queue.items) {
    const owner = overrides[item.id]?.teams?.findIndex((t) => t.fuse === item.fuse) ?? -1;
    if (owner >= 0) assigned[item.id] = owner;
  }

  // Three outcomes, where the queue could previously express two. "Which side
  // owns this pill" has a real third answer — nothing in frame attributes it —
  // and without a way to record that, the row came back forever.
  const resolutionOf = (item: FuseOrientItem): ReviewState => {
    const ov = overrides[item.id];
    if (ov?.unreadable?.fuseOwner)
      return { resolution: 'negative', reason: ov.unreadable['//'], at: ov.unreadable.at };
    return assigned[item.id] === undefined ? { resolution: 'pending' } : { resolution: 'resolved' };
  };

  return {
    ...partitionReviewQueue(queue.items, resolutionOf, { generatedAt: queue.generatedAt }),
    assigned,
  };
});

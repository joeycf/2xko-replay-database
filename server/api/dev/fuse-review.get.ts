import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { partitionReviewQueue } from '@engine/server/utils/reviewQueue';
import type { ReviewState } from '@engine/types';
import type { FuseGapReport, FuseReviewItem, UnreadableVerdict, VideoRecord } from '~~/types';
import type { FuseReviewQueue } from '~~/types/review';

// Dev-only: the manual fuse worklist behind /dev/fuse-review. Joins the gap
// report with the parsed record, the detector's rejected read and whatever
// overrides.json already says, so the page ships one small payload instead of
// all 2.9k videos.json records. Items without cached frames are dropped —
// there is nothing to look at, so they are download work, not review work.
// Read-only; the sibling POST route is what writes.
export default defineEventHandler(() => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });

  const root = process.cwd();
  const gapsPath = join(root, 'cache/fuse/review/fuse-gaps.json');
  if (!existsSync(gapsPath)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'fuse-gaps.json not found — run `npm run data:fuse-gaps` first',
    });
  }
  const report = JSON.parse(readFileSync(gapsPath, 'utf8')) as FuseGapReport;
  const videos = JSON.parse(readFileSync(join(root, 'data/videos.json'), 'utf8')) as VideoRecord[];
  const byId = new Map(videos.map((v) => [v.id, v]));
  const overrides = JSON.parse(readFileSync(join(root, 'data/overrides.json'), 'utf8')) as Record<
    string,
    Partial<VideoRecord> & { unreadable?: UnreadableVerdict }
  >;

  const items: FuseReviewItem[] = [];
  for (const gap of report.items) {
    const video = byId.get(gap.id);
    // a verdict is expressed as one fuse per title-team, so a record that did
    // not parse into exactly 2 teams is a title-parse fix, not fuse work
    if (gap.frames < 1 || !video || video.teams.length !== 2) continue;
    // an override may already carry corrected teams — read the verdict off it
    const teams = overrides[gap.id]?.teams ?? video.teams;
    const saved = overrides[gap.id]?.teams
      ? {
          fuses: [teams[0]?.fuse ?? null, teams[1]?.fuse ?? null] as [string | null, string | null],
          unordered: !!overrides[gap.id]?.fusesUnordered,
        }
      : null;
    items.push({
      id: gap.id,
      bucket: gap.bucket,
      era: gap.era,
      publishedAt: gap.publishedAt,
      season: video.season,
      title: video.title,
      channelName: video.channelName,
      frames: gap.frames,
      teams,
      detection: gap.detection ?? null,
      saved: saved?.fuses.some((f) => f) ? saved : null,
      // Carried separately from `saved`, because it answers a different question:
      // `saved.fuses[i] === null` means nobody has looked, this means somebody
      // did and the pill cannot be read.
      unreadable: overrides[gap.id]?.unreadable?.fuse ?? [],
    });
  }

  // A SAVED ROW LEAVES THE LIST NOW, not after two script runs. The gap report
  // only learns about a verdict once data:parse republishes videos.json and
  // data:fuse-gaps rebuilds — until then every saved item sat in the queue
  // looking exactly like untouched work. The predicate reads overrides.json,
  // which is the file the save writes, so the row clears on the next request.
  //
  // Deliberately NOT videos.json: that is the published record, rebuilt by the
  // pipeline, and asking it turns a fresh verdict invisible.
  const resolutionOf = (item: FuseReviewItem): ReviewState => {
    const ov = overrides[item.id];
    const unreadable = new Set(ov?.unreadable?.fuse ?? []);
    const teams = ov?.teams ?? item.teams;
    const settled = teams.every((t) => !!t.fuse || unreadable.has(t.side));
    if (!settled) return { resolution: 'pending' };
    return unreadable.size
      ? { resolution: 'negative', reason: ov?.unreadable?.['//'], at: ov?.unreadable?.at }
      : { resolution: 'resolved' };
  };

  return partitionReviewQueue(items, resolutionOf, {
    generatedAt: report.generatedAt,
  }) satisfies FuseReviewQueue;
});

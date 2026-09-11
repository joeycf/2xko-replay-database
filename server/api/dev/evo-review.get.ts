import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvoReviewItem, EvoReviewQueue, FootageQueue, VideoRecord } from '~~/types';

interface Extraction {
  id: string;
  title: string;
  left: {
    characters: string[];
    confidence: number;
    dropped: { char: string; frames: number }[];
    read: number;
    sampled: number;
  };
  right: {
    characters: string[];
    confidence: number;
    dropped: { char: string; frames: number }[];
    read: number;
    sampled: number;
  };
  side: { leftIsFirst: boolean; decided: boolean };
  confidence: number;
}

// Dev-only worklist for /dev/evo-review: every footage-channel record, with the
// extractor's proposal beside the verdict already in data/overrides.json.
//
// THE WORKLIST IS THE PIPELINE'S QUEUE, NOT THE EXTRACTION. A video whose
// extraction failed outright is precisely the one a human most needs to see —
// half this corpus is Evo Las Vegas, whose Latin display face defeats OCR — so
// keying the queue on extracted.json would hide exactly the work. The extraction
// is a join, and its absence is a state the page renders rather than a reason to
// drop a row.
//
// IT USED TO READ THE EVO ENTRIES IN data/manual-videos.json. Those records moved
// onto a tracked channel in 4a0a591 and the file has held no Evo row since, so
// this page rendered an empty queue for a month while looking perfectly healthy —
// the failure mode of a lookup that is wrong rather than broken. cache/evo/
// footage-queue.json is written by data:parse, the only stage that knows which
// records are still missing champions.
export default defineEventHandler((): EvoReviewQueue => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const root = process.cwd();

  const queuePath = join(root, 'cache/evo/footage-queue.json');
  if (!existsSync(queuePath)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'footage-queue.json not found — run `npm run data:parse` first',
    });
  }
  const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as FootageQueue;

  // The verdict itself. Champions on a footage channel are published from an
  // override, so this is where a saved answer lives — the same file the fuse
  // workbench writes, and the same one parse.ts merges last.
  const overrides = JSON.parse(readFileSync(join(root, 'data/overrides.json'), 'utf8')) as Record<
    string,
    Partial<VideoRecord>
  >;

  // Human fuse verdicts live in their own committed artifact, mirroring
  // data/fuse-validation.json — a CONFIRMATION is a datum even when it changes
  // no record, and the record itself has nowhere to put one.
  const vePath = join(root, 'data/fuse-validation-evo.json');
  const validated = existsSync(vePath)
    ? (JSON.parse(readFileSync(vePath, 'utf8')) as Record<
        string,
        { left?: string | null; right?: string | null }
      >)
    : {};

  const extractPath = join(root, 'cache/evo/extracted.json');
  const extractions = new Map<string, Extraction>(
    existsSync(extractPath)
      ? (JSON.parse(readFileSync(extractPath, 'utf8')) as Extraction[]).map((e) => [e.id, e])
      : [],
  );

  const framesOf = (id: string): string[] => {
    const dir = join(root, 'cache/evo/frames', id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.slice(0, -4))
      .sort();
  };

  const items: EvoReviewItem[] = queue.items.map((v) => {
    const e = extractions.get(v.id);
    // The queue's teams are already the merged record — override applied — so the
    // saved verdict reads off them rather than off overrides.json a second time.
    const sides = v.teams.map((t) => [...t.characters]) as [string[], string[]];
    const label = v.tournament ?? v.title;
    return {
      id: v.id,
      title: v.title,
      tournament: v.tournament ?? v.channelName,
      ...(v.round ? { round: v.round } : {}),
      durationSec: v.durationSec,
      frames: framesOf(v.id),
      // Evo Japan renders katakana and Las Vegas renders Latin; a reviewer facing
      // a blank proposal needs to know which, because on the Latin half a blank
      // is the known reader limit and on the katakana half it is a real anomaly.
      // Read off the event label when there is one and the title otherwise —
      // this channel names the event in both.
      script: /Japan/i.test(label) ? 'katakana' : 'latin',
      proposal: e
        ? {
            left: e.left,
            right: e.right,
            leftIsFirst: e.side.leftIsFirst,
            decided: e.side.decided,
            confidence: e.confidence,
          }
        : null,
      saved: [sides[0] ?? [], sides[1] ?? []],
      savedFuses: [v.teams[0]?.fuse ?? null, v.teams[1]?.fuse ?? null] as [
        string | null,
        string | null,
      ],
      validatedFuses: [validated[v.id]?.left, validated[v.id]?.right] as [
        string | null | undefined,
        string | null | undefined,
      ],
      players: [
        (v.teams[0]?.players ?? []).map((p) => p.displayName),
        (v.teams[1]?.players ?? []).map((p) => p.displayName),
      ] as [string[], string[]],
      // A record the gate is still withholding — the page's open work. Carries
      // the reason so an empty queue and a settled one never read alike.
      held: !v.settled,
      curated: !!overrides[v.id],
    };
  });

  return { generatedAt: queue.generatedAt, items };
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvoReviewItem, EvoReviewQueue, ManualVideosFile } from '~~/types';

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

// Dev-only worklist for /dev/evo-review: every Evo VOD, with the extractor's
// proposal beside the verdict already in data/manual-videos.json.
//
// THE WORKLIST IS THE MANUAL FILE, NOT THE EXTRACTION. A video whose extraction
// failed outright is precisely the one a human most needs to see — half this
// corpus is Evo Las Vegas, whose Latin display face defeats OCR — so keying the
// queue on extracted.json would hide exactly the work. The extraction is a join,
// and its absence is a state the page renders rather than a reason to drop a row.
export default defineEventHandler((): EvoReviewQueue => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const root = process.cwd();

  const file = JSON.parse(
    readFileSync(join(root, 'data/manual-videos.json'), 'utf8'),
  ) as ManualVideosFile;
  const evo = (file.videos ?? []).filter((v) => /Evo/i.test(v.tournament ?? ''));

  // Human fuse verdicts live in their own committed artifact, mirroring
  // data/fuse-validation.json — a CONFIRMATION is a datum even when it changes
  // no record, and manual-videos.json has nowhere to put one.
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

  const items: EvoReviewItem[] = evo.map((v) => {
    const e = extractions.get(v.id);
    const sides = (v.teams ?? []).map((t) => [...(t.characters ?? [])]) as [string[], string[]];
    return {
      id: v.id,
      title: v.title ?? v.id,
      tournament: v.tournament ?? '',
      ...(v.round ? { round: v.round } : {}),
      durationSec: v.durationSec ?? 0,
      frames: framesOf(v.id),
      // Evo Japan renders katakana and Las Vegas renders Latin; a reviewer facing
      // a blank proposal needs to know which, because on the Latin half a blank
      // is the known reader limit and on the katakana half it is a real anomaly.
      script: /Japan/i.test(v.tournament ?? '') ? 'katakana' : 'latin',
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
      savedFuses: [v.teams?.[0]?.fuse ?? null, v.teams?.[1]?.fuse ?? null] as [
        string | null,
        string | null,
      ],
      validatedFuses: [validated[v.id]?.left, validated[v.id]?.right] as [
        string | null | undefined,
        string | null | undefined,
      ],
      players: [
        (v.teams?.[0]?.players ?? []).map(String),
        (v.teams?.[1]?.players ?? []).map(String),
      ] as [string[], string[]],
      todo: v.todo ?? null,
    };
  });

  return { generatedAt: new Date().toISOString(), items };
});

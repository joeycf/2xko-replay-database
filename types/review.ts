/**
 * Dev review-queue payloads — APP ONLY.
 *
 * These speak the engine's v0.14.0 review-queue contract (`items` is the open
 * work, `resolved` carries the settled rows, `counts` is what the /dev index
 * reads), so every game's tools answer "what is still open?" the same way.
 *
 * They live apart from types/index.ts because that barrel is also compiled by
 * the pipeline's plain tsc project, which resolves no `@engine` alias — and
 * should not, since the data pipeline runs in CI without the layer on disk.
 */
import type { ReviewQueue } from '@engine/types';
import type { EvoReviewItem, FuseOrientItem, FuseReviewItem } from './index';

/** Payload of /api/dev/fuse-review. `generatedAt` is the gap report's stamp. */
export type FuseReviewQueue = ReviewQueue<FuseReviewItem>;

/** Payload of /api/dev/evo-review. */
export type EvoReviewQueue = ReviewQueue<EvoReviewItem>;

/** Payload of /api/dev/fuse-orient.
 *
 * `assigned` maps id → the title-team index that owns the pill, for rows a human
 * has already settled; it is carried for the resolved view rather than as the
 * signal of what is open, which is now `items` itself.
 */
export type FuseOrientReviewQueue = ReviewQueue<FuseOrientItem> & {
  assigned: Record<string, number>;
};

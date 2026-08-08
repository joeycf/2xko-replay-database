import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only: the HUD strip out of a cached Evo broadcast frame — the evidence a
// reviewer reads the four champions off.
//
// A SEPARATE ROUTE FROM fuse-hud, not a parameter on it, because the two frame
// caches are different in kind. cache/fuse/frames holds 12 frames per video from
// the first 12 seconds, stamped 01..12; cache/evo/frames holds frames sampled
// across a whole set, stamped with six-digit absolute SECONDS. The strict-shape
// guards double as path-traversal guards, so they cannot be loosened to cover
// both — `n` is exactly six digits here and exactly two there.
//
// BAND HEIGHT IS 0.20, not fuse-hud's 0.145. That one is cut for the direct game
// feed; broadcast framing sits lower and varies per video (measured scale
// 0.963-1.000), and the extra strip carries the BREAK meters and round score,
// which are the visible cue that a frame sits on a game boundary — i.e. near a
// character change, which is exactly what a set-level union reviewer is hunting.
//
// sharp is imported lazily so production builds never trace the native module.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const { id, n, full } = getQuery(event);
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{11}$/.test(id) ||
    typeof n !== 'string' ||
    !/^\d{6}$/.test(n)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'expected ?id=<videoId>&n=<NNNNNN>' });
  }
  const path = join(process.cwd(), 'cache/evo/frames', id, `${n}.png`);
  if (!existsSync(path)) throw createError({ statusCode: 404 });

  const { default: sharp } = await import('sharp');
  setHeader(event, 'content-type', 'image/png');
  // ?full=1 returns the whole frame: a VS/character-select card is a full-frame
  // layout and states all four champions at once, so a reviewer stuck on the HUD
  // needs to be able to look at one.
  if (full === '1') return await sharp(path).png().toBuffer();

  const meta = (await sharp(path).metadata()) as { width: number; height: number };
  return await sharp(path)
    .extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * 0.2) })
    .png()
    .toBuffer();
});

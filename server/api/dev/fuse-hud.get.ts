import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only: crops the full top-HUD strip (both fuse pills + both teams'
// nameplates) out of a cached frame — the complete orientation evidence in one
// image for /dev/fuse-orient. sharp is imported lazily so production builds
// never trace the native module.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const { id, n } = getQuery(event);
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{11}$/.test(id) ||
    typeof n !== 'string' ||
    !/^\d{2}$/.test(n)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'expected ?id=<videoId>&n=<NN>' });
  }
  const path = join(process.cwd(), 'cache/fuse/frames', id, `${n}.png`);
  if (!existsSync(path)) throw createError({ statusCode: 404 });

  const { default: sharp } = await import('sharp');
  const meta = (await sharp(path).metadata()) as { width: number; height: number };
  const buf = await sharp(path)
    .extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * 0.145) })
    .png()
    .toBuffer();
  setHeader(event, 'content-type', 'image/png');
  return buf;
});

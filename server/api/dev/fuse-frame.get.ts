import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only: streams one cached detection frame (cache/fuse/frames/<id>/<n>.png)
// so /dev/fuse-gaps can show full frames for occlusion context.
export default defineEventHandler((event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const { id, n } = getQuery(event);
  // strict shapes double as path-traversal guards
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
  setHeader(event, 'content-type', 'image/png');
  return readFileSync(path);
});

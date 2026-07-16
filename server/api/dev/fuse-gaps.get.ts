import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only: serves the fuse-gap diagnostic written by `npm run data:fuse-gaps`.
// cache/ never ships, so in production builds this route 404s before touching disk.
export default defineEventHandler((event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const path = join(process.cwd(), 'cache/fuse/review/fuse-gaps.json');
  if (!existsSync(path)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'fuse-gaps.json not found — run `npm run data:fuse-gaps` first',
    });
  }
  setHeader(event, 'content-type', 'application/json');
  return readFileSync(path, 'utf8');
});

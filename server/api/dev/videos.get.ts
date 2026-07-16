import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only: serves the RICH pipeline records (data/videos.json) to the fuse
// curation pages — the public replays.json is the generic schema and lacks
// the fuse/matchType/confidence fields the tooling reads. Static production
// builds drop server routes, so this never ships.
export default defineEventHandler((event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const path = join(process.cwd(), 'data/videos.json');
  if (!existsSync(path)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'data/videos.json not found — run `npm run data:parse` first',
    });
  }
  setHeader(event, 'content-type', 'application/json');
  return readFileSync(path, 'utf8');
});

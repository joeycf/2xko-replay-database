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
    // A record id is not always a YouTube id: a SEGMENT record (replayTheater)
    // is `${videoId}@${startSeconds}` and its frames cache under that whole
    // string. The anchors and the {11} keep this a path-traversal guard — no
    // dot, no slash, no "..".
    !/^[A-Za-z0-9_-]{11}(@\d+)?$/.test(id) ||
    typeof n !== 'string' ||
    !/^\d{2}$/.test(n)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'expected ?id=<recordId>&n=<NN>' });
  }
  const path = join(process.cwd(), 'cache/fuse/frames', id, `${n}.png`);
  if (!existsSync(path)) throw createError({ statusCode: 404 });
  setHeader(event, 'content-type', 'image/png');
  return readFileSync(path);
});

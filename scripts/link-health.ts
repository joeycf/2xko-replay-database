// UNFETCHED-SOURCE LINK HEALTH — report-only, run it when curious.
//
// WHY THIS EXISTS. Every other channel gets a liveness signal for free:
// `data:fetch` re-walks the full uploads playlist daily and drops ids the API
// stops returning, so surviving today's refresh proves YouTube still lists a
// video. Freezing a channel BREAKS that inference for exactly the records the
// freeze is protecting — proReplays is no longer fetched, so its 1,317 carried
// records have had no liveness signal since 2026-08-08. This is the replacement
// signal.
//
// A LOCAL-FIRST SOURCE HAS THE SAME HOLE, for a different reason: it is pulled
// by hand rather than daily, and its records point at OTHER people's VODs —
// event organisers' uploads, not a channel this pipeline tracks. One of Replay
// Theater's 75 source VODs was already private on the day of first ingest. So
// the population here is "records nothing re-fetches", which is both kinds.
//
// Segment records share a video: 888 of them cover 74 VODs, so the probe
// de-duplicates by VIDEO id. Probing the same stream sixteen times would be
// sixteen times the requests for one bit of information.
//
// The freeze rests on a specific claim: the videos still play at their URLs,
// they merely left the uploads playlist when the channel rebranded and unlisted
// its back catalogue. That claim is worth re-testing occasionally, because if it
// stops being true the honest move is a documented prune, not a silent carry.
//
// WHY oEMBED. It is the cheapest endpoint that distinguishes the three states
// that matter, and it needs no API key or quota:
//   200  → the video is playable (an UNLISTED video answers 200 — that is the
//          whole point; it is exactly the state the frozen archive is in)
//   404  → deleted, or the id never existed
//   401  → private
// A HEAD on the watch URL cannot tell these apart: YouTube answers 200 with an
// error page for a dead id.
//
// NOT WIRED TO ANY CRON, and it writes to cache/ (gitignored) rather than
// data/report.md — that file's timestamp-only-diff guard is what stops the daily
// workflow committing on a quiet day, and adding churn to it would defeat that.
//
//   npm run data:link-health              sample 50, spread across the archive
//   npm run data:link-health -- --n 200   bigger sample
//   npm run data:link-health -- --all     every unfetched record (slow; paced)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS } from './channels';
import { refOf, watchUrl } from './video-url';
import type { ChannelKey, VideoRecord } from '../types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(ROOT, 'cache', 'fuse', 'review');

const POOL = 8;
// Pace every attempt, failures included — 2XKO's own lesson from the fuse
// backlog: retrying instantly "fed the throttle spiral that produced the
// 'unavailable' pile in the first place".
const SLEEP_MIN = Number(process.env.LINK_SLEEP_MIN ?? 0.15);
const SLEEP_MAX = Number(process.env.LINK_SLEEP_MAX ?? 0.4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const N = Number(argv[argv.indexOf('--n') + 1]) || 50;

type State = 'alive' | 'deleted' | 'private' | 'unknown';

/** Is the thumbnail real? A dead id still answers 200 on some CDN paths, but
 *  hqdefault 404s with a ~1.1KB placeholder body, so size is the tell. This is
 *  the CORROBORATING signal: a bare oEmbed non-200 cannot be told apart from
 *  throttling, and a report that cries "dead" under rate-limiting is worse than
 *  no report. Verified on a known-good id (50KB) against two dead ones (404). */
async function thumbAlive(id: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${refOf(id).videoId}/hqdefault.jpg`);
    if (!r.ok) return false;
    const buf = await r.arrayBuffer();
    return buf.byteLength > 2048;
  } catch {
    return null; // network problem — decides nothing
  }
}

async function probe(id: string): Promise<{ state: State; detail: string }> {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(id))}&format=json`;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    await sleep((SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN)) * 1000);
    if (res.ok) return { state: 'alive', detail: 'oEmbed 200' };

    // Non-200: corroborate before calling anything dead.
    const thumb = await thumbAlive(id);
    await sleep((SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN)) * 1000);
    if (thumb === null) return { state: 'unknown', detail: `oEmbed ${res.status}, thumb errored` };
    if (thumb)
      return { state: 'unknown', detail: `oEmbed ${res.status} but thumb OK — throttled?` };

    if (res.status === 404) return { state: 'deleted', detail: 'oEmbed 404 + thumb gone' };
    if (res.status === 401 || res.status === 403)
      return { state: 'private', detail: `oEmbed ${res.status} + thumb gone` };
    return { state: 'unknown', detail: `oEmbed ${res.status}` };
  } catch (e) {
    await sleep((SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN)) * 1000);
    return { state: 'unknown', detail: (e as Error).message.slice(0, 60) };
  }
}

const videos = JSON.parse(readFileSync(join(DATA, 'videos.json'), 'utf8')) as VideoRecord[];
// Every source nothing re-fetches: frozen channels and local-first sources.
const unfetchedKeys = (Object.keys(CHANNELS) as ChannelKey[]).filter(
  (k) => CHANNELS[k].frozen || CHANNELS[k].localFirst,
);

if (unfetchedKeys.length === 0) {
  console.log('No frozen or local-first sources — nothing to check.');
  process.exit(0);
}

// One entry per distinct VIDEO. Segment records share a VOD, and its liveness is
// a property of the video, not of each set cut out of it.
const seenVideos = new Set<string>();
const frozen = videos
  .filter((v) => unfetchedKeys.includes(v.channel as ChannelKey))
  .filter((v) => {
    const vid = refOf(v.id).videoId;
    if (seenVideos.has(vid)) return false;
    seenVideos.add(vid);
    return true;
  })
  .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

// Deterministic, evenly-spread sample rather than a random one: re-running gives
// the same ids, so two runs are comparable, and the spread covers the archive's
// whole history instead of clustering on whatever end the sort put first.
const stride = ALL ? 1 : Math.max(1, Math.floor(frozen.length / N));
const sample = ALL ? frozen : frozen.filter((_, i) => i % stride === 0).slice(0, N);

console.log(`Unfetched-source link health`);
for (const k of unfetchedKeys) {
  const f = CHANNELS[k].frozen;
  const carried = frozen.filter((v) => v.channel === k).length;
  if (!f) {
    console.log(
      `  ${k}: ${carried} distinct video(s) behind its records — local-first, no daily fetch signal`,
    );
    continue;
  }
  console.log(`  ${k}: ${carried} carried · frozen ${f.since} · ${f.reason}`);
}
console.log(`  probing ${sample.length} of ${frozen.length} via oEmbed (pool ${POOL})\n`);

type Row = { id: string; title: string; publishedAt: string; state: State; detail: string };
const rows: Row[] = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(POOL, sample.length) }, async () => {
    for (;;) {
      const i = cursor++;
      const v = sample[i];
      if (!v) return;
      const { state, detail } = await probe(v.id);
      rows.push({ id: v.id, title: v.title, publishedAt: v.publishedAt, state, detail });
      if (state !== 'alive') console.log(`  ✖ ${v.id}  ${state}  (${detail})`);
      if (rows.length % 25 === 0) console.log(`  … ${rows.length}/${sample.length}`);
    }
  }),
);
rows.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

const tally = (s: State) => rows.filter((r) => r.state === s).length;
const dead = rows.filter((r) => r.state === 'deleted' || r.state === 'private');

const md: string[] = [];
md.push('# Frozen-channel link health');
md.push('');
md.push(`_Generated ${new Date().toISOString()} · report-only, not wired to any cron_`);
md.push('');
md.push(
  'Frozen channels are not fetched, so they get no liveness signal from the ' +
    'daily refresh. This samples their carried records directly. The freeze ' +
    'rests on the claim that the videos still play at their URLs; a rising dead ' +
    'count is the signal that a documented prune is now the honest move.',
);
md.push('');
for (const k of unfetchedKeys) {
  const f = CHANNELS[k].frozen;
  const n = frozen.filter((v) => v.channel === k).length;
  md.push(
    f
      ? `- \`${k}\` — ${n} carried, frozen ${f.since}: ${f.reason}`
      : `- \`${k}\` — ${n} distinct video(s), local-first: pulled by hand, so no daily fetch proves these still resolve`,
  );
}
md.push('');
md.push('## Result');
md.push('');
md.push(`| state | count |`);
md.push(`|---|---|`);
md.push(`| alive | ${tally('alive')} |`);
md.push(`| deleted | ${tally('deleted')} |`);
md.push(`| private | ${tally('private')} |`);
md.push(`| unknown (network/rate-limit — retry) | ${tally('unknown')} |`);
md.push(`| **sampled** | **${rows.length}** of ${frozen.length} |`);
md.push('');
if (dead.length === 0) {
  md.push('No dead links in this sample. The retain-and-freeze decision still holds.');
} else {
  md.push(`## Dead links (${dead.length})`);
  md.push('');
  md.push('| video | published | state | detail | title |');
  md.push('|---|---|---|---|---|');
  for (const r of dead) {
    md.push(
      `| \`${r.id}\` [▶](${watchUrl(r.id)}) | ${r.publishedAt.slice(0, 10)} | ${r.state} | ${r.detail} | ${r.title.replace(/\|/g, '\\|').slice(0, 60)} |`,
    );
  }
}
md.push('');

mkdirSync(OUT, { recursive: true });
if (!existsSync(OUT)) throw new Error(`could not create ${OUT}`);
writeFileSync(join(OUT, 'link-health.md'), md.join('\n'), 'utf8');

console.log(
  `\nalive ${tally('alive')} · deleted ${tally('deleted')} · private ${tally('private')} · unknown ${tally('unknown')}` +
    `  (sampled ${rows.length} of ${frozen.length})`,
);
console.log('✓ cache/fuse/review/link-health.md');

// Frame acquisition for broadcast (tournament) VODs — the substrate the champion
// extractor reads.
//
// WHY THIS IS NOT scripts/fuses.ts's ensureFrames. That one fetches a single
// contiguous `*0-12` window and cuts 12 frames at fps=1, because an online replay
// upload starts ON the match. A tournament VOD's first 12 seconds is a walk-on or
// a caster desk, and the match runs for tens of minutes after it — the shortest
// Evo set in the corpus is 361 s, and samplePlan's first sample lands at 29 s, so
// no sampled second ever falls inside fuses.ts's window. The two samplings are
// disjoint by construction; "share the frame cache" is unsatisfiable and this
// keeps its own root instead.
//
// It is a COPY of ensureFrames's hard-won invocation, not an import: fuses.ts
// exports nothing, parses process.argv at module scope, can process.exit, and
// builds its record index from a manual-filtered videos.json. Importing it runs
// the whole fuse backlog. What is copied and why:
//
//   --js-runtimes node   YouTube's n-challenge needs yt-dlp's EJS solver, and
//                        only Deno is enabled by default.
//   SSL_CERT_FILE        the static ffmpeg build serving --download-sections
//                        carries no CA bundle and exits 251 without it.
//   sleep after EVERY    including failures. A backlog that retried instantly is
//   attempt              what fed the throttle spiral that produced the
//                        "unavailable" pile in the first place (fuses.ts:305-310).
//   bot-check -> exit 2  a soft-fail here burns the whole run's requests against
//                        a session that is already refusing.
//
// The stamp is SIX digits of absolute seconds, deliberately unlike fuses.ts's
// two-digit ordinal: that one caps at 99 and encodes position-in-clip rather than
// time, and a 6-digit name dropped into cache/fuse/frames would sort ahead of
// 01.png and silently feed mid-match frames to the next `npm run data:fuses`.
//
// This module has NO top-level execution, so it can be imported by a reader or a
// test without side effects. The CLI lives in scripts/evo-recon.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = join(ROOT, 'cache/evo');
const CLIPS = join(CACHE, 'clips');
const FRAMES = join(CACHE, 'frames');

const COOKIES = process.env.EVO_COOKIES ?? join(ROOT, 'secrets/yt-cookies.txt');
const COOKIE_MAX_AGE_DAYS = 14;

// Denser request pattern than the fuse backlog (14 calls per video against one
// id in quick succession, vs 1), so pace it harder than fuses.ts's 1-3 s.
const SLEEP_MIN = Number(process.env.EVO_SLEEP_MIN ?? 3);
const SLEEP_MAX = Number(process.env.EVO_SLEEP_MAX ?? 6);

if (!process.env.SSL_CERT_FILE) process.env.SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const die = (msg: string): never => {
  console.error(`✖ ${msg}`);
  process.exit(2);
};

/** Absolute seconds, zero-padded to six digits, so a plain lexical sort of the
 *  directory is timestamp order. */
export const stamp = (sec: number): string => String(Math.round(sec)).padStart(6, '0');

let preflighted = false;

/** Validate the YouTube session cookies before the first download of a run.
 *
 *  Deliberately LAZY: a re-read from cached frames performs no requests and must
 *  not demand a credential it will never use.
 *
 *  This is a transcription of 2XKO's own scripts/refresh-all.sh preflight
 *  (:294-349) — same checks, same order, same default path — rather than a port
 *  of Tekken's, which is itself a port-back of this one. Values are never read or
 *  logged; presence is tested by cookie NAME only. */
export function preflightCookies(): void {
  if (preflighted) return;
  preflighted = true;

  if (!existsSync(COOKIES)) {
    die(
      `No YouTube session cookies at ${COOKIES}\n` +
        `  Export them from a logged-in browser (see README, "YouTube session cookies").`,
    );
  }
  const st = statSync(COOKIES);
  if (!st.isFile()) die(`Cookie path is not a regular file: ${COOKIES}`);
  if (st.size === 0) die(`Cookie file is empty: ${COOKIES}`);

  // A live Google session inside the worktree is one `git add -A` from being
  // published. Refuse rather than warn.
  if (resolve(COOKIES).startsWith(resolve(ROOT))) {
    const ignored = spawnSync('git', ['check-ignore', '-q', COOKIES], { cwd: ROOT });
    if (ignored.status !== 0) {
      die(`${COOKIES} is inside the repo and is NOT gitignored — refusing to use it.`);
    }
  }
  if ((st.mode & 0o077) !== 0) {
    die(
      `Cookie file is group/world-readable (mode ${(st.mode & 0o777).toString(8)}): ${COOKIES}\n` +
        `  chmod 600 ${COOKIES}`,
    );
  }
  const names = readFileSync(COOKIES, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t')[5])
    .filter(Boolean);
  const missing = ['SAPISID', 'LOGIN_INFO'].filter((n) => !names.includes(n));
  if (missing.length) die(`Cookie export is missing ${missing.join(' and ')}: ${COOKIES}`);

  const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
  if (ageDays > COOKIE_MAX_AGE_DAYS) {
    console.warn(
      `⚠ Cookie export is ${Math.floor(ageDays)} days old — re-export if downloads fail.`,
    );
  }
}

/** Every cached frame for this id, in timestamp order.
 *
 *  Reads the DIRECTORY rather than the paths just written, which is what makes a
 *  re-sample additive: a second, denser pass folds together with the first. */
export function framesOf(id: string): string[] {
  const dir = join(FRAMES, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));
}

/** Pull one contiguous window and cut frames from it at `fps`.
 *
 *  One yt-dlp call per WINDOW rather than per frame is the economy 2XKO's
 *  ensureFrames already relies on: 60 frames of a 120 s window cost one request,
 *  not sixty. Returns the absolute seconds actually written.
 *
 *  Idempotent: a window whose frames are all present performs no request. */
export async function grabWindow(
  id: string,
  startSec: number,
  durSec: number,
  fps: number,
): Promise<number[]> {
  const start = Math.max(0, Math.floor(startSec));
  const step = 1 / fps;
  const want = Array.from({ length: Math.floor(durSec * fps) }, (_, i) =>
    Math.round(start + i * step),
  );
  const dir = join(FRAMES, id);
  if (want.every((s) => existsSync(join(dir, `${stamp(s)}.png`)))) return want;

  preflightCookies();
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(CLIPS, id), { recursive: true });
  const clipStem = join(CLIPS, id, `w${stamp(start)}`);

  const r = spawnSync(
    'yt-dlp',
    [
      '--cookies',
      COOKIES,
      '--js-runtimes',
      'node',
      '--quiet',
      '--no-warnings',
      '--download-sections',
      `*${start}-${start + Math.ceil(durSec)}`,
      '-f',
      'bv*[height<=720]/bv*',
      '-o',
      `${clipStem}.%(ext)s`,
      `https://www.youtube.com/watch?v=${id}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: process.env, timeout: 300_000 },
  );
  // pace EVERY attempt, failures included
  await sleep((SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN)) * 1000);

  const err = r.stderr?.toString() ?? '';
  if (/confirm you.re not a bot|sign in to confirm/i.test(err)) {
    die(
      `YouTube demanded a bot check for ${id}.\n` +
        `  Re-export ${COOKIES} from a logged-in browser and retry.`,
    );
  }
  const clip = existsSync(join(CLIPS, id))
    ? readdirSync(join(CLIPS, id))
        .filter((f) => f.startsWith(`w${stamp(start)}.`))
        .map((f) => join(CLIPS, id, f))[0]
    : undefined;
  if (!clip) {
    console.warn(`  ! ${id} @${start}s: no clip (${err.trim().split('\n')[0] ?? 'unknown'})`);
    return [];
  }

  // %06d is a 1-based ORDINAL here; the rename below maps it to absolute seconds.
  const tmp = join(CLIPS, id, `cut${stamp(start)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        clip,
        '-vf',
        `fps=${fps}`,
        join(tmp, '%06d.png'),
      ],
      { env: process.env, timeout: 300_000 },
    );
  } catch {
    console.warn(`  ! ${id} @${start}s: ffmpeg failed`);
    return [];
  }

  const cut = readdirSync(tmp)
    .filter((f) => f.endsWith('.png'))
    .sort();
  const written: number[] = [];
  for (const [i, f] of cut.entries()) {
    const sec = Math.round(start + i * step);
    execFileSync('cp', [join(tmp, f), join(dir, `${stamp(sec)}.png`)]);
    written.push(sec);
  }
  rmSync(tmp, { recursive: true, force: true });
  return written;
}

/** Drop this id's clips once frames are cut — frames are ~1% of the bytes. */
export function pruneClips(id: string): void {
  rmSync(join(CLIPS, id), { recursive: true, force: true });
}

/** In-match sampling plan, spread across the runtime.
 *
 *  Deliberately not a flat 20/40/60/80%: a bracket set is several games plus
 *  walk-ons, replays and crowd cuts, so spread wider and take more — non-gameplay
 *  frames read as nothing and cost only their share of the vote. */
export function samplePlan(durationSec: number, n = 12): number[] {
  const lo = 0.08;
  const hi = 0.94;
  return Array.from({ length: n }, (_, i) =>
    Math.round(durationSec * (lo + ((hi - lo) * i) / (n - 1))),
  );
}

/** The recon plan: three windows, ~14 requests, ~102 frames.
 *
 *  Sections A and B exist because UNIFORM SAMPLING CANNOT FIND A VS SCREEN. A
 *  character-select or versus card is event-locked to a game boundary and lasts
 *  seconds; twelve samples spread over a ~1000 s set hit a 10 s window about 11%
 *  of the time. A covers the match start densely, B covers a mid-set game
 *  boundary, and only C is the siblings' in-match sweep. */
export async function reconPlan(id: string, durationSec: number): Promise<void> {
  await grabWindow(id, 0, 120, 0.5); // A — match start / first VS screen
  await grabWindow(id, Math.floor(durationSec * 0.45), 60, 0.5); // B — a mid-set boundary
  for (const s of samplePlan(durationSec, 12)) await grabWindow(id, s, 1, 1); // C — in-match
}

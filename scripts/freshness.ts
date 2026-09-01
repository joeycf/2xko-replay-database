// THE STALE-RAW GUARD, as a pure predicate.
//
// WHY IT EXISTS. raw/ is gitignored, so it is local-only and the daily cron
// never writes it — the cron fetches and parses remotely, in one process, and
// commits the result. A local raw/ is therefore routinely OLDER than the
// committed data/, and `npm run data:parse` on its own publishes whatever that
// stale dump can reproduce and silently drops the rest. Observed here
// 2026-07-06: a bare parse regressed the catalogue 2,847 → 2,825.
//
// THE COLLAPSE GUARD CANNOT CATCH THIS, and tuning it is not the answer. It
// needs >20 records AND >10% from ONE channel; staleness arrives as a handful
// spread across every channel and slips under both thresholds by construction.
// Two different failures, two guards.
//
// WHAT THIS REPLACED, and why. Until now the predicate was a CONJUNCTION: an
// id-set arm (committed ids absent from every dump, minus the manual and
// carried exclusions) AND an mtime arm (`Math.max(...rawPaths.map(statSync))`
// against `git log -1 data/videos.json`). The id arm is data; the mtime arm was
// the decidable one, and it was forgeable. mtime is not a record of when a dump
// was FETCHED: a `cp`, a fresh clone, or a gates run that restores raw/ all
// stamp a months-old dump as new. Tōkon caught exactly that live on 2026-08-30,
// and SF6 replaced its own mtime arm for the same reason.
//
// AND THE CRON MOVE MADE IT WORSE THAN MERELY FORGEABLE. The index dump's path
// was pushed into `rawPaths` before the `if (ch.index)` early-continue, so
// `rawMtimeMs` was a Math.max ACROSS ALL DUMPS INCLUDING raw/replayTheater.json.
// `data:theater` joined the daily cron on 2026-08-31, so that file now carries a
// now-stamped mtime on every run, `rawMtimeMs < lastCommitMs` would go false, and
// the guard would be disarmed for every OTHER channel however old its dump is.
// Freshening one third-party index file would silence the guard protecting the
// three YouTube channels. That is why this port landed as a prerequisite of the
// cron move rather than a tidy-up after it.
//
// THE TEST READS ONLY DATA. A dump cannot contain an upload published after it
// was taken. If the committed catalogue holds a record for this channel NEWER
// than the newest upload anywhere in its dump, that record cannot have come from
// this dump and parsing would drop it. Both sides are publish timestamps written
// by YouTube and carried inside the files themselves, so cp, git checkout and a
// fresh clone cannot forge either one.
//
// What that buys:
//  · fires at ANY age — a dump taken two minutes before the cron's is caught,
//    where a 24-hour window never would be.
//  · never fires on age alone — a months-old dump for a channel that has
//    published nothing since is fresh, and re-parsing in the same session is
//    always allowed, because the committed catalogue can only hold what this
//    dump produced.
//  · a DELETED upload stays legal — committed holds it, the dump does not, but
//    the dump's newest is unchanged. That is the prune the pipeline exists to
//    publish and the guard must not block it.
//
// SCOPED PER CHANNEL, because a stale bestReplays dump says nothing about
// highLevel. The three exclusions the old id-set arm had to carry by hand —
// manual entries, frozen channels, the index source — all fall out for free:
// a record is judged only against the dump of the channel it names, and
// 'manual', 'proReplays' (frozen) and 'replayTheater' (index) have no dump to be
// judged against.
//
// A PURE PREDICATE, deliberately. scripts/parse.ts has top-level awaits and
// calls process.exit, so it cannot be imported; a guard that lives inside it can
// only ever be controlled by running the whole pipeline. Here, scripts/e2e.ts
// drives it with hand-built arrays and proves every one of its behaviours in
// milliseconds — which is what this repo did not have before.

import type { ChannelKey, RawVideoRecord, VideoRecord } from '../types/index';

/** What a stale dump looks like, when it is one: the newest upload the dump
 *  holds, and the committed record that proves the dump predates it. */
export interface StaleEvidence {
  newestInDump: string;
  committedId: string;
  committedAt: string;
}

/** null when the dump is fresh (or cannot be judged); the evidence when it is
 *  provably stale. Judging is impossible, and must not be guessed at, when the
 *  dump is empty or the channel has nothing committed yet — a first run. */
export function staleEvidence(
  key: ChannelKey,
  dump: RawVideoRecord[],
  committed: VideoRecord[],
): StaleEvidence | null {
  let newestInDump = '';
  for (const r of dump) if (r.publishedAt > newestInDump) newestInDump = r.publishedAt;
  if (!newestInDump) return null; // empty dump: the caller already refuses that

  let newest: VideoRecord | undefined;
  for (const v of committed) {
    if (v.channel !== key) continue;
    if (!newest || v.publishedAt > newest.publishedAt) newest = v;
  }
  if (!newest) return null; // nothing committed for this channel yet
  if (newest.publishedAt <= newestInDump) return null;

  return { newestInDump, committedId: newest.id, committedAt: newest.publishedAt };
}

/** The refusal, as text. Kept beside the predicate so the two cannot drift. */
export function formatStaleRefusal(key: ChannelKey, e: StaleEvidence): string {
  return [
    `✖ raw/${key}.json is stale: the committed catalogue holds an upload it cannot contain.`,
    ``,
    `  newest upload in the dump   ${e.newestInDump}`,
    `  newest committed record     ${e.committedAt}  ${e.committedId}`,
    ``,
    `  A dump cannot contain an upload published after it was taken, so parsing`,
    `  now would drop that record and every one like it — and the next run would`,
    `  treat the smaller catalogue as the new baseline.`,
    ``,
    `  Refresh first:  npm run data:build   (fetch and parse, always together)`,
    `  Or override:    npm run data:parse -- --allow-stale`,
  ].join('\n');
}

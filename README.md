# 2XKO Replay Database

This is my passion project first step to creating a competitive replay database
for multiple games. Beginning with my current favorite fighting game **2XKO** replay footage of
5,100+ pro and high-level replays, filterable by champion, team pairing, player,
season, channel, and fuse, with a stats dashboard (champion usage, fuse usage,
top pairings, synergy matrix, meta over time, fuse-era shift) and per-champion / per-player pages.

The app is a **thin layer over [replay-engine](https://github.com/joeycf/replay-engine)**
(pinned by tag in `nuxt.config.ts`): the engine owns the generic replay-database
UI and data contract, and this repo supplies the 2XKO data pipeline, theme, and
game-specific extensions (fuses above all). It ships under `/2xko/` behind the
replaydatabase.com shell.

The footer links a [Buy Me a Coffee](https://buymeacoffee.com/whatdaflip) page
(`BMC_URL` in the engine's `SiteFooter.vue`) for anyone who wants to support hosting.

> Part of the **Replay Database** platform — [replaydatabase.com](https://replaydatabase.com) ·
> [engine](https://github.com/joeycf/replay-engine) ·
> [shell](https://github.com/joeycf/replay-database-shell) ·
> [Tekken](https://github.com/joeycf/tekken-replay-database)

## Architecture

```
YouTube Data API v3                    replaytheater.app  (index, add-only)
      │  scripts/fetch.ts                    │  scripts/fetch-theater.ts
      │  (raw dumps → raw/*.json,            │  (+ YouTube metadata per VOD
      │   gitignored)                        │   → raw/replayTheater.json,
      │                                      │     raw/replayTheater.witness.json)
      ▼                                      ▼
scripts/parse.ts                 (channel-aware title parser + aggregates)
      │   merge order: title parse → CV fuses → manual-videos
      │                → replayTheater segments → overrides
      │   scripts/crosscheck.ts: the witness file read back against our own
      │   records → data/theater-disagreements.json (measurement only, no field)
      ▼
data/videos.json                 (RICH records — the pipeline substrate;
      │                           input to the fuse CV + dev curation tools)
      │  scripts/emit.ts         (runs at the end of every parse)
      ▼
data/replays.json + stats.json + summary.json   (GENERIC engine-contract files)
      │
      └─ committed ──►  Nuxt 4 static site (nuxt generate, vercel-static)
                          extends replay-engine layer
                                  │
                                  ├─ registries (champions/players/stats/fuses)
                                  │    → static imports, prerendered into HTML
                                  ├─ replays.json (~2.1 MB) → copied to
                                  │    public/data/ at build, fetched
                                  │    client-side on Browse and entity pages
                                  │    only (never bundled)
                                  └─ summary.json → copied to public/data/ at
                                       build; the apex selector's card counts
                                       (never read by this app)
```

Two schemas, deliberately: `videos.json` (6.1 MB, rich — fuses per team, parse
confidence, match type) never reaches the browser; `emit.ts` maps it onto the
engine's generic `Replay[]` contract, with the 2XKO fuse fields riding along as
extensions the engine ignores.

- **~750 routes prerendered**: Browse shell, Stats, champions and players
  indexes, 15 champion pages, all 715 player pages, plus `404.html`.
- The engine's `modules/static-artifacts` emits **`sitemap.xml`**, **`robots.txt`**,
  the web manifest and `404.html` from the _real_ prerendered route list (the
  old `build:before` sitemap hook and `postgenerate.mjs` are retired). Per-page
  **JSON-LD** (`WebSite` + `SearchAction`, `Organization`, `BreadcrumbList`,
  `CollectionPage`) is prerendered into the HTML.
- Behind the shell, this app's `/2xko/sitemap.xml` is referenced by the apex
  **sitemap index** that `replay-database-shell` owns. The app's own
  `/2xko/robots.txt` is inert — crawlers read `/robots.txt` from the apex, which
  the shell owns.
- The site builds **purely from committed JSON** — no API keys at deploy time.

## Setup

```sh
npm install
cp .env.example .env      # add your YouTube Data API v3 key (pipeline only)
npm run dev
```

`.env` is only needed to run the data pipeline locally. The web app never
reads it.

Two other env vars matter locally, neither of them secret:

- `ENGINE_PATH` — point at a local `replay-engine` checkout (e.g. `../replay-engine`)
  to co-develop app and engine. Unset, the pinned git tag is used; **Vercel leaves
  it unset**.
- `NUXT_APP_BASE_URL` — the site ships under `/2xko/`; set `/` for a root-based
  local preview. The committed default is production truth, so don't "simplify"
  the env expression in `nuxt.config.ts` — a literal value there shadows the
  engine's own read and 404s every prerendered route.

## Scripts

| script                                           | what it does                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `generate` / `preview` | Nuxt app (generate = full static build)                                                                                                                                                                                                                                                                                                       |
| `npm run data:fetch`                             | Pull every upload from the tracked YouTube channels → `raw/` (needs `YT_API_KEY`). Skips frozen channels and index sources                                                                                                                                                                                                                    |
| `npm run data:parse`                             | Parse titles/descriptions → `data/videos.json`, `players.json`, `report.md`; calls `data:emit` at the end                                                                                                                                                                                                                                     |
| `npm run data:emit`                              | Map the rich `videos.json` onto the engine contract → `data/replays.json`, `stats.json`, `summary.json` (+ the `public/data/` copies). Deterministic, no YouTube access — safe to re-run standalone                                                                                                                                           |
| `npm run data:theater`                           | Pull the Replay Theater index (tagged 2XKO tournament matches) joined to each source VOD's YouTube metadata → `raw/replayTheater.json`. Runs in the daily cron on a **cursor** (a few pages); `--full` sweeps the whole 71-page catalogue, `--fresh` also discards the resume cache. See "The index source"                                   |
| `npm run data:build`                             | fetch + parse                                                                                                                                                                                                                                                                                                                                 |
| `npm run data:champions`                         | Champion art + accents (portraits, splash 1600w + 800w, token accents) → `public/img/champions/`, `data/characters.json`                                                                                                                                                                                                                      |
| `npm run data:fuses`                             | **Local-only** CV fuse detection (see below) → `data/fuses-detected.json`                                                                                                                                                                                                                                                                     |
| `npm run data:fuse-gaps`                         | **Local-only** read-only gap diagnostic — buckets every still-fuse-less video (unavailable/low/none/pending/anomaly) → `cache/fuse/review/fuse-gaps.{md,json}` (feeds the `/dev/fuse-gaps` viewer)                                                                                                                                            |
| `npm run data:refresh-all`                       | **Local-only** one-shot full refresh: `data:build` → `data:fuses` → `data:parse` → `data:fuse-gaps`, then a single commit (**never pushes**). Enforces the stage order below and the cron's `report.md` guard. `--check` runs preflight only; `--skip-fuses`, `--limit N`, `--sleep MIN-MAX`, `--no-commit` also available (`--help` for all) |
| `npm run data:player-dupes`                      | Read-only registry audit — ranks `players.json` entries that likely describe the same human (sponsor tags, initials, leet, typos, numeric tails), corroborated by shared champion mains. Prints the merge recipe; edits nothing (`--json` for machine output)                                                                                 |
| `npm run data:replay-dupes`                      | Read-only replay audit — finds the same match uploaded twice (re-uploaded across channels or duplicated within one) via a side-agnostic players+champions signature, adjudicated by exact duration + a thumbnail perceptual hash → `cache/dupes/`. Emits an `overrides.json` exclude fragment (`--emit-overrides`); edits nothing             |
| `npm run typecheck`                              | App (`nuxt typecheck`) **and** pipeline (`tsc -p tsconfig.pipeline.json`) — both must pass                                                                                                                                                                                                                                                    |
| `npm run lint` / `lint:fix`                      | ESLint over the whole repo                                                                                                                                                                                                                                                                                                                    |
| `npm run format` / `format:check`                | Prettier                                                                                                                                                                                                                                                                                                                                      |
| `npm run test:e2e`                               | Playwright e2e suite against the generated output (run `npm run generate` first)                                                                                                                                                                                                                                                              |
| `npx tsx scripts/og.ts`                          | Regenerate the default OG card (`public/og-default.png`)                                                                                                                                                                                                                                                                                      |

Verification: `npm run typecheck` and `npm run lint` must pass, and
`npm run test:e2e` must be green against a fresh `npm run generate`.

## Vercel

Connect the repo and use:

| setting               | value                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework preset      | **Nuxt**                                                                                                                                             |
| Build command         | `npm run generate`                                                                                                                                   |
| Output directory      | _(auto — Build Output API, `.vercel/output`)_                                                                                                        |
| Node.js version       | 24 (`engines.node: ">=24 <25"`; the data-refresh Action runs 24 too)                                                                                 |
| Environment variables | `NUXT_PUBLIC_SITE_URL` = your production URL (used for canonical/OG/sitemap absolute URLs). **No `YT_API_KEY`** — the pipeline never runs on Vercel. |

`ENGINE_PATH` stays unset on Vercel, so the pinned `github:` tag is used.
Deploys are triggered by pushes — including the daily data-refresh commit.

The deployment's own `2xko-replay-database.vercel.app` alias stays reachable and
is **never** host-redirected to the apex: the shell reaches this project through
an edge rewrite, so a host redirect here would loop.

`vercel.json` carries one **path** redirect, `/` → `/2xko`. The build nests every
route under `app.baseURL`, so this project's own root holds nothing but
`404.html` — which is what the Vercel dashboard's Visit link used to land on. Two
constraints keep it safe, and both are easy to "improve" into an outage:

- The destination stays **relative**. An absolute `https://replaydatabase.com/2xko`
  would fire on every **preview** deployment too, bouncing a reviewer off the
  preview they meant to inspect and onto production.
- It stays a **path** redirect, never a host one — see the paragraph above.

It cannot disturb the shell, which only ever requests `/2xko` and `/2xko/*` at
this child, never `/`.

## Analytics

Both are Vercel-native, **inherited from the engine**, inert outside production,
and inject nothing into the prerendered HTML (they attach client-side):

- **Web Analytics** — reports to **this project**, via
  `observability.insights: '/2xko-insights'` in `app/app.config.ts`.
- **Speed Insights** — reports to the **shell's** project at `sampleRate 0.5`,
  so tournament-weekend traffic spikes stay under the Hobby plan's monthly event
  cap while Core Web Vitals stats stay sound. Not per-game on purpose: Speed
  Insights is single-project on Hobby.

The wiring lives in the engine (`app/plugins/vercel-observability.client.ts`);
this repo configures only the endpoint. That one line is **paired with a rewrite
in the shell's `vercel.json`** — `/2xko-insights/:path*` →
`https://2xko-replay-database.vercel.app/_vercel/insights/:path*`. Change one
without the other and every beacon 404s, silently.

That is not hypothetical: the Phase-5 subpath cutover killed analytics outright
for ~10 days. Vercel bakes a per-project obfuscated script path into each build,
and proxied onto the apex it 404s, so both SDKs reported **nothing** — dropped,
not misattributed. `npm run test:e2e` now gates the wiring, and the shell's
`verify:cutover` gates that it resolves through the apex.

## Daily data refresh

`.github/workflows/data-refresh.yml` runs daily at 06:17 UTC (and via
_Run workflow_) on Node 24: `npm run data:build` with `YT_API_KEY` from repo
**Actions secrets**, then commits
`data/{videos,replays,stats,players,summary}.json` + `report.md` **only if changed**
("data: refresh YYYY-MM-DD — N videos"). The push triggers the Vercel deploy.
A run whose only diff is `report.md`'s `_Generated <timestamp>_` line counts
as unchanged — no commit, no deploy — so a `report.md` diff in history always
means real data changed. Champion art is deliberately not part of the daily run.

## Fuse detection (local CV pipeline)

Neither channel labels fuses in titles/descriptions (0% across the catalog),
but every replay shows each team's fuse as a labeled pill in the match HUD.
`npm run data:fuses` downloads the **first 12 s** of each video (yt-dlp,
≤720p, video-only), extracts 1 fps frames, and classifies the two HUD pills
(hue voting gated + wide perceptual hash, validated at 98.75% with no class
failing silently). Champion nameplates orient sides back to **title order**;
genuinely ambiguous pairs are `ok-unordered` (filters/stats are order-agnostic,
the modal shows the pair unattributed).

- Output: `data/fuses-detected.json` (committed). `data:parse` merges it on
  every run — title parse → fuse merge → `manual-videos.json` →
  `overrides.json` last — so detections **survive the daily cron**, which
  regenerates `videos.json`/`replays.json`/`stats.json` from scratch.
- Incremental + resumable: only ids missing from the output are processed;
  `--limit N` for smoke tests, `--force` to redo, `--clean` to purge the
  gitignored `cache/fuse/` working dir (~10 GB for the full backlog).
- `--promote-lows` re-reads every un-overridden `low` record from **cached
  frames only** (no downloads, detection thresholds untouched) and promotes the
  plainly-legible ones, reusing the nameplate `orient()` pass for side
  attribution. Genuinely ambiguous sides go to an `orient-queue.json` that the
  dev-only `/dev/fuse-orient` viewer hand-adjudicates back into `overrides.json`.
- **Whatever the CV can't settle, a human settles in `/dev/fuse-review`** — see
  [Dev curation tooling](#dev-curation-tooling-local-only). After the Best Replays
  backfill (2026-07-22) coverage is **~98%, 5,104 / 5,206**, with ~102 videos in the
  low/anomaly review backlog (the new channel's harder-to-read captures). Expect it to
  dip between a data refresh and the next local `data:fuses` run.
- Run it **locally, weekly-ish**, and commit the refreshed
  `fuses-detected.json`; the daily Action folds it in automatically. The
  Action itself **never** runs yt-dlp — datacenter IPs are routinely blocked.
- **A YouTube bot-check locally is the normal case, not the exception** — this
  host's IP is flagged, so every unauthenticated yt-dlp player client gets
  "Sign in to confirm you're not a bot". Pass a signed-in cookie export:
  `npm run data:fuses -- --cookies secrets/yt-cookies.txt`. See
  [YouTube session cookies](#youtube-session-cookies-local-only) below.
  (`--cookies-from-browser <spec>` is forwarded too, but on WSL2 it cannot
  decrypt a Windows browser profile — the cookies.txt export is the reliable
  path.)
- Review artifacts land in `cache/fuse/review/`: `low-review.md` (every
  low/none with best guess + scores) and `unmatched-pills.png` (montage —
  how a new/rare fuse style gets spotted, templated from those very frames,
  and re-run incrementally).
- `npm run data:fuse-gaps` reconciles `videos.json` against the detections,
  overrides, and low-review sheet and buckets every still-fuse-less video —
  `unavailable` (yt-dlp failed the download), `low`, `none`, `pending` (added
  after the last download run), `anomaly` (confident read that couldn't merge).
  Output: `cache/fuse/review/fuse-gaps.{md,json}` + labeled `gap-pills.png`,
  browsable at the dev-only `/dev/fuse-gaps` viewer. Read-only — no downloads,
  no re-detection.
- **Run the stages in order: `data:fuses` → `data:parse` → `data:fuse-gaps`.**
  `fuses-detected.json` only reaches `videos.json` through a parse, so running
  the gap report on a stale parse reports confident, already-solved detections
  as `anomaly` gaps. If the anomaly bucket is non-empty, re-run `data:parse`
  before assuming there is anything to review.
  `npm run data:refresh-all` encodes this order (plus a preceding
  `data:build`, so the CV pass sees the day's new uploads) and commits the
  result — use it instead of running the four by hand.

## YouTube session cookies (local-only)

`data:fuses` is the only stage that needs these. This machine's IP is
bot-flagged by YouTube, so **without a signed-in cookie export every yt-dlp
download fails instantly** with "Sign in to confirm you're not a bot" —
`scripts/fuses.ts` exits `2` when it sees that.

- **Location: `secrets/yt-cookies.txt`.** `secrets/` is in `.gitignore` **and**
  `.vercelignore` (the latter matters: that file _replaces_ gitignore-based
  exclusion for `vercel deploy` CLI uploads). The file is a **live Google
  session** — treat it like a password. `chmod 600`, never commit it, never
  paste it anywhere. `data:refresh-all` refuses to run if the cookie path is
  inside the worktree and not ignored, or if it is group/world-readable.
- Both `data:refresh-all` and `data:fuses` accept `--cookies <path>` if you
  keep yours elsewhere (e.g. `~/yt-cookies.txt`, outside the repo entirely).

### Creating one

The export must come from a **signed-in incognito window**. Both halves matter,
and the failure modes are silent:

1. Sign in to YouTube in a normal window.
2. Open an **incognito window and sign in to YouTube there too**. An incognito
   export taken _without_ signing in first parses fine but carries no
   `SID`/`SAPISID`/`LOGIN_INFO`, and fails exactly like having no cookies.
3. With a cookies.txt browser extension, export **youtube.com** cookies in
   **Netscape format** to `secrets/yt-cookies.txt`.
4. **Close the incognito window immediately after exporting.** A
   normal-browser export gets rotated out from under the run — one died at
   30/210 videos. An incognito session closed right away stays valid; a good
   one has survived 189 videos / ~65 min.
5. `chmod 600 secrets/yt-cookies.txt`
6. Verify the session cookies are actually present before relying on it (names
   only — never print the values):
   ```sh
   awk -F'\t' 'NF>=7 {print $6}' secrets/yt-cookies.txt | sort -u | grep -E 'SAPISID|LOGIN_INFO'
   ```
   `npm run data:refresh-all -- --check` runs this and the rest of the
   preflight without starting a download.

### When it expires

Sessions rotate every few weeks; `refresh-all` warns once the file is older
than 14 days. If a run dies mid-way on a bot-check, **probe before burning a
fresh export** — a transient throttle stop is common and often clears on its
own:

```sh
npm run data:fuses -- --cookies secrets/yt-cookies.txt --limit 1
```

If that succeeds, just re-run; `data:fuses` is incremental and resumes where it
stopped. Under sustained throttling, pace it with `--sleep 4-8`.

## The index source

`replayTheater` is the platform's first **index-type source**. It is not a
YouTube channel: [replaytheater.app](https://replaytheater.app) is a
fan-curated match index that points AT video with a start offset, and its 2XKO
catalogue holds tournament sets cut out of longform event VODs. 888 published
records over 64 videos, a median of 17 sets per video, September 2025 to July 2026. (The dump itself is 898 records over 74 VODs; the 10 the intake declines
are one-match VODs already hand-authored in `manual-videos.json` — see "Existing
ids win, by ignoring".)

**A record is a SEGMENT, so its id is `${videoId}@${startSeconds}`.** That is the
one structural difference from every other source, and it is why engine v0.10.0
added `Replay.videoId` and `Replay.startSeconds`: every YouTube-shaped URL the
site builds resolves `videoId ?? id`, so the embed opens at the right moment and
the thumbnail comes off the video rather than off a composite id that would 404.

### In the cron since 2026-08-31, add-only, on a cursor

This source was deliberately kept **out** of the daily cron at first: a third
party's uptime and goodwill should not become a cron dependency on day one of an
integration. Four games in, with the trust re-measured against the uploaders' own
chapter markers (99.8% agreement on player names, 606 of 607) and the catalogue's
operator a collaborator, what that policy cost was a human remembering to run the
command. `robots.txt` read 2026-08-31: `User-agent: * / Disallow:`.

What makes the move safe is not the relationship. It is two rules that hold when
the goodwill does not:

- **Add-only.** A rebuild no longer replaces the intake with whatever the dump
  produced. Built records win for the ids the dump **mentions**; a committed id it
  does not mention is carried untouched, and the vanished ones are **counted** in
  `data/report.md` rather than removed. Two independent reasons, either
  sufficient: the cursor's dump is a **delta**, so replacing on it would delete
  the whole intake every morning; and one source VOD going private takes every
  segment cut from it — the largest here holds 22 of the 888 records (2.5%),
  which clears the collapse guard's `>20` arm and fails its `>10%` arm, so that
  loss would pass in silence.
- **Carrying and rebuilding produce byte-identical output**, which is what lets
  the cron and a local `--full` refresh alternate without churning the diff. Both
  paths take the same narrow merge and land in the same slot, and the merged
  block is **sorted with the fetcher's own comparator** — `publishedAt`, then the
  start offset within the VOD. That sort is load-bearing, not tidiness: nothing
  sorts `records` globally in `parse.ts`, so without it a cursor delta's newest
  entries would land in front of the carried survivors and every morning that
  found anything tagged would rewrite the whole intake block of `videos.json` and
  `replays.json` for a reordering, with no content changed at all.
- **The cron never depends on the pull succeeding.** `data:theater` is its own
  workflow step with `continue-on-error`, placed **after** the channel fetches so
  a failure cannot cost the dumps already in hand. On any failure there is no
  dump, parse **carries** the committed records exactly as before, and the run
  stays green. An empty dump is a carry too — `readJson` succeeds on an empty
  file, and without that branch the empty case would rebuild to 0 and trip the
  collapse guard for a reason nothing in the failure names. So is an UNREADABLE
  one: `readJson` is a bare `JSON.parse`, so a truncated or malformed dump threw
  inside the PARSE step, which is not the step wearing `continue-on-error` — a red
  cron over a pull that was only ever optional. It is caught, carried, and named
  in `data/report.md` and the parse log instead. The channel dumps keep throwing:
  those are our own fetcher's output over sources we parse, and swallowing one
  would publish a channel short in silence.

**The cursor** is what makes it affordable. A full sweep is 71 paced requests;
that is not something to send a fellow fan project every morning. The API honours
only `game` and `page` (`since`, `limit`, `per_page`, `sort`, `order` and
`after_id` are accepted and silently ignored), but it orders `upload_date DESC,
id ASC` — so the daily path reads from the front and stops after two consecutive
pages with nothing above the committed cursor, bounded at ten pages.
`data/theater-cursor.json` holds one integer per source, only ever grows, and is
committed by the cron because `raw/` is gitignored and CI starts fresh.

Its blind spot is stated rather than hidden: the ordering key is the **video's**
upload date, not the submission's, so a 2024 VOD submitted today lands behind the
bound. Under add-only that is late, never lost — `npm run data:theater -- --full`
reconciles, and hitting the bound is reported rather than silent.

### Guard posture, stated rather than assumed

The channel-collapse guard is **asleep** for this source: its dump is a cursor
delta, so an ordinary successful morning would read as 888 against a day's
handful — the committed intake's newest 30 days run at 4.5 records/day — and fire
the guard daily. What is awake instead is stronger:

- The **add-only merge**, which makes the published count non-decreasing by
  construction.
- The **count pin** in `data/source-pins.json`, which now refuses to move
  **downward** without `--allow-shrink`. That refusal replaces a guarantee the
  cron move removed: until 2026-08-31 every cron run was a carry and asserted the
  pin at exact equality daily; now most runs rebuild, and a rebuilding run never
  asserted it.
- On a `--full` sweep, a **floor in the fetcher**: fewer than 90% of the pin
  refuses to write, and names the per-entry game gate as the likeliest cause,
  because a renamed game label upstream zeroes every row.

The stale-raw guard reads data, not mtimes, and judges each channel only against
its own dump — the index dump never enters that map, which is what stops a cursor
delta reading as a stale channel.

### Refresh cadence

The cron reads the cursor every morning; there is nothing to remember. Run
`npm run data:theater -- --full && npm run data:parse` occasionally to reconcile
the whole catalogue — that is the 71 paced requests (~90 s) plus two YouTube
metadata batches, and the resume cache still makes an interrupted **full** sweep
restartable.

### What it does not carry

- **No fuse.** These records arrive fuse-less and need `data:fuses`, which for a
  segment samples 12 s **at the offset** rather than at the top of a three-hour
  stream. `data:fuses` is local-only and never runs in CI, so every cron-added
  record arrives under the 95% floor by construction; the e2e fuse floor holds
  this source to a documented ratchet instead (see `FUSE_BACKFILL` in
  `scripts/e2e.ts`, which states the arithmetic behind the number).
- **No duration.** The index publishes none and there is nothing honest to derive
  one from — the gap to the next set includes the downtime between them. The
  duration chip and the "Longest" sort simply skip these records.
- **No view count.** Views belong to the VOD, not to each of the sixteen sets cut
  from it. Engine v0.10.0 hides an absent `views` rather than printing "0 views".
- **A round only sometimes.** The index carries no round; it is harvested from the
  source VOD's chapter titles when one names a bracket round (238 of 888).
- **Two champions per side, always.** The index's schema caps 2XKO at two, so it
  cannot express a within-set counter-pick the way `manual-videos.json` can. A
  set where somebody switched is recorded as their primary duo.

### The second witness

The pull writes `raw/replayTheater.witness.json` alongside the intake dump: EVERY
entry it saw, tagged and untagged. The untagged remainder — 2,648 of the
catalogue's 3,547 entries at first ingest — is online ranked play and out of
INGESTION scope by design. It is not out of scope as **evidence**. Most of those
rows point at a video this repo already publishes from a tracked channel, where a
stranger typed two handles and two champions into a form and our parser read the
same match out of the uploader's title. Neither saw the other.

`scripts/crosscheck.ts` compares the two. It is a pure module — `parse.ts` reads
the files and calls it — it produces no field, it gates nothing, and a
disagreement never edits a record. First measurement, 2,423 of our own whole-video
records:

| field                  | population | agree         | partial | disagree  | cannot witness |
| ---------------------- | ---------- | ------------- | ------- | --------- | -------------- |
| players (both handles) | 2423       | 2413 (99.59%) | 10      | 0         | —              |
| champions (per side)   | 4846       | 4840 (99.88%) | 0       | 6 (0.12%) | 0              |

`data/report.md` renders the whole block from `data/theater-disagreements.json`,
which **only a full sweep writes**. A cursor morning reads a few hundred rows off
the front of the feed — a different WINDOW, not a different corpus — so
recomputing the block from it moved every number in it whether or not a record
had changed: `report.md` then had a real diff every single morning, which retires
the cron's no-change-no-commit rule from the other side and deploys the site daily
forever, and a delta that found nothing overwrote the sweep's rows with an empty
list. The block names its sweep by the catalogue's own high-water entry id rather
than a date, because a timestamp is precisely the churn being avoided. A cursor
run prints its own reading to the console, where it is useful and costs nothing;
a run with no sweep behind it emits no block at all rather than a table of zeros.

Three things make the number mean something:

- **Whole-video records only.** The intake's own `${videoId}@${startSeconds}`
  segments were BUILT from this catalogue, so checking them against it would be
  checking it against itself. Videos the catalogue holds more than one entry for
  are excluded too — it segmented that VOD, and there is no 1:1 claim.
- **Orientation before champions.** p1/p2 is the submitter's reading of the
  screen and ours is the title's. Sides are aligned on the HANDLES first, then
  champions are compared: 2 records were flipped, and without the realignment
  each would have manufactured two champion disagreements out of none (10 instead
  of 6).
- **Exact alias, never fuzzy.** `resolveChampion`'s three-step ladder — exact,
  word-contains, OSA ≤ 1 — exists to read prose out of a sentence. Using it here
  would make the second witness a second parser. The cross-check takes the
  exact-alias-only path `buildTheaterRecords` already takes, and a champion string
  the roster cannot read counts as **cannot witness**, not as disagreement. In
  this game the roster reads every string the catalogue wrote, so that column is
  0 today.

**Cannot witness is a third outcome, not a rounding of the second.** A witness
that cannot REPRESENT the answer is not disagreeing with it, and this game has a
written ceiling: the index caps a side at two champions (above), so any side of
ours longer than two is something the catalogue could not have said. Nothing in
the compared population is in that shape yet — but two set-level `evoEvents`
records in `videos.json` already carry three champions on a side, so the ceiling
is real and not a defensive abstraction.

**The disagreements are published, not withheld.** They go to
`data/theater-disagreements.json` with BOTH claims, and `scripts/e2e.ts` asserts
the mirror of a withholding rule: every contested row MUST still be in
`videos.json`. A row leaving would mean the catalogue had been allowed to remove a
record, which is the one thing this intake must never do. Two of the six are the
most actionable rows the check produces — our side is EMPTY and the catalogue
names both champions, on titles that read `PANUNU (pj1-pj2)`. They are reported,
not auto-filled: RT is a witness, not an authority.

### Existing ids win, by ignoring

If this repo has already ruled on a video **in any capacity** — an active record,
the frozen carry, an `overrides.json` exclusion, a dedupe drop — the index entry
for it is ignored, and the count is reported in `data/report.md` rather than
being silent. The predicate is known-anywhere rather than merely in-records: an
id excluded as wrong-game must not re-enter through a side door.

On the first ingest that cost 10 entries of 898, and every one of them was a
one-match VOD already hand-authored in `manual-videos.json` — so the rule forgoes
no segmentation at all. That is a fact about the data on the day, not a
guarantee, which is why the number is reported on every run.

## Dev curation tooling (local-only)

**Start at [`/dev`](http://localhost:3000/2xko/dev)** — it lists every tool below
with its description, and there is a **Dev** entry in the site nav while the dev
server is running. That index is the engine's (`app/pages/dev/index.vue`) and it
builds itself from what each page declares in `definePageMeta({ devTool })`, so a
new tool appears there the moment it exists. Keep the block on any page you add;
the table here is a copy for readers who never start the server.

Five pages under `/dev` do the hand-curation the automated pipeline can't.
All of them are **`nuxt dev` only**: the page and every `/api/dev/*` route it
uses guard on `import.meta.dev` and 404 otherwise, `nitro.prerender.ignore`
skips the whole `/dev` prefix, and nothing public links to them (the nav entry
is compiled out of production builds). They read and write the committed JSON
directly — there is no database.

| page                | what it's for                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `/dev/fuse-review`  | **The manual fuse workbench.** Adjudicate every gap the CV couldn't settle → `data/overrides.json`   |
| `/dev/fuse-gaps`    | Read-only dashboard over the gap report — bucket/era filters, pill crops, in-app playback            |
| `/dev/fuse-orient`  | The narrow `--promote-lows` orientation queue: fuse is legible, only the owning team is unresolved   |
| `/dev/manual-entry` | Hand-author tournament/non-parseable records → `data/manual-videos.json`                             |
| `/dev/evo-review`   | Complete the champions on Evo broadcast VODs the extractor couldn't read → `data/manual-videos.json` |

### `/dev/fuse-review`

One video at a time, keyboard-driven, covering all three ways a fuse can be
missing. It shows the full HUD strip (both pills **and** both nameplates) with a
frame cycler, plus zoomed crops of each pill, then a fuse picker per
**title-ordered team** — labeled with player names and champions, because screen
side is _not_ title order, which is the whole reason orientation is hard.

| case                     | what you do                  | what lands in `overrides.json`          |
| ------------------------ | ---------------------------- | --------------------------------------- |
| missing / low-confidence | pick a fuse per team         | `teams[i].fuse`, `fusesUnordered:false` |
| one side unreadable      | pick one, mark the other `0` | the other side stays `null`             |
| can't tell which side    | set both, press `u`          | both set + `fusesUnordered:true`        |

That's the same contract `--promote-lows` writes, so hand verdicts and promoted
ones are indistinguishable downstream. Keys: `1`–`8` set the focused row's fuse,
`0` marks it unreadable, `↑↓`/tab switch rows, `←→` cycle frames, `g` accepts the
detector's rejected guess, `u` toggles unordered, `⏎` saves and jumps to the next
open item, `s`/`[`/`]` navigate, `?` shows the legend. A cell strip at the top
tracks every item's state and jumps on click.

Only ids in the current gap report are writable, fuse ids are validated against
the registry, and clearing both sides removes the entry (or nulls the fuses when
it also carries a title-parse correction). Skips are deliberately **not**
persisted — only real assignments touch the repo.

The 63 gaps outstanding when this screen landed are now all resolved (63 new
`overrides.json` entries, every one with both sides attributed). The fixed merge
order means those verdicts survive the daily cron like any other override.

### `/dev/evo-review`

The champion-completion workbench for @EvoEvents footage, where the titles state
players, game and round but never a character.

`npm run data:extract` reads the four champions off the broadcast HUD
(`scripts/hud-read.ts`) and leaves its proposal in `cache/evo/extracted.json`;
this page shows that proposal beside what `data/manual-videos.json` already holds
and lets you settle the difference. It is not optional polish — **half the corpus
cannot be read automatically** (see below), so this is where those records
actually get completed.

| case                      | what you do                          | what lands in `manual-videos.json` |
| ------------------------- | ------------------------------------ | ---------------------------------- |
| extractor read both sides | check it, press `a` then `s`         | both sides' `characters`           |
| extractor read one side   | accept it, click the other side      | both sides' `characters`           |
| no read (the Latin half)  | read the HUD off the frame and click | both sides' `characters`           |
| sides look swapped        | press `⇄ swap sides`, then save      | the two lists exchanged            |

Keys: `←→` move between videos, `[`/`]` cycle frames, `a` accepts the proposal,
`d` jumps to the next disputed verdict, `⏎` jumps to the next incomplete one, `s`
saves. The cell strip tracks every video: **fill** is save state, **border** is
whether the extractor disagrees with what's saved — two independent facts, so
they get two channels.

Champions are clicked as a **set-level union** — every champion that side fielded
across the whole set, any length — matching the convention `manual-videos.json`
documents. Ids are validated against `data/characters.json`, the id must already
exist in the file, and a save clears the entry's `todo` marker.

**Measured, 2026-08-08**, against 21 hand labels captured before scoring
(`npm run data:snapshot-labels` → `cache/evo/ground-truth.json`, which the scorer
reads instead of the live file so a completion pass cannot grade its own work):

|                       | both sides exact | per side      | fabrications |
| --------------------- | ---------------- | ------------- | ------------ |
| katakana (Evo Japan)  | 9/10 · 90.0%     | 19/20 · 95.0% | 0            |
| latin (Evo Las Vegas) | 4/11 · 36.4%     | 13/22 · 59.1% | 0            |
| all                   | 13/21 · 61.9%    | 32/42 · 76.2% | **0**        |

At n=21 the percentage is coarse, so the bar is qualitative and it is met: **zero
fabrications**, and **100% precision at every confidence threshold** — everything
the extractor auto-accepted was correct, 8 of 21 at the 0.90 gate. Every miss is
an omission, and they concentrate in the Latin half exactly as the font wall
predicts. Numbers are for the whole set; the blind subset (17 videos whose frames
were never displayed during recon) scores 10/17, and that is the row to trust.

**Side resolution: 18/18.** `resolveSide` reads which titled side sits on screen
left off the broadcast banner, and agrees with the labels on every video that
carries a signal, including both reversals. The ground-truth title-order defect
rate here is **2/18 (11.1%)**, close to SF6's 12.8% and well below Tekken's 37.7%
— but it is not zero, which is the whole reason the side is read rather than
assumed. It also earned its keep: `f2KZcuecUe0` shipped with its two sides
swapped in both the champion and fuse columns, and the extractor flagged it.

**Fuse column, validated.** All 42 sides were read off the pill by hand into
`data/fuse-validation-evo.json`: **38 confirmed as stored, 2 corrected** (both the
`f2KZcuecUe0` swap). The near-uniform `freestyle` that looked statistically like an
unvalidated default (p ~ 8e-7 against the _online_ detector-confident base rate)
turned out to be real — top-level tournament play skews that hard, and the online
population was the wrong null.

**Why half the corpus is manual.** Evo Japan renders the nameplates in katakana
and `tesseract`'s `jpn` model reads them at 75–100% of HUD-bearing frames. Evo Las
Vegas renders them in 2XKO's Latin display face, and that face defeats OCR: a
clean, human-legible `AHRI` returns `V-V.JI`, measured across four thresholds,
four page-segmentation modes, whitelist on and off, ink-trim, glyph-height
normalization, six shear angles and the VS screen at three times the size. `TEEMO`
reads; `AHRI` never does. It is specific letterforms, not preprocessing.

> **Documented follow-up, not built.** The roster is a closed set of ~15 champions
> in a fixed nameplate font, which is the case template matching is best at —
> auto-rendering each champion's name in that font and matching by dHash would
> read what tesseract cannot, and would extend by itself when a DLC champion
> lands. The shipped `assets/name-templates/*.png` are not that: they are raw HUD
> crops with player handles baked in (`CAITLYN Humbleger`, `Opal AHRI`), one is
> blank, and they score 12–20% top-1. The split ships as-is; this is the escape
> hatch if the Latin half ever becomes worth automating.

### Fuses on tournament footage

Evo records carry a **null** fuse column, deliberately, and `npm run data:evo-fuses`
is the thing that will eventually fill it.

The pill itself transfers fine — `data/fuse-regions.json`'s rects land on it once
they are pushed through the video's measured framing (the Evo overlay insets the
game feed by a per-video amount; `normalizeFraming` recovers it from the health
bar's outer edges). What does **not** transfer are the templates: the overlay
_redraws_ the pill rather than scaling it, so a direct-feed template hashes
against it at `struct` 26–30 with a ceiling of 30 — legible to a human,
structurally unrecognised. Measured against the pixels, the direct-feed set read
FREESTYLE/FREESTYLE as `2x-assist`/`2x-assist` and 2X ASSIST/2X ASSIST as
`double-down`/`double-down`, one of them _confidently_.

The fix is the same one this detector has always used for a new capture style:
template it from its own frames, as `assets/fuse-templates/<fuse>-evo.png`. Two
are cut (`freestyle`, `2x-assist`) and they work — the videos they came from went
from wrong to right at `struct` 14.

**The runner refuses to write until all six active fuses have an `-evo` template.**
An absent class cannot abstain: every class competes, so a pill whose own template
is missing is forced into the nearest one present. That is fabrication, not partial
coverage. Cut the remaining four (`double-down`, `juggernaut`, `sidekick`,
`teamfight`) opportunistically as future corpus frames show them confirmed by eye,
and the gate permits writes as coverage grows.

> **The `-evo` templates are opt-in (`loadPillTemplates(true)`), and stay that way.**
> Folding them into the shared set measures _better_ on `data/fuse-validation.json`
> — 14 disagreements down to 11, two `low` reads promoted — but it also introduces
> one new error, a teamfight side reading as `2x-assist`. That trade is not taken
> as a side effect of tournament work, for two reasons. The **98.75% is a published
> property of a specific template configuration**, so widening the set does not
> improve that number, it invalidates it. And the regression is fabrication-class —
> a confident wrong id on validated ground truth — bought with promotions, which
> are not commensurable: a promotion leaves a read a human can still fix from the
> review queue, a fabrication ships a false fuse nothing flags. If the net win is
> ever worth taking, it is taken deliberately: a re-validation session over the
> full 5,415 with the widened set, every disagreement adjudicated, and a new
> published figure.

## New-champion runbook

1. Add the champion to `data/characters.json` (id, name, aliases; leave
   `portrait`/`splash`/`accent` null).
2. Add the accent token `--champ-<id>` to `design/handoff/tokens.css` (the design
   source of truth) **and** the matching entry to `accents` in
   `app/app.config.ts`, which is what the engine actually reads.
3. Run `npm run data:champions` — downloads portrait + splash (1600w/800w)
   from the official site and reconciles the accent.
4. Re-run `npm run data:parse` and check `data/report.md`: a spike in
   low-confidence records is the built-in alert that titles mention a champion
   the registry doesn't know yet.
5. Commit + push (redeploys).

## Post-v1 notes

- **Slim videos index**: `videos.json` is ~6.1 MB raw (~450 KB compressed; it
  roughly doubled when the Best Replays channel was added) and grows a few MB/year
  at current upload rates. The growth path is a slim browse index (id, teams,
  season, type, publishedAt, viewCount, duration) fetched first, with full records
  hydrated per-video on modal open. The client-fetched `replays.json` is ~2.1 MB.
- **VideoObject structured data**: the site ships page-level JSON-LD
  (`WebSite`/`Organization`/`BreadcrumbList`/`CollectionPage`) but deliberately
  no `VideoObject` — video metadata is client-fetched, so crawlers wouldn't see
  it. Revisit together with the slim index (prerendering per-video pages or
  inlining top-N records).
- **Patch-version enrichment**: the in-game replay theater renders the build/
  patch string bottom-center (e.g. `1.1.2 rls-patch-1-1-2 … 2026.01.27`) —
  readable by the same frame pipeline; would fill the patch field's 0%.
- **Nameplate champion recovery**: HUD nameplates carry each team's champions
  as clean text — the fuse pipeline already reads them for side orientation,
  and they could recover under-reported titles (e.g. Juggernaut teams listed
  with one champion) beyond the hand-verified title-parse overrides shipped so
  far. `/dev/fuse-review` already puts those nameplates in front of a human;
  a champion-recovery mode would be a natural extension of the same screen.

## Tech stack & engineering notes

For engineers reading the source — the stack, and the decisions worth knowing.

### Stack

Shape only; the engine's [`STACK.md`](https://github.com/joeycf/replay-engine/blob/main/STACK.md)
is the single source of pinned versions.

| layer         | choice                                         | notes                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework     | **Nuxt 4** (Vue 3, `<script setup>`)           | `ssr: true` for prerender fidelity, but the output is **100% static** — `nitro` `vercel-static` preset, `nuxt generate`                                                                                                        |
| Base layer    | **replay-engine**, pinned by tag               | `extends:` a git layer (`install: true` is required, or its runtime deps don't resolve). `ENGINE_PATH` swaps in a local checkout for co-development                                                                            |
| Language      | **TypeScript** end to end                      | dual typecheck: `nuxt typecheck` (vue-tsc) for the app, `tsc -p tsconfig.pipeline.json` for the pipeline; shared types in `types/index.ts`                                                                                     |
| Styling       | **Tailwind CSS v4**, via the engine layer      | no `tailwind.config.js` — the 2XKO skin is `app/assets/theme.css`, which loads after the engine CSS and shadows its defaults. Champion accents stay sourced from `design/handoff/tokens.css` (`scripts/champions.ts` reads it) |
| Fonts         | **`@fontsource/*`**, imported in `theme.css`   | Chakra Petch / Barlow / JetBrains Mono, Vite-processed and hashed — no runtime CDN, no `public/` `url()`s                                                                                                                      |
| Animation     | **anime.js v4**                                | reveal-on-scroll (`useReveal`) and animated stat bars                                                                                                                                                                          |
| Images        | **sharp**                                      | champion art (portrait + 1600w/800w splash), OG cards, fuse frame crops                                                                                                                                                        |
| Data pipeline | standalone **`tsx`** scripts                   | no build step; YouTube Data API v3 for metadata, `yt-dlp` + `ffmpeg` for the CV fuse pipeline                                                                                                                                  |
| Tests         | **playwright-core** (bespoke harness)          | not `@playwright/test` — see below                                                                                                                                                                                             |
| Analytics     | Vercel **Web Analytics** + **Speed Insights**  | inherited from the engine; client-only, inert outside production                                                                                                                                                               |
| Host          | **Vercel** Build Output API (`.vercel/output`) | daily GitHub Actions cron for the data refresh                                                                                                                                                                                 |
| Node          | **24** (`engines.node: ">=24 <25"`)            | matched by the data-refresh Action                                                                                                                                                                                             |

### Things worth knowing

- **The URL is the only state store.** Filters, sort, search, and the `?v=…`
  video modal all live in the query string — no Pinia/Vuex. Every view is
  shareable and deep-linkable, the back button is correct, and the engine's
  `app/router.options.ts` suppresses scroll on query-only navigations so
  filtering never jumps the page.
- **Two-tier data loading.** The small registries (champions/players/stats/
  fuses) are static-imported and prerendered into the HTML; the ~2.1 MB
  `replays.json` is copied to `public/data/` and fetched client-side only on the
  pages that need it — **never bundled**, so the JS payload stays flat as the
  catalog grows. The 6.1 MB rich `videos.json` stays pipeline-side and never
  ships.
- **The theme must stay in `:root`.** `app/assets/theme.css` declares the 2XKO
  palette as plain `:root` custom properties, never `@theme`. Under `@theme` the
  dev server still looks correct while the production build drops the tokens —
  a failure that only shows up after deploy. Removing the file entirely should
  drop the site to the neutral engine look; that's the override-contract proof.
- **Zero-secret static deploy.** The whole site builds from committed JSON with
  no API keys at deploy time; the YouTube key only ever lives in local `.env`
  and GitHub Actions secrets, never on Vercel.
- **LiteYouTube facade.** `LiteYouTube.vue` renders a click-to-load thumbnail
  stand-in for the embed, so a grid of dozens of replays doesn't mount dozens
  of YouTube iframes.
- **Channel-aware title parser.** The three source channels use different
  delimiter conventions (Best Replays joins duos with `&` and prefixes some
  titles `NEW PATCH`); `scripts/channels.ts` configures the parser per
  channel, with fuzzy champion matching + a confidence score. Low-confidence
  parses surface in `data/report.md` as a built-in alert (see the new-champion
  runbook).
- **Fuses are recovered with computer vision, not scraped.** None of the channels
  label fuses in titles (0% across the catalog), so `scripts/fuses.ts` reads
  them straight off the match-HUD pills — hue-vote + perceptual-hash
  classification with nameplate orientation for side attribution, 98.75%
  validated. It's the most involved corner of the codebase; the
  [Fuse detection](#fuse-detection-local-cv-pipeline) section above is the full
  pipeline.
- **Detections survive the cron.** The daily refresh regenerates
  `videos.json`/`stats.json` from scratch, but the fixed merge order (title
  parse → fuse merge → `manual-videos.json` → `overrides.json`) means
  locally-committed CV detections and the 139 hand overrides always re-apply.
  It's why every curation tool writes to `overrides.json` rather than editing
  `videos.json` in place — the latter would be erased by the next cron run.
- **Data-derived tests, not fixtures.** `scripts/e2e.ts` spins up its own
  Node `http` static server over the generated output and drives it with
  Playwright-core; every numeric expectation is **computed Node-side from the
  committed JSON**, so a data refresh can never silently break the assertions.
  It also shell-tests the cron commit-guard (a timestamp-only `report.md` diff
  must not trigger a commit).
- **Accessibility in the tokens.** `ink.muted` is deliberately lifted from the
  design spec's value to clear WCAG AA 4.5:1 for small text — the contrast fix
  lives in the token, not in per-component overrides.

## Roadmap

Planned directions for future versions. Priority depends on community interest and
my ability to complete them unless it is something outside my control (like Riot's API).

### Data & ingestion

- ~~**Streamlined manual entry for tournament and non-parseable footage.**~~ **Shipped.**
  `data/manual-videos.json` + the `/dev/manual-entry` authoring UI hand-author matches
  whose titles don't follow the standard `player (champ-champ) vs player (champ-champ)`
  format (e.g. Evo Top 8 VODs, which name players and rounds but not champions). They
  merge in `data:parse` and slot into the site identically to parsed matches, with a
  "tournament" type and round labels. Remaining work is content, not plumbing:
  backfilling the tournament catalog.
- **Automatic parsing of full-length tournament streams.** Long single-video streams
  that contain many matches back to back, auto-segmented into individual match records.
  This is a hard problem: match boundaries, players, and champions all have to be read
  from the video itself rather than the title. Likely an extension of the existing
  computer-vision pipeline (the same approach already used to read fuses off the
  in-game HUD) detecting VS/loading screens to find match starts and reading the
  nameplates and champions from those frames.

  **Partly answered from the other direction (2026-08-28), without solving it.**
  The `replayTheater` source ingests 888 tournament sets that people had already
  segmented by hand — 64 longform VODs, a median of 17 sets each — so the site
  now carries segmented tournament footage. The CV problem is untouched: this is
  someone else's segmentation, it only covers events they indexed, and every
  timestamp traces back to a human. What it does prove is the schema half —
  records keyed `${videoId}@${startSeconds}`, with playback that starts at the
  right moment — so a future CV segmenter has somewhere to put its output.

- ~~**Additional replay sources with duplicate prevention.**~~ **Shipped — the 2XKO
  Best Replays channel is ingested, and `scripts/replay-dupes.ts` (`npm run
data:replay-dupes`) is the read-only audit that catches the same match re-uploaded
  across channels.** It keys on a side-agnostic (players + champions) signature, then
  adjudicates with exact video duration (the only signal that survives cross-channel,
  since each channel picks its own thumbnail) plus a thumbnail perceptual hash as an
  intra-channel corroborator. Confirmed pairs become `exclude` entries in
  `overrides.json`; nothing is deleted automatically. What stays ongoing is running the
  audit after a fetch and approving new duplicates.
- ~~**Recovering the currently un-detected fuses.**~~ **Shipped — coverage is ~98%.**
  The retry pass (`--promote-lows`) plus the manual-review path (`/dev/fuse-review`)
  keep the gap small. What stays ongoing is _keeping_ it there: newly-ingested videos
  (e.g. the Best Replays backfill) arrive fuse-less until the next local `data:fuses`
  run, so the gap report is a maintenance check rather than a backlog.

### Riot API integration

- **Integrate official Riot data if/when a 2XKO API becomes available.** Riot does not
  currently offer a 2XKO developer API. If they do, potential uses include verified
  player identities and official champion assets, and possibly richer match data than
  can be read from video. The pipeline currently already leaves room for this. Champion
  and player registries are structured so official data could enrich or replace the
  derived-from-video approach.

### Features & UX

- **Player and champion detail improvements** — win/loss records where derivable,
  head-to-head views between two players, and links out to players' own channels/socials.
- **Matchup explorer** — filter to a specific champion-pair-vs-champion-pair matchup and
  see every recorded instance, useful for studying a particular team's answers.
- **Shareable filtered views and per-match deep links** — already URL-driven, but
  surfacing "copy link to this filter/match" would make sharing specific study material
  easier.

> Feature requests and bug reports are welcome via Issues.

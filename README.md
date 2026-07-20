# 2XKO Replay Database

This is my passion project first step to creating a competitive replay database
for multiple games. Beginning with my current favorite fighting game **2XKO** replay footage of
2,900+ pro and high-level replays, filterable by champion, team pairing, player,
season, channel, and fuse, with a stats dashboard (champion usage, fuse usage,
top pairings, synergy matrix, meta over time, fuse-era shift) and per-champion / per-player pages.

The app is a **thin layer over [replay-engine](https://github.com/joeycf/replay-engine)**
(pinned by tag in `nuxt.config.ts`): the engine owns the generic replay-database
UI and data contract, and this repo supplies the 2XKO data pipeline, theme, and
game-specific extensions (fuses above all). It ships under `/2xko/` behind the
replaydatabase.com shell.

The footer links a [Buy Me a Coffee](https://buymeacoffee.com/whatdaflip) page
(`BMC_URL` in the engine's `SiteFooter.vue`) for anyone who wants to support hosting.

## Architecture

```
YouTube Data API v3
      │  scripts/fetch.ts        (raw dumps → raw/*.json, gitignored)
      ▼
scripts/parse.ts                 (channel-aware title parser + aggregates)
      │   merge order: title parse → CV fuses → manual-videos → overrides
      ▼
data/videos.json                 (RICH records — the pipeline substrate;
      │                           input to the fuse CV + dev curation tools)
      │  scripts/emit.ts         (runs at the end of every parse)
      ▼
data/replays.json + stats.json   (GENERIC engine-contract files)
      │
      └─ committed ──►  Nuxt 4 static site (nuxt generate, vercel-static)
                          extends replay-engine layer
                                  │
                                  ├─ registries (champions/players/stats/fuses)
                                  │    → static imports, prerendered into HTML
                                  └─ replays.json (~1.3 MB) → copied to
                                       public/data/ at build, fetched
                                       client-side on Browse and entity pages
                                       only (never bundled)
```

Two schemas, deliberately: `videos.json` (3.6 MB, rich — fuses per team, parse
confidence, match type) never reaches the browser; `emit.ts` maps it onto the
engine's generic `Replay[]` contract, with the 2XKO fuse fields riding along as
extensions the engine ignores.

- **~750 routes prerendered**: Browse shell, Stats, champions and players
  indexes, 15 champion pages, all 727 player pages, plus `404.html`.
- The engine's `modules/static-artifacts` emits **`sitemap.xml`**, **`robots.txt`**,
  the web manifest and `404.html` from the _real_ prerendered route list (the
  old `build:before` sitemap hook and `postgenerate.mjs` are retired). Per-page
  **JSON-LD** (`WebSite` + `SearchAction`, `Organization`, `BreadcrumbList`,
  `CollectionPage`) is prerendered into the HTML.
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

| script                                           | what it does                                                                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `generate` / `preview` | Nuxt app (generate = full static build)                                                                                                                                                            |
| `npm run data:fetch`                             | Pull every upload from both YouTube channels → `raw/` (needs `YT_API_KEY`)                                                                                                                         |
| `npm run data:parse`                             | Parse titles/descriptions → `data/videos.json`, `players.json`, `report.md`; calls `data:emit` at the end                                                                                          |
| `npm run data:emit`                              | Map the rich `videos.json` onto the engine contract → `data/replays.json`, `stats.json` (+ the `public/data/` copy). Deterministic, no YouTube access — safe to re-run standalone                  |
| `npm run data:build`                             | fetch + parse                                                                                                                                                                                      |
| `npm run data:champions`                         | Champion art + accents (portraits, splash 1600w + 800w, token accents) → `public/img/champions/`, `champions.json`                                                                                 |
| `npm run data:fuses`                             | **Local-only** CV fuse detection (see below) → `data/fuses-detected.json`                                                                                                                          |
| `npm run data:fuse-gaps`                         | **Local-only** read-only gap diagnostic — buckets every still-fuse-less video (unavailable/low/none/pending/anomaly) → `cache/fuse/review/fuse-gaps.{md,json}` (feeds the `/dev/fuse-gaps` viewer) |
| `npm run typecheck`                              | App (`nuxt typecheck`) **and** pipeline (`tsc -p tsconfig.pipeline.json`) — both must pass                                                                                                         |
| `npm run lint` / `lint:fix`                      | ESLint over the whole repo                                                                                                                                                                         |
| `npm run format` / `format:check`                | Prettier                                                                                                                                                                                           |
| `npm run test:e2e`                               | Playwright e2e suite against the generated output (run `npm run generate` first)                                                                                                                   |
| `npx tsx scripts/og.ts`                          | Regenerate the default OG card (`public/og-default.png`)                                                                                                                                           |

Verification: `npm run typecheck` and `npm run lint` must pass, and
`npm run test:e2e` must be green against a fresh `npm run generate`.

## Vercel

Connect the repo and use:

| setting               | value                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework preset      | **Nuxt**                                                                                                                                             |
| Build command         | `npm run generate`                                                                                                                                   |
| Output directory      | _(auto — Build Output API, `.vercel/output`)_                                                                                                        |
| Node.js version       | 22+ (24 recommended — the data-refresh Action runs 24)                                                                                               |
| Environment variables | `NUXT_PUBLIC_SITE_URL` = your production URL (used for canonical/OG/sitemap absolute URLs). **No `YT_API_KEY`** — the pipeline never runs on Vercel. |

Deploys are triggered by pushes — including the daily data-refresh commit.

## Analytics

Both are Vercel-native, inert outside production, and inject nothing into the
prerendered HTML (they attach client-side):

- **Web Analytics** — `@vercel/analytics`, registered as a Nuxt module.
- **Speed Insights** — `@vercel/speed-insights` via a client-only plugin
  (`app/plugins/speed-insights.client.ts`) at `sampleRate 0.5`, so tournament-
  weekend traffic spikes stay under the Hobby plan's monthly event cap while
  Core Web Vitals stats stay sound.

## Daily data refresh

`.github/workflows/data-refresh.yml` runs daily at 06:17 UTC (and via
_Run workflow_) on Node 24: `npm run data:build` with `YT_API_KEY` from repo
**Actions secrets**, then commits
`data/{videos,replays,stats,players}.json` + `report.md` **only if changed**
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
  [Dev curation tooling](#dev-curation-tooling-local-only). As of the
  2026-07-20 refresh the automated and manual passes together have closed the
  backlog: **100% coverage, 2,952 / 2,952**. Expect it to dip between a data
  refresh and the next local `data:fuses` run.
- Run it **locally, weekly-ish**, and commit the refreshed
  `fuses-detected.json`; the daily Action folds it in automatically. The
  Action itself **never** runs yt-dlp — datacenter IPs are routinely blocked.
- If YouTube throws a bot-check locally, retry with
  `yt-dlp --cookies-from-browser <browser>`.
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

## Dev curation tooling (local-only)

Four pages under `/dev` do the hand-curation the automated pipeline can't.
All of them are **`nuxt dev` only**: the page and every `/api/dev/*` route it
uses guard on `import.meta.dev` and 404 otherwise, `nitro.prerender.ignore`
skips the whole `/dev` prefix, and nothing public links to them. They read and
write the committed JSON directly — there is no database.

| page                | what it's for                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `/dev/fuse-review`  | **The manual fuse workbench.** Adjudicate every gap the CV couldn't settle → `data/overrides.json` |
| `/dev/fuse-gaps`    | Read-only dashboard over the gap report — bucket/era filters, pill crops, in-app playback          |
| `/dev/fuse-orient`  | The narrow `--promote-lows` orientation queue: fuse is legible, only the owning team is unresolved |
| `/dev/manual-entry` | Hand-author tournament/non-parseable records → `data/manual-videos.json`                           |

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

## New-champion runbook

1. Add the champion to `data/champions.json` (id, name, aliases; leave
   `portrait`/`splash`/`accent` null).
2. Add the accent token: `--champ-<id>` in `design/handoff/tokens.css` **and**
   the `champ.<id>` color in `tailwind.config.js`.
3. Run `npm run data:champions` — downloads portrait + splash (1600w/800w)
   from the official site and reconciles the accent.
4. Re-run `npm run data:parse` and check `data/report.md`: a spike in
   low-confidence records is the built-in alert that titles mention a champion
   the registry doesn't know yet.
5. Commit + push (redeploys).

## Post-v1 notes

- **Slim videos index**: `videos.json` is ~3.5 MB raw (~350 KB compressed) and
  grows ~3.5 MB/year at current upload rates. The growth path is a slim
  browse index (id, teams, season, type, publishedAt, viewCount, duration)
  fetched first, with full records hydrated per-video on modal open.
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
| Analytics     | Vercel **Web Analytics** + **Speed Insights**  | client-only, inert outside production                                                                                                                                                                                          |
| Host          | **Vercel** Build Output API (`.vercel/output`) | daily GitHub Actions cron for the data refresh                                                                                                                                                                                 |

### Things worth knowing

- **The URL is the only state store.** Filters, sort, search, and the `?v=…`
  video modal all live in the query string — no Pinia/Vuex. Every view is
  shareable and deep-linkable, the back button is correct, and
  `app/router.options.ts` suppresses scroll on query-only navigations so
  filtering never jumps the page.
- **Two-tier data loading.** The small registries (champions/players/stats/
  fuses) are static-imported and prerendered into the HTML; the ~1.3 MB
  `replays.json` is copied to `public/data/` and fetched client-side only on the
  pages that need it — **never bundled**, so the JS payload stays flat as the
  catalog grows. The 3.6 MB rich `videos.json` stays pipeline-side and never
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
- **Channel-aware title parser.** The two source channels use different
  delimiter conventions; `scripts/channels.ts` configures the parser per
  channel, with fuzzy champion matching + a confidence score. Low-confidence
  parses surface in `data/report.md` as a built-in alert (see the new-champion
  runbook).
- **Fuses are recovered with computer vision, not scraped.** Neither channel
  labels fuses in titles (0% across the catalog), so `scripts/fuses.ts` reads
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
- **Additional replay sources with duplicate prevention.** Bringing in more channels
  and playlists, with reliable de-duplication so the same match appearing on multiple
  channels isn't counted twice. Dedup would key on video identity first, with a fuzzy
  match on (players + champions + approximate date) as a backstop for genuinely
  re-uploaded footage.
- ~~**Recovering the currently un-detected fuses.**~~ **Shipped — coverage is 100%.**
  The retry pass (`--promote-lows`) plus the manual-review path (`/dev/fuse-review`)
  closed the last 63 gaps. What stays ongoing is _keeping_ it there: newly-ingested
  videos arrive fuse-less until the next local `data:fuses` run, so the gap report is
  now a maintenance check rather than a backlog.

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

# 2XKO Replay Database

An unofficial fan-made index of competitive **2XKO** replay footage — 2,800+
pro and high-level replays, filterable by champion, team pairing, player,
season, and channel, with a stats dashboard (champion usage, synergy matrix,
meta over time) and per-champion / per-player pages.

> 2XKO Replay Database is an unofficial fan project, not endorsed by or
> affiliated with Riot Games.

## Architecture

```
YouTube Data API v3
      │  scripts/fetch.ts        (raw dumps → raw/*.json, gitignored)
      ▼
scripts/parse.ts                 (channel-aware title parser + aggregates)
      │
      ▼
data/*.json  ── committed ──►  Nuxt 4 static site (nuxt generate, vercel-static)
                                  │
                                  ├─ registries (champions/players/stats/fuses)
                                  │    → static imports, prerendered into HTML
                                  └─ videos.json → copied to public/data/ at
                                       build, fetched client-side on Browse and
                                       entity pages only (never bundled)
```

- **~735 routes prerendered**: Browse shell, Stats, 15 champion pages, all
  ~714 player pages, plus `404.html`.
- The site builds **purely from committed JSON** — no API keys at deploy time.

## Setup

```sh
npm install
cp .env.example .env      # add your YouTube Data API v3 key (pipeline only)
npm run dev
```

`.env` is only needed to run the data pipeline locally. The web app never
reads it.

## Scripts

| script | what it does |
|---|---|
| `npm run dev` / `build` / `generate` / `preview` | Nuxt app (generate = full static build) |
| `npm run data:fetch` | Pull every upload from both YouTube channels → `raw/` (needs `YT_API_KEY`) |
| `npm run data:parse` | Parse titles/descriptions → `data/videos.json`, `stats.json`, `players.json`, `report.md` |
| `npm run data:build` | fetch + parse |
| `npm run data:champions` | Champion art + accents (portraits, splash 1600w + 800w, token accents) → `public/img/champions/`, `champions.json` |
| `npm run data:fuses` | **Local-only** CV fuse detection (see below) → `data/fuses-detected.json` |
| `npm run test:e2e` | Playwright e2e suite against the generated output (run `npm run generate` first) |
| `npx tsx scripts/og.ts` | Regenerate the default OG card (`public/og-default.png`) |

Verification: `npx tsc --noEmit` (pipeline) and `npx nuxt typecheck` (app)
must both pass, and `npm run test:e2e` must be green against a fresh
`npm run generate`.

## Vercel

Connect the repo and use:

| setting | value |
|---|---|
| Framework preset | **Nuxt** |
| Build command | `npm run generate` |
| Output directory | *(auto — Build Output API, `.vercel/output`)* |
| Node.js version | 20+ (22 recommended) |
| Environment variables | `NUXT_PUBLIC_SITE_URL` = your production URL (used for canonical/OG/sitemap absolute URLs). **No `YT_API_KEY`** — the pipeline never runs on Vercel. |

Deploys are triggered by pushes — including the daily data-refresh commit.

## Daily data refresh

`.github/workflows/data-refresh.yml` runs daily (and via *Run workflow*):
`npm run data:build` with `YT_API_KEY` from repo **Actions secrets**, then
commits `data/{videos,stats,players}.json` + `report.md` **only if changed**
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
  every run — title parse → fuse merge → `overrides.json` last — so detections
  **survive the daily cron**, which regenerates `videos.json`/`stats.json`
  from scratch.
- Incremental + resumable: only ids missing from the output are processed;
  `--limit N` for smoke tests, `--force` to redo, `--clean` to purge the
  gitignored `cache/fuse/` working dir (~10 GB for the full backlog).
- Run it **locally, weekly-ish**, and commit the refreshed
  `fuses-detected.json`; the daily Action folds it in automatically. The
  Action itself **never** runs yt-dlp — datacenter IPs are routinely blocked.
- If YouTube throws a bot-check locally, retry with
  `yt-dlp --cookies-from-browser <browser>`.
- Review artifacts land in `cache/fuse/review/`: `low-review.md` (every
  low/none with best guess + scores) and `unmatched-pills.png` (montage —
  how a new/rare fuse style gets spotted, templated from those very frames,
  and re-run incrementally).

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

- **Slim videos index**: `videos.json` is ~3.3 MB raw (~350 KB compressed) and
  grows ~3.5 MB/year at current upload rates. The growth path is a slim
  browse index (id, teams, season, type, publishedAt, viewCount, duration)
  fetched first, with full records hydrated per-video on modal open.
- **VideoObject structured data**: deliberately absent in v1 — video metadata
  is client-fetched, so crawlers wouldn't see it. Revisit together with the
  slim index (prerendering per-video pages or inlining top-N records).
- **Patch-version enrichment**: the in-game replay theater renders the build/
  patch string bottom-center (e.g. `1.1.2 rls-patch-1-1-2 … 2026.01.27`) —
  readable by the same frame pipeline; would fill the patch field's 0%.
- **Nameplate champion recovery**: HUD nameplates carry each team's champions
  as clean text — the fuse pipeline already reads them for side orientation,
  and they could recover under-reported titles (e.g. Juggernaut teams listed
  with one champion) beyond the five hand-verified overrides shipped in v1.

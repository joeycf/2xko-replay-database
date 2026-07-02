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
| `npx tsx scripts/og.ts` | Regenerate the default OG card (`public/og-default.png`) |

Verification: `npx tsc --noEmit` (pipeline) and `npx nuxt typecheck` (app)
must both pass.

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
Champion art is deliberately not part of the daily run.

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
- **Fuse detection (Phase 7)**: fuse fill-rate is 0% — neither channel labels
  fuses in titles/descriptions. The pipeline already parses fuses end-to-end
  (registry, per-team fields, `overrides.json` patches), so a computer-vision
  pass over the character-select/loading frames can fill it without schema
  changes.

import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinURL } from 'ufo';

import charactersData from './data/characters.json';
import playersData from './data/players.json';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const engineDir = fileURLToPath(
  new URL(process.env.ENGINE_PATH || '../replay-engine', new URL('.', import.meta.url)),
);

// Prerender EVERYTHING entity-shaped: all 15 champions + every player profile
// (featured-but-unverified players must not 404 on static hosting), plus the
// core routes. The engine seeds '/', '/health', '/not-found' itself and emits
// sitemap/robots/manifest/404.html from the REAL prerendered list
// (modules/static-artifacts) — the old build:before sitemap hook and
// postgenerate.mjs are retired.
const characters = charactersData as { id: string }[];
const players = playersData as { id: string }[];
const appRoutes = [
  '/stats',
  '/champions',
  '/players',
  ...characters.map((c) => `/champions/${c.id}`),
  ...players.map((p) => `/players/${p.id}`),
];

export default defineNuxtConfig({
  // The replay-engine layer: local checkout during co-development
  // (ENGINE_PATH in .env), the pinned tag everywhere else (Vercel leaves
  // ENGINE_PATH unset). Never track a branch — bump the pin deliberately.
  // `install: true` is REQUIRED for git layers: without it the cloned layer
  // gets no node_modules and its runtime deps (@tailwindcss/vite, ufo, …)
  // don't resolve — verified locally by building with ENGINE_PATH unset.
  extends: [process.env.ENGINE_PATH || ['github:joeycf/replay-engine#v0.6.0', { install: true }]],

  compatibilityDate: '2025-07-01',

  // 2XKO lives under /2xko/ behind the shell (replaydatabase.com — the
  // Phase-5 subpath cutover; the shell 301s every legacy root URL here). The
  // env expression is REQUIRED, not decorative: a literal baseURL here shadows
  // the engine's own env read (app config wins the layer merge), and
  // NUXT_APP_BASE_URL alone then flips only the runtime router — prerender
  // seeds stay root-based and every route 404s the build (STACK §5.3 desync,
  // reproduced empirically in Phase 5). The committed default IS the
  // production truth; the env var overrides for special builds (e.g.
  // NUXT_APP_BASE_URL=/ for a root-based local preview).
  app: {
    baseURL: process.env.NUXT_APP_BASE_URL || '/2xko/',
  },

  // The 2XKO theme (palette + self-hosted fonts) — loads after the engine's
  // CSS, so its unlayered :root custom properties shadow the umbrella
  // defaults (README contract; MUST stay :root, never @theme — see theme.css).
  css: ['~/assets/theme.css'],

  nitro: {
    prerender: {
      // The /dev curation pages guard themselves behind import.meta.dev and
      // 404 outside `nuxt dev`; the crawler still discovers them via the app
      // manifest. The shipped build tolerated those 404s with
      // failOnError:false — skipping the paths instead keeps every REAL page
      // failure a hard build error.
      ignore: ['/dev'],
    },
  },

  modules: [
    // Seed the entity routes under the final resolved base (same mechanism as
    // the engine's own seeds — static prerender arrays are not base-prefixed).
    function appPrerenderSeeds(_options, nuxt) {
      nuxt.hook('nitro:init', (nitro) => {
        for (const route of appRoutes) {
          nitro.options.prerender.routes.push(joinURL(nuxt.options.app.baseURL, route));
        }
      });
    },
  ],

  hooks: {
    // The whale file: data/replays.json (committed, pipeline-emitted) →
    // public/data/ (gitignored) for the engine's client fetch. Lives in the
    // BUILD because Vercel never runs the pipeline — it builds from committed
    // JSON, exactly like the shipped videos.json flow.
    'build:before'() {
      const dataDir = join(rootDir, 'public/data');
      mkdirSync(dataDir, { recursive: true });
      cpSync(join(rootDir, 'data/replays.json'), join(dataDir, 'replays.json'));
      console.log('✓ copied data/replays.json → public/data/replays.json');
    },
  },

  typescript: {
    // Typecheck runs explicitly via `npm run typecheck` (vue-tsc + pipeline tsc).
    typeCheck: false,
    // app/app.config.ts lands in the generated NODE tsconfig, which doesn't
    // inherit the engine layer's @engine alias — mirror it for the type-only
    // GameConfig import (erased at build; typecheck is a local operation that
    // assumes the sibling engine checkout per the STACK dev loop).
    nodeTsConfig: {
      compilerOptions: {
        paths: {
          '@engine': [engineDir],
          '@engine/*': [`${engineDir}/*`],
        },
      },
    },
  },
});

import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import championsData from './data/champions.json'
import playersData from './data/players.json'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const SITE_URL = (process.env.NUXT_PUBLIC_SITE_URL ?? 'https://2xko-replay-database.vercel.app').replace(/\/$/, '')

// Prerender EVERYTHING: core routes, all 15 champions, all ~714 players
// (featured-but-unverified players like LightWhisp must not 404 on static
// hosting), plus /404.html for the static host's not-found fallback.
const champions = championsData as Record<string, { id: string }>
const players = playersData as Record<string, { id: string }>
const coreRoutes = ['/', '/stats', '/champions', '/players']
const championRoutes = Object.keys(champions).map((id) => `/champions/${id}`)
const playerRoutes = Object.keys(players).map((id) => `/players/${id}`)
/** public, indexable routes (sitemap) — /health and /404.html excluded */
const publicRoutes = [...coreRoutes, ...championRoutes, ...playerRoutes]

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-01',
  ssr: true,
  modules: ['@nuxtjs/tailwindcss', '@nuxtjs/google-fonts'],

  runtimeConfig: {
    public: {
      siteUrl: SITE_URL,
    },
  },

  hooks: {
    // Build-time artifacts (dev, build, and generate):
    //  • videos.json → public/data/ (client-fetched static asset, never bundled)
    //  • sitemap.xml + robots.txt from the prerender route list
    'build:before'() {
      const pub = join(rootDir, 'public')
      mkdirSync(join(pub, 'data'), { recursive: true })
      cpSync(join(rootDir, 'data/videos.json'), join(pub, 'data/videos.json'))
      console.log('✓ copied data/videos.json → public/data/videos.json')

      const today = new Date().toISOString().slice(0, 10)
      const sitemap =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        publicRoutes
          .map((r) => `  <url><loc>${SITE_URL}${r}</loc><lastmod>${today}</lastmod></url>`)
          .join('\n') +
        `\n</urlset>\n`
      writeFileSync(join(pub, 'sitemap.xml'), sitemap)
      writeFileSync(
        join(pub, 'robots.txt'),
        `User-agent: *\nAllow: /\nDisallow: /health\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
      )
      console.log(`✓ wrote sitemap.xml (${publicRoutes.length} urls) + robots.txt`)
    },
  },

  // Static generation targeting Vercel.
  nitro: {
    preset: 'vercel-static',
    prerender: {
      crawlLinks: true,
      failOnError: false,
      routes: [...publicRoutes, '/health', '/not-found'],
    },
  },

  tailwindcss: {
    cssPath: '~/assets/css/main.css',
    configPath: '~~/tailwind.config.js',
  },

  googleFonts: {
    families: {
      'Chakra Petch': [400, 500, 600, 700],
      Barlow: [400, 500, 600, 700],
      'JetBrains Mono': [400, 500, 700],
    },
    display: 'swap',
    preconnect: true,
    download: true, // self-host fonts at build time
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en', class: 'dark' },
      title: '2XKO Replay Database',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content: 'An unofficial fan-made index of 2XKO high-level and pro replay footage.',
        },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },

  // App type-checking runs via `nuxt typecheck` (vue-tsc); the data pipeline is
  // checked separately by `tsc --noEmit` against the root tsconfig.
  typescript: { typeCheck: false },
})

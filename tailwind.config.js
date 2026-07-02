/** ============================================================
 *  2XKO Replay Database — Tailwind config (Nuxt 4, Tailwind v3)
 *  Based on design/handoff/tailwind.config.js. Pairs with the
 *  tokens imported via app/assets/css/main.css. Content globs
 *  point at app/ because Nuxt 4 keeps app code there.
 *  ============================================================ */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./app/**/*.{vue,js,ts}'],
  theme: {
    extend: {
      colors: {
        inset: '#07080B',
        base: '#0A0B0F',
        surface: '#12141B',
        elevated: '#1A1D26',
        accent: {
          DEFAULT: '#FF2E88',
          hover: '#FF529E',
          active: '#E11E71',
          dim: 'rgba(255,46,136,0.14)',
        },
        accent2: '#38CFFF',
        danger: '#F0463F',
        warning: '#F5B33C',
        success: '#35D07A',
        ink: {
          primary: '#F4F5F8',
          secondary: '#A8AEBE',
          // a11y: lifted from the design's #6B7185 (3.9:1 on cards) to meet
          // WCAG AA 4.5:1 for small text — 6.1:1 on #0F1118.
          muted: '#8B93A8',
          faint: '#474C5C',
        },
        // Per-champion accent slot (mirrors tokens.css --champ-*)
        champ: {
          ahri: '#FF5DA2', akali: '#35D98A', blitzcrank: '#FFC24B',
          braum: '#58C7E8', caitlyn: '#B98AE0', darius: '#F0463F',
          ekko: '#1FE0D4', illaoi: '#CE9138', jinx: '#5B8CFF',
          senna: '#97DB4A', teemo: '#E27E3C', thresh: '#49E0A6',
          vi: '#FF6F61', warwick: '#7A6BE8', yasuo: '#52C4C4',
        },
      },
      fontFamily: {
        display: ['Chakra Petch', 'system-ui', 'sans-serif'],
        sans: ['Barlow', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        hero: ['clamp(44px,6vw,72px)', { lineHeight: '0.92', letterSpacing: '-0.02em' }],
        d1: ['40px', { lineHeight: '1.05' }],
        d2: ['30px', { lineHeight: '1.1' }],
        title: ['22px', { lineHeight: '1.2' }],
        sub: ['18px', { lineHeight: '1.3' }],
        body: ['14px', { lineHeight: '1.5' }],
        'data-xl': ['32px', { lineHeight: '1' }],
        label: ['11px', { lineHeight: '1', letterSpacing: '0.18em' }],
      },
      borderRadius: { xs: '2px', sm: '3px', md: '5px', lg: '8px' },
      boxShadow: {
        card: '0 4px 16px rgba(0,0,0,.45)',
        lg: '0 16px 48px rgba(0,0,0,.6)',
        modal: '0 24px 80px rgba(0,0,0,.7)',
        glow: '0 0 0 1px rgba(255,46,136,.5), 0 8px 32px rgba(255,46,136,.28)',
      },
      transitionTimingFunction: { snap: 'cubic-bezier(.16,1,.3,1)' },
      transitionDuration: { 250: '250ms', 360: '360ms', 640: '640ms' },
      spacing: { 18: '4.5rem', 22: '5.5rem' },
    },
  },
  plugins: [],
}

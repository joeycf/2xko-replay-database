import type { Champion } from '~~/types'

/** Seconds → "7:01" or "1:02:03". */
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 12400 → "12.4k" (design's vwf), 1200000 → "1.2m". */
export function formatViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

/** Relative label from an ISO date — days like the design, months/years beyond. */
export function relativeDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return 'today'
  if (days === 1) return '1 day ago'
  if (days < 31) return `${days} days ago`
  const months = Math.floor(days / 30.44)
  if (months < 12) return `${months} mo ago`
  return `${Math.floor(days / 365.25)} yr ago`
}

/** Case + diacritic-insensitive normalization for search matching. */
export function normalizeText(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Two-letter badge initials per the design system: a two-letter alias wins
 * (warwick → "WW", vi → "VI"), otherwise the first two letters of the name
 * (ahri → "AH", blitzcrank → "BL", braum → "BR").
 */
export function championInitials(champion: Pick<Champion, 'name' | 'aliases'>): string {
  const two = champion.aliases.find((a) => a.length === 2)
  return (two ?? champion.name.slice(0, 2)).toUpperCase()
}

/** The design's champion tile gradient: accent → 20%-alpha accent at 150deg. */
export function champGradient(accent: string | null | undefined): string {
  const c = accent ?? '#3a3f4e'
  return `linear-gradient(150deg, ${c}, ${c}33)`
}

/** "S2" / "BETA" (season === null → pre-Season-0 beta footage). */
export function seasonLabel(season: number | null): string {
  return season === null ? 'BETA' : `S${season}`
}

/** "ranked" → "Ranked". */
export function matchTypeLabel(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1)
}

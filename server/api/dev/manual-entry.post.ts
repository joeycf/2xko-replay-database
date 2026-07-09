import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Champion, Fuse, ManualVideosFile } from '~~/types'

// Dev-only: persists ONE entry's teams[].characters back into
// data/manual-videos.json — the only file this endpoint may touch — and clears
// its todo marker. The id must already exist in the manual file (ids from
// videos.json or anywhere else are rejected), champion ids are validated
// against the registry, and re-saving overwrites. data:parse is deliberately
// NOT run here; the user runs it after authoring (it derives allCharacters/
// allPlayers and re-validates everything).
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const body = await readBody<{ id?: unknown; characters?: unknown; fuses?: unknown }>(event)
  const id = typeof body?.id === 'string' ? body.id : null
  const chars = body?.characters as unknown
  const isSide = (s: unknown): s is string[] => Array.isArray(s) && s.every((c) => typeof c === 'string')
  if (!id || !Array.isArray(chars) || chars.length !== 2 || !chars.every(isSide)) {
    throw createError({ statusCode: 400, statusMessage: 'expected { id, characters: [string[], string[]] }' })
  }
  const sides = chars as [string[], string[]]
  // fuses are optional (tournament fuses are often unreadable — blank is fine);
  // when present: one id-or-null per side
  const fusesIn = body?.fuses as unknown
  if (fusesIn !== undefined && (!Array.isArray(fusesIn) || fusesIn.length !== 2 || !fusesIn.every((f) => f === null || typeof f === 'string'))) {
    throw createError({ statusCode: 400, statusMessage: 'expected fuses: [id|null, id|null] when provided' })
  }
  const fusePair = fusesIn as [string | null, string | null] | undefined

  const root = process.cwd()
  const champions = JSON.parse(readFileSync(join(root, 'data/champions.json'), 'utf8')) as Record<string, Champion>
  const unknown = [...new Set(sides.flat().filter((c) => !champions[c]))]
  if (unknown.length > 0) {
    throw createError({ statusCode: 400, statusMessage: `unknown champion id(s): ${unknown.join(', ')}` })
  }
  if (fusePair) {
    const fuses = JSON.parse(readFileSync(join(root, 'data/fuses.json'), 'utf8')) as Record<string, Fuse>
    const badFuses = [...new Set(fusePair.filter((f): f is string => f !== null && !fuses[f]))]
    if (badFuses.length > 0) {
      throw createError({ statusCode: 400, statusMessage: `unknown fuse id(s): ${badFuses.join(', ')} (valid: ${Object.keys(fuses).sort().join(', ')})` })
    }
  }

  const path = join(root, 'data/manual-videos.json')
  const file = JSON.parse(readFileSync(path, 'utf8')) as ManualVideosFile
  const entry = (file.videos ?? []).find((v) => v.id === id)
  if (!entry) {
    throw createError({
      statusCode: 404,
      statusMessage: `id "${id}" is not in manual-videos.json — this tool only edits manual entries`,
    })
  }
  if (!Array.isArray(entry.teams) || entry.teams.length !== 2) {
    throw createError({ statusCode: 409, statusMessage: `entry "${id}" is malformed (expected 2 teams) — fix the file by hand` })
  }

  const dedupe = (xs: string[]) => [...new Set(xs)]
  entry.teams[0].characters = dedupe(sides[0])
  entry.teams[1].characters = dedupe(sides[1])
  if (fusePair) {
    entry.teams[0].fuse = fusePair[0]
    entry.teams[1].fuse = fusePair[1]
  }
  delete entry.todo
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n')

  // advisory only — set-level unions can legitimately be any length
  const warnings: string[] = []
  entry.teams.forEach((t, i) => {
    const side = i === 0 ? 'left' : 'right'
    if (t.characters.length === 0) warnings.push(`${side} side saved with 0 champions`)
    else if (t.characters.length % 2 !== 0) warnings.push(`${side} side has an odd count (${t.characters.length}) — fine for set unions, double-check`)
  })
  return { ok: true, warnings }
})

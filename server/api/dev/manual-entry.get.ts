import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ManualVideosFile } from '~~/types'

// Dev-only: serves data/manual-videos.json entries for the /dev/manual-entry
// authoring UI. Same shipping guarantees as the fuse-orient endpoints: 404
// outside `nuxt dev`, and the vercel-static output carries no server at all.
export default defineEventHandler(() => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const file = JSON.parse(
    readFileSync(join(process.cwd(), 'data/manual-videos.json'), 'utf8'),
  ) as ManualVideosFile
  return { videos: file.videos ?? [] }
})

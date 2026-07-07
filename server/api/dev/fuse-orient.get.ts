import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FuseOrientQueue, VideoRecord } from '~~/types'

// Dev-only: serves the orientation-adjudication queue written by
// `npm run data:fuses -- --promote-lows`, plus which queue ids already carry
// an assignment in overrides.json (owner = title-team index holding the fuse).
export default defineEventHandler(() => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const queuePath = join(process.cwd(), 'cache/fuse/review/orient-queue.json')
  if (!existsSync(queuePath)) {
    throw createError({ statusCode: 404, statusMessage: 'orient-queue.json not found — run `npm run data:fuses -- --promote-lows` first' })
  }
  const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as FuseOrientQueue
  const overrides = JSON.parse(readFileSync(join(process.cwd(), 'data/overrides.json'), 'utf8')) as Record<
    string,
    Partial<VideoRecord>
  >
  const assigned: Record<string, number> = {}
  for (const item of queue.items) {
    const owner = overrides[item.id]?.teams?.findIndex((t) => t.fuse === item.fuse) ?? -1
    if (owner >= 0) assigned[item.id] = owner
  }
  return { ...queue, assigned }
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev-only: crops the fuse-pill region out of a cached frame on the fly, using
// the same rects as detection (data/fuse-regions.json) padded by the Y_SCAN
// drift window — pure cropping, detection logic is never touched. sharp is
// imported lazily so production builds never trace the native module.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const { id, n, side } = getQuery(event)
  if (
    typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id) ||
    typeof n !== 'string' || !/^\d{2}$/.test(n) ||
    (side !== 'left' && side !== 'right')
  ) {
    throw createError({ statusCode: 400, statusMessage: 'expected ?id=<videoId>&n=<NN>&side=left|right' })
  }
  const path = join(process.cwd(), 'cache/fuse/frames', id, `${n}.png`)
  if (!existsSync(path)) throw createError({ statusCode: 404 })

  const regions = JSON.parse(readFileSync(join(process.cwd(), 'data/fuse-regions.json'), 'utf8')) as {
    default: { left: number[]; right: number[] }
  }
  const [rx, ry, rw, rh] = regions.default[side] as [number, number, number, number]
  const { default: sharp } = await import('sharp')
  const meta = (await sharp(path).metadata()) as { width: number; height: number }
  const top = Math.max(0, Math.round((ry - 0.006) * meta.height))
  const buf = await sharp(path)
    .extract({
      left: Math.round(rx * meta.width),
      top,
      width: Math.round(rw * meta.width),
      height: Math.min(Math.round((rh + 0.022) * meta.height), meta.height - top),
    })
    .resize({ height: 88 })
    .png()
    .toBuffer()
  setHeader(event, 'content-type', 'image/png')
  return buf
})

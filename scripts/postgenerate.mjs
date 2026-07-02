// Post-generate: nitro's static preset writes its own SPA-fallback 404.html
// (an empty shell). Replace it with the fully prerendered /not-found page so
// unknown URLs get the designed 404 as real HTML on the static host.
import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '.vercel/output/static')
const src = join(out, 'not-found/index.html')
const dst = join(out, '404.html')

copyFileSync(src, dst)
if (!readFileSync(dst, 'utf8').includes('No data at this route')) {
  console.error('✖ 404.html does not contain the designed not-found page')
  process.exit(1)
}
console.log('✓ 404.html ← prerendered /not-found (designed 404)')

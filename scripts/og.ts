// One-off generator for the site's default OG card (public/og-default.png,
// 1200×630). Renders an on-token HTML card in headless Chrome — Google-Fonts
// CDN is fine here (generator only; the site itself self-hosts fonts).
//
// Run: npx tsx scripts/og.ts

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import type { Champion } from '../types/index'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<void> {
  const champions = JSON.parse(
    await readFile(join(ROOT, 'data/champions.json'), 'utf8'),
  ) as Record<string, Champion>
  const accents = Object.values(champions).map((c) => c.accent ?? '#FF2E88')
  const strip = accents
    .map((a) => `<span style="flex:1;background:${a};"></span>`)
    .join('')

  const html = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=Barlow:wght@500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>*{margin:0;box-sizing:border-box}</style></head>
<body style="width:1200px;height:630px;background:#0A0B0F;overflow:hidden;position:relative;font-family:'Barlow',sans-serif;">
  <div style="position:absolute;inset:0;background:repeating-linear-gradient(135deg,#0e1016,#0e1016 22px,#0b0d13 22px,#0b0d13 44px);opacity:.6;"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(75% 110% at 82% 10%,rgba(255,46,136,.22),transparent 60%);"></div>
  <div style="position:absolute;left:80px;top:132px;">
    <div style="display:flex;align-items:center;gap:26px;">
      <div style="width:118px;height:118px;background:#FF2E88;clip-path:polygon(0 0,calc(100% - 24px) 0,100% 24px,100% 100%,24px 100%,0 calc(100% - 24px));display:flex;align-items:center;justify-content:center;">
        <span style="font-family:'Chakra Petch';font-weight:700;font-size:64px;color:#0A0B0F;transform:skewX(-8deg);">/</span>
      </div>
      <div style="font-family:'Chakra Petch';font-weight:700;font-size:88px;letter-spacing:-.02em;color:#F4F5F8;">2XKO<span style="color:#FF2E88;">/</span>REPLAY</div>
    </div>
    <div style="margin-top:34px;font-size:30px;font-weight:600;color:#A8AEBE;">The competitive 2XKO replay database</div>
    <div style="margin-top:16px;font-family:'JetBrains Mono';font-size:20px;color:#8B93A8;">champion usage · team pairings · meta over time</div>
  </div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:14px;display:flex;">${strip}</div>
</body></html>`

  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 630 } })).newPage()
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const png = await page.screenshot({ type: 'png' })
  await browser.close()
  await writeFile(join(ROOT, 'public/og-default.png'), png)
  console.log(`✓ public/og-default.png (${png.length} bytes)`)
}

main().catch((err) => {
  console.error('✖ og.ts failed:', err)
  process.exit(1)
})

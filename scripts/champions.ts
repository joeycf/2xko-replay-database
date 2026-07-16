// Champion art + accent enricher.
// For each champion in data/characters.json (the engine-generic registry):
//   • accent      ← design tokens (design/handoff/tokens.css --champ-<id>)  [source of truth]
//   • imgPortrait ← 2xko.riotgames.com roster index (characterCardGrid, 780x1040)
//   • imgSplash   ← champion detail page metaImage (1920x1080)
// Images are downloaded to public/img/champions/ as optimized webp (sharp).
// Re-runnable: cached webp files are skipped unless FORCE=1 (or --force).
//
// Run: npm run data:champions

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { Champion } from '../types/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const IMG_DIR = join(ROOT, 'public', 'img', 'champions');
const TOKENS = join(ROOT, 'design', 'handoff', 'tokens.css');
const SITE = 'https://2xko.riotgames.com/en-us/champions';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const FORCE = process.argv.includes('--force') || process.env.FORCE === '1';
const PORTRAIT_W = 780;
const SPLASH_W = 1600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) =>
  access(p)
    .then(() => true)
    .catch(() => false);

async function fetchText(url: string, tries = 4): Promise<string> {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (res.ok) return await res.text();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (i === tries) throw err;
    }
    await sleep(400 * i);
  }
  throw new Error(`unreachable: ${url}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no __NEXT_DATA__ block');
  return JSON.parse(m[1]);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blades = (data: any): any[] => data?.props?.pageProps?.page?.blades ?? [];

// Strip any existing query, cap width via the Sanity CDN; sharp re-encodes to webp.
const sized = (url: string, w: number) => `${url.split('?')[0]}?w=${w}`;

async function saveWebp(srcUrl: string, outPath: string, maxWidth: number): Promise<void> {
  const res = await fetch(sized(srcUrl, maxWidth), { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`image HTTP ${res.status} for ${srcUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await sharp(buf)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 })
    .toFile(outPath);
}

function loadAccents(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of css.matchAll(/--champ-([a-z0-9]+):\s*(#[0-9a-fA-F]{6})/g))
    map.set(m[1], m[2].toUpperCase());
  return map;
}

interface PortraitRef {
  url: string;
  width: number;
}
async function loadPortraitRefs(): Promise<Map<string, PortraitRef>> {
  const grid = blades(nextData(await fetchText(`${SITE}/`))).find(
    (b) => b.type === 'characterCardGrid',
  );
  const refs = new Map<string, PortraitRef>();
  for (const item of grid?.items ?? []) {
    const link: string = item?.action?.payload?.url ?? '';
    const slug = link.replace(/\/+$/, '').split('/').pop()?.toLowerCase();
    const url: string | undefined = item?.media?.url;
    if (slug && url) refs.set(slug, { url, width: item?.media?.dimensions?.width ?? PORTRAIT_W });
  }
  return refs;
}

async function loadSplashUrl(id: string): Promise<string | null> {
  const html = await fetchText(`${SITE}/${id}/`);
  const data = nextData(html);
  // The per-champion hero art is the page's backdrop-blade background; the
  // metaImage is a single generic 2XKO key art shared by every champion page.
  for (const blade of blades(data)) {
    const url = blade?.backdrop?.background?.thumbnail?.url;
    if (typeof url === 'string' && url) return url;
  }
  const meta = data?.props?.pageProps?.page?.metaImage?.url;
  if (meta) return meta;
  const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  return og ? og[1].replace(/&amp;/g, '&') : null;
}

async function main(): Promise<void> {
  await mkdir(IMG_DIR, { recursive: true });
  const characterList = JSON.parse(
    await readFile(join(DATA, 'characters.json'), 'utf8'),
  ) as Champion[];
  const champions: Record<string, Champion> = Object.fromEntries(
    characterList.map((c) => [c.id, c]),
  );
  const ids = characterList.map((c) => c.id);
  const missing: string[] = [];

  // 1. Accents — reconcile to the design tokens.
  const accents = loadAccents(await readFile(TOKENS, 'utf8'));
  let accentOk = 0;
  for (const id of ids) {
    const hex = accents.get(id);
    if (hex) {
      champions[id].accent = hex;
      accentOk++;
    } else missing.push(`${id}:accent(no token)`);
  }

  const portraitPath = (id: string) => join(IMG_DIR, `${id}-portrait.webp`);
  const splashPath = (id: string) => join(IMG_DIR, `${id}-splash.webp`);

  // 2. Portraits — fetch the roster index only if something actually needs downloading.
  const needPortraits: string[] = [];
  for (const id of ids) if (FORCE || !(await exists(portraitPath(id)))) needPortraits.push(id);

  let refs = new Map<string, PortraitRef>();
  if (needPortraits.length) {
    console.log(`Fetching roster index for ${needPortraits.length} portrait(s)…`);
    refs = await loadPortraitRefs();
  }
  let portraitOk = 0;
  for (const id of ids) {
    const out = portraitPath(id);
    if (FORCE || !(await exists(out))) {
      const ref = refs.get(id);
      if (!ref) missing.push(`${id}:portrait(no roster entry)`);
      else {
        try {
          await saveWebp(ref.url, out, Math.min(PORTRAIT_W, ref.width));
          console.log(`  ✓ ${id} portrait`);
          await sleep(120);
        } catch (err) {
          missing.push(`${id}:portrait(${(err as Error).message})`);
        }
      }
    }
    if (await exists(out)) {
      champions[id].imgPortrait = `/img/champions/${id}-portrait.webp`;
      portraitOk++;
    }
  }

  // 3. Splashes — from each champion's detail-page metaImage. An 800w variant
  //    is emitted alongside the 1600w for the hero srcset (filename convention
  //    `<id>-splash-800.webp`; characters.json keeps pointing at the 1600w).
  let splashOk = 0;
  for (const id of ids) {
    const out = splashPath(id);
    const out800 = join(IMG_DIR, `${id}-splash-800.webp`);
    if (FORCE || !(await exists(out)) || !(await exists(out800))) {
      try {
        const url = await loadSplashUrl(id);
        if (!url) missing.push(`${id}:splash(no metaImage)`);
        else {
          if (FORCE || !(await exists(out))) {
            await saveWebp(url, out, SPLASH_W);
            console.log(`  ✓ ${id} splash`);
          }
          if (FORCE || !(await exists(out800))) {
            await saveWebp(url, out800, 800);
            console.log(`  ✓ ${id} splash-800`);
          }
          await sleep(120);
        }
      } catch (err) {
        missing.push(`${id}:splash(${(err as Error).message})`);
      }
    }
    if (await exists(out)) {
      champions[id].imgSplash = `/img/champions/${id}-splash.webp`;
      splashOk++;
    }
  }

  await writeFile(
    join(DATA, 'characters.json'),
    JSON.stringify(characterList, null, 2) + '\n',
    'utf8',
  );
  console.log(
    `\n✔ accents ${accentOk}/${ids.length}  portraits ${portraitOk}/${ids.length}  splashes ${splashOk}/${ids.length}`,
  );
  if (missing.length) console.log('  gaps:', missing.join('  '));
}

main().catch((err) => {
  console.error('✖ champions.ts failed:', err);
  process.exit(1);
});

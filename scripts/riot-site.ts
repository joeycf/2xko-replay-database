// 2xko.riotgames.com, read the one way that is stable.
//
// The site is Next.js: every route embeds its whole page model in a single
// `__NEXT_DATA__` script tag, and that tag is the only honest source on it.
// The rendered DOM is a truncated view (the game-updates listing renders 12 of
// its 62 items and reveals the rest client-side), the `_next/data/<buildId>`
// JSON route changes id on every Riot deploy, and the publishing API behind
// both needs credentials. So both readers of the site — scripts/champions.ts
// for the roster and champion pages, scripts/patch-check.ts for the
// game-updates listing — fetch the HTML and read the embedded model through
// these three helpers. One regex for one site; two copies would drift apart.
//
// Side-effect-free on import. champions.ts itself cannot be imported (sharp,
// and main() runs at load), which is why these live here.

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a page as text. Four tries with a growing pause; 5xx and 429 are
 *  retried, any other 4xx fails at once (a 404 does not improve by waiting). */
export async function fetchText(url: string, tries = 4): Promise<string> {
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

/** The page model Next.js embeds in every route. Throws when the tag is
 *  missing — the route moved, or the site is no longer Next.js. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function nextData(html: string): any {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error('no __NEXT_DATA__ block');
  return JSON.parse(m[1]);
}

/** The page's content blocks (`characterCardGrid`, `articleCardGrid`, …). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const blades = (data: any): any[] => data?.props?.pageProps?.page?.blades ?? [];

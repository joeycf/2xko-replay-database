// E2E suite — Playwright-core (same launch mechanics as og.ts) against the
// generated static output, plus a shell-level test of the daily-cron commit
// guard. Numeric expectations are computed Node-side from the committed data
// files, never hardcoded.
//
// Phase-3 shape: the app is a thin consumer of the replay-engine layer, so the
// suite drives the ENGINE UI (source/patch facets, [data-replay-id] cards,
// engine testids) plus the 2XKO-specific surfaces that stayed app-side (fuse
// stats panels via the GameStatsPanels slot, the sticky BMC footer, legacy
// deep-link translation, /champions/* URLs).
//
// Prereq: npm run generate       Run: npm run test:e2e

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Champion, Fuse, VideoRecord } from '../types/index';

/** Buy Me a Coffee URL — must match the engine's SiteFooter.vue. */
const BMC_URL = 'https://buymeacoffee.com/whatdaflip';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.vercel/output/static');

// Node-side expectations use the SAME record set the site carries: the rich
// substrate minus overrides.json exclusions (scripts/emit.ts applies the same
// filter when emitting replays.json).
const allVideos = JSON.parse(readFileSync(join(ROOT, 'data/videos.json'), 'utf8')) as VideoRecord[];
const overrides = JSON.parse(readFileSync(join(ROOT, 'data/overrides.json'), 'utf8')) as Record<
  string,
  { exclude?: boolean }
>;
const excludedIds = new Set(
  Object.entries(overrides)
    .filter(([, ov]) => ov.exclude === true)
    .map(([id]) => id),
);
const videos = allVideos.filter((v) => !excludedIds.has(v.id));
const fuses = JSON.parse(readFileSync(join(ROOT, 'data/fuses.json'), 'utf8')) as Record<
  string,
  Fuse
>;
const characters = JSON.parse(
  readFileSync(join(ROOT, 'data/characters.json'), 'utf8'),
) as Champion[];
// generic stats: KnownStats + the 2XKO fuse extension keys (scripts/emit.ts)
const stats = JSON.parse(readFileSync(join(ROOT, 'data/stats.json'), 'utf8')) as {
  totals: { replays: number; withFuse: number; byPatch: Record<string, number> };
  pairingUsage: Record<string, number>;
  playerCharacters: Record<string, Record<string, number>>;
  fuseUsage: Record<string, number>;
  fuseByPatch: Record<string, Record<string, number>>;
};

/** rich → emitted patch key (mirror of scripts/emit.ts eraKey) */
const eraKey = (season: number | null) => (season === null ? 'Beta' : `S${season}`);

// ── tiny static server over the generated output ──────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.ico': 'image/x-icon',
};
function serve(): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const candidates = [join(OUT, path), join(OUT, path, 'index.html'), join(OUT, '404.html')];
    for (const file of candidates) {
      if (existsSync(file) && extname(file)) {
        res.writeHead(file.endsWith('404.html') ? 404 : 200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        res.end(readFileSync(file));
        return;
      }
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

// ── micro test harness ────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✖ ${name}\n    ${(err as Error).message.split('\n')[0]}`);
  }
}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** result-count waits out the client-side replays.json fetch ('…' while pending) */
async function resultCount(page: Page): Promise<number> {
  // string-form predicates: they run in the browser, and the pipeline tsconfig
  // deliberately has no DOM lib
  await page.waitForFunction(
    `(() => { const el = document.querySelector('[data-testid="result-count"]'); return el !== null && /^[\\d,]+$/.test((el.textContent || '').trim()) })()`,
    undefined,
    { timeout: 30_000 },
  );
  const text = await page.textContent('[data-testid="result-count"]');
  return Number(text!.replace(/,/g, ''));
}

// ── suite ─────────────────────────────────────────────────────────────────────
async function run(browser: Browser, base: string): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 960 } });
  const page = await ctx.newPage();

  // (t) THEME PRESENCE — the 2026-07-16 hotfix gate (Phase-4 audit). The 2XKO
  // skin must actually APPLY on the BUILT output: theme.css ships plain
  // unlayered :root custom properties; a raw @theme at-rule would reach the
  // browser uncompiled and be dropped, silently shipping the umbrella
  // teal/Space Grotesk (dev masks this — only the built bundle can prove it).
  // Computed styles are the assertion, never source text.
  await test('theme presence: built output computes #ff2e88 / Chakra Petch, no raw @theme ships', async () => {
    await page.goto(`${base}/`);
    const t = (await page.evaluate(`(() => {
      const s = getComputedStyle(document.body);
      return {
        primary: s.getPropertyValue('--color-primary').trim().toLowerCase(),
        secondary: s.getPropertyValue('--color-secondary').trim().toLowerCase(),
        display: s.getPropertyValue('--font-display'),
        bodyFont: s.fontFamily,
      };
    })()`)) as { primary: string; secondary: string; display: string; bodyFont: string };
    expect(t.primary === '#ff2e88', `--color-primary "${t.primary}" ≠ #ff2e88 (umbrella leak)`);
    expect(t.secondary === '#38cfff', `--color-secondary "${t.secondary}" ≠ #38cfff`);
    expect(t.display.includes('Chakra Petch'), `--font-display "${t.display}" ≠ Chakra Petch`);
    expect(t.bodyFont.includes('Barlow'), `body font "${t.bodyFont}" — --font-ui not applied`);
    // mechanism tripwire: an UNCOMPILED @theme block in any built stylesheet
    // is exactly how the regression shipped
    const cssDir = join(OUT, '_nuxt');
    const raw = readdirSync(cssDir)
      .filter((f) => f.endsWith('.css'))
      .filter((f) => /@theme[\s{]/.test(readFileSync(join(cssDir, f), 'utf8')));
    expect(raw.length === 0, `raw @theme at-rule shipped in ${raw.join(', ')}`);
  });

  // (a0) overrides exclusion: the stray record is gone from the emitted set
  await test(`exclusion: ${[...excludedIds].join(',')} absent from replays.json (${videos.length} carried)`, async () => {
    const emitted = JSON.parse(readFileSync(join(ROOT, 'data/replays.json'), 'utf8')) as {
      id: string;
    }[];
    expect(
      emitted.length === videos.length,
      `emitted ${emitted.length} ≠ expected ${videos.length}`,
    );
    for (const id of excludedIds)
      expect(!emitted.some((r) => r.id === id), `excluded ${id} still present`);
    await page.goto(`${base}/`);
    expect((await resultCount(page)) === videos.length, 'Browse count includes an excluded record');
  });

  // (a) source facet counts match Node-side counts from videos.json
  const bySource = (id: string) => videos.filter((v) => v.channel === id).length;
  await test(`source filter: ?src=manual shows ${bySource('manual')} tournament VODs`, async () => {
    await page.goto(`${base}/?src=manual`);
    const shown = await resultCount(page);
    expect(shown === bySource('manual'), `result-count ${shown} ≠ ${bySource('manual')}`);
  });

  // (f1) fuse facet counts match Node-side counts (the shipped a/a2 tests)
  const orMatch = (v: VideoRecord, ids: string[]) =>
    v.teams.some((t) => t.fuse && ids.includes(t.fuse));
  const freestyleN = videos.filter((v) => orMatch(v, ['freestyle'])).length;
  const fusePairN = videos.filter((v) => orMatch(v, ['juggernaut', '2x-assist'])).length;
  await test(`fuse filter: ?fuse=freestyle shows ${freestyleN}, juggernaut+2x-assist OR-match ${fusePairN}`, async () => {
    await page.goto(`${base}/?fuse=freestyle`);
    expect((await resultCount(page)) === freestyleN, 'freestyle count');
    await page.goto(`${base}/?fuse=juggernaut,2x-assist`);
    expect((await resultCount(page)) === fusePairN, 'OR-pair count');
  });

  // (f2) regression (2026-07-03 report): the rarest fuse's UI count equals the
  // Node-computed count — guards over-matching and null-fuse leaks. Also the
  // LEGACY deep-link gate: this exact URL predates the layer refactor.
  const jugN = videos.filter((v) => orMatch(v, ['juggernaut'])).length;
  await test(`legacy fuse deep link: /?fuse=juggernaut filters to ${jugN} (param survives, no strip)`, async () => {
    await page.goto(`${base}/?fuse=juggernaut`);
    await page.waitForFunction(`new URL(location.href).searchParams.get('fuse') === 'juggernaut'`);
    expect((await resultCount(page)) === jugN, 'juggernaut count');
  });

  // (f3) fuse chips round-trip (URL ⇄ chip state ⇄ URL) + active-chips/Clear
  await test('fuse deep-link round-trips (URL ⇄ chip state), Clear all clears fuse=', async () => {
    await page.goto(`${base}/?fuse=juggernaut,2x-assist`);
    await page.waitForSelector('[data-testid="fuse-chip-juggernaut"]');
    for (const [id, want] of [
      ['juggernaut', 'true'],
      ['2x-assist', 'true'],
      ['freestyle', 'false'],
    ] as const) {
      const got = await page.getAttribute(`[data-testid="fuse-chip-${id}"]`, 'aria-pressed');
      expect(got === want, `chip ${id} aria-pressed=${got}, want ${want}`);
    }
    await page.click('[data-testid="fuse-chip-2x-assist"]'); // deselect
    await page.waitForFunction(`new URL(location.href).searchParams.get('fuse') === 'juggernaut'`);
    await page.click('[data-testid="fuse-chip-freestyle"]'); // add
    await page.waitForFunction(
      `new URL(location.href).searchParams.get('fuse') === 'juggernaut,freestyle'`,
    );
    // Clear all (ActiveChips) wipes the custom facet too
    await page.click('text=Clear all');
    await page.waitForFunction(`new URL(location.href).searchParams.get('fuse') === null`);
  });

  // (f5) modal fuse attribution (the shipped c test): ordered records show
  // per-side tags; fusesUnordered records show ONLY the combined unbound row
  const ordered = videos.find(
    (v) => v.teams.length === 2 && v.teams[0]!.fuse && v.teams[1]!.fuse && !v.fusesUnordered,
  )!;
  const unordered = videos.find(
    (v) => v.fusesUnordered && v.teams.length === 2 && (v.teams[0]!.fuse || v.teams[1]!.fuse),
  )!;
  await test(`modal: ordered ${ordered.id} shows per-side tags, unordered ${unordered.id} stays unbound`, async () => {
    await page.goto(`${base}/?v=${ordered.id}`);
    await page.waitForSelector('[data-testid="team-fuse-a"]', { timeout: 30_000 });
    const a = norm(await page.textContent('[data-testid="team-fuse-a"]'));
    const b = norm(await page.textContent('[data-testid="team-fuse-b"]'));
    expect(a === norm(fuses[ordered.teams[0]!.fuse!]!.name), `left tag "${a}"`);
    expect(b === norm(fuses[ordered.teams[1]!.fuse!]!.name), `right tag "${b}"`);
    expect(
      (await page.$('[data-testid="fuses-unordered"]')) === null,
      'unordered row must be absent',
    );

    await page.goto(`${base}/?v=${unordered.id}`);
    await page.waitForSelector('[data-testid="fuses-unordered"]', { timeout: 30_000 });
    const row = norm(await page.textContent('[data-testid="fuses-unordered"]'));
    for (const t of unordered.teams) {
      if (t.fuse) expect(row.includes(norm(fuses[t.fuse]!.name)), `row "${row}" missing ${t.fuse}`);
    }
    expect((await page.$('[data-testid="team-fuse-a"]')) === null, 'per-side tag A must be absent');
    expect((await page.$('[data-testid="team-fuse-b"]')) === null, 'per-side tag B must be absent');
  });

  // (f6) card fuse attribution mirrors the modal's rules (the shipped c2 test)
  const cardQuery = (v: VideoRecord) =>
    encodeURIComponent(v.teams.flatMap((t) => t.players.map((p) => p.displayName)).join(' '));
  await test(`card: ordered ${ordered.id} pins per-side, unordered ${unordered.id} stays unbound`, async () => {
    await page.goto(`${base}/?q=${cardQuery(ordered)}`);
    const oCard = `[data-replay-id="${ordered.id}"]`;
    await page.waitForSelector(`${oCard} [data-testid="card-fuse-a"]`, { timeout: 30_000 });
    const a = norm(await page.textContent(`${oCard} [data-testid="card-fuse-a"]`));
    const b = norm(await page.textContent(`${oCard} [data-testid="card-fuse-b"]`));
    expect(a === norm(fuses[ordered.teams[0]!.fuse!]!.name), `card left tag "${a}"`);
    expect(b === norm(fuses[ordered.teams[1]!.fuse!]!.name), `card right tag "${b}"`);
    expect(
      (await page.$(`${oCard} [data-testid="card-fuses-unordered"]`)) === null,
      'ordered card must not show the unbound row',
    );

    await page.goto(`${base}/?q=${cardQuery(unordered)}`);
    const uCard = `[data-replay-id="${unordered.id}"]`;
    await page.waitForSelector(`${uCard} [data-testid="card-fuses-unordered"]`, {
      timeout: 30_000,
    });
    const row = norm(await page.textContent(`${uCard} [data-testid="card-fuses-unordered"]`));
    for (const t of unordered.teams) {
      if (t.fuse)
        expect(row.includes(norm(fuses[t.fuse]!.name)), `unbound row "${row}" missing ${t.fuse}`);
    }
    expect(
      (await page.$(`${uCard} [data-testid="card-fuse-a"]`)) === null,
      'unordered card must not pin a fuse to side A',
    );
    expect(
      (await page.$(`${uCard} [data-testid="card-fuse-b"]`)) === null,
      'unordered card must not pin a fuse to side B',
    );
  });

  // (f4) the coverage-honesty line rides the facet note
  await test(`coverage line: ${videos.filter((v) => v.teams.some((t) => t.fuse)).length.toLocaleString('en-US')} of ${videos.length.toLocaleString('en-US')}`, async () => {
    await page.goto(`${base}/`);
    await page.waitForSelector('[data-testid="fuse-facet-note"]');
    const line = await page.textContent('[data-testid="fuse-facet-note"]');
    const withFuse = videos.filter((v) => v.teams.some((t) => t.fuse)).length;
    expect(line!.includes(withFuse.toLocaleString('en-US')), `line "${line}"`);
    expect(line!.includes(videos.length.toLocaleString('en-US')), `line "${line}"`);
  });

  // (a2) patch facet, single + OR
  const byPatch = (keys: string[]) => videos.filter((v) => keys.includes(eraKey(v.season))).length;
  await test(`patch filter: ?patch=S1 shows ${byPatch(['S1'])}, S1,S2 OR-match ${byPatch(['S1', 'S2'])}`, async () => {
    await page.goto(`${base}/?patch=S1`);
    expect((await resultCount(page)) === byPatch(['S1']), 'single-patch count');
    await page.goto(`${base}/?patch=S1,S2`);
    expect((await resultCount(page)) === byPatch(['S1', 'S2']), 'OR-patch count');
  });

  // (a3) duo sides: filtering by the SECOND player of a duo team must match
  // (Side.players — engine v0.2.0), and the card labels join both names
  const duo = videos.find(
    (v) => v.teams.length === 2 && v.teams.some((t) => t.players.length > 1),
  )!;
  const partner = duo.teams.find((t) => t.players.length > 1)!.players[1]!;
  const partnerN = videos.filter((v) =>
    v.teams.some((t) => t.players.some((p) => p.id === partner.id)),
  ).length;
  await test(`duo sides: ?p=${partner.id} matches ${partnerN} replays incl. duo teams`, async () => {
    await page.goto(`${base}/?p=${partner.id}`);
    const shown = await resultCount(page);
    expect(shown === partnerN, `result-count ${shown} ≠ ${partnerN}`);
    const card = `[data-replay-id="${duo.id}"]`;
    await page.waitForSelector(card, { timeout: 30_000 });
    const label = norm(await page.textContent(card));
    for (const t of duo.teams)
      for (const p of t.players)
        expect(label.includes(norm(p.displayName)), `card missing duo player ${p.displayName}`);
  });

  // (b) same-side chain (the 47 → 23 example, generalized): top pairing
  const [topPairKey] = Object.entries(stats.pairingUsage).sort((x, y) => y[1] - x[1])[0]!;
  const [pa, pb] = topPairKey.split('|') as [string, string];
  const bothN = videos.filter((v) => [pa, pb].every((c) => v.allCharacters.includes(c))).length;
  const sameSideN = videos.filter((v) =>
    v.teams.some((t) => [pa, pb].every((c) => t.characters.includes(c))),
  ).length;
  await test(`same-side chain: c=${pa},${pb} ${bothN} → side=1 narrows to ${sameSideN}`, async () => {
    await page.goto(`${base}/?c=${pa},${pb}`);
    expect((await resultCount(page)) === bothN, 'AND count');
    await page.click('[data-testid="co-occurrence-toggle"]');
    await page.waitForFunction(`new URL(location.href).searchParams.get('side') === '1'`);
    expect((await resultCount(page)) === sameSideN, 'same-side count');
  });

  // (c) legacy deep-links translate (middleware/legacy-params.global.ts)
  const proS1 = videos.filter(
    (v) => v.channel === 'proReplays' && eraKey(v.season) === 'S1',
  ).length;
  await test(`legacy params: ?ch=pro&s=1 → src=proReplays&patch=S1 (${proS1})`, async () => {
    await page.goto(`${base}/?ch=pro&s=1`);
    await page.waitForFunction(
      `new URL(location.href).searchParams.get('src') === 'proReplays' && new URL(location.href).searchParams.get('patch') === 'S1' && !new URL(location.href).searchParams.get('ch')`,
    );
    expect((await resultCount(page)) === proS1, 'translated count');
    await page.goto(`${base}/?type=tournament`);
    await page.waitForFunction(`new URL(location.href).searchParams.get('src') === 'manual'`);
  });

  // (d) stats fuse panels (GameStatsPanels slot) render the real top values…
  const usageRanked = Object.entries(stats.fuseUsage).sort((x, y) => y[1] - x[1]);
  const [topId, topN] = usageRanked[0]!;
  await test(`stats: fuse usage panel ranks ${topId} first at ${topN.toLocaleString('en-US')}`, async () => {
    await page.goto(`${base}/stats`);
    await page.waitForSelector('[data-testid="fuse-usage-bars"]');
    // counts animate up when the panel scrolls into view — jump there, then
    // wait for the count-up to land on the real value
    await page.evaluate(
      `document.querySelector('[data-testid="fuse-usage-bars"]').scrollIntoView()`,
    );
    await page.waitForFunction(
      `(document.querySelector('[data-testid="fuse-usage-bars"] > div:first-child')?.textContent ?? '').includes('${topN.toLocaleString('en-US')}')`,
      undefined,
      { timeout: 15_000 },
    );
    const firstRow = norm(
      await page.textContent('[data-testid="fuse-usage-bars"] > div:first-child'),
    );
    expect(firstRow.includes(norm(fuses[topId]!.name)), `first row "${firstRow}"`);
    const cards = await page.$$('[data-testid="fuse-era-shift"] > div');
    expect(cards.length === Object.keys(stats.fuseByPatch).length, `${cards.length} era cards`);
    const s1 = stats.fuseByPatch['S1']!;
    const s1Total = Object.values(s1).reduce((a, b) => a + b, 0);
    const s1Top = Object.entries(s1).sort((x, y) => y[1] - x[1])[0]!;
    const s1Share = `${Math.round((s1Top[1] / s1Total) * 100)}%`;
    const s1Card = norm(
      await page.textContent('[data-testid="fuse-era-shift"] > div:nth-child(3)'),
    );
    expect(s1Card.startsWith('s1'), `card 3 is "${s1Card.slice(0, 12)}…", want S1`);
    expect(
      s1Card.includes(norm(fuses[s1Top[0]]!.name)) && s1Card.includes(s1Share),
      `S1 card missing ${s1Top[0]} @ ${s1Share}`,
    );
  });

  // …the numbers are prerendered into the HTML (no-JS check on the file), and
  // the coverage-honesty line moved into the panel hint
  await test('stats: fuse numbers + coverage line prerendered in /stats/index.html', () => {
    const html = readFileSync(join(OUT, 'stats/index.html'), 'utf8');
    expect(html.includes(topN.toLocaleString('en-US')), `static HTML missing ${topN}`);
    expect(html.includes(fuses[topId]!.name), `static HTML missing ${fuses[topId]!.name}`);
    expect(
      html.includes(stats.totals.withFuse.toLocaleString('en-US')) &&
        html.includes(stats.totals.replays.toLocaleString('en-US')),
      'coverage hint missing detected/total counts',
    );
  });

  // (g) synergy-matrix hover tooltip: canonical names + count on a top cell AND
  // its transpose, diagonal says "same champion" (GameConfig.terms), a true
  // zero pair shows "never paired", and click-to-filter still deep-links
  const champById = Object.fromEntries(characters.map((c) => [c.id, c]));
  const champIds = characters.map((c) => c.id);
  const [pairKey, pairN] = Object.entries(stats.pairingUsage).sort((x, y) => y[1] - x[1])[0]!;
  const zeroPairKey = (() => {
    for (let i = 0; i < champIds.length; i++)
      for (let j = i + 1; j < champIds.length; j++) {
        const k = [champIds[i]!, champIds[j]!].sort().join('|');
        if (!stats.pairingUsage[k]) return k;
      }
    return null;
  })();
  await test(`stats: synergy tooltip (${pairKey} = ${pairN} on both mirror cells, "same champion" diagonal)`, async () => {
    await page.goto(`${base}/stats`);
    await page.waitForSelector('[data-testid="synergy-matrix"]');
    const names = pairKey.split('|').map((id) => champById[id]!.name);
    const cells = await page.$$(`[data-testid="synergy-matrix"] [data-pair="${pairKey}"]`);
    expect(cells.length === 2, `expected 2 mirrored cells for ${pairKey}, got ${cells.length}`);
    await cells[0]!.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    for (const cell of cells) {
      await page.mouse.move(0, 0);
      await cell.hover();
      await page.waitForSelector('[data-testid="synergy-tip"]');
      const txt = norm(await page.textContent('[data-testid="synergy-tip"]'));
      for (const n of names) expect(txt.includes(norm(n)), `tip "${txt}" missing name ${n}`);
      expect(txt.includes(pairN.toLocaleString('en-US')), `tip "${txt}" missing count ${pairN}`);
      await page.mouse.move(0, 0);
      await page.waitForFunction(`!document.querySelector('[data-testid="synergy-tip"]')`);
    }
    await page.mouse.move(0, 0);
    await page.hover(`[data-diag="${champIds[0]}"]`);
    const diag = norm(await page.textContent('[data-testid="synergy-tip"]'));
    expect(diag.includes('same champion'), `diagonal tip "${diag}" (terms.character)`);
    if (zeroPairKey) {
      await page.mouse.move(0, 0);
      await page.hover(`[data-testid="synergy-matrix"] [data-pair="${zeroPairKey}"]`);
      const zero = norm(await page.textContent('[data-testid="synergy-tip"]'));
      expect(zero.includes('never paired'), `zero-pair tip "${zero}"`);
    }
    await page.click(`[data-testid="synergy-matrix"] [data-pair="${pairKey}"]`);
    await page.waitForFunction(`new URL(location.href).searchParams.get('side') === '1'`);
    const c = String(await page.evaluate(`new URL(location.href).searchParams.get('c')`));
    expect(c.split(',').sort().join('|') === pairKey, `click filter c=${c}`);
  });

  // (j) dev-only surfaces (authoring/diagnostic pages + their API routes) must
  // not exist in the generated output — the served route falls to 404.html
  await test('dev-only: /dev/* and /api/* absent from output, /dev/manual-entry 404s', async () => {
    expect(!existsSync(join(OUT, 'dev')), 'OUT/dev/ must not be prerendered');
    expect(!existsSync(join(OUT, 'api')), 'OUT/api/ must not exist in static output');
    const res = await fetch(`${base}/dev/manual-entry`);
    expect(res.status === 404, `/dev/manual-entry served ${res.status}, want 404`);
    // root-level /dev routes only — player slugs like /players/devillion are fine
    expect(
      !/<loc>https?:\/\/[^/<]+\/dev(\/|<)/.test(readFileSync(join(OUT, 'sitemap.xml'), 'utf8')),
      'sitemap must not list /dev routes',
    );
  });

  // (h) SEO: canonical/OG on the deployed domain, valid JSON-LD (no
  // VideoObject anywhere), /champions/* URL segment preserved, sitemap/robots
  const envFile = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '';
  const site = (
    process.env.NUXT_PUBLIC_SITE_URL ??
    envFile.match(/^NUXT_PUBLIC_SITE_URL=(.+)$/m)?.[1] ??
    'https://2xko-replay-database.vercel.app'
  )
    .trim()
    .replace(/\/$/, '');
  const html = (p: string) => readFileSync(join(OUT, p), 'utf8');
  const ld = (doc: string): Record<string, unknown>[] =>
    [...doc.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) =>
      JSON.parse(m[1]!),
    );
  const champId = champIds[0]!;
  const playerId = Object.keys(stats.playerCharacters ?? {})[0]!;
  await test(`SEO: canonicals/OG on ${site}, JSON-LD valid, /champions/* preserved, sitemap/robots`, () => {
    const home = html('index.html');
    expect(home.includes(`<link rel="canonical" href="${site}/">`), 'home canonical');
    expect(home.includes(`content="${site}/og-default.png"`), 'home og:image absolute');
    const homeLd = ld(home);
    const websiteNode = homeLd.find((n) => n['@type'] === 'WebSite') as
      { potentialAction?: { target?: { urlTemplate?: string } } } | undefined;
    expect(!!homeLd.find((n) => n['@type'] === 'Organization'), 'Organization node');
    expect(
      websiteNode?.potentialAction?.target?.urlTemplate === `${site}/?q={search_term_string}`,
      'SearchAction target',
    );
    const champ = html(`champions/${champId}/index.html`);
    expect(
      champ.includes(`<link rel="canonical" href="${site}/champions/${champId}">`),
      'champ canonical',
    );
    expect(champ.includes('/img/champions/'), 'champ og:image uses splash art');
    const champLd = ld(champ);
    const crumbs = champLd.find((n) => n['@type'] === 'BreadcrumbList') as
      { itemListElement?: { item?: string; name?: string }[] } | undefined;
    expect(crumbs?.itemListElement?.length === 3, 'champ breadcrumb depth');
    expect(crumbs?.itemListElement?.[1]?.name === 'Champions', 'champ breadcrumb noun (terms)');
    expect(
      crumbs?.itemListElement?.[2]?.item === `${site}/champions/${champId}`,
      'champ breadcrumb leaf',
    );
    expect(!!champLd.find((n) => n['@type'] === 'CollectionPage'), 'champ CollectionPage');
    expect(champ.includes('<a href="/players/'), 'champ → player entity anchors (pilots)');
    const player = html(`players/${playerId}/index.html`);
    const pLd = ld(player);
    const pCrumbs = pLd.find((n) => n['@type'] === 'BreadcrumbList') as
      { itemListElement?: { item?: string }[] } | undefined;
    expect(pCrumbs?.itemListElement?.[1]?.item === `${site}/players`, 'player breadcrumbs');
    expect(
      player.includes('<a href="/champions/'),
      'player → champion entity anchor (main champion)',
    );
    for (const [route, doc] of [
      ['/', home],
      [`/champions/${champId}`, champ],
      [`/players/${playerId}`, player],
      ['/stats', html('stats/index.html')],
    ] as const) {
      expect(!doc.includes('VideoObject'), `unexpected VideoObject on ${route}`);
    }
    const sm = html('sitemap.xml');
    expect(
      sm.includes(`<loc>${site}/</loc>`) &&
        sm.includes(`<loc>${site}/champions/${champId}</loc>`) &&
        sm.includes(`<loc>${site}/players/${playerId}</loc>`) &&
        sm.includes(`<loc>${site}/stats</loc>`),
      'sitemap host + core/entity routes',
    );
    expect(!sm.includes('/characters'), 'sitemap must not leak /characters routes');
    expect(!sm.includes('/health'), 'sitemap excludes /health');
    const robots = html('robots.txt');
    expect(
      robots.includes('Disallow: /health') && robots.includes(`Sitemap: ${site}/sitemap.xml`),
      'robots.txt',
    );
    expect(
      html('health/index.html').includes('name="robots" content="noindex"'),
      '/health noindex',
    );
  });

  // (i) footer support link: a real prerendered anchor (shared engine layout +
  // SiteFooter, so check every page type) with new-tab + nofollow
  await test(`footer: Buy Me a Coffee link → ${BMC_URL} on all page types`, () => {
    const pages = [
      'index.html',
      'stats/index.html',
      `champions/${champId}/index.html`,
      `players/${playerId}/index.html`,
    ];
    for (const p of pages) {
      const anchor = [...html(p).matchAll(/<a [^>]*>/g)]
        .map((m) => m[0])
        .find((a) => a.includes(`href="${BMC_URL}"`));
      expect(!!anchor, `${p}: no anchor with href="${BMC_URL}"`);
      expect(anchor!.includes('target="_blank"'), `${p}: missing target="_blank" — ${anchor}`);
      for (const r of ['noopener', 'noreferrer', 'nofollow'])
        expect(new RegExp(`rel="[^"]*${r}`).test(anchor!), `${p}: rel missing ${r} — ${anchor}`);
    }
  });

  await ctx.close();
}

// (f) the daily-cron guard: timestamp-only report.md diff must not commit
function testCronGuard(): Promise<void> {
  return test('cron guard: timestamp-only run skips, real change commits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-guard-'));
    const sh = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' }).toString();
    const wf = readFileSync(join(ROOT, '.github/workflows/data-refresh.yml'), 'utf8').split('\n');
    const start = wf.findIndex((l) => l.includes('git config user.name'));
    const guard = wf
      .slice(start)
      .filter((l) => l.startsWith('          '))
      .map((l) => l.slice(10))
      .filter((l) => l.trim() !== 'git push') // scratch repo has no remote
      .join('\n'); // the literal "Commit if changed" block, minus indentation
    expect(
      guard.includes('git restore --staged --worktree data/report.md'),
      'workflow guard missing',
    );
    try {
      sh('git init -q . && git config user.email t@t && git config user.name t && mkdir data');
      const seed = (n: number, ts: string) => {
        writeFileSync(
          join(dir, 'data/videos.json'),
          JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))),
        );
        writeFileSync(
          join(dir, 'data/replays.json'),
          JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))),
        );
        writeFileSync(join(dir, 'data/stats.json'), '{}');
        writeFileSync(join(dir, 'data/players.json'), '[]');
        writeFileSync(join(dir, 'data/report.md'), `# R\n\n_Generated ${ts}._\n\ntotal: ${n}\n`);
      };
      seed(1, '2026-07-03T01:00:00.000Z');
      sh('git add -A && git commit -qm seed');
      writeFileSync(join(dir, 'guard.sh'), `set -e\n${guard}\n`);
      seed(1, '2026-07-03T02:00:00.000Z'); // timestamp-only
      const a = sh('bash guard.sh');
      expect(a.includes('No data changes'), `case A output: ${a.trim()}`);
      expect(sh('git rev-list --count HEAD').trim() === '1', 'case A must not commit');
      seed(2, '2026-07-03T03:00:00.000Z'); // real change
      sh('bash guard.sh');
      expect(sh('git rev-list --count HEAD').trim() === '2', 'case B must commit');
      expect(sh('git show --stat --format= HEAD').includes('report.md'), 'case B ships report.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ── main ──────────────────────────────────────────────────────────────────────
if (!existsSync(join(OUT, 'index.html'))) {
  console.error('✖ no generated output — run `npm run generate` first');
  process.exit(1);
}
console.log('e2e suite (static output + cron guard):');
const { base, close } = await serve();
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  await run(browser, base);
  await testCronGuard();
} finally {
  await browser.close();
  close();
}
console.log(
  `\n${passed}/${passed + failures.length} passed${failures.length ? ` — FAILED: ${failures.join(' · ')}` : ' 🎯'}`,
);
if (failures.length) process.exit(1);

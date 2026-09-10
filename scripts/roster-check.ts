/**
 * Roster drift check — is data/characters.json still what the vendor ships?
 *
 * WHY THIS EXISTS. A roster goes stale silently, and this is the repo where
 * that is most true: scripts/champions.ts only ENRICHES ids already present in
 * data/characters.json, so it can never discover a new champion, and 2XKO has
 * no residue gate to surface an unknown name from upload titles. Until this
 * file, roster drift here was findable only by a human going and looking — and
 * the whole point of the sibling repos' gates is that nobody should have to.
 *
 * A missing champion fails nothing. Every match they appear in renders, filters
 * and passes every count assertion — with one side quietly absent.
 *
 * THE PAIR THIS FORMS WITH scripts/expiries.ts, and it is deliberate. This
 * checker is CONTENT-AWARE: it fires on the real event, a new card appearing in
 * Riot's grid, and cannot be early or late. expiries.ts is CLOCK-ONLY: it reads
 * a date and nothing else, so no change of Riot's markup can blind it. The
 * sibling repos learned this the hard way — Tōkon's content-aware patch check
 * went blind for three weeks on a vendor rename and the dumb date alarm was the
 * only thing that fired. Keep both. Never replace one with the other.
 *
 * NETWORK, MANUAL, NEVER IN THE CRON — same contract as scripts/patch-check.ts.
 * The daily refresh must stay offline; this is the hand-run, usually via
 * ../check-rosters.sh at the workspace root.
 *
 * Run: npm run data:roster-check
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UNRELEASED } from './expiries';
import { blades, fetchText, nextData } from './riot-site';
import type { Champion } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://2xko.riotgames.com/en-us/champions';

/** The one machine-readable line ../check-rosters.sh classifies on. Everything
 *  else this script prints is for a human and may be reworded freely. */
type State = 'CURRENT' | 'DRIFT' | 'UNVERIFIED' | 'UNREADABLE';
const verdict = (state: State, detail = ''): never => {
  if (detail) console.log(detail);
  console.log(`roster-check: ${state}`);
  process.exit(state === 'CURRENT' || state === 'UNVERIFIED' ? 0 : 1);
};

async function main(): Promise<void> {
  const local = JSON.parse(
    await readFile(join(ROOT, 'data/characters.json'), 'utf8'),
  ) as Champion[];
  const localIds = new Set(local.map((c) => c.id));

  // Announced-but-unplayable champions are EXPECTED to be absent. Without this
  // the checker would report permanent DRIFT the moment Riot pages one early,
  // and a checker that is always red is a checker nobody reads.
  const gated = new Set(UNRELEASED.map((u) => u.id));

  let html: string;
  try {
    html = await fetchText(`${SITE}/`);
  } catch (e) {
    // Upstream unreachable is NOT drift. It is "nothing was checked", which is
    // yellow rather than red — but it is not clean either, and saying CURRENT
    // here would be a lie the runner would repeat.
    return void verdict('UNVERIFIED', `! could not reach ${SITE}/ — ${(e as Error).message}`);
  }

  let grid: { items?: unknown[] } | undefined;
  try {
    grid = blades(nextData(html)).find((b: { type?: string }) => b.type === 'characterCardGrid');
  } catch (e) {
    return void verdict('UNREADABLE', `✖ __NEXT_DATA__ would not parse — ${(e as Error).message}`);
  }
  if (!grid) {
    // Markup drift, not an empty roster. Reporting DRIFT here would say "Riot
    // removed every champion", which is never the right conclusion.
    return void verdict(
      'UNREADABLE',
      '✖ no characterCardGrid blade in __NEXT_DATA__ — the page shape changed.\n' +
        '  Re-read scripts/riot-site.ts and champions.ts before trusting anything here.',
    );
  }

  const upstream: string[] = [];
  for (const item of (grid.items ?? []) as { action?: { payload?: { url?: string } } }[]) {
    const link = item?.action?.payload?.url ?? '';
    const slug = link.replace(/\/+$/, '').split('/').pop()?.toLowerCase();
    if (slug) upstream.push(slug);
  }
  if (upstream.length === 0)
    return void verdict('UNREADABLE', '✖ characterCardGrid carried no readable item urls.');

  const upstreamIds = new Set(upstream);
  const missing = [...upstreamIds].filter((id) => !localIds.has(id) && !gated.has(id)).sort();
  const extra = [...localIds].filter((id) => !upstreamIds.has(id)).sort();
  const paged = [...upstreamIds].filter((id) => gated.has(id)).sort();

  console.log(
    `  ${upstreamIds.size} champion(s) on the grid · ${localIds.size} in characters.json`,
  );
  if (paged.length)
    console.log(`  ${paged.length} gated (announced, held back): ${paged.join(', ')}`);

  if (!missing.length && !extra.length)
    return void verdict('CURRENT', '✓ roster matches Riot’s champion grid');

  const lines: string[] = ['✖ roster has drifted from Riot’s champion grid', ''];
  for (const id of missing)
    lines.push(
      `  MISSING  ${id} — on the grid, not in data/characters.json.`,
      `           If they are playable, add them (see scripts/expiries.ts for the full`,
      `           runbook — this repo's characters.json is a hand-authored INPUT, not a`,
      `           build output). If they are announced but NOT yet playable, add an`,
      `           UNRELEASED row instead and this line becomes a "gated" note.`,
    );
  for (const id of extra)
    lines.push(
      `  EXTRA    ${id} — in data/characters.json, not on the grid.`,
      `           Usually a typo'd id or a slug Riot renamed. Confirm before deleting`,
      `           anything: records already reference this id.`,
    );
  verdict('DRIFT', lines.join('\n'));
}

await main();

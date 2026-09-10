/**
 * Self-expiring gates — things the DATA can tell us are due, rather than things
 * a human has to remember.
 *
 * WHY THIS FILE EXISTS HERE AT ALL, AND WHY IT ARRIVED LAST. Four of the six
 * sibling repos have had this gate for months; 2XKO and Tekken did not, and a
 * 2026-09-09 roster audit across all six is what surfaced the hole. Nothing in
 * this repo could have told anyone that a champion had shipped:
 * scripts/champions.ts only ENRICHES ids that are already in
 * data/characters.json, so it never discovers a new champion from Riot's grid,
 * and this repo has no residue gate to catch the name in upload titles either.
 * Roster drift here was, until now, findable only by a human going and looking.
 *
 * THE SEVERITY DESIGN, matching the siblings — read before "fixing" anything:
 *
 *   scripts/champions.ts   (manual roster run)  → prints its own gaps, exits 0
 *   .github/workflows/…    (daily cron)         → a FINAL step, AFTER commit,
 *                                                 push and the deploy smoke
 *                                                 check, that exits 1
 *
 * The cron step is deliberately LAST and deliberately failing. A hard exit
 * earlier would stop the daily refresh, which is strictly worse than the thing
 * it warns about: a day of stale data costs more than a day of a champion
 * filed under no accent. So the data gets committed, pushed and smoke-checked
 * first, and only then does the run go red so the pending work is impossible
 * to miss.
 *
 * THE RED WORKFLOW AND THE exit 1 ARE THE DESIGN, NOT A BUG. Clear them by
 * doing the work below — never by deleting the check.
 *
 * Run: npm run data:expiries   (tsx scripts/expiries.ts --check)
 */

import type { Expiry } from '../types/index';

/**
 * Champions that are ANNOUNCED but not yet playable.
 *
 * A row here is what turns a future release into a due expiry instead of
 * something someone has to diary. `releases` is the date the row FIRES.
 *
 * THIS LIST HAS A KNOWN END, WHICH IS UNUSUAL AND WORTH SAYING OUT LOUD. Riot
 * announced that active development of 2XKO ends in December 2026, and named
 * Samira as the game's FINAL champion. So unlike every sibling repo — where the
 * roster is open-ended and the gate is permanent — this file has exactly one
 * job, once. When Samira ships and this array empties, 2XKO's roster is closed
 * for good and the array stays empty forever.
 *
 * FOR A MONTH-GRANULARITY ANNOUNCEMENT THE DATE IS THE LAST DAY OF THE WINDOW.
 * Riot gave a month and a patch number, not a day. Firing at window OPEN would
 * mean a red run every day from 1 October until she ships, and an alarm that is
 * red all month is an alarm that gets muted. Firing at window CLOSE costs at
 * most one late day, and the content-aware detector below covers the gap.
 *
 * WHAT COVERS THE GAP is `npm run data:roster-check`, which diffs Riot's own
 * champion grid against data/characters.json. That fires on the real event — a
 * new card appearing in the grid — rather than on a date someone guessed, and
 * it cannot be early or late. This date row is the backstop for the opposite
 * case: Riot ships her and the grid or the checker is unreachable.
 *
 * PROVENANCE. riotgames.com/en/news/2xko-active-development-ends-december-2026:
 * "October - Patch 1.3.3 … Launching in October, 2XKO's final champion is
 * Samira, the Desert Rose." Corroborated on the live 1.3.1 patch notes, which
 * refer forward to "Samira's launch skin" in patch 1.3.3. Verified NOT playable
 * on 2026-09-09: she is absent from the characterCardGrid blade on
 * 2xko.riotgames.com/en-us/champions/, and /en-us/champions/samira/ returns 404
 * where /en-us/champions/yasuo/ returns 200.
 */
export const UNRELEASED: { id: string; releases: string; accent?: string; note?: string }[] = [
  {
    id: 'samira',
    releases: '2026-10-31',
    note:
      'Patch 1.3.3, announced for OCTOBER 2026 with no day; this row fires at window CLOSE. ' +
      "2XKO's FINAL champion — active development ends December 2026, so nothing follows her. " +
      'No accent has been derived: it comes from a Claude Design session, never invented here, ' +
      'and it must clear 4.5:1 on the page background and sit a hue away from its chip ' +
      'neighbours (Senna and Teemo, alphabetically).',
  },
];

const today = (): string => new Date().toISOString().slice(0, 10);

/** Everything whose date has now passed. Empty is the happy path. */
export function dueExpiries(asOf: string = today()): Expiry[] {
  const due: Expiry[] = [];

  for (const u of UNRELEASED) {
    if (asOf >= u.releases) {
      due.push({
        kind: 'unreleased-champion',
        id: u.id,
        date: u.releases,
        action:
          `${u.id} should now be playable. If it is: confirm the spelling on ` +
          `2xko.riotgames.com/en-us/champions/, add --champ-${u.id} to ` +
          `design/handoff/tokens.css (${
            u.accent
              ? `the handoff already derived ${u.accent}`
              : 'accent from a Claude Design session — never invent one'
          }), MIRROR the same hex into BOTH design/handoff/tailwind.config.js and ` +
          `accents in app/app.config.ts — this repo has three copies of every accent and ` +
          `nothing cross-checks them — then hand-add the champion object to ` +
          `data/characters.json (2XKO is the one repo where that file is the INPUT, not a ` +
          `build output), add the release patch to data/patchBoundaries.json and ` +
          `data/patchGroups.json with the champion as its note, drop this entry from ` +
          `UNRELEASED, and run \`npm run data:champions\` then \`npm run data:parse\` then ` +
          `\`npx tsx scripts/og.ts\`. Two things no gate will catch: the OG card is rebuilt ` +
          `from characters.json and goes stale silently, and ` +
          `assets/name-templates/${u.id}-left.png / -right.png cannot be scraped — they come ` +
          `off real footage, and until they exist scripts/fuses.ts scores no name for them. ` +
          `If ${u.id} has NOT shipped, re-date this row — do not delete it.`,
      });
    }
  }

  return due;
}

/** Human-facing block, reused by the console banner and any report surface. */
export function formatExpiries(due: Expiry[]): string {
  return due.map((e) => `- **${e.id}** (${e.kind}, due ${e.date})\n  ${e.action}`).join('\n\n');
}

// ── standalone `--check` ─────────────────────────────────────────────────────
// The workflow's LAST step. It runs after the data has been committed, pushed
// and smoke-checked, so a red run never costs a refresh — it only makes the
// pending work impossible to ignore.
const isMain = !!process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain && process.argv.includes('--check')) {
  const due = dueExpiries();
  if (!due.length) {
    console.log(`✓ no expiries due — ${UNRELEASED.length} unreleased row(s) pending`);
    process.exit(0);
  }
  console.error(`\n✖ ${due.length} EXPIRY(S) DUE — this step is designed to go red.\n`);
  for (const d of due) {
    console.error(`  ${d.id}  (${d.kind}, due ${d.date})`);
    console.error(`    ${d.action}\n`);
  }
  console.error('  Clear these by doing the work above. Never by deleting the check.');
  process.exit(1);
}

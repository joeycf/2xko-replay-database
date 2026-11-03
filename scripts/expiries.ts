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
 *   .github/workflows/pending-work.yml          → runs after every completed
 *                                                 data run, whatever it
 *                                                 concluded, and exits 1
 *
 * The step is deliberately failing, and deliberately NOT in the data run. A hard
 * exit there would stop the daily refresh, which is strictly worse than the
 * thing it warns about: a day of stale data costs more than a day of a champion
 * filed under no accent. So the data run commits, pushes and smoke-checks on
 * its own, and "Pending work" (workflow_run on its completion) goes red so the
 * pending work is impossible to miss — and a held data run can no longer hide
 * a due expiry behind it, which it did on 2026-10-12.
 *
 * THE RED PENDING-WORK RUN AND THE exit 1 ARE THE DESIGN, NOT A BUG. Clear them by
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
 * THIS LIST WAS EXPECTED TO HAVE A KNOWN END, AND THE END WAS WRONG BY ONE.
 * Riot announced that active development of 2XKO ends in December 2026 and named
 * Samira as the game's final champion, so this file was written to do one job,
 * once. Patch 1.3.3 (2026-10-27) then shipped Samira AND Sett ("Sett and Samira
 * join the fight") — Sett with no announcement this file ever saw, so no row
 * here fired for him and only `data:roster-check` caught him (MISSING sett).
 * Both were promoted 2026-11-02 and the array is empty. Keep it, and keep the
 * roster check: an unannounced champion is exactly what a date row cannot see.
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
 * PROVENANCE OF THE LAST ROW (samira, 2026-10-31, removed on promotion):
 * riotgames.com/en/news/2xko-active-development-ends-december-2026, "October -
 * Patch 1.3.3 … Launching in October, 2XKO's final champion is Samira, the
 * Desert Rose." She shipped in 1.3.3 on 2026-10-27, four days inside her window.
 */
export const UNRELEASED: { id: string; releases: string; accent?: string; note?: string }[] = [];

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
              : 'accent DERIVED in-session by engine checklist 14c: sample the anchor hue from ' +
                "the champion's own splash, place it in a free OKLCH hue window ≥ 8–12° from " +
                'every roster accent, clear 4.5:1 on --bg-base, present 3–4 candidates and let ' +
                'a person pick; mark it DERIVED in tokens.css'
          }), MIRROR the same hex into BOTH design/handoff/tailwind.config.js and ` +
          `accents in app/app.config.ts — this repo has three copies of every accent and ` +
          `nothing cross-checks them — then hand-add the champion object to ` +
          `data/characters.json (2XKO is the one repo where that file is the INPUT, not a ` +
          `build output; fields imgPortrait/imgSplash/accent null, extra.aliases required, ` +
          `alphabetical — the chip order follows it), add the release patch to ` +
          `data/patchBoundaries.json with the champion as its note (start = the date in the ` +
          `post's title and URL, never data:patch-check's publish-time fallback; patchGroups ` +
          `regenerates on parse), drop this entry from UNRELEASED, and run ` +
          `\`npm run data:champions\` then \`npm run data:build\` (a stale raw/ refuses a plain ` +
          `parse) then ` +
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
// The "Pending work" workflow's step. It runs after the data run has completed
// (committed, pushed and smoke-checked — or held), so a red run never costs a
// refresh — it only makes the pending work impossible to ignore.
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

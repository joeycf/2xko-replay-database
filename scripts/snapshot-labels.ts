// Protect the hand labels the extractor is scored against.
//
// The 20 Evo records in data/manual-videos.json were authored BEFORE this
// extractor existed, by a human watching the footage. That makes them the only
// genuinely blind ground truth this project has, and blindness is the entire
// basis of the accuracy claim.
//
// Two things can destroy it, both quietly:
//
//  1. RELABELLING THROUGH /dev/evo-review. That page shows the extractor's
//     proposal beside the saved verdict — which is exactly what makes it a good
//     completion tool and exactly what makes it a bad labelling tool. A reviewer
//     who "confirms" a side while looking at the proposal has not produced an
//     independent label, and scoring against it afterwards measures agreement
//     with a suggestion rather than accuracy.
//  2. `git restore data/manual-videos.json`, which erases hours of watching with
//     no warning and no diff to notice.
//
// So capture them first. Everything downstream scores against the SNAPSHOT, not
// against whatever the file says later, and the labelling pass is then free to
// correct, complete and overwrite without corrupting its own measurement.
//
// Run: npx tsx scripts/snapshot-labels.ts            # capture (refuses to clobber)
//      npx tsx scripts/snapshot-labels.ts --check    # exit 1 if any label drifted
//      npx tsx scripts/snapshot-labels.ts --force    # re-capture deliberately
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManualVideosFile } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(ROOT, 'cache/evo/ground-truth.json');

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const force = argv.includes('--force');

interface Label {
  id: string;
  tournament: string;
  /** TITLE order, exactly as the hand-authored entry holds it */
  teams: string[][];
  /** an entry still carrying a todo was never a finished label */
  todo: string | null;
}

const file = JSON.parse(readFileSync(join(DATA, 'manual-videos.json'), 'utf8')) as ManualVideosFile;
const labels: Label[] = (file.videos ?? [])
  .filter((v) => /Evo/i.test(v.tournament ?? ''))
  .map((v) => ({
    id: v.id,
    tournament: v.tournament ?? '',
    teams: (v.teams ?? []).map((t) => [...(t.characters ?? [])].sort()),
    todo: v.todo ?? null,
  }));

const complete = labels.filter((l) => !l.todo && l.teams.every((t) => t.length > 0));

if (check) {
  if (!existsSync(OUT)) {
    console.error(`✖ no snapshot at ${OUT} — run \`npx tsx scripts/snapshot-labels.ts\` first`);
    process.exit(1);
  }
  const snap = JSON.parse(readFileSync(OUT, 'utf8')) as { labels: Label[] };
  const by = new Map(snap.labels.map((l) => [l.id, l]));
  const drift: string[] = [];
  for (const l of labels) {
    const s = by.get(l.id);
    if (!s) continue; // new entry since the snapshot — not drift
    if (JSON.stringify(s.teams) !== JSON.stringify(l.teams)) {
      drift.push(`  ${l.id}: ${JSON.stringify(s.teams)} → ${JSON.stringify(l.teams)}`);
    }
  }
  if (drift.length) {
    console.log(`⚠ ${drift.length} label(s) changed since the snapshot:`);
    for (const d of drift) console.log(d);
    console.log('\n  This is EXPECTED if the labelling pass corrected them. The snapshot is');
    console.log('  still the blind ground truth — scoring reads it, not the live file.');
    process.exit(1);
  }
  console.log(`✔ all ${labels.length} label(s) match the snapshot`);
  process.exit(0);
}

if (existsSync(OUT) && !force) {
  console.error(
    `✖ ${OUT} already exists.\n` +
      `  Re-capturing after a labelling pass would replace the blind ground truth with\n` +
      `  post-hoc labels and quietly turn the accuracy number into self-agreement.\n` +
      `  Pass --force only if you mean to.`,
  );
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString().slice(0, 10),
      note: 'Hand labels as they stood BEFORE the extractor was scored. Blind ground truth — score against this, never against the live file.',
      labels,
    },
    null,
    2,
  ) + '\n',
);
console.log(`✔ captured ${labels.length} label(s) → ${OUT}`);
console.log(
  `  ${complete.length} complete · ${labels.length - complete.length} still open (todo or empty side)`,
);

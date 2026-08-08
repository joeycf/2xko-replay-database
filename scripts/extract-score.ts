// Score the footage extractor against the hand-authored records.
//
// THE SIDES ARE COMPARED AS AN UNORDERED PAIR, and that is a deliberate narrowing
// of what this number claims. Neither array is in a trustworthy order: the
// extraction's left/right are SCREEN positions, and the hand-authored teams are in
// TITLE order, which the recon already found reversed on at least one corpus video.
// A positional comparison would measure the title-order assumption as much as the
// reader. Attribution is scored separately below, because folding it in would hide
// it — which is exactly the defect that blocked Tekken's enrollment.
//
// AND THE POPULATIONS ARE REPORTED SEPARATELY. The corpus splits by script and the
// two halves do not perform alike, so a single percentage over both would be a
// number that describes neither. Same for the frames this session's recon put on
// screen: those predictions leaked, so they are scored apart from the blind ones.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE } from './hud-frames';

const asJson = process.argv.includes('--json');

/** Videos whose frames were displayed during the recon, so their champions were
 *  seen before the extractor ran. Blindness is the whole basis of an accuracy
 *  claim, so the honest fix is to report BOTH populations and say which to trust —
 *  not to quietly average them. */
const EXPOSED = new Set(['zxRvkDeYL8w', 'QWjpY279YCs', 'jEWF1k9zyPk', 'LeLxCI1Dbmk']);

interface Extraction {
  id: string;
  title: string;
  left: { characters: string[]; confidence: number };
  right: { characters: string[]; confidence: number };
  side: { leftIsFirst: boolean; decided: boolean };
  confidence: number;
  resolved: boolean;
}

const out = join(CACHE, 'extracted.json');
if (!existsSync(out)) {
  console.error(`✖ no ${out} — run \`npx tsx scripts/complete-characters.ts\` first`);
  process.exit(1);
}
const extractions = JSON.parse(readFileSync(out, 'utf8')) as Extraction[];

// SCORE AGAINST THE SNAPSHOT, NOT THE LIVE FILE. The hand labels in
// data/manual-videos.json were authored before this extractor existed, which is
// what makes them blind — but the completion pass edits that same file while the
// extractor's proposal is on screen. Reading it here would score the extractor
// against labels its own output helped produce, and the number would drift
// upward every time someone accepted a proposal. scripts/snapshot-labels.ts
// captures the pre-pass state; this reads only that.
const snapPath = join(CACHE, 'ground-truth.json');
if (!existsSync(snapPath)) {
  console.error(`✖ no ${snapPath} — run \`npx tsx scripts/snapshot-labels.ts\` first`);
  process.exit(1);
}
const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as {
  capturedAt: string;
  labels: { id: string; tournament: string; teams: string[][]; todo: string | null }[];
};
const manual = snap.labels.map((l) => ({ id: l.id, tournament: l.tournament }));
// an entry that still carried a todo was never a finished label — excluded, not
// counted as a miss
const labels = new Map(
  snap.labels
    .filter((l) => !l.todo && l.teams.every((t) => t.length > 0))
    .map((l) => [l.id, l.teams]),
);

const key = (xs: string[]): string => [...xs].sort().join('+');
const pairKey = (a: string[], b: string[]): string => [key(a), key(b)].sort().join(' | ');
/** Which event, and therefore which script the nameplates were in. */
const script = (id: string): 'katakana' | 'latin' =>
  /Japan/i.test(manual.find((v) => v.id === id)?.tournament ?? '') ? 'katakana' : 'latin';

interface Row {
  id: string;
  script: 'katakana' | 'latin';
  exposed: boolean;
  got: string[][];
  want: string[][];
  bothExact: boolean;
  sidesExact: number;
  missed: string[];
  invented: string[];
  confidence: number;
  resolved: boolean;
  decided: boolean;
}

const rows: Row[] = [];
for (const e of extractions) {
  const want = labels.get(e.id);
  if (!want) continue; // the new video has no hand label — nothing to score against
  const got = [e.left.characters, e.right.characters];
  // per-side: pair each extracted side with its best-matching label side
  let sidesExact = 0;
  const used = new Set<number>();
  for (const g of got) {
    const i = want.findIndex((wv, j) => !used.has(j) && key(wv) === key(g));
    if (i !== -1) {
      used.add(i);
      sidesExact++;
    }
  }
  const flatGot = new Set(got.flat());
  const flatWant = new Set(want.flat());
  rows.push({
    id: e.id,
    script: script(e.id),
    exposed: EXPOSED.has(e.id),
    got,
    want,
    bothExact: pairKey(got[0]!, got[1]!) === pairKey(want[0]!, want[1]!),
    sidesExact,
    missed: [...flatWant].filter((c) => !flatGot.has(c)),
    invented: [...flatGot].filter((c) => !flatWant.has(c)),
    confidence: e.confidence,
    resolved: e.resolved,
    decided: e.side.decided,
  });
}

const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`);
const tally = (rs: Row[]) => ({
  n: rs.length,
  both: rs.filter((r) => r.bothExact).length,
  sides: rs.reduce((a, r) => a + r.sidesExact, 0),
  sidesN: rs.length * 2,
  invented: rs.reduce((a, r) => a + r.invented.length, 0),
  missed: rs.reduce((a, r) => a + r.missed.length, 0),
});

if (asJson) {
  console.log(JSON.stringify({ rows, overall: tally(rows) }, null, 2));
  process.exit(0);
}

console.log('── extractor accuracy ─────────────────────────────────────────');
console.log(`  blind ground truth captured ${snap.capturedAt} (cache/evo/ground-truth.json)`);
console.log(
  `  scored ${rows.length} of ${extractions.length} extractions (the rest have no hand label)\n`,
);

const show = (name: string, rs: Row[]): void => {
  if (!rs.length) return;
  const t = tally(rs);
  console.log(
    `  ${name.padEnd(22)} both-sides ${String(t.both).padStart(2)}/${String(t.n).padEnd(2)} ${pct(t.both, t.n).padStart(6)}   ` +
      `per-side ${String(t.sides).padStart(2)}/${String(t.sidesN).padEnd(2)} ${pct(t.sides, t.sidesN).padStart(6)}   ` +
      `invented ${t.invented}  missed ${t.missed}`,
  );
};

console.log('  BY SCRIPT — the split this corpus lives or dies on');
show(
  'katakana (Evo Japan)',
  rows.filter((r) => r.script === 'katakana'),
);
show(
  'latin (Evo Vegas)',
  rows.filter((r) => r.script === 'latin'),
);
console.log('');
console.log('  BY EXPOSURE — trust the blind row');
show(
  'blind',
  rows.filter((r) => !r.exposed),
);
show(
  'exposed (recon)',
  rows.filter((r) => r.exposed),
);
console.log('');
show('ALL', rows);

// ── the gate ─────────────────────────────────────────────────────────────────
// At n=20 a percentage is coarse, so the bar is qualitative: nothing fabricated,
// every miss explained, and the multi-champion subset exact.
const fabricated = rows.filter((r) => r.invented.length > 0);
const multi = rows.filter((r) => r.want.some((w) => w.length > 2));
console.log('\n── the gate (small-n: qualitative, not a percentage) ──────────');
console.log(
  `  fabrications (a champion the label lacks)   ${fabricated.length}  ${fabricated.length === 0 ? '✔' : '✖'}`,
);
for (const r of fabricated) console.log(`      ${r.id} invented ${r.invented.join(',')}`);
console.log(
  `  multi-champion sides exact                  ${multi.filter((r) => r.bothExact).length}/${multi.length}`,
);
console.log(
  `  auto-accepted (conf >= 0.90 and decided)    ${rows.filter((r) => r.resolved).length}/${rows.length}`,
);
console.log(
  `  side undecided                              ${rows.filter((r) => !r.decided).length}/${rows.length}`,
);

// ── attribution, scored separately and never folded in ───────────────────────
// ONE READ SIDE IS ENOUGH, and requiring two was hiding the answer. `resolveSide`
// decides which TITLE team sits on the screen's left; checking that needs only a
// side whose champions were read and a label that says which team owns them. The
// earlier form required BOTH sides exact, which excluded every video with one
// unread side — and on this corpus that is precisely where both reversals live,
// so it reported "0 reversed" while the extractor had called two and been right
// about both. A measurement that structurally cannot observe the positive case is
// not a measurement.
const attr = { agree: 0, contradict: 0, noSignal: 0, reversedTruth: 0, ids: [] as string[] };
for (const e of extractions) {
  const want = labels.get(e.id);
  if (!want || !e.side.decided) continue;
  const t1 = key(want[0]!);
  const t2 = key(want[1]!);
  if (t1 === t2) {
    attr.noSignal++; // mirror — carries no orientation signal
    continue;
  }
  // use whichever screen side actually read
  const L = e.left.characters.length ? key(e.left.characters) : null;
  const R = e.right.characters.length ? key(e.right.characters) : null;
  let leftIsFirstTruth: boolean | null = null;
  if (L === t1 || R === t2) leftIsFirstTruth = true;
  else if (L === t2 || R === t1) leftIsFirstTruth = false;
  if (leftIsFirstTruth === null) {
    attr.noSignal++;
    continue;
  }
  if (!leftIsFirstTruth) attr.reversedTruth++;
  if (e.side.leftIsFirst === leftIsFirstTruth) attr.agree++;
  else {
    attr.contradict++;
    attr.ids.push(e.id);
  }
}
const attrN = attr.agree + attr.contradict;
console.log('\n── player attribution (resolveSide vs the labels) ─────────────');
console.log(`  checkable (>=1 side read, not a mirror)     ${attrN}`);
console.log(
  `  resolveSide AGREES with the label           ${attr.agree}  ${attrN ? pct(attr.agree, attrN) : ''}`,
);
console.log(`  resolveSide CONTRADICTS the label           ${attr.contradict}`);
for (const id of attr.ids) console.log(`      ${id}`);
console.log(`  no signal (mirror or unmatched)             ${attr.noSignal}`);
console.log(
  `\n  ground-truth title-order defect rate       ${attr.reversedTruth}/${attrN}  ${attrN ? pct(attr.reversedTruth, attrN) : ''}` +
    `  (Tekken measured 37.7%, SF6 12.8%)`,
);

// ── threshold sweep: where does precision break? ─────────────────────────────
console.log('\n── confidence sweep ──────────────────────────────────────────');
console.log('  threshold  accepted  both-exact  precision');
for (const th of [0.01, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  const acc = rows.filter((r) => r.confidence >= th);
  const good = acc.filter((r) => r.bothExact).length;
  console.log(
    `  ${th.toFixed(2).padStart(9)}  ${String(acc.length).padStart(8)}  ${String(good).padStart(10)}  ${pct(good, acc.length).padStart(9)}`,
  );
}

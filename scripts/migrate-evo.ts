// One-shot migration: move the Evo corpus from hand-authored records to
// footage-verdict overrides on a fetched channel.
//
// WHY IT CARRIES RATHER THAN RE-DERIVES. Enrolling @EvoEvents means parse.ts
// builds these records from raw/ instead of from data/manual-videos.json, and the
// obvious implementation lets the title supply the players and a new grammar
// supply the tournament and round. That would throw away the three things a human
// just spent a sitting establishing:
//
//   · ATTRIBUTION. Title order is reversed on 2 of 18 checkable videos, and one of
//     them (f2KZcuecUe0) shipped with its sides swapped in BOTH the champion and
//     fuse columns. Re-deriving players from title order re-introduces exactly
//     that class of error, silently, on the records we know it bites.
//   · THE FUSE COLUMN. All 42 sides were read off the pill by hand
//     (data/fuse-validation-evo.json). Nothing re-derives that — broadcast fuse
//     detection is still gated on an incomplete template set.
//   · DUO SIDES. 7 sides carry two players, and the titles join them with "/",
//     which CHAR_SEP (channels.ts) treats as a CHARACTER separator. A title parse
//     would split "SonicFox/INZEM" in the wrong dimension.
//
// So each record becomes an overrides.json entry holding the verdict verbatim,
// and the fetched record supplies only metadata — publishedAt, durationSec,
// viewCount, thumbnail — which comes from the API and is better than the
// hand-copied values it replaces.
//
// Run: npx tsx scripts/migrate-evo.ts [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManualVideosFile, Team, VideoRecord } from '../types/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const dry = process.argv.includes('--dry');

/** parse.ts:52's identity rule, restated character-for-character.
 *
 *  It STRIPS non-alphanumerics rather than replacing them with a separator —
 *  "Jake'n'bake" is `jakenbake`, not `jake-n-bake`. The sibling repos use the
 *  hyphenating form, and taking it from there produced ids that would never
 *  match the ones parse.ts registers, quietly fragmenting a player across two
 *  pages. Restated helpers drift; this one is checked against its source. */
const slugify = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const manualPath = join(DATA, 'manual-videos.json');
const overridesPath = join(DATA, 'overrides.json');
const file = JSON.parse(readFileSync(manualPath, 'utf8')) as ManualVideosFile;
const overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>;
const players = JSON.parse(readFileSync(join(DATA, 'players.json'), 'utf8')) as {
  id: string;
  handle: string;
  extra?: { aliases?: string[] };
}[];

// resolve a display name to its registry id the same way parse.ts does, so a
// verdict cannot mint a second page for an existing player
const alias = new Map<string, { id: string; displayName: string }>();
for (const p of players) {
  alias.set(p.handle.toLowerCase(), { id: p.id, displayName: p.handle });
  for (const a of p.extra?.aliases ?? [])
    alias.set(a.toLowerCase(), { id: p.id, displayName: p.handle });
}
const resolvePlayer = (name: string): { id: string; displayName: string } =>
  alias.get(name.trim().toLowerCase()) ?? { id: slugify(name), displayName: name.trim() };

const evo = (file.videos ?? []).filter((v) => /Evo/i.test(v.tournament ?? ''));
const kept = (file.videos ?? []).filter((v) => !/Evo/i.test(v.tournament ?? ''));

const today = new Date().toISOString().slice(0, 10);
let n = 0;
const unresolved: string[] = [];

for (const v of evo) {
  const sides: ('left' | 'right')[] = ['left', 'right'];
  const teams: Team[] = (v.teams ?? []).map((t, i) => {
    const ps = (t.players ?? []).map(String).map(resolvePlayer);
    for (const [j, raw] of (t.players ?? []).entries())
      if (!alias.has(String(raw).trim().toLowerCase()))
        unresolved.push(`${v.id}: "${raw}" → new player ${ps[j]!.id}`);
    return {
      side: sides[i]!,
      players: ps,
      characters: [...(t.characters ?? [])],
      fuse: t.fuse ?? null,
    };
  });

  const rec: Partial<VideoRecord> & { '//'?: string } = {
    '//': `evo migration: hand-validated verdict carried from manual-videos.json [${today}]`,
    teams,
    allCharacters: [...new Set(teams.flatMap((t) => t.characters))],
    allPlayers: [...new Set(teams.flatMap((t) => t.players.map((p) => p.id)))],
    matchType: 'tournament',
    parseConfidence: 'high',
    tournament: v.tournament,
    ...(v.round ? { round: v.round } : {}),
  };
  overrides[v.id] = { ...(overrides[v.id] as object satisfies object | undefined), ...rec };
  n++;
}

if (unresolved.length) {
  console.log(
    `  ⚠ ${unresolved.length} player name(s) not in players.json — parse will register them:`,
  );
  for (const u of unresolved) console.log(`      ${u}`);
}

// data/overrides.json stores non-ASCII escaped; writing it literally would
// reformat every line containing one. Same serializer the review routes use.
const serialize = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(
    /[-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  ) + '\n';

if (!dry) {
  writeFileSync(overridesPath, serialize(overrides));
  writeFileSync(manualPath, JSON.stringify({ ...file, videos: kept }, null, 2) + '\n');
}
console.log(
  `${dry ? '(dry) ' : ''}✔ ${n} Evo record(s) → overrides.json · manual-videos.json ${evo.length} → ${kept.length} entries`,
);
console.log('  Next: add evoEvents to scripts/channels.ts, then npm run data:build');

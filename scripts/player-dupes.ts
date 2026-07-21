// Scan data/players.json for entries that probably describe the SAME human and
// should be consolidated. Read-only: prints candidate pairs ranked by how much
// merging them would fix. Nothing here edits the registry — see the report
// footer for the merge recipe.
//
// Heuristics (a pair is reported if ANY fires; the label says which):
//   sponsor  — one handle is the other plus a leading/trailing team tag
//              ("2WINZ HARU" ↔ "HARU", "HARU | TSM" ↔ "HARU")
//   initials — the same handle with the first word abbreviated
//              ("Filipino Champ" ↔ "F. Champ", "Uncivil Ninja" ↔ "U. Ninja")
//   slug     — slugs collide after stripping separators/diacritics ("Xi-Ao" ↔ "XiAo").
//              Also flags parser ids that took a -2 suffix (the parser only
//              suffixes when a DIFFERENT name slugged the same).
//   leet     — equal after folding 0/1/3/4/5/7 → o/i/e/a/s ("K1NG" ↔ "KING")
//   typo     — OSA edit distance ≤1 on slugs of length ≥5 ("garanti" ↔ "garantl")
//   affix    — one slug is the other + a short numeric/regional tail
//              ("zane" ↔ "zaneuk", "poka" ↔ "poka2")
//
// Usage: npx tsx scripts/player-dupes.ts [--min-count 0] [--json]

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Player, VideoRecord } from '../types/index';

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const readJson = async <T>(p: string): Promise<T> =>
  JSON.parse(await readFile(join(DATA, p), 'utf8')) as T;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const minCount = Number(args[args.indexOf('--min-count') + 1]) || 0;

// ── normalizers ───────────────────────────────────────────────────────────────

/** Same slugify parse.ts uses — id-space collisions are what create dupes. */
const slugify = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };
const deleet = (s: string): string => s.replace(/[013457]/g, (c) => LEET[c]);

/** Optimal String Alignment distance, capped — same metric parse.ts uses for champions. */
function osaDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2; // caller only cares about ≤1
  const d = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
    }
  }
  return d[a.length][b.length];
}

/** Handle split into words; sponsor tags are separate words or |/-delimited. */
const words = (handle: string): string[] =>
  handle
    .split(/[\s|/\\]+|(?<=[a-z])-(?=[A-Z])/)
    .map((w) => slugify(w))
    .filter(Boolean);

// ── load ──────────────────────────────────────────────────────────────────────

const players = await readJson<Player[]>('players.json');
const videos = await readJson<VideoRecord[]>('videos.json');

const counts = new Map<string, number>();
const champsOf = new Map<string, Map<string, number>>(); // playerId -> championId -> picks
for (const v of videos) {
  for (const id of v.allPlayers ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const t of v.teams) {
    for (const p of t.players) {
      const m = champsOf.get(p.id) ?? new Map<string, number>();
      for (const c of t.characters) m.set(c, (m.get(c) ?? 0) + 1);
      champsOf.set(p.id, m);
    }
  }
}
const countOf = (id: string): number => counts.get(id) ?? 0;

/** Top champions by pick count — a shared main is strong evidence two names are one player. */
const topChamps = (id: string, n = 3): string[] =>
  [...(champsOf.get(id) ?? new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([c]) => c);

// ── pairwise candidates ───────────────────────────────────────────────────────

interface Candidate {
  a: Player;
  b: Player;
  kinds: string[];
  note: string;
}

const bySlug = new Map<string, Player[]>();
const byLeet = new Map<string, Player[]>();
const byWord = new Map<string, Player[]>(); // every word of the handle — candidates only, validated pairwise
for (const p of players) {
  const slug = slugify(p.handle);
  const push = (m: Map<string, Player[]>, k: string): void => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.some((q) => q.id === p.id)) list.push(p);
    m.set(k, list);
  };
  push(bySlug, slug);
  push(byLeet, deleet(slug));
  for (const w of new Set(words(p.handle))) if (w.length >= 3) push(byWord, w);
}

const candidates = new Map<string, Candidate>(); // "idA idB" (sorted) -> candidate
const add = (a: Player, b: Player, kind: string, note: string): void => {
  if (a.id === b.id) return;
  const key = [a.id, b.id].sort().join(' ');
  const hit = candidates.get(key);
  if (hit) {
    if (!hit.kinds.includes(kind)) hit.kinds.push(kind);
    return;
  }
  // canonical first: more replays wins, ties → the featured/curated one
  const [x, y] =
    countOf(a.id) !== countOf(b.id)
      ? countOf(a.id) > countOf(b.id)
        ? [a, b]
        : [b, a]
      : a.featured && !b.featured
        ? [a, b]
        : [b, a];
  candidates.set(key, { a: x, b: y, kinds: [kind], note });
};

const pairsIn = (
  groups: Map<string, Player[]>,
  kind: string,
  note: (k: string) => string,
): void => {
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) add(list[i], list[j], kind, note(k));
  }
};

pairsIn(bySlug, 'slug', (k) => `both slug to "${k}"`);
pairsIn(byLeet, 'leet', (k) => `equal after leet-folding to "${k}"`);

// A shared WORD is only a candidate — "RIOT POLKADOT" and "RIOT YOHOSIE" share a
// sponsor tag, not an identity. Confirm pairwise: either the shorter handle
// survives whole as a word of the longer (sponsor), or the longer's first word
// is abbreviated to its initial in the shorter (initials).
for (const [, list] of byWord) {
  if (list.length < 2) continue;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      const [long, short] = slugify(a.handle).length >= slugify(b.handle).length ? [a, b] : [b, a];
      const longWords = words(long.handle);
      const shortWords = words(short.handle);
      const shortSlug = slugify(short.handle);

      if (longWords.length > shortWords.length && longWords.includes(shortSlug)) {
        add(a, b, 'sponsor', `"${long.handle}" is "${short.handle}" plus a team tag`);
        continue;
      }
      // "Filipino Champ" → "F. Champ": same trailing words, first word initialled
      const lHead = longWords[0];
      const sHead = shortWords[0];
      if (
        longWords.length > 1 &&
        longWords.length === shortWords.length &&
        sHead.length === 1 &&
        lHead.length > 1 &&
        lHead.startsWith(sHead) &&
        longWords.slice(1).join() === shortWords.slice(1).join()
      )
        add(a, b, 'initials', `"${short.handle}" abbreviates "${long.handle}"`);
    }
  }
}

// typo + affix are O(n²) over slugs — 728 players, fine
const slugs = players.map((p) => ({ p, s: slugify(p.handle) }));
for (let i = 0; i < slugs.length; i++) {
  for (let j = i + 1; j < slugs.length; j++) {
    const { p: a, s: sa } = slugs[i];
    const { p: b, s: sb } = slugs[j];
    if (sa.length >= 5 && sb.length >= 5 && osaDistance(sa, sb) === 1)
      add(a, b, 'typo', `1-character difference ("${sa}" vs "${sb}")`);
    const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
    if (short.length >= 4 && long.startsWith(short)) {
      const tail = long.slice(short.length);
      if (tail.length <= 3 && /^(?:\d+|[a-z]{1,3})$/.test(tail))
        add(a, b, 'affix', `"${long}" is "${short}" + "${tail}"`);
    }
  }
}

// ── rank + report ─────────────────────────────────────────────────────────────

const KIND_WEIGHT: Record<string, number> = {
  slug: 5,
  leet: 4,
  sponsor: 3,
  initials: 3,
  typo: 2,
  affix: 1,
};
/** Champions both sides pick. Fighting-game players main the same duo across accounts,
 *  so an overlap corroborates a name match — and a disjoint pool argues against it. */
const sharedChamps = (c: Candidate): string[] => {
  const bs = new Set(topChamps(c.b.id, 4));
  return topChamps(c.a.id, 4).filter((x) => bs.has(x));
};

const score = (c: Candidate): number => {
  const strength = Math.max(...c.kinds.map((k) => KIND_WEIGHT[k] ?? 0)) + (c.kinds.length - 1);
  const volume = Math.min(countOf(c.a.id), countOf(c.b.id)); // both sides actually used
  return (strength + sharedChamps(c).length) * 100 + volume;
};

const ranked = [...candidates.values()]
  .filter((c) => countOf(c.a.id) + countOf(c.b.id) >= minCount)
  .sort((x, y) => score(y) - score(x));

if (asJson) {
  console.log(
    JSON.stringify(
      ranked.map((c) => ({
        canonical: {
          id: c.a.id,
          handle: c.a.handle,
          featured: c.a.featured,
          replays: countOf(c.a.id),
        },
        duplicate: {
          id: c.b.id,
          handle: c.b.handle,
          featured: c.b.featured,
          replays: countOf(c.b.id),
        },
        kinds: c.kinds,
        note: c.note,
        sharedChampions: sharedChamps(c),
      })),
      null,
      2,
    ),
  );
} else {
  const orphans = players.filter((p) => countOf(p.id) === 0);
  console.log(
    `\n${players.length} players · ${videos.length} videos · ${ranked.length} duplicate candidates\n`,
  );
  for (const c of ranked) {
    const tag = (p: Player): string =>
      `${p.handle} (${p.id}, ${countOf(p.id)} replays${p.featured ? ', featured' : ''})`;
    const shared = sharedChamps(c);
    const champs = shared.length
      ? `both main ${shared.join('/')}`
      : `no shared champions — ${topChamps(c.a.id, 2).join('/') || '?'} vs ${topChamps(c.b.id, 2).join('/') || '?'}`;
    console.log(
      `[${c.kinds.join('+')}] ${tag(c.a)}\n         ↔ ${tag(c.b)}\n         ${c.note}\n         ${champs}\n`,
    );
  }
  console.log(`${orphans.length} registry entries with 0 replays (stale or alias-only):`);
  console.log(orphans.map((p) => p.id).join(', ') || '(none)');
  console.log(
    [
      '',
      'To merge the second entry (B) into the first (A):',
      '  1. data/players.json — add B.handle + all of B.extra.aliases to A.extra.aliases,',
      '     then delete the B entry. Both halves matter: without the aliases the next',
      '     parse just re-discovers B from the same titles under a fresh id.',
      '  2. data/overrides.json + data/manual-videos.json — rewrite any player id "B" to "A".',
      '     Overrides shallow-merge whole teams[] arrays with hardcoded ids, so they bypass',
      '     alias resolution and would keep B alive on their own.',
      '  3. npm run data:parse   (re-resolves every title against the updated registry)',
      '',
      'parse.ts only prunes players discovered WITHIN a run, and players.json round-trips,',
      'so nothing here disappears on its own — every merge needs the manual delete in step 1.',
      '',
    ].join('\n'),
  );
}

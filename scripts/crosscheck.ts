// THE SECOND WITNESS, as a pure predicate.
//
// WHAT THIS MEASURES, and why it is worth a file. Replay Theater's catalogue is
// mostly NOT tournament footage: 2,648 of its 3,547 2XKO entries at first ingest
// carried no event tag, and those are online ranked play. They are out of
// INGESTION scope by design — this repo already tracks three channels of exactly
// that, and what it was worst at was tournament sets, which is the whole reason
// the index intake exists.
//
// But out of ingestion scope is not out of scope as EVIDENCE. Most of those
// untagged rows point at a video THIS REPO HAS ALREADY PUBLISHED from a tracked
// channel. Each one is an independent human reading of the same match: a stranger
// typed the two handles and the two champions into a form, and our parser read
// them out of the uploader's title. Neither saw the other.
//
// That makes this the first continuous accuracy measurement of our own title
// parser against something that is not us. Every other number in report.md is the
// pipeline grading its own homework.
//
// IT PRODUCES NO FIELD AND GATES NOTHING. A disagreement is recorded in
// data/theater-disagreements.json with both claims side by side; it never edits a
// record, never outranks a confident parse, and never outranks a human override.
// RT is a witness, not an authority — the same posture the intake already takes
// when it resolves champions on an exact alias only and drops the rest to residue.
//
// THE THIRD OUTCOME IS THE POINT. agree / disagree is not enough, because a
// witness that CANNOT REPRESENT the answer is not disagreeing with it. The
// catalogue's schema is lossier than ours, and in this game the loss is recorded
// platform doctrine rather than a suspicion: README, "What it does not carry" —
// "the index's schema caps 2XKO at two [champions per side], so it cannot express
// a within-set counter-pick the way manual-videos.json can". A side of ours that
// is longer than two is therefore something the catalogue COULD NOT HAVE SAID,
// not something it contradicted, and scoring it as a disagreement would make
// agreement unreachable for exactly the records a resolver would want. Anything
// in that shape is counted as `cannotWitness` and reported separately.
//
// EXACT ALIAS, NEVER FUZZY. The catalogue writes display names and this repo
// stores ids. parse.ts's `resolveChampion` is a three-step ladder — exact alias,
// then word-contains, then OSA ≤ 1 — and its job is to read prose out of somebody
// else's sentence. Reaching for it here would turn a second WITNESS into a second
// PARSER: a near-miss would become a confident champion nobody played, and the
// two readings would agree because one of them guessed. So this takes the same
// exact-alias-only path buildTheaterRecords and the manual validator already take
// (parse.ts, `champByAlias.get(...)` with no fallback), and a catalogue string the
// roster does not know is `cannotWitness` rather than a disagreement.

import type { VideoRecord } from '../types/index';

/** One catalogue entry, exactly as the catalogue publishes it. Everything is
 *  nullable: this is someone else's schema and we do not get to assume. Mirrors
 *  `TheaterEntry` in scripts/fetch-theater.ts, which writes the witness file. */
export interface WitnessEntry {
  id?: number;
  game?: string | null;
  video_link?: string | null;
  tag?: string | null;
  p1_name?: string | null;
  p2_name?: string | null;
  p1_char?: string | null;
  p1_char2?: string | null;
  p1_char3?: string | null;
  p1_char4?: string | null;
  p2_char?: string | null;
  p2_char2?: string | null;
  p2_char3?: string | null;
  p2_char4?: string | null;
}

/** raw/replayTheater.witness.json — the pull's own self-report plus EVERY entry
 *  it saw, tagged and untagged. */
export interface WitnessFile {
  mode?: 'cursor' | 'full';
  maxEntryId?: number;
  pagesRead?: number;
  hitBound?: boolean;
  entries?: WitnessEntry[];
}

/** One row the cross-check could not settle, carrying BOTH claims. This is what
 *  reaches data/theater-disagreements.json — never a rewritten record. */
export interface Disagreement {
  videoId: string;
  field: 'players' | 'characters';
  /** 0 or 1, in our record's team order. Absent for a whole-record player miss. */
  side?: number;
  ours: string[];
  theirs: string[];
  title: string;
}

export interface CrossCheckResult {
  /** Videos where exactly one catalogue entry lines up with one of our
   *  whole-video records. A video the catalogue has cut into several segments is
   *  excluded: those are the intake's own territory and there is no 1:1 claim to
   *  compare against. */
  compared: number;
  /** Catalogue entries that pointed at a video we do not hold. Not a failure —
   *  it is most of the catalogue — but the denominator of "reach". */
  unmatched: number;
  /** Videos we hold that the catalogue indexes as several segments. */
  segmented: number;
  /** Videos we hold in a shape with no two sides to align — a record whose
   *  `teams` is not exactly two. That is a defect in OUR record rather than
   *  anything the catalogue did, so it is counted separately and compared
   *  against nothing. One exists in the corpus today (a low-confidence
   *  bestReplays row whose duo never split), and the catalogue does not index
   *  it. */
  unalignable: number;
  players: { both: number; one: number; neither: number; flipped: number };
  characters: {
    sides: number;
    agree: number;
    subset: number;
    disagree: number;
    cannotWitness: number;
  };
  disagreements: Disagreement[];
}

/**
 * data/theater-disagreements.json — the committed home of everything the
 * cross-check knows, written ONLY by a full sweep.
 *
 * WHY THE MEASUREMENT IS COMMITTED RATHER THAN RECOMPUTED INTO report.md ON
 * EVERY RUN. The witness is rebuilt from scratch on each pull and holds only the
 * pages that pull read, so a cursor morning's window is a few hundred catalogue
 * rows and its numbers differ from yesterday's — a different WINDOW, not a
 * different corpus. Rendering those into report.md made the file change every
 * single morning whether or not any RECORD had, which defeats the cron's
 * no-change-no-commit rule from the other side and puts a deploy on the calendar
 * every day forever. That is the same failure the `_Generated` timestamp line
 * already has a suppression for, arriving through a door nobody was watching.
 *
 * So: a FULL sweep measures and writes; every run renders report.md from what is
 * committed; a cursor morning prints its own reading to the console and leaves
 * the artifact alone. The block says which sweep it came from — by the
 * catalogue's own high-water entry id, which is content, not a clock.
 */
export interface WitnessArtifact {
  /** The reading, frozen at the last full sweep. */
  measured?: {
    /** The catalogue's high-water entry id at that sweep — names the sweep
     *  without a timestamp, so re-rendering it cannot churn the file. */
    atEntryId: number;
    compared: number;
    unmatched: number;
    segmented: number;
    /** This repo carries a fourth outcome the other games do not: a record of
     *  ours with no two sides to align. It is rendered, so it is measured. */
    unalignable: number;
    players: CrossCheckResult['players'];
    characters: CrossCheckResult['characters'];
  };
  disagreements: Disagreement[];
}

/** The YouTube id inside a catalogue link. The catalogue's submission form
 *  concatenates rather than builds — `https://youtu.be/<id>&t=554s` is a PATH
 *  with no query string — so this matches the id SHAPE explicitly and refuses
 *  anything else rather than guessing. Same regex the intake uses
 *  (scripts/fetch-theater.ts), deliberately duplicated rather than exported from
 *  there: that module fetches at import time and this one must stay pure. */
const VIDEO_ID =
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:live|shorts|embed)\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** A side's champions in the catalogue's own order and spelling. Four columns
 *  exist in the schema; a 2XKO side is a duo, so two are filled. */
const charsOf = (e: WitnessEntry, side: 1 | 2): string[] =>
  ([`p${side}_char`, `p${side}_char2`, `p${side}_char3`, `p${side}_char4`] as const)
    .map((k) => (e as unknown as Record<string, unknown>)[k])
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());

const setEq = (a: string[], b: string[]): boolean => {
  const A = new Set(a);
  const B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};
const subsetOf = (a: string[], b: string[]): boolean => a.every((x) => b.includes(x));

/**
 * @param witness      every entry the pull saw, tagged and untagged
 * @param committed    our published records
 * @param byAlias      the roster's exact-alias table: display name → champion id
 *                     (parse.ts's `champByAlias`, built from data/characters.json)
 * @param resolveKey   this repo's player identity key, applied to the
 *                     CATALOGUE's handle strings — registry alias lookup, then
 *                     slugify, exactly as parse.ts's resolvePlayer decides an id,
 *                     but READ-ONLY (it must not register a discovered player)
 * @param stripSponsor the catalogue's own handle cleanup ("OEG | Slate" → "Slate")
 * @param splitPlayers the catalogue's duo delimiter — a 2XKO side can be two
 *                     people, so `p1_name` is not always one handle
 * @param sideCap      how many champions the CATALOGUE can express per side. FOUR
 *                     columns exist in its schema, but 2XKO is capped at TWO by
 *                     the index itself (README, "Two champions per side,
 *                     always"), so a side of ours longer than that is a record it
 *                     structurally cannot witness.
 */
export function crossCheck(
  witness: WitnessFile,
  committed: VideoRecord[],
  byAlias: Map<string, string>,
  resolveKey: (h: string) => string,
  stripSponsor: (h: string) => string,
  splitPlayers: (s: string) => string[],
  sideCap = 2,
): CrossCheckResult {
  // Only WHOLE-VIDEO records are comparable. Our index-intake records are
  // `${videoId}@${startSeconds}` segments built FROM this catalogue, so checking
  // them against it would be checking it against itself — and in this repo that
  // exclusion is total, because every replayTheater record is a segment.
  const ours = new Map<string, VideoRecord>();
  for (const v of committed) if (!v.id.includes('@')) ours.set(v.id, v);

  const byVideo = new Map<string, WitnessEntry[]>();
  for (const e of witness.entries ?? []) {
    const m = VIDEO_ID.exec(e.video_link ?? '');
    if (!m) continue;
    byVideo.set(m[1], [...(byVideo.get(m[1]) ?? []), e]);
  }

  const r: CrossCheckResult = {
    compared: 0,
    unmatched: 0,
    segmented: 0,
    unalignable: 0,
    players: { both: 0, one: 0, neither: 0, flipped: 0 },
    characters: { sides: 0, agree: 0, subset: 0, disagree: 0, cannotWitness: 0 },
    disagreements: [],
  };

  for (const [videoId, entries] of byVideo) {
    const mine = ours.get(videoId);
    if (!mine) {
      r.unmatched++;
      continue;
    }
    // The catalogue cut this VOD into segments. Our record is the whole video, so
    // there is no single claim to compare — and these are the intake's own rows
    // anyway.
    if (entries.length > 1) {
      r.segmented++;
      continue;
    }
    const e = entries[0];
    // A record with anything other than two teams has no side to align, and the
    // alignment below indexes [0] and [1] — it must not invent a side to do it.
    // Counted on its own rather than folded into `unmatched`: we DO hold the
    // video, so calling it unmatched would misreport the witness's reach.
    if (mine.teams.length !== 2) {
      r.unalignable++;
      continue;
    }
    r.compared++;

    const theirSides = ([1, 2] as const).map((n) => ({
      players: splitPlayers(stripSponsor(String(e[`p${n}_name`] ?? '')))
        .map((x) => resolveKey(x))
        .filter(Boolean),
      chars: charsOf(e, n),
    }));
    // OUR players already carry this repo's identity key — `TeamPlayer.id` IS
    // what resolvePlayer decided when the record was built — so they are read
    // rather than re-resolved. Re-running the resolver here would register the
    // catalogue's handles as discovered players, which is a write, and this
    // measurement writes nothing.
    const ourSides = mine.teams.map((t) => ({
      players: t.players.map((p) => p.id),
      chars: t.characters,
    }));

    // ORIENTATION. The catalogue's p1/p2 is the submitter's reading of the screen
    // and ours is the title's; they agree nearly always but not always, and
    // comparing champions across a swapped pair would manufacture two
    // disagreements out of none. Aligned on the handles, which is the field the
    // two sources agree on most.
    const score = (a: typeof ourSides, b: typeof theirSides) =>
      a.reduce((n, s, i) => n + (s.players.some((p) => b[i].players.includes(p)) ? 1 : 0), 0);
    const flipped = score(ourSides, [theirSides[1], theirSides[0]]) > score(ourSides, theirSides);
    const theirs = flipped ? [theirSides[1], theirSides[0]] : theirSides;
    if (flipped) r.players.flipped++;

    const hits = ourSides.reduce(
      (n, s, i) => n + (s.players.some((p) => theirs[i].players.includes(p)) ? 1 : 0),
      0,
    );
    if (hits === 2) r.players.both++;
    else if (hits === 1) r.players.one++;
    else {
      r.players.neither++;
      r.disagreements.push({
        videoId,
        field: 'players',
        ours: ourSides.flatMap((s) => s.players),
        theirs: theirs.flatMap((s) => s.players),
        title: mine.title,
      });
    }

    for (let i = 0; i < 2; i++) {
      r.characters.sides++;
      const mineChars = ourSides[i].chars;
      // EXACT ALIAS ONLY. A catalogue string the roster does not know is not a
      // disagreement — it is a witness we cannot read, and guessing at it is how
      // a second witness becomes a second parser.
      const raw = theirs[i].chars;
      const resolved = raw.map((c) => byAlias.get(c.toLowerCase()));
      if (raw.length === 0 || resolved.some((x) => x === undefined)) {
        r.characters.cannotWitness++;
        continue;
      }
      // THE SCHEMA CEILING, and in this game it is recorded doctrine rather than
      // an inference: the index caps a 2XKO side at TWO champions and cannot
      // express a within-set counter-pick. A side of ours that is longer is not
      // something the catalogue declined to report; it is something it could not
      // have said.
      if (mineChars.length > sideCap) {
        r.characters.cannotWitness++;
        continue;
      }
      const theirChars = resolved as string[];
      if (setEq(mineChars, theirChars)) r.characters.agree++;
      // A SIDE OF OURS THAT IS EMPTY IS NOT A PARTIAL READING OF THEIRS, and this
      // is where the shape departs from the games whose sides are always filled.
      // `subsetOf([], theirs)` is vacuously true, so an empty side would score as
      // "partial" and vanish into a column nobody acts on — when what actually
      // happened is that the catalogue named the champions and we named none.
      // Those are the most actionable rows the check produces, so they are
      // disagreements and they are written out with both claims.
      else if (
        mineChars.length > 0 &&
        (subsetOf(mineChars, theirChars) || subsetOf(theirChars, mineChars))
      )
        r.characters.subset++;
      else {
        r.characters.disagree++;
        r.disagreements.push({
          videoId,
          field: 'characters',
          side: i,
          ours: mineChars,
          theirs: theirChars,
          title: mine.title,
        });
      }
    }
  }
  return r;
}

const pct = (n: number, total: number) =>
  total === 0 ? '—' : `${((n / total) * 100).toFixed(2)}%`;

/**
 * The report.md block, rendered from the COMMITTED artifact rather than from
 * this run — see WitnessArtifact for why. Byte-identical between full sweeps,
 * which is what keeps a quiet morning quiet, and empty until a sweep has
 * measured something.
 */
export function formatCrossCheck(a: WitnessArtifact): string[] {
  const m = a.measured;
  if (!m || m.compared === 0) return [];
  const c = m.characters;
  return [
    `## Replay Theater cross-check`,
    ``,
    `An independent reading of **${m.compared}** of our own records, from the catalogue's`,
    `UNTAGGED entries — online replays it indexes that we also parse from a tracked`,
    `channel. Neither side saw the other, so this is the only accuracy number here the`,
    `pipeline did not produce about itself. It changes nothing: a disagreement is`,
    `recorded in \`data/theater-disagreements.json\` with both claims, never written into`,
    `a record. The catalogue does not outrank a confident parse and never outranks a`,
    `human override.`,
    ``,
    // `unmatched` is counted once per VIDEO — the loop walks the catalogue
    // grouped by video id, so a VOD submitted five times is one row here, not
    // five. It said "entr(ies)" for its first day and that was simply the wrong
    // word for the number.
    `_Measured on the last full sweep, at catalogue entry ${m.atEntryId}. ${m.unmatched} distinct video(s)_`,
    `_the catalogue links are ones we do not hold; ${m.segmented} are VODs it segments, which the_`,
    `_intake owns; ${m.unalignable} point at a record of ours with no two sides to align._`,
    ``,
    `| field | population | agree | partial | disagree | cannot witness |`,
    `|---|---|---|---|---|---|`,
    `| players (both handles) | ${m.compared} | ${m.players.both} (${pct(m.players.both, m.compared)}) | ${m.players.one} | ${m.players.neither} | — |`,
    `| champions (per side) | ${c.sides} | ${c.agree} (${pct(c.agree, c.sides)}) | ${c.subset} | ${c.disagree} (${pct(c.disagree, c.sides)}) | ${c.cannotWitness} |`,
    ``,
    `Side order differed on **${m.players.flipped}** record(s); the comparison realigns on the`,
    `handles before reading champions, so a swapped pair is not counted twice as a`,
    `champion disagreement.`,
    ``,
    `**Cannot witness** is not disagreement: the index caps a 2XKO side at two champions`,
    `and cannot express a within-set counter-pick, and a champion string its vocabulary`,
    `spells differently from ours resolves to nothing. Neither is the catalogue`,
    `contradicting us — it is the catalogue being unable to say what we said.`,
    ``,
    ...(a.disagreements.length
      ? [
          `**${a.disagreements.length} disagreement(s)** — both claims, ours first:`,
          ``,
          ...a.disagreements
            .slice(0, 25)
            .map(
              (d) =>
                `- \`${d.videoId}\`${d.side !== undefined ? ` side ${d.side}` : ''} ${d.field}: ` +
                `**${d.ours.join(', ') || '(none)'}** vs catalogue **${d.theirs.join(', ') || '(none)'}** — ${d.title.slice(0, 70)}`,
            ),
          ...(a.disagreements.length > 25 ? [`- … ${a.disagreements.length - 25} more`] : []),
          ``,
        ]
      : [`No disagreements on that sweep.`, ``]),
  ];
}

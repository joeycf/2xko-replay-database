import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Champion, FootageQueue, Fuse, VideoRecord } from '~~/types';

// Dev-only: persists champion verdicts for footage-channel records into
// data/overrides.json.
//
// IT USED TO WRITE data/manual-videos.json, and the reason it no longer does is
// the same migration that emptied this tool's worklist. While every record here
// was hand-authored, overrides.json was the wrong target — parse.ts merges
// overrides over PARSED records only, so a verdict written there would have been
// silently discarded. Since 4a0a591 the corpus IS parsed records, on a channel
// whose whole contract is that the champion verdict lives in overrides.json
// (`charactersFromFootage`), and manual-videos.json is the file that would now
// discard the write. The target followed the corpus.
//
// THE MERGE IS SHALLOW AND LAST, which is why `allCharacters` is written out
// rather than left to the pipeline. parse.ts computes it at build time from the
// parsed teams and never recomputes it after `{ ...merged, ...ov }`, so an
// override that carries teams and not allCharacters publishes a record whose
// champions and whose champion INDEX disagree — visible on the site as a match
// that no champion page lists. The 21 migrated Evo verdicts all carry it.
//
// Accepts BATCHES because a labelling pass is a sitting, not a click — but
// reports per-entry outcomes instead of throwing, so one bad row cannot discard
// the rest of the sitting.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 });
  const body = await readBody<{ entries?: unknown }>(event);
  const entries = body?.entries;
  if (!Array.isArray(entries)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'expected { entries: [{ id, characters: [string[], string[]] }] }',
    });
  }

  const root = process.cwd();
  const characterList = JSON.parse(
    readFileSync(join(root, 'data/characters.json'), 'utf8'),
  ) as Champion[];
  const known = new Set(characterList.map((c) => c.id));
  const fuses = JSON.parse(readFileSync(join(root, 'data/fuses.json'), 'utf8')) as Record<
    string,
    Fuse
  >;

  // Only ids the pipeline is actually holding a slot for are writable, mirroring
  // /dev/fuse-review's rule that the gap report defines the editable set. An id
  // outside it is either excluded, on another channel, or gone from the dump —
  // all cases where a verdict would sit in overrides.json attached to nothing.
  const queuePath = join(root, 'cache/evo/footage-queue.json');
  if (!existsSync(queuePath)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'footage-queue.json not found — run `npm run data:parse` first',
    });
  }
  const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as FootageQueue;
  const queued = new Map(queue.items.map((v) => [v.id, v]));

  const ovPath = join(root, 'data/overrides.json');
  const overrides = JSON.parse(readFileSync(ovPath, 'utf8')) as Record<
    string,
    Partial<VideoRecord> & { '//'?: string; exclude?: boolean }
  >;

  // The broadcast fuse ground truth, mirroring data/fuse-validation.json's shape.
  // TITLE order, like the record it sits beside — the reviewer assigns to team 1
  // / team 2, and the detector's screen-order read is mapped through the side
  // resolution when scored. Every verdict lands here, INCLUDING one that merely
  // confirms the stored value: that confirmation is the only thing separating a
  // read fuse from the 38-of-40 `freestyle` default.
  const vePath = join(root, 'data/fuse-validation-evo.json');
  const validated = existsSync(vePath)
    ? (JSON.parse(readFileSync(vePath, 'utf8')) as Record<
        string,
        { left?: string | null; right?: string | null }
      >)
    : {};
  let validatedWritten = 0;

  let written = 0;
  const rejected: { id: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const raw of entries) {
    const e = raw as { id?: unknown; characters?: unknown; fuses?: unknown };
    const id = typeof e.id === 'string' ? e.id : '';
    const chars = e.characters;
    const isSide = (s: unknown): s is string[] =>
      Array.isArray(s) && s.every((c) => typeof c === 'string');
    if (!id) {
      rejected.push({ id: '?', reason: 'missing id' });
      continue;
    }
    if (!Array.isArray(chars) || chars.length !== 2 || !chars.every(isSide)) {
      rejected.push({ id, reason: 'expected characters: [string[], string[]]' });
      continue;
    }
    const sides = chars as [string[], string[]];
    const unknownIds = [...new Set(sides.flat().filter((c) => !known.has(c)))];
    if (unknownIds.length) {
      rejected.push({ id, reason: `unknown champion id(s): ${unknownIds.join(', ')}` });
      continue;
    }
    // Exclusion is checked BEFORE the queue lookup, because the queue omits
    // excluded ids — asking about one there would answer "re-run data:parse",
    // which is both wrong and the kind of advice that gets followed.
    if (overrides[id]?.exclude) {
      rejected.push({
        id,
        reason: 'ruled out by an exclusion in overrides.json — clear that first',
      });
      continue;
    }
    const item = queued.get(id);
    if (!item) {
      rejected.push({ id, reason: 'not in the footage queue — re-run `npm run data:parse`' });
      continue;
    }
    // NOT malformation — the expected state for a record nobody has authored yet.
    // These titles carry no champions in parentheses, so TEAM_SPLIT rejects them
    // and the parsed record has NO teams at all: not even players or sides. A
    // footage verdict therefore has to supply the whole skeleton, which is what
    // the 21 migrated Evo entries carry and what this tool cannot invent — the
    // reviewer reads champions off the HUD, not who was playing.
    if (item.teams.length !== 2) {
      rejected.push({
        id,
        reason:
          'the title parse produced no teams — author the skeleton (sides + players) in overrides.json first, then re-run `npm run data:parse`',
      });
      continue;
    }

    // FUSES ARE THREE-STATE, and collapsing them to two is how the column got
    // into its current shape. `undefined` means the reviewer has not looked at
    // this side yet and the stored value is left alone; `null` means they looked
    // and the pill was unreadable, which is a real finding worth recording; a
    // string is a read. Only the last two touch the file, so an unfinished pass
    // never overwrites anything with a shrug.
    let fusePair: (string | null | undefined)[] | null = null;
    if (e.fuses !== undefined) {
      if (
        !Array.isArray(e.fuses) ||
        e.fuses.length !== 2 ||
        !e.fuses.every((f) => f === null || f === undefined || typeof f === 'string')
      ) {
        rejected.push({ id, reason: 'expected fuses: [id|null|undefined, ...] when provided' });
        continue;
      }
      const bad = [
        ...new Set(
          (e.fuses as (string | null | undefined)[]).filter(
            (f): f is string => typeof f === 'string' && !fuses[f],
          ),
        ),
      ];
      if (bad.length) {
        rejected.push({ id, reason: `unknown fuse id(s): ${bad.join(', ')}` });
        continue;
      }
      fusePair = e.fuses as (string | null | undefined)[];
    }

    // NO SILENT DELETION. This is a COMPLETION tool: it exists to fill sides in,
    // and a save that empties a side that already had champions is a data loss,
    // not an edit. It is also indistinguishable at the wire from a UI bug, a
    // stale draft, or a mis-seeded form — all of which cost a human's watching
    // time to undo and leave no trace that anything went missing.
    //
    // So the writer refuses, per side, and says which. A reviewer who genuinely
    // means to clear one passes allowClear.
    const allowClear = (raw as { allowClear?: unknown }).allowClear === true;
    const wiped = ([0, 1] as const).filter(
      (i) => item.teams[i]!.characters.length > 0 && sides[i]!.length === 0,
    );
    if (wiped.length && !allowClear) {
      rejected.push({
        id,
        reason: `would empty ${wiped.map((i) => (i === 0 ? 'team 1' : 'team 2')).join(' and ')} — pass allowClear to mean it`,
      });
      continue;
    }

    const dedupe = (xs: string[]): string[] => [...new Set(xs)];
    const base = overrides[id];
    // Teams come from the QUEUE, which is the merged record: side and players as
    // the pipeline resolved them, plus whatever verdict already stands. Rebuilding
    // them from the request would let a stale page overwrite a corrected roster.
    const teams = item.teams.map((t, i) => ({
      ...t,
      characters: dedupe(sides[i]!),
      fuse: fusePair && fusePair[i] !== undefined ? (fusePair[i] as string | null) : t.fuse,
    }));

    overrides[id] = {
      // A hand-read verdict is the highest-confidence source this repo has, and
      // the parse that produced the record could not see a single champion. The
      // 21 migrated verdicts all record it this way.
      '//': base?.['//'] ?? `champion verdict read off the broadcast HUD [/dev/evo-review]`,
      ...base,
      teams,
      allCharacters: dedupe(teams.flatMap((t) => t.characters)),
      parseConfidence: 'high',
    };

    if (fusePair) {
      for (const i of [0, 1] as const) {
        if (fusePair[i] === undefined) continue;
        validated[id] ??= {};
        validated[id]![i === 0 ? 'left' : 'right'] = fusePair[i] as string | null;
        validatedWritten++;
      }
    }
    written++;

    // Advisory only — a set-level union is legitimately any length, and a side
    // that changed its duo mid-set is the case this whole pipeline exists for.
    teams.forEach((t, i) => {
      const side = i === 0 ? 'left' : 'right';
      if (t.characters.length === 0) warnings.push(`${id} ${side}: saved with 0 champions`);
      else if (t.characters.length % 2 !== 0)
        warnings.push(
          `${id} ${side}: odd count (${t.characters.length}) — fine for a set union, double-check`,
        );
    });
  }

  if (written > 0) writeFileSync(ovPath, JSON.stringify(overrides, null, 2) + '\n');
  if (validatedWritten > 0) writeFileSync(vePath, JSON.stringify(validated, null, 2) + '\n');
  // The verdict only reaches videos.json through a parse, exactly like a fuse
  // verdict — say so rather than letting a green toast imply the site changed.
  return {
    ok: true,
    written,
    rejected,
    warnings,
    fuseVerdicts: validatedWritten,
    ...(written > 0 ? { next: 'run `npm run data:parse` to publish' } : {}),
  };
});

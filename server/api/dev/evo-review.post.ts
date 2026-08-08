import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Champion, Fuse, ManualVideosFile } from '~~/types';

// Dev-only: persists champion verdicts for Evo VODs back into
// data/manual-videos.json — the only file this endpoint touches.
//
// SAME WRITE TARGET AND SAME RULES AS /api/dev/manual-entry, deliberately. Every
// record in this corpus is hand-authored today, and a champion verdict written to
// overrides.json would be silently discarded for one: parse.ts merges overrides
// over the PARSED records only, and the fuse-only bridge added for manual entries
// carries the fuse column and nothing else. Two writers for one file would also
// be two places for the validation to drift, so this reuses the rules rather than
// restating them: ids checked against data/characters.json, sides deduped, the id
// required to exist already, and the todo marker cleared on save.
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

  const path = join(root, 'data/manual-videos.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as ManualVideosFile;

  // The broadcast fuse ground truth, mirroring data/fuse-validation.json's shape.
  // TITLE order, like the record it sits beside — the reviewer assigns to team 1
  // / team 2, and the detector's screen-order read is mapped through the side
  // resolution when scored. Every verdict lands here, INCLUDING one that merely
  // confirms the stored value: that confirmation is the only thing separating a
  // read fuse from the 38-of-40 `freestyle` default, and manual-videos.json has
  // no way to express it.
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
    const unknown = [...new Set(sides.flat().filter((c) => !known.has(c)))];
    if (unknown.length) {
      rejected.push({ id, reason: `unknown champion id(s): ${unknown.join(', ')}` });
      continue;
    }
    const entry = (file.videos ?? []).find((v) => v.id === id);
    if (!entry) {
      rejected.push({ id, reason: 'not in manual-videos.json — this tool only edits entries' });
      continue;
    }
    if (!Array.isArray(entry.teams) || entry.teams.length !== 2) {
      rejected.push({ id, reason: 'entry is malformed (expected 2 teams)' });
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
      (i) => (entry.teams[i]!.characters ?? []).length > 0 && sides[i]!.length === 0,
    );
    if (wiped.length && !allowClear) {
      rejected.push({
        id,
        reason: `would empty ${wiped.map((i) => (i === 0 ? 'team 1' : 'team 2')).join(' and ')} — pass allowClear to mean it`,
      });
      continue;
    }

    const dedupe = (xs: string[]): string[] => [...new Set(xs)];
    entry.teams[0]!.characters = dedupe(sides[0]!);
    entry.teams[1]!.characters = dedupe(sides[1]!);
    if (fusePair) {
      for (const i of [0, 1] as const) {
        if (fusePair[i] === undefined) continue;
        entry.teams[i]!.fuse = fusePair[i] as string | null;
        validated[id] ??= {};
        validated[id]![i === 0 ? 'left' : 'right'] = fusePair[i] as string | null;
        validatedWritten++;
      }
    }
    // the marker exists to say "unread"; a save is the moment that stops being true
    if (sides[0]!.length > 0 && sides[1]!.length > 0) delete entry.todo;
    written++;

    // Advisory only — a set-level union is legitimately any length, and a side
    // that changed its duo mid-set is the case this whole pipeline exists for.
    entry.teams.forEach((t, i) => {
      const side = i === 0 ? 'left' : 'right';
      if (t.characters.length === 0) warnings.push(`${id} ${side}: saved with 0 champions`);
      else if (t.characters.length % 2 !== 0)
        warnings.push(
          `${id} ${side}: odd count (${t.characters.length}) — fine for a set union, double-check`,
        );
    });
  }

  if (written > 0) writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  if (validatedWritten > 0) writeFileSync(vePath, JSON.stringify(validated, null, 2) + '\n');
  return { ok: true, written, rejected, warnings, fuseVerdicts: validatedWritten };
});

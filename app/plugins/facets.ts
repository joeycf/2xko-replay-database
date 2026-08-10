/**
 * The 2XKO fuse facet (engine game-facet API, v0.3.0):
 *  - chips only for fuses with ≥1 detection, ranked by usage (useFuses.detected)
 *  - the coverage honesty line beside the label
 *  - `fuse` is the shipped URL param, so pre-refactor deep links
 *    (/?fuse=freestyle,juggernaut) keep working natively.
 *
 * THE FUSE ATTACHES TO THE SIDE HOLDING THE SELECTED CHAMPIONS. This is the
 * refinement `gameFacets.ts` has advertised since v0.3.0, and it needed no
 * engine change — `ctx.state` has carried the live FilterState all along.
 * Before it, picking champions AND a fuse returned matches where the OPPONENT
 * ran that fuse, which is the opposite of what the filter looks like it means.
 *
 * WHY IT IS NOT SIMPLY INDEX-ALIGNED. `fuses` is in sides order, but
 * `fusesUnordered` marks the records where the CV read the PAIR confidently and
 * could NOT attribute sides — 1,931 of 5,475, over a third of the corpus. The
 * type comment says "never side-pin", and pinning them anyway would put a
 * confident wrong answer on 35% of the archive. So those fall back to
 * either-slot matching, which is what the whole facet used to do: nothing that
 * was visible before disappears, and nothing gains a side attribution the
 * footage never established. The modal and the cards already refuse to show
 * per-side tags on those records (e2e f5/f6) — the filter was the last surface
 * still pretending otherwise.
 *
 * With no champion selected the predicate is EXACTLY the old one, because
 * `[].every(…)` is true for every side. That is deliberate and load-bearing:
 * bare `?fuse=` deep links keep their shipped counts.
 *
 * Blast radius is smaller than the unordered share suggests: side-pinning can
 * only change an answer when the two slots DIFFER and the record is ordered,
 * and 2,818 of the 3,429 ordered records field the same fuse on both sides.
 * That leaves 611 records, 11.2% of the corpus, where this changes anything.
 */
export default defineNuxtPlugin(() => {
  const { detected, fuseName, coverage, replayFuses } = useFuses();

  provideGameFacets([
    {
      param: 'fuse',
      label: 'Fuse · on the selected team',
      note:
        `fuse identified for ${coverage.withFuse.toLocaleString('en-US')} of ${coverage.total.toLocaleString('en-US')} replays` +
        ' · side unknown on some, matched on either team',
      chips: detected.map((f) => ({ id: f.id, label: f.name, accent: f.accent ?? '#8B93A8' })),
      matches: (selected, { replay, state }) => {
        const { a, b, unordered } = replayFuses(replay);
        if (a === null && b === null) return false;
        const hit = (f: string | null) => f !== null && selected.includes(f);
        // Side attribution unknown — match either slot rather than invent one.
        if (unordered) return hit(a) || hit(b);
        const slots = [a, b];
        return replay.sides.some(
          (s, i) =>
            state.characters.every((c) => s.characters.includes(c)) && hit(slots[i] ?? null),
        );
      },
      chipLabel: (id) => fuseName(id),
    },
  ]);
});

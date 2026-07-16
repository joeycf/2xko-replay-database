import type { Replay } from '@engine/types';
import type { ReplayFuseFields } from '~~/types';

/**
 * The 2XKO fuse facet (engine game-facet API, v0.3.0) — the shipped Browse
 * filter restored with its exact semantics:
 *  - chips only for fuses with ≥1 detection, ranked by usage (useFuses.detected)
 *  - OR-match against EITHER team's fuse; undetected replays never match
 *  - the coverage honesty line beside the label
 *  - `fuse` is the shipped URL param, so pre-refactor deep links
 *    (/?fuse=freestyle,juggernaut) keep working natively.
 *
 * The predicate reads the fuse extension fields riding on the emitted replay
 * objects. Composition headroom: ctx.state carries the live FilterState, so
 * the promised "fuse attaches to the side holding the selected characters"
 * refinement is a predicate change here — no engine work.
 */
export default defineNuxtPlugin(() => {
  const { detected, fuseName, coverage } = useFuses();

  provideGameFacets([
    {
      param: 'fuse',
      label: 'Fuse · either team',
      note: `fuse identified for ${coverage.withFuse.toLocaleString('en-US')} of ${coverage.total.toLocaleString('en-US')} replays`,
      chips: detected.map((f) => ({ id: f.id, label: f.name, accent: f.accent ?? '#8B93A8' })),
      matches: (selected, { replay }) => {
        const fuses = (replay as Replay & ReplayFuseFields).fuses;
        return !!fuses && fuses.some((f) => f !== null && selected.includes(f));
      },
      chipLabel: (id) => fuseName(id),
    },
  ]);
});

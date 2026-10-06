/**
 * Which colour a model wears — ONE table for the whole app, never decided per
 * screen or per conversation.
 *
 * Slots used to be handed out by volume (biggest model → slot 0), once per
 * conversation. That kept a hue stable down one reader, but opus was blue in a
 * session it dominated and red in one where a sonnet subagent out-spent it, so
 * a colour never meant a model from one screen to the next. The four validated
 * `--chart-N` slots and the four model families line up one to one, so each
 * family owns a slot for good; anything else (a second model of the same
 * family, a non-Claude model, a record naming none) folds into one grey band.
 * No imports: `turnMix.ts`, `contextPlot.ts` and `statsPlot.ts` all read it.
 */
export const FAMILY_SLOTS: readonly [RegExp, number][] = [
  [/opus/i, 0],
  [/sonnet/i, 1],
  [/haiku/i, 2],
  [/fable/i, 3],
];

/** The folded tail's slot — one past the four validated hues, painted grey
 *  (`TokenComposition.tsx`'s `MODEL_SLOT`). */
export const REST_SLOT = 4;

/** A model id's own slot, or null when it belongs to no family. */
export function familySlot(id: string | null | undefined): number | null {
  if (!id) return null;
  for (const [re, slot] of FAMILY_SLOTS) if (re.test(id)) return slot;
  return null;
}

/**
 * Ids → slots, for ids given biggest first. The first id of each family takes
 * the family's slot; a later one of the same family is left out (it folds into
 * the rest), because two bands in one hue read as one model.
 */
export function familySlots(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of ids) {
    const s = familySlot(id);
    if (s == null || taken.has(s) || out.has(id)) continue;
    taken.add(s);
    out.set(id, s);
  }
  return out;
}

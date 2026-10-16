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
 *
 * The hue also says the PRICE (owner, 2026-10-11: "the redder the more
 * expensive"): the families are listed dearest first and wear the slots
 * warm to cool — fable red, opus amber, sonnet green, haiku blue — so a red
 * bar in the agent lanes is the expensive one without reading the legend.
 * Legends list in this order too (`byPrice`).
 * No imports: `turnMix.ts`, `contextPlot.ts` and `statsPlot.ts` all read it.
 */
export const FAMILY_SLOTS: readonly [RegExp, number][] = [
  [/fable/i, 1], // --chart-2, red
  [/opus/i, 3], // --chart-4, amber
  [/sonnet/i, 2], // --chart-3, green
  [/haiku/i, 0], // --chart-1, blue
];

/** Sort comparator over slots: dearest family first, the grey tail last;
 *  within a family the full hue before its tints (`TINT_STEP`). */
export function byPrice(a: number, b: number): number {
  const rank = (s: number) => {
    const i = FAMILY_SLOTS.findIndex(([, slot]) => slot === s % TINT_STEP);
    return (i < 0 ? FAMILY_SLOTS.length : i) * 10 + Math.floor(s / TINT_STEP);
  };
  return rank(a) - rank(b);
}

/** Slot `base + TINT_STEP * n` is family `base`'s hue, n steps lighter
 *  (`TokenComposition.tsx`'s `MODEL_SLOT`). Two tints per family. */
export const TINT_STEP = 5;
const TINTS = 2;

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

/** Ids reordered newest version first (`claude-opus-5-5` before
 *  `claude-opus-5`), stable otherwise — so `familySlots` gives a family's hue
 *  to its current model, not to whichever logged the most all-time. A date
 *  suffix is not a version. */
export function newestFirst(ids: string[]): string[] {
  const ver = (id: string) => (id.match(/\d+/g) ?? []).filter((d) => d.length <= 2).map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? -1) - (b[i] ?? -1);
      if (d) return d;
    }
    return 0;
  };
  return [...ids].sort((x, y) => cmp(ver(y), ver(x)));
}

/**
 * Ids → slots where EVERY model of a family gets a band, for the screens that
 * stack a corpus by model: the first id of a family (pass `newestFirst`) wears
 * the full hue, the next ones lighter tints of it. Owner, 2026-10-16: the grey
 * "6 more" hid which models ran — each one wants its own colour on the chart.
 * Past the tints, and for ids no family owns, nothing: they fold into grey.
 */
export function familyTintSlots(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Map<number, number>();
  for (const id of ids) {
    const s = familySlot(id);
    const n = s == null ? 0 : used.get(s) ?? 0;
    if (s == null || n > TINTS || out.has(id)) continue;
    used.set(s, n + 1);
    out.set(id, s + TINT_STEP * n);
  }
  return out;
}

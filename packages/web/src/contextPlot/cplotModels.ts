/**
 * Which palette slot each model wears, and the stack series that draw by model.
 *
 * Moved out of `contextPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `contextPlot/`.
 */

import {
  normalizeModel,
  sampleTotals,
  type ContextSample,
} from "@waterplane/shared";
import { familySlots, REST_SLOT } from "../modelHue.ts";
import { type StackSeries } from "./cplotPaths.ts";

/**
 * Which palette slot each model wears — FIXED app-wide by `modelHue.ts`.
 *
 * ── Why a fixed table, and why not a fifth hue ──────────────────────────────
 *
 * Slots used to go to the biggest models of THIS conversation, so opus was
 * blue in one session and red in the next. Now each family owns one of the
 * four validated slots for good; a second model of the same family, a
 * non-Claude model and a record naming none fold into one grey band
 * (`REST_SLOT`). The palette is four slots validated as a SET, in two themes,
 * under three simulated colour deficiencies (`TokenComposition.tsx`) — the
 * grey is the fold, not a fifth hue.
 *
 * ── Why it is a separate object and not computed per chart ──────────────────
 *
 * Two charts on this sheet paint models — the stacked areas and the subagent
 * bars — off two different arrays (samples, and agent runs). Which of two
 * same-family models keeps the hue is decided here once, off the table's
 * volume order (host `modelOrder`), so both charts agree.
 */
export interface ModelSlots {
  /** Models that got a slot of their own, in slot order. `idx` is the model's
   *  index in the document's table. */
  named: { id: string; idx: number; slot: number }[];
  /** The leftover band's slot and name, or null when nothing falls into it. */
  rest: { slot: number; name: string } | null;
  /** A model index (into the document's table) → its slot, or the leftover
   *  band's. Undefined — a record that named no model — lands there too. */
  slotOf(i: number | undefined): number;
}

export function modelSlots(models: string[] | undefined, unattributed: boolean): ModelSlots | null {
  if (!models?.length) return null;
  const of = familySlots(models);
  const named = models
    .map((id, idx) => ({ id, idx, slot: of.get(id) }))
    .filter((m): m is { id: string; idx: number; slot: number } => m.slot != null && models.indexOf(m.id) === m.idx)
    .sort((x, y) => x.slot - y.slot);
  const byIdx = new Map(named.map((m) => [m.idx, m.slot]));
  const more = models.length - named.length;
  const rest = more > 0 || unattributed
    ? { slot: REST_SLOT, name: more > 0 ? `${more} more` : "unattributed" }
    : null;
  return {
    named,
    rest,
    slotOf: (i) => (i != null ? byIdx.get(i) : undefined) ?? REST_SLOT,
  };
}

/** The key a leftover band is identified by. Not a model id, and deliberately
 *  unspellable as one. */
export const REST_KEY = "\u0000rest";

/**
 * The models as stack series, over the slots `modelSlots` assigned.
 *
 * Null when nothing can be attributed at all — an older host, or a backend
 * whose log names no model — and then the chart offers only its kinds.
 */
export function modelSeries(
  samples: ContextSample[],
  slots: ModelSlots | null,
  pick: "kinds" | "cum",
): StackSeries[] | null {
  if (!slots || !samples.some((s) => s.model != null && s[pick])) return null;
  const whole = (s: ContextSample) => {
    const t = s[pick];
    if (!t) return 0;
    const k = sampleTotals(t);
    return k.input + k.output + k.cacheRead + k.cacheWrite;
  };
  // Only the models that actually carried something HERE get a band. The table
  // is the whole document's — it includes models only the SUBAGENTS ran, whose
  // tokens are in no sample at all — so an unfiltered list puts a band of
  // nothing on the chart and an entry reading `opus-5 0 0%` in the legend
  // beside it. The slot still comes from the table index, so dropping an empty
  // band moves no colour.
  const out: StackSeries[] = slots.named.map((m) => ({
    key: m.id,
    name: modelLabel(m.id),
    slot: m.slot,
    at: (s: ContextSample) => (s.model === m.idx ? whole(s) : 0),
    perRequest: pick === "kinds",
  })).filter((k) => samples.some((s) => k.at(s) > 0));
  const own = new Set(slots.named.map((m) => m.idx));
  const rest = (s: ContextSample) => (s.model == null || !own.has(s.model) ? whole(s) : 0);
  // Added only where something is in it: a band of nothing is a legend entry
  // claiming a model was left out when none was.
  if (slots.rest && samples.some((s) => rest(s) > 0)) {
    out.push({ key: REST_KEY, name: slots.rest.name, slot: slots.rest.slot, at: rest, perRequest: pick === "kinds" });
  }
  return out;
}

/** Slots the validated palette has. Never raise this without re-running the
 *  palette validator in BOTH themes — see `TokenComposition.tsx`. */
export const MODEL_SLOTS = 4;

/**
 * A model id as a person would name it: the alias, without the dated snapshot
 * or the context-variant marker.
 *
 * The same rule the all-sessions screen labels its model rows by
 * (`normalizeModel`), so `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are
 * one band on both screens rather than two that look like two models.
 */
export function modelLabel(id: string): string {
  return (normalizeModel(id) ?? id).replace(/^claude-/, "");
}

import { normalizeModel, type TranscriptTurn } from "@waterplane/shared";
import { familySlots, REST_SLOT } from "./modelHue.ts";

/**
 * The reader's per-turn model donut and subagent chips, as pure data.
 *
 * A model's colour is FIXED app-wide (`modelHue.ts`): opus wears the same hue
 * under turn 3, turn 30 and in every other session. Four family slots, and one
 * grey tail for everything else — never a generated fifth hue.
 */
export { REST_SLOT };

export interface MixSlots {
  /** model id → slot. A model not in here takes `rest`. */
  of: Map<string, number>;
  /** The grey tail slot, or null when every model has its own. */
  rest: number | null;
}

/** A turn's models with its subagents' folded in by alias — the turn's figure
 *  counts both, so the bar that says who spent it must too. */
export function turnModels(t: TranscriptTurn): { id: string; tok: number; costUsd?: number }[] {
  const out = (t.models ?? []).map((m) => ({ ...m }));
  for (const a of t.agentModels ?? []) {
    const m = out.find((x) => x.id === a.id);
    if (!m) { out.push({ ...a }); continue; }
    m.tok += a.tok;
    if (a.costUsd != null) m.costUsd = (m.costUsd ?? 0) + a.costUsd;
  }
  return out;
}

export function mixSlots(turns: TranscriptTurn[]): MixSlots | null {
  const tok = new Map<string, number>();
  for (const t of turns) for (const m of turnModels(t)) tok.set(m.id, (tok.get(m.id) ?? 0) + m.tok);
  if (!tok.size) return null;
  // Biggest first only decides which of two same-family models keeps the hue.
  const order = [...tok.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const of = familySlots(order);
  return { of, rest: order.some((id) => !of.has(id)) ? REST_SLOT : null };
}

export const modelName = (id: string): string => (normalizeModel(id) ?? id).replace(/^claude-/, "");

export interface MixPart { id: string; name: string; slot: number; share: number; costUsd?: number; tok: number }

/**
 * One turn's models as bar segments, or null with nothing to draw.
 *
 * Shares are by MONEY when every model in the turn has a rate (the question
 * under a dollar figure is which model spent it), else by TOKENS — and `by`
 * says which, because the two can differ by 20× on the same turn.
 */
export function turnMix(t: TranscriptTurn, slots: MixSlots | null): { by: "cost" | "tokens"; parts: MixPart[] } | null {
  const ms = turnModels(t).filter((m) => m.tok > 0);
  if (!ms.length || !slots) return null;
  const priced = ms.every((m) => m.costUsd != null && m.costUsd > 0);
  const val = (m: { tok: number; costUsd?: number }) => (priced ? m.costUsd! : m.tok);
  const sum = ms.reduce((a, m) => a + val(m), 0);
  if (sum <= 0) return null;
  const parts: MixPart[] = [];
  const tail: typeof ms = [];
  for (const m of ms) {
    const slot = slots.of.get(m.id);
    if (slot == null) { tail.push(m); continue; }
    parts.push({ id: m.id, name: modelName(m.id), slot, share: val(m) / sum, costUsd: m.costUsd, tok: m.tok });
  }
  // The tail is ONE grey part: two greys side by side are one colour with two
  // names, so a lone tail model keeps its name and several are counted.
  if (tail.length) {
    const tok = tail.reduce((a, m) => a + m.tok, 0);
    const cost = tail.every((m) => m.costUsd != null) ? tail.reduce((a, m) => a + m.costUsd!, 0) : undefined;
    parts.push({
      id: tail.length === 1 ? tail[0].id : "\u0000rest",
      name: tail.length === 1 ? modelName(tail[0].id) : `${tail.length} more`,
      slot: REST_SLOT, share: tail.reduce((a, m) => a + val(m), 0) / sum, costUsd: cost, tok,
    });
  }
  parts.sort((a, b) => a.slot - b.slot);
  return { by: priced ? "cost" : "tokens", parts };
}

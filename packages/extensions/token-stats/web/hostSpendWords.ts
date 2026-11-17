/**
 * The host's own metered calls (plugins), as one line under the totals card. Pure words: the
 * figures arrive from `meter.status`. A call on a model with no price is COUNTED and named, never
 * read as free; with nothing priced there is no `$` at all.
 */
import { BRAND, fmtCount, fmtUsd, type MeterSummary } from "@waterplane/shared";

const plural = (n: number, one: string, many: string) => `${fmtCount(n)} ${n === 1 ? one : many}`;

/** null when the meter has recorded nothing (the line is not drawn). */
export function hostSpendWords(m: MeterSummary | null | undefined): { lead: string; text: string } | null {
  if (!m || !(m.calls > 0)) return null;
  const parts: string[] = [];
  parts.push(plural(m.calls, "call", "calls"));
  parts.push(`${fmtCount(m.inTok + m.outTok)} tokens (${fmtCount(m.inTok)} in, ${fmtCount(m.outTok)} out)`);
  const unCalls = m.unpricedCalls ?? 0;
  const pricedCalls = m.calls - unCalls;
  if (m.unpricedCalls != null && pricedCalls > 0) parts.push(`about ${fmtUsd(m.costUsd)} for the priced part`);
  else if (m.unpricedCalls == null && m.costUsd > 0) parts.push(`about ${fmtUsd(m.costUsd)}`);
  if (unCalls > 0) {
    parts.push(`${plural(unCalls, "call", "calls")} on ${unCalls === 1 ? "a model" : "models"} with no price (${fmtCount(m.unpricedTok ?? 0)} tokens), not in the dollars`);
  }
  return { lead: `Calls ${BRAND.displayName} itself made`, text: parts.join(" · ") };
}

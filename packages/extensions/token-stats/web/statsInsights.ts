/**
 * The all-sessions screen's INSIGHTS: a handful of sentences, each a measured
 * fact about where the money went on this desktop and the lever it points at.
 *
 * Pure and node-tested (`statsInsights.test.mjs`). Two rules, both this app's:
 * an insight that cannot be measured is ABSENT, never approximated (a
 * week-over-week change from a week with nothing in it is a division by zero
 * with a face on it), and nothing here applies itself — the "try" line is a
 * sentence a person acts on, never a control that acts for them.
 *
 * Dollar figures are the screen's usual COUNTERFACTUAL (list price, not a
 * bill); the sheet's caveat covers them and they are not re-caveated here.
 */
import { docInput, windowInput, fmtUsd, leversOf, modelOf, pct, perRequestMove, undatedSince, undatedWhy, type Insight, type InsightInput, type TokenDay, type TokenStatsDoc } from "@waterplane/shared";

export type { Insight, InsightInput };
export { leversOf, modelOf, perRequestMove, docInput, windowInput };

/** Sum a run of days' cost and requests. */
function spanOf(days: readonly TokenDay[]): { usd: number; turns: number } {
  let usd = 0, turns = 0;
  for (const d of days) { usd += d.cost.total; turns += d.turns; }
  return { usd, turns };
}

/** `YYYY-MM-DD` of the local day `n` days before `now`. */
function dayKey(now: number, back: number): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The share each insight is about, measured whether or not it clears its threshold — what a
 *  delta compares. Absent where the scope cannot measure it. */
function shares(x: InsightInput): Partial<Record<Insight["id"], number>> {
  const out: Partial<Record<Insight["id"], number>> = {};
  if (x.usd <= 0) return out;
  out.writes = pct(x.writeUsd, x.usd);
  if (x.cold) out.cold = pct(x.cold.usd, x.usd);
  out.agents = pct(x.agentUsd, x.usd);
  out.concentration = pct(x.topUsd.slice(0, 5).reduce((s, u) => s + u, 0), x.usd);
  return out;
}

/**
 * The insights, in reading order: the biggest structural lever first (what the
 * cache writes cost), then what the clock cost, the fan-out, how concentrated
 * the spend is, the trend, the model mix. Each is present only when its figure
 * is both measurable and large enough to be worth a line.
 */
export function statsInsights(doc: TokenStatsDoc, now: number): Insight[] {
  const x = docInput(doc);
  if (x.usd <= 0 || x.tok <= 0) return [];
  const out = leversOf(x);

  // 5. Last 7 days against the 7 before, per request (volume moves with how
  //    much you worked; the price of a request is the part a habit moves).
  // Undated records are in no day: where one could fall in the fortnight, both sums are floors
  // and the comparison is absent (shared `undatedSince`, from the fortnight's first midnight).
  const fortnight = new Date(now);
  const fortnightFrom = new Date(fortnight.getFullYear(), fortnight.getMonth(), fortnight.getDate() - 13).getTime();
  const undatedIn = !!undatedWhy(undatedSince(doc, fortnightFrom));
  const cur = undatedIn ? [] : doc.days.filter((d) => d.day > dayKey(now, 7) && d.day <= dayKey(now, 0));
  const prev = doc.days.filter((d) => d.day > dayKey(now, 14) && d.day <= dayKey(now, 7));
  const a = spanOf(cur), b = spanOf(prev);
  const mv = perRequestMove(a, b);
  if (mv) {
    out.push({
      id: "trend",
      head: `A request costs ${Math.abs(mv.ch)}% ${mv.ch > 0 ? "more" : "less"} than the week before`,
      body: `${fmtUsd(mv.perA)} per request over the last 7 days against ${fmtUsd(mv.perB)} the 7 before (${fmtUsd(a.usd)} vs ${fmtUsd(b.usd)} in all).`,
      tryThis: mv.ch > 0
        ? `Longer conversations or a dearer model are the usual cause — the costliest conversations below say which.`
        : undefined,
    });
  }
  const m = modelOf(x);
  if (m) { const { label: _l, ...i } = m; out.push(i); }
  return out;
}

/** An insight over a span, with how its share moved against the span before (`delta`). */
export interface SpanInsight extends Insight {
  /** "Up 7 points on the week before (31%)." — absent with no previous span to compare. */
  delta?: string;
}

/** How a share moved, in words. */
function moveWords(now: number, before: number, prevWords: string): string {
  const d = now - before;
  if (d === 0) return `Same share as ${prevWords}.`;
  return `${d > 0 ? "Up" : "Down"} ${Math.abs(d)} point${Math.abs(d) === 1 ? "" : "s"} on ${prevWords} (${before}%).`;
}

/**
 * The insights over ONE span (`cur`), each with its move against the span before it (`prev`,
 * null when there is none to compare). The per-request trend compares the two spans rather than
 * the last two weeks. Re-caching after breaks is absent: the span fold does not measure it.
 */
export function spanInsights(cur: InsightInput, prev: InsightInput | null, prevWords: string): SpanInsight[] {
  const out: SpanInsight[] = leversOf(cur);
  if (cur.usd <= 0 || cur.tok <= 0) return out;
  if (prev && prev.usd > 0) {
    const was = shares(prev), now = shares(cur);
    for (const i of out) {
      const a = now[i.id], b = was[i.id];
      if (a != null && b != null) i.delta = moveWords(a, b, prevWords);
    }
    const mv = perRequestMove({ usd: cur.usd, turns: cur.turns }, { usd: prev.usd, turns: prev.turns });
    if (mv) {
      out.push({
        id: "trend",
        head: `A request costs ${Math.abs(mv.ch)}% ${mv.ch > 0 ? "more" : "less"} than ${prevWords}`,
        body: `${fmtUsd(mv.perA)} per request in this span against ${fmtUsd(mv.perB)} ${prevWords}.`,
        tryThis: mv.ch > 0
          ? `Longer conversations or a dearer model are the usual cause — the costliest conversations below say which.`
          : undefined,
      });
    }
  }
  const m = modelOf(cur);
  if (m) {
    const { label, ...i } = m;
    const si: SpanInsight = i;
    const pm = prev && prev.usd > 0 ? prev.models.find((x) => x.label === label) : undefined;
    if (prev && prev.usd > 0) {
      const after = pct(cur.models.find((x) => x.label === label)?.usd ?? 0, cur.usd);
      si.delta = moveWords(after, pct(pm?.usd ?? 0, prev.usd), prevWords);
    }
    out.push(si);
  }
  return out;
}

/** Why a span's insights (or its comparison) are not drawn yet, by the read's state. */
export function spanFoldText(what: string, res: { state: string; error?: string | null; data?: { undated?: number } | null }): string {
  const undated = undatedWhy(res.data?.undated);
  if (undated) return `${what} ${undated} — not drawn.`;
  if (res.state === "offline") return `${what}: no connection — the desktop folds it.`;
  if (res.state === "error") return `${what}: the desktop could not fold it${res.error ? ` (${res.error})` : ""}.`;
  return `${what}: reading it from the desktop…`;
}

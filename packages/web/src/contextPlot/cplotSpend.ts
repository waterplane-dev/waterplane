/**
 * What a conversation has SPENT: the spend facts, their sentences, the split and the agents' band.
 *
 * Moved out of `contextPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `contextPlot/`.
 */

import {
  addTotals,
  cacheHitPct,
  fmtUsd,
  tokenTotal,
  zeroTotals,
  type ContextSample,
  type TokenTotals,
} from "@waterplane/shared";
import { fmtTokens } from "../kit/chart/chartFmt.ts";
import { f1, bandOutline } from "../kit/chart/chartPath.ts";
import { type Plot, USED } from "./cplotAxis.ts";

// ── what a conversation has SPENT, as opposed to what it is carrying ──────

/**
 * The running-total chart's facts, from the same series the curve is drawn
 * from.
 *
 * ── Why this is a second chart and not a second line ────────────────────────
 *
 * The two series share a unit and nothing else. `tok` is a LEVEL — how much
 * the next request re-reads — and it falls by two thirds at a compaction.
 * `used` is a TOTAL and cannot fall at all. Drawn on one pair of axes the
 * cumulative curve is a wall the sawtooth hides behind (they differ by orders
 * of magnitude within an afternoon); drawn on two y axes it is the dual-axis
 * chart that makes any two unrelated quantities look correlated. So: two
 * plots, stacked, sharing the x axis and nothing else, each naming its own
 * scale.
 *
 * ── The one number this must not invent ─────────────────────────────────────
 *
 * The curve ends at what the MAIN conversation spent. The session's total also
 * counts its subagents, whose own logs are dated: host `agentCumOf` merges them
 * into one running total (`ContextSeriesDoc.agentCum`), stacked on top of the
 * curve as a band (`agentSpendBand`) whose top edge ends at the total. The
 * total is still a dashed reference line, because an older host sends no
 * `agentCum` and then the GAP between the curve's end and the line is the only
 * way the agent share can be shown.
 */
export interface SpendFacts {
  /** What the main conversation had spent by its last request. A FLOOR. */
  end: number;
  /** The session's whole total, subagents included, when the host measured it
   *  — never derived from `end`, which does not contain them. */
  total: number | null;
  /** The subagent share of `total`, already inside it. */
  agents: number | null;
  /** The top of the y axis has to contain both. */
  top: number;
  /**
   * What the whole session would have cost at list prices, USD — the same
   * figure the launcher row prints, off the same fields.
   *
   * Null when nothing could be priced, and then every surface says tokens, as
   * they all did before this existed. It is NOT part of the geometry: the
   * curve is drawn in tokens because that is what the samples are, and a
   * second y axis in dollars would be the same shape twice.
   */
  costUsd: number | null;
  /** The subagent share of `costUsd`, already inside it. */
  agentCostUsd: number | null;
  /** Tokens no rate covered, in neither figure. */
  unpricedTok: number | null;
}

/** Whether the series carries a running total at all — an older host, or a
 *  backend that records no output tokens, simply has no spend chart. */
export function hasSpend(samples: ContextSample[]): boolean {
  return samples.some((s) => s.used != null && s.used > 0);
}

export function spendFacts(
  samples: ContextSample[],
  usageTok: number | null | undefined,
  agentTok: number | null | undefined,
  /** The list-price cost of the same tokens, as the host priced them — the
   *  conversation's and its agents' added up, never re-derived here from a
   *  total and one rate (`shared/pricing.ts` states why). Absent on an older
   *  host, and then this reading is exactly what it always was. */
  cost?: { total: number | null; agents: number | null; unpricedTok: number | null } | null,
): SpendFacts | null {
  if (!hasSpend(samples)) return null;
  const end = samples.reduce((m, s) => (s.used != null && s.used > m ? s.used : m), 0);
  // `usageTok` is the host's own total and is the authority; it is only used
  // when it is at least the curve's end, because a total BELOW the curve it is
  // drawn over would render as a reference line under the last point — a chart
  // contradicting itself in the one direction nobody would look twice at.
  const total = usageTok != null && usageTok >= end ? usageTok : null;
  const agents = total != null && agentTok != null && agentTok > 0 ? agentTok : null;
  // A cost of zero is not a cost: the host sends the field only where it could
  // price something, and a `0` arriving from anywhere else must read as "no
  // figure", never as "this was free".
  const costUsd = cost?.total != null && cost.total > 0 ? cost.total : null;
  return {
    end, total, agents, top: Math.max(end, total ?? 0),
    costUsd,
    agentCostUsd: costUsd != null && cost?.agents != null && cost.agents > 0 ? cost.agents : null,
    unpricedTok: cost?.unpricedTok != null && cost.unpricedTok > 0 ? cost.unpricedTok : null,
  };
}

/** The headline over the spend chart — the same two facts the launcher row's
 *  `Σ` chip carries, in words, because this screen has the room for them. */
export function spendSummary(f: SpendFacts, truncated: boolean): string {
  // The money leads where there is any: it is the figure the launcher row now
  // prints, and a screen whose headline opens with tokens while the row it was
  // opened from opens with dollars is two readings of one conversation. The
  // tokens keep their place immediately after — this section is the one with
  // room for both, and the volume is still what a usage window counts.
  const spent = f.total != null ? f.total : f.end;
  const head = f.costUsd != null
    ? `${fmtUsd(f.costUsd)} at list prices · ${fmtTokens(spent)} spent`
    : `${fmtTokens(spent)} spent`;
  const parts = [truncated ? `${head} (at least)` : `${head} so far`];
  if (f.agents != null) {
    parts.push(f.agentCostUsd != null
      ? `${fmtUsd(f.agentCostUsd)} / ${fmtTokens(f.agents)} of it in subagents`
      : `${fmtTokens(f.agents)} of it in subagents`);
  }
  return parts.join(" · ");
}

/**
 * What the spend chart is claiming, under the spend chart — split in two.
 *
 * `lead` is what stays open: only the ABSENCES (tokens no rate covered, a log
 * read part-way), because a thing that is missing from a figure is never folded
 * away. `more` is the method — how the curve is counted, what a list price is,
 * what the grey band is — and folds into `details.hint-more` under the chart.
 */
export function spendNote(f: SpendFacts, truncated: boolean, agentsDrawn = false): { lead: string | null; more: string } {
  const lead: string[] = [];
  if (f.costUsd != null && f.unpricedTok != null) {
    lead.push(`${fmtTokens(f.unpricedTok)} of these tokens ran on a model with no published rate and are in neither dollar figure.`);
  }
  if (truncated) lead.push("This log is longer than the host reads in one go, so the curve starts part-way up.");
  const more = [
    "Every request's input, cache reads and cache writes plus what it wrote back, added up as the conversation went. It only rises — a compaction resets the window, never the bill.",
  ];
  // The one thing a reader would otherwise get wrong about the dollar figure:
  // this app drives a CLI that is usually on a subscription, a flat fee.
  if (f.costUsd != null) {
    more.push(`The ${fmtUsd(f.costUsd)} is what the API would have charged for those tokens at published rates, priced per request on the model that ran it — not what anybody paid, and nothing to do with what a subscription costs.`);
  }
  if (f.agents != null) {
    more.push(agentsDrawn
      ? `The grey band on top is the ${fmtTokens(f.agents)} its subagents spent, placed at the times their own logs record, so its top edge ends on the dashed whole-session total.`
      : `The dashed line is the session's whole total; the gap between it and the curve is the ${fmtTokens(f.agents)} its subagents spent, which this host did not send as a series over time.`);
  }
  more.push("A floor: an agent log this desktop never saw is one nothing here can add.");
  return { lead: lead.length ? lead.join(" ") : null, more: more.join(" ") };
}

/**
 * ── What those tokens WERE ─────────────────────────────────────────────────
 *
 * The spend chart answers "how much", and for the reason `shared/tokens.ts`
 * opens with, "how much" on its own is this app's most misleading number:
 * measured over this desktop's whole corpus, 96% of every token was the
 * conversation being re-read out of the prompt cache. A reader who takes
 * "16M spent" for fresh input is out by two orders of magnitude, and until
 * this existed the per-session screen printed exactly that figure alone while
 * the all-sessions screen had never once shown a total without its split.
 *
 * So the same four kinds, in the same order and the same hues, per session —
 * `KindBar`, fed from here. The MAIN conversation and the SUBAGENTS are kept
 * apart as well as added, because on a fan-out session they are most of the
 * bill and "of which subagents" is a question somebody asks.
 */
export interface SpendSplit {
  /** The whole session: the conversation's own requests plus its agents'. */
  all: TokenTotals;
  /** This conversation's own requests. */
  main: TokenTotals;
  /** The subagents' share of `all`, or null when nothing measured them —
   *  never a tally of zeros, which reads as "they spent nothing". */
  agents: TokenTotals | null;
}

/**
 * The session's split, or null when there is nothing to draw.
 *
 * Null rather than an empty bar in both the cases that matter: a host one
 * version behind sends no split at all, and a backend whose log records no
 * usage sends one of zeros. A 100%-wide bar of nothing is a claim.
 */
export function spendSplit(
  split: TokenTotals | null | undefined,
  agentSplit: TokenTotals | null | undefined,
): SpendSplit | null {
  if (!split) return null;
  const agents = agentSplit && tokenTotal(agentSplit) > 0 ? agentSplit : null;
  const all = addTotals(addTotals(zeroTotals(), split), agents ?? {});
  if (tokenTotal(all) <= 0) return null;
  return { all, main: split, agents };
}

/**
 * The headline over the strip — the one fact the section exists for.
 *
 * The bar is legible and the legend carries every number, but a reader must
 * not have to derive the headline by eyeballing a band: the point of the strip
 * is that almost none of the figure above it is fresh input. Stated, not
 * implied.
 *
 * Deliberately does NOT restate the total — `spendSummary` is three lines up
 * and said it once. Null when nothing went in at all, which is the same
 * "absent rather than a verdict about zero" rule `cacheReading` follows.
 */
export function splitSummary(s: SpendSplit): string | null {
  const share = cacheHitPct(s.all);
  if (share == null) return null;
  return `What those tokens were · ${Math.round(share)}% of everything sent in came out of the cache`;
}

/**
 * What the strip is claiming, under the strip — split like `spendNote`.
 *
 * `lead` stays open: where the agents are (IN this bar, the grey band on the
 * spend chart), and a truncated log, which makes every kind a floor. `more` is
 * the method — the same accounting as the all-sessions screen, and that a turn
 * here is a REQUEST — and folds.
 */
export function splitNote(s: SpendSplit, truncated: boolean): { lead: string | null; more: string } {
  const lead: string[] = [];
  if (s.agents) lead.push(`Subagents are IN this bar: ${fmtTokens(tokenTotal(s.agents))} of it.`);
  if (truncated) lead.push("A floor: this log is longer than the host reads in one go, so every kind here starts part-way up.");
  const more = [
    "The same four kinds, counted the same way, as the all-sessions token screen — this conversation is a slice of that total, not a second opinion about it.",
    "Turns here are REQUESTS, not prompts — a turn that ran thirteen tools sent fourteen of them, which is the denominator the all-sessions screen uses too.",
  ];
  return { lead: lead.length ? lead.join(" ") : null, more: more.join(" ") };
}

/**
 * The subagents' spend, stacked on the parent's cumulative curve.
 *
 * The bottom edge IS the parent's line (`USED`, linear between readings, 0
 * before the first and held after the last), and the top adds `agentCum`
 * STEP-held: a running total is a count of requests that happened, and between
 * two of them nothing was spent, so the band rises in vertical steps at the
 * agents' own timestamps rather than in ramps that would invent spend at
 * instants nobody recorded. Its last top point is the parent's end plus the
 * agents' total — the dashed whole-session line.
 *
 * Empty strings where there is nothing to draw (an older host sends no
 * `agentCum`, and the chart is then exactly what it was).
 */
export function agentSpendBand(
  p: Plot,
  samples: ContextSample[],
  cum: [number, number][] | null | undefined,
): { area: string; top: string } {
  if (!cum?.length || !samples.length) return { area: "", top: "" };
  const n = f1;
  const parent = (t: number) => {
    if (t < samples[0].t) return 0;
    const last = samples[samples.length - 1];
    if (t >= last.t) return USED(last);
    let i = 0;
    while (i < samples.length - 1 && samples[i + 1].t <= t) i++;
    const a = samples[i], b = samples[i + 1];
    return b.t === a.t ? USED(b) : USED(a) + ((USED(b) - USED(a)) * (t - a.t)) / (b.t - a.t);
  };
  const times = [...new Set([
    ...samples.map((s) => s.t).filter((t) => t > cum[0][0]),
    ...cum.map(([t]) => t),
  ])].sort((a, b) => a - b);
  const top: string[] = [];
  const bottom: string[] = [];
  let ci = 0;
  let agents = 0;
  for (const t of times) {
    const base = parent(t);
    const x = n(p.px(t));
    const before = agents;
    while (ci < cum.length && cum[ci][0] <= t) agents = cum[ci++][1];
    if (agents !== before) top.push(`${x},${n(p.py(base + before))}`);
    top.push(`${x},${n(p.py(base + agents))}`);
    bottom.unshift(`${x},${n(p.py(base))}`);
  }
  if (top.length < 2) return { area: "", top: "" };
  return { area: bandOutline(top, bottom), top: `M${top.join("L")}` };
}

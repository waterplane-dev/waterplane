/**
 * The cost levers over one scope (cache writes, cold caches, subagents, concentration, model mix,
 * the per-request trend): the thresholds and sentences the all-sessions screen and the Setup check
 * both read. Moved from the token-stats extension's `statsInsights.ts` (which re-exports it).
 * An insight that cannot be measured is ABSENT, never approximated; nothing here applies itself.
 * Dollar figures are the screen's usual COUNTERFACTUAL (list price, not a bill).
 */
import { fmtCount } from "../../tokens.js";
import { fmtUsd } from "../../pricing.js";
import { tokenTotal } from "../../tokens.js";
import type { TokenStatsDoc } from "../../wire/telemetry.js";
import type { CostWindowDoc } from "../../wire/costwindow.js";

export interface Insight {
  id: "writes" | "cold" | "agents" | "concentration" | "trend" | "model";
  /** The finding, one short line with its number. */
  head: string;
  /** Why it matters, one sentence. */
  body: string;
  /** What to try: a sentence, never an action. */
  tryThis?: string;
}

export const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * What every insight reads, whichever document it came from: the all-time ledger or the host's
 * fold of one span. One set of thresholds and words for both.
 */
export interface InsightInput {
  usd: number;
  tok: number;
  writeTok: number;
  writeUsd: number;
  /** What the gaps cost; null = not measured over this scope (the span fold has no cold starts). */
  cold: { usd: number; count: number } | null;
  agentUsd: number;
  agentRuns: number;
  conversations: number;
  /** Conversation costs, dearest first, as many as the document carries. */
  topUsd: number[];
  /** Priced models only. */
  models: { label: string; tok: number; usd: number }[];
  /** Requests counted: the per-request denominator. */
  turns: number;
}

/** The cache-write, cold, fan-out and concentration findings over one scope. */
export function leversOf(x: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { usd, tok } = x;
  if (usd <= 0 || tok <= 0) return out;

  // 1. Cache writes: a sliver of the tokens, a large share of the money.
  const wTok = pct(x.writeTok, tok), wUsd = pct(x.writeUsd, usd);
  if (wUsd >= 15 && wUsd > wTok * 2) {
    out.push({
      id: "writes",
      head: `Cache writes: ${wTok < 1 ? "<1" : wTok}% of tokens, ${wUsd}% of cost`,
      body: `Writing context into the cache costs up to 20× reading it back, so every new session, every compaction and every resume after a long break pays that rate on everything it carries.`,
      tryThis: `Fewer, longer-lived sessions per task, and a smaller always-on baseline (CLAUDE.md, skill descriptions, MCP tools) — it is written once per session.`,
    });
  }

  // 2. What the GAPS cost: expired caches re-written instead of re-read.
  const cold = x.cold?.usd ?? 0;
  if (cold > 0 && pct(cold, usd) >= 2) {
    out.push({
      id: "cold",
      head: `${fmtUsd(cold)} (${pct(cold, usd)}%) spent re-caching after breaks`,
      body: `${fmtCount(x.cold?.count ?? 0)} requests came back to a cache that had expired and re-wrote the whole window instead of re-reading it.`,
      tryThis: `Finish or /compact a big session before stepping away; pick a large one up again the next morning in a fresh session with a short hand-over note.`,
    });
  }

  // 3. The fan-out.
  const aUsd = pct(x.agentUsd, usd);
  if (aUsd >= 15) {
    out.push({
      id: "agents",
      head: `Subagents: ${aUsd}% of cost across ${fmtCount(x.agentRuns)} runs`,
      body: `Every subagent starts its own context from the baseline and pays to cache it, so many short agents cost more than their output suggests.`,
      tryThis: `Brief agents tightly, give each one package of work, and run mechanical lanes on a cheaper model.`,
    });
  }

  // 4. Concentration: a few conversations carry the bill.
  if (x.topUsd.length >= 3 && x.conversations > 20) {
    const n = Math.min(5, x.topUsd.length);
    const share = pct(x.topUsd.slice(0, n).reduce((s, u) => s + u, 0), usd);
    if (share >= 10) {
      out.push({
        id: "concentration",
        head: `${n} of ${fmtCount(x.conversations)} conversations are ${share}% of the cost`,
        body: `The long conversations re-send everything they hold on every turn, so a handful of them dominate — they are listed below.`,
        tryThis: `Ask one of them to explain itself: each row below can start a session that reads its log and names what made it expensive.`,
      });
    }
  }
  return out;
}

/** The model mix: the one model whose share of the money outruns its share of the tokens the most. */
export function modelOf(x: InsightInput): (Insight & { label: string }) | null {
  if (x.usd <= 0 || x.tok <= 0) return null;
  let worst: { label: string; t: number; u: number } | null = null;
  for (const m of x.models) {
    const t = pct(m.tok, x.tok), u = pct(m.usd, x.usd);
    if (u >= 10 && u - t >= 5 && (!worst || u - t > worst.u - worst.t)) worst = { label: m.label, t, u };
  }
  if (!worst) return null;
  return {
    id: "model", label: worst.label,
    head: `${worst.label}: ${worst.t}% of tokens, ${worst.u}% of cost`,
    body: `Per token it is the dearest model you run a lot of.`,
    tryThis: `Route reading, searching and mechanical edits to a cheaper model and keep it for planning and review.`,
  };
}

/** Per-request cost of `a` against `b`, or null where either is too thin or the move too small. */
export function perRequestMove(a: { usd: number; turns: number }, b: { usd: number; turns: number }): { perA: number; perB: number; ch: number } | null {
  if (a.turns < 20 || b.turns < 20 || a.usd <= 0 || b.usd <= 0) return null;
  const perA = a.usd / a.turns, perB = b.usd / b.turns;
  const ch = Math.round(((perA - perB) / perB) * 100);
  return Math.abs(ch) >= 10 ? { perA, perB, ch } : null;
}

/** The all-time ledger as insight input. */
export function docInput(doc: TokenStatsDoc): InsightInput {
  return {
    usd: doc.cost.total, tok: tokenTotal(doc.totals),
    writeTok: doc.totals.cacheWrite, writeUsd: doc.cost.cacheWrite,
    // Unmeasured (no cold starts block, or nothing could be priced) stays null: the rule then says "not checked", never a pass on a zero.
    cold: doc.coldStarts && doc.coldStarts.premiumUsd != null ? { usd: doc.coldStarts.premiumUsd, count: doc.coldStarts.count } : null,
    agentUsd: doc.subagentCost.total, agentRuns: doc.subagentLogs,
    conversations: doc.conversations,
    topUsd: (doc.top ?? []).map((c) => c.cost.total),
    models: doc.models.filter((m) => m.priced !== false).map((m) => ({ label: m.label, tok: tokenTotal(m), usd: m.cost.total })),
    turns: doc.totals.turns,
  };
}

/** A span's fold as insight input. `unpriced` names model ids with no list price (the all-time
 *  ledger's `priced: false` rows) — a span's model slice carries no such flag. */
export function windowInput(w: CostWindowDoc, unpriced: ReadonlySet<string> = new Set()): InsightInput {
  const byModel = new Map<string, { tok: number; usd: number }>();
  for (const h of w.hours) {
    for (const m of h.byModel) {
      const e = byModel.get(m.model) ?? { tok: 0, usd: 0 };
      e.tok += tokenTotal(m.totals); e.usd += m.cost.total;
      byModel.set(m.model, e);
    }
  }
  const rest = w.rest ?? [];
  return {
    usd: w.cost.total, tok: tokenTotal(w.totals),
    writeTok: w.totals.cacheWrite, writeUsd: w.cost.cacheWrite,
    cold: null,
    agentUsd: w.agentCost.total,
    agentRuns: w.convos.reduce((s, c) => s + c.agents, 0) + rest.reduce((s, r) => s + r.agents, 0),
    conversations: w.convosTotal ?? w.convos.length,
    topUsd: w.convos.map((c) => c.cost.total).sort((a, b) => b - a),
    models: [...byModel].filter(([k]) => !unpriced.has(k)).map(([label, v]) => ({ label, ...v })),
    turns: w.totals.turns,
  };
}

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
import { fmtCount, fmtUsd, tokenTotal, undatedSince, undatedWhy, type CostWindowDoc, type TokenDay, type TokenStatsDoc } from "@waterplane/shared";

export interface Insight {
  id: "writes" | "cold" | "agents" | "concentration" | "trend" | "model";
  /** The finding, one short line with its number. */
  head: string;
  /** Why it matters, one sentence. */
  body: string;
  /** What to try — a sentence, never an action. */
  tryThis?: string;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

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

/**
 * What every insight reads, whichever document it came from: the all-time ledger
 * (`TokenStatsDoc`) or the host's fold of one span (`CostWindowDoc`). One set of
 * thresholds and words for both, so a span never reads a lever the whole record
 * would word differently.
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
  /** Conversation costs, dearest first — as many as the document carries. */
  topUsd: number[];
  /** Priced models only. */
  models: { label: string; tok: number; usd: number }[];
  /** Requests counted — the per-request denominator. */
  turns: number;
}

/** The all-time ledger as insight input. */
export function docInput(doc: TokenStatsDoc): InsightInput {
  return {
    usd: doc.cost.total, tok: tokenTotal(doc.totals),
    writeTok: doc.totals.cacheWrite, writeUsd: doc.cost.cacheWrite,
    cold: doc.coldStarts ? { usd: doc.coldStarts.premiumUsd ?? 0, count: doc.coldStarts.count } : { usd: 0, count: 0 },
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

/** The cache-write, cold, fan-out, concentration and model findings over one scope. */
function leversOf(x: InsightInput): Insight[] {
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

/** 6. The model mix: the one model whose share of the money outruns its share of the tokens the most. */
function modelOf(x: InsightInput): (Insight & { label: string }) | null {
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
function perRequestMove(a: { usd: number; turns: number }, b: { usd: number; turns: number }) {
  if (a.turns < 20 || b.turns < 20 || a.usd <= 0 || b.usd <= 0) return null;
  const perA = a.usd / a.turns, perB = b.usd / b.turns;
  const ch = Math.round(((perA - perB) / perB) * 100);
  return Math.abs(ch) >= 10 ? { perA, perB, ch } : null;
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

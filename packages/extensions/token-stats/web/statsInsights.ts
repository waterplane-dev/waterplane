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
import { fmtCount, fmtUsd, tokenTotal, undatedSince, undatedWhy, type TokenDay, type TokenStatsDoc } from "@waterplane/shared";

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
 * The insights, in reading order: the biggest structural lever first (what the
 * cache writes cost), then what the clock cost, the fan-out, how concentrated
 * the spend is, the trend, the model mix. Each is present only when its figure
 * is both measurable and large enough to be worth a line.
 */
export function statsInsights(doc: TokenStatsDoc, now: number): Insight[] {
  const out: Insight[] = [];
  const usd = doc.cost.total;
  const tok = tokenTotal(doc.totals);
  if (usd <= 0 || tok <= 0) return out;

  // 1. Cache writes: a sliver of the tokens, a large share of the money.
  const wTok = pct(doc.totals.cacheWrite, tok), wUsd = pct(doc.cost.cacheWrite, usd);
  if (wUsd >= 15 && wUsd > wTok * 2) {
    out.push({
      id: "writes",
      head: `Cache writes: ${wTok < 1 ? "<1" : wTok}% of tokens, ${wUsd}% of cost`,
      body: `Writing context into the cache costs up to 20× reading it back, so every new session, every compaction and every resume after a long break pays that rate on everything it carries.`,
      tryThis: `Fewer, longer-lived sessions per task, and a smaller always-on baseline (CLAUDE.md, skill descriptions, MCP tools) — it is written once per session.`,
    });
  }

  // 2. What the GAPS cost: expired caches re-written instead of re-read.
  const cold = doc.coldStarts?.premiumUsd ?? 0;
  if (cold > 0 && pct(cold, usd) >= 2) {
    out.push({
      id: "cold",
      head: `${fmtUsd(cold)} (${pct(cold, usd)}%) spent re-caching after breaks`,
      body: `${fmtCount(doc.coldStarts?.count ?? 0)} requests came back to a cache that had expired and re-wrote the whole window instead of re-reading it.`,
      tryThis: `Finish or /compact a big session before stepping away; pick a large one up again the next morning in a fresh session with a short hand-over note.`,
    });
  }

  // 3. The fan-out.
  const aUsd = pct(doc.subagentCost.total, usd);
  if (aUsd >= 15) {
    out.push({
      id: "agents",
      head: `Subagents: ${aUsd}% of cost across ${fmtCount(doc.subagentLogs)} runs`,
      body: `Every subagent starts its own context from the baseline and pays to cache it, so many short agents cost more than their output suggests.`,
      tryThis: `Brief agents tightly, give each one package of work, and run mechanical lanes on a cheaper model.`,
    });
  }

  // 4. Concentration: a few conversations carry the bill.
  const top = doc.top ?? [];
  if (top.length >= 3 && doc.conversations > 20) {
    const n = Math.min(5, top.length);
    const share = pct(top.slice(0, n).reduce((s, c) => s + c.cost.total, 0), usd);
    if (share >= 10) {
      out.push({
        id: "concentration",
        head: `${n} of ${fmtCount(doc.conversations)} conversations are ${share}% of the cost`,
        body: `The long conversations re-send everything they hold on every turn, so a handful of them dominate — they are listed below.`,
        tryThis: `Ask one of them to explain itself: each row below can start a session that reads its log and names what made it expensive.`,
      });
    }
  }

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
  if (a.turns >= 20 && b.turns >= 20 && a.usd > 0 && b.usd > 0) {
    const perA = a.usd / a.turns, perB = b.usd / b.turns;
    const ch = Math.round(((perA - perB) / perB) * 100);
    if (Math.abs(ch) >= 10) {
      out.push({
        id: "trend",
        head: `A request costs ${Math.abs(ch)}% ${ch > 0 ? "more" : "less"} than the week before`,
        body: `${fmtUsd(perA)} per request over the last 7 days against ${fmtUsd(perB)} the 7 before (${fmtUsd(a.usd)} vs ${fmtUsd(b.usd)} in all).`,
        tryThis: ch > 0
          ? `Longer conversations or a dearer model are the usual cause — the costliest conversations below say which.`
          : undefined,
      });
    }
  }

  // 6. The model mix: the one model whose share of the money outruns its
  //    share of the tokens the most.
  let worst: { label: string; t: number; u: number } | null = null;
  for (const m of doc.models) {
    if (m.priced === false) continue;
    const t = pct(tokenTotal(m), tok), u = pct(m.cost.total, usd);
    if (u >= 10 && u - t >= 5 && (!worst || u - t > worst.u - worst.t)) worst = { label: m.label, t, u };
  }
  if (worst) {
    out.push({
      id: "model",
      head: `${worst.label}: ${worst.t}% of tokens, ${worst.u}% of cost`,
      body: `Per token it is the dearest model you run a lot of.`,
      tryThis: `Route reading, searching and mechanical edits to a cheaper model and keep it for planning and review.`,
    });
  }
  return out;
}

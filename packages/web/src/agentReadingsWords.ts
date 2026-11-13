/**
 * Every sentence the Agent readings region says (`AgentReadingsRegion.tsx`).
 * Pure and node-tested (`agentReadingsWords.test.mjs`): it rounds and words,
 * it judges nothing — no verdict word, no colour, no rank. An absent reading
 * is the HOST's sentence, quoted, never a zero. A total is never worded
 * without its split (`reworkLine` names all three classes; the region draws
 * the kind split under it).
 */
import { START_PARTS, fmtCount, fmtShare, fmtUsd, isAgentAbsent, tokenTotal, zeroTotals, addTotals } from "@waterplane/shared";
import type {
  AgentStartReading, SeriesMedian, SeriesValue, AgentActivityReading, AgentSpendReading, AgentCompactReading, AgentEscapedReading, AgentExploreReading, AgentReadingAbsent, AgentReadingsWeek, AgentReworkReading,
  TokenTotals,
} from "@waterplane/shared";

export const AGENT_REGION_WORDS =
  "From this desktop's own conversation logs: what the agents spent working in this repo, week by week. These are readings, not a score — nothing here is judged, coloured or counted in the badge, and a week with nothing to read says why. Only this desktop's sessions are in them.";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A week chip's label: the Monday it starts, month and day. */
export function weekChip(week: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(week);
  return m ? `${Number(m[1])}/${Number(m[2])}` : week;
}

export function weekHeading(week: string, current: boolean): string {
  return current ? `Week of ${weekChip(week)} (this week, so far)` : `Week of ${weekChip(week)}`;
}

/** The always-on list's card: measured off the working tree now, not weekly. */
export const CARRIED_TITLE = "What every turn carries (now)";

/** Said once above the charts: the bars ARE the week picker. */
export const PICK_HINT = "Tap a bar to read that week; every chart follows.";

/** A chart's text answer for the picked week: its date, then the figure or the host's sentence. */
export function readout(week: string, current: boolean, figure: string | null, absentWhy?: string): string {
  const when = `${weekChip(week)}${current ? " (so far)" : ""}`;
  return figure !== null ? `${when}: ${figure}` : `${when}: ${absentWhy ?? "not taken"}`;
}

export function spendLine(r: AgentSpendReading): string {
  const per = r.pricedRequests ? `${fmtUsd(r.usd / r.pricedRequests)} per priced request` : "no request on a priced model";
  return `${fmtUsd(r.usd)} at list price over ${plural(r.requests, "request")} — ${per}.`;
}

export function spendBeside(r: AgentSpendReading): string {
  const unpriced = r.requests - r.pricedRequests;
  const ctx = r.ctxTok !== undefined && r.requests ? `${fmtCount(r.ctxTok / r.requests)} tokens of context sent per request` : "context per request is not on this ledger's rows";
  return unpriced ? `${ctx}; ${plural(unpriced, "request")} on a model with no list price, in the count and not the dollars.` : `${ctx}.`;
}

export function activityLine(r: AgentActivityReading): string {
  const whole = r.mainTok + r.agentTok;
  return `${plural(r.sessions, "conversation")} spent tokens (${r.started} started this week) with ${plural(r.agents, "subagent")} under them — subagents ${fmtShare(whole ? r.agentTok / whole : 0)} of ${fmtCount(whole)} tokens.`;
}

/** Each chart's headline figure, for its readout and the weeks table. */
export const figures = {
  spend: (r: AgentSpendReading) => spendLine(r),
  activity: (r: AgentActivityReading) => `${activityLine(r)} Own ${fmtCount(r.mainTok)} · subagents ${fmtCount(r.agentTok)}.`,
};

/** Said instead of a chart whose every week counted nothing: an axis over twelve empty slots reads as broken. */
export function noneIn(weeks: number): string {
  return `Nothing counted in any of these ${weeks} weeks.`;
}

/** A median of counts: whole where it is whole, one place where two sessions averaged. */
export function fmtMedian(x: number): string {
  return Number.isInteger(x) ? fmtCount(x) : x.toFixed(1);
}

/** A series median's value, or null where the host sent the sentence why (or nothing at all). */
export function medianOf(v: SeriesValue | undefined): SeriesMedian | null {
  return v && !isAgentAbsent(v) ? v : null;
}

/** The start chart's figure: tokens, said to be measured, with the count behind the median. */
export function startLine(tok: SeriesMedian): string {
  return `${fmtCount(tok.median)} tokens in the first request, measured — the median of ${plural(tok.n, "fresh interactive session")}.`;
}

/** Said once over the parts list: what the numbers are, and what they are not. */
export const START_PARTS_CAP =
  "Characters per part, the median over the sessions that recorded it — measured off the logs. Part medians do not add up to the token figure, and they are not the skills screen's estimated weights.";

/** One line per part the host listed, in `START_PARTS` order, labelled as the carried list names them. */
export function startPartLines(r: AgentStartReading): string[] {
  const label = new Map(START_PARTS.map((p) => [p.id as string, p.label]));
  return r.parts.map((p) => {
    const name = label.get(p.id) ?? "a part this app version cannot name";
    const m = medianOf(p.chars);
    return m ? `${name}: ${fmtCount(m.median)} chars (${plural(m.n, "session")})` : `${name}: ${isAgentAbsent(p.chars) ? p.chars.absent : "not taken"}`;
  });
}

/** The subagents' own start, never folded into the session median. */
export function startSubLine(r: AgentStartReading): string {
  const m = medianOf(r.sub);
  return m ? `Subagents: ${fmtCount(m.median)} tokens in the first request, measured — the median of ${plural(m.n, "subagent log")}.`
    : `Subagents: ${isAgentAbsent(r.sub) ? r.sub.absent : "not taken"}`;
}

export function exploreLine(r: AgentExploreReading): string {
  return `${fmtCount(r.medianTok)} tokens sent before the first edit — the median of ${plural(r.sessions, "fresh session")} that edited.`;
}

/** The look median, over the same sessions as the token median above it. */
export function looksLine(m: SeriesMedian): string {
  return `${fmtMedian(m.median)} look calls before the first edit — the median of the same ${plural(m.n, "session")}.`;
}

export function requestsLine(m: SeriesMedian): string {
  return `${fmtMedian(m.median)} requests — the median of ${plural(m.n, "fresh session")} that committed, each in the week it started.`;
}

export function exploreBeside(r: AgentExploreReading): string {
  return `${plural(r.noEdit, "fresh session")} never edited a file; ${r.skipped} left out (forked, continued or headless).`;
}

/** The three classes' tokens, summed, for the kind split under the share line. */
export function reworkWhole(r: AgentReworkReading): TokenTotals {
  const t = zeroTotals();
  for (const c of ["rework", "feature", "unknown"] as const) addTotals(t, r.byClass[c]);
  return t;
}

export function reworkLine(r: AgentReworkReading): string {
  const share = (c: "rework" | "feature" | "unknown") => fmtShare(r.totalTok ? tokenTotal(r.byClass[c]) / r.totalTok : 0);
  return `Rework ${share("rework")} · feature ${share("feature")} · unknown ${share("unknown")} of ${fmtCount(r.totalTok)} tokens.`;
}

export function reworkBeside(r: AgentReworkReading): string {
  const s = r.sessions;
  const runs = r.repairRuns ? `; ${plural(r.repairRuns, "review-repair run")} among them` : "";
  return `Conversations: ${s.rework} rework, ${s.feature} feature, ${s.unknown} unknown${runs}.`;
}

/** Compactions per committed session, to two places — the ratio of two counts, both printed beside it. */
export function compactLine(r: AgentCompactReading): string {
  const per = r.compactions / r.committed;
  return `${per.toFixed(2)} compactions per committed session — ${plural(r.compactions, "compaction")} over ${plural(r.committed, "session")} that committed.`;
}

export function compactBeside(r: AgentCompactReading): string {
  return `Every session that week: ${plural(r.compactionsAll, "compaction")} over ${plural(r.sessionsAll, "session")}.`;
}

const countOr = (x: number | AgentReadingAbsent, one: string): string => (isAgentAbsent(x) ? x.absent : plural(x, one));

export function escapedLines(r: AgentEscapedReading): { crash: string; bugs: string } {
  return {
    crash: `Crash marks: ${countOr(r.crashMarks, "crash group")}${isAgentAbsent(r.crashMarks) ? "" : " marked."}`,
    bugs: `Bugs on the backlog: ${countOr(r.bugItems, "item")}${isAgentAbsent(r.bugItems) ? "" : " added."}`,
  };
}

/** The escaped chart's readout figure: both counts, a dash where one was not taken (its sentence is below the chart). */
export function escapedFigure(r: AgentEscapedReading): string {
  const n = (x: number | AgentReadingAbsent) => (isAgentAbsent(x) ? "–" : String(x));
  return `${n(r.crashMarks)} crash marks · ${n(r.bugItems)} bugs`;
}

/** One cell of the weeks table: the reading's headline figure, or "–" where it was not taken. */
export function weekCells(w: AgentReadingsWeek): {
  spend: string; sessions: string; start: string; explore: string; looks: string; requests: string; rework: string; compact: string; crash: string; bugs: string;
} {
  const n = (x: number | AgentReadingAbsent) => (isAgentAbsent(x) ? "–" : String(x));
  const med = (v: SeriesValue | undefined, f: (x: number) => string) => { const m = medianOf(v); return m ? f(m.median) : "–"; };
  return {
    start: !w.start || isAgentAbsent(w.start) ? "–" : med(w.start.tok, fmtCount),
    looks: isAgentAbsent(w.explore) ? "–" : med(w.explore.looks, fmtMedian),
    requests: med(w.requests, fmtMedian),
    spend: !w.spend || isAgentAbsent(w.spend) ? "–" : fmtUsd(w.spend.usd),
    sessions: !w.activity || isAgentAbsent(w.activity) ? "–" : String(w.activity.sessions),
    explore: isAgentAbsent(w.explore) ? "–" : fmtCount(w.explore.medianTok),
    rework: isAgentAbsent(w.rework) ? "–" : fmtShare(tokenTotal(w.rework.byClass.rework) / w.rework.totalTok),
    compact: isAgentAbsent(w.compact) ? "–" : (w.compact.compactions / w.compact.committed).toFixed(2),
    crash: n(w.escaped.crashMarks),
    bugs: n(w.escaped.bugItems),
  };
}

export const TABLE_NOTE = "– means the reading was not taken that week; pick the week above to read why.";


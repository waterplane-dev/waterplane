/**
 * Every sentence the Agent readings region says (`AgentReadingsRegion.tsx`).
 * Pure and node-tested (`agentReadingsWords.test.mjs`): it rounds and words,
 * it judges nothing — no verdict word, no colour, no rank. An absent reading
 * is the HOST's sentence, quoted, never a zero. A total is never worded
 * without its split (`reworkLine` names all three classes; the region draws
 * the kind split under it).
 */
import { fmtCount, fmtShare, isAgentAbsent, tokenTotal, zeroTotals, addTotals } from "@waterplane/shared";
import type {
  AgentCompactReading, AgentEscapedReading, AgentExploreReading, AgentReadingAbsent, AgentReadingsWeek, AgentReworkReading,
  TokenTotals,
} from "@waterplane/shared";

export const AGENT_REGION_WORDS =
  "From this desktop's own conversation logs: what the agents spent working in this repo, week by week. These are readings, not a score — nothing here is judged, coloured or counted in the badge, and a week with nothing to read says why. Only this desktop's sessions are in them.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A week chip's label: the Monday it starts, month and day. */
export function weekChip(week: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(week);
  return m ? `${Number(m[1])}/${Number(m[2])}` : week;
}

export function weekHeading(week: string, current: boolean): string {
  return current ? `Week of ${week} (this week, so far)` : `Week of ${week}`;
}

export function exploreLine(r: AgentExploreReading): string {
  return `${fmtCount(r.medianTok)} tokens read before the first edit — the median of ${plural(r.sessions, "fresh session")}, ${plural(r.medianRequests, "request")} in.`;
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

/** One cell of the weeks table: the reading's headline figure, or "–" where it was not taken. */
export function weekCells(w: AgentReadingsWeek): { explore: string; rework: string; compact: string; crash: string; bugs: string } {
  const n = (x: number | AgentReadingAbsent) => (isAgentAbsent(x) ? "–" : String(x));
  return {
    explore: isAgentAbsent(w.explore) ? "–" : fmtCount(w.explore.medianTok),
    rework: isAgentAbsent(w.rework) ? "–" : fmtShare(tokenTotal(w.rework.byClass.rework) / w.rework.totalTok),
    compact: isAgentAbsent(w.compact) ? "–" : (w.compact.compactions / w.compact.committed).toFixed(2),
    crash: n(w.escaped.crashMarks),
    bugs: n(w.escaped.bugItems),
  };
}

export const TABLE_NOTE = "– means the reading was not taken that week; pick the week above to read why.";


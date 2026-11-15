/**
 * Every sentence the Agent readings region says (`AgentReadingsRegion.tsx`).
 * Pure and node-tested (`agentReadingsWords.test.mjs`): it rounds and words,
 * it judges nothing — no verdict word, no colour, no rank. An absent reading
 * is the HOST's sentence, quoted, never a zero. A total is never worded
 * without its split (`reworkLine` names all three classes; the region draws
 * the kind split under it).
 */
import { START_PARTS, fmtCount, fmtShare, fmtUsd, isAgentAbsent, partsByGroup, tokenTotal, zeroTotals, addTotals } from "@waterplane/shared";
import { byModelCliText, normalizeModel } from "@waterplane/shared";
import { SHARE_MIN_N } from "@waterplane/shared";
import { PROBE_KIND_SHORT } from "./probeWords.ts";
import type { ByModelAbsent, ByModelResult, SeriesReading, SetupCost, SetupShareBlock, ShareRepoHalf } from "@waterplane/shared";
import type {
  AgentStartReading, SeriesLoads, SeriesMedian, SeriesValue, AgentActivityReading, AgentSpendReading, AgentCompactReading, AgentEscapedReading, AgentExploreReading, AgentReadingAbsent, AgentReadingsWeek, AgentReworkReading,
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

/** The region's three views, as their chips say them (`AgentView` in `AgentReadingsRegion.tsx`). */
export const AGENT_VIEW_LABEL = { now: "now", weeks: "week by week", tests: "test & compare" } as const;

/** One line under the view chips: what the open view answers, for a first-time reader. */
export const AGENT_VIEW_HELP: Record<keyof typeof AGENT_VIEW_LABEL, string> = {
  now: "What a session in this repo costs before any work, and what it loads on every turn.",
  weeks: "What the agents spent working here, one week at a time.",
  tests: "Measure a setup change or a model on fixed questions, and compare your setup with a colleague's.",
};

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

/** One part's line: its label (or the sentence that this app version cannot name it) and its median. */
function partLine(p: AgentStartReading["parts"][number], label: Map<string, string>): string {
  const name = label.get(p.id) ?? `a part this app version cannot name (${p.id})`;
  const m = medianOf(p.chars);
  return m ? `${name}: ${fmtCount(m.median)} chars (${plural(m.n, "session")})` : `${name}: ${isAgentAbsent(p.chars) ? p.chars.absent : "not taken"}`;
}

/**
 * The parts grouped by whose they are (shared `START_GROUPS`: the repo's, yours, the CLI's, not
 * split), in that order, each group with its heading, its sentence and its parts' lines in
 * `START_PARTS` order. A group with no measured part is left out; a part the log does not split by
 * source is under "not split", never assigned to one side.
 */
export function startPartGroups(r: AgentStartReading): { id: string; heading: string; note: string; lines: string[] }[] {
  const label = new Map(START_PARTS.map((p) => [p.id, p.label]));
  return partsByGroup(r.parts).map(({ group, parts }) => ({
    id: group.id, heading: group.label, note: group.note, lines: parts.map((p) => partLine(p, label)),
  }));
}

/** Every part line, flat, in group order (the groups' own order, then `START_PARTS` within one). */
export function startPartLines(r: AgentStartReading): string[] {
  return startPartGroups(r).flatMap((g) => g.lines);
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

/** A mean of counts: two places below 1 (0.04 is not 0.0), one below 10, whole above. */
export function fmtMean(x: number): string {
  return x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : fmtCount(Math.round(x));
}

/** Skill loads: the mean per session AND the share that loaded one, over the same sessions (never a median: most load none). */
export function skillsLine(m: SeriesLoads): string {
  return `${fmtMean(m.mean)} skill loads per session on average; ${fmtShare(m.share)} of ${plural(m.n, "fresh session")} loaded at least one, each in the week it started.`;
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


// ── The headline (R-metrics-070): setup cost per median session, the last probe, the pattern ──

export const HEADLINE_TITLE = "Setup cost per session";

/** The headline's figure, alone on its large line: dollars at list price, or tokens where no rate covers enough sessions. */
export function setupCostFigure(c: SetupCost): string {
  return c.usd !== undefined ? fmtUsd(c.usd) : `${fmtCount(c.tok)} tokens`;
}

/** The line under the figure: what it is per, with the tokens beside the dollars (or why there are no dollars). */
export function setupCostLine(c: SetupCost): string {
  // The dollars are a median over the priced sessions only; the tokens over all of them. Never one
  // wording for two populations: when they differ, say both counts.
  if (c.usd !== undefined && c.nPriced < c.n) {
    return `per median priced session at list price (${c.nPriced} of ${c.n} sessions had a list price) · ${fmtCount(c.tok)} tokens per median session over all ${c.n}`;
  }
  return c.usd !== undefined
    ? `per median session at list price · ${fmtCount(c.tok)} tokens`
    : `per median session; no dollar figure: ${plural(c.n - c.nPriced, "session")} of ${c.n} ran a model with no list price.`;
}

/** The short visible caption: how many sessions, which days, which rates, which way it errs. */
export function setupCostBeside(c: SetupCost, days: number, prices: string): string {
  return `${plural(c.n, "fresh interactive session")}, last ${days} days · ${prices} · errs low.`;
}

/** Its split by whose it is — never a total without it. The method is in the `?`. */
export function setupSplitLine(c: SetupCost): string {
  if (!c.split.length) return "Whose it is: not measured — no session in these days recorded its parts.";
  const basis = c.nSplit < c.n ? ` (of the ${c.nSplit} of ${c.n} sessions that recorded parts, pooled over characters)` : "";
  return `Whose it is${basis}: ${c.split.map((g) => `${g.label} ${fmtShare(g.share)}`).join(" · ")}.`;
}

/** The headline's probe slot when no probe has run here (`probeLastLine` once one has). */
export const PROBE_NONE = "Last search test: none run yet.";

/** The `?` behind the headline: what it is and how it is made (the figures behind it when measured); the source is the caption under it, not repeated here. */
export function headlineHelp(c: SetupCost | null): string {
  const made = c
    ? ` Here: median start ${fmtCount(c.startTok)} tokens, median ${fmtMedian(c.requests)} requests${c.models.length ? `, on ${c.models.join(", ")}` : ""}; the split is over ${plural(c.nSplit, "session")} that recorded their parts.`
    : "";
  return `What the setup (instruction files, tool schemas, skill and subagent listings: everything the first request carries before anyone types) costs a typical session here. Every request carries it again from the cache, so per session it is start × requests at the model's cache-read rate, the median of that over the sessions; a list-price figure, also on a subscription. The first request's cache write and any rebuild after a pause are left out, so it errs low. The split is each group's share of the measured part characters (characters are not tokens, so no dollar figure per group).${made} The pattern line reads the newest change on this repo against the band day-to-day variation alone draws, one model at a time; it says what moved and how far, and leaves the reading of it to you. No score: the start context, the work after it and a search test pull in different directions.`;
}


// ── Compare by model (R-metrics-072): one compact row, only when two models have enough sessions ──

// closed: SeriesReading is the shared reading id, a parameter here, never read off the wire
const BY_MODEL_WORDS: Record<SeriesReading, string> = {
  start: "start context", look: "looks before the first edit", req: "requests per committing session", skills: "skill loads", subStart: "subagent start",
};

/**
 * The region's by-model row: the readings compared for the first pair that has enough sessions,
 * each with its ratio and whether it is inside the band; null when no reading has two models
 * with enough sessions (the usual state — the token-stats card says that in full).
 */
export function byModelRow(all: readonly { reading: SeriesReading; r: ByModelResult | ByModelAbsent }[], days: number): { line: string; notes: string[] } | null {
  const shown = all.map((x) => x.r).filter((r): r is ByModelResult => !("absent" in r));
  const first = shown[0];
  if (!first) return null;
  const name = (id: string): string => normalizeModel(id) ?? id;
  const same = (r: ByModelResult): boolean => r.a.model === first.a.model && r.b.model === first.b.model;
  const parts = all.map(({ reading, r }) => ("absent" in r || !same(r)
    ? `${BY_MODEL_WORDS[reading]} not compared`
    : `${BY_MODEL_WORDS[reading]} ×${(Math.round(r.ratio * 100) / 100).toString()}, ${r.inside ? "within" : "outside"} normal variation`));
  return {
    line: `By model, last ${days} days, ${name(first.b.model)} against ${name(first.a.model)}: ${parts.join(" · ")}.`,
    notes: first.cliTogether ? [byModelCliText(first)] : [],
  };
}

// ── Compare setups (R-metrics-073): the export block, its preview and the side by side ──

export const SHARE_TITLE = "Compare setups";

/** What leaves, said above the preview, before anything leaves. */
export const SHARE_LEAVES =
  `Only the text below leaves, and only when you copy or save it: medians over at least ${SHARE_MIN_N} sessions of what each first request carried, by part and grouped by whose it is, the median start tokens, the newest search test's summary when one ran (its day and kind, the model it ran on, how many questions and a fingerprint of which ones, the share found right, tokens a question), the model and CLI version, the days it covers, the repo's name and a hash of its remote, and the name you chose. No session counts, no cost figure, file, skill or plugin names, prompts, paths, or times finer than a day.`;

/** The `?` behind the card. */
export const SHARE_HELP =
  `Two people on one repo can put their setups side by side: each exports a block from this card and sends it where the team talks, the other imports it here. A block is a copy you hand over, not a sync: it never goes into git, and an imported one stays on this phone until you remove it. Only start-context sizes travel (what a session carries before anyone types), never how anyone works: looks, requests, skill loads and the setup cost (which with the start tokens would say how many requests a session made) stay on their own desktop, because two people's work mixes differ too much to compare. A part a block's version does not name is folded into "parts this version does not name", so a plugin or connector name never leaves.`;

/** Under every side by side: what a difference is, and what it is not. */
export const SHARE_CAPTION =
  "Differences here are setup, not skill: what each desktop carries into a session before anyone types. A smaller figure is a smaller price, not a sign of more effective work.";

export const SHARE_NAME_ASK = "The name the others will see beside your figures (kept on this phone):";
export const SHARE_NO_POINTS = "Nothing to export yet: this repo's sessions are still being read.";
export const SHARE_IMPORT_ASK = "Paste a block someone exported, or pick its file.";
export const SHARE_KEPT = "Imported blocks are kept on this phone only; remove takes one away.";
export const SHARE_COPIED = "Copied the setup block.";
export const SHARE_COPY_REFUSED = "This browser did not let the block be copied. Select the text above and copy it by hand, or save it to the outbox.";

/** The toast after the outbox write: the full path, as the transport rule asks. */
export function shareSavedText(relPath: string): string {
  return `Saved to ${relPath} on the desktop. It is not committed.`;
}

export function shareImportedText(from: string, dropped: readonly string[]): string {
  return dropped.length
    ? `Imported ${from}'s setup; ${plural(dropped.length, "field")} this phone does not read ${dropped.length === 1 ? "was" : "were"} left out.`
    : `Imported ${from}'s setup.`;
}

/** The repo half's caption: identical (the Project-typed files, normally committed), or flagged when it is NOT. One predicate (`setupShareCompare().repoHalf`). */
export function shareRepoHalfText(half: ShareRepoHalf, theirs: SetupShareBlock): string {
  switch (half) {
    case "identical": return "The repo's half is identical: the files the log types Project, normally committed, read the same for both of you.";
    case "differs": return `The repo's half differs, which committed files would not: the two date ranges ran different commits of the repo's instruction files (${theirs.days.from} to ${theirs.days.to} on ${theirs.from}'s side).`;
    case "otherRepo": return `This block may be from another repo (${theirs.repo?.name ?? "unnamed"}): the two remotes are written differently (a fork, an ssh alias and a rewritten URL all hash differently), so the repo's half may be different files.`;
    case "unknownRepo": return "One of the two blocks names no shared remote, so whether this is the same repo cannot be checked.";
    default: return "Whether the repo's half is the same on both sides cannot be said by this version.";
  }
}

const chars = (x: number | undefined): string => (x === undefined ? "–" : `${fmtCount(x)} chars`);

/** One side-by-side line: yours first, theirs beside, no difference and no order between them. */
export function shareRowLine(label: string, mine: number | undefined, theirs: number | undefined, theirName: string): string {
  return `${label}: you ${chars(mine)} · ${theirName} ${chars(theirs)}`;
}

/** What each block ran: model, CLI, backend, days. */
export function shareRanLine(b: SetupShareBlock, who: string): string {
  const m = b.models.length ? b.models.map((x) => normalizeModel(x) ?? x).join(", ") : "model not recorded";
  return `${who}: ${b.backend}, ${m}, CLI ${b.cli.length ? b.cli.join(", ") : "not recorded"}, ${b.days.from} to ${b.days.to}`;
}

/** Each side's median start tokens (no cost figure travels: with the start it would be a behaviour reading). */
export function shareStartLine(b: SetupShareBlock, who: string): string {
  return `${who}: start ${fmtCount(b.startTok)} tokens, the median first request`;
}

/**
 * Each side's probe summary, when its block carries one: the lookup questions, not anyone's work. It names the model the probe
 * ran on and how many questions, because a probe's model is typed at the card and each desktop draws its own questions.
 */
export function shareProbeLine(b: SetupShareBlock, who: string): string {
  if (!b.probe) return `${who}: no search test in the block`;
  const p = b.probe;
  const on = p.model ? ` on ${p.model}` : "";
  const asked = p.questions ? `, ${plural(p.questions, "question")}` : "";
  return `${who}: search test on ${p.day} (${Object.prototype.hasOwnProperty.call(PROBE_KIND_SHORT, p.kind) ? PROBE_KIND_SHORT[p.kind] : p.kind})${on}${asked}, ${fmtShare(p.correct)} right, ${fmtCount(p.tokPerQuestion)} tokens a question, ${plural(p.repeats, "repeat")}`;
}

/**
 * One line under the two probe lines when they cannot be read as one setup difference: another model, other questions, or a
 * block from a version that did not say. Empty when both name the same model and the same draw. Never ranks.
 */
export function shareProbeNote(mine: SetupShareBlock | null, theirs: SetupShareBlock): string {
  const a = mine?.probe, b = theirs.probe;
  if (!a || !b) return "";
  const why: string[] = [];
  if (!a.model || !b.model) why.push("a block from an older version does not name the model its search test ran on");
  else if (a.model !== b.model) why.push(`the search tests ran on different models (${a.model} and ${b.model})`);
  if (!a.draw || !b.draw) why.push("a block from an older version does not say which questions its search test asked");
  else if (a.draw !== b.draw) why.push("each desktop draws its own questions from the pool, and these are not the same ones");
  return why.length ? `These two search test lines are not one setup difference: ${why.join("; ")}.` : "";
}

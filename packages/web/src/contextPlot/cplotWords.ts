/**
 * What the chart says in words: event labels, the axis note and the series summary.
 *
 * Moved out of `contextPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `contextPlot/`.
 */

import {
  contextPct,
  type AgentRun,
  type ContextEvent,
  type ContextSample,
  type ContextWindowSource,
} from "@waterplane/shared";
import { fmtTokens, fmtAxisTime } from "../kit/chart/chartFmt.ts";
import { agentPeak } from "./cplotAgents.ts";
import { fmtGap } from "./cplotAxis.ts";

// ── what the chart says in words ──────────────────────────────────────────

export interface EventLabel {
  /** One line, for a legend row or a table cell. */
  text: string;
  /** What it is, for the icon and the colour. */
  kind: ContextEvent["kind"];
}

/**
 * One event as a sentence.
 *
 * Written here and used by BOTH the tooltip and the table view, because those
 * are the two places a value is reachable and a chart whose tooltip and table
 * describe the same event differently has no table-view twin at all — it has
 * two charts.
 */
export function eventLabel(e: ContextEvent): EventLabel {
  if (e.kind === "compact") {
    const how = e.trigger === "auto" ? "Auto-compacted" : e.trigger === "manual" ? "Compacted (/compact)" : "Compacted";
    const drop = e.preTok && e.postTok ? ` · ${fmtTokens(e.preTok)} → ${fmtTokens(e.postTok)}` : "";
    return { kind: "compact", text: how + drop };
  }
  if (e.kind === "rebuild") {
    // The one event whose whole point is what it COST, because nothing about
    // the shape of the chart shows it: the window is unchanged either side.
    const wrote = e.wroteTok ? fmtTokens(e.wroteTok) : "the window";
    const quiet = e.gapMs ? ` after ${fmtGap(e.gapMs)} quiet` : "";
    return { kind: "rebuild", text: `Cache expired — re-wrote ${wrote}${quiet}` };
  }
  const scope = e.weekly ? "Weekly usage limit" : "Usage limit";
  const back = e.resetAt != null ? ` · back at ${fmtAxisTime(e.resetAt, 0)}` : "";
  return { kind: "limit", text: scope + back };
}

/**
 * What the axis IS — the sentence under every chart, one per `windowFrom`.
 *
 * ── Why this is said out loud at all ────────────────────────────────────────
 *
 * The entire value of a fixed 0–100% axis is that two sessions' charts can be
 * put side by side. A reader can only rely on that if the chart names the scale
 * it is on and admits the one case where it is not on the shared one.
 *
 * ── Why `"config"` gets its own sentence rather than joining `"model"` ──────
 *
 * `"config"` is the backend's own CONFIGURATION stating the window —
 * opencode's `/config/providers` `limit.context`. Every other source on this
 * list is something that was *watched*: the TUI printed it, or a conversation
 * was seen to hold it, or (weakest) the model id implied it. A configuration
 * number is none of those. It is what the tool believes it is permitted to
 * send, and a local runner serving that model may be holding a far smaller
 * context than the configuration claims — measured behaviour, not a hypothetical:
 * a model file loaded with a shorter `num_ctx` answers happily and truncates
 * quietly, and the configuration says nothing about it.
 *
 * So the sentence ATTRIBUTES it — "as <backend>'s configuration states it" —
 * and never presents it as a measurement. The number is still the best axis
 * available and is still drawn; what changes is whose claim it is. CLAUDE.md:
 * a heuristic degrades to absent, never to a wrong number — and a number whose
 * provenance is stated is not the same object as one asserted flat.
 *
 * Pure and here rather than inline in the sheet's JSX because it is four
 * mutually exclusive claims about truthfulness, which is exactly the kind of
 * thing that should be readable in one place and pinned by a test.
 */
export function axisNote(
  from: ContextWindowSource | undefined,
  windowTok: number | null,
  /** The model the window was derived from, where the source names one. */
  model: string | undefined,
  /** The backend's own label, for the source that is a claim BY a backend.
   *  Falls back to a neutral noun so a third backend needs no edit here. */
  backendLabel?: string,
): string {
  // No window is no window, whatever the source said: a "100% is null" sentence
  // is worse than admitting the axis is in tokens.
  if (windowTok == null || !(windowTok > 0)) {
    return "This model’s context window is not known here, so the axis is in tokens and is NOT the shared 0–100% scale — this graph cannot be compared with another session’s.";
  }
  const tok = fmtTokens(windowTok);
  switch (from) {
    case "measured":
      return `100% is ${tok} — the window ${model ?? "this model"} has been SEEN to hold, so it is the same scale as every other session’s graph.`;
    case "screen":
      return `100% is the ${tok} window the CLI printed on screen.`;
    case "config":
      // Attributed, never asserted. The two clauses are the whole point: whose
      // claim it is, and what would make it wrong.
      return `100% is ${tok}, as ${backendLabel ?? "this backend"}’s configuration states it${model ? ` for ${model}` : ""} — a setting this app read, not something anybody watched happen. A model running locally may be holding less than that, and nothing here would show it.`;
    case "model":
      // The weakest source, and the one that has been measured wrong: the CLI's
      // log records the base id even for a 1M conversation.
      return `100% is ${tok}, assumed from the model id${model ? ` (${model})` : ""} — nothing here has held more than that yet, so if it is really a larger window this axis will correct itself the first time a conversation goes past.`;
    default:
      return "This model’s context window is not known here, so the axis is in tokens and is NOT the shared 0–100% scale — this graph cannot be compared with another session’s.";
  }
}

/**
 * What the whole series amounts to, for the line above the chart.
 *
 * Null when there is nothing to summarise — a caller renders `Empty` instead,
 * rather than a headline reading "0 of 0".
 */

export function seriesSummary(samples: ContextSample[], events: ContextEvent[], windowTok: number | null, agents?: AgentRun[]): string | null {
  if (!samples.length) return null;
  const last = samples[samples.length - 1];
  const peak = samples.reduce((m, s) => (s.tok > m ? s.tok : m), 0);
  const compacts = events.filter((e) => e.kind === "compact").length;
  const limits = events.filter((e) => e.kind === "limit").length;
  const nowPct = contextPct(last.tok, windowTok);
  const peakPct = contextPct(peak, windowTok);
  const now = nowPct != null
    ? `${Math.round(nowPct)}% of ${fmtTokens(windowTok!)}`
    : `${fmtTokens(last.tok)} now`;
  const parts = [now, peakPct != null ? `peak ${Math.round(peakPct)}%` : `peak ${fmtTokens(peak)}`];
  // The parent's window says nothing about its agents': a session read 31%
  // here while an agent under it held 967k. Tokens, not a percentage — an
  // agent may run a model whose window is not this axis's.
  const ap = agentPeak(agents);
  if (ap != null) parts.push(`an agent held ${fmtTokens(ap)}`);
  if (compacts) parts.push(`${compacts} compaction${compacts > 1 ? "s" : ""}`);
  if (limits) parts.push(`${limits} usage limit${limits > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

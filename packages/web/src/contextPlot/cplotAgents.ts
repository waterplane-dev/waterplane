/**
 * The subagents as events on the same axis: swim lanes, their lines and the sentences about them.
 *
 * Moved out of `contextPlot.ts` unchanged (docs/notes/charts-architecture.md); that file is the
 * facade that re-exports every module in `contextPlot/`.
 */

import { fmtUsd, type AgentRun } from "@waterplane/shared";
import { fmtTokens, fmtAxisTime } from "../kit/chart/chartFmt.ts";
import { f1 } from "../kit/chart/chartPath.ts";
import { type Plot, fmtGap } from "./cplotAxis.ts";
import { type ModelSlots, modelLabel } from "./cplotModels.ts";

// ── the subagents, as events on the same axis ─────────────────────────────

/**
 * One subagent as a bar in the swim-lane strip: from its first dated record to
 * its last, in the lane interval packing put it in.
 *
 * ── Why lanes and not a count per bucket ────────────────────────────────────
 *
 * The strip used to count LAUNCHES per stretch of the axis, which says how
 * often a session fanned out and nothing about the three things that decide
 * what a fan-out cost: how long each agent ran, how many ran at once, and
 * which one was the big one. A bar per agent over its own span answers all
 * three on the axis the spend chart above it uses, so a step in the grey band
 * lines up with the bar that caused it.
 *
 * A lane is NOT an identity — it is just the first row the bar fitted in — so
 * lanes carry no label; the colour is the model (`modelSlots`), the one thing
 * about an agent that is a category.
 */
export interface AgentLane {
  run: AgentRun;
  /** Left edge and width, plot units. At least `LANE_MIN_W` wide, so a
   *  one-request agent is a mark rather than nothing. */
  x: number;
  w: number;
  lane: number;
  slot: number;
  /** The agent that spent the most — outlined, and named by the summary. */
  dearest: boolean;
  /** Still running: to the right edge, faded — its last record is not an end. */
  open: boolean;
}

/** Narrowest bar drawn, and the clear space packing keeps between two bars
 *  sharing a lane, in plot units. */
const LANE_MIN_W = 3;
const LANE_GAP = 2;

/**
 * Pack the agents into the fewest lanes, greedily in start order (interval
 * scheduling's first-fit, which is optimal for intervals sorted by start).
 *
 * Packed in PIXELS, not milliseconds: the axis is piecewise, and two agents
 * a compressed silence apart can be closer on screen than their times say — a
 * packing done in time would draw them over each other.
 */
export function agentLanes(p: Plot, agents: AgentRun[], slots: ModelSlots | null): { bars: AgentLane[]; lanes: number } {
  const dear = agents.reduce<AgentRun | null>((m, a) => (!m || a.tok > m.tok ? a : m), null);
  const ends: number[] = [];
  const bars: AgentLane[] = [];
  for (const run of [...agents].sort((a, b) => a.at - b.at || a.endAt - b.endAt)) {
    // Clamped into the plot: an agent before the first reading still draws.
    const x0 = Math.max(p.x, Math.min(p.x + p.w - LANE_MIN_W, p.px(run.at)));
    const x1 = run.running ? p.x + p.w // no end yet: the newest instant drawn
      : Math.min(p.x + p.w, Math.max(x0 + LANE_MIN_W, p.px(Math.max(run.at, run.endAt))));
    let lane = ends.findIndex((e) => e + LANE_GAP <= x0);
    if (lane < 0) { lane = ends.length; ends.push(x1); } else ends[lane] = x1;
    bars.push({ run, x: x0, w: x1 - x0, lane, slot: slots ? slots.slotOf(run.model) : 0, dearest: run === dear, open: !!run.running });
  }
  return { bars, lanes: ends.length };
}

/**
 * How tall each lane is: 13 units (a 10-unit bar and a 3-unit gap) up to eight
 * lanes, then squeezed so the strip stays near ~104 units however many ran at
 * once, never below a 3-unit bar.
 */
export function laneGeom(lanes: number): { laneH: number; barH: number; plotH: number } {
  const laneH = lanes <= 8 ? 13 : Math.max(5, Math.floor(104 / lanes));
  return { laneH, barH: Math.max(3, laneH - 3), plotH: Math.max(1, lanes) * laneH };
}

/**
 * The bar under a pointer: the one in the pointer's lane nearest it in x (zero
 * inside a bar), or, off every lane, the nearest bar at all. By position rather
 * than an exact hit, because a 3-unit bar is not a target on a phone.
 */
export function agentAtPoint(bars: AgentLane[], laneH: number, plotY: number, x: number, y: number): AgentLane | null {
  if (!bars.length) return null;
  const lane = Math.floor((y - plotY) / laneH);
  const dist = (b: AgentLane) => (x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0);
  const pool = bars.some((b) => b.lane === lane) ? bars.filter((b) => b.lane === lane) : bars;
  return pool.reduce((m, b) => (dist(b) < dist(m) ? b : m), pool[0]);
}

/** Most agents running at the same instant, measured in time (a lane count
 *  is pixels). A hand-over is not concurrent; a running agent has not ended. */
export function agentConcurrency(agents: AgentRun[]): number {
  const ev = agents.flatMap((a) => [[a.at, 1], [a.running ? Infinity : Math.max(a.at, a.endAt), -1]] as [number, number][])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0, max = 0;
  for (const [, d] of ev) { now += d; if (now > max) max = now; }
  return max;
}

/** The tapped agent, as the text line under the strip. */
export function agentReadout(a: AgentRun, models: string[] | undefined, span: number): string {
  const who = models && a.model != null ? models[a.model] : null;
  return [
    a.type ?? "agent",
    who ? modelLabel(who) : null,
    a.running
      ? `started ${fmtAxisTime(a.at, span)} · still running, last wrote ${fmtAxisTime(a.endAt, span)}`
      : `${fmtAxisTime(a.at, span)}–${fmtAxisTime(a.endAt, span)} (${fmtGap(Math.max(0, a.endAt - a.at))})`,
    `${fmtTokens(a.tok)} spent`,
    a.peakTok ? `window peaked at ${fmtTokens(a.peakTok)}` : null,
    a.costUsd != null ? fmtUsd(a.costUsd) : null,
  ].filter(Boolean).join(" · ");
}

/**
 * What the lane strip says above itself: how many, how many at once, how
 * long, and which one was dear (the outlined bar).
 */
export function agentSummary(agents: AgentRun[], models: string[] | undefined): string {
  if (!agents.length) return "No subagents — every turn here ran in this conversation.";
  // A running agent's span so far is not its length: finished ones only.
  const spans = agents.filter((a) => !a.running && a.endAt > a.at);
  const busiest = agents.reduce((m, a) => (a.tok > m.tok ? a : m), agents[0]);
  const parts = [`${agents.length} subagent${agents.length > 1 ? "s" : ""}`];
  const live = agents.filter((a) => a.running).length;
  if (live) parts.push(`${live === agents.length && live > 1 ? "all" : live} still running (fading out at the right)`);
  const most = agentConcurrency(agents);
  if (most > 1) parts.push(`up to ${most} at once`);
  if (spans.length) {
    const med = spans.map((a) => a.endAt - a.at).sort((a, b) => a - b)[Math.floor(spans.length / 2)];
    parts.push(`median ${fmtGap(med)} each`);
  }
  const who = models && busiest.model != null ? models[busiest.model] : null;
  parts.push(`dearest ${fmtTokens(busiest.tok)}${who ? ` on ${modelLabel(who)}` : ""}${agents.length > 1 ? " (outlined)" : ""}`);
  return parts.join(" · ");
}

/**
 * The share of the agents' spend the strip CANNOT draw — logs that carried no
 * timestamp are in `agentTok` and off the roster. An absence, so it is a
 * sentence in the open, never folded; null when the roster accounts for it all.
 */
export function agentUndatedText(agents: AgentRun[], agentTok: number | null | undefined): string | null {
  if (agentTok == null) return null;
  const drawn = agents.reduce((n, a) => n + a.tok, 0);
  const off = agentTok - drawn;
  if (!(off > 0)) return null;
  return `${fmtTokens(off)} of the subagents' tokens are in logs with no timestamp: in every total here, and on no chart.`;
}

/**
 * One path per agent's own window, on the plot's axes. An agent with no
 * dated points draws nothing (it is still in the totals).
 */
export function agentLines(p: Plot, agents: AgentRun[]): { id: string; d: string }[] {
  const n = f1;
  return agents
    .filter((a) => (a.ctx?.length ?? 0) > 0)
    .map((a) => ({
      id: a.id,
      d: a.ctx!.length === 1
        ? `M${n(p.px(a.ctx![0][0]) - 1)},${n(p.py(a.ctx![0][1]))}h2`
        : `M${a.ctx!.map(([t, v]) => `${n(p.px(t))},${n(p.py(v))}`).join("L")}`,
    }));
}

/** The largest window any one agent held, or null when none reported one. */
export function agentPeak(agents: AgentRun[] | undefined): number | null {
  const m = Math.max(0, ...(agents ?? []).map((a) => a.peakTok ?? 0));
  return m > 0 ? m : null;
}

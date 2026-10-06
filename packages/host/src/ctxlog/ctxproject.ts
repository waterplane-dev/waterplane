/** The cursor as the wire document, and the row sparkline. Moved from ctxlog.ts. */
import { updateContextLog } from "./ctxupdate.js";
import { agentEnvelope, liveAgentOf } from "./ctxagents.js";
import type { ContextSpark, ContextWindowSource } from "@waterplane/shared";
import { seriesCostFields, downsample } from "@waterplane/shared";
import { projectCold, projectCompaction } from "./ctxcursor.js";
import type { ContextLog, SeriesCursor } from "./ctxcursor.js";
import type { AgentUsage } from "./ctxagents.js";

/**
 * The model table the client gets, and the permutation that gets it there.
 *
 * The cursor claims a slot on FIRST SIGHT, because that is the only order a
 * single forward pass can assign. The client needs them ordered by VOLUME: the
 * order is what picks a colour, the palette has four validated slots and no
 * fifth, so the models that fall off the end have to be the small ones and the
 * dominant model has to be slot 0 on both this screen and the all-sessions one.
 *
 * So the table is sorted once, here, and every index that pointed into it is
 * rewritten. Sorting the table without rewriting the indices is the failure
 * this function exists to make impossible — every sample would keep pointing at
 * the model that used to be in that slot, and the chart would be confidently,
 * silently, wrong about which model did what.
 */
export function modelOrder(cur: SeriesCursor): { models: string[]; at: number[] } {
  const idx = cur.models.map((_, i) => i);
  // Ties broken by the id, so two models with identical totals do not swap
  // places (and swap colours) between one read and the next.
  idx.sort((a, b) => (cur.modelTok[b] - cur.modelTok[a]) || (cur.models[a] < cur.models[b] ? -1 : 1));
  const at: number[] = new Array(cur.models.length);
  idx.forEach((from, to) => { at[from] = to; });
  return { models: idx.map((i) => cur.models[i]), at };
}

/** Project a cursor into the document a client gets. */
export function projectContextLog(cur: SeriesCursor): ContextLog {
  const order = modelOrder(cur);
  return {
    // Re-pointed onto the sorted table, into NEW objects: `downsample` returns
    // the cursor's own array when the series is under the cap, and rewriting a
    // field in place would corrupt the live cursor every other projection.
    samples: downsample(cur.samples).map((s) => (s.model != null ? { ...s, model: order.at[s.model] } : s)),
    models: order.models,
    events: cur.events,
    turns: cur.turns,
    usageTok: cur.usageTok,
    split: cur.split,
    // Null, never a breakdown of zeros, when not one record could be priced:
    // a $0 beside a conversation that visibly ran reads as "this was free",
    // and the honest answer is that nothing here knows what it cost. The
    // unpriced tokens travel either way, so the screen can say which it is.
    cost: cur.cost.total > 0 ? cur.cost : null,
    unpricedTok: cur.unpriced,
    compaction: projectCompaction(cur.compaction),
    coldStarts: projectCold(cur.cold),
    autoCompactTok: cur.autoCompactTok,
    model: cur.model,
    truncated: cur.truncated,
    mtime: cur.mtime,
  };
}

/**
 * Parse one conversation log into a context-window series, from scratch.
 *
 * The stateless form, for a caller with nowhere to keep a cursor (and for the
 * tests, where "the same file read twice gives the same answer" is the point).
 */
export function readContextLog(path: string): ContextLog | null {
  const cur = updateContextLog(path, null);
  return cur ? projectContextLog(cur) : null;
}

// ── The row miniature ─────────────────────────────────────────────────────

/** Readings in a sparkline. Sixteen is what fits legibly in ~72 px. */
export const SPARK_POINTS = 16;
/**
 * Event ticks in a sparkline.
 *
 * Six, not ten. A tick is a full-height rule across a 76 px box, and past a
 * handful of them the miniature reads as a hatch pattern rather than a curve
 * with things marked on it — which loses the curve, the thing the row is
 * actually for. The count is in the badge's title text either way.
 */
export const SPARK_MARKS = 6;

/**
 * The same series, small enough to ride on `SessionInfo`.
 *
 * A sparkline's x axis is the READING, not the clock — the standard convention,
 * and the only one available here: sixteen points cannot carry a time axis, and
 * an event tick placed by time against a curve placed by index would sit beside
 * the drop it is naming rather than on it. So the ticks are placed by finding
 * the reading nearest each event and using ITS index, which keeps the tick and
 * the cliff together whatever the spacing does.
 */
/**
 * The session's list-price cost, as the three optional fields the spark carries.
 *
 * Its own function because the rule is a conjunction that is easy to get wrong
 * inline: the figure is the conversation's cost PLUS its agents', and a total
 * of zero is not a cost of zero — it is a conversation nothing in the rate
 * table could price, which must come out absent so the row falls back to
 * tokens. `unpricedTok` is published whenever there IS one, including beside a
 * real cost: a session that ran an unknown model for half its turns has a
 * figure that is true and low, and saying so is the only honest form of it.
 */
function costFields(cur: SeriesCursor, agents: AgentUsage): Partial<ContextSpark> {
  // An agent tally from before this field existed cannot say what its logs
  // cost, and the rule `usageTok` follows applies to money first: a figure that
  // leaves the agents out is worse than no figure. So an absent agent cost
  // withholds the WHOLE reading rather than publishing the parent's half of it.
  if (!agents.cost) return {};
  const total = cur.cost.total + agents.cost.total;
  const unpriced = cur.unpriced + (agents.unpriced || 0);
  return {
    ...(total > 0 ? { costUsd: total } : {}),
    ...(total > 0 && agents.cost.total > 0 ? { agentCostUsd: agents.cost.total } : {}),
    ...(unpriced > 0 ? { unpricedTok: unpriced } : {}),
  };
}

export function sparkOf(
  cur: SeriesCursor,
  windowTok: number | null,
  windowFrom: ContextWindowSource,
  /** What this session's subagents have spent (`agentUsage`), when the caller
   *  looked. Absent ⇒ the spark carries no total at all rather than one that
   *  silently leaves the agents out — on a fan-out session those ARE the bill. */
  agents?: AgentUsage | null,
  /** The clock `liveAgentOf` asks recency against — a parameter for the test. */
  now: number = Date.now(),
): ContextSpark | null {
  const pts = downsample(cur.samples, SPARK_POINTS);
  if (!pts.length) return null;
  const last = pts.length - 1;
  const marks: ContextSpark["marks"] = [];
  // Newest events first, so what survives the cap is what just happened.
  //
  // A `rebuild` is deliberately NOT a mark. The curve is the window, and a
  // re-write leaves the window exactly where it was — there is nothing at that
  // x for a tick to point at. It also has no validated colour of its own (the
  // chart has two event colours, measured under three kinds of colour
  // blindness in both themes), and painting it in the usage-limit red would
  // say "your account refused this request", which is a different and much
  // more alarming claim. It travels as a COUNT on `coldStarts` and as a
  // sentence instead.
  for (const e of cur.events.filter((e) => e.kind !== "rebuild").slice(-SPARK_MARKS)) {
    let idx = 0;
    // Nearest reading by time. Linear, over at most sixteen points.
    for (let i = 1; i <= last; i++) {
      if (Math.abs(pts[i].t - e.t) < Math.abs(pts[idx].t - e.t)) idx = i;
    }
    marks.push({ at: last ? idx / last : 0, kind: e.kind });
  }
  // The spend curve, index-for-index with the readings. Emitted only when the
  // backend actually records output tokens: a series of zeros would draw a flat
  // line along the floor, which reads as "this session has spent nothing"
  // rather than as "nobody measured it". Absent, and the row draws no second
  // miniature — the `ContextSpark.usedPts` rule.
  const usedPts = pts.some((p) => p.used != null && p.used > 0)
    ? pts.map((p) => p.used ?? 0)
    : null;
  // The agents' own windows, bucketed onto these same readings — the one fact
  // a fan-out session's row otherwise hides (the parent at 31%, an agent at 97%).
  const agentEnv = agents?.runs ? agentEnvelope(pts.map((p) => p.t), agents.runs) : null;
  const live = agents?.files ? liveAgentOf(agents, now) : null;
  return {
    pts: pts.map((p) => p.tok),
    ...(usedPts ? { usedPts } : {}),
    ...(agentEnv ? { agentEnv } : {}),
    ...(live ? { liveAgentTok: live.tok, liveAgentAt: live.at, liveAgentId: live.id, ...(live.type ? { liveAgentType: live.type } : {}) } : {}),
    marks,
    peak: cur.samples.reduce((m, p) => (p.tok > m ? p.tok : m), 0),
    // The three the cost reading needs, off the FULL series rather than `pts`.
    // Derived in `@waterplane/shared` so the context sheet — which holds the same
    // series at full resolution — cannot decide for itself what a baseline is.
    // The truncated case withholds the baseline there; see `seriesCostFields`.
    // `turns` is COUNTED (`cur.turns`), never `samples.length` — see the field.
    ...seriesCostFields(cur.samples, cur.truncated, cur.turns),
    // The total, and the agent share of it. Both absent when nobody looked at
    // the subagent directory: "1.4M used" that omits eight agents is worse than
    // no figure, and the phone words what it gets, never what it assumes.
    ...(agents ? { usageTok: cur.usageTok + agents.tok, agentTok: agents.tok } : {}),
    // …and the same two facts in money, which is what the row PRINTS. They
    // follow `usageTok` exactly: absent unless the agents were looked at, so
    // the chip can never quote a figure that leaves eight conversations out,
    // and absent (never `0`) when nothing could be priced at all — the row
    // then falls back to the token total, which is what it showed before any
    // of this existed. `unpricedTok` travels beside them so the title can name
    // what was left out instead of the chip silently coming in low.
    ...(agents ? costFields(cur, agents) : {}),
    windowTok,
    windowFrom,
    autoCompactTok: cur.autoCompactTok,
    // Three small numbers, on the spark that every launcher row already holds:
    // this is the one fact about a conversation's price that the curve above it
    // cannot show, because a re-write leaves the window exactly where it was.
    coldStarts: projectCold(cur.cold),
  };
}


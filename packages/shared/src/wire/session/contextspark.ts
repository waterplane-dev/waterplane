import type { CostBreakdown } from "../../pricing.js";
import type { ColdStarts } from "../../sessioncost.js";
import type { AutoCompactSource } from "../../autocompact.js";
import type { TokenTotals } from "../telemetry.js";
import type { SessionCarried } from "../alwayson.js";
import type { ContextSample, AgentRun, ContextEvent, CompactionLedger, SkillLoad } from "./context.js";

/**
 * The context series, small enough to ride on every `SessionInfo` — the
 * miniature drawn on a launcher row beside the context percentage.
 *
 * Sixteen readings and ten ticks, ~200 bytes. It is a SHAPE, not a chart: its x
 * axis is the reading index, not the clock, so the ticks are placed by index
 * too (host `sparkOf`) and a compaction tick always sits on the cliff it names.
 * The full series, with a real time axis, is `/api/context`.
 */
export interface ContextSpark {
  /** Readings in tokens, oldest first. */
  pts: number[];
  /**
   * What the conversation had SPENT at each of those same readings — the
   * cumulative curve, index-for-index with `pts`.
   *
   * The second miniature on a launcher row, and the reason there are two: `pts`
   * is a level that a compaction drops to a third, and this one cannot fall.
   * They are never drawn as two lines on one chart for exactly that reason —
   * same unit, nothing else in common — which is the rule the full sheet's two
   * charts already follow (`SpendChart`).
   *
   * Sixteen more numbers, ~100 bytes, on a payload that rides every
   * `SessionInfo`: the alternative was the total as a bare figure, which says
   * what a session has cost and nothing at all about how it got there — a
   * session that spent 38M in one fan-out turn and one that crept there over
   * two days print the same chip.
   *
   * The MAIN conversation only, like `ContextSample.used` it is taken from, so
   * its last value is `usageTok` minus `agentTok`. On this miniature the gap is
   * drawn as a reference line, never folded into the curve: the spark carries
   * no agent spend series (the sheet's `agentCum` does, at a size a launcher
   * row has no room for). Absent on a backend that records no output tokens — then the row has
   * no spend miniature at all, never a curve of `pts` cumulated, which is a
   * different quantity wearing the same units.
   */
  usedPts?: number[];
  /**
   * What the SUBAGENTS had spent by each of those same readings — cumulative,
   * index-for-index with `usedPts`, its last value exactly `agentTok`. The spend
   * miniature STACKS it on the parent's curve (the sheet's spend chart does the
   * same with `agentCum`), so the top edge is the total beside it. Without it a
   * fan-out session drew its parent's 8% as a line on the floor under a dashed
   * total at the top of the box. Absent with no agent spend, without
   * `usedPts`, and from an older host — then the dashed total, as before.
   */
  agentUsedPts?: number[];
  /**
   * The SUBAGENTS' windows, as an envelope index-for-index with `pts`: the
   * largest context any agent held within each reading's stretch of time (the
   * stretch runs half-way to each neighbouring reading; the first and last
   * reach to the ends). 0 where no agent ran.
   *
   * A fan-out session reads 31% in its own window while an agent under it holds
   * 97% of its own, and a row miniature of the parent alone says "cheap and
   * small". Drawn as a faint area BEHIND the parent's line on the same axis.
   * Absent when no agent reported a dated window, and from an older host.
   */
  agentEnv?: number[];
  /**
   * The largest CURRENT window among this session's RUNNING subagents: each
   * agent's LATEST request (input + cache read + cache write), over the agents
   * whose last record is within `AGENT_LIVE_MS` of when the host built this
   * spark. A running agent re-reads that much on every step, and nothing else
   * on the row says so while it happens (`agentEnv` is its history, drawn
   * faintly). Absent when no agent is live, and from an older host.
   *
   * The spark is only rebuilt when a log moves, so the phone re-asks recency
   * against `liveAgentAt` with its own clock (`liveAgentText`).
   */
  liveAgentTok?: number;
  /** That agent's last record, epoch ms — present exactly with `liveAgentTok`. */
  liveAgentAt?: number;
  /** That agent's id (its log's name) — one notice per agent, not per frame. */
  liveAgentId?: string;
  /** Its `agentType`, when its `.meta.json` named one. */
  liveAgentType?: string;
  /** Event ticks, as a fraction 0..1 along the same run of readings. */
  marks: { at: number; kind: ContextEvent["kind"] }[];
  /** Highest reading of the FULL series. Kept even though the axis is fixed:
   *  it is what the row's title text quotes. */
  peak: number;
  /**
   * The session's FIRST reading — what one turn of a FRESH session in this repo
   * carries, measured rather than assumed.
   *
   * Here and not derived from `pts[0]` because `pts` is downsampled keeping each
   * bucket's max AND min, emitted in time order — so on a conversation that
   * compacted early, `pts[0]` is the first bucket's PEAK and not the session's
   * first turn. Reading the baseline there would inflate it and understate the
   * cost multiple, which is the one direction this must never err in. Absent
   * when the log was `truncated` and the first reading is not in what was
   * read.
   */
  baseTok?: number;
  /**
   * Turns this conversation has completed — what the outline lists.
   *
   * COUNTED off the user records (host `ctxlog.ts`, sharing the reader's own
   * `opensTurn`), never the length of the series: a reading is one REQUEST, so
   * a turn that ran thirteen tools contributes fourteen of them and the count
   * read 24 where the outline listed 4.
   *
   * A FLOOR, and worded as one wherever it is printed — a resumed log's
   * pre-prompt tail and this host's own screen-only turns are turns the reader
   * lists and this cannot see, and a truncated read undercounts besides.
   */
  turns?: number;
  /**
   * Every reading summed: the tokens this conversation has carried in total.
   *
   * Not a bill — cache reads price at a tenth of input and the plan is nowhere
   * in the log — but it is the VOLUME, which is what a usage window counts, and
   * it is the only figure that makes the cost of a long conversation concrete
   * instead of a ratio.
   */
  spentTok?: number;
  /**
   * What this session has USED, in total: every request it sent and every
   * token it generated, its subagents included.
   *
   * A different fact from `spentTok`, which is the sum of the READINGS — the
   * input side of the main conversation only, because that is what the curve
   * is drawn from. This one adds the output of each turn and everything the
   * Task tool's agents spent in their own logs, and it is the number somebody
   * means by "what has this session cost me": a session whose window reads 267k
   * can have used ten times that once its subagents are counted.
   *
   * Still not a bill — cache reads price at a tenth of input, and no plan is in
   * the log — and always a FLOOR, worded "so far" wherever it is printed: a
   * truncated log undercounts, and a subagent log this host never saw is one it
   * cannot add. Absent when nothing measured it, never a guess.
   */
  usageTok?: number;
  /** The SUBAGENT share of `usageTok` — already inside it, carried apart
   *  because "267k in the window, 1.4M used, 1.1M of it in agents" is three
   *  facts and the middle one alone explains nothing. */
  agentTok?: number;
  /**
   * What `usageTok` would have cost at Anthropic's published list prices, USD,
   * subagents included — the figure the row's spend miniature PRINTS.
   *
   * A token count is not a quantity anybody has an instinct for: `38M` and
   * `18M` sit next to each other on the launcher and say nothing about which
   * conversation was the expensive one, because the answer depends entirely on
   * the model and on how much of it was cache reads at a tenth of the rate. So
   * the chip is money, and the tokens move into the title beside it.
   *
   * Priced PER RECORD, on the model and the day that record ran
   * (`pricing.ts`), never by applying one rate to the session's total: a
   * conversation changes model mid-way, and the all-sessions screen prices at
   * the same granularity — one of them picking a single rate is how the two
   * screens come to disagree about the same tokens.
   *
   * A counterfactual and not a bill: this app drives a CLI that most people
   * run on a subscription, and a subscription is a flat fee. Every surface
   * that prints it says so.
   *
   * **Absent when nothing could be priced** — an unrecognised model, a backend
   * that records no usage, a host one version behind — and then the chip falls
   * back to the token total exactly as it was. Never 0, which reads as free.
   */
  costUsd?: number;
  /** The SUBAGENT share of `costUsd`, already inside it — the money twin of
   *  `agentTok`, and the reason a 300k-window session can be the dearest one
   *  on the screen. */
  agentCostUsd?: number;
  /** Tokens that ran on a model with no published rate, and so are in NEITHER
   *  cost figure. Carried so the reading can say what it left out rather than
   *  quietly charging zero for it; absent means there were none. */
  unpricedTok?: number;
  /** As on `ContextSeriesDoc` — the window every graph is scaled against, and
   *  where an auto-compaction was observed to fire. */
  windowTok: number | null;
  windowFrom: ContextWindowSource;
  autoCompactTok: number | null;
  /** The `autoCompactWindow` SETTING for this session's worktree as it read
   *  when the spark was built, in tokens (`ContextSeriesDoc.autoCompactSet`'s
   *  size). The miniature's y axis tops out here: past it the session does not
   *  grow, so a 1M axis under a 400k setting draws every row in the bottom
   *  half. Absent when no size is set, or on an older host. */
  autoCompactSetTok?: number;
  /** The rebuilds this conversation has paid for — see `ColdStarts`. Absent on
   *  an older host; `count: 0` is the claim that there were none. */
  coldStarts?: ColdStarts;
}

/**
 * Where the number behind "100%" came from.
 *
 * On the graph this decides whether the axis can be a PERCENTAGE at all, which
 * is what makes two sessions' charts comparable — so it is carried rather than
 * re-derived, and `"none"` is a visible state with its own sentence, never a
 * silent switch to a per-session axis nobody was told about.
 */
export type ContextWindowSource =
  /** The TUI printed an absolute gauge for THIS session — a direct statement,
   *  so it wins over every inference. */
  | "screen"
  /** The most context this model has been SEEN to hold, snapped to a real
   *  window. The ordinary answer, and the only one the id rule cannot get
   *  wrong: a conversation cannot exceed its own window. */
  | "measured"
  /** The model id alone, with no observation yet. Right for a 200k model and
   *  for a launch id carrying `[1m]`; wrong for a 1M conversation whose log
   *  dropped the suffix, which is why it ranks below a measurement. */
  | "model"
  /**
   * The BACKEND'S OWN CONFIGURATION states the window — opencode's
   * `/config/providers` `limit.context`.
   *
   * Ranked below `screen` and `measured` deliberately: it is what the tool
   * believes it is allowed to send, not something anybody watched happen. A
   * local runner may be holding a smaller context than the configuration
   * claims. It travels with the number so the caption can ATTRIBUTE it rather
   * than present it as a measurement.
   */
  | "config"
  /**
   * The CLI SAID it, over its own channel, for the model this session is on —
   * a plugin backend's `ContextSource` sample carrying `window` (contract 2.2).
   * A statement about THIS session, like `screen`, but not something printed
   * on screen, so it gets its own caption. Only a source session's series
   * carries it; claude's never does.
   */
  | "source"
  /** None of them: the axis falls back to tokens and the graph says so. */
  | "none";

/**
 * How full a session's context window has been, over time — the CLI's own
 * conversation log, read as a series.
 *
 * The screen-scraped `contextLeft` is one number with no history and no clock;
 * this is the same fact as a shape. Read-only and best-effort in the same sense
 * as the transcript: an unreadable log yields null and the graph says so.
 */
export interface ContextSeriesDoc {
  sessionId: string;
  claudeSessionId?: string;
  /** The log's mtime — what a poll passes back as `since` for a 204. */
  updatedAt: number;
  samples: ContextSample[];
  events: ContextEvent[];
  /**
   * The window every context graph is scaled against — 100% on the y axis.
   *
   * The conversation log does not record it, so it comes from the MODEL
   * (`resolveContextWindow`, and `windowFrom` says which source answered). Null
   * when the model is not recognised,
   * and then the graph plots tokens on an axis of its own AND SAYS SO — a chart
   * silently 5× off is worse than one that admits it does not know.
   */
  windowTok: number | null;
  windowFrom: ContextWindowSource;
  /** The model the window was derived from, for the sentence that names it. */
  model?: string;
  /**
   * Where an auto-compact was last OBSERVED to fire, in tokens.
   *
   * This is a measurement, not a setting: the newest `trigger:"auto"` compact's
   * own `preTokens`. It is not the window size and is not labelled as one — it
   * is the line the conversation actually got cut at, which is the more useful
   * of the two when the window is unknown.
   */
  autoCompactTok: number | null;
  /**
   * The `autoCompactWindow` a session spawned in this conversation's directory
   * would see NOW — a SETTING, read when this document was built, not what the
   * conversation ran under (the file may have changed since). `tokens` is null
   * for `auto`, unset or an unparseable value: auto compacts near the model's
   * own window and no number for it is guessed. Absent on an older host.
   */
  autoCompactSet?: { tokens: number | null; source: AutoCompactSource; raw?: string };
  /** The log was longer than the tail this reads — the series starts mid-way. */
  truncated: boolean;
  /** Turns the log opened, counted — see `ContextSpark.turns`. A FLOOR. */
  turns?: number;
  /** What the session has used in total, and the subagent share of it — the
   *  same two facts `ContextSpark` carries, off the full series. FLOORS. */
  usageTok?: number;
  agentTok?: number;
  /**
   * `usageTok`, broken into the four kinds — this conversation's own requests.
   *
   * A single "16M spent" is the app's most misleading number for exactly the
   * reason `tokens.ts` opens with: measured over this desktop's whole corpus,
   * 96% of it is the conversation being re-read out of the prompt cache, and a
   * reader who takes the figure for fresh input is out by two orders of
   * magnitude. The all-sessions screen has never printed a total without the
   * split beside it; this is the same rule, per session, and it is the SAME
   * `TokenTotals` shape so the two screens cannot word one fact two ways.
   *
   * `turns` here counts assistant REQUESTS, not the `turns` field above, which
   * is what the outline lists. They differ by roughly the number of tool calls
   * — a turn that ran thirteen tools sent fourteen requests — and the per-turn
   * context reading (`cacheReading`) divides by requests on both screens or
   * the same conversation reads differently depending which one you opened.
   *
   * Absent on an older host and on a backend whose log records no usage; then
   * nothing is drawn, never a bar of zeros.
   */
  split?: TokenTotals;
  /**
   * The same four kinds for the SUBAGENTS — `agentTok` broken up.
   *
   * Apart rather than folded in, for the reason `agentTok` is: on a fan-out
   * session they are most of the bill, and "of which subagents" is a question
   * somebody asks. A caller wanting the session's whole shape adds the two.
   */
  agentSplit?: TokenTotals;
  /**
   * What ALL the subagents had spent by each instant — every agent log's
   * requests merged by their own timestamps, as a running total `[t, tok]`.
   *
   * The same four kinds and the same record rules (dedupe by `message.id`,
   * `<synthetic>` skipped) as `agentTok`, so the LAST point equals `agentTok`
   * exactly: a record with no timestamp is counted at the next dated record of
   * its log (or at the log's end), and a log with none at all lands on the
   * final point. Thinned to `AGENT_CUM_POINTS`, keeping each bucket's LAST
   * point, so every point is a true value of the running total and the last is
   * exact. The spend chart stacks it on the parent's cumulative curve, step-held
   * between points. Absent from an older host and when no agent log carried a
   * dated record.
   */
  agentCum?: [t: number, tok: number][];
  /**
   * What this conversation's own requests would have cost at list prices — the
   * same accounting as the all-sessions screen, per session.
   *
   * Broken down by kind for the reason `split` is: cache reads are 96% of the
   * tokens and output is most of the money, and one figure cannot be un-summed
   * back into that. Priced per record on its own model and day (`pricing.ts`),
   * which is the only granularity at which it is well defined.
   *
   * Absent when nothing could be priced, never a breakdown of zeros.
   */
  cost?: CostBreakdown;
  /** The same for the SUBAGENTS — apart from `cost`, exactly as `agentSplit`
   *  is apart from `split`, and travelling only with it. */
  agentCost?: CostBreakdown;
  /** Tokens on a model with no published rate, in neither figure above. Said
   *  on screen rather than charged at zero; absent means there were none. */
  unpricedTok?: number;
  /**
   * The models that ran in this conversation, **descending by tokens** — the
   * table `ContextSample.model` and `AgentRun.model` index into.
   *
   * The order is not cosmetic: it is how a model gets its colour, and it is
   * fixed for the whole document rather than recomputed per chart or per
   * visible range. A palette slot follows the ENTITY, so a crosshair, a range
   * change or a filter must not repaint the survivors — ranking per view is
   * exactly how that happens.
   *
   * Absent on an older host; then nothing can be stacked by model and the
   * chart offers only its kinds.
   */
  models?: string[];
  /**
   * Every subagent this conversation ran, oldest first.
   *
   * Dated, sized and attributed — see `AgentRun`. Absent when the subagent
   * directory could not be read at all (a MISSING one is a measured zero and
   * ships an empty list, which is a different claim and reads as one).
   */
  agents?: AgentRun[];
  /**
   * Every skill the conversation ITSELF loaded, oldest first (its agents'
   * ride on each `AgentRun.skills`). Always sent where the log was read, an
   * empty list when none were — absent only from an older host, so "loaded
   * none" and "nobody looked" stay apart.
   */
  skills?: SkillLoad[];
  /**
   * What the FIRST request of this conversation carried, read off the CLI log's attachment records
   * written before the first assistant usage (D2: the initial set; later deltas are only counted).
   * Absent on an older host and where the log's head could not be read — never a guessed set.
   */
  carried?: SessionCarried;
  /**
   * What this conversation's compactions shed, saved and cost.
   *
   * Absent on an older host and on a backend whose log has no compaction
   * boundary at all. A conversation that has never compacted ships a ledger of
   * ZEROES rather than nothing, so those two states stay apart: one is "none
   * have run", which is an answer, and the other is "nobody counted", which is
   * not — and the screen draws a panel for neither.
   */
  compaction?: CompactionLedger;
  /**
   * The turns that came back to an expired cache and re-wrote the window.
   *
   * Absent on an older host. A conversation with none ships `count: 0` rather
   * than nothing, for `compaction`'s reason: "none happened" is an answer and
   * "nobody counted" is not.
   */
  coldStarts?: ColdStarts;
}

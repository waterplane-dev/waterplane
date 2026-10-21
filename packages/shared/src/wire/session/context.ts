// ── Context-window history ────────────────────────────────────────────────

/**
 * One reading of how full the context window was, at an instant.
 *
 * `tok` is what the request carried in: prompt tokens plus everything read
 * back out of the cache plus everything written into it. That sum is the
 * context the model actually saw, which is the number the TUI's own meter is a
 * percentage of — output tokens are deliberately NOT in it, since they are not
 * context until the turn after.
 */
export interface ContextSample {
  /** Epoch ms, from the log record's own timestamp. */
  t: number;
  tok: number;
  /**
   * Everything this conversation had SPENT by the time of this request —
   * cumulative, monotonic, in tokens.
   *
   * `tok` is a level and this is its integral-so-far: what the window carried
   * at that instant, against what the whole conversation had cost to get
   * there. They are drawn as two charts and never as two lines on one, because
   * they share a unit and nothing else — a compaction drops `tok` to a third
   * and cannot move this at all.
   *
   * Counted the way `ContextSpark.usageTok` is counted (every request's input,
   * cache reads and cache writes PLUS its output) and by the same running
   * counter, so the last sample's `used` is `usageTok` minus the subagent
   * share. The gap between the two is `agentTok`: the agents' own logs are
   * dated too, and their running total over time is `ContextSeriesDoc.agentCum`,
   * which the spend chart stacks on top of this curve.
   *
   * A FLOOR, like every figure derived from a log that may be truncated: a
   * series whose oldest records fell off the cap starts part-way up, which is
   * correct and is said next to the chart. Absent on a backend that does not
   * record output tokens per request, and then there is no spend chart at all
   * — never a curve of `tok` cumulated, which is a different quantity wearing
   * the same units.
   */
  used?: number;
  /**
   * What this ONE request was made of — the four kinds, in `TOKEN_KINDS` order.
   *
   * The composition strip at the foot of the sheet already says 96% of
   * everything was a cache read. That is the right headline and it cannot
   * answer the question underneath it: WHEN did the mix change. A session that
   * re-read a 300k window eighty times and one that wrote a fresh 300k cache
   * eighty times print an identical strip and were two completely different
   * afternoons. Per sample, a stacked chart can tell them apart.
   *
   * A TUPLE rather than a `TokenTotals`, deliberately: there are up to 1,200 of
   * these in one document and the key names would be most of the bytes.
   *
   * `input + cacheRead + cacheWrite` is `tok` exactly, and `output` is the
   * fourth — NOT in `tok`, because output is not context until the turn after.
   * Absent on an older host, and then the chart draws the single series it
   * always drew rather than a stack of zeros.
   */
  kinds?: SampleKinds;
  /**
   * The same four kinds, CUMULATIVE — what the conversation had spent of each
   * by this request. `cum` sums to `used` exactly.
   *
   * A second tuple rather than a running sum computed on the phone, and the
   * reason is the downsampler. `samples` is capped at 1,200 and thinned by
   * keeping each bucket's min and max, so a client-side cumsum over what
   * survived would leave out every dropped request and the stacked spend chart
   * would end a long way below the total printed above it — the "two totals
   * that nearly agree" failure this file's header calls the worst one
   * available. A recorded running counter survives thinning; a derived one does
   * not, which is exactly why `used` is recorded too.
   *
   * Absent on an older host, and then the spend chart is the single series it
   * always was.
   */
  cum?: SampleKinds;
  /**
   * Which model ran this request — an INDEX into `ContextSeriesDoc.models`.
   *
   * An index rather than the id, for the reason `kinds` is a tuple: the id is
   * ~18 characters and it would repeat on every one of 1,200 samples. Absent
   * when the record named no model.
   */
  model?: number;
}

/**
 * One request's four kinds, in `TOKEN_KINDS` order: input, output, cache read,
 * cache write.
 *
 * The order is load-bearing — it is the palette SLOT order on every screen that
 * paints these, so a tuple written in another order is a chart with the right
 * numbers in the wrong colours. `sampleTotals()` is the one reader, and there
 * must not be a second.
 */
export type SampleKinds = [input: number, output: number, cacheRead: number, cacheWrite: number];

/**
 * One subagent a session ran, as a dated event with a size and a model.
 *
 * `agentTok` says the Task tool spent 355M of one session's 368M and stops
 * there. The three questions it cannot answer are the ones somebody actually
 * has — how many, WHEN, and on what — and all three are already on disk: the
 * CLI writes one `subagents/agent-<id>.jsonl` per agent, whose records are
 * dated and carry `message.model`, beside a `.meta.json` naming the task type.
 *
 * A FLOOR like everything read off those logs: an agent log that has been
 * cleaned up is one nothing here can list, and the count is worded accordingly.
 */
export interface AgentRun {
  /** The CLI's own agent id — the file name IS the id (`agents.ts`). */
  id: string;
  /** Its first record: when the agent started. The x of the bar it draws. */
  at: number;
  /** Its last record. Equal to `at` for an agent that wrote once. For a
   *  `running` agent this is only how far its log has got, not an end. */
  endAt: number;
  /** Still running when the document was read: the host's own running-agent
   *  list (`agents.ts`, the parent's task-notifications) still holds it. Only
   *  a LIVE session can say so; absent means not running OR nobody asked — a
   *  closed session's agents are all over, and an older host never says. */
  running?: true;
  /** Which model ran it — an index into `ContextSeriesDoc.models`, the same
   *  table the samples index. Absent when no record named one. */
  model?: number;
  /** `agentType` from its `.meta.json` — `Explore`, `general-purpose`, a
   *  project's own agent. Absent when that file was missing or unreadable,
   *  which costs a label and never the row. */
  type?: string;
  /** Everything that log spent: input, cache reads and writes, and output. */
  tok: number;
  /** At list prices, USD. Absent when its model has no published rate — never
   *  0, which reads as free. */
  costUsd?: number;
  /** The most context any one of its requests carried (input + cache read +
   *  cache write) — the agent's OWN window, which the parent's curve never
   *  shows: one session read 31% in its window while an agent under it ran at
   *  97%. Absent from an older host. */
  peakTok?: number;
  /** How many REQUESTS the agent made (its log's assistant records, deduped by
   *  message id) — not prompts. Absent when 0 or unknown, and from an older host. */
  turns?: number;
  /** That window over time, `[t, tok]`, thinned to at most `AGENT_CTX_POINTS`
   *  with every bucket's MAXIMUM kept, so the peak survives thinning. Absent
   *  from an older host. */
  ctx?: [t: number, tok: number][];
}

/** Points per agent context series on the wire. */
export const AGENT_CTX_POINTS = 60;

/** Points in `ContextSeriesDoc.agentCum` on the wire. */
export const AGENT_CUM_POINTS = 120;

/**
 * Something that happened TO the window, as opposed to a reading of it.
 *
 * Both kinds are dated by the CLI itself, which is the whole reason this is
 * read off the conversation log rather than accumulated from the screen: a
 * scraped meter carries no clock, so a series built from it could never say
 * WHEN the drop happened, and a drop with no time on it is not a graph.
 */
export interface ContextEvent {
  t: number;
  kind:
    /** The conversation was summarised and the window reset. */
    | "compact"
    /** The account refused the request — the usage wall. */
    | "limit"
    /**
     * The conversation came back to an expired cache and re-WROTE its window
     * instead of re-reading it — see `isColdRebuild`.
     *
     * An event rather than a flag on the sample, because the samples are
     * DOWNSAMPLED for the spark and a flag would survive or not depending on
     * which bucket the request landed in. This is also the one thing on the
     * graph that is invisible in the curve: the window does not move, so
     * nothing about the shape says the turn cost twenty times the one before.
     */
    | "rebuild";
  /** compact: whether the CLI did it on its own or the user typed `/compact`. */
  trigger?: "auto" | "manual";
  /** compact: the window immediately before and after. */
  preTok?: number;
  postTok?: number;
  /** rebuild: what it wrote, what it had been carrying, and how long the
   *  conversation had been quiet when it came back. */
  wroteTok?: number;
  prevTok?: number;
  gapMs?: number;
  /** limit: the instant the account said it would serve again, when it said. */
  resetAt?: number;
  /** limit: anything other than the five-hour session window. */
  weekly?: boolean;
}

/**
 * What the compactions in one conversation shed, saved and cost.
 *
 * One row per trigger — see `CompactionLedger`. Every figure is a FLOOR, and
 * each is a floor for its own reason, which is why they are not summed here
 * into a single "net": see the fields.
 */
export interface CompactionCost {
  /** How many compactions this row folds. */
  count: number;
  /**
   * `Σ preTok − postTok`: what the window would still be carrying had none of
   * them run.
   *
   * Exact, and the one figure here that is not a counterfactual — the CLI
   * writes both numbers down at the boundary. It chains correctly across
   * several compactions: after two, the uncompacted window is the real one
   * plus both sheds, because each drop is measured against what the previous
   * one left behind.
   */
  shedTok: number;
  /**
   * Tokens no later request had to re-send, because these compactions ran.
   *
   * Accumulated per REQUEST, not per compaction: every request after a
   * boundary carried `shedTok` fewer tokens than the same request in a
   * conversation that never compacted, so this is that difference summed over
   * every request since. It is what makes the saving grow the longer you keep
   * working — a compaction with no turn after it has saved nothing yet, and
   * says so rather than printing a zero.
   */
  savedTok: number;
  /**
   * `savedTok` at list prices, USD — priced as CACHE READS on the model that
   * actually ran each request, on the day it ran.
   *
   * Cache reads because that is the cheapest thing those tokens could have
   * been, which makes this a floor in the one direction that matters: a
   * conversation resumed after the cache expired re-WRITES its prefix, at
   * 12.5× to 20× the read rate, and pricing every shed token at the write tier
   * would let this figure flatter the feature it is reporting on.
   *
   * Absent when no request could be priced, and absent when nothing has been
   * saved yet — never 0, which reads as "compacting was pointless".
   */
  savedUsd?: number;
  /**
   * What the first request after each of these boundaries wrote into the cache
   * — the window being built again from nothing.
   *
   * The measured cost of compacting, and an OVERSTATEMENT on purpose: some of
   * that write is the turn's own growth, which an uncompacted conversation
   * would have paid too. Erring high here and low on `savedUsd` is the same
   * decision twice — neither number may make compaction look better than it is.
   *
   * These tokens are real and are already inside the session's own
   * `usageTok`/`cost`. `savedTok` is the opposite: money never spent, in no
   * total anywhere. Any surface printing both says which is which.
   */
  rebuildTok: number;
  /** `rebuildTok` at list prices, on the model and day of that request.
   *  Absent rather than 0, for `savedUsd`'s reason. */
  rebuildUsd?: number;
}

/**
 * The compaction ledger for one conversation, split by who asked for it.
 *
 * Split because they are two different decisions: an auto-compaction is the
 * CLI hitting the wall, a manual one is somebody typing `/compact`, and "was
 * it worth doing by hand" is only answerable if the two are counted apart.
 * Both rows are always present — a zeroed row is the claim that none of that
 * kind ran, which is a fact, unlike an absent ledger.
 *
 * **The summarisation request itself is not in these figures.** The CLI does
 * not write it to the conversation log — measured: no assistant record carries
 * its usage, between the boundary and the next prompt there is nothing — so
 * the one part of the cost nothing here can see is the model reading the whole
 * window in order to summarise it. Every surface that prints `rebuildUsd`
 * says so; that is also why the two sides are never subtracted into a net
 * here, where the wording cannot follow.
 */
export interface CompactionLedger {
  auto: CompactionCost;
  manual: CompactionCost;
  /**
   * Compactions whose `preTokens`/`postTokens` the log did not record, and so
   * are in NONE of the figures above — counted rather than silently dropped,
   * exactly as `unpricedTok` counts what no rate covered.
   */
  unmeasured: number;
}

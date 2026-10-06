// Cut from sessioncost.ts (move only): the level vocabulary, thresholds, cache age and the input/reading records
// The one door stays `./sessioncost.js`; this slice imports its siblings directly, never the barrel.

/**
 * How much this conversation carries into every turn, relative to a fresh one.
 *
 *  - `fresh`  — nothing to say, or too early to say it. No chip.
 *  - `warm`   — past the point where a multi-turn task is cheaper elsewhere.
 *  - `heavy`  — a turn here costs several times a fresh turn.
 *  - `steep`  — an order of magnitude. The monsters in the measurement.
 */
export type SessionCostLevel = "fresh" | "warm" | "heavy" | "steep";

/**
 * The thresholds, and where they come from.
 *
 * They are read off `breakEvenTurns`, not chosen: each is the multiple at which
 * a particular size of task stops being cheaper here.
 *
 *   2.5× — break-even is ~13 turns: a session's worth of work belongs elsewhere.
 *   5×   — break-even is ~5 turns: so does an ordinary errand.
 *   9×   — break-even is ~3 turns: so does nearly anything new.
 *
 * They also happen to be the shape of the measured distribution — the long
 * sessions in the fortnight sampled sat at 4-6×, and the handful that dominated
 * the bill sat near 10× — which is the sanity check, not the derivation.
 *
 * **Those turn counts were 8/3/1 while `breakEvenTurns` wrote the fresh
 * session's baseline at the 5-minute cache tier.** It does not: measured over
 * every conversation log on this desktop, 8,160 of 8,160 main-conversation
 * requests that wrote cache wrote it at the 1-HOUR tier (2× input, not 1.25×),
 * and the only 5-minute writes anywhere were the 571 subagent logs. The
 * multiples below are unchanged — they are read off the distribution too — but
 * each of them now means about 65% more turns than this comment used to claim,
 * and the old figures were nudging people out of warm sessions early.
 */
export const MULT_WARM = 2.5;
export const MULT_HEAVY = 5;
export const MULT_STEEP = 9;

/**
 * Turns before a multiple means anything.
 *
 * The first turns of any session climb steeply off the baseline simply because
 * the model is reading the files it was pointed at. Calling that "3× a fresh
 * session" is true and useless — it IS the fresh session, mid-warm-up. Nothing
 * is said until the conversation has settled into its own slope.
 */
export const MIN_TURNS = 6;

/**
 * How long the prompt cache holds a conversation's prefix, and how long after
 * that it is worth SAYING the cache is gone.
 *
 * ── What is actually knowable ───────────────────────────────────────────────
 *
 * The cache is server-side and nothing reports its state. What the CLI's log
 * gives is the last time this conversation ran, and the entry's lifetime is
 * measured from the START of a request, refreshed on every hit. So an upper
 * bound on warmth is derivable and an exact expiry is not — and the difference
 * is not academic, because three things routinely keep a prefix alive that
 * this conversation's own log cannot see:
 *
 *  - a FORK (`--fork-session`) continues the same prefix in a DIFFERENT log,
 *  - `--continue` after a limit exit, and the remote-control bridge, do too,
 *  - a request that hit the usage wall leaves a record with no usage at all,
 *    and it still warmed the cache.
 *
 * ── The measurement, and the two things that corrupt it ─────────────────────
 *
 * Asking the logs "was the prefix served from cache" has two traps, and both
 * of them manufacture fake WARM readings:
 *
 *  1. **A compaction inside the gap.** The window drops to a tenth, so the
 *     request after it writes a small number that looks nothing like a
 *     re-write of the old window. Those gaps are excluded, not counted warm.
 *  2. **`cache_creation > cache_read` is the WRONG test.** Every cold resume
 *     still reads the tools-and-system preamble, which is a separate cache
 *     entry kept warm by sibling sessions in the same repo and measured at
 *     32.5k-36.8k here. A 60k conversation coming back cold reads 36.8k and
 *     writes 30.6k — write < read, and it was stone cold. The test is whether
 *     the read covers the CONVERSATION's own previous context.
 *
 * With both corrected, over every conversation log on this desktop carrying
 * more than 40k, by the gap between one request and the next:
 *
 *   under 30 min   0.2% cold  ·  30-50 min  0%  ·  50-58 min  5%
 *   58-62 min       36% cold  ·  62-70 min  89%  ·  70-90 min  91%
 *   90-120 min      96% cold  ·  2-4 h     100% (48 of 48)  ·  over 4 h  99%
 *
 * The hour is real and the cliff is sharp — and it is 36% wide at the edge, so
 * a countdown would be printing minutes into the one band where the answer is
 * a coin toss. There is no countdown here for that reason, and no expiry
 * instant on any screen.
 *
 * ── Why the threshold is the hour plus a half ───────────────────────────────
 *
 * The log record is stamped when GENERATION ENDED, not when the request
 * started (measured: median 4 s later, p99 49 s, worst 9 min), so
 * `lastTurnAt + TTL` is already past the true expiry — and a 66-minute gap
 * that came back warm is in this data, which is what that skew looks like.
 * Half an hour of margin puts the claim in the 96% band without waiting for
 * the 100% one: the earlier draft of this rule used TWICE the TTL on a
 * corpus reading of "5% warm between one and four hours", and that 5% was the
 * two artefacts above. The real figure is 1 warm resume in 71.
 *
 * What is left past four hours is one warm reading in 118 — a fork or a
 * resurrection continuing the prefix in a file this conversation cannot see.
 * So it is still a heuristic, worded as one wherever it is printed, and it
 * never appears as a number of minutes or a figure in dollars.
 */
export const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Past this much silence, the cache is very likely gone.
 *
 * Deliberately not `CACHE_TTL_MS` itself — see above. The TTL is what the API
 * promises; this is the point where the log alone is evidence.
 */
export const CACHE_COLD_AFTER_MS = CACHE_TTL_MS + 30 * 60 * 1000;

/**
 * Has this conversation's cached prefix very likely expired?
 *
 *  - `true`  — nothing has run here for `CACHE_COLD_AFTER_MS`.
 *  - `false` — too recent to say that. NOT a claim that it is warm.
 *  - `null`  — unknowable: nothing recorded a last turn, or a turn is running
 *              right now (which refreshes the entry continuously, so any
 *              reading taken mid-turn is about to be wrong).
 *
 * `now` is the CALLER's, and on the phone it must be the phone's own clock at
 * render time: a flag computed on the host is stale the moment it is sent, and
 * a device that has been asleep for three hours has to recompute this, not
 * redraw it.
 */
export function cacheLikelyCold(
  lastTurnAt: number | null | undefined,
  now: number,
  turnActive?: boolean | null,
): boolean | null {
  if (turnActive) return null;
  if (lastTurnAt == null || !(lastTurnAt > 0) || !Number.isFinite(now)) return null;
  return now - lastTurnAt >= CACHE_COLD_AFTER_MS;
}

export interface SessionCostInput {
  /** Context carried by the most recent turn, in tokens — what the next turn
   *  re-reads. The last reading of the series, not the peak: a compaction
   *  genuinely makes the next turn cheap again. */
  tok: number;
  /**
   * The session's FIRST reading — the measured price of a turn in a fresh
   * session in this repo, on this machine, with this CLAUDE.md and these tools.
   *
   * Deliberately measured rather than assumed: the baseline is dominated by the
   * project's own CLAUDE.md and MCP surface, so it is a per-repo fact that
   * varies by an order of magnitude across one desktop. Null when the log was
   * truncated and there is no first reading to quote — and then there is no
   * multiple and nothing is claimed, rather than a number invented from a
   * constant that would be wrong for most repos.
   */
  baseTok: number | null;
  /** Turns this conversation has completed — user records that opened one, NOT
   *  readings in the series (a single turn writes one reading per request, so a
   *  tool-heavy turn writes a dozen). Null when nothing counted them. */
  turns: number | null;
  /** Sum of every reading: what this conversation has carried in total. Not a
   *  bill (cache reads are a tenth of input, and the plan is not in the log) —
   *  it is the volume, which is what a usage limit actually counts. */
  spentTok: number | null;
  /**
   * What the session has USED in total: the same volume plus what each turn
   * generated plus everything its subagents spent in their own logs.
   *
   * `spentTok` is the curve's integral — the input side of this conversation
   * alone, which is the right number for "what does the next turn re-read" and
   * the wrong one for "what has this cost". A session that fans out to eight
   * agents carries a small window and spends millions, and until this existed
   * nothing on any screen could say so.
   *
   * A FLOOR, always worded "so far": a truncated log undercounts and an agent
   * log that was cleaned up is one nobody can add. Null when nothing measured
   * it — an older host sends no such field, and a number invented from
   * `spentTok` would be the plausible wrong one.
   */
  usageTok: number | null;
  /** The subagent share of `usageTok`, already inside it. Null when unmeasured,
   *  0 when measured and this session ran none. */
  agentTok: number | null;
  /**
   * `cacheLikelyCold`'s answer for this session, or absent when nobody asked.
   *
   * Only `true` changes anything that is said. `false` and `null` both leave
   * every sentence exactly as it was, because neither is evidence that the
   * cache is WARM — one is "too recent to claim otherwise" and the other is
   * "nothing to read". The asymmetry is the point: this may make a reading
   * more cautious, never more encouraging.
   *
   * It goes IN and does not come back out: the reading carries no boolean at
   * all, because every boolean on it is one a caller can mistake for a gate,
   * and what a cold window changes is which sentence is true — which is
   * already in `note` and `advice`.
   */
  cacheCold?: boolean | null;
}

export interface SessionCostReading {
  level: SessionCostLevel;
  tok: number;
  baseTok: number | null;
  /** `tok / baseTok`. Null when there is no baseline to divide by. */
  multiple: number | null;
  /** More turns of new work than this, and a fresh session would have been
   *  cheaper. Null when there is no baseline, or when the session is still
   *  close enough to one that the answer is not a small number. */
  breakEven: number | null;
  spentTok: number | null;
  usageTok: number | null;
  agentTok: number | null;
  turns: number | null;
  /** Short chip text — `"4.8×"`. Null at `fresh`, which draws nothing. */
  chip: string | null;
  /** One sentence of fact. Never an instruction. */
  note: string;
  /** What the fact implies, as a suggestion, when there is one worth making. */
  advice: string | null;
}

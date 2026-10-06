/**
 * Is the account limit-blocked RIGHT NOW — asked of the CLI's own log, not of
 * the screen.
 *
 * `limit.ts` reads the banner off a terminal, which is the only source when
 * there is nothing else. Its blind spot is that a screen carries no date. The
 * banner is the last thing a blocked session ever prints, so it stays in the
 * scrollback tail for as long as that session sits idle — hours, or days. Every
 * later scan re-reads it and re-affirms a block that ended long ago, and the
 * bare clock time it carries ("resets 10pm") is resolved against TODAY, so a
 * Wednesday wall reappears as a Friday one. Nothing then lifts it: while the
 * session is quiet the banner never leaves the window, so the scan can only
 * ever confirm.
 *
 * The CLI writes the same event down, and dates it. A rejected request lands in
 * the conversation jsonl as a synthetic assistant turn carrying `quotaLimits`:
 *
 *   {"type":"assistant","timestamp":"…","message":{"model":"<synthetic>",…},
 *    "quotaLimits":{"status":"rejected","resetsAt":1788465600,
 *                   "rateLimitType":"five_hour",…}}
 *
 * That gives the two things a screen cannot: WHEN the wall was hit, and the
 * reset as an INSTANT rather than a wall-clock time needing a zone and a date.
 * And an ordinary assistant turn stamped after it is proof the account served
 * this session again — the positive signal that lifts a block without anyone
 * typing anything.
 *
 * Read-only, and never authoritative when it cannot read: a session whose
 * conversation id is not known yet, a log that has not appeared, a tmux session
 * adopted after a restart all answer `unknown`, and the caller keeps the screen
 * heuristic it had before.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { stamp, toMs } from "./convlog.js";

/** How much of the log tail to read. A rejection is followed by very little —
 *  the turn it killed ended there — so the answer is always near the end. */
const MAX_READ = 512 * 1024;

export type LimitLogState =
  /** The newest rejection is unanswered and its reset has not passed. */
  | "blocked"
  /** The log is readable and says the account is serving this session. */
  | "clear"
  /** No log, no conversation id, nothing parseable — the screen is all there is. */
  | "unknown";

export interface LimitLogVerdict {
  state: LimitLogState;
  /** When the newest rejection was recorded (epoch ms), if any. */
  rejectedAt: number | null;
  /** The instant the account is said to reset (epoch ms), if the row said. */
  resetAt: number | null;
  /** Anything other than the 5-hour session window (weekly, monthly, …). */
  weekly: boolean;
  /** Newest ordinary assistant turn — the account provably served us then. */
  servedAt: number | null;
  /**
   * WHY a `clear` is clear — null unless `state === "clear"`.
   *
   * The three are not equally strong evidence and the caller must not read them
   * as one fact:
   *  - `served`: an ordinary turn is stamped after the rejection. Positive
   *    proof; the account is serving this session again.
   *  - `reset`: the rejection still stands and nothing has been served since —
   *    only its own reset INSTANT has passed on the clock. That says the wall
   *    should be gone, not that anything has run: the turn it killed still has
   *    not happened, and an auto-continue is what is supposed to make it.
   *  - `none`: no rejection row in the tail at all. The log has nothing to say
   *    about a wall — which is not the same as saying there is none, because
   *    the CLI writes the row a moment AFTER the banner reaches the screen.
   */
  clearedBy: "served" | "reset" | "none" | null;
}

const UNKNOWN: LimitLogVerdict = { state: "unknown", rejectedAt: null, resetAt: null, weekly: false, servedAt: null, clearedBy: null };

/** Read the tail of a log. Null when it isn't there. */
function tailLines(path: string): string[] | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  const start = Math.max(0, st.size - MAX_READ);
  const len = st.size - start;
  if (len <= 0) return [];
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift(); // a tail read starts mid-record
  return lines;
}

/**
 * What the conversation log says about the account, as of `now`.
 *
 * Walks the tail BACKWARDS and stops at the newest of each of the two rows that
 * matter, so an ordinary check costs one stat, one bounded read and a handful
 * of `JSON.parse`s — cheap enough for the idle sweep to ask every minute about
 * every blocked session.
 */
export function readLimitLog(path: string, now = Date.now()): LimitLogVerdict {
  const lines = tailLines(path);
  if (!lines) return UNKNOWN;
  let rejectedAt: number | null = null;
  let resetAt: number | null = null;
  let weekly = false;
  let servedAt: number | null = null;
  let sawRow = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    const isQuota = rejectedAt == null && line.includes('"quotaLimits"');
    const isAssistant = servedAt == null && line.includes('"assistant"');
    if (!isQuota && !isAssistant) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    sawRow = true;
    const q = row.quotaLimits as { status?: string; resetsAt?: number; rateLimitType?: string } | undefined;
    if (rejectedAt == null && q && q.status === "rejected") {
      rejectedAt = stamp(row) ?? now;
      resetAt = toMs(q.resetsAt);
      weekly = typeof q.rateLimitType === "string" && q.rateLimitType !== "five_hour";
      continue;
    }
    // A REAL assistant turn. The rejection itself is written as one too, with
    // `<synthetic>` for a model — counting that as service would make every
    // block clear itself the instant it was recorded.
    if (servedAt == null && row.type === "assistant") {
      const model = (row.message as { model?: unknown } | undefined)?.model;
      if (model === "<synthetic>") continue;
      servedAt = stamp(row);
    }
    if (rejectedAt != null && servedAt != null) break;
  }
  if (!sawRow) return UNKNOWN;
  // Blocked means: nothing has been served since the wall, and the wall's own
  // reset instant has not passed. Both halves are needed — a session left
  // sitting at a rejection serves nothing precisely BECAUSE nobody typed into
  // it, so silence alone would keep a two-day-old block alive for ever.
  const stale = resetAt != null && resetAt <= now;
  const superseded = servedAt != null && rejectedAt != null && servedAt > rejectedAt;
  const state: LimitLogState = rejectedAt != null && !stale && !superseded ? "blocked" : "clear";
  // Which of the three cleared it. `served` outranks `reset` when both hold:
  // being served again is a fact about the account, where a passed instant is
  // only a fact about the clock.
  const clearedBy: LimitLogVerdict["clearedBy"] =
    state !== "clear" ? null : rejectedAt == null ? "none" : superseded ? "served" : "reset";
  return { state, rejectedAt, resetAt, weekly, servedAt, clearedBy };
}

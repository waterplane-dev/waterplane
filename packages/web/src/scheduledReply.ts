/**
 * **Which live sessions have words already scheduled for them.**
 *
 * A session waiting for your answer says nothing about whether anybody has
 * already written the answer and put it on a clock. That is exactly the pair a
 * person cannot hold in their head across fifteen repos: five sessions parked
 * on a question, some of them with a reply queued for after the weekly window
 * resets and some of them waiting on a person who thinks they already dealt
 * with it. The rows are on the desktop, in a sheet two taps away, keyed by
 * repo — nowhere near the row that is waiting.
 *
 * So the launcher says it, and this is the one reading behind every place it is
 * said: the per-session chip, the repo group's *N waiting* pill and the header's
 * *N waiting* chip. One function, so the three cannot disagree about what
 * counts — which is the failure `clockCuts.ts` was written to end one sheet
 * over, where three hand-rolled copies of "this row is on a clock" said 13, 8
 * and 2 about one set of rows.
 *
 * **What counts is narrow on purpose**: a row with a CLOCK (`trigger.kind ===
 * "at"`), still expecting to run, not set aside, and aimed at THIS SESSION. A
 * clock row aimed at the repo is not a reply to a session — it opens a session
 * of its own — and counting it here would put a mark on a waiting row about
 * work that is never going to reach it.
 *
 * The chip is a COUNT, so it is a filter: what the tap opens is exactly these
 * ids and never the repo's whole backlog for the reader to find them in.
 */
import type { Intent } from "@waterplane/shared";

export interface ScheduledReply {
  /** The rows themselves, so a tap can open exactly these and nothing else. */
  ids: string[];
  /**
   * The soonest instant any of them is armed for, or null when the host has
   * armed none of them yet — a window rule with no usage reading yet arms to
   * `null`, which means *not yet*, never *never*. Null degrades to a chip with
   * no time on it, never to a made-up one.
   */
  nextAt: number | null;
}

/**
 * Rows still expecting to run, named POSITIVELY: a state added to `Lifecycle`
 * tomorrow must not silently join this set, because every one of these puts a
 * mark on a row saying words are on their way to it.
 *
 * `failed` is out with the other two terminal states — a row that stopped is
 * not a reply anybody is waiting for — and so is `archived`, which is somebody
 * saying *not this*.
 */
const LIVE: readonly Intent["state"][] = ["queued", "blocked", "starting", "running"];

function pending(i: Intent): boolean {
  return LIVE.includes(i.state) && !i.archived;
}

/**
 * Session id → the clock rows aimed at it. Sessions with none are absent, so a
 * caller asks with `has`/`get` and never has to tell an empty entry from a
 * missing one.
 */
export function scheduledRepliesBySession(rows: readonly Intent[]): Map<string, ScheduledReply> {
  const m = new Map<string, ScheduledReply>();
  for (const i of rows) {
    if (i.trigger.kind !== "at" || i.target.kind !== "session" || !pending(i)) continue;
    const cur = m.get(i.target.sessionId) ?? { ids: [], nextAt: null };
    cur.ids.push(i.id);
    if (i.nextAt != null) cur.nextAt = cur.nextAt == null ? i.nextAt : Math.min(cur.nextAt, i.nextAt);
    m.set(i.target.sessionId, cur);
  }
  return m;
}

/**
 * How many of THESE sessions have one.
 *
 * The pills take a dot and not a number: *5 waiting* is already a count and
 * already a filter (it cuts the list to those five), and a second number on the
 * same control would be a second filter with no second tap to spend on it. The
 * number lives on the session row, where the tap that opens those rows is.
 */
export function anyScheduledReply(sessionIds: readonly string[], bySession: Map<string, ScheduledReply>): boolean {
  return sessionIds.some((id) => bySession.has(id));
}

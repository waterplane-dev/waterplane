// Cut from queue.ts (move only): why nothing is sending
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import type { SendBlockReason, BlockedEntry } from "./queueplan.js";
import { SERIAL_WAIT_TEXT } from "./queueserial.js";

/** The sentence for one block reason. Wording lives here so every surface that
 *  explains a stuck queue says the same thing. */
export function blockedReasonText(r: SendBlockReason): string {
  // closed: the reason is `planQueue`'s, computed by this build
  switch (r) {
    case "budget": return "paused — the account is past your usage budget; it resumes when the window resets";
    // "the repo's work items" was the retired name for rows in the shared
    // per-repo conversation, which no longer exists — the same words, and the
    // same fix, as `intent.ts`'s `GONE_SESSION`. Two copies of a sentence are
    // two chances for one of them to keep saying the old thing.
    case "sessionBudget": return "held — this session is over its own budget; raise or clear it to send";
    case "sessionGone": return "that session is gone — aim it at another session or at the repo's backlog";
    case "gate": return "queued — auto-send is off, tap Send now";
    case "backoff": return "a send just failed — retrying in a moment";
    case "held": return "held until the agent finishes this turn";
    case "serial": return SERIAL_WAIT_TEXT;
    case "pendingCreate": return "waiting for its session to open";
    case "lane": return "another message for that session is going out first";
    case "inflight": return "a delivery for that session is already in flight";
  }
}

/**
 * Why did nothing go out? — in one sentence, for a flush that sent zero.
 *
 * The bug this replaces: every caller of `flushOutbox()` treated a zero return
 * as proof the link was down, and said "still offline — staying queued" over a
 * header chip reading `open · 100.64.0.5`. The link was one of at least seven
 * possible answers and usually not the right one.
 *
 * Precedence is by what the user can DO about it, not by queue order: the gate
 * is a switch one tap away, a backoff clears itself, and the rest are facts
 * about a session. `null` = nothing is stuck (nothing queued, or something did
 * go out), so the caller stays silent rather than inventing reassurance.
 */
export function queueIdleReason(
  blocked: readonly BlockedEntry[],
  opts: { online: boolean; queued: number; serialText?: string },
): string | null {
  if (!opts.online) return "still offline — staying queued";
  if (!opts.queued || !blocked.length) return null;
  // `budget` outranks everything but the user's own switch: it is the only
  // reason here that is about the ACCOUNT rather than about one lane's position,
  // so when it is true it is the answer for every row at once.
  // `sessionGone` sits above the three self-resolving waits: it is the only
  // reason here that never clears on its own.
  const order: SendBlockReason[] = ["gate", "budget", "sessionBudget", "sessionGone", "backoff", "serial", "held", "pendingCreate", "lane", "inflight"];
  // `serialText` is the caller's NAMED serial sentence (`serialWaitText`), when
  // it could say who holds the repo; the generic line otherwise.
  for (const r of order) if (blocked.some((b) => b.reason === r)) return r === "serial" && opts.serialText ? opts.serialText : blockedReasonText(r);
  return null;
}

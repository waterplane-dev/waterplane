/**
 * "Flag for follow up" — what the flag may say, and the one wording of it
 * (R-sessions-041…045). The host keeps the flags per conversation and stamps
 * them onto `SessionInfo.followUp` / `ClosedSession.followUp`; both ends read
 * a flag through `cleanFollowUp` and word it through `followUpText`, so the
 * row, the header and the notification cannot describe one flag three ways.
 *
 * It is a reading list, not a status: setting one never changes what a
 * session does, and only a person's tap clears it — opening the session does
 * not (that is `newActivity`'s job, and the reason this is a second field).
 */
import type { FollowUp, FollowUpBy } from "./wire/session.js";

/** An agent's reason, and a launch flag's item label, are one line of at most this. */
export const FOLLOWUP_REASON_CAP = 160;

const BY: ReadonlySet<string> = new Set<FollowUpBy>(["hand", "launch", "agent"]);

/** One line, collapsed whitespace, clipped with an ellipsis; empty ⇒ undefined. */
export function clipFollowUpText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > FOLLOWUP_REASON_CAP ? `${t.slice(0, FOLLOWUP_REASON_CAP - 1).trimEnd()}…` : t;
}

/**
 * A flag read off disk or the wire. An unknown `by` or a missing `at` drops the
 * WHOLE flag (`null`) — a flag that cannot say who set it cannot be coloured,
 * and rounding it to `hand` would claim the person did. `reason` is kept only
 * on an `agent` flag, `item` only on a `launch` one.
 */
export function cleanFollowUp(raw: unknown): FollowUp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.by !== "string" || !BY.has(r.by)) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  const by = r.by as FollowUpBy;
  const out: FollowUp = { by, at: r.at };
  const reason = by === "agent" ? clipFollowUpText(r.reason) : undefined;
  const item = by === "launch" ? clipFollowUpText(r.item) : undefined;
  if (reason) out.reason = reason;
  if (item) out.item = item;
  return out;
}

/** Who set it, in the words a row and a hint use. */
export function followUpByText(by: FollowUpBy): string {
  return by === "hand" ? "flagged by you"
    : by === "launch" ? "flagged when done, as you asked"
    : "flagged by the session";
}

/**
 * The flag as one sentence: who, and — where there is one — what to read.
 * `flagged by the session: migration needs your call`.
 */
export function followUpText(f: FollowUp): string {
  const head = followUpByText(f.by);
  if (f.by === "agent" && f.reason) return `${head}: ${f.reason}`;
  if (f.by === "launch" && f.item) return `${head} (${f.item})`;
  return head;
}

/**
 * The push a flag set WITHOUT a tap sends (a `hand` flag sends none — the
 * person is holding the phone). Title names the session; body is the reason.
 */
export function followUpPushText(f: FollowUp, title: string): { title: string; body: string } | null {
  if (f.by === "hand") return null;
  return {
    title: `Follow up: ${title}`,
    body: f.by === "agent" ? (f.reason ?? "The session says there is something for you to read.")
      : `Finished${f.item ? ` — ${f.item}` : ""}. Flagged for follow up, as you asked.`,
  };
}
